"""
Transaction manager for Solana blockchain operations.

Handles transaction building, signing, submission, and confirmation
with retry logic and error handling.
"""

import asyncio
from dataclasses import dataclass, field
from typing import List, Optional, Dict, Any, Union
from enum import Enum

import structlog
from solders.keypair import Keypair
from solders.pubkey import Pubkey
from solders.instruction import Instruction
from solders.message import MessageV0
from solders.transaction import VersionedTransaction
from solders.hash import Hash
from solders.compute_budget import set_compute_unit_limit, set_compute_unit_price
from solana.rpc.commitment import Confirmed, Finalized
from tenacity import (
    retry,
    stop_after_attempt,
    wait_exponential,
    retry_if_exception_type,
    RetryError,
)

from app.config import get_settings
from .solana_client import SolanaClient, get_solana_client, TransactionResult

logger = structlog.get_logger(__name__)
settings = get_settings()


class TransactionStatus(str, Enum):
    """Transaction status enum."""
    PENDING = "pending"
    SUBMITTED = "submitted"
    CONFIRMED = "confirmed"
    FINALIZED = "finalized"
    FAILED = "failed"
    TIMEOUT = "timeout"


@dataclass
class TransactionBundle:
    """
    A bundle of instructions to execute as a single transaction.

    Attributes:
        instructions: List of instructions to include
        signers: Additional signers (beyond the fee payer)
        description: Human-readable description
        priority_fee: Optional priority fee in microlamports per compute unit
    """
    instructions: List[Instruction] = field(default_factory=list)
    signers: List[Keypair] = field(default_factory=list)
    description: str = ""
    priority_fee: Optional[int] = None  # microlamports per compute unit

    def add_instruction(self, instruction: Instruction) -> "TransactionBundle":
        """Add an instruction to the bundle."""
        self.instructions.append(instruction)
        return self

    def add_signer(self, signer: Keypair) -> "TransactionBundle":
        """Add a signer to the bundle."""
        self.signers.append(signer)
        return self


@dataclass
class TransactionReceipt:
    """
    Receipt for a submitted transaction.

    Contains all relevant information about transaction status and result.
    """
    signature: str
    status: TransactionStatus
    slot: Optional[int] = None
    block_time: Optional[int] = None
    fee: Optional[int] = None
    error: Optional[str] = None
    logs: List[str] = field(default_factory=list)
    metadata: Dict[str, Any] = field(default_factory=dict)

    @property
    def is_success(self) -> bool:
        """Check if transaction was successful."""
        return self.status in (
            TransactionStatus.CONFIRMED,
            TransactionStatus.FINALIZED,
        )

    @property
    def explorer_url(self) -> str:
        """Get Solana Explorer URL for this transaction."""
        cluster = "devnet" if settings.solana_network == "devnet" else ""
        cluster_param = f"?cluster={cluster}" if cluster else ""
        return f"https://explorer.solana.com/tx/{self.signature}{cluster_param}"


class TransactionManager:
    """
    Manages transaction building, submission, and confirmation.

    Provides:
    - Transaction building from instruction bundles
    - Automatic blockhash fetching
    - Retry logic for failed submissions
    - Confirmation tracking
    """

    def __init__(
        self,
        solana_client: Optional[SolanaClient] = None,
        max_retries: int = 3,
        confirmation_timeout: int = 60,
    ):
        """
        Initialize the transaction manager.

        Args:
            solana_client: Solana client instance
            max_retries: Maximum retry attempts for failed transactions
            confirmation_timeout: Timeout in seconds for confirmation
        """
        self._solana_client = solana_client
        self.max_retries = max_retries
        self.confirmation_timeout = confirmation_timeout

    async def _get_solana_client(self) -> SolanaClient:
        """Get or create Solana client."""
        if self._solana_client is None:
            self._solana_client = await get_solana_client()
        return self._solana_client

    async def build_and_sign_transaction(
        self,
        bundle: TransactionBundle,
        fee_payer: Optional[Pubkey] = None,
    ) -> VersionedTransaction:
        """
        Build and sign a versioned transaction from an instruction bundle.

        This combines building and signing in one step to ensure correct
        signer ordering - the signers must be provided in the same order
        as they appear in the compiled message's account keys.

        Args:
            bundle: Transaction bundle with instructions and signers
            fee_payer: Fee payer public key (defaults to wallet)

        Returns:
            Signed VersionedTransaction ready for submission
        """
        solana = await self._get_solana_client()

        if fee_payer is None:
            fee_payer = solana.wallet_pubkey

        # Get recent blockhash
        blockhash_str = await solana.get_recent_blockhash()
        blockhash = Hash.from_string(blockhash_str)

        # Build instruction list, prepending compute budget instructions if priority fee is set
        all_instructions = []

        # Add compute budget instructions FIRST if priority fee is set
        # This improves transaction inclusion during network congestion
        if bundle.priority_fee is not None and bundle.priority_fee > 0:
            # Set compute unit limit (default 200,000 is sufficient for most LP operations)
            compute_limit_ix = set_compute_unit_limit(200_000)
            # Set priority fee in microlamports per compute unit
            priority_ix = set_compute_unit_price(bundle.priority_fee)
            all_instructions.extend([compute_limit_ix, priority_ix])
            logger.debug(
                "priority_fee_added",
                fee_microlamports=bundle.priority_fee,
                compute_limit=200_000,
            )

        # Add the bundle's instructions after compute budget instructions
        all_instructions.extend(bundle.instructions)

        # Build message with all instructions
        message = MessageV0.try_compile(
            payer=fee_payer,
            instructions=all_instructions,
            address_lookup_table_accounts=[],
            recent_blockhash=blockhash,
        )

        # Wallet is always first signer (fee payer)
        # Additional signers follow in the order they appear in bundle.signers
        all_signers = [solana.wallet] + bundle.signers

        logger.debug(
            "building_signed_transaction",
            description=bundle.description,
            num_instructions=len(bundle.instructions),
            num_signers=len(all_signers),
            fee_payer=str(fee_payer),
            signer_pubkeys=[str(s.pubkey()) for s in all_signers],
        )

        # Create signed transaction directly
        # The signers must be in the same order as the message expects:
        # - Fee payer is always first
        # - Then other signers in the order they appear in account_keys
        try:
            signed_tx = VersionedTransaction(message, all_signers)
        except Exception as e:
            # Log detailed info for debugging signer issues
            logger.error(
                "transaction_signing_failed",
                error=str(e),
                num_required_signatures=message.header.num_required_signatures,
                num_signers_provided=len(all_signers),
                signer_pubkeys=[str(s.pubkey()) for s in all_signers],
            )
            raise

        logger.debug(
            "transaction_signed",
            description=bundle.description,
            num_signers=len(all_signers),
        )

        return signed_tx

    async def build_transaction(
        self,
        bundle: TransactionBundle,
        fee_payer: Optional[Pubkey] = None,
    ) -> VersionedTransaction:
        """
        Build an unsigned versioned transaction from an instruction bundle.

        Note: For most use cases, use build_and_sign_transaction instead.

        Args:
            bundle: Transaction bundle with instructions
            fee_payer: Fee payer public key (defaults to wallet)

        Returns:
            Unsigned VersionedTransaction
        """
        solana = await self._get_solana_client()

        if fee_payer is None:
            fee_payer = solana.wallet_pubkey

        # Get recent blockhash
        blockhash_str = await solana.get_recent_blockhash()
        blockhash = Hash.from_string(blockhash_str)

        # Build message
        message = MessageV0.try_compile(
            payer=fee_payer,
            instructions=bundle.instructions,
            address_lookup_table_accounts=[],
            recent_blockhash=blockhash,
        )

        # Create unsigned transaction
        transaction = VersionedTransaction(message, [])

        logger.debug(
            "built_unsigned_transaction",
            description=bundle.description,
            num_instructions=len(bundle.instructions),
            fee_payer=str(fee_payer),
        )

        return transaction

    async def sign_transaction(
        self,
        transaction: VersionedTransaction,
        signers: List[Keypair],
    ) -> VersionedTransaction:
        """
        Sign a transaction with the provided signers.

        Note: For most use cases, use build_and_sign_transaction instead,
        as it handles signer ordering correctly.

        Args:
            transaction: Transaction to sign
            signers: List of signers (wallet is always included)

        Returns:
            Signed transaction
        """
        solana = await self._get_solana_client()

        # Include wallet as first signer (fee payer)
        all_signers = [solana.wallet] + signers

        # Sign the transaction
        signed_tx = VersionedTransaction(
            transaction.message,
            all_signers,
        )

        logger.debug(
            "signed_transaction",
            num_signers=len(all_signers),
        )

        return signed_tx

    async def submit_transaction(
        self,
        bundle: TransactionBundle,
        wait_for_confirmation: bool = True,
        commitment: str = "confirmed",
    ) -> TransactionReceipt:
        """
        Build, sign, and submit a transaction.

        Args:
            bundle: Transaction bundle to submit
            wait_for_confirmation: Whether to wait for confirmation
            commitment: Confirmation commitment level

        Returns:
            TransactionReceipt with status and details
        """
        # Submit real transaction
        solana = await self._get_solana_client()

        try:
            # Build and sign transaction in one step
            # This ensures correct signer ordering
            signed_tx = await self.build_and_sign_transaction(bundle)

            # Submit with retry (handles blockhash expiration)
            result = await self._submit_with_retry(signed_tx, bundle.signers, bundle)

            if not result.success:
                return TransactionReceipt(
                    signature=result.signature or "",
                    status=TransactionStatus.FAILED,
                    error=result.error,
                    metadata={"description": bundle.description},
                )

            # Wait for confirmation if requested
            if wait_for_confirmation:
                confirmed = await self._wait_for_confirmation(
                    result.signature,
                    commitment,
                )
                status = TransactionStatus.CONFIRMED if confirmed else TransactionStatus.TIMEOUT
            else:
                status = TransactionStatus.SUBMITTED

            # Set error message for timeout to explain what happened
            error_msg = None
            if status == TransactionStatus.TIMEOUT:
                error_msg = (
                    f"Transaction confirmation timeout after {self.confirmation_timeout}s. "
                    "The transaction may still be pending or may have been dropped by the network. "
                    "Manual verification required."
                )

            receipt = TransactionReceipt(
                signature=result.signature,
                status=status,
                slot=result.slot,
                error=error_msg,
                metadata={"description": bundle.description},
            )

            logger.info(
                "transaction_submitted",
                signature=result.signature,
                status=status.value,
                description=bundle.description,
            )

            return receipt

        except Exception as e:
            logger.error(
                "transaction_submission_failed",
                error=str(e),
                description=bundle.description,
            )
            return TransactionReceipt(
                signature="",
                status=TransactionStatus.FAILED,
                error=str(e),
                metadata={"description": bundle.description},
            )

    @retry(
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=1, max=10),
        retry=retry_if_exception_type((ConnectionError, TimeoutError)),
    )
    async def _submit_with_retry(
        self,
        transaction: VersionedTransaction,
        additional_signers: List[Keypair],
        bundle: Optional[TransactionBundle] = None,
    ) -> TransactionResult:
        """
        Submit transaction with retry logic.
        
        CRITICAL FIX: Handles BlockhashNotFound errors by rebuilding transaction
        with fresh blockhash. Blockhashes expire after ~60 seconds, so if there's
        a delay between building and submitting, the blockhash may expire.
        """
        solana = await self._get_solana_client()
        
        # First attempt
        result = await solana.send_transaction(transaction, additional_signers)
        
        # Check if error is BlockhashNotFound (handles both preflight and submission failures)
        if not result.success and result.error:
            error_str = str(result.error).lower()
            # Check for blockhash errors in various formats:
            # - "blockhash not found"
            # - "blockhashnotfound"
            # - "Transaction simulation failed: Blockhash not found" (preflight)
            # - "SendTransactionPreflightFailureMessage" with blockhash error
            is_blockhash_error = (
                "blockhash" in error_str and "not found" in error_str
            ) or "blockhashnotfound" in error_str or (
                "preflight" in error_str and "blockhash" in error_str
            )
            
            if is_blockhash_error and bundle:
                logger.warning(
                    "blockhash_expired_retrying",
                    error=result.error,
                    description=bundle.description,
                )
                # Rebuild transaction with fresh blockhash
                try:
                    fresh_tx = await self.build_and_sign_transaction(bundle)
                    # Retry with fresh transaction
                    result = await solana.send_transaction(fresh_tx, additional_signers)
                    if result.success:
                        logger.info(
                            "blockhash_retry_succeeded",
                            description=bundle.description,
                        )
                except Exception as e:
                    logger.error(
                        "blockhash_retry_failed",
                        error=str(e),
                        description=bundle.description,
                    )
                    # Return original error
                    return result
        
        return result

    async def _wait_for_confirmation(
        self,
        signature: str,
        commitment: str = "confirmed",
    ) -> bool:
        """Wait for transaction confirmation."""
        solana = await self._get_solana_client()

        commitment_level = Confirmed if commitment == "confirmed" else Finalized

        try:
            return await asyncio.wait_for(
                solana.confirm_transaction(signature, commitment_level),
                timeout=self.confirmation_timeout,
            )
        except asyncio.TimeoutError:
            logger.warning(
                "transaction_confirmation_timeout",
                signature=signature,
                timeout=self.confirmation_timeout,
            )

            # CRITICAL FIX: Verify transaction actually failed before giving up
            # The timeout doesn't mean the transaction failed - it means we gave up waiting
            # Try one more time to check if transaction was actually confirmed
            logger.info(
                "verifying_transaction_status_after_timeout",
                signature=signature,
            )

            try:
                # Give the chain a moment to catch up
                await asyncio.sleep(5)

                # Try to verify if transaction is actually confirmed
                is_confirmed = await solana.confirm_transaction(signature, commitment_level)

                if is_confirmed:
                    logger.info(
                        "transaction_confirmed_after_timeout_verification",
                        signature=signature,
                    )
                    return True
                else:
                    logger.warning(
                        "transaction_not_confirmed_after_verification",
                        signature=signature,
                    )
                    return False

            except Exception as e:
                logger.error(
                    "transaction_verification_failed",
                    signature=signature,
                    error=str(e),
                )
                return False

    async def simulate_transaction(
        self,
        bundle: TransactionBundle,
    ) -> Dict[str, Any]:
        """
        Simulate a transaction without submitting.

        Useful for checking if a transaction would succeed and
        estimating compute units.

        Args:
            bundle: Transaction bundle to simulate

        Returns:
            Simulation result with logs and compute units
        """
        solana = await self._get_solana_client()

        try:
            # Build transaction
            transaction = await self.build_transaction(bundle)

            # Sign transaction (required for simulation)
            signed_tx = await self.sign_transaction(transaction, bundle.signers)

            # Simulate via RPC
            response = await solana.client.simulate_transaction(signed_tx)

            result = {
                "success": response.value.err is None,
                "error": str(response.value.err) if response.value.err else None,
                "logs": response.value.logs or [],
                "units_consumed": response.value.units_consumed,
            }

            logger.debug(
                "transaction_simulated",
                success=result["success"],
                units_consumed=result["units_consumed"],
                description=bundle.description,
            )

            return result

        except Exception as e:
            logger.error("transaction_simulation_failed", error=str(e))
            return {
                "success": False,
                "error": str(e),
                "logs": [],
                "units_consumed": None,
            }


# Singleton instance
_transaction_manager: Optional[TransactionManager] = None


async def get_transaction_manager() -> TransactionManager:
    """Get or create the default transaction manager singleton."""
    global _transaction_manager
    if _transaction_manager is None:
        _transaction_manager = TransactionManager()
    return _transaction_manager
