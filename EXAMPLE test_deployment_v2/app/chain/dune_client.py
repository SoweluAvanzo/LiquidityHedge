"""
Dune Analytics client for historical Orca Whirlpool data.

Fetches historical volume, fees, and TVL data for backtesting.
Free tier: 2,500 credits/month with API access.

Sign up at: https://dune.com/
API Docs: https://docs.dune.com/api-reference/overview
"""

from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Optional, List, Dict, Any
import asyncio

import httpx
import structlog

from app.config import get_settings

logger = structlog.get_logger(__name__)
settings = get_settings()

# Dune API base URL
DUNE_API_URL = "https://api.dune.com/api/v1"

# Known SOL/USDC Whirlpool addresses and their fee tiers
SOL_USDC_WHIRLPOOL = "HJPjoWUrhoZzkNfRpHuieeFk9WcZWjwy6PBjZ81ngndJ"

# Pool address to fee tier mapping (in basis points)
# These are the actual Orca Whirlpool fee tiers
POOL_FEE_TIERS_BPS = {
    "Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE": 4,    # 0.04% fee
    "21gTfxAnhUDjJGZJDkTXctGFKT8TeiXx6pN1CEg9K1uW": 16,   # 0.16% fee
    "HJPjoWUrhoZzkNfRpHuieeFk9WcZWjwy6PBjZ81ngndJ": 64,   # 0.64% fee (default)
}

# Default fee rate if pool not found (use 64 bps = 0.64%)
DEFAULT_FEE_RATE_BPS = 64

# SQL query to get daily volume and fees for SOL/USDC Whirlpool
# This query aggregates swap data by day using dex_solana.trades
# Filters by project='orca' to get only Orca Whirlpool trades (not all DEXs)
# Fee rate parameter allows specifying the actual pool fee tier
DAILY_POOL_METRICS_QUERY = """
-- Daily metrics for SOL/USDC on Orca Whirlpools ONLY
-- Note: In dex_solana.trades, Orca Whirlpools are labeled as 'whirlpool' (not 'orca')
SELECT
    DATE_TRUNC('day', block_time) as date,
    COUNT(*) as num_swaps,
    SUM(amount_usd) as volume_usd,
    -- Calculate fees using the pool's actual fee rate ({{fee_rate_pct}}%)
    SUM(amount_usd) * {{fee_rate_decimal}} as fees_usd
FROM dex_solana.trades
WHERE block_time >= DATE '{{start_date}}'
    AND block_time < DATE '{{end_date}}'
    AND project = 'whirlpool'  -- Orca Whirlpools are labeled 'whirlpool' in Dune
    AND (
        (token_bought_symbol IN ('SOL', 'WSOL') AND token_sold_symbol = 'USDC')
        OR
        (token_sold_symbol IN ('SOL', 'WSOL') AND token_bought_symbol = 'USDC')
    )
GROUP BY 1
ORDER BY 1 DESC
"""


@dataclass
class DailyPoolMetrics:
    """Daily pool metrics from Dune."""
    date: datetime
    num_swaps: int
    volume_usd: float
    fees_usd: float
    tvl_usd: Optional[float] = None  # TVL if available
    fee_apr: Optional[float] = None  # Calculated APR


class DuneClient:
    """
    Client for Dune Analytics API.

    Provides methods for:
    - Executing SQL queries
    - Fetching historical pool metrics
    - Calculating fee APR from volume data
    """

    def __init__(self, api_key: Optional[str] = None):
        """
        Initialize Dune client.

        Args:
            api_key: Dune API key (get one free at dune.com)
        """
        self.api_key = api_key or getattr(settings, 'dune_api_key', None)
        self._client: Optional[httpx.AsyncClient] = None

    @property
    def is_configured(self) -> bool:
        """Check if API key is configured."""
        return bool(self.api_key)

    async def _get_client(self) -> httpx.AsyncClient:
        """Get or create HTTP client."""
        if self._client is None or self._client.is_closed:
            headers = {
                "X-Dune-API-Key": self.api_key or "",
                "Content-Type": "application/json",
            }
            self._client = httpx.AsyncClient(
                base_url=DUNE_API_URL,
                headers=headers,
                timeout=120.0,  # Dune queries can take time
            )
        return self._client

    async def close(self):
        """Close the HTTP client."""
        if self._client and not self._client.is_closed:
            await self._client.aclose()

    async def execute_query(
        self,
        query_sql: str,
        parameters: Optional[Dict[str, Any]] = None,
    ) -> List[Dict[str, Any]]:
        """
        Execute a SQL query on Dune.

        Args:
            query_sql: SQL query string
            parameters: Query parameters (for template substitution)

        Returns:
            List of result rows as dictionaries
        """
        if not self.api_key:
            logger.warning("dune_no_api_key", msg="DUNE_API_KEY not configured")
            return []

        client = await self._get_client()

        # Substitute parameters in query
        if parameters:
            for key, value in parameters.items():
                query_sql = query_sql.replace(f"{{{{{key}}}}}", str(value))

        try:
            # Step 1: Execute SQL query directly
            logger.info("dune_executing_query", query_length=len(query_sql))

            response = await client.post(
                "/sql/execute",
                json={
                    "sql": query_sql,
                    "performance": "medium",  # Use medium for free tier
                }
            )

            if response.status_code == 401:
                logger.error("dune_auth_failed", msg="Invalid DUNE_API_KEY")
                return []

            response.raise_for_status()
            data = response.json()
            execution_id = data.get("execution_id")

            if not execution_id:
                logger.error("dune_no_execution_id", response=data)
                return []

            logger.info("dune_query_started", execution_id=execution_id)

            # Step 2: Poll for results
            results = await self._poll_for_results(execution_id)
            return results

        except httpx.HTTPStatusError as e:
            logger.error(
                "dune_query_failed",
                status=e.response.status_code,
                error=str(e),
            )
            return []
        except Exception as e:
            logger.error("dune_query_error", error=str(e))
            return []

    async def _poll_for_results(
        self,
        execution_id: str,
        max_attempts: int = 30,
        poll_interval: float = 2.0,
    ) -> List[Dict[str, Any]]:
        """
        Poll Dune API for query results.

        Args:
            execution_id: Query execution ID
            max_attempts: Maximum polling attempts
            poll_interval: Seconds between polls

        Returns:
            List of result rows
        """
        client = await self._get_client()

        for attempt in range(max_attempts):
            try:
                response = await client.get(f"/execution/{execution_id}/results")
                response.raise_for_status()
                data = response.json()

                state = data.get("state")
                logger.debug("dune_poll_status", state=state, attempt=attempt + 1)

                if state == "QUERY_STATE_COMPLETED":
                    result = data.get("result", {})
                    rows = result.get("rows", [])
                    logger.info(
                        "dune_query_completed",
                        rows_returned=len(rows),
                        execution_id=execution_id,
                    )
                    return rows

                elif state == "QUERY_STATE_FAILED":
                    error = data.get("error", "Unknown error")
                    logger.error("dune_query_state_failed", error=error)
                    return []

                elif state in ["QUERY_STATE_PENDING", "QUERY_STATE_EXECUTING"]:
                    await asyncio.sleep(poll_interval)
                else:
                    logger.warning("dune_unknown_state", state=state)
                    await asyncio.sleep(poll_interval)

            except Exception as e:
                logger.warning("dune_poll_error", error=str(e), attempt=attempt + 1)
                await asyncio.sleep(poll_interval)

        logger.error("dune_query_timeout", execution_id=execution_id)
        return []

    async def get_daily_pool_metrics(
        self,
        days: int = 90,
        pool_address: str = SOL_USDC_WHIRLPOOL,
        fee_rate_bps: Optional[int] = None,
    ) -> List[DailyPoolMetrics]:
        """
        Fetch daily pool metrics (volume, fees, swaps) for Orca Whirlpools.

        Args:
            days: Number of days of history to fetch
            pool_address: Whirlpool address (used to determine fee tier)
            fee_rate_bps: Override fee rate in basis points (auto-detected from pool if None)

        Returns:
            List of DailyPoolMetrics objects
        """
        from datetime import timezone
        end_date = datetime.now(timezone.utc).date()
        start_date = end_date - timedelta(days=days)

        # Determine fee rate from pool address or use override
        if fee_rate_bps is None:
            fee_rate_bps = POOL_FEE_TIERS_BPS.get(pool_address, DEFAULT_FEE_RATE_BPS)

        fee_rate_decimal = fee_rate_bps / 10000  # Convert bps to decimal (64 bps = 0.0064)
        fee_rate_pct = fee_rate_bps / 100  # Convert bps to percent (64 bps = 0.64%)

        logger.info(
            "dune_query_params",
            pool_address=pool_address,
            fee_rate_bps=fee_rate_bps,
            fee_rate_pct=f"{fee_rate_pct}%",
        )

        parameters = {
            "start_date": start_date.isoformat(),
            "end_date": end_date.isoformat(),
            "fee_rate_decimal": str(fee_rate_decimal),
            "fee_rate_pct": str(fee_rate_pct),
        }

        rows = await self.execute_query(DAILY_POOL_METRICS_QUERY, parameters)

        metrics = []
        for row in rows:
            try:
                # Parse date - handle various Dune formats
                date_val = row.get("date")
                if isinstance(date_val, str):
                    # Remove " UTC" suffix and .000 milliseconds if present
                    date_str = date_val.replace(" UTC", "").replace(".000", "")
                    # Handle ISO format or Dune format
                    if "T" in date_str:
                        date = datetime.fromisoformat(date_str.replace("Z", "+00:00"))
                    else:
                        date = datetime.strptime(date_str, "%Y-%m-%d %H:%M:%S")
                else:
                    date = date_val

                metrics.append(DailyPoolMetrics(
                    date=date,
                    num_swaps=int(row.get("num_swaps", 0)),
                    volume_usd=float(row.get("volume_usd", 0)),
                    fees_usd=float(row.get("fees_usd", 0)),
                ))
            except (ValueError, TypeError) as e:
                logger.warning("dune_parse_row_error", row=row, error=str(e))
                continue

        logger.info(
            "dune_metrics_fetched",
            days_requested=days,
            days_returned=len(metrics),
        )

        return sorted(metrics, key=lambda x: x.date)

    async def get_historical_apr(
        self,
        days: int = 90,
        estimated_tvl: float = 10_000_000,  # Default $10M TVL estimate
        pool_address: str = SOL_USDC_WHIRLPOOL,
    ) -> Dict[str, float]:
        """
        Get historical daily APR calculated from fees and estimated TVL.

        DEPRECATION NOTE: This method uses an estimated TVL which is unreliable.
        For accurate APR data with real TVL, use the Cambrian API instead:
        - CambrianClient.get_historical_data() returns actual TVL per day
        - CambrianClient.get_sol_usdc_historical_apr() calculates APR from real TVL

        Args:
            days: Number of days of history
            estimated_tvl: Estimated TVL for APR calculation (default $10M) - UNRELIABLE
            pool_address: Whirlpool address for fee tier lookup

        Returns:
            Dict mapping date string (YYYY-MM-DD) to APR percentage
        """
        logger.warning(
            "dune_apr_uses_estimated_tvl",
            msg="Using estimated TVL for APR. For accurate APR, use Cambrian API instead.",
            estimated_tvl=estimated_tvl,
        )

        metrics = await self.get_daily_pool_metrics(days=days, pool_address=pool_address)

        apr_data = {}
        for m in metrics:
            # APR = (daily_fees / TVL) * 365 * 100
            tvl = m.tvl_usd or estimated_tvl
            if tvl > 0:
                daily_rate = m.fees_usd / tvl
                apr = daily_rate * 365 * 100
            else:
                apr = 0.0

            date_str = m.date.strftime("%Y-%m-%d")
            apr_data[date_str] = apr

        return apr_data


# Singleton instance
_default_client: Optional[DuneClient] = None


async def get_dune_client() -> DuneClient:
    """Get or create the default Dune client singleton."""
    global _default_client
    if _default_client is None:
        _default_client = DuneClient()
    return _default_client


def is_dune_configured() -> bool:
    """Check if Dune API is configured (has API key)."""
    api_key = getattr(settings, 'dune_api_key', None)
    return bool(api_key)
