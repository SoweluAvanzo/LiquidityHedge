#!/usr/bin/env python3
"""
Unit tests for the simplified ATR/range calculation flow.

Tests the 2025-12 simplification changes:
1. Config no longer has deprecated ATR parameters
2. MarketState calculates clamped_range which is the key value
3. open_position_with_rebalance accepts range_width_pct directly
4. rebalance_position accepts range_width_pct directly
5. Ticks are calculated at execution time from fresh pool sqrt_price
"""

import asyncio
import os
import sys
import math
import unittest
from unittest.mock import Mock, AsyncMock, patch
from decimal import Decimal

# Add test_deployment_v2 to path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from config import Config, get_config, reset_config, ATRConfig, RangeConfig
from market_analyzer import MarketAnalyzer, MarketState


class TestConfigSimplified(unittest.TestCase):
    """Test that config no longer has deprecated parameters."""

    def setUp(self):
        reset_config()

    def test_atr_config_has_recalc_interval(self):
        """ATRConfig should have recalc_interval_hours."""
        config = ATRConfig()
        self.assertTrue(hasattr(config, 'recalc_interval_hours'))
        self.assertEqual(config.recalc_interval_hours, 4)  # Default

    def test_atr_config_no_change_threshold(self):
        """ATRConfig should NOT have change_threshold (deprecated)."""
        config = ATRConfig()
        # The attribute should not exist as a separate field
        # It was removed in the simplification
        self.assertFalse(hasattr(config, 'change_threshold'))

    def test_atr_config_no_min_hours_between_range_updates(self):
        """ATRConfig should NOT have min_hours_between_range_updates (deprecated)."""
        config = ATRConfig()
        self.assertFalse(hasattr(config, 'min_hours_between_range_updates'))

    def test_range_config_has_bounds(self):
        """RangeConfig should have min_range and max_range."""
        config = RangeConfig()
        self.assertEqual(config.min_range, 0.03)  # 3%
        self.assertEqual(config.max_range, 0.07)  # 7%
        self.assertEqual(config.k_coefficient, 0.60)


class TestMarketAnalyzerSimplified(unittest.TestCase):
    """Test MarketAnalyzer simplified flow."""

    def setUp(self):
        reset_config()
        self.config = get_config()

    def test_market_analyzer_no_last_range_update(self):
        """MarketAnalyzer should not track _last_range_update (deprecated)."""
        analyzer = MarketAnalyzer(self.config)
        self.assertFalse(hasattr(analyzer, '_last_range_update'))

    def test_market_analyzer_no_should_update_range(self):
        """MarketAnalyzer should not have should_update_range() method (deprecated)."""
        analyzer = MarketAnalyzer(self.config)
        self.assertFalse(hasattr(analyzer, 'should_update_range'))

    def test_range_clamping(self):
        """Test that range is properly clamped to [min_range, max_range]."""
        analyzer = MarketAnalyzer(self.config)

        # Test with a high ATR that would exceed max_range
        analyzer._current_atr = 0.15  # 15% ATR
        price = 100.0

        raw_range, clamped_range, lower, upper = analyzer.calculate_range_targets(price)

        # With K=0.60 and ATR=15%, raw_range = 0.60 * 0.15 = 0.09 (9%)
        self.assertAlmostEqual(raw_range, 0.09, places=4)
        # But clamped_range should be max_range = 0.07 (7%)
        self.assertAlmostEqual(clamped_range, 0.07, places=4)

    def test_range_clamping_low(self):
        """Test that low range is clamped to min_range."""
        analyzer = MarketAnalyzer(self.config)

        # Test with a low ATR that would be below min_range
        analyzer._current_atr = 0.02  # 2% ATR
        price = 100.0

        raw_range, clamped_range, lower, upper = analyzer.calculate_range_targets(price)

        # With K=0.60 and ATR=2%, raw_range = 0.60 * 0.02 = 0.012 (1.2%)
        self.assertAlmostEqual(raw_range, 0.012, places=4)
        # But clamped_range should be min_range = 0.03 (3%)
        self.assertAlmostEqual(clamped_range, 0.03, places=4)


class TestMarketState(unittest.TestCase):
    """Test MarketState contains the right fields."""

    def test_market_state_has_clamped_range(self):
        """MarketState should have clamped_range field."""
        from datetime import datetime, timezone
        state = MarketState(
            timestamp=datetime.now(timezone.utc),
            price=100.0,
            atr=0.05,
            atr_absolute=5.0,
            volatility_24h=0.05,
            last_atr_update=datetime.now(timezone.utc),
            raw_range=0.03,
            clamped_range=0.03,  # Key field
            lower_target=98.5,
            upper_target=101.5,
        )
        self.assertEqual(state.clamped_range, 0.03)

    def test_market_state_docstring_mentions_clamped_range(self):
        """MarketState docstring should mention clamped_range is the key value."""
        docstring = MarketState.__doc__ or ""
        # The docstring should mention that clamped_range is what gets used
        self.assertIn("clamped_range", docstring.lower())


class TestTickCalculation(unittest.TestCase):
    """Test tick calculation from range_width_pct."""

    def test_calculate_safe_tick_range_from_sqrt_price(self):
        """Test that calculate_safe_tick_range_from_sqrt_price works correctly."""
        from execution import calculate_safe_tick_range_from_sqrt_price, tick_to_price

        # Test with a typical sqrt_price (corresponds to ~$225 SOL/USDC)
        # sqrt_price in Q64.64 format: price = (sqrt_price / 2^64)^2 * 10^(decimals_b - decimals_a)
        # For SOL/USDC: decimals_a = 9 (SOL), decimals_b = 6 (USDC)
        # So price = (sqrt_price / 2^64)^2 * 10^(-3)

        # For $225: sqrt_price = sqrt(225 * 10^3) * 2^64 = sqrt(225000) * 2^64
        # But let's use a known value from the pool
        sqrt_price = 277145889579725455648  # ~$225 approximation
        tick_spacing = 4  # 0.04% fee pool
        range_width_pct = 0.036  # 3.6%

        lower_tick, upper_tick = calculate_safe_tick_range_from_sqrt_price(
            sqrt_price_current=sqrt_price,
            tick_spacing=tick_spacing,
            range_width_pct=range_width_pct,
        )

        # Verify ticks are multiples of tick_spacing
        self.assertEqual(lower_tick % tick_spacing, 0)
        self.assertEqual(upper_tick % tick_spacing, 0)

        # Verify upper > lower
        self.assertGreater(upper_tick, lower_tick)

        # Verify the range width is approximately correct
        lower_price = tick_to_price(lower_tick)
        upper_price = tick_to_price(upper_tick)
        actual_width = (upper_price - lower_price) / math.sqrt(lower_price * upper_price)

        # Allow 5% tolerance due to tick alignment
        self.assertAlmostEqual(actual_width, range_width_pct, delta=range_width_pct * 0.05)


class TestIntegration(unittest.TestCase):
    """Integration tests for the simplified flow."""

    def test_end_to_end_range_calculation(self):
        """Test end-to-end range calculation flow."""
        reset_config()
        config = get_config()
        analyzer = MarketAnalyzer(config)

        # Simulate ATR calculation
        analyzer._current_atr = 0.06  # 6% ATR

        # Calculate range targets
        price = 225.0
        raw_range, clamped_range, lower_target, upper_target = analyzer.calculate_range_targets(price)

        # Verify raw_range = K * ATR = 0.60 * 0.06 = 0.036
        self.assertAlmostEqual(raw_range, 0.036, places=4)

        # Since 3.6% is within [3%, 7%], clamped_range should be same as raw
        self.assertAlmostEqual(clamped_range, 0.036, places=4)

        # Verify targets use GEOMETRIC symmetry (for balanced 50/50 ratio)
        # lower = price / sqrt(1 + range), upper = price * sqrt(1 + range)
        multiplier = math.sqrt(1 + clamped_range)
        expected_lower = price / multiplier
        expected_upper = price * multiplier

        self.assertAlmostEqual(lower_target, expected_lower, places=2)
        self.assertAlmostEqual(upper_target, expected_upper, places=2)

        # Verify the range width is approximately correct
        # Note: Due to geometric vs arithmetic differences, there's a small discrepancy
        actual_width = (upper_target - lower_target) / math.sqrt(lower_target * upper_target)
        self.assertAlmostEqual(actual_width, clamped_range, delta=0.001)  # ~0.1% tolerance


if __name__ == '__main__':
    unittest.main(verbosity=2)
