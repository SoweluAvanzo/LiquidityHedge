#!/usr/bin/env python3
"""
Tests for stop-loss trigger using previous day low as alternate threshold.
"""

import os
import sys
import unittest
from types import SimpleNamespace
from datetime import datetime, timezone, timedelta
from decimal import Decimal
from unittest.mock import AsyncMock

# Add test_deployment_v2 to path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from config import get_config, reset_config
from lp_strategy import LPStrategyOrchestrator
from market_analyzer import MarketState
from position_monitor import PositionSnapshot


class _MockSessionState:
    def get_daily_stats(self):
        return SimpleNamespace(emergency_used=False)


class _MockSessionManager:
    def __init__(self, can_rebalance: bool):
        self._can_rebalance = can_rebalance
        self.state = _MockSessionState()

    def can_rebalance(self) -> bool:
        return self._can_rebalance


def _make_snapshot(position_id: str, lower_price: float, upper_price: float, current_price: float) -> PositionSnapshot:
    now = datetime.now(timezone.utc)
    return PositionSnapshot(
        timestamp=now,
        position_address=position_id,
        current_price=Decimal(str(current_price)),
        open_price=Decimal("100"),
        price_change_pct=Decimal("0"),
        lower_price=Decimal(str(lower_price)),
        upper_price=Decimal(str(upper_price)),
        is_in_range=False,
        current_token_a=Decimal("0"),
        current_token_b=Decimal("0"),
        current_value_usd=Decimal("0"),
        initial_token_a=Decimal("0"),
        initial_token_b=Decimal("0"),
        initial_value_usd=Decimal("0"),
        token_a_ratio=Decimal("0.5"),
        hold_value_usd=Decimal("0"),
        il_usd=Decimal("0"),
        il_pct=Decimal("0"),
        pending_fees_a=Decimal("0"),
        pending_fees_b=Decimal("0"),
        pending_fees_usd=Decimal("0"),
        tx_fees_sol=Decimal("0"),
        tx_fees_usd=Decimal("0"),
    )


def _make_market_state(price: float) -> MarketState:
    now = datetime.now(timezone.utc)
    return MarketState(
        timestamp=now,
        price=price,
        atr=0.05,
        atr_absolute=price * 0.05,
        volatility_24h=0.05,
        last_atr_update=now,
        last_range_update=now,
        raw_range=0.03,
        clamped_range=0.03,
        lower_target=price * 0.985,
        upper_target=price * 1.015,
    )


class TestStopLossPrevDayLow(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        reset_config()
        self.config = get_config()
        self.orch = LPStrategyOrchestrator(self.config)
        self.orch.session_manager = _MockSessionManager(can_rebalance=False)
        self.orch.market_analyzer = AsyncMock()

        # Ensure duration condition is met
        position_id = "pos_test"
        past = datetime.now(timezone.utc) - timedelta(minutes=self.config.stop_loss.out_of_range_duration_minutes + 5)
        self.orch._position_last_in_range_at[position_id] = past

        # Minimal trade executor stub (only methods used before close failure)
        self.orch.trade_executor = SimpleNamespace(
            get_balances=AsyncMock(return_value=(1.0, 0.0)),
            close_position=AsyncMock(return_value=SimpleNamespace(success=False, error="test_fail"))
        )

    async def test_prev_day_low_triggers_when_config_threshold_not_met(self):
        position_id = "pos_test"
        lower_price = 100.0
        upper_price = 120.0
        # Above config threshold (99.6) but below prev day low (99.9)
        current_price = 99.8

        snapshot = _make_snapshot(position_id, lower_price, upper_price, current_price)
        market_state = _make_market_state(current_price)

        self.orch.market_analyzer.get_previous_day_low = AsyncMock(return_value=99.9)

        await self.orch._check_stop_loss_conditions(snapshot, market_state)

        self.orch.trade_executor.close_position.assert_awaited_once()

    async def test_no_trigger_when_neither_condition_met(self):
        position_id = "pos_test"
        lower_price = 100.0
        upper_price = 120.0
        # Above config threshold (99.6) and above prev day low (99.5)
        current_price = 99.8

        snapshot = _make_snapshot(position_id, lower_price, upper_price, current_price)
        market_state = _make_market_state(current_price)

        self.orch.market_analyzer.get_previous_day_low = AsyncMock(return_value=99.5)

        await self.orch._check_stop_loss_conditions(snapshot, market_state)

        self.orch.trade_executor.close_position.assert_not_awaited()


