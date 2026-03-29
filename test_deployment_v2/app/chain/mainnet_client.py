"""
Mainnet data client for DRY_RUN mode.

Provides read-only access to mainnet pool state data regardless
of the configured wallet network. This allows simulating trades
with real market data while using simulated balances.
"""

from typing import Optional
import structlog
from solana.rpc.async_api import AsyncClient
from solana.rpc.commitment import Confirmed
from solders.pubkey import Pubkey

from app.config import get_settings

logger = structlog.get_logger(__name__)
settings = get_settings()


class MainnetDataClient:
    """
    Read-only client for fetching mainnet data.

    Used by DRY_RUN mode to get real pool state while
    the wallet may be configured for devnet/testnet.
    """

    def __init__(self, rpc_url: Optional[str] = None):
        self.rpc_url = rpc_url or settings.mainnet_rpc_url
        self._client: Optional[AsyncClient] = None

    async def connect(self) -> None:
        """Initialize connection to mainnet RPC."""
        if self._client is None:
            self._client = AsyncClient(self.rpc_url, commitment=Confirmed)
            logger.info("mainnet_client_connected", rpc_url=self.rpc_url)

    async def close(self) -> None:
        """Close the connection."""
        if self._client:
            await self._client.close()
            self._client = None
            logger.info("mainnet_client_disconnected")

    async def get_account_data(self, pubkey: str) -> Optional[bytes]:
        """
        Fetch account data from mainnet.

        Args:
            pubkey: Account public key

        Returns:
            Raw account data bytes or None if not found
        """
        if self._client is None:
            await self.connect()

        try:
            pk = Pubkey.from_string(pubkey)
            response = await self._client.get_account_info(pk)

            if response.value is None:
                logger.warning("mainnet_account_not_found", pubkey=pubkey)
                return None

            return bytes(response.value.data)

        except Exception as e:
            logger.error("mainnet_data_fetch_failed", pubkey=pubkey, error=str(e))
            return None

    async def account_exists(self, pubkey: str) -> bool:
        """Check if an account exists on mainnet."""
        data = await self.get_account_data(pubkey)
        return data is not None and len(data) > 0

    async def get_token_account_balance(self, token_account: str) -> int:
        """
        Get the balance of an SPL token account.

        Args:
            token_account: Token account public key (vault address)

        Returns:
            Balance in base units (lamports for SOL, micro-units for USDC)
        """
        if self._client is None:
            await self.connect()

        try:
            pk = Pubkey.from_string(token_account)
            response = await self._client.get_token_account_balance(pk)

            if response.value is None:
                logger.warning("token_account_not_found", account=token_account)
                return 0

            # response.value.amount is a string representing the balance
            balance = int(response.value.amount)
            logger.debug(
                "token_balance_fetched",
                account=token_account,
                balance=balance,
                decimals=response.value.decimals,
            )
            return balance

        except Exception as e:
            logger.error("token_balance_fetch_failed", account=token_account, error=str(e))
            return 0

    async def get_slot(self) -> int:
        """Get current slot number."""
        if self._client is None:
            await self.connect()

        try:
            response = await self._client.get_slot()
            return response.value
        except Exception as e:
            logger.error("get_slot_failed", error=str(e))
            return 0


# Singleton instance
_mainnet_client: Optional[MainnetDataClient] = None


async def get_mainnet_client() -> MainnetDataClient:
    """Get or create mainnet data client singleton."""
    global _mainnet_client
    if _mainnet_client is None:
        _mainnet_client = MainnetDataClient()
        await _mainnet_client.connect()
    return _mainnet_client


async def close_mainnet_client() -> None:
    """Close the mainnet client if open."""
    global _mainnet_client
    if _mainnet_client is not None:
        await _mainnet_client.close()
        _mainnet_client = None
