#!/usr/bin/env python3
"""
Real Data Retrieval Test - Deployment Scenario

Tests actual data retrieval in deployment-like conditions:
1. Orca API TVL/Volume retrieval
2. On-chain TVL calculation
3. Position data retrieval (if position exists)
4. Fee estimation (if position exists)
5. Optionally opens a small test position

Uses the same wallet and configuration as the deployed app.
"""

import asyncio
import sys
import os
from pathlib import Path
from decimal import Decimal
from dotenv import load_dotenv

# Add project root to path
project_root = Path(__file__).parent.parent
sys.path.insert(0, str(project_root))

load_dotenv()

from test_deployment_v2.config import get_config
from test_deployment_v2.app.chain.orca_client import get_orca_client
from test_deployment_v2.app.chain.orca_api_client import get_orca_api_client
from test_deployment_v2.pool_metrics_calculator import calculate_tvl_from_pool_state


async def test_orca_api_tvl_retrieval():
    """Test TVL retrieval from Orca API."""
    print("=" * 70)
    print("TEST 1: Orca API TVL/Volume Retrieval")
    print("=" * 70)
    
    config = get_config()
    pool_address = config.pool.pool_address
    
    print(f"\nPool Address: {pool_address}")
    print(f"Attempting to fetch metrics from Orca API...")
    
    try:
        api_client = get_orca_api_client()
        metrics = await api_client.get_pool_metrics(pool_address)
        
        if metrics:
            print(f"\n✅ Orca API SUCCESS:")
            print(f"   TVL: ${metrics.tvl:,.2f}" if metrics.tvl else "   TVL: None")
            print(f"   Volume 24h: ${metrics.volume_24h:,.2f}" if metrics.volume_24h else "   Volume 24h: None")
            print(f"   Volume 7d: ${metrics.volume_7d:,.2f}" if metrics.volume_7d else "   Volume 7d: None")
            print(f"   Fee Rate: {metrics.fee_rate:.4f}" if metrics.fee_rate else "   Fee Rate: None")
            print(f"   Price: ${metrics.price:.4f}" if metrics.price else "   Price: None")
            return metrics.tvl, metrics.volume_24h, None
        else:
            error_msg = "API returned None"
            print(f"\n❌ Orca API FAILED: {error_msg}")
            return None, None, error_msg
            
    except Exception as e:
        error_msg = f"API exception: {str(e)[:100]}"
        print(f"\n❌ Orca API FAILED: {error_msg}")
        import traceback
        traceback.print_exc()
        return None, None, error_msg


async def test_onchain_tvl_calculation():
    """Test TVL calculation from on-chain data."""
    print("\n" + "=" * 70)
    print("TEST 2: On-Chain TVL Calculation")
    print("=" * 70)
    
    config = get_config()
    pool_address = config.pool.pool_address
    
    print(f"\nPool Address: {pool_address}")
    print(f"Fetching pool state from blockchain...")
    
    try:
        orca_client = await get_orca_client()
        pool_state = await orca_client.get_pool_state(pool_address, force_refresh=True)
        
        if not pool_state:
            error_msg = "Failed to get pool state"
            print(f"\n❌ On-Chain FAILED: {error_msg}")
            return None, None, None, error_msg
        
        print(f"\n✅ Pool State Retrieved:")
        print(f"   Current Price: ${pool_state.current_price:.4f}")
        print(f"   Tick Current: {pool_state.tick_current_index}")
        print(f"   Vault A: {pool_state.token_vault_a}")
        print(f"   Vault B: {pool_state.token_vault_b}")
        
        # Calculate TVL
        print(f"\nCalculating TVL from vault balances...")
        tvl_usd, sol_bal, usdc_bal = await calculate_tvl_from_pool_state(
            pool_state,
            solana_client=None
        )
        
        if tvl_usd > 0:
            print(f"\n✅ On-Chain TVL Calculation SUCCESS:")
            print(f"   TVL: ${tvl_usd:,.2f}")
            print(f"   SOL Balance: {sol_bal:.2f} SOL")
            print(f"   USDC Balance: ${usdc_bal:,.2f}")
            return tvl_usd, sol_bal, usdc_bal, None
        else:
            error_msg = "TVL calculation returned 0"
            print(f"\n❌ On-Chain TVL Calculation FAILED: {error_msg}")
            return None, None, None, error_msg
            
    except Exception as e:
        error_msg = f"On-chain exception: {str(e)[:100]}"
        print(f"\n❌ On-Chain FAILED: {error_msg}")
        import traceback
        traceback.print_exc()
        return None, None, None, error_msg


async def test_position_data_retrieval(position_address: str = None):
    """Test retrieving data from an existing position."""
    print("\n" + "=" * 70)
    print("TEST 3: Position Data Retrieval")
    print("=" * 70)
    
    if not position_address:
        print("\n⚠️  No position address provided - skipping position data test")
        print("   To test with a real position, provide address as argument:")
        print("   python test_real_data_retrieval.py <position_address>")
        return None, None, None
    
    print(f"\nPosition Address: {position_address}")
    
    try:
        orca_client = await get_orca_client()
        
        # Get position state
        print(f"\nFetching position state...")
        position_state = await orca_client.get_position_state(position_address)
        
        if not position_state:
            error_msg = "Position state not found"
            print(f"\n❌ Position Retrieval FAILED: {error_msg}")
            return None, None, error_msg
        
        print(f"\n✅ Position State Retrieved:")
        print(f"   Liquidity: {position_state.liquidity:,}")
        print(f"   Tick Lower: {position_state.tick_lower_index}")
        print(f"   Tick Upper: {position_state.tick_upper_index}")
        print(f"   Fee Owed A: {position_state.fee_owed_a}")
        print(f"   Fee Owed B: {position_state.fee_owed_b}")
        
        # Estimate fees
        print(f"\nEstimating fees...")
        fees_sol_decimal, fees_usdc_decimal = await orca_client.estimate_fees_earned(
            position_pubkey=position_address
        )
        fees_sol = float(fees_sol_decimal)
        fees_usdc = float(fees_usdc_decimal)
        
        print(f"\n✅ Fee Estimation SUCCESS:")
        print(f"   Fees SOL: {fees_sol:.6f}")
        print(f"   Fees USDC: ${fees_usdc:.2f}")
        print(f"   Total Fees (at $128/SOL): ${(fees_sol * 128) + fees_usdc:.2f}")
        
        return fees_sol, fees_usdc, None
        
    except Exception as e:
        error_msg = f"Position retrieval exception: {str(e)[:100]}"
        print(f"\n❌ Position Retrieval FAILED: {error_msg}")
        import traceback
        traceback.print_exc()
        return None, None, error_msg


async def test_open_small_position():
    """Test opening a very small position to verify end-to-end flow."""
    print("\n" + "=" * 70)
    print("TEST 4: Open Small Test Position (Optional)")
    print("=" * 70)
    
    print("\n⚠️  This test will open a REAL position on mainnet")
    print("   It will use minimal amounts (0.01 SOL + $1 USDC)")
    print("   Do you want to proceed? (This requires confirmation)")
    
    # For safety, require explicit confirmation
    response = input("\nType 'YES' to proceed with opening test position: ")
    if response != "YES":
        print("   Test skipped - no position opened")
        return None
    
    config = get_config()
    
    # Check if dry_run is enabled
    if config.api.dry_run:
        print("\n⚠️  DRY_RUN mode is enabled - position will not actually open")
        print("   Set DRY_RUN=false in config to open real position")
        return None
    
    try:
        from test_deployment_v2.execution import TradeExecutor
        from test_deployment_v2.market_analyzer import MarketAnalyzer
        
        # Get market state
        market_analyzer = MarketAnalyzer(config)
        market_state = await market_analyzer.get_market_state()
        
        print(f"\nCurrent Price: ${market_state.price:.4f}")
        print(f"Range Targets: ${market_state.lower_target:.4f} - ${market_state.upper_target:.4f}")
        
        # Create trade executor
        trade_executor = TradeExecutor(config)
        
        # Calculate small amounts
        test_sol = 0.01  # 0.01 SOL
        test_usdc = 1.0  # $1 USDC
        
        print(f"\nOpening test position with:")
        print(f"   SOL: {test_sol:.4f}")
        print(f"   USDC: ${test_usdc:.2f}")
        
        # Calculate ticks
        from test_deployment_v2.execution import calculate_range
        lower_tick, upper_tick = calculate_range(
            market_state.lower_target,
            market_state.upper_target,
            config.pool.tick_spacing
        )
        
        # Open position
        open_result, swap_result = await trade_executor.open_position_with_rebalance(
            lower_tick=lower_tick,
            upper_tick=upper_tick,
            max_sol=test_sol,
            max_usdc=test_usdc,
            liquidity=0,  # Will be calculated
        )
        
        if open_result and open_result.success:
            print(f"\n✅ Test Position Opened Successfully:")
            print(f"   Position Address: {open_result.position_address}")
            print(f"   Signature: {open_result.signature}")
            print(f"   Deposited SOL: {open_result.deposited_sol:.6f}")
            print(f"   Deposited USDC: ${open_result.deposited_usdc:.2f}")
            
            # Now test retrieving data from this position
            print(f"\nTesting data retrieval from new position...")
            fees_sol, fees_usdc, error = await test_position_data_retrieval(
                open_result.position_address
            )
            
            return open_result.position_address
        else:
            error_msg = open_result.error if open_result else "Unknown error"
            print(f"\n❌ Test Position Opening FAILED: {error_msg}")
            return None
            
    except Exception as e:
        error_msg = f"Position opening exception: {str(e)[:100]}"
        print(f"\n❌ Test Position Opening FAILED: {error_msg}")
        import traceback
        traceback.print_exc()
        return None


async def main():
    """Run all tests."""
    print("=" * 70)
    print("REAL DATA RETRIEVAL TEST - DEPLOYMENT SCENARIO")
    print("=" * 70)
    print("\nThis test verifies actual data retrieval works in deployment conditions.")
    print("It tests:")
    print("1. Orca API TVL/Volume retrieval")
    print("2. On-chain TVL calculation")
    print("3. Position data retrieval (if position provided)")
    print("4. Optional: Open small test position")
    print("\n" + "=" * 70 + "\n")
    
    # Test 1: Orca API
    api_tvl, api_volume, api_error = await test_orca_api_tvl_retrieval()
    
    # Test 2: On-chain calculation
    onchain_tvl, sol_bal, usdc_bal, onchain_error = await test_onchain_tvl_calculation()
    
    # Test 3: Position data (if address provided)
    position_address = sys.argv[1] if len(sys.argv) > 1 else None
    fees_sol, fees_usdc, pos_error = await test_position_data_retrieval(position_address)
    
    # Test 4: Optional - open small position
    # Uncomment to enable:
    # new_position = await test_open_small_position()
    
    # Summary
    print("\n" + "=" * 70)
    print("TEST SUMMARY")
    print("=" * 70)
    
    print(f"\n1. Orca API TVL Retrieval:")
    if api_tvl:
        print(f"   ✅ SUCCESS - TVL: ${api_tvl:,.2f}")
    else:
        print(f"   ❌ FAILED - {api_error}")
    
    print(f"\n2. On-Chain TVL Calculation:")
    if onchain_tvl:
        print(f"   ✅ SUCCESS - TVL: ${onchain_tvl:,.2f}")
    else:
        print(f"   ❌ FAILED - {onchain_error}")
    
    print(f"\n3. Position Data Retrieval:")
    if position_address:
        if fees_sol is not None:
            print(f"   ✅ SUCCESS - Fees: {fees_sol:.6f} SOL, ${fees_usdc:.2f} USDC")
        else:
            print(f"   ❌ FAILED - {pos_error}")
    else:
        print(f"   ⚠️  SKIPPED - No position address provided")
    
    # Conclusions
    print("\n" + "=" * 70)
    print("CONCLUSIONS")
    print("=" * 70)
    
    if api_tvl or onchain_tvl:
        print("\n✅ TVL RETRIEVAL WORKS:")
        if api_tvl:
            print(f"   - Orca API: ${api_tvl:,.2f}")
        if onchain_tvl:
            print(f"   - On-chain: ${onchain_tvl:,.2f}")
        print("\n   → If CSV shows empty TVL, the problem is in the integration")
        print("     (error not captured, not passed to CSV logger, etc.)")
    else:
        print("\n❌ TVL RETRIEVAL FAILS:")
        print(f"   - Orca API: {api_error}")
        print(f"   - On-chain: {onchain_error}")
        print("\n   → This explains why CSV shows empty TVL")
        print("     Need to fix the underlying retrieval issue")
    
    if position_address and fees_sol is not None:
        print("\n✅ POSITION DATA RETRIEVAL WORKS:")
        print(f"   - Fees can be retrieved: {fees_sol:.6f} SOL, ${fees_usdc:.2f} USDC")
        print("\n   → If CSV shows empty fees, the problem is in the integration")
    elif position_address:
        print("\n❌ POSITION DATA RETRIEVAL FAILS:")
        print(f"   - Error: {pos_error}")
        print("\n   → This explains why CSV shows empty fees")
    else:
        print("\n⚠️  POSITION DATA NOT TESTED:")
        print("   - Provide position address to test fee retrieval")


if __name__ == "__main__":
    asyncio.run(main())

