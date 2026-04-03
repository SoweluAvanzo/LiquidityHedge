"""
Birdeye API client for historical price data.

Provides access to Birdeye's price history and OHLCV data for Solana tokens.
API Documentation: https://docs.birdeye.so/
"""

from dataclasses import dataclass
from datetime import datetime, timedelta
from decimal import Decimal
from typing import Optional, List, Dict, Any
from enum import Enum

import httpx
import structlog

from app.config import get_settings

logger = structlog.get_logger(__name__)
settings = get_settings()

# Birdeye API base URL
BIRDEYE_API_URL = "https://public-api.birdeye.so"

# Common token addresses
SOL_ADDRESS = "So11111111111111111111111111111111111111112"
USDC_ADDRESS = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"


class TimeInterval(str, Enum):
    """OHLCV time intervals."""
    ONE_MINUTE = "1m"
    FIVE_MINUTES = "5m"
    FIFTEEN_MINUTES = "15m"
    THIRTY_MINUTES = "30m"
    ONE_HOUR = "1H"
    FOUR_HOURS = "4H"
    ONE_DAY = "1D"
    ONE_WEEK = "1W"


@dataclass
class PricePoint:
    """Single price data point."""
    timestamp: datetime
    price: Decimal
    volume: Optional[Decimal] = None


@dataclass
class OHLCVCandle:
    """OHLCV candlestick data."""
    timestamp: datetime
    open: Decimal
    high: Decimal
    low: Decimal
    close: Decimal
    volume: Decimal


@dataclass
class TokenInfo:
    """Token information from Birdeye."""
    address: str
    symbol: str
    name: str
    decimals: int
    price_usd: Decimal
    price_change_24h: Optional[float] = None
    volume_24h: Optional[Decimal] = None
    liquidity: Optional[Decimal] = None


class BirdeyeClient:
    """
    Client for Birdeye API.

    Provides methods for:
    - Current token prices
    - Historical price data
    - OHLCV candlestick data
    - Token information
    """

    def __init__(self, api_key: Optional[str] = None):
        """
        Initialize Birdeye client.

        Args:
            api_key: Birdeye API key (optional, uses public endpoints if not provided)
        """
        self.api_key = api_key or getattr(settings, 'birdeye_api_key', None)
        self._client: Optional[httpx.AsyncClient] = None

    async def _get_client(self) -> httpx.AsyncClient:
        """Get or create HTTP client."""
        if self._client is None or self._client.is_closed:
            headers = {"accept": "application/json"}
            if self.api_key:
                headers["X-API-KEY"] = self.api_key
            self._client = httpx.AsyncClient(
                base_url=BIRDEYE_API_URL,
                headers=headers,
                timeout=30.0,
            )
        return self._client

    async def close(self):
        """Close the HTTP client."""
        if self._client and not self._client.is_closed:
            await self._client.aclose()

    async def get_token_price(self, token_address: str) -> Optional[Decimal]:
        """
        Get current price for a token.

        Args:
            token_address: Token mint address

        Returns:
            Current price in USD or None
        """
        client = await self._get_client()

        try:
            response = await client.get(
                "/defi/price",
                params={"address": token_address}
            )
            response.raise_for_status()
            data = response.json()

            if data.get("success") and data.get("data"):
                price = data["data"].get("value")
                if price is not None:
                    return Decimal(str(price))

            return None

        except Exception as e:
            logger.warning("birdeye_get_price_failed", token=token_address, error=str(e))
            return None

    async def get_token_info(self, token_address: str) -> Optional[TokenInfo]:
        """
        Get detailed token information.

        Args:
            token_address: Token mint address

        Returns:
            TokenInfo or None
        """
        client = await self._get_client()

        try:
            response = await client.get(
                "/defi/token_overview",
                params={"address": token_address}
            )
            response.raise_for_status()
            data = response.json()

            if data.get("success") and data.get("data"):
                info = data["data"]
                return TokenInfo(
                    address=token_address,
                    symbol=info.get("symbol", ""),
                    name=info.get("name", ""),
                    decimals=info.get("decimals", 0),
                    price_usd=Decimal(str(info.get("price", 0))),
                    price_change_24h=info.get("priceChange24hPercent"),
                    volume_24h=Decimal(str(info.get("v24hUSD", 0))) if info.get("v24hUSD") else None,
                    liquidity=Decimal(str(info.get("liquidity", 0))) if info.get("liquidity") else None,
                )

            return None

        except Exception as e:
            logger.warning("birdeye_get_token_info_failed", token=token_address, error=str(e))
            return None

    async def get_price_history(
        self,
        token_address: str,
        interval: TimeInterval = TimeInterval.ONE_HOUR,
        time_from: Optional[datetime] = None,
        time_to: Optional[datetime] = None,
    ) -> List[PricePoint]:
        """
        Get historical price data for a token.

        Args:
            token_address: Token mint address
            interval: Time interval for data points
            time_from: Start time (defaults to 7 days ago)
            time_to: End time (defaults to now)

        Returns:
            List of PricePoint objects
        """
        client = await self._get_client()

        # Default time range
        if time_to is None:
            time_to = datetime.utcnow()
        if time_from is None:
            time_from = time_to - timedelta(days=7)

        try:
            response = await client.get(
                "/defi/history_price",
                params={
                    "address": token_address,
                    "address_type": "token",
                    "type": interval.value,
                    "time_from": int(time_from.timestamp()),
                    "time_to": int(time_to.timestamp()),
                }
            )
            response.raise_for_status()
            data = response.json()

            prices = []
            if data.get("success") and data.get("data", {}).get("items"):
                for item in data["data"]["items"]:
                    prices.append(PricePoint(
                        timestamp=datetime.fromtimestamp(item["unixTime"]),
                        price=Decimal(str(item["value"])),
                    ))

            return prices

        except Exception as e:
            logger.warning(
                "birdeye_get_price_history_failed",
                token=token_address,
                error=str(e)
            )
            return []

    async def get_ohlcv(
        self,
        token_address: str,
        interval: TimeInterval = TimeInterval.ONE_HOUR,
        time_from: Optional[datetime] = None,
        time_to: Optional[datetime] = None,
    ) -> List[OHLCVCandle]:
        """
        Get OHLCV candlestick data for a token.

        Args:
            token_address: Token mint address
            interval: Candle interval
            time_from: Start time (defaults to 7 days ago)
            time_to: End time (defaults to now)

        Returns:
            List of OHLCVCandle objects
        """
        client = await self._get_client()

        # Default time range
        if time_to is None:
            time_to = datetime.utcnow()
        if time_from is None:
            time_from = time_to - timedelta(days=7)

        try:
            response = await client.get(
                "/defi/ohlcv",
                params={
                    "address": token_address,
                    "type": interval.value,
                    "time_from": int(time_from.timestamp()),
                    "time_to": int(time_to.timestamp()),
                }
            )
            response.raise_for_status()
            data = response.json()

            candles = []
            if data.get("success") and data.get("data", {}).get("items"):
                for item in data["data"]["items"]:
                    candles.append(OHLCVCandle(
                        timestamp=datetime.fromtimestamp(item["unixTime"]),
                        open=Decimal(str(item["o"])),
                        high=Decimal(str(item["h"])),
                        low=Decimal(str(item["l"])),
                        close=Decimal(str(item["c"])),
                        volume=Decimal(str(item["v"])),
                    ))

            return candles

        except Exception as e:
            logger.warning(
                "birdeye_get_ohlcv_failed",
                token=token_address,
                error=str(e)
            )
            return []

    async def get_sol_price_history(
        self,
        days: int = 30,
        interval: TimeInterval = TimeInterval.ONE_HOUR,
    ) -> List[PricePoint]:
        """
        Get SOL/USD price history.

        Args:
            days: Number of days of history
            interval: Time interval

        Returns:
            List of PricePoint objects
        """
        time_to = datetime.utcnow()
        time_from = time_to - timedelta(days=days)

        return await self.get_price_history(
            SOL_ADDRESS,
            interval=interval,
            time_from=time_from,
            time_to=time_to,
        )

    async def get_multi_price(
        self,
        token_addresses: List[str],
    ) -> Dict[str, Decimal]:
        """
        Get prices for multiple tokens.

        Args:
            token_addresses: List of token mint addresses

        Returns:
            Dict mapping address to price
        """
        client = await self._get_client()
        prices = {}

        try:
            # Birdeye supports multi-price endpoint
            addresses_str = ",".join(token_addresses)
            response = await client.get(
                "/defi/multi_price",
                params={"list_address": addresses_str}
            )
            response.raise_for_status()
            data = response.json()

            if data.get("success") and data.get("data"):
                for address, info in data["data"].items():
                    if info and info.get("value") is not None:
                        prices[address] = Decimal(str(info["value"]))

        except Exception as e:
            logger.warning("birdeye_get_multi_price_failed", error=str(e))
            # Fall back to individual requests
            for addr in token_addresses:
                price = await self.get_token_price(addr)
                if price:
                    prices[addr] = price

        return prices


# Singleton instance
_default_client: Optional[BirdeyeClient] = None


async def get_birdeye_client() -> BirdeyeClient:
    """Get or create the default Birdeye client singleton."""
    global _default_client
    if _default_client is None:
        _default_client = BirdeyeClient()
    return _default_client
