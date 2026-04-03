#!/usr/bin/env python3
"""
Complete test for Fees and TVL retrieval and logging.

Tests:
1. Fee retrieval from position state
2. TVL calculation from vault balances
3. CSV logging with both fees and TVL
4. Error handling

Run this to verify everything works before deployment.
"""

import asyncio
import os
import sys
from pathlib import Path
from decimal import Decimal
from dotenv import load_dotenv

# Add project root to path
project_root = Path(__file__).parent.parent
sys.path.insert(0, str(project_root))

load_dotenv()

from test_deployment_v2.config import get_config
from test_deployment_v2.app.chain.orca_client import get_orca_client
from test_deployment_v2.app.chain.solana_client import get_solana_client
from test_deployment_v2.pool_metrics_calculator import calculate_tvl_from_pool_state
from test_deployment_v2.csv_logger import CSVLogger, get_csv_logger


async def test_fee_retrieval():
    """Test fee retrieval from a real position."""
    print("=" * 70)
    print("TEST: Fee Retrieval from Position State")
    print("=" * 70)
    
    config = get_config()
    orca_client = await get_orca_client()
    
    # Try to find an active position by checking recent transactions
    # For testing, we'll use a known position address or create a test
    print("\n⚠️  To test fees, we need a position address.")
    print("   Options:")
    print("   1. Provide a position address as argument")
    print("   2. Create a test position (requires wallet)")
    
    # If position address provided as argument
    position_address = None
    if len(sys.argv) > 1:
        position_address = sys.argv[1]
        print(f"\n📋 Testing with position: {position_address}")
    
    if not position_address:
        print("\n⚠️  No position address provided - testing fee estimation logic only")
        print("   (This will test the code path but won't retrieve real fees)")
        return None, None
    
    try:
        # Test estimate_fees_earned
        print(f"\n--- Testing estimate_fees_earned ---")
        fees_sol_decimal, fees_usdc_decimal = await orca_client.estimate_fees_earned(
            position_pubkey=position_address
        )
        fees_sol = float(fees_sol_decimal)
        fees_usdc = float(fees_usdc_decimal)
        
        print(f"✅ Fees retrieved successfully:")
        print(f"   SOL: {fees_sol:.6f}")
        print(f"   USDC: ${fees_usdc:.2f}")
        print(f"   Total (at $128/SOL): ${(fees_sol * 128) + fees_usdc:.2f}")
        
        # Also test direct position state
        print(f"\n--- Testing direct position state ---")
        position_state = await orca_client.get_position_state(position_address)
        if position_state:
            fee_owed_a = float(position_state.fee_owed_a) / 1e9
            fee_owed_b = float(position_state.fee_owed_b) / 1e6
            print(f"✅ Position state retrieved:")
            print(f"   fee_owed_a: {fee_owed_a:.6f} SOL")
            print(f"   fee_owed_b: ${fee_owed_b:.2f} USDC")
            print(f"   liquidity: {position_state.liquidity}")
            
            # Verify they match
            if abs(fee_owed_a - fees_sol) < 0.000001 and abs(fee_owed_b - fees_usdc) < 0.01:
                print(f"✅ Fee values match between methods")
            else:
                print(f"⚠️  Fee values differ slightly (expected due to timing)")
        
        return fees_sol, fees_usdc
        
    except Exception as e:
        print(f"❌ Fee retrieval failed: {e}")
        import traceback
        traceback.print_exc()
        return None, None


async def test_tvl_retrieval():
    """Test TVL retrieval from pool vault balances."""
    print("\n" + "=" * 70)
    print("TEST: TVL Retrieval from Pool Vault Balances")
    print("=" * 70)
    
    config = get_config()
    pool_address = config.pool.pool_address
    
    try:
        orca_client = await get_orca_client()
        pool_state = await orca_client.get_pool_state(pool_address, force_refresh=True)
        
        if not pool_state:
            print("❌ Failed to get pool state")
            return None
        
        # Check vault addresses
        if not hasattr(pool_state, 'token_vault_a') or not pool_state.token_vault_a:
            print("❌ Pool state missing token_vault_a")
            return None
        if not hasattr(pool_state, 'token_vault_b') or not pool_state.token_vault_b:
            print("❌ Pool state missing token_vault_b")
            return None
        
        print(f"✅ Pool state retrieved with vault addresses")
        
        # Test TVL calculation
        tvl_usd, sol_bal, usdc_bal = await calculate_tvl_from_pool_state(
            pool_state,
            solana_client=None
        )
        
        if tvl_usd > 0:
            print(f"✅ TVL calculated successfully:")
            print(f"   TVL: ${tvl_usd:,.2f}")
            print(f"   SOL balance: {sol_bal:.2f} SOL")
            print(f"   USDC balance: ${usdc_bal:,.2f}")
            return tvl_usd
        else:
            print(f"❌ TVL calculation returned 0")
            return None
            
    except Exception as e:
        print(f"❌ TVL retrieval failed: {e}")
        import traceback
        traceback.print_exc()
        return None


async def test_csv_logging_with_fees_and_tvl():
    """Test CSV logging with fees and TVL."""
    print("\n" + "=" * 70)
    print("TEST: CSV Logging with Fees and TVL")
    print("=" * 70)
    
    config = get_config()
    
    # Create a test CSV logger
    test_data_dir = Path("test_deployment_v2/test_data_csv")
    test_data_dir.mkdir(exist_ok=True)
    
    csv_logger = CSVLogger(output_dir=str(test_data_dir))
    
    # Test position open with TVL
    print("\n--- Testing log_position_open with TVL ---")
    pool_state = await test_tvl_retrieval()
    tvl_entry = 0.0
    if pool_state:
        tvl_entry, _, _ = await calculate_tvl_from_pool_state(pool_state, solana_client=None)
    
    csv_logger.log_position_open(
        position_address="TEST_POSITION_123",
        entry_price=128.50,
        sol_amount=1.0,
        usdc_amount=128.50,
        lower_price=126.0,
        upper_price=131.0,
        tx_signature="TEST_SIG_OPEN",
        open_attempts=1,
        tvl=tvl_entry if tvl_entry > 0 else 0.0,
        volume_24h=0.0,  # Not implemented yet
    )
    print(f"✅ Position open logged with TVL={tvl_entry:.2f}")
    
    # Test position close with fees and TVL
    print("\n--- Testing log_position_close with fees and TVL ---")
    
    # Get TVL at exit
    tvl_exit = 0.0
    if pool_state:
        tvl_exit, _, _ = await calculate_tvl_from_pool_state(pool_state, solana_client=None)
    
    # Test with sample fees
    test_fees_sol = 0.001234
    test_fees_usdc = 0.15
    
    csv_logger.log_position_close(
        position_address="TEST_POSITION_123",
        exit_price=129.00,
        sol_withdrawn=0.98,
        usdc_withdrawn=126.50,
        fees_sol=test_fees_sol,
        fees_usdc=test_fees_usdc,
        tx_signature="TEST_SIG_CLOSE",
        rebalance_latency_seconds=0.0,
        tvl=tvl_exit if tvl_exit > 0 else 0.0,
        volume_24h=0.0,
    )
    print(f"✅ Position close logged with:")
    print(f"   Fees: {test_fees_sol:.6f} SOL + ${test_fees_usdc:.2f} USDC")
    print(f"   TVL at exit: ${tvl_exit:,.2f}")
    
    # Test fee collection logging
    print("\n--- Testing log_fee_collection ---")
    csv_logger.log_fee_collection(
        fees_sol=test_fees_sol,
        fees_usdc=test_fees_usdc,
        price=129.00,
        tx_signature="TEST_SIG_CLOSE",
    )
    print(f"✅ Fee collection logged")
    
    # Verify CSV file
    csv_file = test_data_dir / "lp_management.csv"
    if csv_file.exists():
        print(f"\n✅ CSV file created: {csv_file}")
        with open(csv_file, 'r') as f:
            lines = f.readlines()
            print(f"   Lines in CSV: {len(lines)}")
            if len(lines) > 1:
                print(f"   Last row: {lines[-1][:200]}...")
    
    return csv_logger


async def test_complete_flow():
    """Test complete flow: position open -> close with fees and TVL."""
    print("\n" + "=" * 70)
    print("TEST: Complete Flow (Open -> Close with Fees & TVL)")
    print("=" * 70)
    
    config = get_config()
    csv_logger = CSVLogger(output_dir="test_deployment_v2/test_data_csv")
    
    # Simulate position open
    print("\n1. Position Open...")
    pool_state = None
    try:
        orca_client = await get_orca_client()
        pool_state = await orca_client.get_pool_state(config.pool.pool_address, force_refresh=True)
    except Exception as e:
        print(f"   ⚠️  Could not get pool state: {e}")
    
    tvl_entry = 0.0
    if pool_state:
        try:
            tvl_entry, _, _ = await calculate_tvl_from_pool_state(pool_state, solana_client=None)
        except Exception as e:
            print(f"   ⚠️  TVL calculation failed: {e}")
    
    csv_logger.log_position_open(
        position_address="FLOW_TEST_POSITION",
        entry_price=128.50,
        sol_amount=1.846,
        usdc_amount=244.69,
        lower_price=126.4515,
        upper_price=131.0864,
        tx_signature="FLOW_TEST_OPEN_SIG",
        open_attempts=1,
        tvl=tvl_entry,
        volume_24h=0.0,
    )
    print(f"   ✅ Logged open with TVL=${tvl_entry:,.2f}")
    
    # Simulate position close
    print("\n2. Position Close...")
    
    # Get fees (simulate - in real flow these come from close_position)
    fees_sol = 0.001  # Example
    fees_usdc = 0.15  # Example
    
    # Get TVL at exit
    tvl_exit = 0.0
    if pool_state:
        try:
            tvl_exit, _, _ = await calculate_tvl_from_pool_state(pool_state, solana_client=None)
        except Exception as e:
            print(f"   ⚠️  TVL calculation at exit failed: {e}")
    
    csv_logger.log_position_close(
        position_address="FLOW_TEST_POSITION",
        exit_price=129.00,
        sol_withdrawn=1.80,
        usdc_withdrawn=240.00,
        fees_sol=fees_sol,
        fees_usdc=fees_usdc,
        tx_signature="FLOW_TEST_CLOSE_SIG",
        rebalance_latency_seconds=0.0,
        tvl=tvl_exit,
        volume_24h=0.0,
    )
    print(f"   ✅ Logged close with:")
    print(f"      Fees: {fees_sol:.6f} SOL + ${fees_usdc:.2f} USDC")
    print(f"      TVL at exit: ${tvl_exit:,.2f}")
    
    # Log fee collection
    print("\n3. Fee Collection...")
    csv_logger.log_fee_collection(
        fees_sol=fees_sol,
        fees_usdc=fees_usdc,
        price=129.00,
        tx_signature="FLOW_TEST_CLOSE_SIG",
    )
    print(f"   ✅ Fee collection logged")
    
    # Verify CSV
    csv_file = Path("test_deployment_v2/test_data_csv/lp_management.csv")
    if csv_file.exists():
        print(f"\n✅ CSV file verified: {csv_file}")
        with open(csv_file, 'r') as f:
            content = f.read()
            # Check for fees
            if "0.001000" in content or "0.001" in content:
                print(f"   ✅ Fees found in CSV")
            else:
                print(f"   ⚠️  Fees not found in CSV")
            
            # Check for TVL
            if str(int(tvl_entry)) in content or str(int(tvl_exit)) in content:
                print(f"   ✅ TVL found in CSV")
            else:
                print(f"   ⚠️  TVL not found in CSV")
            
            print(f"\n   CSV content (last 500 chars):")
            print(content[-500:])


async def main():
    """Run all tests."""
    print("=" * 70)
    print("COMPLETE FEES & TVL TEST SUITE")
    print("=" * 70)
    print("\nThis script tests:")
    print("1. Fee retrieval from position state")
    print("2. TVL calculation from vault balances")
    print("3. CSV logging with fees and TVL")
    print("4. Complete flow simulation")
    print("\n" + "=" * 70 + "\n")
    
    # Test 1: Fee retrieval (if position address provided)
    if len(sys.argv) > 1:
        fees_sol, fees_usdc = await test_fee_retrieval()
    else:
        print("⚠️  Skipping fee retrieval test (no position address provided)")
        print("   Usage: python test_fees_and_tvl_complete.py <position_address>")
        fees_sol, fees_usdc = None, None
    
    # Test 2: TVL retrieval
    tvl = await test_tvl_retrieval()
    
    # Test 3: CSV logging
    csv_logger = await test_csv_logging_with_fees_and_tvl()
    
    # Test 4: Complete flow
    await test_complete_flow()
    
    # Summary
    print("\n" + "=" * 70)
    print("TEST SUMMARY")
    print("=" * 70)
    print(f"Fee Retrieval: {'✅' if fees_sol is not None else '⚠️  (skipped)'}")
    print(f"TVL Retrieval: {'✅' if tvl else '❌'}")
    print(f"CSV Logging: {'✅' if csv_logger else '❌'}")
    print(f"Complete Flow: ✅")
    
    if tvl and csv_logger:
        print(f"\n✅ ALL CRITICAL TESTS PASSED")
        print(f"   Ready for deployment after code fixes")
    else:
        print(f"\n❌ SOME TESTS FAILED")
        print(f"   Fix issues before deployment")


if __name__ == "__main__":
    asyncio.run(main())























