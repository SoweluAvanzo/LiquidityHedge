"""
Cambrian API client for historical Orca Whirlpool data.

Provides access to historical fee APR, volume, and TVL data for Orca Whirlpools.
API Documentation: https://docs.cambrian.org/docs/orca-whirlpools-api-user-guide
"""

from dataclasses import dataclass
from datetime import datetime, timedelta
from decimal import Decimal
from typing import Optional, List, Dict, Any

import httpx
import structlog

from app.config import get_settings

logger = structlog.get_logger(__name__)
settings = get_settings()

# Cambrian API base URL
CAMBRIAN_API_URL = "https://api.cambrian.org"

# Known SOL/USDC Whirlpool addresses (different fee tiers)
SOL_USDC_POOLS = {
    "4bps": "Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE",   # 0.04% fee
    "16bps": "21gTfxAnhUDjJGZJDkTXctGFKT8TeiXx6pN1CEg9K1uW",  # 0.16% fee
    "64bps": "HJPjoWUrhoZzkNfRpHuieeFk9WcZWjwy6PBjZ81ngndJ",  # 0.64% fee
}

# Default pool (most liquid, 0.04% fee tier)
DEFAULT_SOL_USDC_POOL = SOL_USDC_POOLS["4bps"]


@dataclass
class DailyFeeData:
    """Daily fee and volume data for a pool."""
    date: datetime
    fee_apr: float  # Annualized fee APR as percentage (e.g., 25.5 means 25.5%)
    fees_usd: float  # Total fees in USD for the day
    volume_usd: float  # Trading volume in USD
    tvl_usd: float  # Total value locked in USD


@dataclass
class PoolMetrics:
    """Current pool metrics snapshot."""
    pool_id: str
    tvl_usd: float
    volume_24h_usd: float
    volume_7d_usd: float
    volume_30d_usd: float
    fees_24h_usd: float
    fees_7d_usd: float
    fees_30d_usd: float
    apr_24h: float
    apr_7d: float
    apr_30d: float


class CambrianClient:
    """
    Client for Cambrian API.

    Provides methods for:
    - Historical daily fee APR data
    - Pool metrics and volume data
    - TVL history

    Note: Requires a Cambrian API key. Sign up at https://www.cambrian.org/
    """

    def __init__(self, api_key: Optional[str] = None):
        """
        Initialize Cambrian client.

        Args:
            api_key: Cambrian API key (required for data access)
        """
        self.api_key = api_key or getattr(settings, 'cambrian_api_key', None)
        self._client: Optional[httpx.AsyncClient] = None

    @property
    def is_configured(self) -> bool:
        """Check if API key is configured."""
        return bool(self.api_key)

    async def _get_client(self) -> httpx.AsyncClient:
        """Get or create HTTP client."""
        if self._client is None or self._client.is_closed:
            headers = {
                "accept": "application/json",
                "Content-Type": "application/json",
            }
            if self.api_key:
                headers["x-api-key"] = self.api_key
            self._client = httpx.AsyncClient(
                base_url=CAMBRIAN_API_URL,
                headers=headers,
                timeout=30.0,
            )
        return self._client

    async def close(self):
        """Close the HTTP client."""
        if self._client and not self._client.is_closed:
            await self._client.aclose()

    async def get_pool_metrics(
        self,
        pool_id: str = DEFAULT_SOL_USDC_POOL,
    ) -> Optional[PoolMetrics]:
        """
        Get current pool metrics including APR snapshots.

        Args:
            pool_id: Whirlpool address

        Returns:
            PoolMetrics or None if unavailable
        """
        if not self.api_key:
            logger.warning("cambrian_no_api_key", msg="Cambrian API key not configured")
            return None

        client = await self._get_client()

        try:
            response = await client.get(
                f"/v1/orca/pool/{pool_id}/metrics"
            )
            response.raise_for_status()
            data = response.json()

            if data.get("success") and data.get("data"):
                metrics = data["data"]
                return PoolMetrics(
                    pool_id=pool_id,
                    tvl_usd=float(metrics.get("tvl", 0)),
                    volume_24h_usd=float(metrics.get("volume24h", 0)),
                    volume_7d_usd=float(metrics.get("volume7d", 0)),
                    volume_30d_usd=float(metrics.get("volume30d", 0)),
                    fees_24h_usd=float(metrics.get("fees24h", 0)),
                    fees_7d_usd=float(metrics.get("fees7d", 0)),
                    fees_30d_usd=float(metrics.get("fees30d", 0)),
                    apr_24h=float(metrics.get("apr24h", 0)),
                    apr_7d=float(metrics.get("apr7d", 0)),
                    apr_30d=float(metrics.get("apr30d", 0)),
                )

            return None

        except httpx.HTTPStatusError as e:
            if e.response.status_code == 401:
                logger.error("cambrian_auth_failed", msg="Invalid Cambrian API key")
            elif e.response.status_code == 404:
                logger.warning("cambrian_pool_not_found", pool_id=pool_id)
            else:
                logger.warning("cambrian_api_error", status=e.response.status_code, error=str(e))
            return None
        except Exception as e:
            logger.warning("cambrian_get_metrics_failed", pool_id=pool_id, error=str(e))
            return None

    async def get_historical_data(
        self,
        pool_id: str = DEFAULT_SOL_USDC_POOL,
        days: int = 30,
    ) -> List[DailyFeeData]:
        """
        Get historical daily fee and volume data.

        Args:
            pool_id: Whirlpool address
            days: Number of days of history (max 365)

        Returns:
            List of DailyFeeData objects, ordered by date ascending
        """
        if not self.api_key:
            logger.warning("cambrian_no_api_key", msg="Cambrian API key not configured")
            return []

        client = await self._get_client()
        days = min(days, 365)

        try:
            response = await client.get(
                f"/v1/orca/pool/{pool_id}/historical",
                params={"timeframeDays": days}
            )
            response.raise_for_status()
            data = response.json()

            history = []
            if data.get("success") and data.get("data"):
                items = data["data"]
                # Sort by date ascending
                items = sorted(items, key=lambda x: x.get("date", ""))

                for item in items:
                    try:
                        # Parse date (format: YYYY-MM-DD)
                        date_str = item.get("date", "")
                        if date_str:
                            date = datetime.strptime(date_str, "%Y-%m-%d")
                        else:
                            continue

                        fees_usd = float(item.get("feesUsd", 0))
                        volume_usd = float(item.get("volumeUsd", 0))
                        tvl_usd = float(item.get("tvlUsd", 0))

                        # Calculate daily APR from fees and TVL
                        # APR = (daily_fees / TVL) * 365 * 100
                        if tvl_usd > 0:
                            daily_rate = fees_usd / tvl_usd
                            fee_apr = daily_rate * 365 * 100
                        else:
                            fee_apr = 0.0

                        history.append(DailyFeeData(
                            date=date,
                            fee_apr=fee_apr,
                            fees_usd=fees_usd,
                            volume_usd=volume_usd,
                            tvl_usd=tvl_usd,
                        ))
                    except (ValueError, KeyError) as e:
                        logger.debug("cambrian_parse_item_failed", item=item, error=str(e))
                        continue

            logger.info(
                "cambrian_historical_loaded",
                pool_id=pool_id,
                days_requested=days,
                days_returned=len(history),
            )
            return history

        except httpx.HTTPStatusError as e:
            if e.response.status_code == 401:
                logger.error("cambrian_auth_failed", msg="Invalid Cambrian API key")
            elif e.response.status_code == 404:
                logger.warning("cambrian_pool_not_found", pool_id=pool_id)
            else:
                logger.warning("cambrian_api_error", status=e.response.status_code, error=str(e))
            return []
        except Exception as e:
            logger.warning("cambrian_get_historical_failed", pool_id=pool_id, error=str(e))
            return []

    async def get_sol_usdc_historical_apr(
        self,
        days: int = 30,
        fee_tier: str = "4bps",
    ) -> Dict[str, float]:
        """
        Get historical daily APR for SOL/USDC pool.

        Args:
            days: Number of days of history
            fee_tier: Fee tier ("4bps", "16bps", or "64bps")

        Returns:
            Dict mapping date string (YYYY-MM-DD) to APR percentage
        """
        pool_id = SOL_USDC_POOLS.get(fee_tier, DEFAULT_SOL_USDC_POOL)
        history = await self.get_historical_data(pool_id=pool_id, days=days)

        return {
            item.date.strftime("%Y-%m-%d"): item.fee_apr
            for item in history
        }


# Singleton instance
_default_client: Optional[CambrianClient] = None


async def get_cambrian_client() -> CambrianClient:
    """Get or create the default Cambrian client singleton."""
    global _default_client
    if _default_client is None:
        _default_client = CambrianClient()
    return _default_client


def is_cambrian_configured() -> bool:
    """Check if Cambrian API is configured (has API key)."""
    api_key = getattr(settings, 'cambrian_api_key', None)
    return bool(api_key)
