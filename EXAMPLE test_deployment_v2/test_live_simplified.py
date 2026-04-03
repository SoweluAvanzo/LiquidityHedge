#!/usr/bin/env python3
"""
Live Test for Simplified ATR/Range Flow.

This test opens a REAL position on mainnet to verify:
1. The simplified flow works correctly
2. range_width_pct is passed correctly to execution
3. Position opens with price IN RANGE
4. No TokenMaxExceeded or other errors occur

IMPORTANT: This uses REAL funds! Run only after unit/integration tests pass.

Usage:
    python test_live_simplified.py --open     # Open a test position
    python test_live_simplified.py --close    # Close existing position
    python test_live_simplified.py --check    # Just check current state
"""

import asyncio
import argparse
import logging
import sys
import os
from datetime import datetime, timezone
from decimal import Decimal

# Load environment
from dotenv import load_dotenv
load_dotenv()

# Add test_deployment_v2 to path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from config import get_config, reset_config
from market_analyzer import MarketAnalyzer
from execution import (
    get_trade_executor,
    calculate_safe_tick_range_from_sqrt_price,
    tick_to_price,
    tick_to_sqrt_price,
)

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


async def check_current_state():
    """Check current wallet and pool state."""
    logger.info("=" * 60)
    logger.info("CHECKING CURRENT STATE")
    logger.info("=" * 60)

    reset_config()
    config = get_config()
    executor = await get_trade_executor()

    # Get balances
    sol, usdc = await executor.get_balances()
    logger.info(f"Wallet balances: {sol:.4f} SOL, ${usdc:.2f} USDC")

    # Get pool state
    pool_state = await executor.get_pool_state()
    logger.info(f"Pool: {config.pool.pool_address}")
    logger.info(f"Current price: ${pool_state.current_price:.4f}")
    logger.info(f"Tick spacing: {pool_state.tick_spacing}")
    logger.info(f"Current tick: {pool_state.tick_current_index}")

    return executor, pool_state, sol, usdc


async def open_test_position():
    """
    Open a test position using the simplified flow.

    This tests the full flow:
    1. MarketAnalyzer calculates clamped_range
    2. range_width_pct is passed to execution
    3. Execution calculates ticks from fresh sqrt_price
    4. Position opens successfully
    """
    logger.info("=" * 60)
    logger.info("OPENING TEST POSITION (SIMPLIFIED FLOW)")
    logger.info("=" * 60)

    executor, pool_state, sol_balance, usdc_balance = await check_current_state()

    # Safety checks
    MIN_SOL_RESERVE = 0.05  # Keep some SOL for fees
    if sol_balance < MIN_SOL_RESERVE + 0.02:
        logger.error(f"Insufficient SOL: {sol_balance:.4f} < {MIN_SOL_RESERVE + 0.02}")
        return False

    if usdc_balance < 5:
        logger.error(f"Insufficient USDC: ${usdc_balance:.2f} < $5")
        return False

    # Calculate range using MarketAnalyzer (simulating ATR)
    reset_config()
    config = get_config()
    analyzer = MarketAnalyzer(config)

    # Simulate an ATR value (in production this comes from Birdeye OHLCV)
    analyzer._current_atr = 0.06  # 6% ATR

    # Calculate range targets
    price = pool_state.current_price
    raw_range, clamped_range, lower_target, upper_target = analyzer.calculate_range_targets(price)

    logger.info(f"\nSTEP 1: MarketAnalyzer calculated:")
    logger.info(f"  ATR: {analyzer._current_atr*100:.2f}%")
    logger.info(f"  K coefficient: {config.range.k_coefficient}")
    logger.info(f"  Raw range: {raw_range*100:.2f}%")
    logger.info(f"  Clamped range: {clamped_range*100:.2f}%")
    logger.info(f"  Display targets: ${lower_target:.4f} - ${upper_target:.4f}")

    # SIMPLIFIED FLOW: Pass range_width_pct directly
    range_width_pct = clamped_range

    logger.info(f"\nSTEP 2: Passing range_width_pct = {range_width_pct*100:.2f}% to execution")

    # Calculate amounts to use (use 80% of available, keep reserve)
    available_sol = sol_balance - MIN_SOL_RESERVE
    max_sol = min(available_sol * 0.8, config.capital.max_sol_per_position)
    max_usdc = min(usdc_balance * 0.8, config.capital.max_usdc_per_position)

    # Calculate liquidity (simplified)
    total_value = (max_sol * price) + max_usdc
    liquidity = int(total_value * 1e6)

    logger.info(f"\nSTEP 3: Opening position with:")
    logger.info(f"  Range width: {range_width_pct*100:.2f}%")
    logger.info(f"  Max SOL: {max_sol:.4f}")
    logger.info(f"  Max USDC: ${max_usdc:.2f}")
    logger.info(f"  Target liquidity: {liquidity}")

    # Preview the tick calculation
    lower_tick, upper_tick = calculate_safe_tick_range_from_sqrt_price(
        sqrt_price_current=pool_state.sqrt_price,
        tick_spacing=pool_state.tick_spacing,
        range_width_pct=range_width_pct,
    )
    lower_price = tick_to_price(lower_tick)
    upper_price = tick_to_price(upper_tick)

    logger.info(f"\n  Expected ticks: [{lower_tick}, {upper_tick}]")
    logger.info(f"  Expected range: ${lower_price:.4f} - ${upper_price:.4f}")

    # Verify price is in range
    sqrt_lower = tick_to_sqrt_price(lower_tick)
    sqrt_upper = tick_to_sqrt_price(upper_tick)
    if not (sqrt_lower < pool_state.sqrt_price < sqrt_upper):
        logger.error("CRITICAL: Price would be OUT OF RANGE! Aborting.")
        return False
    logger.info(f"  ✓ Price ${price:.4f} is IN RANGE")

    # Execute the position open using the SIMPLIFIED API
    logger.info(f"\nSTEP 4: Executing open_position_with_rebalance...")
    try:
        open_result, swap_result = await executor.open_position_with_rebalance(
            range_width_pct=range_width_pct,
            max_sol=max_sol,
            max_usdc=max_usdc,
            liquidity=liquidity,
            retry_attempt=0,
        )

        if swap_result and swap_result.success:
            logger.info(f"\n  Swap executed:")
            logger.info(f"    Direction: {swap_result.direction}")
            logger.info(f"    Input: {swap_result.input_amount:.4f} {swap_result.input_token}")
            logger.info(f"    Output: {swap_result.output_amount:.4f} {swap_result.output_token}")
            logger.info(f"    Signature: {swap_result.signature}")

        if open_result.success:
            logger.info(f"\n  ✓ POSITION OPENED SUCCESSFULLY!")
            logger.info(f"    Address: {open_result.position_address}")
            logger.info(f"    Signature: {open_result.signature}")
            logger.info(f"    Deposited: {open_result.deposited_sol:.4f} SOL, ${open_result.deposited_usdc:.2f} USDC")
            logger.info(f"    Ticks: [{open_result.lower_tick}, {open_result.upper_tick}]")
            logger.info(f"    Range: ${open_result.lower_price:.4f} - ${open_result.upper_price:.4f}")

            # Verify the opened position
            logger.info(f"\nSTEP 5: Verifying position...")

            # Check balances after
            sol_after, usdc_after = await executor.get_balances()
            logger.info(f"  Balance after: {sol_after:.4f} SOL, ${usdc_after:.2f} USDC")
            logger.info(f"  SOL used: {sol_balance - sol_after:.4f}")
            logger.info(f"  USDC used: ${usdc_balance - usdc_after:.2f}")

            # Verify the actual position is in range
            actual_lower_sqrt = tick_to_sqrt_price(open_result.lower_tick)
            actual_upper_sqrt = tick_to_sqrt_price(open_result.upper_tick)

            # Re-fetch pool state to get current sqrt_price
            current_pool = await executor.get_pool_state()
            if actual_lower_sqrt < current_pool.sqrt_price < actual_upper_sqrt:
                logger.info(f"  ✓ VERIFIED: Current price ${current_pool.current_price:.4f} is IN RANGE")
            else:
                logger.warning(f"  ! WARNING: Price may have moved during execution")

            return True
        else:
            logger.error(f"\n  ✗ POSITION OPEN FAILED!")
            logger.error(f"    Error: {open_result.error}")
            return False

    except Exception as e:
        logger.exception(f"Exception during position open: {e}")
        return False


async def close_position_by_address(address: str):
    """Close a specific position by address."""
    logger.info("=" * 60)
    logger.info(f"CLOSING POSITION: {address}")
    logger.info("=" * 60)

    executor, pool_state, sol, usdc = await check_current_state()

    logger.info(f"\nClosing position: {address}")
    try:
        result = await executor.close_position(address)
        if result.success:
            logger.info(f"  ✓ Closed successfully")
            logger.info(f"    Withdrawn: {result.withdrawn_sol:.4f} SOL, ${result.withdrawn_usdc:.2f} USDC")
            logger.info(f"    Fees collected: {result.fees_collected_sol:.6f} SOL, ${result.fees_collected_usdc:.4f} USDC")
            return True
        else:
            logger.error(f"  ✗ Failed: {result.error}")
            return False
    except Exception as e:
        logger.exception(f"  Exception: {e}")
        return False


async def main():
    parser = argparse.ArgumentParser(description='Live test for simplified ATR/range flow')
    parser.add_argument('--open', action='store_true', help='Open a test position')
    parser.add_argument('--close', type=str, metavar='ADDRESS', help='Close a specific position by address')
    parser.add_argument('--check', action='store_true', help='Just check current state')

    args = parser.parse_args()

    if args.close:
        await close_position_by_address(args.close)
    elif args.open:
        success = await open_test_position()
        if success:
            logger.info("\n" + "=" * 60)
            logger.info("LIVE TEST PASSED ✓")
            logger.info("The simplified flow works correctly!")
            logger.info("=" * 60)
        else:
            logger.error("\n" + "=" * 60)
            logger.error("LIVE TEST FAILED ✗")
            logger.error("=" * 60)
            sys.exit(1)
    elif args.check:
        await check_current_state()
    else:
        # Default: check state
        await check_current_state()
        logger.info("\nUse --open to open a test position, --close to close positions")


if __name__ == '__main__':
    asyncio.run(main())
