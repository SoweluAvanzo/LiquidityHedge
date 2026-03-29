#!/usr/bin/env python3
"""
Test script to verify pending fees calculation for a specific position.

This script tests the fee retrieval logic used in the app to ensure it correctly
calculates pending fees from on-chain data.
"""

import asyncio
import sys
from decimal import Decimal
from pathlib import Path

# Add parent directory to path
sys.path.insert(0, str(Path(__file__).parent))

from dotenv import load_dotenv
load_dotenv()

from app.chain.orca_client import get_orca_client


async def test_pending_fees():
    """Test pending fees calculation for the position."""

    # Position details from user
    position_address = "5vKh75db3U8m6WdqKbxQMjfwDjAExv8ECmqhiyfzh1QB"
    nft_address = "7NJUAGPF87DdiNSmjsYZLps1Yo5iWxt2YEagJdSDcPQA"
    pool_address = "Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE"
    expected_fees_usd = 0.18  # Expected total fees in USD

    print("=" * 80)
    print("PENDING FEES VERIFICATION TEST")
    print("=" * 80)
    print(f"\nPosition Address: {position_address}")
    print(f"NFT Address:      {nft_address}")
    print(f"Pool Address:     {pool_address}")
    print(f"Expected Fees:    ~${expected_fees_usd:.2f} USD")
    print()

    try:
        # Get Orca client
        orca_client = await get_orca_client()
        print("✅ Orca client initialized")

        # Step 1: Get position state
        print("\n" + "=" * 80)
        print("STEP 1: Fetching Position State")
        print("=" * 80)
        position_state = await orca_client.get_position_state(position_address)

        if not position_state:
            print(f"❌ ERROR: Position not found at address {position_address}")
            print("   This could mean:")
            print("   - The position doesn't exist")
            print("   - The position has been closed")
            print("   - RPC connection issues")
            return

        print(f"✅ Position state retrieved")
        print(f"   Whirlpool:              {position_state.whirlpool}")
        print(f"   Position Mint:          {position_state.position_mint}")
        print(f"   Liquidity:              {position_state.liquidity:,}")
        print(f"   Tick Lower:             {position_state.tick_lower_index}")
        print(f"   Tick Upper:             {position_state.tick_upper_index}")
        print(f"   Fee Growth Checkpoint A: {position_state.fee_growth_checkpoint_a}")
        print(f"   Fee Growth Checkpoint B: {position_state.fee_growth_checkpoint_b}")
        print(f"   Fee Owed A (STALE):     {position_state.fee_owed_a} (not used)")
        print(f"   Fee Owed B (STALE):     {position_state.fee_owed_b} (not used)")

        if position_state.liquidity == 0:
            print("\n⚠️  WARNING: Position has ZERO liquidity!")
            print("   This means the position has been closed or has no funds.")
            print("   Fees should be 0.")

        # Step 2: Get pool state with fresh fee growth globals
        print("\n" + "=" * 80)
        print("STEP 2: Fetching Pool State (with force_refresh)")
        print("=" * 80)
        pool_state = await orca_client.get_pool_state(position_state.whirlpool, force_refresh=True)

        if not pool_state:
            print(f"❌ ERROR: Pool state not found for {position_state.whirlpool}")
            return

        print(f"✅ Pool state retrieved")
        print(f"   Pool Address:           {pool_state.pubkey}")
        print(f"   Current Tick:           {pool_state.tick_current_index}")
        print(f"   Current Price:          ${pool_state.current_price:.2f}")
        print(f"   Liquidity:              {pool_state.liquidity:,}")
        print(f"   Fee Rate:               {pool_state.fee_rate} ({pool_state.fee_rate/10000:.4f}%)")
        print(f"   Fee Growth Global A:    {pool_state.fee_growth_global_a}")
        print(f"   Fee Growth Global B:    {pool_state.fee_growth_global_b}")

        # Check if position is in range
        in_range = (position_state.tick_lower_index <= pool_state.tick_current_index <= position_state.tick_upper_index)
        print(f"\n   Position In Range:      {'✅ YES' if in_range else '❌ NO'}")

        # Step 3: Calculate pending fees using the same logic as the app
        print("\n" + "=" * 80)
        print("STEP 3: Calculating Pending Fees")
        print("=" * 80)

        liquidity = position_state.liquidity

        # Calculate fee growth deltas
        fee_growth_delta_a = pool_state.fee_growth_global_a - position_state.fee_growth_checkpoint_a
        fee_growth_delta_b = pool_state.fee_growth_global_b - position_state.fee_growth_checkpoint_b

        print(f"Fee Growth Delta A: {fee_growth_delta_a}")
        print(f"Fee Growth Delta B: {fee_growth_delta_b}")
        print(f"Position Liquidity: {liquidity:,}")

        # Calculate fees: (delta * liquidity) / Q64
        Q64 = 2**64
        fees_a_raw = (fee_growth_delta_a * liquidity) // Q64
        fees_b_raw = (fee_growth_delta_b * liquidity) // Q64

        print(f"\nRaw Fees (base units):")
        print(f"   Fees A (lamports):      {fees_a_raw:,}")
        print(f"   Fees B (micro-units):   {fees_b_raw:,}")

        # Convert to token amounts
        fees_sol = Decimal(fees_a_raw) / Decimal(10**9)  # SOL has 9 decimals
        fees_usdc = Decimal(fees_b_raw) / Decimal(10**6)  # USDC has 6 decimals

        print(f"\nToken Amounts:")
        print(f"   Fees SOL:               {float(fees_sol):.9f} SOL")
        print(f"   Fees USDC:              ${float(fees_usdc):.6f} USDC")

        # Calculate USD value
        fees_sol_usd = float(fees_sol) * pool_state.current_price
        fees_usdc_usd = float(fees_usdc)
        total_fees_usd = fees_sol_usd + fees_usdc_usd

        print(f"\nUSD Values (using current price ${pool_state.current_price:.2f}):")
        print(f"   Fees SOL:               ${fees_sol_usd:.6f}")
        print(f"   Fees USDC:              ${fees_usdc_usd:.6f}")
        print(f"   TOTAL FEES:             ${total_fees_usd:.6f}")

        # Step 4: Compare with expected value
        print("\n" + "=" * 80)
        print("STEP 4: Verification")
        print("=" * 80)

        difference = abs(total_fees_usd - expected_fees_usd)
        percentage_diff = (difference / expected_fees_usd * 100) if expected_fees_usd > 0 else 0

        print(f"Expected Fees:   ${expected_fees_usd:.6f}")
        print(f"Calculated Fees: ${total_fees_usd:.6f}")
        print(f"Difference:      ${difference:.6f} ({percentage_diff:.2f}%)")

        if total_fees_usd == 0:
            print("\n⚠️  RESULT: Fees are ZERO")
            print("   Possible reasons:")
            print("   - Position has zero liquidity (already closed)")
            print("   - No trading activity since position was opened")
            print("   - Position is out of range (no fees earned)")
        elif difference < 0.01:  # Within 1 cent
            print("\n✅ RESULT: Fees match expected value (within $0.01)")
        elif percentage_diff < 10:  # Within 10%
            print("\n⚠️  RESULT: Fees are close to expected value (within 10%)")
            print("   This is acceptable - fees change as trading happens")
        else:
            print("\n❌ RESULT: Fees differ significantly from expected value")
            print("   This could indicate:")
            print("   - Expected value was incorrect")
            print("   - Significant trading happened since estimate")
            print("   - Issue with calculation logic")

        # Step 5: Test the estimate_fees_earned function directly
        print("\n" + "=" * 80)
        print("STEP 5: Testing estimate_fees_earned() Function")
        print("=" * 80)

        fees_a_func, fees_b_func = await orca_client.estimate_fees_earned(position_address)

        print(f"Function returned:")
        print(f"   Fees SOL:  {float(fees_a_func):.9f}")
        print(f"   Fees USDC: ${float(fees_b_func):.6f}")

        fees_total_func = (float(fees_a_func) * pool_state.current_price) + float(fees_b_func)
        print(f"   TOTAL:     ${fees_total_func:.6f}")

        if fees_total_func == total_fees_usd:
            print("\n✅ Function output matches manual calculation")
        else:
            print(f"\n⚠️  Function output differs: ${abs(fees_total_func - total_fees_usd):.6f}")

        print("\n" + "=" * 80)
        print("TEST COMPLETE")
        print("=" * 80)

    except Exception as e:
        print(f"\n❌ ERROR during test: {e}")
        import traceback
        traceback.print_exc()


if __name__ == "__main__":
    asyncio.run(test_pending_fees())
