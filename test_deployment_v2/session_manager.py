"""
Session Manager Module for LP Strategy v2.

Tracks session-level metrics and aggregates data across positions.
Handles:
- Session lifecycle (start, track, end)
- Aggregate PnL across all positions
- Position history tracking
- Rebalance tracking with daily limits
- CSV output for session data
"""

import csv
import json
import logging
from datetime import datetime, timezone, timedelta, date
from dataclasses import dataclass, field
from typing import Optional, List, Dict
from decimal import Decimal
from pathlib import Path

from config import get_config, Config
from position_monitor import PositionSnapshot

logger = logging.getLogger(__name__)


@dataclass
class PositionRecord:
    """Record of a single position's lifecycle."""
    position_address: str
    open_timestamp: datetime
    close_timestamp: Optional[datetime] = None

    # Opening data
    open_price: Decimal = Decimal(0)
    initial_token_a: Decimal = Decimal(0)
    initial_token_b: Decimal = Decimal(0)
    initial_value_usd: Decimal = Decimal(0)
    lower_price: Decimal = Decimal(0)
    upper_price: Decimal = Decimal(0)

    # Closing data
    close_price: Optional[Decimal] = None
    final_token_a: Optional[Decimal] = None
    final_token_b: Optional[Decimal] = None
    final_value_usd: Optional[Decimal] = None

    # Current tracking (updated during monitoring)
    current_value_usd: Decimal = Decimal(0)

    # Accumulated metrics
    total_fees_earned_usd: Decimal = Decimal(0)
    total_il_usd: Decimal = Decimal(0)
    total_tx_fees_usd: Decimal = Decimal(0)

    # Status
    is_closed: bool = False
    close_reason: Optional[str] = None

    def net_pnl(self) -> Decimal:
        """Calculate net PnL for this position."""
        if self.final_value_usd is None:
            return Decimal(0)
        return (
            self.final_value_usd - self.initial_value_usd +
            self.total_fees_earned_usd - self.total_tx_fees_usd
        )

    def to_dict(self) -> dict:
        """Convert to dictionary."""
        return {
            'position': self.position_address,
            'open_time': self.open_timestamp.isoformat(),
            'close_time': self.close_timestamp.isoformat() if self.close_timestamp else None,
            'open_price': float(self.open_price),
            'close_price': float(self.close_price) if self.close_price else None,
            'initial_value': float(self.initial_value_usd),
            'current_value': float(self.current_value_usd),
            'final_value': float(self.final_value_usd) if self.final_value_usd else None,
            'fees_earned': float(self.total_fees_earned_usd),
            'il': float(self.total_il_usd),
            'tx_fees': float(self.total_tx_fees_usd),
            'net_pnl': float(self.net_pnl()),
            'is_closed': self.is_closed,
            'close_reason': self.close_reason,
        }


@dataclass
class SwapRecord:
    """Record of a token swap transaction."""
    timestamp: datetime
    direction: str  # 'sell_sol' or 'buy_sol'
    input_amount: Decimal = Decimal(0)
    output_amount: Decimal = Decimal(0)
    input_token: str = ""  # 'SOL' or 'USDC'
    output_token: str = ""
    signature: Optional[str] = None
    tx_fee_sol: Decimal = Decimal(0)
    reason: str = "rebalance"  # 'rebalance', 'initial_position', etc.
    price_at_swap: Decimal = Decimal(0)  # SOL price at time of swap

    def to_dict(self) -> dict:
        return {
            'timestamp': self.timestamp.isoformat(),
            'direction': self.direction,
            'input': f"{float(self.input_amount):.6f} {self.input_token}",
            'output': f"{float(self.output_amount):.6f} {self.output_token}",
            'signature': self.signature[:16] + '...' if self.signature else None,
            'tx_fee_sol': float(self.tx_fee_sol),
            'reason': self.reason,
            'price': float(self.price_at_swap),
        }


@dataclass
class WsolCleanupRecord:
    """Record of a wSOL cleanup operation."""
    timestamp: datetime
    accounts_cleaned: int = 0
    sol_recovered: Decimal = Decimal(0)
    success: bool = True
    error: Optional[str] = None
    reason: str = "periodic"  # 'startup', 'after_close', 'periodic'
    tx_fee_sol: Decimal = Decimal(0)
    tx_fee_usd: Decimal = Decimal(0)

    def to_dict(self) -> dict:
        return {
            'timestamp': self.timestamp.isoformat(),
            'accounts_cleaned': self.accounts_cleaned,
            'sol_recovered': float(self.sol_recovered),
            'success': self.success,
            'error': self.error,
            'reason': self.reason,
            'tx_fee_sol': float(self.tx_fee_sol),
            'tx_fee_usd': float(self.tx_fee_usd),
        }


@dataclass
class PoolStateRecord:
    """Record of pool state at a point in time."""
    timestamp: datetime
    pool_address: str
    price: Decimal = Decimal(0)  # Current pool price
    sqrt_price: int = 0  # Raw sqrt_price from pool
    tick_current: int = 0  # Current tick
    liquidity: int = 0  # Current liquidity
    fee_growth_global_a: int = 0  # Fee growth token A
    fee_growth_global_b: int = 0  # Fee growth token B
    tick_spacing: int = 1  # Pool tick spacing

    def to_dict(self) -> dict:
        return {
            'timestamp': self.timestamp.isoformat(),
            'pool': self.pool_address[:16] + '...',
            'price': float(self.price),
            'tick_current': self.tick_current,
            'liquidity': self.liquidity,
            'tick_spacing': self.tick_spacing,
        }


@dataclass
class RebalanceRecord:
    """Record of a rebalance event."""
    timestamp: datetime
    position_address: str
    trigger_reason: str  # 'out_of_range', 'ratio_skew', 'emergency', 'volatility_update'
    is_emergency: bool = False

    # Before rebalance
    price_before: Decimal = Decimal(0)
    lower_before: Decimal = Decimal(0)
    upper_before: Decimal = Decimal(0)

    # After rebalance
    price_after: Decimal = Decimal(0)
    lower_after: Decimal = Decimal(0)
    upper_after: Decimal = Decimal(0)

    # New position info
    new_position_address: Optional[str] = None

    # Costs
    tx_fee_sol: Decimal = Decimal(0)  # Combined close + open tx fees
    swap_fee_sol: Decimal = Decimal(0)  # Swap tx fee if any
    swap_record: Optional[SwapRecord] = None

    # Amounts
    withdrawn_sol: Decimal = Decimal(0)
    withdrawn_usdc: Decimal = Decimal(0)
    deposited_sol: Decimal = Decimal(0)
    deposited_usdc: Decimal = Decimal(0)
    fees_collected_sol: Decimal = Decimal(0)
    fees_collected_usdc: Decimal = Decimal(0)

    def to_dict(self) -> dict:
        return {
            'timestamp': self.timestamp.isoformat(),
            'position': self.position_address[:16] + '...',
            'new_position': self.new_position_address[:16] + '...' if self.new_position_address else None,
            'reason': self.trigger_reason,
            'is_emergency': self.is_emergency,
            'price': float(self.price_after),
            'new_range': f"${float(self.lower_after):.2f} - ${float(self.upper_after):.2f}",
            'withdrawn': f"{float(self.withdrawn_sol):.4f} SOL + ${float(self.withdrawn_usdc):.2f}",
            'deposited': f"{float(self.deposited_sol):.4f} SOL + ${float(self.deposited_usdc):.2f}",
            'fees_collected': f"{float(self.fees_collected_sol):.6f} SOL + ${float(self.fees_collected_usdc):.4f}",
            'tx_fee': float(self.tx_fee_sol),
            'swap_fee': float(self.swap_fee_sol),
        }


@dataclass
class DailyStats:
    """Daily rebalance and performance stats."""
    date: date
    rebalance_count: int = 0
    emergency_used: bool = False
    fees_earned_usd: Decimal = Decimal(0)
    il_usd: Decimal = Decimal(0)
    tx_fees_usd: Decimal = Decimal(0)

    def can_rebalance(self, max_per_day: int) -> bool:
        """Check if more rebalances are allowed today."""
        return self.rebalance_count < max_per_day

    def can_emergency_rebalance(self) -> bool:
        """Check if emergency rebalance is available."""
        return not self.emergency_used


@dataclass
class SessionState:
    """Complete session state."""
    session_id: str
    start_time: datetime
    end_time: Optional[datetime] = None

    # Initial account state
    initial_sol_balance: Decimal = Decimal(0)
    initial_usdc_balance: Decimal = Decimal(0)
    initial_total_usd: Decimal = Decimal(0)

    # Current account state (updated periodically)
    current_sol_balance: Decimal = Decimal(0)
    current_usdc_balance: Decimal = Decimal(0)
    current_total_usd: Decimal = Decimal(0)

    # Position tracking
    positions: Dict[str, PositionRecord] = field(default_factory=dict)
    position_history: List[PositionRecord] = field(default_factory=list)

    # Rebalance tracking
    rebalances: List[RebalanceRecord] = field(default_factory=list)
    daily_stats: Dict[date, DailyStats] = field(default_factory=dict)

    # Swap tracking
    swaps: List[SwapRecord] = field(default_factory=list)
    total_swap_fees_sol: Decimal = Decimal(0)

    # Transaction cost tracking (network fees)
    session_total_tx_costs_sol: Decimal = Decimal(0)
    session_total_tx_costs_usd: Decimal = Decimal(0)

    # Cost decomposition by category (cumulative, includes rent for open/close)
    # Note: For position operations, individual costs include rent, but the net
    # (open + close) cancels out rent and shows true cost
    cost_by_category_sol: Dict[str, Decimal] = field(default_factory=lambda: {
        'swap': Decimal(0),
        'position_open': Decimal(0),
        'position_close': Decimal(0),
        'wsol_cleanup': Decimal(0),
        'stop_loss': Decimal(0),
    })
    cost_by_category_usd: Dict[str, Decimal] = field(default_factory=lambda: {
        'swap': Decimal(0),
        'position_open': Decimal(0),
        'position_close': Decimal(0),
        'wsol_cleanup': Decimal(0),
        'stop_loss': Decimal(0),
    })

    # wSOL cleanup tracking
    wsol_cleanups: List[WsolCleanupRecord] = field(default_factory=list)
    total_wsol_recovered: Decimal = Decimal(0)

    # Pool state tracking
    pool_states: List[PoolStateRecord] = field(default_factory=list)

    # Aggregate metrics
    total_positions_opened: int = 0
    total_positions_closed: int = 0
    total_rebalances: int = 0
    current_position_index: int = 0  # NEW: Current position index for CSV logging (1, 2, 3...)
    total_emergency_rebalances: int = 0
    total_swaps: int = 0
    total_wsol_cleanups: int = 0

    # ===== SESSION-SPECIFIC PNL TRACKING (NEW) =====
    # These fields track PnL at the SESSION level, NOT wallet level
    # Session PnL = sum of all position PnLs (entry vs exit + fees)

    # Total entry value across all positions opened in this session
    session_total_entry_value_usd: Decimal = Decimal(0)

    # Realized PnL from CLOSED positions (exit_value - entry_value)
    session_realized_pnl_usd: Decimal = Decimal(0)

    # Realized fees from CLOSED positions (actual fees collected via tx parsing)
    session_realized_fees_usd: Decimal = Decimal(0)

    # Track closed position entry values (for calculating unrealized PnL)
    session_closed_entries_total_usd: Decimal = Decimal(0)

    # ===== STRATEGY PERFORMANCE TRACKING (LP vs HODL) =====
    # These track what a HODL strategy would have returned vs LP strategy
    # Used to calculate "Strategy Alpha" = LP performance - HODL performance

    # Total HODL value at close for all closed positions
    # (what you'd have if you just held the initial tokens instead of LP'ing)
    session_total_hodl_value_at_close_usd: Decimal = Decimal(0)

    # Total impermanent loss across all closed positions
    session_total_il_usd: Decimal = Decimal(0)

    def get_daily_stats(self, for_date: Optional[date] = None) -> DailyStats:
        """
        Get or create daily stats for a date.
        
        CRITICAL: Resets at midnight UTC (calendar date change).
        When date changes, a new DailyStats is created with rebalance_count=0.
        """
        target_date = for_date or datetime.now(timezone.utc).date()
        if target_date not in self.daily_stats:
            # Check if this is a date change (limit reset)
            if len(self.daily_stats) > 0:
                previous_date = max(self.daily_stats.keys())
                if previous_date < target_date:
                    logger.info(
                        f"Daily rebalance limit RESET - new date: {target_date} "
                        f"(previous: {previous_date}). Rebalance count reset to 0."
                    )
            self.daily_stats[target_date] = DailyStats(date=target_date)
        return self.daily_stats[target_date]

    def add_cost(self, category: str, cost_sol: Decimal, cost_usd: Decimal) -> None:
        """
        Add a cost to both category-specific tracking and session totals.

        IMPORTANT: For position_open and position_close, costs include rent.
        - Individual operation costs are tracked cumulatively (for logging per-operation)
        - Net cost (open + close, where rent cancels) is tracked separately and cumulatively
        - Other costs (swap, wsol_cleanup, stop_loss) are actual costs, tracked cumulatively

        Args:
            category: Cost category ('swap', 'position_open', 'position_close', 'wsol_cleanup', 'stop_loss')
            cost_sol: Cost in SOL
            cost_usd: Cost in USD
        """
        if category in self.cost_by_category_sol:
            self.cost_by_category_sol[category] += cost_sol
            self.cost_by_category_usd[category] += cost_usd
        else:
            logger.warning(f"Unknown cost category: {category}, adding to session totals only")

        # Add to session totals
        # IMPORTANT: Individual operation costs (with rent) are tracked cumulatively.
        # The net cost (rent excluded) is calculated in get_cost_breakdown() and used
        # in get_session_pnl() and get_strategy_metrics() for accurate calculations.
        # session_total_tx_costs_usd here includes rent for backward compatibility,
        # but net costs are used where accuracy matters.
        self.session_total_tx_costs_sol += cost_sol
        self.session_total_tx_costs_usd += cost_usd

    def get_cost_breakdown(self) -> Dict:
        """
        Get a breakdown of costs by category.

        IMPORTANT: For position operations, the net cost (open + close) is calculated
        where rent cancels out. This represents the true cumulative cost.

        Returns:
            Dictionary with cost totals and per-category breakdown, including net position costs
        """
        # Calculate net position cost (rent cancels out)
        # Net = cumulative_open + cumulative_close
        # This gives the true cost after all rent deposits/refunds cancel
        cumulative_open = self.cost_by_category_usd.get('position_open', Decimal(0))
        cumulative_close = self.cost_by_category_usd.get('position_close', Decimal(0))
        net_open_close = cumulative_open + cumulative_close
        
        return {
            'total_sol': float(self.session_total_tx_costs_sol),
            'total_usd': float(self.session_total_tx_costs_usd),
            'by_category_sol': {k: float(v) for k, v in self.cost_by_category_sol.items()},
            'by_category_usd': {k: float(v) for k, v in self.cost_by_category_usd.items()},
            # Net position cost (cumulative, rent cancels out)
            'net_open_close_usd': float(net_open_close),
        }

    def add_position_opened(self, entry_value_usd: Decimal) -> None:
        """
        Track when a new position is opened.

        Args:
            entry_value_usd: Total USD value deposited into the position
        """
        self.session_total_entry_value_usd += entry_value_usd
        self.total_positions_opened += 1
        self.current_position_index += 1

    def add_position_closed(
        self,
        entry_value_usd: Decimal,
        exit_value_usd: Decimal,
        realized_fees_usd: Decimal,
        hodl_value_at_close_usd: Decimal = Decimal(0),
        il_usd: Decimal = Decimal(0),
    ) -> None:
        """
        Track when a position is closed with ACTUAL realized fees and IL data.

        Args:
            entry_value_usd: Original entry value of the position
            exit_value_usd: Final value withdrawn (includes collected fees in balance diff)
            realized_fees_usd: ACTUAL fees collected (from Helius tx parsing) - tracked separately for reporting
            hodl_value_at_close_usd: What HODL would be worth at close (for alpha calculation)
            il_usd: Impermanent loss for this position (exit_value - hodl_value, typically negative)
        """
        # Position PnL = exit_value - entry_value (exit_value EXCLUDES fees)
        # Realized fees are tracked separately and added in get_session_pnl()
        position_pnl = exit_value_usd - entry_value_usd

        self.session_realized_pnl_usd += position_pnl
        self.session_realized_fees_usd += realized_fees_usd
        self.session_closed_entries_total_usd += entry_value_usd
        self.total_positions_closed += 1

        # Track HODL comparison data for strategy alpha calculation
        self.session_total_hodl_value_at_close_usd += hodl_value_at_close_usd
        self.session_total_il_usd += il_usd

    def get_session_pnl(
        self,
        open_positions_value_usd: Decimal,
        pending_fees_usd: Decimal
    ) -> Dict:
        """
        Calculate session-specific PnL (NOT wallet-based).

        This is the CORRECT way to calculate PnL:
        - Tracks only capital deployed into positions
        - Realized PnL from closed positions
        - Unrealized PnL from open positions
        - Pending fees from open positions

        Args:
            open_positions_value_usd: Current value of all open positions
            pending_fees_usd: Estimated pending fees from open positions

        Returns:
            Dictionary with comprehensive session PnL breakdown
        """
        # Entry value of currently open positions
        open_entries_value = self.session_total_entry_value_usd - self.session_closed_entries_total_usd

        # Unrealized PnL from open positions (current value vs entry)
        unrealized_pnl = open_positions_value_usd - open_entries_value

        # Total session PnL = realized + realized fees + unrealized + pending fees
        # Note: realized PnL is (exit_value - entry_value) which EXCLUDES collected fees,
        # so we must add session_realized_fees_usd separately
        total_session_pnl = self.session_realized_pnl_usd + self.session_realized_fees_usd + unrealized_pnl + pending_fees_usd

        # Session PnL AFTER all costs (should reconcile with wallet-based return)
        # Use net costs (rent excluded) for accurate calculation
        cost_breakdown = self.get_cost_breakdown()
        net_position_cost = Decimal(str(cost_breakdown.get('net_open_close_usd', 0)))
        other_costs = (
            Decimal(str(cost_breakdown['by_category_usd']['swap'])) +
            Decimal(str(cost_breakdown['by_category_usd']['wsol_cleanup'])) +
            Decimal(str(cost_breakdown['by_category_usd']['stop_loss']))
        )
        total_net_costs = net_position_cost + other_costs
        total_session_pnl_after_costs = total_session_pnl - total_net_costs

        # Calculate percentage return on CURRENTLY deployed capital (open positions only)
        # This shows the return on capital that is currently active in positions
        if open_entries_value > 0:
            session_pnl_pct_deployed = (total_session_pnl / open_entries_value) * 100
        else:
            session_pnl_pct_deployed = Decimal(0)

        # Calculate percentage return on initial wallet balance (starting capital)
        # This shows the overall return on the capital you started the session with
        if self.initial_total_usd > 0:
            session_pnl_pct_initial = (total_session_pnl / self.initial_total_usd) * 100
        else:
            session_pnl_pct_initial = Decimal(0)

        # After-costs percentage
        if self.initial_total_usd > 0:
            session_pnl_after_costs_pct_initial = (total_session_pnl_after_costs / self.initial_total_usd) * 100
        else:
            session_pnl_after_costs_pct_initial = Decimal(0)

        return {
            # Initial wallet balance (starting capital)
            "initial_wallet_usd": float(self.initial_total_usd),

            # Deployed capital
            "total_deployed_usd": float(self.session_total_entry_value_usd),
            "open_entries_value_usd": float(open_entries_value),
            "closed_entries_value_usd": float(self.session_closed_entries_total_usd),

            # Current values
            "open_positions_value_usd": float(open_positions_value_usd),

            # Realized (from closed positions)
            "realized_pnl_usd": float(self.session_realized_pnl_usd),
            "realized_fees_usd": float(self.session_realized_fees_usd),

            # Unrealized (from open positions)
            "unrealized_pnl_usd": float(unrealized_pnl),
            "pending_fees_usd": float(pending_fees_usd),

            # Session totals
            "session_pnl_usd": float(total_session_pnl),
            "session_pnl_pct_deployed": float(session_pnl_pct_deployed),  # % of deployed capital
            "session_pnl_pct_initial": float(session_pnl_pct_initial),    # % of initial wallet

            # After-costs PnL
            "session_pnl_after_costs_usd": float(total_session_pnl_after_costs),
            "session_pnl_after_costs_pct_initial": float(session_pnl_after_costs_pct_initial),
            "total_costs_usd": float(total_net_costs),  # Use net costs (rent excluded)

            # Position counts
            "positions_opened": self.total_positions_opened,
            "positions_closed": self.total_positions_closed,
            "positions_active": len(self.positions),
        }

    def get_strategy_metrics(
        self,
        open_positions_value_usd: Decimal,
        pending_fees_usd: Decimal,
        open_positions_hodl_value_usd: Decimal = Decimal(0),
        open_positions_il_usd: Decimal = Decimal(0),
    ) -> Dict:
        """
        Calculate strategy performance metrics comparing LP to HODL.

        This answers the key question: "Did LP outperform just holding?"

        Strategy Alpha = Total Fees + Total IL - TX Costs
        - IL is typically NEGATIVE (e.g., -$5.00 means you lost $5 to IL)
        - So the formula effectively calculates: Fees - |IL| - TX Costs
        - Positive alpha = LP strategy beat HODL
        - Negative alpha = HODL would have been better

        Market Movement = HODL value change (what you'd have if just held)
        - This separates market direction from strategy performance
        - "You lost 2.2% total, but -3.8% was market, +1.6% was strategy alpha"

        Args:
            open_positions_value_usd: Current value of all open positions
            pending_fees_usd: Estimated pending fees from open positions
            open_positions_hodl_value_usd: What open positions would be worth if HODL
            open_positions_il_usd: IL from open positions

        Returns:
            Dictionary with strategy performance breakdown
        """
        # ===== REALIZED (from closed positions) =====
        realized_fees = self.session_realized_fees_usd
        realized_il = self.session_total_il_usd  # Typically negative
        realized_hodl_value = self.session_total_hodl_value_at_close_usd
        closed_entry_value = self.session_closed_entries_total_usd

        # Market movement for closed positions
        # = how much HODL changed from entry to close
        realized_market_movement = realized_hodl_value - closed_entry_value

        # ===== UNREALIZED (from open positions) =====
        open_entry_value = self.session_total_entry_value_usd - closed_entry_value
        unrealized_il = open_positions_il_usd  # Typically negative

        # Market movement for open positions
        unrealized_market_movement = open_positions_hodl_value_usd - open_entry_value

        # ===== TOTALS =====
        total_fees = realized_fees + pending_fees_usd
        total_il = realized_il + unrealized_il  # Both typically negative
        total_market_movement = realized_market_movement + unrealized_market_movement

        # Transaction costs (use net costs, rent excluded)
        cost_breakdown = self.get_cost_breakdown()
        net_position_cost = Decimal(str(cost_breakdown.get('net_open_close_usd', 0)))
        other_costs = (
            Decimal(str(cost_breakdown['by_category_usd']['swap'])) +
            Decimal(str(cost_breakdown['by_category_usd']['wsol_cleanup'])) +
            Decimal(str(cost_breakdown['by_category_usd']['stop_loss']))
        )
        total_tx_costs = net_position_cost + other_costs

        # ===== STRATEGY ALPHA =====
        # Alpha = Fees earned - IL suffered - TX costs
        # This is what LP added/subtracted vs HODL
        # Positive = LP beat HODL, Negative = HODL would have been better
        strategy_alpha = total_fees + total_il - total_tx_costs  # IL is negative, so adding it subtracts

        # Calculate alpha percentage
        total_entry = self.session_total_entry_value_usd
        alpha_pct = (strategy_alpha / total_entry * 100) if total_entry > 0 else Decimal(0)

        # ===== LP vs HODL COMPARISON =====
        # LP Total Return = exit value + fees - entry value = session_pnl
        # HODL Total Return = hodl_value - entry value = market_movement
        # Alpha = LP Return - HODL Return

        return {
            # Entry values
            "total_entry_value_usd": float(total_entry),
            "closed_entry_value_usd": float(closed_entry_value),
            "open_entry_value_usd": float(open_entry_value),

            # Fees (positive contributor to alpha)
            "realized_fees_usd": float(realized_fees),
            "pending_fees_usd": float(pending_fees_usd),
            "total_fees_usd": float(total_fees),

            # Impermanent Loss (negative contributor to alpha)
            "realized_il_usd": float(realized_il),
            "unrealized_il_usd": float(unrealized_il),
            "total_il_usd": float(total_il),

            # Transaction costs (negative contributor to alpha)
            "total_tx_costs_usd": float(total_tx_costs),

            # Market movement (HODL performance)
            "realized_market_movement_usd": float(realized_market_movement),
            "unrealized_market_movement_usd": float(unrealized_market_movement),
            "total_market_movement_usd": float(total_market_movement),

            # STRATEGY ALPHA (LP vs HODL)
            # Positive = LP outperformed HODL
            # Negative = HODL would have been better
            "strategy_alpha_usd": float(strategy_alpha),
            "strategy_alpha_pct": float(alpha_pct),

            # Human-readable interpretation
            "lp_beat_hodl": strategy_alpha > 0,
            "summary": (
                f"LP {'outperformed' if strategy_alpha > 0 else 'underperformed'} HODL by "
                f"${abs(float(strategy_alpha)):.2f} ({abs(float(alpha_pct)):.2f}%)"
            ),
        }


class SessionManager:
    """
    Manages LP strategy session lifecycle and aggregation.

    Responsibilities:
    - Track session start/end
    - Maintain position records
    - Track rebalance events with daily limits
    - Aggregate PnL across positions
    - Output session data to CSV/JSON
    """

    def __init__(self, config: Optional[Config] = None):
        self.config = config or get_config()
        self._state: Optional[SessionState] = None

        # Determine output directory
        # Use configured data_dir if it exists and is writable, otherwise use local ./data
        configured_dir = Path(self.config.session.data_dir)
        if configured_dir.exists() and configured_dir.is_dir():
            self._output_dir = configured_dir
        else:
            # Fall back to local ./data directory for local testing
            local_data_dir = Path(__file__).parent / "data"
            self._output_dir = local_data_dir
            logger.info(f"Using local data directory: {local_data_dir} (configured {configured_dir} not available)")

        # CSV writers
        self._snapshots_csv: Optional[csv.DictWriter] = None
        self._snapshots_file = None
        self._rebalances_csv: Optional[csv.DictWriter] = None
        self._rebalances_file = None
        self._swaps_csv: Optional[csv.DictWriter] = None
        self._swaps_file = None
        self._wsol_cleanup_csv: Optional[csv.DictWriter] = None
        self._wsol_cleanup_file = None
        self._pool_state_csv: Optional[csv.DictWriter] = None
        self._pool_state_file = None

    @property
    def state(self) -> Optional[SessionState]:
        return self._state

    @property
    def is_active(self) -> bool:
        return self._state is not None and self._state.end_time is None

    def start_session(
        self,
        initial_sol: Decimal,
        initial_usdc: Decimal,
        initial_price: Decimal
    ) -> SessionState:
        """Start a new session."""
        session_id = datetime.now().strftime("%Y%m%d_%H%M%S")
        initial_total = (initial_sol * initial_price) + initial_usdc

        self._state = SessionState(
            session_id=session_id,
            start_time=datetime.now(timezone.utc),
            initial_sol_balance=initial_sol,
            initial_usdc_balance=initial_usdc,
            initial_total_usd=initial_total,
            current_sol_balance=initial_sol,
            current_usdc_balance=initial_usdc,
            current_total_usd=initial_total,
        )

        # Setup output directory and files
        self._setup_output_files(session_id)

        logger.info(f"Session started: {session_id}")
        logger.info(f"  Initial: {initial_sol:.6f} SOL + {initial_usdc:.2f} USDC = ${initial_total:.2f}")

        return self._state

    def _setup_output_files(self, session_id: str) -> None:
        """Setup CSV output files."""
        self._output_dir.mkdir(parents=True, exist_ok=True)

        # Snapshots CSV - includes IL tracking, wallet balances, and SESSION EQUITY CURVE
        # IL columns: hodl_value_usd, il_usd, il_pct, net_pnl_usd (IL + pending fees)
        # Session PnL columns: Track session-specific equity curve (NOT wallet-based)
        snapshots_path = self._output_dir / f"session_{session_id}_snapshots.csv"
        self._snapshots_file = open(snapshots_path, 'w', newline='')
        self._snapshots_csv = csv.DictWriter(self._snapshots_file, fieldnames=[
            'timestamp', 'position', 'price', 'in_range', 'token_a', 'token_b',
            'value_usd', 'token_a_ratio',
            'hodl_value_usd', 'il_usd', 'il_pct',  # IL tracking columns
            'pending_fees_usd', 'net_pnl_usd',  # Fees and net PnL
            'wallet_sol', 'wallet_usdc', 'wallet_total_usd',
            # Legacy session columns (wallet-based - DEPRECATED, kept for backwards compatibility)
            'session_total_value', 'session_total_pnl', 'session_total_pnl_pct',
            # ===== SESSION EQUITY CURVE (position-based, NOT wallet-based) =====
            'session_initial_wallet',      # Initial wallet balance at session start
            'session_deployed_capital',    # Total entry value of all positions in session (cumulative)
            'session_open_entries_value',  # Entry value of currently open positions
            'session_current_value',       # Current value of all open positions
            'session_realized_pnl',        # PnL from closed positions only
            'session_realized_fees',       # ACTUAL fees from closed positions (tx parsing)
            'session_unrealized_pnl',      # PnL from open positions (current - entry)
            'session_pending_fees',        # Estimated pending fees from open positions
            'session_total_pnl',           # Total session PnL (realized + unrealized + fees)
            'session_pnl_pct_deployed',    # Session PnL as % of CURRENTLY deployed capital
            'session_pnl_pct_initial',     # Session PnL as % of initial wallet balance
            'session_pnl_after_costs',     # Session PnL after all costs deducted
            'session_total_costs',         # Total costs deducted from PnL
            # ===== COST DECOMPOSITION =====
            'cost_total_sol', 'cost_total_usd',
            'cost_swap_sol', 'cost_swap_usd',
            'cost_position_open_sol', 'cost_position_open_usd',
            'cost_position_close_sol', 'cost_position_close_usd',
            'cost_wsol_cleanup_sol', 'cost_wsol_cleanup_usd',
            'cost_stop_loss_sol', 'cost_stop_loss_usd',
        ])
        self._snapshots_csv.writeheader()

        # Rebalances CSV
        rebalances_path = self._output_dir / f"session_{session_id}_rebalances.csv"
        self._rebalances_file = open(rebalances_path, 'w', newline='')
        self._rebalances_csv = csv.DictWriter(self._rebalances_file, fieldnames=[
            'timestamp', 'position', 'reason', 'is_emergency', 'price',
            'lower_before', 'upper_before', 'lower_after', 'upper_after', 'tx_fee_sol'
        ])
        self._rebalances_csv.writeheader()

        # Swaps CSV
        swaps_path = self._output_dir / f"session_{session_id}_swaps.csv"
        self._swaps_file = open(swaps_path, 'w', newline='')
        self._swaps_csv = csv.DictWriter(self._swaps_file, fieldnames=[
            'timestamp', 'direction', 'input_amount', 'input_token',
            'output_amount', 'output_token', 'price', 'tx_fee_sol',
            'reason', 'signature'
        ])
        self._swaps_csv.writeheader()

        # wSOL Cleanup CSV
        wsol_path = self._output_dir / f"session_{session_id}_wsol_cleanup.csv"
        self._wsol_cleanup_file = open(wsol_path, 'w', newline='')
        self._wsol_cleanup_csv = csv.DictWriter(self._wsol_cleanup_file, fieldnames=[
            'timestamp', 'accounts_cleaned', 'sol_recovered', 'success', 'error', 'reason',
            'tx_fee_sol', 'tx_fee_usd'
        ])
        self._wsol_cleanup_csv.writeheader()

        # Pool State CSV - tracks pool data each iteration
        pool_state_path = self._output_dir / f"session_{session_id}_pool_state.csv"
        self._pool_state_file = open(pool_state_path, 'w', newline='')
        self._pool_state_csv = csv.DictWriter(self._pool_state_file, fieldnames=[
            'timestamp', 'pool_address', 'price', 'sqrt_price', 'tick_current',
            'liquidity', 'fee_growth_global_a', 'fee_growth_global_b', 'tick_spacing'
        ])
        self._pool_state_csv.writeheader()

        logger.info(f"Output files created: snapshots, rebalances, swaps, wsol_cleanup, pool_state")

    def end_session(self, final_price: Decimal) -> Dict:
        """End the session and return final summary."""
        if not self._state:
            return {}

        self._state.end_time = datetime.now(timezone.utc)

        # Close any open positions in records
        for pos_record in self._state.positions.values():
            if not pos_record.is_closed:
                pos_record.is_closed = True
                pos_record.close_timestamp = self._state.end_time
                pos_record.close_reason = 'session_end'
                self._state.position_history.append(pos_record)

        # Calculate final summary
        summary = self.get_session_summary(final_price)

        # Save final state
        self._save_session_state()

        # Close files
        if self._snapshots_file:
            self._snapshots_file.close()
        if self._rebalances_file:
            self._rebalances_file.close()
        if self._swaps_file:
            self._swaps_file.close()
        if self._wsol_cleanup_file:
            self._wsol_cleanup_file.close()
        if self._pool_state_file:
            self._pool_state_file.close()

        logger.info(f"Session ended: {self._state.session_id}")
        logger.info(f"  Duration: {self._state.end_time - self._state.start_time}")
        logger.info(f"  Final PnL: ${summary.get('net_pnl_usd', 0):.2f} ({summary.get('net_pnl_pct', 0):.2f}%)")

        return summary

    def register_position(
        self,
        position_address: str,
        open_price: Decimal,
        initial_token_a: Decimal,
        initial_token_b: Decimal,
        lower_price: Decimal,
        upper_price: Decimal
    ) -> PositionRecord:
        """Register a new position in the session."""
        if not self._state:
            raise RuntimeError("No active session")

        initial_value = (initial_token_a * open_price) + initial_token_b

        # CRITICAL FIX: Check if position already registered to prevent double-counting entry value
        # This can happen if position was registered but monitor initialization failed, then
        # position is rediscovered later (e.g., via on-chain discovery)
        position_already_registered = position_address in self._state.positions

        record = PositionRecord(
            position_address=position_address,
            open_timestamp=datetime.now(timezone.utc),
            open_price=open_price,
            initial_token_a=initial_token_a,
            initial_token_b=initial_token_b,
            initial_value_usd=initial_value,
            current_value_usd=initial_value,
            lower_price=lower_price,
            upper_price=upper_price,
        )

        self._state.positions[position_address] = record

        # ===== NEW: Track entry value for session PnL =====
        # Use add_position_opened for proper session PnL tracking
        # Note: This handles total_positions_opened and current_position_index
        # CRITICAL FIX: Only add to session totals if position wasn't already registered
        # This prevents double-counting when positions are rediscovered
        if not position_already_registered:
            self._state.session_total_entry_value_usd += initial_value
            self._state.total_positions_opened += 1
            logger.info(f"Position registered: {position_address[:16]}...")
            logger.info(f"  Range: ${lower_price:.4f} - ${upper_price:.4f}")
            logger.info(f"  Value: ${initial_value:.2f}")
            logger.info(f"  Session deployed capital: ${float(self._state.session_total_entry_value_usd):.2f}")
        else:
            logger.warning(f"Position {position_address[:16]}... already registered - updating record but not double-counting entry value")
            logger.info(f"  Range: ${lower_price:.4f} - ${upper_price:.4f}")
            logger.info(f"  Value: ${initial_value:.2f} (not added to session totals - already counted)")

        # Note: current_position_index is incremented in lp_strategy.py before calling log_position_open

        return record

    def close_position(
        self,
        position_address: str,
        close_price: Decimal,
        final_token_a: Decimal,
        final_token_b: Decimal,
        fees_earned: Decimal,
        tx_fee: Decimal,
        reason: str = 'rebalance',
        realized_fees_sol: Decimal = Decimal(0),  # NEW: Actual fees from Helius
        realized_fees_usdc: Decimal = Decimal(0),  # NEW: Actual fees from Helius
    ) -> Optional[PositionRecord]:
        """
        Close a position and record final state.

        Args:
            position_address: Address of the position to close
            close_price: Current SOL price at close
            final_token_a: SOL withdrawn (excluding fees)
            final_token_b: USDC withdrawn (excluding fees)
            fees_earned: Legacy fees estimate (DEPRECATED - use realized_fees_*)
            tx_fee: Transaction fee in SOL
            reason: Why the position was closed
            realized_fees_sol: ACTUAL SOL fees collected (from Helius tx parsing)
            realized_fees_usdc: ACTUAL USDC fees collected (from Helius tx parsing)
        """
        if not self._state:
            return None

        record = self._state.positions.get(position_address)
        if not record:
            logger.warning(f"Position not found: {position_address}")
            return None

        record.close_timestamp = datetime.now(timezone.utc)
        record.close_price = close_price
        record.final_token_a = final_token_a
        record.final_token_b = final_token_b
        record.final_value_usd = (final_token_a * close_price) + final_token_b
        record.total_tx_fees_usd += tx_fee
        record.is_closed = True
        record.close_reason = reason

        # ===== NEW: Use ACTUAL realized fees from Helius if available =====
        # Otherwise fall back to the legacy estimate
        if realized_fees_sol > 0 or realized_fees_usdc > 0:
            # Calculate realized fees USD value
            realized_fees_usd = (realized_fees_sol * close_price) + realized_fees_usdc
            record.total_fees_earned_usd = realized_fees_usd
            logger.info(f"  Using ACTUAL fees from Helius: {realized_fees_sol:.6f} SOL + ${realized_fees_usdc:.2f} USDC = ${float(realized_fees_usd):.2f}")
        else:
            record.total_fees_earned_usd = fees_earned
            logger.info(f"  Using estimated fees: ${float(fees_earned):.2f} (Helius not available)")

        # Calculate IL (Impermanent Loss)
        # HODL value = what you'd have if you just held the initial tokens
        hold_value = (record.initial_token_a * close_price) + record.initial_token_b
        record.total_il_usd = record.final_value_usd - hold_value  # Typically negative

        # ===== Update session-level PnL tracking =====
        # Pass HODL value and IL for strategy alpha calculation
        self._state.add_position_closed(
            entry_value_usd=record.initial_value_usd,
            exit_value_usd=record.final_value_usd,
            realized_fees_usd=record.total_fees_earned_usd,
            hodl_value_at_close_usd=hold_value,  # For market movement calculation
            il_usd=record.total_il_usd,  # For strategy alpha calculation
        )

        # Move to history (note: total_positions_closed is handled by add_position_closed)
        self._state.position_history.append(record)
        del self._state.positions[position_address]
        # Note: total_positions_closed is now incremented in add_position_closed

        # Calculate position-level PnL for logging
        position_pnl = (record.final_value_usd - record.initial_value_usd) + record.total_fees_earned_usd

        logger.info(f"Position closed: {position_address[:16]}... (reason: {reason})")
        logger.info(f"  Entry value: ${float(record.initial_value_usd):.2f}")
        logger.info(f"  Exit value: ${float(record.final_value_usd):.2f}")
        logger.info(f"  Realized fees: ${float(record.total_fees_earned_usd):.2f}")
        logger.info(f"  Position PnL: ${float(position_pnl):.2f}")
        logger.info(f"  Session realized PnL: ${float(self._state.session_realized_pnl_usd):.2f}")
        logger.info(f"  Session realized fees: ${float(self._state.session_realized_fees_usd):.2f}")

        return record

    def record_swap(
        self,
        direction: str,
        input_amount: Decimal,
        output_amount: Decimal,
        input_token: str,
        output_token: str,
        signature: Optional[str] = None,
        tx_fee_sol: Decimal = Decimal("0.001"),  # Estimated swap fee
        reason: str = "rebalance",
        price: Decimal = Decimal(0),  # SOL price at time of swap
    ) -> SwapRecord:
        """
        Record a token swap transaction.

        Args:
            direction: 'sell_sol' or 'buy_sol'
            input_amount: Amount of input token
            output_amount: Amount of output token received
            input_token: 'SOL' or 'USDC'
            output_token: 'SOL' or 'USDC'
            signature: Transaction signature
            tx_fee_sol: Transaction fee in SOL
            reason: Why the swap was made
            price: SOL price at time of swap

        Returns:
            SwapRecord
        """
        if not self._state:
            raise RuntimeError("No active session")

        record = SwapRecord(
            timestamp=datetime.now(timezone.utc),
            direction=direction,
            input_amount=input_amount,
            output_amount=output_amount,
            input_token=input_token,
            output_token=output_token,
            signature=signature,
            tx_fee_sol=tx_fee_sol,
            reason=reason,
            price_at_swap=price,
        )

        self._state.swaps.append(record)
        self._state.total_swaps += 1
        self._state.total_swap_fees_sol += tx_fee_sol

        # Write to CSV
        if self._swaps_csv:
            self._swaps_csv.writerow({
                'timestamp': record.timestamp.isoformat(),
                'direction': direction,
                'input_amount': float(input_amount),
                'input_token': input_token,
                'output_amount': float(output_amount),
                'output_token': output_token,
                'price': float(price),
                'tx_fee_sol': float(tx_fee_sol),
                'reason': reason,
                'signature': signature or '',
            })
            self._swaps_file.flush()

        logger.info(f"Swap recorded: {input_amount:.4f} {input_token} -> {output_amount:.4f} {output_token}")
        logger.info(f"  Reason: {reason}, Fee: {tx_fee_sol:.6f} SOL")

        return record

    def record_rebalance(
        self,
        position_address: str,
        trigger_reason: str,
        is_emergency: bool,
        price: Decimal,
        lower_before: Decimal,
        upper_before: Decimal,
        lower_after: Decimal,
        upper_after: Decimal,
        tx_fee_sol: Decimal,
        # New parameters for detailed tracking
        new_position_address: Optional[str] = None,
        withdrawn_sol: Decimal = Decimal(0),
        withdrawn_usdc: Decimal = Decimal(0),
        deposited_sol: Decimal = Decimal(0),
        deposited_usdc: Decimal = Decimal(0),
        fees_collected_sol: Decimal = Decimal(0),
        fees_collected_usdc: Decimal = Decimal(0),
        swap_record: Optional[SwapRecord] = None,
    ) -> RebalanceRecord:
        """
        Record a rebalance event with full transaction details.

        This now tracks:
        - Old and new position addresses
        - Withdrawn/deposited amounts
        - Collected fees
        - Associated swap if any
        """
        if not self._state:
            raise RuntimeError("No active session")

        swap_fee = swap_record.tx_fee_sol if swap_record else Decimal(0)

        record = RebalanceRecord(
            timestamp=datetime.now(timezone.utc),
            position_address=position_address,
            trigger_reason=trigger_reason,
            is_emergency=is_emergency,
            price_before=price,
            lower_before=lower_before,
            upper_before=upper_before,
            price_after=price,
            lower_after=lower_after,
            upper_after=upper_after,
            new_position_address=new_position_address,
            tx_fee_sol=tx_fee_sol,
            swap_fee_sol=swap_fee,
            swap_record=swap_record,
            withdrawn_sol=withdrawn_sol,
            withdrawn_usdc=withdrawn_usdc,
            deposited_sol=deposited_sol,
            deposited_usdc=deposited_usdc,
            fees_collected_sol=fees_collected_sol,
            fees_collected_usdc=fees_collected_usdc,
        )

        self._state.rebalances.append(record)
        self._state.total_rebalances += 1

        # Update daily stats
        daily = self._state.get_daily_stats()
        daily.rebalance_count += 1
        daily.tx_fees_usd += tx_fee_sol * price  # Approximate USD cost
        if swap_fee > 0:
            daily.tx_fees_usd += swap_fee * price
        if is_emergency:
            daily.emergency_used = True
            self._state.total_emergency_rebalances += 1

        # Write to CSV
        if self._rebalances_csv:
            self._rebalances_csv.writerow({
                'timestamp': record.timestamp.isoformat(),
                'position': position_address,
                'reason': trigger_reason,
                'is_emergency': is_emergency,
                'price': float(price),
                'lower_before': float(lower_before),
                'upper_before': float(upper_before),
                'lower_after': float(lower_after),
                'upper_after': float(upper_after),
                'tx_fee_sol': float(tx_fee_sol + swap_fee),
            })
            self._rebalances_file.flush()

        logger.info(f"Rebalance recorded: {trigger_reason} ({'EMERGENCY' if is_emergency else 'normal'})")
        if new_position_address:
            logger.info(f"  New position: {new_position_address[:16]}...")
        if swap_record:
            logger.info(f"  Swap included: {swap_record.input_amount:.4f} {swap_record.input_token} -> {swap_record.output_amount:.4f} {swap_record.output_token}")

        return record

    def can_rebalance(self) -> bool:
        """Check if normal rebalance is allowed."""
        if not self._state:
            return False
        daily = self._state.get_daily_stats()
        return daily.can_rebalance(self.config.rebalance.max_rebalances_per_day)

    def can_emergency_rebalance(self) -> bool:
        """Check if emergency rebalance is available."""
        if not self._state:
            return False
        daily = self._state.get_daily_stats()
        return daily.can_emergency_rebalance()

    def update_wallet_balance(
        self,
        sol_balance: Decimal,
        usdc_balance: Decimal,
        current_price: Decimal
    ) -> None:
        """
        Update current wallet balances (outside of positions).

        This is used to track the remaining wallet balance for accurate PnL calculation.
        Total value = position values + wallet balance.
        """
        if not self._state:
            return

        self._state.current_sol_balance = sol_balance
        self._state.current_usdc_balance = usdc_balance
        self._state.current_total_usd = (sol_balance * current_price) + usdc_balance

    def record_snapshot(self, snapshot: PositionSnapshot) -> None:
        """Record a position snapshot to CSV and update position state."""
        if not self._state:
            return

        # Update position's current value for PnL tracking
        if snapshot.position_address in self._state.positions:
            record = self._state.positions[snapshot.position_address]
            record.current_value_usd = snapshot.current_value_usd
            record.total_fees_earned_usd = snapshot.pending_fees_usd
            record.total_il_usd = snapshot.il_usd

        if not self._snapshots_csv:
            return

        # Calculate LEGACY session totals (wallet-based - DEPRECATED but kept for compatibility)
        total_value = snapshot.current_value_usd
        total_pnl = total_value - self._state.initial_total_usd + snapshot.pending_fees_usd
        total_pnl_pct = (total_pnl / self._state.initial_total_usd * 100) if self._state.initial_total_usd > 0 else Decimal(0)

        # Calculate net PnL (IL + pending fees)
        net_pnl_usd = snapshot.il_usd + snapshot.pending_fees_usd

        # ===== NEW: Calculate session-specific PnL (position-based, NOT wallet-based) =====
        # Sum current value and pending fees from ALL open positions
        total_open_value = Decimal(0)
        total_pending_fees = Decimal(0)
        for pos_record in self._state.positions.values():
            total_open_value += pos_record.current_value_usd
            total_pending_fees += pos_record.total_fees_earned_usd

        # Get session PnL breakdown
        session_pnl_data = self._state.get_session_pnl(total_open_value, total_pending_fees)

        # Get cost breakdown
        cost_breakdown = self._state.get_cost_breakdown()

        self._snapshots_csv.writerow({
            'timestamp': snapshot.timestamp.isoformat(),
            'position': snapshot.position_address,
            'price': float(snapshot.current_price),
            'in_range': snapshot.is_in_range,
            'token_a': float(snapshot.current_token_a),
            'token_b': float(snapshot.current_token_b),
            'value_usd': float(snapshot.current_value_usd),
            'token_a_ratio': float(snapshot.token_a_ratio),
            'hodl_value_usd': float(snapshot.hold_value_usd),  # HODL baseline for IL calc
            'il_usd': float(snapshot.il_usd),
            'il_pct': float(snapshot.il_pct),
            'pending_fees_usd': float(snapshot.pending_fees_usd),
            'net_pnl_usd': float(net_pnl_usd),  # IL + pending fees
            'wallet_sol': float(self._state.current_sol_balance),
            'wallet_usdc': float(self._state.current_usdc_balance),
            'wallet_total_usd': float(self._state.current_total_usd),
            # Legacy columns (wallet-based - DEPRECATED)
            'session_total_value': float(total_value),
            'session_total_pnl': float(total_pnl),
            'session_total_pnl_pct': float(total_pnl_pct),
            # ===== SESSION EQUITY CURVE (position-based) =====
            'session_initial_wallet': session_pnl_data['initial_wallet_usd'],
            'session_deployed_capital': session_pnl_data['total_deployed_usd'],
            'session_open_entries_value': session_pnl_data['open_entries_value_usd'],
            'session_current_value': session_pnl_data['open_positions_value_usd'],
            'session_realized_pnl': session_pnl_data['realized_pnl_usd'],
            'session_realized_fees': session_pnl_data['realized_fees_usd'],
            'session_unrealized_pnl': session_pnl_data['unrealized_pnl_usd'],
            'session_pending_fees': session_pnl_data['pending_fees_usd'],
            'session_total_pnl': session_pnl_data['session_pnl_usd'],
            'session_pnl_pct_deployed': session_pnl_data['session_pnl_pct_deployed'],
            'session_pnl_pct_initial': session_pnl_data['session_pnl_pct_initial'],
            'session_pnl_after_costs': session_pnl_data['session_pnl_after_costs_usd'],
            'session_total_costs': session_pnl_data['total_costs_usd'],
            # ===== COST DECOMPOSITION =====
            'cost_total_sol': cost_breakdown['total_sol'],
            'cost_total_usd': cost_breakdown['total_usd'],
            'cost_swap_sol': cost_breakdown['by_category_sol']['swap'],
            'cost_swap_usd': cost_breakdown['by_category_usd']['swap'],
            'cost_position_open_sol': cost_breakdown['by_category_sol']['position_open'],
            'cost_position_open_usd': cost_breakdown['by_category_usd']['position_open'],
            'cost_position_close_sol': cost_breakdown['by_category_sol']['position_close'],
            'cost_position_close_usd': cost_breakdown['by_category_usd']['position_close'],
            'cost_wsol_cleanup_sol': cost_breakdown['by_category_sol']['wsol_cleanup'],
            'cost_wsol_cleanup_usd': cost_breakdown['by_category_usd']['wsol_cleanup'],
            'cost_stop_loss_sol': cost_breakdown['by_category_sol']['stop_loss'],
            'cost_stop_loss_usd': cost_breakdown['by_category_usd']['stop_loss'],
        })
        self._snapshots_file.flush()

    def record_wsol_cleanup(
        self,
        accounts_cleaned: int,
        sol_recovered: Decimal,
        success: bool = True,
        error: Optional[str] = None,
        reason: str = "periodic",
        tx_fee_sol: Decimal = Decimal(0),
        current_price: Decimal = Decimal(0),
    ) -> WsolCleanupRecord:
        """
        Record a wSOL cleanup operation.

        Args:
            accounts_cleaned: Number of wSOL accounts closed
            sol_recovered: Total SOL recovered from cleanup
            success: Whether the cleanup succeeded
            error: Error message if failed
            reason: Why the cleanup was performed ('startup', 'after_close', 'periodic')
            tx_fee_sol: Transaction fees paid for cleanup in SOL
            current_price: Current SOL price for USD conversion

        Returns:
            WsolCleanupRecord
        """
        if not self._state:
            raise RuntimeError("No active session")

        # Calculate USD cost
        tx_fee_usd = tx_fee_sol * current_price if current_price > 0 else Decimal(0)

        record = WsolCleanupRecord(
            timestamp=datetime.now(timezone.utc),
            accounts_cleaned=accounts_cleaned,
            sol_recovered=sol_recovered,
            success=success,
            error=error,
            reason=reason,
            tx_fee_sol=tx_fee_sol,
            tx_fee_usd=tx_fee_usd,
        )

        self._state.wsol_cleanups.append(record)
        self._state.total_wsol_cleanups += 1
        if success:
            self._state.total_wsol_recovered += sol_recovered
            # Track wSOL cleanup costs if fee > 0
            if tx_fee_sol > 0:
                self._state.add_cost('wsol_cleanup', tx_fee_sol, tx_fee_usd)

        # Write to CSV
        if self._wsol_cleanup_csv:
            self._wsol_cleanup_csv.writerow({
                'timestamp': record.timestamp.isoformat(),
                'accounts_cleaned': accounts_cleaned,
                'sol_recovered': float(sol_recovered),
                'success': success,
                'error': error or '',
                'reason': reason,
                'tx_fee_sol': float(tx_fee_sol),
                'tx_fee_usd': float(tx_fee_usd),
            })
            self._wsol_cleanup_file.flush()

        if success and accounts_cleaned > 0:
            logger.info(f"wSOL cleanup recorded: {accounts_cleaned} accounts, {sol_recovered:.6f} SOL recovered, fee: {float(tx_fee_sol):.6f} SOL (${float(tx_fee_usd):.4f})")
        elif not success:
            logger.warning(f"wSOL cleanup failed: {error}")

        return record

    def record_pool_state(
        self,
        pool_address: str,
        price: Decimal,
        sqrt_price: int = 0,
        tick_current: int = 0,
        liquidity: int = 0,
        fee_growth_global_a: int = 0,
        fee_growth_global_b: int = 0,
        tick_spacing: int = 1,
    ) -> PoolStateRecord:
        """
        Record pool state at current time.

        Args:
            pool_address: Pool address
            price: Current pool price
            sqrt_price: Raw sqrt_price from pool state
            tick_current: Current tick index
            liquidity: Current liquidity
            fee_growth_global_a: Fee growth for token A
            fee_growth_global_b: Fee growth for token B
            tick_spacing: Pool tick spacing

        Returns:
            PoolStateRecord
        """
        if not self._state:
            raise RuntimeError("No active session")

        record = PoolStateRecord(
            timestamp=datetime.now(timezone.utc),
            pool_address=pool_address,
            price=price,
            sqrt_price=sqrt_price,
            tick_current=tick_current,
            liquidity=liquidity,
            fee_growth_global_a=fee_growth_global_a,
            fee_growth_global_b=fee_growth_global_b,
            tick_spacing=tick_spacing,
        )

        self._state.pool_states.append(record)

        # Write to CSV
        if self._pool_state_csv:
            self._pool_state_csv.writerow({
                'timestamp': record.timestamp.isoformat(),
                'pool_address': pool_address,
                'price': float(price),
                'sqrt_price': sqrt_price,
                'tick_current': tick_current,
                'liquidity': liquidity,
                'fee_growth_global_a': fee_growth_global_a,
                'fee_growth_global_b': fee_growth_global_b,
                'tick_spacing': tick_spacing,
            })
            self._pool_state_file.flush()

        return record

    def get_session_summary(self, current_price: Decimal) -> Dict:
        """
        Get current session summary using CORRECT position-based PnL calculation.

        This replaces the old wallet-based calculation which produced incorrect results.
        """
        if not self._state:
            return {}

        # Calculate current value and pending fees from ALL open positions
        total_open_value = Decimal(0)
        total_pending_fees = Decimal(0)
        for pos_record in self._state.positions.values():
            total_open_value += pos_record.current_value_usd
            total_pending_fees += pos_record.total_fees_earned_usd

        # Get the CORRECT session PnL breakdown (position-based)
        session_pnl_data = self._state.get_session_pnl(total_open_value, total_pending_fees)

        # Aggregate fees and tx costs for legacy compatibility
        total_fees = Decimal(0)
        total_il = Decimal(0)
        total_tx_fees = Decimal(0)

        # Sum from active positions
        for record in self._state.positions.values():
            total_fees += record.total_fees_earned_usd
            total_il += record.total_il_usd
            total_tx_fees += record.total_tx_fees_usd

        # Sum from closed positions
        for record in self._state.position_history:
            total_fees += record.total_fees_earned_usd
            total_il += record.total_il_usd
            total_tx_fees += record.total_tx_fees_usd

        return {
            'session_id': self._state.session_id,
            'start_time': self._state.start_time.isoformat(),
            'end_time': self._state.end_time.isoformat() if self._state.end_time else None,
            'duration_hours': (
                (self._state.end_time or datetime.now(timezone.utc)) - self._state.start_time
            ).total_seconds() / 3600,

            # Wallet and capital tracking
            'initial_value_usd': float(self._state.initial_total_usd),
            'current_value_usd': float(self._state.current_total_usd) + float(total_open_value) + float(total_pending_fees),
            'current_wallet_value_usd': float(self._state.current_total_usd),
            'initial_wallet_usd': session_pnl_data['initial_wallet_usd'],
            'total_deployed_capital_usd': session_pnl_data['total_deployed_usd'],
            'currently_deployed_usd': session_pnl_data['open_entries_value_usd'],

            # Position values
            'open_positions_value_usd': session_pnl_data['open_positions_value_usd'],
            'closed_positions_entry_usd': session_pnl_data['closed_entries_value_usd'],

            # Session PnL (CORRECT calculation)
            'session_pnl_usd': session_pnl_data['session_pnl_usd'],
            'session_pnl_pct_deployed': session_pnl_data['session_pnl_pct_deployed'],
            'session_pnl_pct_initial': session_pnl_data['session_pnl_pct_initial'],
            'session_pnl_after_costs_usd': session_pnl_data['session_pnl_after_costs_usd'],
            'session_total_costs_usd': session_pnl_data['total_costs_usd'],

            # Realized vs Unrealized
            'realized_pnl_usd': session_pnl_data['realized_pnl_usd'],
            'realized_fees_usd': session_pnl_data['realized_fees_usd'],
            'unrealized_pnl_usd': session_pnl_data['unrealized_pnl_usd'],
            'pending_fees_usd': session_pnl_data['pending_fees_usd'],

            # Legacy fields (kept for backwards compatibility but DEPRECATED)
            'total_fees_earned_usd': float(total_fees),
            'total_il_usd': float(total_il),
            'total_tx_fees_usd': float(total_tx_fees),
            'net_pnl_usd': session_pnl_data['session_pnl_usd'],  # Use correct calculation
            'net_pnl_pct': session_pnl_data['session_pnl_pct_initial'],  # Use % of initial wallet

            # Position counts
            'positions_opened': self._state.total_positions_opened,
            'positions_closed': self._state.total_positions_closed,
            'positions_active': session_pnl_data['positions_active'],
            'total_rebalances': self._state.total_rebalances,
            'emergency_rebalances': self._state.total_emergency_rebalances,
        }

    def _save_session_state(self) -> None:
        """Save session state to JSON."""
        if not self._state:
            return

        state_path = self._output_dir / f"session_{self._state.session_id}_state.json"

        state_dict = {
            'session_id': self._state.session_id,
            'start_time': self._state.start_time.isoformat(),
            'end_time': self._state.end_time.isoformat() if self._state.end_time else None,
            'initial_balances': {
                'sol': float(self._state.initial_sol_balance),
                'usdc': float(self._state.initial_usdc_balance),
                'total_usd': float(self._state.initial_total_usd),
            },
            'final_balances': {
                'sol': float(self._state.current_sol_balance),
                'usdc': float(self._state.current_usdc_balance),
                'total_usd': float(self._state.current_total_usd),
            },
            'positions': [p.to_dict() for p in self._state.position_history],
            'rebalances': [r.to_dict() for r in self._state.rebalances],
            'swaps': [s.to_dict() for s in self._state.swaps],
            'wsol_cleanups': [w.to_dict() for w in self._state.wsol_cleanups],
            'totals': {
                'swaps': self._state.total_swaps,
                'swap_fees_sol': float(self._state.total_swap_fees_sol),
                'wsol_cleanups': self._state.total_wsol_cleanups,
                'wsol_recovered_sol': float(self._state.total_wsol_recovered),
            },
            'summary': self.get_session_summary(self._state.current_total_usd),
        }

        with open(state_path, 'w') as f:
            json.dump(state_dict, f, indent=2)

        logger.info(f"Session state saved: {state_path}")


# Module-level instance
_manager: Optional[SessionManager] = None


def get_session_manager() -> SessionManager:
    """Get or create global session manager."""
    global _manager
    if _manager is None:
        _manager = SessionManager()
    return _manager
