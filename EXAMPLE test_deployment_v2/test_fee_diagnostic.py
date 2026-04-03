#!/usr/bin/env python3
"""
Fee Calculation Diagnostic Test

Shows ALL values used in fee calculation to diagnose discrepancies.
"""

import asyncio
import sys
from pathlib import Path
from dotenv import load_dotenv

# Add project root to path
project_root = Path(__file__).parent.parent
sys.path.insert(0, str(project_root))

load_dotenv()

from test_deployment_v2.config import get_config
from test_deployment_v2.app.chain.orca_client import get_orca_client


async def diagnostic_test(position_address: str):
    """Show all values used in fee calculation."""

    print("=" * 80)
    print("FEE CALCULATION DIAGNOSTIC")
    print("=" * 80)
    print(f"\nPosition: {position_address}\n")

    orca_client = await get_orca_client()

    # Get position state
    print("STEP 1: Get Position State")
    print("-" * 80)
    position_state = await orca_client.get_position_state(position_address)

    if not position_state:
        print("❌ Failed to get position state")
        return

    print(f"✅ Position State:")
    print(f"   Whirlpool: {position_state.whirlpool}")
    print(f"   Liquidity: {position_state.liquidity:,}")
    print(f"   Tick Lower: {position_state.tick_lower_index}")
    print(f"   Tick Upper: {position_state.tick_upper_index}")
    print(f"   Fee Growth Checkpoint A: {position_state.fee_growth_checkpoint_a}")
    print(f"   Fee Growth Checkpoint B: {position_state.fee_growth_checkpoint_b}")
    print(f"   Fee Owed A (stale): {position_state.fee_owed_a}")
    print(f"   Fee Owed B (stale): {position_state.fee_owed_b}")

    # Get pool state
    print(f"\nSTEP 2: Get Pool State")
    print("-" * 80)
    pool_state = await orca_client.get_pool_state(position_state.whirlpool, force_refresh=True)

    if not pool_state:
        print("❌ Failed to get pool state")
        return

    print(f"✅ Pool State:")
    print(f"   Current Price: ${pool_state.current_price:.4f}")
    print(f"   Tick Current: {pool_state.tick_current_index}")
    print(f"   Fee Growth Global A: {pool_state.fee_growth_global_a}")
    print(f"   Fee Growth Global B: {pool_state.fee_growth_global_b}")
    print(f"   Pool Liquidity: {pool_state.liquidity:,}")

    # Check if position is in range
    print(f"\nSTEP 3: Check if Position is In Range")
    print("-" * 80)
    in_range = (position_state.tick_lower_index <= pool_state.tick_current_index <= position_state.tick_upper_index)
    print(f"   Position range: [{position_state.tick_lower_index}, {position_state.tick_upper_index}]")
    print(f"   Current tick: {pool_state.tick_current_index}")
    print(f"   In range: {'✅ YES' if in_range else '❌ NO (fees only accumulate when in range)'}")

    # Calculate fee deltas
    print(f"\nSTEP 4: Calculate Fee Growth Deltas")
    print("-" * 80)
    delta_a = pool_state.fee_growth_global_a - position_state.fee_growth_checkpoint_a
    delta_b = pool_state.fee_growth_global_b - position_state.fee_growth_checkpoint_b

    print(f"   Delta A = {pool_state.fee_growth_global_a} - {position_state.fee_growth_checkpoint_a}")
    print(f"          = {delta_a}")
    print(f"   Delta B = {pool_state.fee_growth_global_b} - {position_state.fee_growth_checkpoint_b}")
    print(f"          = {delta_b}")

    if delta_a < 0 or delta_b < 0:
        print(f"\n   ⚠️  WARNING: Negative delta detected!")
        print(f"       This suggests position checkpoint is newer than pool globals (impossible)")
        print(f"       Possible causes:")
        print(f"       - Position was recently updated with update_fees_and_rewards")
        print(f"       - Position account data corruption")
        print(f"       - Decoding error")

    # Calculate raw fees
    print(f"\nSTEP 5: Calculate Raw Fees (in base units)")
    print("-" * 80)
    Q64 = 2**64
    fees_a_raw = (delta_a * position_state.liquidity) // Q64
    fees_b_raw = (delta_b * position_state.liquidity) // Q64

    print(f"   fees_a_raw = ({delta_a} * {position_state.liquidity}) / {Q64}")
    print(f"              = {fees_a_raw} lamports")
    print(f"   fees_b_raw = ({delta_b} * {position_state.liquidity}) / {Q64}")
    print(f"              = {fees_b_raw} micro-USDC")

    # Convert to token amounts
    print(f"\nSTEP 6: Convert to Token Amounts")
    print("-" * 80)
    fees_sol = fees_a_raw / 10**9
    fees_usdc = fees_b_raw / 10**6

    print(f"   fees_sol = {fees_a_raw} / 10^9 = {fees_sol:.9f} SOL")
    print(f"   fees_usdc = {fees_b_raw} / 10^6 = ${fees_usdc:.6f} USDC")

    # Calculate total value
    print(f"\nSTEP 7: Calculate Total Fee Value")
    print("-" * 80)
    sol_price = pool_state.current_price
    total_usd = (fees_sol * sol_price) + fees_usdc

    print(f"   SOL fees value: {fees_sol:.9f} SOL × ${sol_price:.2f} = ${fees_sol * sol_price:.2f}")
    print(f"   USDC fees value: ${fees_usdc:.2f}")
    print(f"   TOTAL: ${total_usd:.2f}")

    # Final result
    print(f"\n" + "=" * 80)
    print("FINAL RESULT")
    print("=" * 80)
    print(f"Pending Fees: {fees_sol:.9f} SOL + ${fees_usdc:.2f} USDC = ${total_usd:.2f}")
    print("=" * 80)

    # Sanity checks
    print(f"\nSANITY CHECKS")
    print("-" * 80)

    if total_usd > 10000:
        print(f"⚠️  WARNING: Fees seem very high (${total_usd:.2f})")
        print(f"   This could mean:")
        print(f"   - Position has been open for a very long time")
        print(f"   - Position has very high liquidity in a high-volume pool")
        print(f"   - fee_growth_checkpoint values are incorrect (possibly 0)")
    elif total_usd < 0.01:
        print(f"⚠️  WARNING: Fees seem very low (${total_usd:.2f})")
        print(f"   This could mean:")
        print(f"   - Position was just opened")
        print(f"   - Position is out of range")
        print(f"   - Very low pool volume")
    else:
        print(f"✅ Fees seem reasonable for a typical position")

    # Check if checkpoint values are 0
    if position_state.fee_growth_checkpoint_a == 0 or position_state.fee_growth_checkpoint_b == 0:
        print(f"\n⚠️  CRITICAL: fee_growth_checkpoint is 0!")
        print(f"   This means the delta equals the entire pool's fee growth since inception.")
        print(f"   Possible causes:")
        print(f"   - Position was opened when pool had 0 fees (very unlikely)")
        print(f"   - Position account data is not being decoded correctly")
        print(f"   - Wrong offset when reading fee_growth_checkpoint from account data")

    print()


async def main():
    if len(sys.argv) < 2:
        print("Usage: python test_fee_diagnostic.py <position_address>")
        print("Example: python test_fee_diagnostic.py B59LDq95FtLAGRsBr7Xbws5bCZLUWwRidD6C75xvXyLK")
        return

    position_address = sys.argv[1]
    await diagnostic_test(position_address)


if __name__ == "__main__":
    asyncio.run(main())
