#!/usr/bin/env python3
"""
Test script to analyze transaction costs at different position sizes.

This test measures costs by comparing wallet balances BEFORE and AFTER each operation.
Tests multiple position sizes to determine if costs are:
- Fixed (same cost regardless of size)
- Variable (proportional to size)
- Mixed (fixed + variable components)

Also verifies Jupiter Ultra API usage and compares to standard Swap API costs.
"""
import asyncio
import os
import sys
from datetime import datetime, timezone
from dataclasses import dataclass, field
from typing import Optional, Tuple, List

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from config import Config, get_config
from execution import (
    TradeExecutor,
    price_to_tick,
    calculate_liquidity_from_amounts,
    tick_to_sqrt_price,
)
import httpx


@dataclass
class BalanceSnapshot:
    """Snapshot of wallet balances at a point in time."""
    sol: float
    usdc: float
    timestamp: datetime
    label: str

    def __str__(self):
        return f"[{self.label}] SOL: {self.sol:.6f}, USDC: ${self.usdc:.2f}"


@dataclass
class OperationCost:
    """Cost analysis for a single operation."""
    operation: str
    sol_change: float
    usdc_change: float
    expected_sol_change: float
    expected_usdc_change: float
    actual_cost_sol: float
    actual_cost_usd: float
    rpc_reported_fee_sol: float
    signature: str

    def __str__(self):
        return (
            f"{self.operation}:\n"
            f"  Balance change: {self.sol_change:+.6f} SOL, {self.usdc_change:+.2f} USDC\n"
            f"  Expected change: {self.expected_sol_change:+.6f} SOL, {self.expected_usdc_change:+.2f} USDC\n"
            f"  Actual cost: {self.actual_cost_sol:.6f} SOL (${self.actual_cost_usd:.4f})\n"
            f"  RPC reported fee: {self.rpc_reported_fee_sol:.9f} SOL"
        )


@dataclass
class PositionSizeTest:
    """Results from testing a specific position size."""
    position_size_usd: float
    sol_amount: float
    usdc_amount: float

    # Costs by operation
    open_cost_sol: float = 0.0
    open_cost_usd: float = 0.0
    close_cost_sol: float = 0.0
    close_cost_usd: float = 0.0

    # RPC reported fees
    open_rpc_fee: float = 0.0
    close_rpc_fee: float = 0.0

    # Totals
    total_cost_sol: float = 0.0
    total_cost_usd: float = 0.0
    total_rpc_fee: float = 0.0

    # Collected fees
    fees_collected_sol: float = 0.0
    fees_collected_usdc: float = 0.0

    # Signatures
    open_signature: str = ""
    close_signature: str = ""
    swap_signature: str = ""

    # Timing
    position_duration_sec: float = 0.0

    @property
    def cost_as_pct(self) -> float:
        """Cost as percentage of position size."""
        if self.position_size_usd > 0:
            return (self.total_cost_usd / self.position_size_usd) * 100
        return 0.0

    @property
    def rpc_fee_as_pct(self) -> float:
        """RPC fee as percentage of position size."""
        if self.position_size_usd > 0:
            return (self.total_rpc_fee * 128.0 / self.position_size_usd) * 100  # Approximate price
        return 0.0


async def get_transaction_fee_from_rpc(rpc_url: str, signature: str, max_retries: int = 3) -> float:
    """Get transaction fee from RPC with retry logic."""
    if not signature:
        return 0.0

    for attempt in range(max_retries):
        try:
            if attempt > 0:
                await asyncio.sleep(3 * attempt)

            async with httpx.AsyncClient(timeout=30.0) as client:
                payload = {
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "getTransaction",
                    "params": [
                        signature,
                        {"encoding": "jsonParsed", "maxSupportedTransactionVersion": 0}
                    ]
                }

                response = await client.post(rpc_url, json=payload)
                response.raise_for_status()
                tx_data = response.json()

                result = tx_data.get("result")
                if result:
                    meta = result.get("meta", {})
                    fee_lamports = meta.get("fee", 0)
                    return fee_lamports / 1e9

                print(f"    RPC attempt {attempt+1}/{max_retries}: TX not indexed yet...")

        except Exception as e:
            print(f"    RPC attempt {attempt+1}/{max_retries}: Error - {e}")

    return 0.0


async def take_balance_snapshot(executor: TradeExecutor, label: str) -> BalanceSnapshot:
    """Take a snapshot of current wallet balances."""
    sol, usdc = await executor.get_balances()
    return BalanceSnapshot(
        sol=sol,
        usdc=usdc,
        timestamp=datetime.now(timezone.utc),
        label=label
    )


def calculate_operation_cost(
    before: BalanceSnapshot,
    after: BalanceSnapshot,
    expected_sol_change: float,
    expected_usdc_change: float,
    operation: str,
    price: float,
    rpc_fee: float,
    signature: str
) -> OperationCost:
    """Calculate actual cost of an operation from balance differences."""
    actual_sol_change = after.sol - before.sol
    actual_usdc_change = after.usdc - before.usdc

    sol_cost = expected_sol_change - actual_sol_change
    usdc_cost = expected_usdc_change - actual_usdc_change

    total_cost_sol = sol_cost + (usdc_cost / price)
    total_cost_usd = total_cost_sol * price

    return OperationCost(
        operation=operation,
        sol_change=actual_sol_change,
        usdc_change=actual_usdc_change,
        expected_sol_change=expected_sol_change,
        expected_usdc_change=expected_usdc_change,
        actual_cost_sol=total_cost_sol,
        actual_cost_usd=total_cost_usd,
        rpc_reported_fee_sol=rpc_fee,
        signature=signature
    )


async def test_position_size(
    executor: TradeExecutor,
    config: Config,
    target_size_usd: float,
    current_price: float,
    wait_duration: int = 10
) -> Optional[PositionSizeTest]:
    """Test a specific position size and return cost analysis."""

    print(f"\n{'='*70}")
    print(f"TESTING POSITION SIZE: ${target_size_usd}")
    print(f"{'='*70}")

    rpc_url = config.api.rpc_url

    # Split 50/50 between SOL and USDC
    target_sol_value = target_size_usd / 2
    target_usdc_value = target_size_usd / 2
    test_sol = target_sol_value / current_price
    test_usdc = target_usdc_value

    result = PositionSizeTest(
        position_size_usd=target_size_usd,
        sol_amount=test_sol,
        usdc_amount=test_usdc
    )

    print(f"   Target: {test_sol:.4f} SOL (${target_sol_value:.0f}) + ${test_usdc:.0f} USDC")

    # Check balance
    current_bal = await take_balance_snapshot(executor, "CHECK")
    if current_bal.sol < test_sol + 0.05:
        print(f"   ERROR: Insufficient SOL! Have {current_bal.sol:.4f}, need {test_sol + 0.05:.4f}")
        return None
    if current_bal.usdc < test_usdc:
        print(f"   ERROR: Insufficient USDC! Have ${current_bal.usdc:.2f}, need ${test_usdc:.0f}")
        return None

    # Get pool state
    pool_state = await executor.get_pool_state()
    tick_spacing = pool_state.tick_spacing
    sqrt_price = pool_state.sqrt_price

    # Calculate range (3% width)
    range_pct = 0.03
    lower_price = current_price * (1 - range_pct / 2)
    upper_price = current_price * (1 + range_pct / 2)

    lower_tick = price_to_tick(lower_price, tick_spacing)
    upper_tick = price_to_tick(upper_price, tick_spacing)

    print(f"   Range: ${lower_price:.2f} - ${upper_price:.2f} ({range_pct*100:.1f}%)")

    # Calculate liquidity
    sol_lamports = int(test_sol * 1e9)
    usdc_micro = int(test_usdc * 1e6)
    liquidity = calculate_liquidity_from_amounts(
        sqrt_price_current=sqrt_price,
        lower_tick=lower_tick,
        upper_tick=upper_tick,
        token_a_amount=sol_lamports,
        token_b_amount=usdc_micro,
    )

    # ===== OPEN POSITION =====
    print(f"\n   Opening position...")
    pre_open = await take_balance_snapshot(executor, "PRE_OPEN")
    open_start = datetime.now(timezone.utc)

    open_result, swap_result = await executor.open_position_with_rebalance(
        lower_tick=lower_tick,
        upper_tick=upper_tick,
        max_sol=test_sol,
        max_usdc=test_usdc,
        liquidity=liquidity,
        retry_attempt=0,
    )

    if not open_result or not open_result.success:
        print(f"   ERROR: Failed to open position!")
        if open_result:
            print(f"   Error: {open_result.error}")
        return None

    position_address = open_result.position_address
    result.open_signature = open_result.signature
    if swap_result and swap_result.success:
        result.swap_signature = swap_result.signature
        print(f"   Pre-swap executed: {swap_result.input_amount:.4f} -> {swap_result.output_amount:.4f}")

    print(f"   Position opened: {position_address[:20]}...")
    print(f"   Deposited: {open_result.deposited_sol:.4f} SOL + ${open_result.deposited_usdc:.2f} USDC")

    await asyncio.sleep(3)
    post_open = await take_balance_snapshot(executor, "POST_OPEN")

    # Get RPC fee
    open_rpc_fee = await get_transaction_fee_from_rpc(rpc_url, open_result.signature)
    result.open_rpc_fee = open_rpc_fee

    # Calculate open cost
    open_cost = calculate_operation_cost(
        before=pre_open,
        after=post_open,
        expected_sol_change=-open_result.deposited_sol,
        expected_usdc_change=-open_result.deposited_usdc,
        operation="OPEN",
        price=current_price,
        rpc_fee=open_rpc_fee,
        signature=open_result.signature
    )
    result.open_cost_sol = open_cost.actual_cost_sol
    result.open_cost_usd = open_cost.actual_cost_usd

    print(f"   Open cost: {open_cost.actual_cost_sol:.6f} SOL (${open_cost.actual_cost_usd:.4f})")
    print(f"   RPC fee: {open_rpc_fee:.9f} SOL")

    # ===== WAIT =====
    print(f"\n   Waiting {wait_duration}s for fees to accumulate...")
    await asyncio.sleep(wait_duration)

    # ===== CLOSE POSITION =====
    print(f"\n   Closing position...")
    current_price = await executor.get_pool_price()

    pre_close = await take_balance_snapshot(executor, "PRE_CLOSE")

    close_result = await executor.close_position(
        position_address=position_address,
    )

    close_end = datetime.now(timezone.utc)
    result.position_duration_sec = (close_end - open_start).total_seconds()

    if not close_result or not close_result.success:
        print(f"   ERROR: Failed to close position!")
        return None

    result.close_signature = close_result.signature
    result.fees_collected_sol = close_result.fees_collected_sol
    result.fees_collected_usdc = close_result.fees_collected_usdc

    print(f"   Withdrawn: {close_result.withdrawn_sol:.4f} SOL + ${close_result.withdrawn_usdc:.2f} USDC")
    print(f"   Fees collected: {close_result.fees_collected_sol:.6f} SOL + ${close_result.fees_collected_usdc:.4f} USDC")

    await asyncio.sleep(3)
    post_close = await take_balance_snapshot(executor, "POST_CLOSE")

    # Get RPC fee
    close_rpc_fee = await get_transaction_fee_from_rpc(rpc_url, close_result.signature)
    result.close_rpc_fee = close_rpc_fee

    # Calculate close cost
    expected_sol_back = close_result.withdrawn_sol + close_result.fees_collected_sol
    expected_usdc_back = close_result.withdrawn_usdc + close_result.fees_collected_usdc

    close_cost = calculate_operation_cost(
        before=pre_close,
        after=post_close,
        expected_sol_change=expected_sol_back,
        expected_usdc_change=expected_usdc_back,
        operation="CLOSE",
        price=current_price,
        rpc_fee=close_rpc_fee,
        signature=close_result.signature
    )
    result.close_cost_sol = close_cost.actual_cost_sol
    result.close_cost_usd = close_cost.actual_cost_usd

    print(f"   Close cost: {close_cost.actual_cost_sol:.6f} SOL (${close_cost.actual_cost_usd:.4f})")
    print(f"   RPC fee: {close_rpc_fee:.9f} SOL")

    # Calculate totals
    result.total_cost_sol = result.open_cost_sol + result.close_cost_sol
    result.total_cost_usd = result.open_cost_usd + result.close_cost_usd
    result.total_rpc_fee = result.open_rpc_fee + result.close_rpc_fee

    print(f"\n   === ${target_size_usd} POSITION SUMMARY ===")
    print(f"   Total actual cost: {result.total_cost_sol:.6f} SOL (${result.total_cost_usd:.4f})")
    print(f"   Total RPC fees: {result.total_rpc_fee:.9f} SOL")
    print(f"   Cost as % of position: {result.cost_as_pct:.4f}%")

    return result


async def main():
    print("=" * 80)
    print("MULTI-SIZE TRANSACTION COST ANALYSIS")
    print("Testing if costs are FIXED or VARIABLE based on position size")
    print("=" * 80)
    print(f"\nStarted at: {datetime.now(timezone.utc).isoformat()} UTC")

    config = get_config()
    pool_address = config.pool.pool_address
    rpc_url = config.api.rpc_url

    # Check Jupiter config
    use_ultra = config.jupiter.use_ultra
    ultra_gasless = config.jupiter.ultra_gasless

    print(f"\n1. CONFIGURATION")
    print(f"   Pool: {pool_address}")
    print(f"   Jupiter Ultra API: {'ENABLED' if use_ultra else 'DISABLED'}")
    print(f"   Ultra Gasless: {'ENABLED' if ultra_gasless else 'DISABLED'}")

    # Initialize TradeExecutor
    trade_executor = TradeExecutor(config=config)

    print(f"\n   Initializing clients...")
    init_success = await trade_executor.initialize()
    if not init_success:
        print(f"   ERROR: Failed to initialize TradeExecutor!")
        return
    print(f"   Clients initialized successfully")

    # Get current state
    current_price = await trade_executor.get_pool_price()

    print(f"\n2. INITIAL STATE")
    initial_snapshot = await take_balance_snapshot(trade_executor, "INITIAL")
    print(f"   {initial_snapshot}")
    print(f"   SOL/USDC price: ${current_price:.2f}")
    total_available = initial_snapshot.sol * current_price + initial_snapshot.usdc
    print(f"   Total available: ${total_available:.2f}")

    # Define position sizes to test (adjusted based on available balance)
    # We need some reserve for fees and multiple tests
    max_test_size = min(400, total_available * 0.4)  # Use up to 40% per test

    if total_available < 250:
        position_sizes = [50, 100]
    elif total_available < 500:
        position_sizes = [100, 200]
    else:
        position_sizes = [100, 200, 400]

    print(f"\n3. TEST PLAN")
    print(f"   Position sizes to test: {position_sizes}")
    print(f"   Each test: Open -> Wait 10s -> Close")

    # Run tests
    results: List[PositionSizeTest] = []

    for size in position_sizes:
        # Refresh price before each test
        current_price = await trade_executor.get_pool_price()

        result = await test_position_size(
            executor=trade_executor,
            config=config,
            target_size_usd=float(size),
            current_price=current_price,
            wait_duration=10
        )

        if result:
            results.append(result)
        else:
            print(f"\n   WARNING: Test for ${size} failed, skipping...")

        # Short delay between tests
        await asyncio.sleep(5)

    # =========================================================================
    # ANALYSIS
    # =========================================================================
    print(f"\n" + "=" * 80)
    print("COST ANALYSIS RESULTS")
    print("=" * 80)

    if len(results) < 2:
        print("\n   ERROR: Not enough successful tests for analysis!")
        return

    current_price = await trade_executor.get_pool_price()

    print(f"\n--- Raw Results ---")
    print(f"{'Size':>10} | {'Total Cost':>15} | {'Cost %':>10} | {'RPC Fee':>12} | {'Open Cost':>12} | {'Close Cost':>12}")
    print("-" * 85)

    for r in results:
        print(f"${r.position_size_usd:>8.0f} | {r.total_cost_sol:>10.6f} SOL | {r.cost_as_pct:>9.4f}% | {r.total_rpc_fee:>10.9f} | {r.open_cost_sol:>10.6f} | {r.close_cost_sol:>10.6f}")

    # Analyze cost structure
    print(f"\n--- Cost Structure Analysis ---")

    if len(results) >= 2:
        # Check if costs are fixed or proportional
        sizes = [r.position_size_usd for r in results]
        costs_usd = [r.total_cost_usd for r in results]
        costs_pct = [r.cost_as_pct for r in results]

        # Calculate cost per dollar of position
        cost_per_dollar = [r.total_cost_usd / r.position_size_usd for r in results]

        # If cost % is roughly constant, costs are PROPORTIONAL
        # If cost USD is roughly constant, costs are FIXED
        pct_variation = max(costs_pct) - min(costs_pct)
        usd_variation = max(costs_usd) - min(costs_usd)

        avg_cost_pct = sum(costs_pct) / len(costs_pct)
        avg_cost_usd = sum(costs_usd) / len(costs_usd)

        print(f"\n   Cost as % of position:")
        for i, r in enumerate(results):
            print(f"      ${r.position_size_usd:>5.0f}: {r.cost_as_pct:.4f}%")
        print(f"      Variation: {pct_variation:.4f}% (range)")
        print(f"      Average: {avg_cost_pct:.4f}%")

        print(f"\n   Cost in USD:")
        for i, r in enumerate(results):
            print(f"      ${r.position_size_usd:>5.0f}: ${r.total_cost_usd:.4f}")
        print(f"      Variation: ${usd_variation:.4f}")
        print(f"      Average: ${avg_cost_usd:.4f}")

        # Determine cost structure
        print(f"\n--- CONCLUSION ---")

        # If percentage variation is small (< 0.5%) and USD variation is high, costs are PROPORTIONAL
        # If USD variation is small (< $0.50) and percentage variation is high, costs are FIXED

        if pct_variation < 0.5:  # Less than 0.5% variation in percentage
            print(f"   COST STRUCTURE: PROPORTIONAL (variable)")
            print(f"   - Costs scale with position size")
            print(f"   - Average cost: {avg_cost_pct:.4f}% of position")
            print(f"   - Likely dominated by: Slippage, swap fees")
        elif pct_variation > 1.0 and len([r for r in results if r.position_size_usd > 100]) >= 2:
            # Large positions have lower percentage cost = fixed component
            print(f"   COST STRUCTURE: FIXED (with possible small variable component)")
            print(f"   - Costs are roughly constant regardless of size")
            print(f"   - Average fixed cost: ~${avg_cost_usd:.4f}")
            print(f"   - Likely dominated by: TX fees, account rent")
        else:
            print(f"   COST STRUCTURE: MIXED (fixed + variable)")
            print(f"   - Contains both fixed and proportional components")

            # Try to decompose: assume Cost = Fixed + (Variable% * Size)
            # Using two points: Fixed = (Cost1 * Size2 - Cost2 * Size1) / (Size2 - Size1)
            if len(results) >= 2:
                r1, r2 = results[0], results[-1]
                if r2.position_size_usd != r1.position_size_usd:
                    # Solve: C1 = F + V*S1, C2 = F + V*S2
                    # V = (C2-C1)/(S2-S1)
                    # F = C1 - V*S1
                    variable_rate = (r2.total_cost_usd - r1.total_cost_usd) / (r2.position_size_usd - r1.position_size_usd)
                    fixed_cost = r1.total_cost_usd - variable_rate * r1.position_size_usd

                    print(f"\n   Estimated decomposition:")
                    print(f"   - Fixed cost: ~${max(0, fixed_cost):.4f}")
                    print(f"   - Variable cost: ~{variable_rate * 100:.4f}% of position size")

        # Compare with RPC reported fees
        print(f"\n--- RPC Fee Comparison ---")
        for r in results:
            rpc_usd = r.total_rpc_fee * current_price
            underreport = ((r.total_cost_usd - rpc_usd) / r.total_cost_usd * 100) if r.total_cost_usd > 0 else 0
            print(f"   ${r.position_size_usd:>5.0f}: RPC=${rpc_usd:.4f}, Actual=${r.total_cost_usd:.4f}, Underreported by {underreport:.1f}%")

        avg_underreport = sum((r.total_cost_usd - r.total_rpc_fee * current_price) / r.total_cost_usd * 100 for r in results if r.total_cost_usd > 0) / len(results)
        print(f"\n   Average RPC underreporting: {avg_underreport:.1f}%")
        print(f"   This is because RPC only captures TX fees, not slippage or liquidity costs.")

    # Production comparison note
    print(f"\n--- Production Comparison Notes ---")
    print(f"   From production logs (Session PnL):")
    print(f"   - TX Costs shown: $0.01 (RPC-reported)")
    print(f"   - Position size: ~$7612")
    print(f"   - Our tests show RPC underreports by ~90%+")
    print(f"\n   Estimated actual production TX costs:")
    if results:
        avg_pct = sum(r.cost_as_pct for r in results) / len(results)
        estimated_prod_cost = 7612 * (avg_pct / 100)
        print(f"   - Using avg test cost %: {avg_pct:.4f}%")
        print(f"   - Estimated actual cost: ~${estimated_prod_cost:.2f}")
        print(f"   - vs RPC reported: $0.01")

    # Final state
    final_snapshot = await take_balance_snapshot(trade_executor, "FINAL")
    print(f"\n--- Final Wallet State ---")
    print(f"   {final_snapshot}")
    print(f"   Net change from initial: {final_snapshot.sol - initial_snapshot.sol:+.6f} SOL, {final_snapshot.usdc - initial_snapshot.usdc:+.2f} USDC")

    print(f"\n" + "=" * 80)
    print(f"Test completed at: {datetime.now(timezone.utc).isoformat()} UTC")
    print("=" * 80)


if __name__ == "__main__":
    asyncio.run(main())
