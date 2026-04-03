"""
wSOL (Wrapped SOL) Cleanup Module.

Provides functionality to detect and close/unwrap wSOL token accounts,
returning the SOL to the wallet's native balance.

When interacting with Orca Whirlpools, SOL gets wrapped into wSOL.
Sometimes leftover wSOL remains after transactions (failed/partial transactions,
or after closing positions). This module provides automatic cleanup functionality.
"""

import struct
from dataclasses import dataclass
from typing import List, Optional

import structlog
from solders.pubkey import Pubkey
from solders.keypair import Keypair
from solders.instruction import Instruction, AccountMeta

from app.config import get_settings

logger = structlog.get_logger(__name__)
settings = get_settings()

# wSOL (Native Mint) address
WSOL_MINT = Pubkey.from_string("So11111111111111111111111111111111111111112")
WSOL_MINT_STR = "So11111111111111111111111111111111111111112"

# Token Program ID
TOKEN_PROGRAM_ID = Pubkey.from_string("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")

# SPL Token instruction discriminators
CLOSE_ACCOUNT_IX = 9  # CloseAccount instruction index


@dataclass
class WsolAccountInfo:
    """Information about a wSOL token account."""
    pubkey: str
    balance_lamports: int
    balance_sol: float
    owner: str
    delegated_amount: int = 0
    delegate: Optional[str] = None
    is_frozen: bool = False

    @property
    def has_active_delegation(self) -> bool:
        """Check if account has an active delegation."""
        return self.delegated_amount > 0 and self.delegate is not None

    @property
    def can_close(self) -> bool:
        """Check if account can be safely closed."""
        return not self.has_active_delegation and not self.is_frozen


@dataclass
class CleanupResult:
    """Result of a wSOL cleanup operation."""
    success: bool
    accounts_cleaned: int = 0
    total_sol_recovered: float = 0.0
    signatures: List[str] = None
    skipped_accounts: List[str] = None
    error: Optional[str] = None
    tx_fee_sol: float = 0.0  # Total transaction fees paid for cleanup

    def __post_init__(self):
        if self.signatures is None:
            self.signatures = []
        if self.skipped_accounts is None:
            self.skipped_accounts = []


def build_close_account_instruction(
    account: Pubkey,
    destination: Pubkey,
    owner: Pubkey,
) -> Instruction:
    """
    Build an instruction to close a token account.

    For wSOL accounts, this effectively "unwraps" the SOL by:
    1. Transferring all lamports (including rent) to the destination
    2. Closing the token account

    Args:
        account: The token account to close (wSOL ATA)
        destination: Where to send the SOL (usually the wallet)
        owner: The owner of the token account (signer)

    Returns:
        Instruction to close the account
    """
    # CloseAccount instruction: index 9, no data payload needed
    data = bytes([CLOSE_ACCOUNT_IX])

    return Instruction(
        program_id=TOKEN_PROGRAM_ID,
        accounts=[
            AccountMeta(pubkey=account, is_signer=False, is_writable=True),
            AccountMeta(pubkey=destination, is_signer=False, is_writable=True),
            AccountMeta(pubkey=owner, is_signer=True, is_writable=False),
        ],
        data=data,
    )


class WsolCleanupManager:
    """
    Manages wSOL account detection and cleanup.

    Provides methods to:
    - Detect wSOL token accounts in a wallet
    - Close/unwrap wSOL accounts (returns SOL to native balance)
    - Handle edge cases (delegations, frozen accounts)
    """

    def __init__(self, solana_client=None):
        """
        Initialize the cleanup manager.

        Args:
            solana_client: SolanaClient instance (will be fetched if not provided)
        """
        self._solana_client = solana_client
        self._enabled = self._get_cleanup_enabled()

    def _get_cleanup_enabled(self) -> bool:
        """Check if wSOL cleanup is enabled via environment."""
        import os
        env_value = os.getenv('WSOL_CLEANUP_ENABLED', 'true').lower()
        return env_value in ('true', '1', 'yes')

    @property
    def is_enabled(self) -> bool:
        """Check if cleanup is enabled."""
        return self._enabled

    async def _get_solana_client(self):
        """Get or create Solana client."""
        if self._solana_client is None:
            from app.chain.solana_client import get_solana_client
            self._solana_client = await get_solana_client()
        return self._solana_client

    async def get_wsol_accounts(
        self,
        wallet_pubkey: Optional[str] = None,
    ) -> List[WsolAccountInfo]:
        """
        Get all wSOL token accounts for a wallet.

        Args:
            wallet_pubkey: Wallet public key (defaults to loaded wallet)

        Returns:
            List of WsolAccountInfo for each wSOL account found
        """
        solana = await self._get_solana_client()

        if wallet_pubkey is None:
            wallet_pubkey = str(solana.wallet_pubkey)

        logger.debug("scanning_for_wsol_accounts", wallet=wallet_pubkey[:16])

        try:
            # Get all token accounts for the wallet
            token_accounts = await solana.get_token_accounts_by_owner(wallet_pubkey)

            # Filter for wSOL accounts
            wsol_accounts = []
            for account in token_accounts:
                if account.get("mint") == WSOL_MINT_STR:
                    # Get more details about the account
                    account_pubkey = account.get("pubkey")
                    balance_lamports = account.get("amount", 0)

                    # Check for delegation and freeze state
                    # This requires parsing the full account data
                    delegated_amount = 0
                    delegate = None
                    is_frozen = False

                    try:
                        account_info = await solana.get_account_info(account_pubkey)
                        if account_info and len(account_info.data) >= 165:
                            # Parse Token Account data structure
                            # Offset 72: delegate (32 bytes, optional)
                            # Offset 104: delegated_amount (8 bytes)
                            # Offset 108: state (1 byte, 0=uninitialized, 1=initialized, 2=frozen)
                            data = account_info.data

                            # Check if delegate is set (not zero pubkey)
                            delegate_bytes = data[72:104]
                            if any(b != 0 for b in delegate_bytes):
                                delegate = str(Pubkey.from_bytes(delegate_bytes))
                                delegated_amount = struct.unpack_from("<Q", data, 104)[0]

                            # Check account state
                            state = data[108]
                            is_frozen = state == 2
                    except Exception as e:
                        logger.debug("failed_to_parse_account_details", error=str(e))

                    wsol_info = WsolAccountInfo(
                        pubkey=account_pubkey,
                        balance_lamports=balance_lamports,
                        balance_sol=balance_lamports / 1_000_000_000,
                        owner=wallet_pubkey,
                        delegated_amount=delegated_amount,
                        delegate=delegate,
                        is_frozen=is_frozen,
                    )
                    wsol_accounts.append(wsol_info)

                    logger.debug(
                        "found_wsol_account",
                        pubkey=account_pubkey[:16],
                        balance_sol=wsol_info.balance_sol,
                        has_delegation=wsol_info.has_active_delegation,
                        is_frozen=is_frozen,
                    )

            logger.info(
                "wsol_scan_complete",
                wallet=wallet_pubkey[:16],
                accounts_found=len(wsol_accounts),
                total_sol=sum(a.balance_sol for a in wsol_accounts),
            )

            return wsol_accounts

        except Exception as e:
            logger.error("failed_to_scan_wsol_accounts", error=str(e))
            return []

    async def cleanup_wsol_accounts(
        self,
        wallet_pubkey: Optional[str] = None,
        min_balance_lamports: int = 0,
    ) -> CleanupResult:
        """
        Close all wSOL token accounts and recover SOL.

        This unwraps wSOL by closing the token accounts, which transfers
        all lamports (balance + rent) back to the native SOL balance.

        Args:
            wallet_pubkey: Wallet public key (defaults to loaded wallet)
            min_balance_lamports: Only close accounts with at least this balance

        Returns:
            CleanupResult with details of the operation
        """
        if not self._enabled:
            logger.info("wsol_cleanup_disabled")
            return CleanupResult(success=True, error="Cleanup disabled")

        solana = await self._get_solana_client()

        if wallet_pubkey is None:
            wallet_pubkey = str(solana.wallet_pubkey)

        logger.info(
            "starting_wsol_cleanup",
            wallet=wallet_pubkey[:16],
            min_balance=min_balance_lamports,
        )

        # Get all wSOL accounts
        wsol_accounts = await self.get_wsol_accounts(wallet_pubkey)

        if not wsol_accounts:
            logger.info("no_wsol_accounts_to_cleanup")
            return CleanupResult(success=True, accounts_cleaned=0)

        # Filter accounts that can be closed
        closeable = []
        skipped = []

        for account in wsol_accounts:
            if account.balance_lamports < min_balance_lamports:
                logger.debug(
                    "skipping_account_below_threshold",
                    pubkey=account.pubkey[:16],
                    balance=account.balance_lamports,
                )
                skipped.append(account.pubkey)
                continue

            if not account.can_close:
                if account.has_active_delegation:
                    logger.warning(
                        "skipping_account_with_delegation",
                        pubkey=account.pubkey[:16],
                        delegate=account.delegate[:16] if account.delegate else None,
                        delegated_amount=account.delegated_amount,
                    )
                elif account.is_frozen:
                    logger.warning(
                        "skipping_frozen_account",
                        pubkey=account.pubkey[:16],
                    )
                skipped.append(account.pubkey)
                continue

            closeable.append(account)

        if not closeable:
            logger.info(
                "no_closeable_wsol_accounts",
                total_accounts=len(wsol_accounts),
                skipped=len(skipped),
            )
            return CleanupResult(
                success=True,
                accounts_cleaned=0,
                skipped_accounts=skipped,
            )

        # Build and execute close transactions
        from app.chain.transaction_manager import (
            TransactionBundle,
            get_transaction_manager,
        )

        tx_manager = await get_transaction_manager()
        wallet_pk = Pubkey.from_string(wallet_pubkey)

        signatures = []
        total_recovered = 0.0
        accounts_closed = 0
        total_tx_fee_sol = 0.0  # Accumulator for transaction fees

        for account in closeable:
            try:
                account_pk = Pubkey.from_string(account.pubkey)

                # Build close instruction
                close_ix = build_close_account_instruction(
                    account=account_pk,
                    destination=wallet_pk,
                    owner=wallet_pk,
                )

                # Set priority fee from config if enabled
                priority_fee = None
                if settings.tx_priority_fee_enabled:
                    priority_fee = settings.tx_priority_fee_microlamports

                bundle = TransactionBundle(
                    instructions=[close_ix],
                    signers=[],
                    description=f"Close wSOL account {account.pubkey[:8]}...",
                    priority_fee=priority_fee,
                )

                logger.info(
                    "closing_wsol_account",
                    pubkey=account.pubkey[:16],
                    balance_sol=account.balance_sol,
                )

                receipt = await tx_manager.submit_transaction(bundle)

                if receipt.is_success:
                    signatures.append(receipt.signature)
                    total_recovered += account.balance_sol
                    accounts_closed += 1
                    # Extract transaction fee from receipt (default ~0.000005 SOL if not available)
                    tx_fee = getattr(receipt, 'fee', None) or getattr(receipt, 'tx_fee_sol', None) or 0.000005
                    total_tx_fee_sol += tx_fee
                    logger.info(
                        "wsol_account_closed",
                        pubkey=account.pubkey[:16],
                        signature=receipt.signature,
                        sol_recovered=account.balance_sol,
                        tx_fee_sol=tx_fee,
                    )
                else:
                    logger.error(
                        "failed_to_close_wsol_account",
                        pubkey=account.pubkey[:16],
                        error=receipt.error,
                    )
                    skipped.append(account.pubkey)

            except Exception as e:
                logger.error(
                    "wsol_cleanup_error",
                    pubkey=account.pubkey[:16],
                    error=str(e),
                )
                skipped.append(account.pubkey)

        logger.info(
            "wsol_cleanup_complete",
            accounts_closed=accounts_closed,
            total_sol_recovered=total_recovered,
            total_tx_fee_sol=total_tx_fee_sol,
            skipped=len(skipped),
        )

        return CleanupResult(
            success=True,
            accounts_cleaned=accounts_closed,
            total_sol_recovered=total_recovered,
            signatures=signatures,
            skipped_accounts=skipped,
            tx_fee_sol=total_tx_fee_sol,
        )

    async def cleanup_single_account(
        self,
        account_pubkey: str,
    ) -> CleanupResult:
        """
        Close a specific wSOL token account.

        Args:
            account_pubkey: The wSOL account to close

        Returns:
            CleanupResult with details of the operation
        """
        if not self._enabled:
            logger.info("wsol_cleanup_disabled")
            return CleanupResult(success=True, error="Cleanup disabled")

        solana = await self._get_solana_client()
        wallet_pubkey = str(solana.wallet_pubkey)

        logger.info(
            "closing_single_wsol_account",
            account=account_pubkey[:16],
        )

        # Verify it's a wSOL account
        try:
            account_info = await solana.get_account_info(account_pubkey)
            if not account_info:
                return CleanupResult(
                    success=False,
                    error=f"Account not found: {account_pubkey}",
                )

            # Get token balance
            balance_info = await solana.get_token_balance(account_pubkey)
            balance_lamports = int(balance_info.get("amount", 0))
            balance_sol = balance_lamports / 1_000_000_000

        except Exception as e:
            return CleanupResult(
                success=False,
                error=f"Failed to get account info: {e}",
            )

        # Build and execute close transaction
        from app.chain.transaction_manager import (
            TransactionBundle,
            get_transaction_manager,
        )

        tx_manager = await get_transaction_manager()
        wallet_pk = Pubkey.from_string(wallet_pubkey)
        account_pk = Pubkey.from_string(account_pubkey)

        try:
            close_ix = build_close_account_instruction(
                account=account_pk,
                destination=wallet_pk,
                owner=wallet_pk,
            )

            # Set priority fee from config if enabled
            priority_fee = None
            if settings.tx_priority_fee_enabled:
                priority_fee = settings.tx_priority_fee_microlamports

            bundle = TransactionBundle(
                instructions=[close_ix],
                signers=[],
                description=f"Close wSOL account {account_pubkey[:8]}...",
                priority_fee=priority_fee,
            )

            receipt = await tx_manager.submit_transaction(bundle)

            if receipt.is_success:
                logger.info(
                    "wsol_account_closed",
                    pubkey=account_pubkey[:16],
                    signature=receipt.signature,
                    sol_recovered=balance_sol,
                )
                return CleanupResult(
                    success=True,
                    accounts_cleaned=1,
                    total_sol_recovered=balance_sol,
                    signatures=[receipt.signature],
                )
            else:
                return CleanupResult(
                    success=False,
                    error=receipt.error,
                )

        except Exception as e:
            logger.error(
                "failed_to_close_wsol_account",
                pubkey=account_pubkey[:16],
                error=str(e),
            )
            return CleanupResult(
                success=False,
                error=str(e),
            )


# Singleton instance
_cleanup_manager: Optional[WsolCleanupManager] = None


async def get_wsol_cleanup_manager() -> WsolCleanupManager:
    """Get or create the default wSOL cleanup manager singleton."""
    global _cleanup_manager
    if _cleanup_manager is None:
        _cleanup_manager = WsolCleanupManager()
    return _cleanup_manager


async def cleanup_wsol(
    min_balance_lamports: int = 0,
) -> CleanupResult:
    """
    Convenience function to cleanup all wSOL accounts.

    Args:
        min_balance_lamports: Only close accounts with at least this balance

    Returns:
        CleanupResult with details of the operation
    """
    manager = await get_wsol_cleanup_manager()
    return await manager.cleanup_wsol_accounts(
        min_balance_lamports=min_balance_lamports,
    )


async def get_wsol_balance() -> float:
    """
    Get total wSOL balance across all accounts.

    Returns:
        Total wSOL balance in SOL
    """
    manager = await get_wsol_cleanup_manager()
    accounts = await manager.get_wsol_accounts()
    return sum(a.balance_sol for a in accounts)
