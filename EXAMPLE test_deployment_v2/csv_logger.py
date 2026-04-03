"""
CSV Logger Module for LP Strategy v2.

Provides structured CSV logging in the format specified for performance tracking:

1. LP Management Sheet - Tracks position lifecycle:
   - Entry/exit data
   - Range configuration
   - Token ratios
   - PnL calculations
   - Execution efficiency metrics

2. Asset and Fees Management Sheet - Tracks all transactions:
   - Token swaps (Asset type)
   - Fee collections (Fee type)
   - Transaction links

3. Pool State History Sheet - Tracks pool state at every iteration:
   - Price from on-chain Orca pool (not Birdeye)
   - Liquidity
   - Tick data
   - Fee growth metrics
"""

import csv
import logging
from datetime import datetime, timezone
from dataclasses import dataclass, field
from typing import Optional, List
from decimal import Decimal
from pathlib import Path
import os

from config import get_config

logger = logging.getLogger(__name__)

# Solscan base URL for transaction links
SOLSCAN_TX_URL = "https://solscan.io/tx/"


def get_solscan_link(signature: Optional[str]) -> str:
    """Generate Solscan transaction link from signature."""
    if not signature:
        return ""
    return f"{SOLSCAN_TX_URL}{signature}"


@dataclass
class LPManagementRow:
    """
    Row for LP Management sheet.

    Tracks full position lifecycle from entry to exit with all performance metrics.
    """
    # === Position Index ===
    position_index: int = 0  # Progressive index (1, 2, 3...) per session

    # === Entry Data ===
    pair: str = "SOL/USDC"
    entry_date: str = ""  # YYYY-MM-DD
    entry_time: str = ""  # HH:MM:SS
    deposit_ratio: float = 0.0  # USDC_deposited / SOL_deposited (NOT market price)
    market_price_entry: float = 0.0  # On-chain pool price at entry
    market_price_exit: float = 0.0   # On-chain pool price at exit
    entry_tx_link: str = ""  # Solscan link

    # === Token Amounts at Entry ===
    sol_amount_entry: float = 0.0  # Amount of SOL deposited
    sol_value_entry: float = 0.0   # Mark to market value of SOL at entry ($)
    usdc_amount_entry: float = 0.0  # USDC volume at entry ($)
    total_value_entry: float = 0.0  # Total mark to market at entry ($)

    # === Range Configuration ===
    min_range_price: float = 0.0  # Lower bound price ($)
    max_range_price: float = 0.0  # Upper bound price ($)
    min_range_pct: float = 0.0    # Lower bound as % from entry price
    max_range_pct: float = 0.0    # Upper bound as % from entry price
    range_width_pct: float = 0.0  # Total range width %

    # === Token Ratios ===
    ratio_sol: float = 0.0  # SOL ratio (should be ~50%)
    ratio_usdc: float = 0.0  # USDC ratio (should be ~50%)

    # === Pool Metrics ===
    tvl: float = 0.0              # Pool TVL at entry (renamed from tvl_at_entry)
    tvl_at_exit: float = 0.0      # Pool TVL at exit (NEW)
    volume_24h: float = 0.0       # Pool 24h volume at entry (from API, for reference)
    volume_during_position: float = 0.0  # Volume calculated from fees collected (NEW)
    volume_tvl_ratio: float = 0.0  # volume_during_position / tvl_at_exit (or tvl if exit not available)

    # === Exit Data ===
    exit_date: str = ""  # YYYY-MM-DD
    exit_time: str = ""  # HH:MM:SS
    exit_tx_link: str = ""  # Solscan link
    duration_in_range: str = ""  # Time position was in range (HH:MM:SS or days)
    num_tx_per_day: float = 0.0  # Number of transactions per day

    # === Exit Amounts ===
    total_value_exit: float = 0.0  # Mark to market at exit ($)
    mark_to_market_pnl: float = 0.0  # Value change ($) = exit_value - entry_value

    # === Collected Fees ===
    fees_sol: float = 0.0       # Collected fees in SOL
    fees_sol_value: float = 0.0  # Collected fees SOL value ($)
    fees_usdc: float = 0.0      # Collected fees in USDC
    fees_total_value: float = 0.0  # Total collected fees ($)

    # === Total PnL ===
    total_pnl: float = 0.0  # mark_to_market_pnl + fees_total_value

    # === Impermanent Loss ===
    # IL compares LP value vs HODL value at exit price
    # HODL value = (sol_entry * exit_price) + usdc_entry
    # IL = LP_value - HODL_value (negative = loss due to IL)
    hodl_value_at_exit: float = 0.0  # What you'd have if you just held
    impermanent_loss_usd: float = 0.0  # IL in USD (negative = loss)
    impermanent_loss_pct: float = 0.0  # IL as percentage (negative = loss)

    # === Execution Efficiency ===
    execution_efficiency: str = ""  # Number of tx to open position (1 is best)
    rebalance_latency: str = ""     # Time between close and reopen

    # === Transaction Costs ===
    open_tx_fee_sol: float = 0.0    # Open transaction fee in SOL
    close_tx_fee_sol: float = 0.0   # Close transaction fee in SOL
    swap_tx_fee_sol: float = 0.0    # Swap transaction fee in SOL (if swap occurred)
    total_tx_fees_sol: float = 0.0  # Total transaction fees in SOL
    total_tx_fees_usd: float = 0.0  # Total transaction fees in USD
    actual_cost_usd: float = 0.0    # Actual cost from balance diff (captures slippage + fees + rent)
    actual_cost_close_usd: float = 0.0  # Close operation actual cost (balance diff)
    actual_cost_open_usd: float = 0.0   # Open operation actual cost (balance diff)
    actual_cost_swap_usd: float = 0.0   # Swap operation actual cost (balance diff, includes slippage)

    # === Close Reason ===
    close_reason: str = ""  # Trigger reason: out_of_range, ratio_skew_high, ratio_skew_low, upward_profit_capture, stop_loss, emergency, shutdown

    # === Internal tracking (not in CSV) ===
    position_address: str = ""
    is_closed: bool = False

    def to_csv_row(self) -> dict:
        """Convert to CSV row dictionary.

        Entry fields are always populated with actual values.
        Exit fields are empty until position is closed.
        """
        return {
            # Position index - first column
            'Position #': str(self.position_index) if self.position_index > 0 else "",
            # Entry fields - always populated
            'Pair': self.pair,
            'Entry date': self.entry_date,
            'Entry time': self.entry_time,
            'Deposit ratio': f"{self.deposit_ratio:.4f}",
            'Market price at entry': f"{self.market_price_entry:.4f}" if self.market_price_entry else "",
            'Market price at exit': f"{self.market_price_exit:.4f}" if self.market_price_exit else "",
            'Solscan transaction link (entry)': self.entry_tx_link,
            'Amount of SOL at entry (#)': f"{self.sol_amount_entry:.6f}",
            'SOL value at entry ($)': f"{self.sol_value_entry:.2f}",
            'USDC amount at entry ($)': f"{self.usdc_amount_entry:.2f}",
            'Total value at entry ($)': f"{self.total_value_entry:.2f}",
            'Min range price': f"{self.min_range_price:.4f}",
            'Max range price': f"{self.max_range_price:.4f}",
            'Min range %': f"{self.min_range_pct:.2f}%",
            'Max range %': f"{self.max_range_pct:.2f}%",
            'Range width %': f"{self.range_width_pct:.2f}%",
            'Ratio SOL': f"{self.ratio_sol:.1f}%",
            'Ratio USDC': f"{self.ratio_usdc:.1f}%",
            # TVL and Volume columns (updated structure)
            'TVL at entry': f"{self.tvl:.0f}" if self.tvl else "",
            'TVL at exit': f"{self.tvl_at_exit:.0f}" if self.tvl_at_exit else "",
            'Volume during position': f"{self.volume_during_position:.0f}" if self.volume_during_position else "",
            'Volume/TVL': f"{self.volume_tvl_ratio:.4f}" if self.volume_tvl_ratio else "",
            # Exit fields - only populated when closed
            'Exit date': self.exit_date,
            'Exit time': self.exit_time,
            'Solscan transaction link (exit)': self.exit_tx_link,
            'Duration in range': self.duration_in_range,
            'Num tx per day': f"{self.num_tx_per_day:.2f}" if self.num_tx_per_day else "",
            'Total value at exit ($)': f"{self.total_value_exit:.2f}" if self.total_value_exit else "",
            'Mark to market PnL ($)': f"{self.mark_to_market_pnl:.2f}" if self.mark_to_market_pnl != 0 else "",
            'Collected fees SOL': f"{self.fees_sol:.6f}" if self.fees_sol else "",
            'Collected fees SOL ($)': f"{self.fees_sol_value:.2f}" if self.fees_sol_value else "",
            'Collected fees USDC': f"{self.fees_usdc:.2f}" if self.fees_usdc else "",
            'Collected fees total ($)': f"{self.fees_total_value:.2f}" if self.fees_total_value else "",
            'Total PnL ($)': f"{self.total_pnl:.2f}" if self.total_pnl != 0 else "",
            # Impermanent Loss columns
            'HODL value at exit ($)': f"{self.hodl_value_at_exit:.2f}" if self.hodl_value_at_exit else "",
            'Impermanent Loss ($)': f"{self.impermanent_loss_usd:.2f}" if self.impermanent_loss_usd != 0 else "",
            'Impermanent Loss (%)': f"{self.impermanent_loss_pct:.2f}%" if self.impermanent_loss_pct != 0 else "",
            'Execution efficiency': self.execution_efficiency,
            'Rebalance latency': self.rebalance_latency,
            'Close reason': self.close_reason,
            # Transaction Costs
            'Open TX fee (SOL)': f"{self.open_tx_fee_sol:.9f}" if self.open_tx_fee_sol else "",
            'Close TX fee (SOL)': f"{self.close_tx_fee_sol:.9f}" if self.close_tx_fee_sol else "",
            'Swap TX fee (SOL)': f"{self.swap_tx_fee_sol:.9f}" if self.swap_tx_fee_sol else "",
            'Total TX fees (SOL)': f"{self.total_tx_fees_sol:.9f}" if self.total_tx_fees_sol else "",
            'Total TX fees ($)': f"{self.total_tx_fees_usd:.2f}" if self.total_tx_fees_usd else "",
            'Actual Cost ($)': f"{self.actual_cost_usd:.4f}" if self.actual_cost_usd else "",
            'Actual Cost Close ($)': f"{self.actual_cost_close_usd:.4f}" if self.actual_cost_close_usd else "",
            'Actual Cost Open ($)': f"{self.actual_cost_open_usd:.4f}" if self.actual_cost_open_usd else "",
            'Actual Cost Swap ($)': f"{self.actual_cost_swap_usd:.4f}" if self.actual_cost_swap_usd else "",
        }


@dataclass
class AssetFeeRow:
    """
    Row for Asset and Fees Management sheet.

    Tracks all transactions: swaps (Asset) and fee collections (Fee).
    """
    date: str = ""  # YYYY-MM-DD HH:MM:SS
    buy_sell: str = ""  # 'Buy' or 'Sell' (for SOL)
    sol: float = 0.0    # SOL amount (positive for buy, negative for sell)
    usdc: float = 0.0   # USDC amount (negative for buy SOL, positive for sell SOL)
    price: float = 0.0  # SOL price from LP (not external)
    tx_link: str = ""   # Solscan transaction link
    type: str = ""      # 'Asset' (swap) or 'Fee' (fee collection)

    def to_csv_row(self) -> dict:
        """Convert to CSV row dictionary."""
        return {
            'Date': self.date,
            'Buy/Sell': self.buy_sell,
            'SOL': f"{self.sol:.6f}" if self.sol else "",
            'USDC': f"{self.usdc:.2f}" if self.usdc else "",
            'Price': f"{self.price:.4f}" if self.price else "",
            'Transaction link': self.tx_link,
            'Type': self.type,
        }


@dataclass
class PoolStateRow:
    """
    Row for Pool State History sheet.

    Tracks on-chain pool state at every iteration.
    All data fetched directly from Orca Whirlpool (not Birdeye).
    """
    # Timestamp
    date: str = ""  # YYYY-MM-DD
    time: str = ""  # HH:MM:SS

    # Price data (from on-chain pool)
    price: float = 0.0  # SOL/USDC price derived from sqrt_price
    sqrt_price: int = 0  # Raw sqrt_price (Q64.64 format)

    # Tick data
    tick_current: int = 0  # Current tick index
    tick_spacing: int = 0  # Pool tick spacing

    # Liquidity
    liquidity: int = 0  # Current pool liquidity

    # Fee data
    fee_rate: int = 0  # Pool fee rate (basis points * 100)
    fee_growth_global_a: int = 0  # Cumulative fee growth for token A
    fee_growth_global_b: int = 0  # Cumulative fee growth for token B

    # Pool info
    pool_address: str = ""  # Pool address (truncated)

    def to_csv_row(self) -> dict:
        """Convert to CSV row dictionary."""
        return {
            'Date': self.date,
            'Time': self.time,
            'Price (USD)': f"{self.price:.4f}" if self.price else "",
            'Sqrt Price': str(self.sqrt_price),
            'Tick Current': str(self.tick_current),
            'Tick Spacing': str(self.tick_spacing),
            'Liquidity': str(self.liquidity),
            'Fee Rate (bps)': f"{self.fee_rate / 100:.2f}" if self.fee_rate else "",
            'Fee Growth A': str(self.fee_growth_global_a),
            'Fee Growth B': str(self.fee_growth_global_b),
            'Pool Address': self.pool_address,
        }


class CSVLogger:
    """
    CSV Logger for LP Strategy performance tracking.

    Creates three CSV files:
    - lp_management.csv: Position lifecycle tracking
    - asset_fees_management.csv: Transaction tracking
    - pool_state_history.csv: On-chain pool state at every iteration
    """

    # Column headers for LP Management sheet (45 columns)
    LP_COLUMNS = [
        'Position #',  # NEW: First column - progressive index (1, 2, 3...)
        'Pair',
        'Entry date',
        'Entry time',
        'Deposit ratio',
        'Market price at entry',
        'Market price at exit',
        'Solscan transaction link (entry)',
        'Amount of SOL at entry (#)',
        'SOL value at entry ($)',
        'USDC amount at entry ($)',
        'Total value at entry ($)',
        'Min range price',
        'Max range price',
        'Min range %',
        'Max range %',
        'Range width %',
        'Ratio SOL',
        'Ratio USDC',
        'TVL at entry',  # RENAMED from 'TVL'
        'TVL at exit',  # NEW: TVL when position closed
        'Volume during position',  # NEW: Calculated from fees
        'Volume/TVL',  # MODIFIED: Uses volume_during_position / tvl_at_exit
        'Exit date',
        'Exit time',
        'Solscan transaction link (exit)',
        'Duration in range',
        'Num tx per day',
        'Total value at exit ($)',
        'Mark to market PnL ($)',
        'Collected fees SOL',
        'Collected fees SOL ($)',
        'Collected fees USDC',
        'Collected fees total ($)',
        'Total PnL ($)',
        'HODL value at exit ($)',
        'Impermanent Loss ($)',
        'Impermanent Loss (%)',
        'Execution efficiency',
        'Rebalance latency',
        'Close reason',
        'Open TX fee (SOL)',
        'Close TX fee (SOL)',
        'Swap TX fee (SOL)',
        'Total TX fees (SOL)',
        'Total TX fees ($)',
        'Actual Cost ($)',  # Actual cost from balance diff (slippage + fees + rent)
        'Actual Cost Close ($)',
        'Actual Cost Open ($)',
        'Actual Cost Swap ($)',
    ]

    # Column headers for Asset and Fees Management sheet
    ASSET_FEE_COLUMNS = [
        'Date',
        'Buy/Sell',
        'SOL',
        'USDC',
        'Price',
        'Transaction link',
        'Type',
    ]

    # Column headers for Pool State History sheet
    POOL_STATE_COLUMNS = [
        'Date',
        'Time',
        'Price (USD)',
        'Sqrt Price',
        'Tick Current',
        'Tick Spacing',
        'Liquidity',
        'Fee Rate (bps)',
        'Fee Growth A',
        'Fee Growth B',
        'Pool Address',
    ]

    def __init__(self, output_dir: Optional[str] = None):
        """
        Initialize CSV Logger.

        Args:
            output_dir: Directory to store CSV files. Defaults to config.session.data_dir
        """
        config = get_config()
        self._output_dir = Path(output_dir or config.session.data_dir)
        self._output_dir.mkdir(parents=True, exist_ok=True)

        # File paths
        self._lp_file_path = self._output_dir / "lp_management.csv"
        self._asset_fee_file_path = self._output_dir / "asset_fees_management.csv"
        self._pool_state_file_path = self._output_dir / "pool_state_history.csv"

        # In-memory tracking of current position data
        self._current_position: Optional[LPManagementRow] = None
        self._position_open_time: Optional[datetime] = None
        self._position_tx_count: int = 0

        # Initialize CSV files with headers if they don't exist
        self._init_csv_files()

        logger.info(f"CSVLogger initialized. Output directory: {self._output_dir}")

    def _init_csv_files(self):
        """Initialize CSV files with headers, resetting them for each new session."""
        # LP Management CSV - always reset on new session
        with open(self._lp_file_path, 'w', newline='') as f:
            writer = csv.DictWriter(f, fieldnames=self.LP_COLUMNS)
            writer.writeheader()
        logger.info(f"Reset LP Management CSV: {self._lp_file_path}")

        # Asset and Fees Management CSV - always reset on new session
        with open(self._asset_fee_file_path, 'w', newline='') as f:
            writer = csv.DictWriter(f, fieldnames=self.ASSET_FEE_COLUMNS)
            writer.writeheader()
        logger.info(f"Reset Asset/Fees Management CSV: {self._asset_fee_file_path}")

        # Pool State History CSV - always reset on new session
        with open(self._pool_state_file_path, 'w', newline='') as f:
            writer = csv.DictWriter(f, fieldnames=self.POOL_STATE_COLUMNS)
            writer.writeheader()
        logger.info(f"Reset Pool State History CSV: {self._pool_state_file_path}")

    def log_position_open(
        self,
        position_address: str,
        entry_price: float,
        sol_amount: float,
        usdc_amount: float,
        lower_price: float,
        upper_price: float,
        tx_signature: str,
        open_attempts: int = 1,
        tvl: float = 0.0,
        volume_24h: float = 0.0,
        position_index: int = 0,  # NEW: Progressive position index (1, 2, 3...)
        open_tx_fee_sol: float = 0.0,  # NEW: Open transaction fee in SOL
        swap_tx_fee_sol: float = 0.0,  # NEW: Swap transaction fee in SOL (if swap occurred during open)
        actual_cost_usd: float = 0.0,  # Actual cost from balance diff
        actual_cost_open_usd: float = 0.0,  # Open operation actual cost (balance diff)
        actual_cost_swap_usd: float = 0.0,  # Swap operation actual cost (balance diff)
        market_price: float = 0.0,  # Market price at entry (for value columns)
    ):
        """
        Log position open event.

        Called when a new position is successfully opened.
        NOTE: Does NOT write to CSV immediately - row is written only on position close
        to avoid duplicate rows. Position data is stored internally.

        entry_price = deposit ratio (deposited_usdc / deposited_sol) — kept for PnL tracking.
        market_price = current market price — used for sol_value_entry and total_value_entry
        to be consistent with how exit values are computed (at market price).
        """
        now = datetime.now(timezone.utc)

        # Use market price for value columns (consistent with exit-side calculations)
        # Fall back to entry_price if market_price not provided
        value_price = market_price if market_price > 0 else entry_price

        # Calculate values at market price
        sol_value = sol_amount * value_price
        total_value = sol_value + usdc_amount

        # Calculate ratios
        ratio_sol = (sol_value / total_value * 100) if total_value > 0 else 0
        ratio_usdc = (usdc_amount / total_value * 100) if total_value > 0 else 0

        # Calculate range percentages from market price (not deposit ratio)
        min_range_pct = ((lower_price - value_price) / value_price * 100) if value_price > 0 else 0
        max_range_pct = ((upper_price - value_price) / value_price * 100) if value_price > 0 else 0
        range_width_pct = max_range_pct - min_range_pct

        # Volume/TVL ratio (at entry, using API data if available)
        vol_tvl = (volume_24h / tvl) if tvl > 0 else 0

        # Create position record with position index
        self._current_position = LPManagementRow(
            position_index=position_index,  # NEW: Store position index
            pair="SOL/USDC",
            entry_date=now.strftime("%Y-%m-%d"),
            entry_time=now.strftime("%H:%M:%S"),
            deposit_ratio=entry_price,
            market_price_entry=value_price,
            entry_tx_link=get_solscan_link(tx_signature),
            sol_amount_entry=sol_amount,
            sol_value_entry=sol_value,
            usdc_amount_entry=usdc_amount,
            total_value_entry=total_value,
            min_range_price=lower_price,
            max_range_price=upper_price,
            min_range_pct=min_range_pct,
            max_range_pct=max_range_pct,
            range_width_pct=range_width_pct,
            ratio_sol=ratio_sol,
            ratio_usdc=ratio_usdc,
            tvl=tvl,
            volume_24h=volume_24h,
            volume_tvl_ratio=vol_tvl,  # Will be recalculated on close using actual volume
            execution_efficiency=f"{open_attempts} tx",
            position_address=position_address,
            is_closed=False,
            open_tx_fee_sol=open_tx_fee_sol,
            swap_tx_fee_sol=swap_tx_fee_sol,
            actual_cost_usd=actual_cost_usd,
            actual_cost_open_usd=actual_cost_open_usd,
            actual_cost_swap_usd=actual_cost_swap_usd,
        )

        self._position_open_time = now
        self._position_tx_count = open_attempts

        # NOTE: DO NOT write to CSV here - row will be written only on position close
        # This prevents duplicate rows (one at open, one at close)

        # Log to console for visibility
        logger.info(f"=" * 50)
        logger.info(f"CSV: Position #{position_index} opened - {position_address[:16]}...")
        logger.info(f"  Market price: ${value_price:.2f}, Deposit ratio: ${entry_price:.2f}")
        logger.info(f"  SOL: {sol_amount:.4f}, USDC: ${usdc_amount:.2f}")
        logger.info(f"  Range: ${lower_price:.2f} - ${upper_price:.2f}")
        logger.info(f"  Ratio: {ratio_sol:.1f}% SOL / {ratio_usdc:.1f}% USDC")
        logger.info(f"  TVL at entry: ${tvl:,.0f}" if tvl else "  TVL at entry: N/A")
        # ===== TX COST VERIFICATION LOGGING =====
        if open_tx_fee_sol > 0 or swap_tx_fee_sol > 0 or actual_cost_usd > 0:
            logger.info(f"  TX Costs captured:")
            logger.info(f"    Open TX fee (RPC): {open_tx_fee_sol:.9f} SOL (${open_tx_fee_sol * value_price:.4f})")
            if swap_tx_fee_sol > 0:
                logger.info(f"    Swap TX fee (RPC): {swap_tx_fee_sol:.9f} SOL (${swap_tx_fee_sol * value_price:.4f})")
            if actual_cost_usd > 0:
                logger.info(f"    Actual Cost: ${actual_cost_usd:.4f} (balance-based)")
        logger.info(f"  CSV row will be written on position close")
        logger.info(f"=" * 50)

    def log_position_close(
        self,
        position_address: str,
        exit_price: float,
        sol_withdrawn: float,
        usdc_withdrawn: float,
        fees_sol: float,
        fees_usdc: float,
        tx_signature: str,
        rebalance_latency_seconds: float = 0.0,
        fee_tier: float = 0.0004,  # Pool fee tier (0.0004 = 0.04%, 0.003 = 0.30%)
        tvl_at_exit: float = 0.0,  # Pool TVL at exit for Volume/TVL calculation
        close_tx_fee_sol: float = 0.0,  # Close transaction fee in SOL
        close_reason: str = "",  # Trigger reason: out_of_range, ratio_skew_high, ratio_skew_low, upward_profit_capture, stop_loss, emergency, shutdown
        actual_cost_close_usd: float = 0.0,  # Close operation actual cost (balance diff)
    ):
        """
        Log position close event and write completed row to CSV.

        Called when a position is closed (either final close or rebalance).

        Args:
            position_address: Address of the position being closed
            exit_price: Current SOL price at exit
            sol_withdrawn: SOL amount withdrawn (excluding fees)
            usdc_withdrawn: USDC amount withdrawn (excluding fees)
            fees_sol: SOL fees collected
            fees_usdc: USDC fees collected
            tx_signature: Transaction signature for the close
            rebalance_latency_seconds: Time since last rebalance (if applicable)
            fee_tier: Pool fee tier as decimal (e.g., 0.0004 for 0.04%)
            tvl_at_exit: Pool TVL at exit in USD (for Volume/TVL calculation)
            close_tx_fee_sol: Close transaction fee in SOL
            close_reason: Trigger reason for the close (out_of_range, ratio_skew_high,
                ratio_skew_low, upward_profit_capture, stop_loss, emergency, shutdown)
        """
        now = datetime.now(timezone.utc)

        if not self._current_position:
            logger.warning(f"CSV: Position close logged but no open position tracked")
            # Create a minimal record
            self._current_position = LPManagementRow(
                pair="SOL/USDC",
                position_address=position_address,
            )

        # Calculate exit values
        fees_sol_value = fees_sol * exit_price
        fees_total = fees_sol_value + fees_usdc
        total_value_exit = (sol_withdrawn * exit_price) + usdc_withdrawn + fees_total

        # Mark to market PnL (excludes fees, just position value change)
        position_value_exit = (sol_withdrawn * exit_price) + usdc_withdrawn
        mark_to_market_pnl = position_value_exit - self._current_position.total_value_entry

        # Total PnL including fees
        total_pnl = mark_to_market_pnl + fees_total

        # === NEW: Calculate Volume from Fees ===
        # Volume = Fees / Fee Tier
        # This gives us the actual trading volume that generated our fees
        volume_during_position = 0.0
        if fee_tier > 0:
            # Calculate volume for each token
            volume_sol = fees_sol / fee_tier if fees_sol > 0 else 0.0
            volume_usdc = fees_usdc / fee_tier if fees_usdc > 0 else 0.0
            # Total volume in USD
            volume_during_position = (volume_sol * exit_price) + volume_usdc
            logger.info(f"  Volume calculation: fees_sol={fees_sol:.6f}, fees_usdc={fees_usdc:.2f}, fee_tier={fee_tier:.6f}")
            logger.info(f"    => volume_sol={volume_sol:.2f} SOL, volume_usdc=${volume_usdc:.2f}, total_volume=${volume_during_position:.2f}")

        # Calculate Volume/TVL ratio using actual volume during position
        volume_tvl_ratio = 0.0
        if tvl_at_exit > 0:
            volume_tvl_ratio = volume_during_position / tvl_at_exit
        elif self._current_position.tvl > 0:
            # Fallback to TVL at entry if exit TVL not available
            volume_tvl_ratio = volume_during_position / self._current_position.tvl

        # Calculate Impermanent Loss
        # HODL value = what you'd have if you just held the original tokens
        # HODL value at exit = (SOL entry amount * exit price) + USDC entry amount
        # IL = LP value at exit (excl. fees) - HODL value
        # Negative IL = loss due to providing liquidity vs holding
        hodl_value_at_exit = (self._current_position.sol_amount_entry * exit_price) + self._current_position.usdc_amount_entry
        impermanent_loss_usd = position_value_exit - hodl_value_at_exit
        impermanent_loss_pct = (impermanent_loss_usd / hodl_value_at_exit * 100) if hodl_value_at_exit > 0 else 0.0

        # Calculate duration
        duration = ""
        num_tx_per_day = 0.0
        if self._position_open_time:
            duration_delta = now - self._position_open_time
            duration_seconds = duration_delta.total_seconds()

            if duration_seconds < 3600:
                duration = f"{int(duration_seconds // 60)}m {int(duration_seconds % 60)}s"
            elif duration_seconds < 86400:
                hours = int(duration_seconds // 3600)
                minutes = int((duration_seconds % 3600) // 60)
                duration = f"{hours}h {minutes}m"
            else:
                days = duration_seconds / 86400
                duration = f"{days:.2f} days"

            # Transactions per day
            if duration_seconds > 0:
                days_elapsed = duration_seconds / 86400
                if days_elapsed > 0:
                    num_tx_per_day = self._position_tx_count / days_elapsed

        # Format rebalance latency
        rebalance_latency = ""
        if rebalance_latency_seconds > 0:
            if rebalance_latency_seconds < 60:
                rebalance_latency = f"{rebalance_latency_seconds:.1f}s"
            else:
                rebalance_latency = f"{rebalance_latency_seconds / 60:.1f}m"

        # Update position record with exit data
        self._current_position.exit_date = now.strftime("%Y-%m-%d")
        self._current_position.exit_time = now.strftime("%H:%M:%S")
        self._current_position.exit_tx_link = get_solscan_link(tx_signature)
        self._current_position.duration_in_range = duration
        self._current_position.num_tx_per_day = num_tx_per_day
        self._current_position.total_value_exit = total_value_exit
        self._current_position.mark_to_market_pnl = mark_to_market_pnl
        self._current_position.fees_sol = fees_sol
        self._current_position.fees_sol_value = fees_sol_value
        self._current_position.fees_usdc = fees_usdc
        self._current_position.fees_total_value = fees_total
        self._current_position.total_pnl = total_pnl
        self._current_position.hodl_value_at_exit = hodl_value_at_exit
        self._current_position.impermanent_loss_usd = impermanent_loss_usd
        self._current_position.impermanent_loss_pct = impermanent_loss_pct
        self._current_position.rebalance_latency = rebalance_latency
        self._current_position.close_reason = close_reason
        self._current_position.market_price_exit = exit_price
        self._current_position.is_closed = True

        # NEW: Update TVL and volume fields
        self._current_position.tvl_at_exit = tvl_at_exit
        self._current_position.volume_during_position = volume_during_position
        self._current_position.volume_tvl_ratio = volume_tvl_ratio

        # NEW: Update transaction cost fields
        self._current_position.close_tx_fee_sol = close_tx_fee_sol
        self._current_position.actual_cost_close_usd = actual_cost_close_usd
        # Calculate total transaction fees (open + close + swap)
        self._current_position.total_tx_fees_sol = (
            self._current_position.open_tx_fee_sol +
            self._current_position.close_tx_fee_sol +
            self._current_position.swap_tx_fee_sol
        )
        self._current_position.total_tx_fees_usd = self._current_position.total_tx_fees_sol * exit_price

        # Write to CSV (ONLY place where LP row is written - prevents duplicates)
        self._write_lp_row(self._current_position)

        # Enhanced logging for position close
        logger.info(f"=" * 50)
        logger.info(f"CSV: Position #{self._current_position.position_index} closed - {position_address[:16]}...")
        logger.info(f"  Close reason: {close_reason}" if close_reason else "  Close reason: (not specified)")
        logger.info(f"  Exit: ${exit_price:.2f}, Duration: {duration}")
        logger.info(f"  PnL: ${total_pnl:.2f} (M2M: ${mark_to_market_pnl:.2f} + Fees: ${fees_total:.2f})")
        logger.info(f"  Transaction Costs:")
        logger.info(f"    Open:  {self._current_position.open_tx_fee_sol:.9f} SOL (${self._current_position.open_tx_fee_sol * exit_price:.4f})")
        logger.info(f"    Close: {self._current_position.close_tx_fee_sol:.9f} SOL (${self._current_position.close_tx_fee_sol * exit_price:.4f})")
        if self._current_position.swap_tx_fee_sol > 0:
            logger.info(f"    Swap:  {self._current_position.swap_tx_fee_sol:.9f} SOL (${self._current_position.swap_tx_fee_sol * exit_price:.4f})")
        logger.info(f"    TOTAL: {self._current_position.total_tx_fees_sol:.9f} SOL (${self._current_position.total_tx_fees_usd:.4f})")
        # Log actual costs from balance diffs (if available)
        if hasattr(self._current_position, 'actual_cost_open_usd') and self._current_position.actual_cost_open_usd > 0:
            logger.info(f"  Actual Costs (balance-based):")
            logger.info(f"    Open:  ${self._current_position.actual_cost_open_usd:.4f}")
        if hasattr(self._current_position, 'actual_cost_close_usd'):
            logger.info(f"    Close: ${self._current_position.actual_cost_close_usd:.4f}")
        if hasattr(self._current_position, 'actual_cost_swap_usd') and self._current_position.actual_cost_swap_usd > 0:
            logger.info(f"    Swap:  ${self._current_position.actual_cost_swap_usd:.4f}")
        logger.info(f"  IL: ${impermanent_loss_usd:.2f} ({impermanent_loss_pct:.2f}%) vs HODL ${hodl_value_at_exit:.2f}")
        logger.info(f"  Volume during position: ${volume_during_position:,.0f}")
        logger.info(f"  TVL at exit: ${tvl_at_exit:,.0f}" if tvl_at_exit else "  TVL at exit: N/A")
        logger.info(f"  Volume/TVL ratio: {volume_tvl_ratio:.4f}")
        logger.info(f"  CSV row written successfully")
        logger.info(f"=" * 50)

        # Clear current position
        self._current_position = None
        self._position_open_time = None
        self._position_tx_count = 0

    def log_swap(
        self,
        direction: str,  # 'buy_sol' or 'sell_sol'
        sol_amount: float,
        usdc_amount: float,
        price: float,
        tx_signature: str,
    ):
        """
        Log a token swap (Asset type transaction).

        Args:
            direction: 'buy_sol' (buy SOL with USDC) or 'sell_sol' (sell SOL for USDC)
            sol_amount: Amount of SOL involved (always positive)
            usdc_amount: Amount of USDC involved (always positive)
            price: SOL price at time of swap (fallback, used if execution price can't be calculated)
            tx_signature: Transaction signature
        """
        now = datetime.now(timezone.utc)

        # Calculate actual execution price from swap amounts
        # This is more accurate than using market price
        if sol_amount > 0:
            execution_price = usdc_amount / sol_amount
        else:
            execution_price = price  # Fallback to market price

        # Determine buy/sell direction
        if direction == 'buy_sol':
            buy_sell = 'Buy'
            sol_signed = sol_amount  # Received SOL
            usdc_signed = -usdc_amount  # Spent USDC
        else:  # sell_sol
            buy_sell = 'Sell'
            sol_signed = -sol_amount  # Spent SOL
            usdc_signed = usdc_amount  # Received USDC

        row = AssetFeeRow(
            date=now.strftime("%Y-%m-%d %H:%M:%S"),
            buy_sell=buy_sell,
            sol=sol_signed,
            usdc=usdc_signed,
            price=execution_price,
            tx_link=get_solscan_link(tx_signature),
            type="Asset",
        )

        self._write_asset_fee_row(row)
        self._position_tx_count += 1

        logger.info(f"CSV: Logged swap - {buy_sell} {sol_amount:.4f} SOL @ ${execution_price:.4f} (market: ${price:.2f})")

    def log_fee_collection(
        self,
        fees_sol: float,
        fees_usdc: float,
        price: float,
        tx_signature: str,
    ):
        """
        Log fee collection (Fee type transaction).

        Args:
            fees_sol: SOL fees collected
            fees_usdc: USDC fees collected
            price: SOL price at time of collection (from LP)
            tx_signature: Transaction signature
        """
        now = datetime.now(timezone.utc)

        # Only log if there are actual fees
        if fees_sol <= 0 and fees_usdc <= 0:
            return

        row = AssetFeeRow(
            date=now.strftime("%Y-%m-%d %H:%M:%S"),
            buy_sell="",  # Not applicable for fee collection
            sol=fees_sol,
            usdc=fees_usdc,
            price=price,
            tx_link=get_solscan_link(tx_signature),
            type="Fee",
        )

        self._write_asset_fee_row(row)

        fees_total = (fees_sol * price) + fees_usdc
        logger.info(f"CSV: Logged fee collection - {fees_sol:.6f} SOL + ${fees_usdc:.2f} USDC = ${fees_total:.2f}")

    def log_pool_state(
        self,
        price: float,
        sqrt_price: int,
        tick_current: int,
        tick_spacing: int,
        liquidity: int,
        fee_rate: int = 0,
        fee_growth_global_a: int = 0,
        fee_growth_global_b: int = 0,
        pool_address: str = "",
    ):
        """
        Log pool state at current iteration.

        All data should come directly from Orca Whirlpool on-chain data (not Birdeye).

        Args:
            price: SOL/USDC price derived from sqrt_price
            sqrt_price: Raw sqrt_price from pool (Q64.64 format)
            tick_current: Current tick index
            tick_spacing: Pool tick spacing
            liquidity: Current pool liquidity
            fee_rate: Pool fee rate (basis points * 100)
            fee_growth_global_a: Cumulative fee growth for token A (SOL)
            fee_growth_global_b: Cumulative fee growth for token B (USDC)
            pool_address: Pool address
        """
        now = datetime.now(timezone.utc)

        row = PoolStateRow(
            date=now.strftime("%Y-%m-%d"),
            time=now.strftime("%H:%M:%S"),
            price=price,
            sqrt_price=sqrt_price,
            tick_current=tick_current,
            tick_spacing=tick_spacing,
            liquidity=liquidity,
            fee_rate=fee_rate,
            fee_growth_global_a=fee_growth_global_a,
            fee_growth_global_b=fee_growth_global_b,
            pool_address=pool_address[:16] + "..." if len(pool_address) > 16 else pool_address,
        )

        self._write_pool_state_row(row)

    def _write_lp_row(self, row: LPManagementRow):
        """Write a row to LP Management CSV."""
        try:
            import os
            with open(self._lp_file_path, 'a', newline='') as f:
                writer = csv.DictWriter(f, fieldnames=self.LP_COLUMNS)
                writer.writerow(row.to_csv_row())
                f.flush()  # Flush Python buffer
                os.fsync(f.fileno())  # CRITICAL: Force sync to disk before email reads file
            logger.debug(f"CSV row written and synced: {self._lp_file_path}")
        except Exception as e:
            logger.error(f"CSV: Failed to write LP row: {e}")

    def _write_asset_fee_row(self, row: AssetFeeRow):
        """Write a row to Asset/Fees Management CSV."""
        try:
            with open(self._asset_fee_file_path, 'a', newline='') as f:
                writer = csv.DictWriter(f, fieldnames=self.ASSET_FEE_COLUMNS)
                writer.writerow(row.to_csv_row())
                f.flush()  # FIXED: Explicit flush to ensure data is written before email attachment
        except Exception as e:
            logger.error(f"CSV: Failed to write Asset/Fee row: {e}")

    def _write_pool_state_row(self, row: PoolStateRow):
        """Write a row to Pool State History CSV."""
        try:
            with open(self._pool_state_file_path, 'a', newline='') as f:
                writer = csv.DictWriter(f, fieldnames=self.POOL_STATE_COLUMNS)
                writer.writerow(row.to_csv_row())
                f.flush()  # FIXED: Explicit flush to ensure data is written before email attachment
        except Exception as e:
            logger.error(f"CSV: Failed to write Pool State row: {e}")

    def increment_tx_count(self):
        """Increment transaction count for current position."""
        self._position_tx_count += 1

    def get_current_position(self) -> Optional[LPManagementRow]:
        """Get current open position data (if any)."""
        return self._current_position


# Global CSV logger instance
_csv_logger: Optional[CSVLogger] = None


def get_csv_logger() -> CSVLogger:
    """Get or create global CSV logger instance."""
    global _csv_logger
    if _csv_logger is None:
        _csv_logger = CSVLogger()
    return _csv_logger


def reset_csv_logger():
    """Reset global CSV logger instance (for testing)."""
    global _csv_logger
    _csv_logger = None


# =============================================================================
# MULTI-USER CSV LOGGER MANAGEMENT
# =============================================================================

# Cache of user-specific CSV loggers
_user_csv_loggers: dict = {}


def get_user_csv_logger(user_id: int, base_data_dir: str = "/data") -> CSVLogger:
    """
    Get or create a CSV logger for a specific user.

    Each user gets their own CSV files in a user-specific directory:
    {base_data_dir}/users/{user_id}/

    Args:
        user_id: The user's database ID
        base_data_dir: Base data directory (default: /data)

    Returns:
        CSVLogger: User-specific CSV logger instance
    """
    global _user_csv_loggers

    if user_id not in _user_csv_loggers:
        user_data_dir = Path(base_data_dir) / "users" / str(user_id)
        _user_csv_loggers[user_id] = CSVLogger(output_dir=str(user_data_dir))
        logger.info(f"Created CSV logger for user {user_id}: {user_data_dir}")

    return _user_csv_loggers[user_id]


def remove_user_csv_logger(user_id: int) -> None:
    """
    Remove a user's CSV logger from cache.

    Call this when a user's session ends to free memory.

    Args:
        user_id: The user's database ID
    """
    global _user_csv_loggers

    if user_id in _user_csv_loggers:
        del _user_csv_loggers[user_id]
        logger.info(f"Removed CSV logger for user {user_id}")


def reset_all_user_csv_loggers() -> None:
    """Reset all user CSV loggers (for testing)."""
    global _user_csv_loggers
    _user_csv_loggers.clear()
