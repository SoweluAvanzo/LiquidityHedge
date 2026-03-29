#!/usr/bin/env python3
"""
Test script to verify on-chain data retrieval for TVL and Fees.

This script tests different methods to retrieve:
1. Pool TVL from vault balances
2. Position fees from position state
3. Pool metrics from various sources

Run this BEFORE modifying the main implementation to ensure methods work.
"""

import asyncio
import os
import sys
from pathlib import Path
from dotenv import load_dotenv

# Add project root to path
project_root = Path(__file__).parent.parent
sys.path.insert(0, str(project_root))

load_dotenv()

from test_deployment_v2.config import get_config
from test_deployment_v2.app.chain.orca_client import get_orca_client
from test_deployment_v2.app.chain.solana_client import get_solana_client
from test_deployment_v2.app.chain.mainnet_client import get_mainnet_client
from test_deployment_v2.pool_metrics_calculator import calculate_tvl_from_pool_state


async def test_pool_state_retrieval():
    """Test 1: Can we get pool state with vault addresses?"""
    print("=" * 70)
    print("TEST 1: Pool State Retrieval")
    print("=" * 70)
    
    config = get_config()
    pool_address = config.pool.pool_address
    
    try:
        orca_client = await get_orca_client()
        pool_state = await orca_client.get_pool_state(pool_address, force_refresh=True)
        
        print(f"✅ Pool state retrieved")
        print(f"   Pool: {pool_address[:16]}...")
        print(f"   Price: ${pool_state.current_price:.4f}")
        print(f"   Tick spacing: {pool_state.tick_spacing}")
        print(f"   Liquidity: {pool_state.liquidity}")
        
        # Check vault addresses
        has_vault_a = hasattr(pool_state, 'token_vault_a') and pool_state.token_vault_a
        has_vault_b = hasattr(pool_state, 'token_vault_b') and pool_state.token_vault_b
        
        print(f"\n   Vault addresses:")
        print(f"   - token_vault_a: {'✅' if has_vault_a else '❌'} {pool_state.token_vault_a if has_vault_a else 'MISSING'}")
        print(f"   - token_vault_b: {'✅' if has_vault_b else '❌'} {pool_state.token_vault_b if has_vault_b else 'MISSING'}")
        
        if not has_vault_a or not has_vault_b:
            print("\n❌ PROBLEM: Pool state missing vault addresses!")
            return None
        
        return pool_state
        
    except Exception as e:
        print(f"❌ Failed to get pool state: {e}")
        import traceback
        traceback.print_exc()
        return None


async def test_vault_balance_retrieval(pool_state):
    """Test 2: Can we get vault balances?"""
    print("\n" + "=" * 70)
    print("TEST 2: Vault Balance Retrieval")
    print("=" * 70)
    
    if not pool_state:
        print("❌ Skipping: No pool state available")
        return None, None
    
    vault_a = pool_state.token_vault_a
    vault_b = pool_state.token_vault_b
    
    print(f"Vault A (SOL): {vault_a}")
    print(f"Vault B (USDC): {vault_b}")
    
    # Method 1: Mainnet client
    print("\n--- Method 1: Mainnet Client ---")
    try:
        mainnet_client = await get_mainnet_client()
        sol_balance_base = await mainnet_client.get_token_account_balance(vault_a)
        usdc_balance_base = await mainnet_client.get_token_account_balance(vault_b)
        
        sol_balance = float(sol_balance_base) / 1e9
        usdc_balance = float(usdc_balance_base) / 1e6
        
        print(f"✅ Mainnet client: SOL={sol_balance:.2f}, USDC=${usdc_balance:.2f}")
        return sol_balance, usdc_balance
        
    except Exception as e:
        print(f"❌ Mainnet client failed: {e}")
    
    # Method 2: Solana client
    print("\n--- Method 2: Solana Client ---")
    try:
        solana_client = await get_solana_client()
        sol_balance_info = await solana_client.get_token_balance(vault_a)
        usdc_balance_info = await solana_client.get_token_balance(vault_b)
        
        if sol_balance_info and usdc_balance_info:
            sol_balance = float(sol_balance_info.get("ui_amount", 0))
            usdc_balance = float(usdc_balance_info.get("ui_amount", 0))
            print(f"✅ Solana client: SOL={sol_balance:.2f}, USDC=${usdc_balance:.2f}")
            return sol_balance, usdc_balance
        else:
            print(f"❌ Solana client returned None")
    except Exception as e:
        print(f"❌ Solana client failed: {e}")
        import traceback
        traceback.print_exc()
    
    return None, None


async def test_tvl_calculation(pool_state, sol_balance, usdc_balance):
    """Test 3: Can we calculate TVL?"""
    print("\n" + "=" * 70)
    print("TEST 3: TVL Calculation")
    print("=" * 70)
    
    if not pool_state or sol_balance is None or usdc_balance is None:
        print("❌ Skipping: Missing required data")
        return None
    
    try:
        current_price = pool_state.current_price
        sol_value_usd = sol_balance * current_price
        tvl_usd = sol_value_usd + usdc_balance
        
        print(f"✅ TVL Calculation:")
        print(f"   SOL balance: {sol_balance:.2f} SOL")
        print(f"   USDC balance: ${usdc_balance:.2f}")
        print(f"   Current price: ${current_price:.4f}")
        print(f"   SOL value: ${sol_value_usd:.2f}")
        print(f"   TVL: ${tvl_usd:,.2f}")
        
        return tvl_usd
        
    except Exception as e:
        print(f"❌ TVL calculation failed: {e}")
        import traceback
        traceback.print_exc()
        return None


async def test_tvl_calculator_function(pool_state):
    """Test 4: Does the calculate_tvl_from_pool_state function work?"""
    print("\n" + "=" * 70)
    print("TEST 4: TVL Calculator Function")
    print("=" * 70)
    
    if not pool_state:
        print("❌ Skipping: No pool state available")
        return None
    
    try:
        tvl_usd, sol_bal, usdc_bal = await calculate_tvl_from_pool_state(
            pool_state,
            solana_client=None
        )
        
        if tvl_usd > 0:
            print(f"✅ calculate_tvl_from_pool_state worked!")
            print(f"   TVL: ${tvl_usd:,.2f}")
            print(f"   SOL: {sol_bal:.2f}")
            print(f"   USDC: ${usdc_bal:.2f}")
            return tvl_usd
        else:
            print(f"❌ calculate_tvl_from_pool_state returned 0")
            return None
            
    except Exception as e:
        print(f"❌ calculate_tvl_from_pool_state failed: {e}")
        import traceback
        traceback.print_exc()
        return None


async def test_position_fees(position_address: str):
    """Test 5: Can we get position fees?"""
    print("\n" + "=" * 70)
    print("TEST 5: Position Fees Retrieval")
    print("=" * 70)
    
    if not position_address:
        print("⚠️  No position address provided - skipping")
        return None, None
    
    try:
        orca_client = await get_orca_client()
        
        # Method 1: estimate_fees_earned
        print(f"\n--- Method 1: estimate_fees_earned ---")
        fees_sol, fees_usdc = await orca_client.estimate_fees_earned(position_address)
        print(f"✅ estimate_fees_earned: SOL={float(fees_sol):.6f}, USDC=${float(fees_usdc):.2f}")
        
        # Method 2: Get position state directly
        print(f"\n--- Method 2: Direct Position State ---")
        position_state = await orca_client.get_position_state(position_address)
        if position_state:
            fee_owed_a = float(position_state.fee_owed_a) / 1e9
            fee_owed_b = float(position_state.fee_owed_b) / 1e6
            print(f"✅ Position state: fee_owed_a={fee_owed_a:.6f} SOL, fee_owed_b=${fee_owed_b:.2f} USDC")
            print(f"   Liquidity: {position_state.liquidity}")
            print(f"   Tick range: [{position_state.tick_lower_index}, {position_state.tick_upper_index}]")
        else:
            print(f"❌ Position state is None")
        
        return fees_sol, fees_usdc
        
    except Exception as e:
        print(f"❌ Fee retrieval failed: {e}")
        import traceback
        traceback.print_exc()
        return None, None


async def main():
    """Run all tests."""
    print("=" * 70)
    print("ON-CHAIN DATA RETRIEVAL TEST")
    print("=" * 70)
    print("\nThis script tests methods to retrieve TVL and Fees from on-chain data.")
    print("Run this BEFORE modifying the main implementation.\n")
    
    # Test 1: Pool state
    pool_state = await test_pool_state_retrieval()
    
    # Test 2: Vault balances
    sol_balance, usdc_balance = await test_vault_balance_retrieval(pool_state)
    
    # Test 3: TVL calculation
    tvl = await test_tvl_calculation(pool_state, sol_balance, usdc_balance)
    
    # Test 4: TVL calculator function
    tvl_from_function = await test_tvl_calculator_function(pool_state)
    
    # Test 5: Position fees (if position address provided)
    # Get a recent position from CSV if available
    position_address = None
    try:
        csv_path = Path("test_deployment_v2/data/lp_management.csv")
        if csv_path.exists():
            import csv
            with open(csv_path, 'r') as f:
                reader = csv.DictReader(f)
                rows = list(reader)
                if rows:
                    # Try to get position address from most recent entry
                    # Position address might be in a different column
                    print(f"\n⚠️  Note: To test position fees, provide a position address")
    except Exception:
        pass
    
    if position_address:
        fees_sol, fees_usdc = await test_position_fees(position_address)
    else:
        print("\n" + "=" * 70)
        print("TEST 5: Position Fees (Skipped - no position address)")
        print("=" * 70)
        print("⚠️  To test fees, provide a position address from a recent position")
    
    # Summary
    print("\n" + "=" * 70)
    print("TEST SUMMARY")
    print("=" * 70)
    print(f"Pool State: {'✅' if pool_state else '❌'}")
    print(f"Vault Balances: {'✅' if sol_balance and usdc_balance else '❌'}")
    print(f"TVL Calculation: {'✅' if tvl else '❌'}")
    print(f"TVL Function: {'✅' if tvl_from_function else '❌'}")
    
    if pool_state and (sol_balance or usdc_balance):
        print(f"\n✅ READY: On-chain data retrieval works!")
        print(f"   You can proceed with implementation fixes.")
    else:
        print(f"\n❌ NOT READY: Some tests failed.")
        print(f"   Fix issues before modifying implementation.")


if __name__ == "__main__":
    asyncio.run(main())






















