"""
Orca API Client for fetching pool metrics.

Provides methods for fetching TVL, Volume, and other metrics from the Orca API.
This is separate from the on-chain Orca client (orca_client.py) which handles
direct blockchain interactions.

API Documentation: https://docs.orca.so/
Base URL: https://api.mainnet.orca.so/v1/
"""

import asyncio
import logging
from dataclasses import dataclass
from datetime import datetime, timezone, timedelta
from typing import Optional, Dict, Any

import httpx

logger = logging.getLogger(__name__)

# Orca API base URL
ORCA_API_BASE_URL = "https://api.mainnet.orca.so/v1"

# Cache duration in seconds (5 minutes - balance between freshness and rate limits)
CACHE_DURATION_SECONDS = 300


@dataclass
class PoolMetrics:
    """
    Pool metrics from Orca API.

    Contains TVL, volume, and other pool statistics.
    """
    pool_address: str
    tvl: float  # Total Value Locked in USD
    volume_24h: float  # 24-hour trading volume in USD
    volume_7d: float  # 7-day trading volume in USD
    fee_rate: float  # Pool fee rate (e.g., 0.003 for 0.3%)
    price: float  # Current price from pool
    token_a_symbol: str  # Token A symbol (e.g., "SOL")
    token_b_symbol: str  # Token B symbol (e.g., "USDC")
    token_a_mint: str  # Token A mint address
    token_b_mint: str  # Token B mint address
    # Calculated metrics
    volume_tvl_ratio: float  # Volume/TVL ratio (APR indicator)
    # Metadata
    fetched_at: datetime
    is_cached: bool = False

    @property
    def estimated_apr_from_volume(self) -> float:
        """
        Estimate APR from volume/TVL ratio.

        This is a rough estimate: APR = (24h_volume * fee_rate * 365) / TVL
        Actual APR depends on position range, price movements, etc.
        """
        if self.tvl <= 0:
            return 0.0
        return (self.volume_24h * self.fee_rate * 365) / self.tvl * 100  # As percentage


class OrcaAPIClient:
    """
    Client for Orca REST API.

    Fetches pool metrics including TVL, Volume, and other statistics.
    Implements caching to reduce API calls and handle rate limits.
    """

    def __init__(self, base_url: str = ORCA_API_BASE_URL, cache_duration: int = CACHE_DURATION_SECONDS):
        """
        Initialize the Orca API client.

        Args:
            base_url: Orca API base URL
            cache_duration: Cache duration in seconds
        """
        self._base_url = base_url
        self._cache_duration = timedelta(seconds=cache_duration)
        self._cache: Dict[str, tuple[PoolMetrics, datetime]] = {}
        self._http_client: Optional[httpx.AsyncClient] = None

    async def _get_http_client(self) -> httpx.AsyncClient:
        """Get or create HTTP client."""
        if self._http_client is None or self._http_client.is_closed:
            self._http_client = httpx.AsyncClient(
                timeout=30.0,
                headers={
                    "Accept": "application/json",
                    "User-Agent": "LP-Strategy-Bot/1.0",
                }
            )
        return self._http_client

    async def close(self):
        """Close the HTTP client."""
        if self._http_client and not self._http_client.is_closed:
            await self._http_client.aclose()
            self._http_client = None

    def _get_cached(self, pool_address: str) -> Optional[PoolMetrics]:
        """Get cached metrics if valid."""
        if pool_address not in self._cache:
            return None

        metrics, cached_at = self._cache[pool_address]
        if datetime.now(timezone.utc) - cached_at > self._cache_duration:
            # Cache expired
            del self._cache[pool_address]
            return None

        # Return cached copy with is_cached flag
        return PoolMetrics(
            pool_address=metrics.pool_address,
            tvl=metrics.tvl,
            volume_24h=metrics.volume_24h,
            volume_7d=metrics.volume_7d,
            fee_rate=metrics.fee_rate,
            price=metrics.price,
            token_a_symbol=metrics.token_a_symbol,
            token_b_symbol=metrics.token_b_symbol,
            token_a_mint=metrics.token_a_mint,
            token_b_mint=metrics.token_b_mint,
            volume_tvl_ratio=metrics.volume_tvl_ratio,
            fetched_at=metrics.fetched_at,
            is_cached=True,
        )

    def _set_cache(self, pool_address: str, metrics: PoolMetrics):
        """Cache pool metrics."""
        self._cache[pool_address] = (metrics, datetime.now(timezone.utc))

    async def get_pool_metrics(self, pool_address: str, force_refresh: bool = False) -> Optional[PoolMetrics]:
        """
        Get pool metrics from Orca API.

        Args:
            pool_address: Whirlpool address
            force_refresh: Force refresh from API, bypassing cache

        Returns:
            PoolMetrics if successful, None if failed
        """
        # Check cache first
        if not force_refresh:
            cached = self._get_cached(pool_address)
            if cached:
                logger.debug(f"Using cached pool metrics for {pool_address[:16]}...")
                return cached

        try:
            client = await self._get_http_client()
            url = f"{self._base_url}/whirlpool/{pool_address}"

            logger.info(f"Fetching pool metrics from Orca API: {pool_address[:16]}...")
            response = await client.get(url)

            if response.status_code == 404:
                logger.warning(f"Pool not found in Orca API: {pool_address}")
                return None

            if response.status_code == 429:
                logger.warning("Orca API rate limit hit, using cached data if available")
                cached = self._get_cached(pool_address)
                return cached

            response.raise_for_status()
            data = response.json()

            # Parse response
            metrics = self._parse_pool_response(pool_address, data)

            if metrics:
                self._set_cache(pool_address, metrics)
                logger.info(
                    f"Pool metrics fetched: TVL=${metrics.tvl:,.0f}, "
                    f"Vol24h=${metrics.volume_24h:,.0f}, "
                    f"Vol/TVL={metrics.volume_tvl_ratio:.4f}"
                )

            return metrics

        except httpx.TimeoutException:
            logger.warning(f"Timeout fetching pool metrics for {pool_address[:16]}...")
            return self._get_cached(pool_address)
        except httpx.HTTPStatusError as e:
            logger.error(f"HTTP error fetching pool metrics: {e.response.status_code}")
            return self._get_cached(pool_address)
        except Exception as e:
            logger.error(f"Error fetching pool metrics: {e}")
            return self._get_cached(pool_address)

    def _parse_pool_response(self, pool_address: str, data: Dict[str, Any]) -> Optional[PoolMetrics]:
        """
        Parse Orca API response into PoolMetrics.

        The Orca API returns data in this format:
        {
            "address": "...",
            "tokenA": { "mint": "...", "symbol": "...", ... },
            "tokenB": { "mint": "...", "symbol": "...", ... },
            "price": 225.123,
            "tvl": 12345678.90,
            "volume": { "day": 1234567.89, "week": 8765432.10, ... },
            "feeRate": 0.003,
            ...
        }
        """
        try:
            # Extract TVL
            tvl = float(data.get("tvl", 0) or 0)

            # Extract volume - handle both formats
            volume_data = data.get("volume", {})
            if isinstance(volume_data, dict):
                volume_24h = float(volume_data.get("day", 0) or 0)
                volume_7d = float(volume_data.get("week", 0) or 0)
            else:
                # Fallback if volume is just a number
                volume_24h = float(volume_data or 0)
                volume_7d = 0.0

            # Extract fee rate
            fee_rate = float(data.get("feeRate", 0.003) or 0.003)

            # Extract price
            price = float(data.get("price", 0) or 0)

            # Extract token info
            token_a = data.get("tokenA", {})
            token_b = data.get("tokenB", {})

            token_a_symbol = token_a.get("symbol", "TOKEN_A")
            token_b_symbol = token_b.get("symbol", "TOKEN_B")
            token_a_mint = token_a.get("mint", "")
            token_b_mint = token_b.get("mint", "")

            # Calculate volume/TVL ratio
            volume_tvl_ratio = (volume_24h / tvl) if tvl > 0 else 0.0

            return PoolMetrics(
                pool_address=pool_address,
                tvl=tvl,
                volume_24h=volume_24h,
                volume_7d=volume_7d,
                fee_rate=fee_rate,
                price=price,
                token_a_symbol=token_a_symbol,
                token_b_symbol=token_b_symbol,
                token_a_mint=token_a_mint,
                token_b_mint=token_b_mint,
                volume_tvl_ratio=volume_tvl_ratio,
                fetched_at=datetime.now(timezone.utc),
                is_cached=False,
            )

        except Exception as e:
            logger.error(f"Error parsing pool response: {e}")
            return None

    async def get_tvl(self, pool_address: str) -> float:
        """Get pool TVL in USD."""
        metrics = await self.get_pool_metrics(pool_address)
        return metrics.tvl if metrics else 0.0

    async def get_volume_24h(self, pool_address: str) -> float:
        """Get pool 24h volume in USD."""
        metrics = await self.get_pool_metrics(pool_address)
        return metrics.volume_24h if metrics else 0.0


# Singleton instance
_orca_api_client: Optional[OrcaAPIClient] = None


def get_orca_api_client() -> OrcaAPIClient:
    """Get or create the global Orca API client instance."""
    global _orca_api_client
    if _orca_api_client is None:
        _orca_api_client = OrcaAPIClient()
    return _orca_api_client


def reset_orca_api_client():
    """Reset the global Orca API client instance (for testing)."""
    global _orca_api_client
    if _orca_api_client:
        asyncio.create_task(_orca_api_client.close())
    _orca_api_client = None
