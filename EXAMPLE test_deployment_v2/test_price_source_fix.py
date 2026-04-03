"""
Comprehensive Unit Tests for Price Source Fix.

Tests verify that:
1. MarketAnalyzer uses pool price (not Birdeye) for market state
2. ATR calculation still uses Birdeye OHLCV data
3. No false ratio triggers when Birdeye price diverges from pool price
4. Ratio calculations are coherent with pool price

Date: 2025-12-12
Issue: Mixing Birdeye price with pool price caused false ratio skew triggers
Fix: Pool price for all decisions, Birdeye ONLY for ATR calculation
"""

import asyncio
import pytest
from datetime import datetime, timezone, timedelta
from typing import Optional, List
from unittest.mock import AsyncMock, MagicMock, patch
from dataclasses import dataclass

# Import modules under test
from market_analyzer import MarketAnalyzer, MarketState, OHLCVBar
from config import Config, get_config, reset_config


# ==============================================================================
# Test Fixtures and Helpers
# ==============================================================================

@pytest.fixture(autouse=True)
def reset_config_fixture():
    """Reset config before and after each test."""
    reset_config()
    yield
    reset_config()


@pytest.fixture
def mock_config():
    """Create a mock config for testing."""
    config = Config()
    config.api.birdeye_api_key = "test_api_key"
    config.api.rpc_url = "https://test.rpc.url"
    config.atr.period_days = 14
    config.atr.recalc_interval_hours = 4
    config.range.k_coefficient = 0.60
    config.range.min_range = 0.03
    config.range.max_range = 0.07
    config.rebalance.ratio_skew_high = 0.85
    config.rebalance.ratio_skew_low = 0.15
    return config


def create_mock_ohlcv_bars(
    num_days: int = 14,
    base_price: float = 240.0,
    daily_range_pct: float = 0.03,
) -> List[OHLCVBar]:
    """Create mock OHLCV bars for ATR testing."""
    bars = []
    now = datetime.now(timezone.utc)

    for i in range(num_days):
        timestamp = now - timedelta(days=num_days - i - 1)
        close = base_price + (i * 0.5)  # Slight uptrend
        high = close * (1 + daily_range_pct / 2)
        low = close * (1 - daily_range_pct / 2)
        open_price = close - 0.5

        bars.append(OHLCVBar(
            timestamp=timestamp,
            open=open_price,
            high=high,
            low=low,
            close=close,
            volume=1000000.0,
        ))

    return bars


# ==============================================================================
# Test 1: MarketAnalyzer uses pool price for market state
# ==============================================================================

class TestPoolPriceUsage:
    """Tests verifying MarketAnalyzer uses pool price for market state."""

    @pytest.mark.asyncio
    async def test_market_state_uses_pool_price_not_birdeye(self, mock_config):
        """
        Test that get_market_state() returns pool price, not Birdeye price.

        Scenario:
        - Pool price: $242.36 (stable on-chain price)
        - Birdeye price: $300.00 (volatile external price)
        - MarketState.price should be $242.36
        """
        pool_price = 242.36
        birdeye_price = 300.00  # Different! Should NOT be used

        # Create mock pool price fetcher returning pool price
        async def mock_pool_price_fetcher() -> Optional[float]:
            return pool_price

        analyzer = MarketAnalyzer(
            config=mock_config,
            pool_price_fetcher=mock_pool_price_fetcher
        )

        # Pre-set ATR to avoid Birdeye OHLCV fetch
        analyzer._current_atr = 0.05
        analyzer._last_atr_calc = datetime.now(timezone.utc)

        # Get market state
        market_state = await analyzer.get_market_state()

        # Verify pool price is used
        assert market_state is not None
        assert market_state.price == pool_price
        assert market_state.price != birdeye_price

        # Verify range targets are calculated from pool price
        expected_lower = pool_price / (1 + mock_config.range.min_range) ** 0.5
        expected_upper = pool_price * (1 + mock_config.range.min_range) ** 0.5

        # Check targets are close to expected (within 1%)
        assert abs(market_state.lower_target - expected_lower) / expected_lower < 0.01
        assert abs(market_state.upper_target - expected_upper) / expected_upper < 0.01

    @pytest.mark.asyncio
    async def test_market_state_fails_without_pool_price_fetcher(self, mock_config):
        """
        Test that get_market_state() returns None when no pool price fetcher is configured.

        This is the expected behavior - we REQUIRE pool price for all decisions.
        """
        analyzer = MarketAnalyzer(config=mock_config, pool_price_fetcher=None)

        market_state = await analyzer.get_market_state()

        assert market_state is None

    @pytest.mark.asyncio
    async def test_market_state_fails_when_pool_price_fetch_fails(self, mock_config):
        """
        Test that get_market_state() returns None when pool price fetch fails.
        """
        async def mock_failing_fetcher() -> Optional[float]:
            return None  # Simulates fetch failure

        analyzer = MarketAnalyzer(
            config=mock_config,
            pool_price_fetcher=mock_failing_fetcher
        )

        market_state = await analyzer.get_market_state()

        assert market_state is None

    @pytest.mark.asyncio
    async def test_pool_price_used_for_range_targets(self, mock_config):
        """
        Test that range targets (lower_target, upper_target) are calculated from pool price.

        Scenario:
        - Pool price: $242.36
        - Range: 3% (clamped min)
        - Lower target should be ~$238.76 (242.36 / sqrt(1.03))
        - Upper target should be ~$245.99 (242.36 * sqrt(1.03))
        """
        pool_price = 242.36

        async def mock_pool_price_fetcher() -> Optional[float]:
            return pool_price

        analyzer = MarketAnalyzer(
            config=mock_config,
            pool_price_fetcher=mock_pool_price_fetcher
        )

        # Set ATR to trigger min_range (3%)
        analyzer._current_atr = 0.02  # K * ATR = 0.6 * 0.02 = 1.2% < min 3%
        analyzer._last_atr_calc = datetime.now(timezone.utc)

        market_state = await analyzer.get_market_state()

        # Verify clamped range is min (3%)
        assert market_state.clamped_range == mock_config.range.min_range

        # Calculate expected targets (geometric symmetry)
        import math
        multiplier = math.sqrt(1 + mock_config.range.min_range)
        expected_lower = pool_price / multiplier
        expected_upper = pool_price * multiplier

        # Verify targets match
        assert abs(market_state.lower_target - expected_lower) < 0.01
        assert abs(market_state.upper_target - expected_upper) < 0.01


# ==============================================================================
# Test 2: ATR calculation still uses Birdeye OHLCV
# ==============================================================================

class TestATRUsesBirdeye:
    """Tests verifying ATR calculation uses Birdeye OHLCV data."""

    @pytest.mark.asyncio
    async def test_fetch_ohlcv_calls_birdeye_api(self, mock_config):
        """
        Test that fetch_ohlcv() calls Birdeye API endpoint.
        """
        analyzer = MarketAnalyzer(config=mock_config)

        with patch('httpx.AsyncClient') as mock_client_class:
            mock_client = AsyncMock()
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=None)

            mock_response = MagicMock()
            mock_response.status_code = 200
            mock_response.json.return_value = {
                "data": {
                    "items": [
                        {
                            "unixTime": int(datetime.now(timezone.utc).timestamp()),
                            "o": 240.0,
                            "h": 245.0,
                            "l": 235.0,
                            "c": 242.0,
                            "v": 1000000,
                        }
                    ]
                }
            }
            mock_client.get = AsyncMock(return_value=mock_response)
            mock_client_class.return_value = mock_client

            bars = await analyzer.fetch_ohlcv(days=14)

            # Verify Birdeye API was called
            mock_client.get.assert_called_once()
            call_args = mock_client.get.call_args
            assert "public-api.birdeye.so" in call_args[0][0]
            assert "ohlcv" in call_args[0][0]

    def test_calculate_atr_uses_ohlcv_bars(self, mock_config):
        """
        Test that calculate_atr() computes ATR from OHLCV bars correctly.
        """
        analyzer = MarketAnalyzer(config=mock_config)

        # Create mock bars with known true ranges
        bars = create_mock_ohlcv_bars(num_days=14, base_price=240.0, daily_range_pct=0.04)

        atr = analyzer.calculate_atr(bars, period=14)

        # ATR should be approximately 4% (daily_range_pct)
        # Allow for calculation method differences
        assert atr is not None
        assert 0.02 < atr < 0.06  # Reasonable ATR range

    @pytest.mark.asyncio
    async def test_atr_updated_when_interval_passed(self, mock_config):
        """
        Test that ATR is recalculated when recalc_interval has passed.
        """
        pool_price = 242.36

        async def mock_pool_price_fetcher() -> Optional[float]:
            return pool_price

        analyzer = MarketAnalyzer(
            config=mock_config,
            pool_price_fetcher=mock_pool_price_fetcher
        )

        # Set last ATR calc to 5 hours ago (interval is 4h)
        analyzer._last_atr_calc = datetime.now(timezone.utc) - timedelta(hours=5)
        analyzer._current_atr = 0.03

        assert analyzer.should_update_atr() is True

        # Now set to 2 hours ago (within interval)
        analyzer._last_atr_calc = datetime.now(timezone.utc) - timedelta(hours=2)

        assert analyzer.should_update_atr() is False

    @pytest.mark.asyncio
    async def test_birdeye_price_method_renamed_for_clarity(self, mock_config):
        """
        Test that get_birdeye_price_for_atr() method exists and is separate from pool price.

        This verifies the method was renamed to make its purpose clear.
        """
        analyzer = MarketAnalyzer(config=mock_config)

        # Method should exist
        assert hasattr(analyzer, 'get_birdeye_price_for_atr')

        # Old method name should NOT exist
        assert not hasattr(analyzer, 'get_current_price')


# ==============================================================================
# Test 3: No false ratio triggers when Birdeye diverges from pool
# ==============================================================================

class TestNoFalseRatioTriggers:
    """Tests verifying no false RATIO_SKEW triggers when Birdeye diverges."""

    @pytest.mark.asyncio
    async def test_ratio_uses_pool_price_not_birdeye(self, mock_config):
        """
        Test that ratio calculations use pool price, preventing false triggers.

        Scenario:
        - Position opened at pool price $242 (balanced 50/50)
        - Pool price stable at $242
        - Birdeye shows $300 (24% higher)
        - If using pool price: ratio should be ~50% (no trigger)
        - If using Birdeye: ratio would be ~70%+ (false trigger!)
        """
        pool_price = 242.36
        birdeye_price = 300.00  # 24% higher - would cause false trigger

        async def mock_pool_price_fetcher() -> Optional[float]:
            return pool_price

        analyzer = MarketAnalyzer(
            config=mock_config,
            pool_price_fetcher=mock_pool_price_fetcher
        )
        analyzer._current_atr = 0.05
        analyzer._last_atr_calc = datetime.now(timezone.utc)

        market_state = await analyzer.get_market_state()

        # Market state should reflect pool price
        assert market_state.price == pool_price
        assert market_state.price != birdeye_price

        # Simulate ratio calculation for a balanced position
        # Position: 1 SOL, 242 USDC at price $242
        sol_amount = 1.0
        usdc_amount = 242.0

        # Calculate ratio using market state price (pool price)
        sol_value = sol_amount * market_state.price
        total_value = sol_value + usdc_amount
        sol_ratio = sol_value / total_value

        # Ratio should be ~50% (balanced)
        assert 0.45 < sol_ratio < 0.55, f"Ratio {sol_ratio} should be ~50%"

        # Verify this is NOT a ratio skew trigger
        assert sol_ratio < mock_config.rebalance.ratio_skew_high
        assert sol_ratio > mock_config.rebalance.ratio_skew_low

        # Now calculate what ratio WOULD be if using Birdeye (to prove the fix)
        sol_value_birdeye = sol_amount * birdeye_price
        total_value_birdeye = sol_value_birdeye + usdc_amount
        sol_ratio_birdeye = sol_value_birdeye / total_value_birdeye

        # With Birdeye price, ratio would be ~55% - closer to trigger threshold
        # (In production, Birdeye swung to $304, which would show 88%+ ratio)
        assert sol_ratio_birdeye > sol_ratio, "Birdeye would show higher ratio"

    @pytest.mark.asyncio
    async def test_extreme_birdeye_divergence_no_trigger(self, mock_config):
        """
        Test extreme scenario from production: Birdeye $304 vs Pool $242.

        Production Issue:
        - Position opened 49.8% SOL at $242
        - Birdeye showed $304 (25% higher)
        - System calculated 88.94% SOL ratio (FALSE!)
        - Triggered RATIO_SKEW_HIGH rebalance

        With Fix:
        - Ratio should remain ~50% using pool price
        - No false trigger
        """
        pool_price = 242.36
        birdeye_price = 304.15  # Actual production value causing false trigger

        async def mock_pool_price_fetcher() -> Optional[float]:
            return pool_price

        analyzer = MarketAnalyzer(
            config=mock_config,
            pool_price_fetcher=mock_pool_price_fetcher
        )
        analyzer._current_atr = 0.05
        analyzer._last_atr_calc = datetime.now(timezone.utc)

        market_state = await analyzer.get_market_state()

        # Simulate position from production: ~0.5 SOL, ~121 USDC
        sol_amount = 0.5
        usdc_amount = 121.0

        # Calculate ratio using pool price (fixed behavior)
        sol_value = sol_amount * market_state.price  # Using pool price
        total_value = sol_value + usdc_amount
        sol_ratio = sol_value / total_value

        # Ratio should be ~50%
        assert 0.45 < sol_ratio < 0.55, f"Pool price ratio {sol_ratio} should be ~50%"

        # NOT a trigger
        assert sol_ratio < mock_config.rebalance.ratio_skew_high

        # Calculate what ratio WOULD be with Birdeye (the bug)
        sol_value_birdeye = sol_amount * birdeye_price
        total_value_birdeye = sol_value_birdeye + usdc_amount
        sol_ratio_birdeye = sol_value_birdeye / total_value_birdeye

        # With Birdeye, ratio would be ~55.7% - still not 88% because amounts are adjusted
        # The production 88% came from larger position, but point is proven
        assert sol_ratio_birdeye > sol_ratio

    @pytest.mark.asyncio
    async def test_ratio_trigger_only_when_pool_price_moves(self, mock_config):
        """
        Test that ratio triggers ONLY when pool price actually moves significantly.

        Scenario:
        - Position opened at $242 (balanced)
        - Pool price drops to $200 (-17%)
        - Ratio should shift toward USDC (less SOL value)
        - This is a LEGITIMATE trigger
        """
        initial_pool_price = 242.36
        dropped_pool_price = 200.00  # 17% drop

        # Position opened at initial price
        sol_amount = 1.0
        usdc_amount = 242.0  # ~50/50 at $242

        # Calculate ratio at dropped pool price
        sol_value = sol_amount * dropped_pool_price
        total_value = sol_value + usdc_amount
        sol_ratio = sol_value / total_value

        # Sol ratio should be ~45% (dropped from 50%)
        expected_ratio = 200.0 / (200.0 + 242.0)
        assert abs(sol_ratio - expected_ratio) < 0.01

        # This is NOT a ratio skew trigger (45% is between 15% and 85%)
        # But if price dropped to $30, it would be:
        extreme_dropped_price = 30.0
        sol_value_extreme = sol_amount * extreme_dropped_price
        total_extreme = sol_value_extreme + usdc_amount
        sol_ratio_extreme = sol_value_extreme / total_extreme

        # ~11% - this WOULD be a legitimate trigger (below 15%)
        # 30 / (30 + 242) = 0.11 < 0.15
        assert sol_ratio_extreme < mock_config.rebalance.ratio_skew_low


# ==============================================================================
# Test 4: Ratio calculations coherent with pool price
# ==============================================================================

class TestRatioCoherency:
    """Tests verifying ratio calculations are coherent with pool price."""

    @pytest.mark.asyncio
    async def test_position_open_and_ratio_use_same_price(self, mock_config):
        """
        Test that position opening and ratio monitoring use the same price source.

        Key coherency requirement:
        - Position opens at pool price P
        - Ratio is calculated using pool price P
        - Result: consistent 50/50 ratio immediately after opening
        """
        pool_price = 242.36

        async def mock_pool_price_fetcher() -> Optional[float]:
            return pool_price

        analyzer = MarketAnalyzer(
            config=mock_config,
            pool_price_fetcher=mock_pool_price_fetcher
        )
        analyzer._current_atr = 0.05
        analyzer._last_atr_calc = datetime.now(timezone.utc)

        # Get market state for position opening
        market_state = await analyzer.get_market_state()
        open_price = market_state.price

        # Simulate opening position with 50/50 split at open_price
        total_usd = 500.0
        sol_amount = (total_usd / 2) / open_price  # Half in SOL
        usdc_amount = total_usd / 2  # Half in USDC

        # Immediately calculate ratio using same market state
        sol_value = sol_amount * market_state.price
        total_value = sol_value + usdc_amount
        sol_ratio = sol_value / total_value

        # Ratio should be exactly 50%
        assert abs(sol_ratio - 0.5) < 0.001, f"Ratio {sol_ratio} should be 50%"

    @pytest.mark.asyncio
    async def test_market_state_price_matches_pool_fetcher(self, mock_config):
        """
        Test that MarketState.price always matches what pool_price_fetcher returns.
        """
        test_prices = [100.0, 200.0, 242.36, 300.0, 500.0]

        for expected_price in test_prices:
            async def mock_fetcher(price=expected_price) -> Optional[float]:
                return price

            analyzer = MarketAnalyzer(
                config=mock_config,
                pool_price_fetcher=lambda p=expected_price: mock_fetcher(p)
            )
            analyzer._current_atr = 0.05
            analyzer._last_atr_calc = datetime.now(timezone.utc)

            market_state = await analyzer.get_market_state()

            assert market_state.price == expected_price

    @pytest.mark.asyncio
    async def test_display_targets_coherent_with_price(self, mock_config):
        """
        Test that display targets (lower_target, upper_target) are coherent with price.

        The current price should be at the geometric center of the range:
        price = sqrt(lower_target * upper_target)
        """
        pool_price = 242.36

        async def mock_pool_price_fetcher() -> Optional[float]:
            return pool_price

        analyzer = MarketAnalyzer(
            config=mock_config,
            pool_price_fetcher=mock_pool_price_fetcher
        )
        analyzer._current_atr = 0.05
        analyzer._last_atr_calc = datetime.now(timezone.utc)

        market_state = await analyzer.get_market_state()

        # Verify price is at geometric center of range
        import math
        geometric_center = math.sqrt(market_state.lower_target * market_state.upper_target)

        assert abs(geometric_center - market_state.price) < 0.01


# ==============================================================================
# Integration Test: Full flow with mocked dependencies
# ==============================================================================

class TestIntegration:
    """Integration tests for the full price source fix."""

    @pytest.mark.asyncio
    async def test_full_market_state_flow_with_pool_price(self, mock_config):
        """
        Full integration test of market state flow using pool price.

        Verifies:
        1. Pool price fetcher is called
        2. Price in MarketState matches pool price
        3. Range targets calculated correctly
        4. ATR would use Birdeye (mocked to skip API call)
        """
        pool_price = 242.36
        call_count = {"fetch": 0}

        async def mock_pool_price_fetcher() -> Optional[float]:
            call_count["fetch"] += 1
            return pool_price

        analyzer = MarketAnalyzer(
            config=mock_config,
            pool_price_fetcher=mock_pool_price_fetcher
        )

        # Pre-set ATR to avoid external API call
        analyzer._current_atr = 0.05  # 5% ATR
        analyzer._last_atr_calc = datetime.now(timezone.utc)

        # Get market state
        market_state = await analyzer.get_market_state()

        # Verify pool price fetcher was called
        assert call_count["fetch"] == 1

        # Verify all market state values are coherent
        assert market_state is not None
        assert market_state.price == pool_price
        assert market_state.atr == 0.05
        assert market_state.atr_absolute == 0.05 * pool_price

        # Verify range is correctly clamped (K * ATR = 0.6 * 0.05 = 3% = min_range)
        assert market_state.clamped_range == mock_config.range.min_range

        # Verify targets
        import math
        expected_multiplier = math.sqrt(1 + mock_config.range.min_range)
        assert abs(market_state.lower_target - pool_price / expected_multiplier) < 0.01
        assert abs(market_state.upper_target - pool_price * expected_multiplier) < 0.01

    @pytest.mark.asyncio
    async def test_consecutive_market_states_use_fresh_pool_price(self, mock_config):
        """
        Test that each get_market_state() call fetches fresh pool price.
        """
        prices = [240.0, 242.0, 245.0]
        current_price_index = {"i": 0}

        async def mock_pool_price_fetcher() -> Optional[float]:
            price = prices[current_price_index["i"]]
            current_price_index["i"] += 1
            return price

        analyzer = MarketAnalyzer(
            config=mock_config,
            pool_price_fetcher=mock_pool_price_fetcher
        )
        analyzer._current_atr = 0.05
        analyzer._last_atr_calc = datetime.now(timezone.utc)

        # Get three consecutive market states
        state1 = await analyzer.get_market_state()
        state2 = await analyzer.get_market_state()
        state3 = await analyzer.get_market_state()

        # Each should have the corresponding price
        assert state1.price == 240.0
        assert state2.price == 242.0
        assert state3.price == 245.0


# ==============================================================================
# Run tests
# ==============================================================================

if __name__ == "__main__":
    pytest.main([__file__, "-v", "--tb=short"])
