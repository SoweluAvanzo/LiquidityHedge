"""
Solana RPC client wrapper.

Provides async methods for interacting with the Solana blockchain
with retry logic and connection pooling.
"""

import asyncio
import base64
from dataclasses import dataclass
from typing import Optional, List, Any, Dict

import structlog
from solana.rpc.async_api import AsyncClient
from solana.rpc.commitment import Commitment, Confirmed, Finalized
from solana.rpc.types import TxOpts, TokenAccountOpts
from solders.keypair import Keypair
from solders.pubkey import Pubkey
from solders.signature import Signature
from solders.transaction import Transaction, VersionedTransaction
from tenacity import retry, stop_after_attempt, wait_exponential, retry_if_exception_type

from app.config import get_settings

logger = structlog.get_logger(__name__)
settings = get_settings()


@dataclass
class AccountInfo:
    """Account information from Solana."""
    pubkey: str
    lamports: int
    owner: str
    data: bytes
    executable: bool
    rent_epoch: int


@dataclass
class TransactionResult:
    """Result of a transaction send."""
    signature: str
    success: bool
    error: Optional[str] = None
    slot: Optional[int] = None


class SolanaClient:
    """
    Async Solana RPC client with retry logic.

    Provides methods for:
    - Account data fetching
    - Balance queries
    - Transaction sending
    - Signature confirmation
    """

    def __init__(
        self,
        rpc_url: Optional[str] = None,
        commitment: Commitment = Confirmed,
    ):
        """
        Initialize the Solana client.

        Args:
            rpc_url: Solana RPC endpoint URL
            commitment: Default commitment level
        """
        self.rpc_url = rpc_url or settings.solana_rpc_url
        self.commitment = commitment
        self._client: Optional[AsyncClient] = None
        self._wallet: Optional[Keypair] = None

    async def connect(self) -> None:
        """Initialize the async client connection."""
        if self._client is None:
            self._client = AsyncClient(self.rpc_url, commitment=self.commitment)
            logger.info("solana_client_connected", rpc_url=self.rpc_url)

    async def close(self) -> None:
        """Close the client connection."""
        if self._client:
            await self._client.close()
            self._client = None
            logger.info("solana_client_disconnected")

    async def __aenter__(self) -> "SolanaClient":
        """Async context manager entry."""
        await self.connect()
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb) -> None:
        """Async context manager exit."""
        await self.close()

    @property
    def client(self) -> AsyncClient:
        """Get the async client, raising if not connected."""
        if self._client is None:
            raise RuntimeError("SolanaClient not connected. Call connect() first.")
        return self._client

    def load_wallet(self, private_key_base58: Optional[str] = None) -> Keypair:
        """
        Load wallet from private key.

        Args:
            private_key_base58: Private key in base58 format

        Returns:
            Keypair: The loaded wallet keypair
        """
        key = private_key_base58 or settings.wallet_private_key_base58
        if not key:
            raise ValueError("No wallet private key provided")

        import base58
        secret_key = base58.b58decode(key)
        self._wallet = Keypair.from_bytes(secret_key)
        logger.info("wallet_loaded", pubkey=str(self._wallet.pubkey()))
        return self._wallet

    @property
    def wallet(self) -> Keypair:
        """Get the loaded wallet keypair."""
        if self._wallet is None:
            raise RuntimeError("Wallet not loaded. Call load_wallet() first.")
        return self._wallet

    @property
    def wallet_pubkey(self) -> Pubkey:
        """Get the wallet public key."""
        return self.wallet.pubkey()

    @retry(
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=1, max=10),
        retry=retry_if_exception_type(Exception),
    )
    async def get_balance(self, pubkey: Optional[str] = None) -> int:
        """
        Get SOL balance in lamports.

        Args:
            pubkey: Public key to check (defaults to wallet)

        Returns:
            int: Balance in lamports
        """
        pk = Pubkey.from_string(pubkey) if pubkey else self.wallet_pubkey
        response = await self.client.get_balance(pk)

        if response.value is None:
            return 0

        return response.value

    async def get_balance_sol(self, pubkey: Optional[str] = None) -> float:
        """
        Get SOL balance as float.

        Args:
            pubkey: Public key to check (defaults to wallet)

        Returns:
            float: Balance in SOL
        """
        lamports = await self.get_balance(pubkey)
        return lamports / 1_000_000_000

    @retry(
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=1, max=10),
        retry=retry_if_exception_type(Exception),
    )
    async def get_account_info(self, pubkey: str) -> Optional[AccountInfo]:
        """
        Get account information.

        Args:
            pubkey: Account public key

        Returns:
            AccountInfo or None if account doesn't exist
        """
        pk = Pubkey.from_string(pubkey)
        response = await self.client.get_account_info(pk)

        if response.value is None:
            return None

        account = response.value
        return AccountInfo(
            pubkey=pubkey,
            lamports=account.lamports,
            owner=str(account.owner),
            data=bytes(account.data),
            executable=account.executable,
            rent_epoch=account.rent_epoch,
        )

    @retry(
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=1, max=10),
        retry=retry_if_exception_type(Exception),
    )
    async def get_account_data(self, pubkey: str) -> Optional[bytes]:
        """
        Get raw account data.

        Args:
            pubkey: Account public key

        Returns:
            bytes: Account data or None
        """
        account = await self.get_account_info(pubkey)
        return account.data if account else None

    @retry(
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=1, max=10),
        retry=retry_if_exception_type(Exception),
    )
    async def get_token_balance(
        self,
        token_account: str,
    ) -> Dict[str, Any]:
        """
        Get SPL token balance.

        Args:
            token_account: Token account address

        Returns:
            dict: Token balance info with amount and decimals
        """
        pk = Pubkey.from_string(token_account)
        response = await self.client.get_token_account_balance(pk)

        if response.value is None:
            return {"amount": "0", "decimals": 0, "ui_amount": 0.0}

        return {
            "amount": response.value.amount,
            "decimals": response.value.decimals,
            "ui_amount": float(response.value.ui_amount or 0),
        }

    async def get_recent_blockhash(self) -> str:
        """
        Get recent blockhash for transaction building.

        Returns:
            str: Recent blockhash
        """
        response = await self.client.get_latest_blockhash()
        return str(response.value.blockhash)

    @retry(
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=1, max=10),
        retry=retry_if_exception_type(Exception),
    )
    async def get_token_accounts_by_owner(
        self,
        owner: str,
        program_id: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        """
        Get all token accounts owned by an address.

        Args:
            owner: Owner wallet address
            program_id: Optional token program ID filter

        Returns:
            List of token account info dicts
        """
        from spl.token.constants import TOKEN_PROGRAM_ID

        owner_pk = Pubkey.from_string(owner)
        program_pk = Pubkey.from_string(program_id) if program_id else TOKEN_PROGRAM_ID

        response = await self.client.get_token_accounts_by_owner_json_parsed(
            owner_pk,
            opts=TokenAccountOpts(program_id=program_pk),
        )

        if response.value is None:
            return []

        accounts = []
        for account in response.value:
            info = account.account.data.parsed.get("info", {})
            token_amount = info.get("tokenAmount", {})
            accounts.append({
                "pubkey": str(account.pubkey),
                "mint": info.get("mint"),
                "owner": info.get("owner"),
                "amount": int(token_amount.get("amount", 0)),
                "decimals": token_amount.get("decimals", 0),
                "ui_amount": float(token_amount.get("uiAmount") or 0),
            })

        return accounts

    async def send_transaction(
        self,
        transaction: Transaction | VersionedTransaction,
        signers: Optional[List[Keypair]] = None,
        opts: Optional[TxOpts] = None,
    ) -> TransactionResult:
        """
        Sign and send a transaction.

        Args:
            transaction: Transaction to send
            signers: Additional signers (wallet is always included)
            opts: Transaction options

        Returns:
            TransactionResult: Result with signature and status
        """
        try:
            all_signers = [self.wallet]
            if signers:
                all_signers.extend(signers)

            if opts is None:
                opts = TxOpts(skip_preflight=False, preflight_commitment=self.commitment)

            # Send transaction
            if isinstance(transaction, VersionedTransaction):
                # CRITICAL FIX: VersionedTransaction must be signed before sending!
                # The transaction from Jupiter is unsigned - create a new signed version
                # by passing the message and signers to the constructor
                signed_tx = VersionedTransaction(transaction.message, all_signers)
                response = await self.client.send_transaction(
                    signed_tx,
                    opts=opts,
                )
            else:
                response = await self.client.send_transaction(
                    transaction,
                    *all_signers,
                    opts=opts,
                )

            signature = str(response.value)
            logger.info("transaction_sent", signature=signature)

            return TransactionResult(
                signature=signature,
                success=True,
            )

        except Exception as e:
            logger.error("transaction_failed", error=str(e))
            return TransactionResult(
                signature="",
                success=False,
                error=str(e),
            )

    async def confirm_transaction(
        self,
        signature: str,
        commitment: Commitment = Finalized,
        timeout: int = 60,
    ) -> bool:
        """
        Wait for transaction confirmation.

        Args:
            signature: Transaction signature
            commitment: Confirmation commitment level
            timeout: Timeout in seconds

        Returns:
            bool: True if confirmed, False otherwise
        """
        # Always check confirmation for real transactions

        try:
            sig = Signature.from_string(signature)
            response = await self.client.confirm_transaction(
                sig,
                commitment=commitment,
                sleep_seconds=1,
            )
            return response.value is not None

        except Exception as e:
            logger.error("confirmation_failed", signature=signature, error=str(e))
            return False

    async def get_slot(self) -> int:
        """Get current slot."""
        response = await self.client.get_slot()
        return response.value

    async def is_connected(self) -> bool:
        """Check if connected to RPC."""
        try:
            await self.get_slot()
            return True
        except Exception:
            return False


# Singleton instance for convenience
_default_client: Optional[SolanaClient] = None


async def get_solana_client() -> SolanaClient:
    """Get or create the default Solana client singleton."""
    global _default_client
    if _default_client is None:
        _default_client = SolanaClient()
        await _default_client.connect()
        if settings.wallet_private_key_base58:
            _default_client.load_wallet()
    return _default_client
