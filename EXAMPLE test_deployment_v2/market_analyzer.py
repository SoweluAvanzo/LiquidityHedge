"""
Market Analyzer Module for LP Strategy v2.

Provides:
- Price data from pool state (authoritative on-chain source)
- Birdeye API for ATR/volatility calculation only
- ATR (Average True Range) calculation
- Volatility metrics
- Range calculations based on ATR and pool price

CRITICAL: All position decisions and range calculations use POOL PRICE.
Birdeye is ONLY used for historical OHLCV data to calculate ATR (volatility).
"""

import asyncio
import logging
from datetime import datetime, timezone, timedelta
from dataclasses import dataclass, field
from typing import Optional, List, Tuple
from decimal import Decimal

import httpx

from config import get_config, Config

logger = logging.getLogger(__name__)


@dataclass
class OHLCVBar:
    """Single OHLCV candle."""
    timestamp: datetime
    open: float
    high: float
    low: float
    close: float
    volume: float

    @property
    def true_range(self) -> float:
        """Calculate true range for this bar."""
        return self.high - self.low


@dataclass
class MarketState:
    """Current market state snapshot."""
    timestamp: datetime
    price: float
    atr: float  # ATR as decimal (e.g., 0.05 = 5%)
    atr_absolute: float  # ATR in USD terms
    volatility_24h: float  # 24h volatility as decimal
    last_atr_update: datetime
    last_range_update: datetime

    # Calculated range targets
    raw_range: float  # Before clamping
    clamped_range: float  # After clamping to min/max
    lower_target: float
    upper_target: float

    def to_dict(self) -> dict:
        """Convert to dictionary for logging/serialization."""
        return {
            'timestamp': self.timestamp.isoformat(),
            'price': self.price,
            'atr_pct': f"{self.atr * 100:.2f}%",
            'atr_usd': f"${self.atr_absolute:.2f}",
            'volatility_24h': f"{self.volatility_24h * 100:.2f}%",
            'raw_range': f"{self.raw_range * 100:.2f}%",
            'clamped_range': f"{self.clamped_range * 100:.2f}%",
            'lower_target': f"${self.lower_target:.4f}",
            'upper_target': f"${self.upper_target:.4f}",
        }


class MarketAnalyzer:
    """
    Market data analyzer using Birdeye API.

    Responsibilities:
    - Fetch OHLCV data for ATR calculation
    - Calculate ATR14 (14-day Average True Range)
    - Calculate target price ranges based on volatility
    - Determine when to update ranges based on ATR changes
    """

    def __init__(self, config: Optional[Config] = None, pool_price_fetcher=None):
        self.config = config or get_config()
        self._ohlcv_cache: List[OHLCVBar] = []
        self._last_atr_calc: Optional[datetime] = None
        self._last_range_update: Optional[datetime] = None
        self._current_atr: Optional[float] = None
        self._current_range: Optional[float] = None
        self._pool_price_fetcher = pool_price_fetcher  # Callable that returns current pool price
        self._prev_day_low_cache_date: Optional[datetime.date] = None
        self._prev_day_low_cache_value: Optional[float] = None

    async def get_birdeye_price_for_atr(self) -> Optional[float]:
        """
        Fetch current SOL/USDC price from Birdeye API.

        NOTE: This should ONLY be used for ATR calculation (volatility measurement).
        For position decisions, range calculations, and ratio checks, use POOL PRICE instead.
        Birdeye can have significant lag/discrepancies vs on-chain pool price.
        """
        if not self.config.api.birdeye_api_key:
            logger.warning("No Birdeye API key configured")
            return None

        try:
            url = "https://public-api.birdeye.so/defi/price"
            params = {"address": self.config.pool.sol_mint}
            headers = {
                "X-API-KEY": self.config.api.birdeye_api_key,
                "x-chain": "solana",
            }

            async with httpx.AsyncClient(timeout=15.0) as client:
                resp = await client.get(url, params=params, headers=headers)
                if resp.status_code == 200:
                    data = resp.json()
                    price = data.get("data", {}).get("value")
                    if price:
                        logger.debug(f"Birdeye price (for ATR only): ${float(price):.4f}")
                        return float(price)

            logger.warning("Could not fetch price from Birdeye")
            return None

        except Exception as e:
            logger.error(f"Error fetching price: {e}")
            return None

    async def fetch_ohlcv(self, days: int = 14) -> List[OHLCVBar]:
        """
        Fetch OHLCV data from Birdeye.

        Args:
            days: Number of days of data to fetch

        Returns:
            List of OHLCVBar objects
        """
        if not self.config.api.birdeye_api_key:
            logger.warning("No Birdeye API key configured")
            return []

        try:
            # Calculate time range
            now = datetime.now(timezone.utc)
            time_from = int((now - timedelta(days=days)).timestamp())
            time_to = int(now.timestamp())

            url = "https://public-api.birdeye.so/defi/ohlcv"
            params = {
                "address": self.config.pool.sol_mint,
                "type": "1D",  # Daily candles
                "time_from": time_from,
                "time_to": time_to,
            }
            headers = {
                "X-API-KEY": self.config.api.birdeye_api_key,
                "x-chain": "solana",
            }

            async with httpx.AsyncClient(timeout=30.0) as client:
                resp = await client.get(url, params=params, headers=headers)
                if resp.status_code == 200:
                    data = resp.json()
                    items = data.get("data", {}).get("items", [])

                    bars = []
                    for item in items:
                        try:
                            bar = OHLCVBar(
                                timestamp=datetime.fromtimestamp(item["unixTime"], tz=timezone.utc),
                                open=float(item["o"]),
                                high=float(item["h"]),
                                low=float(item["l"]),
                                close=float(item["c"]),
                                volume=float(item.get("v", 0)),
                            )
                            bars.append(bar)
                        except (KeyError, ValueError) as e:
                            logger.warning(f"Skipping malformed OHLCV bar: {e}")

                    # Sort by timestamp ascending
                    bars.sort(key=lambda x: x.timestamp)
                    self._ohlcv_cache = bars
                    return bars

            logger.warning("Could not fetch OHLCV data from Birdeye")
            return []

        except Exception as e:
            logger.error(f"Error fetching OHLCV: {e}")
            return []

    async def get_previous_day_low(self, now: Optional[datetime] = None) -> Optional[float]:
        """
        Get the previous completed daily candle low (UTC) from Birdeye OHLCV data.

        Returns:
            Low price for the previous day candle, or None if unavailable.
        """
        now = now or datetime.now(timezone.utc)
        target_date = (now - timedelta(days=1)).date()

        if self._prev_day_low_cache_date == target_date:
            return self._prev_day_low_cache_value

        # Ensure cache is populated
        if not self._ohlcv_cache:
            await self.fetch_ohlcv(days=max(self.config.atr.period_days + 2, 5))

        if not self._ohlcv_cache:
            return None

        # First try: exact match on previous day
        for bar in reversed(self._ohlcv_cache):
            if bar.timestamp.date() == target_date:
                self._prev_day_low_cache_date = target_date
                self._prev_day_low_cache_value = bar.low
                return bar.low

        # Fallback: most recent completed candle before today
        for bar in reversed(self._ohlcv_cache):
            if bar.timestamp.date() < now.date():
                self._prev_day_low_cache_date = bar.timestamp.date()
                self._prev_day_low_cache_value = bar.low
                return bar.low

        return None

    def calculate_atr(self, bars: Optional[List[OHLCVBar]] = None, period: Optional[int] = None) -> Optional[float]:
        """
        Calculate Average True Range (ATR) as percentage of price.

        For daily bars without previous close, TR = High - Low.

        Args:
            bars: OHLCV bars (uses cache if None)
            period: ATR period in days (uses config if None)

        Returns:
            ATR as decimal (e.g., 0.05 = 5%), or None if insufficient data
        """
        bars = bars or self._ohlcv_cache
        period = period or self.config.atr.period_days

        if len(bars) < period:
            logger.warning(f"Insufficient data for ATR{period}: only {len(bars)} bars")
            return None

        # Use the most recent 'period' bars
        recent_bars = bars[-period:]

        # Calculate true range for each bar
        # For daily bars, we use High-Low as a simplified TR
        # (proper TR uses previous close, but for daily % this is close enough)
        true_ranges = []
        for i, bar in enumerate(recent_bars):
            if i == 0:
                # First bar: just use high-low
                tr = bar.high - bar.low
            else:
                # Subsequent bars: max of (H-L, |H-prevC|, |L-prevC|)
                prev_close = recent_bars[i - 1].close
                tr = max(
                    bar.high - bar.low,
                    abs(bar.high - prev_close),
                    abs(bar.low - prev_close)
                )
            true_ranges.append(tr)

        # Average true range in absolute terms
        atr_absolute = sum(true_ranges) / len(true_ranges)

        # Convert to percentage using the latest close price
        latest_price = recent_bars[-1].close
        if latest_price > 0:
            atr_pct = atr_absolute / latest_price
        else:
            atr_pct = 0.0

        self._current_atr = atr_pct
        self._last_atr_calc = datetime.now(timezone.utc)

        logger.info(f"ATR{period} calculated: {atr_pct * 100:.2f}% (${atr_absolute:.2f})")
        return atr_pct

    def calculate_range_targets(
        self,
        price: float,
        atr: Optional[float] = None,
        trend_direction: Optional[float] = None,
    ) -> Tuple[float, float, float, float]:
        """
        Calculate range targets based on ATR and optionally market trend.

        RANGE CALCULATION MODES:
        -----------------------
        1. BALANCED MODE (default, use_trend_prediction=False):
           - Uses GEOMETRIC symmetry for balanced token ratio (~50/50)
           - In CLMM (Concentrated Liquidity), the token ratio depends on where
             the price sits relative to sqrt_price bounds, NOT arithmetic price
           - To achieve ~50/50 balance, we use:
             lower = price / sqrt(1 + range)
             upper = price * sqrt(1 + range)
           - This places the current price at the geometric center of the range

        2. TREND PREDICTION MODE (use_trend_prediction=True):
           - Range is shifted in the direction of detected trend
           - Uptrend: range shifted upward (more room above price)
           - Downtrend: range shifted downward (more room below price)
           - Controlled by trend_bias_factor (0.0-1.0)
           - NOTE: Trend detection must be provided externally

        ATR-BASED RANGE WIDTH:
        ----------------------
        - Range width = K * ATR (clamped to min_range/max_range)
        - K coefficient controls aggressiveness (default 0.60)
        - Higher K = wider range = more buffer but less fee capture
        - Lower K = tighter range = more fee capture but more rebalances

        WHY GEOMETRIC SYMMETRY FOR CLMM:
        --------------------------------
        In Uniswap V3 / Orca Whirlpools, liquidity math uses sqrt_price:
        - Token A amount = L * (sqrt_upper - sqrt_current) / (sqrt_current * sqrt_upper)
        - Token B amount = L * (sqrt_current - sqrt_lower)

        For equal token values at current price:
        - sqrt_current / sqrt_lower = sqrt_upper / sqrt_current
        - This means: sqrt_current = sqrt(sqrt_lower * sqrt_upper)
        - Or: current_price = sqrt(lower * upper)  [geometric mean]

        Using: lower = price / M, upper = price * M  where M = sqrt(1 + range)
        We get: sqrt(lower * upper) = sqrt(price/M * price*M) = price ✓

        Args:
            price: Current price from pool state (on-chain authoritative price)
            atr: ATR as decimal (uses cached if None)
            trend_direction: Optional trend direction (-1.0 to 1.0) for trend mode
                            Negative = downtrend, Positive = uptrend

        Returns:
            Tuple of (raw_range, clamped_range, lower_target, upper_target)
        """
        import math

        atr = atr or self._current_atr or 0.05  # Default 5% if no ATR

        # Raw range = K * ATR
        k = self.config.range.k_coefficient
        raw_range = k * atr

        # Clamp to min/max
        clamped_range = max(
            self.config.range.min_range,
            min(raw_range, self.config.range.max_range)
        )

        # Calculate target bounds based on mode
        if self.config.range.use_trend_prediction and trend_direction is not None:
            # TREND PREDICTION MODE: Shift range in trend direction
            # trend_direction: -1.0 (strong down) to 1.0 (strong up)
            # trend_bias_factor: how much to shift (0.0 to 1.0)
            bias = self.config.range.trend_bias_factor
            shift = trend_direction * bias * clamped_range / 2

            # Apply shift: positive shift moves range up, negative moves down
            # Still use geometric symmetry as base, but shifted
            multiplier = math.sqrt(1 + clamped_range)
            lower_target = price / multiplier * (1 + shift)
            upper_target = price * multiplier * (1 + shift)

            logger.info(f"Trend prediction enabled: direction={trend_direction:.2f}, shift={shift*100:.2f}%")
        else:
            # BALANCED MODE (default): GEOMETRIC symmetry for ~50/50 token ratio
            # Using: lower = price / M, upper = price * M
            # Where M = sqrt(1 + range) ensures price is at geometric center
            #
            # This makes the current price the GEOMETRIC MEAN of the bounds:
            # sqrt(lower * upper) = sqrt(price/M * price*M) = sqrt(price^2) = price
            #
            # In CLMM, being at the geometric center means equal value in both tokens.
            multiplier = math.sqrt(1 + clamped_range)
            lower_target = price / multiplier
            upper_target = price * multiplier

        self._current_range = clamped_range

        # Log actual range percentage for clarity
        actual_range_pct = (upper_target - lower_target) / price
        logger.debug(f"Range targets: raw={raw_range*100:.2f}%, clamped={clamped_range*100:.2f}%")
        logger.debug(f"Actual range width: {actual_range_pct*100:.2f}% (geometric)")
        logger.debug(f"Bounds: ${lower_target:.4f} - ${upper_target:.4f}")

        return (raw_range, clamped_range, lower_target, upper_target)

    def should_update_atr(self) -> bool:
        """Check if ATR should be recalculated based on time interval."""
        if self._last_atr_calc is None:
            return True

        hours_since = (datetime.now(timezone.utc) - self._last_atr_calc).total_seconds() / 3600
        return hours_since >= self.config.atr.recalc_interval_hours

    def should_update_range(self, new_atr: float) -> bool:
        """
        Check if range targets should be updated based on ATR change.

        Range is updated if:
        1. ATR changed by >= threshold (default 10%)
        2. AND at least min_hours have passed since last range update
        """
        if self._current_atr is None or self._last_range_update is None:
            return True

        # Check ATR change threshold
        atr_change = abs(new_atr - self._current_atr) / self._current_atr
        if atr_change < self.config.atr.change_threshold:
            return False

        # Check time since last range update
        hours_since = (datetime.now(timezone.utc) - self._last_range_update).total_seconds() / 3600
        if hours_since < self.config.atr.min_hours_between_range_updates:
            logger.debug(f"ATR changed {atr_change*100:.1f}% but only {hours_since:.1f}h since last range update")
            return False

        logger.info(f"Range update triggered: ATR changed {atr_change*100:.1f}%")
        return True

    async def get_market_state(self) -> Optional[MarketState]:
        """
        Get complete market state snapshot.

        This is the main method to call for getting current market analysis.

        CRITICAL: Uses POOL PRICE (not Birdeye) for range target calculations.
        Birdeye is only used for ATR/volatility measurement.
        """
        # Fetch current price from POOL (authoritative on-chain source)
        if self._pool_price_fetcher is None:
            logger.error("No pool price fetcher configured - cannot get market state")
            return None

        price = await self._pool_price_fetcher()
        if price is None:
            logger.error("Could not get pool price")
            return None

        logger.debug(f"Market state using pool price: ${price:.4f}")

        now = datetime.now(timezone.utc)

        # Check if we need to recalculate ATR
        if self.should_update_atr():
            logger.info("Updating ATR calculation...")
            bars = await self.fetch_ohlcv(days=self.config.atr.period_days + 2)
            if bars:
                new_atr = self.calculate_atr(bars)

                # Check if we should update range targets
                if new_atr and self.should_update_range(new_atr):
                    self._last_range_update = now
                    logger.info("Range targets will be updated on next calculation")

        # Calculate range targets using POOL PRICE
        # This ensures ranges are calculated from the authoritative on-chain price
        raw_range, clamped_range, lower_target, upper_target = self.calculate_range_targets(price)

        # Calculate 24h volatility (simplified: use ATR as proxy)
        volatility_24h = self._current_atr or 0.05

        return MarketState(
            timestamp=now,
            price=price,  # Pool price
            atr=self._current_atr or 0.05,
            atr_absolute=(self._current_atr or 0.05) * price,
            volatility_24h=volatility_24h,
            last_atr_update=self._last_atr_calc or now,
            last_range_update=self._last_range_update or now,
            raw_range=raw_range,
            clamped_range=clamped_range,
            lower_target=lower_target,
            upper_target=upper_target,
        )

    def check_emergency_condition(
        self,
        current_price: float,
        price_at_last_rebalance: float
    ) -> bool:
        """
        Check if emergency rebalance is triggered.

        Emergency triggers when:
        intraday_move > 3 * ATR (configurable multiple)

        Args:
            current_price: Current price
            price_at_last_rebalance: Price at last rebalance

        Returns:
            True if emergency condition met
        """
        if price_at_last_rebalance <= 0:
            return False

        intraday_move = abs(current_price - price_at_last_rebalance) / price_at_last_rebalance
        threshold = self.config.rebalance.emergency_atr_multiple * (self._current_atr or 0.05)

        if intraday_move > threshold:
            logger.warning(
                f"EMERGENCY: Intraday move {intraday_move*100:.2f}% exceeds "
                f"threshold {threshold*100:.2f}% ({self.config.rebalance.emergency_atr_multiple}x ATR)"
            )
            return True

        return False


# Module-level instance for convenience
_analyzer: Optional[MarketAnalyzer] = None


def get_market_analyzer() -> MarketAnalyzer:
    """Get or create global market analyzer instance."""
    global _analyzer
    if _analyzer is None:
        _analyzer = MarketAnalyzer()
    return _analyzer


async def main():
    """Test the market analyzer."""
    import sys
    from dotenv import load_dotenv

    load_dotenv()

    logging.basicConfig(
        level=logging.INFO,
        format='%(asctime)s [%(levelname)s] %(message)s',
        handlers=[logging.StreamHandler(sys.stdout)]
    )

    analyzer = MarketAnalyzer()
    state = await analyzer.get_market_state()

    if state:
        print("\n" + "=" * 50)
        print("MARKET STATE")
        print("=" * 50)
        for key, value in state.to_dict().items():
            print(f"  {key}: {value}")
        print("=" * 50)
    else:
        print("Failed to get market state")


if __name__ == "__main__":
    asyncio.run(main())
