#!/usr/bin/env python3
"""
Test script to close current position and parse fees using Helius.
Should match the exact method used in the app.
"""
import asyncio
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from config import Config
from app.chain.orca_client import OrcaClient
from app.chain.helius_client import HeliusClient
from execution import TradeExecutor


async def main():
    print("=" * 70)
    print("TEST: Close Position and Parse Fees with Helius")
    print("=" * 70)

    # Load configuration
    config = Config()
    
    print(f"\n✓ Configuration loaded")
    print(f"  Helius API Key: {config.api.helius_api_key[:20]}..." if config.api.helius_api_key else "  ❌ No Helius API Key")
    
    if not config.api.helius_api_key:
        print("\n❌ ERROR: HELIUS_API_KEY not set!")
        return

    # Initialize clients
    orca_client = OrcaClient(
        rpc_url=config.api.rpc_url,
        wallet_path=None,
        pool_address=config.pool.pool_address,
        payer_keypair=config.get_payer_keypair()
    )

    helius_client = HeliusClient(api_key=config.api.helius_api_key)
    
    trade_executor = TradeExecutor(
        orca_client=orca_client,
        config=config
    )

    print(f"✓ Clients initialized")

    # Get current price
    pool_state = await orca_client.get_pool_state()
    current_price = orca_client.sqrt_price_to_price(pool_state.sqrt_price)
    
    print(f"\n✓ Current SOL/USDC price: ${current_price:.2f}")

    # Find open position
    print(f"\n1. Looking for open positions...")
    positions = await orca_client.get_positions_by_owner(config.get_payer_keypair().pubkey())
    
    if not positions:
        print(f"   ❌ No open positions found!")
        return
    
    position_address = str(positions[0])
    print(f"   ✓ Found position: {position_address}")

    # Get position state and calculate pending fees
    print(f"\n2. Calculating pending fees from pool state...")
    position_state = await orca_client.get_position(position_address)
    pending_fees = orca_client.calculate_fees_owed(position=position_state, pool=pool_state)
    
    pending_fees_sol = pending_fees.get("fee_owed_a", 0) / 1e9
    pending_fees_usdc = pending_fees.get("fee_owed_b", 0) / 1e6
    pending_fees_total = (pending_fees_sol * current_price) + pending_fees_usdc
    
    print(f"   Pending fees (from pool state):")
    print(f"   - SOL:  {pending_fees_sol:.6f} SOL (${pending_fees_sol * current_price:.4f})")
    print(f"   - USDC: ${pending_fees_usdc:.4f}")
    print(f"   - Total: ${pending_fees_total:.4f}")

    # Close position
    print(f"\n3. Closing position...")
    close_result = await trade_executor.close_position(
        position_address=position_address,
        slippage_bps=50
    )

    if not close_result or not close_result.get("signature"):
        print(f"   ❌ Failed to close position!")
        print(f"   Result: {close_result}")
        return

    close_signature = close_result["signature"]
    sol_withdrawn = close_result.get("sol_withdrawn", 0)
    usdc_withdrawn = close_result.get("usdc_withdrawn", 0)

    print(f"   ✓ Position closed successfully!")
    print(f"   - Signature: {close_signature}")
    print(f"   - Withdrawn: {sol_withdrawn:.6f} SOL + ${usdc_withdrawn:.2f} USDC")

    # Wait for transaction to be fully processed
    print(f"\n4. Waiting for transaction to propagate...")
    await asyncio.sleep(5)

    # Parse transaction with Helius (EXACT METHOD FROM APP)
    print(f"\n5. Parsing transaction with Helius...")
    print(f"   Using the EXACT method from lp_strategy.py")
    
    try:
        actual_fees = await helius_client.extract_collected_fees(close_signature)
        
        actual_fees_sol = actual_fees.get("SOL", 0)
        actual_fees_usdc = actual_fees.get("USDC", 0)
        actual_fees_total = (actual_fees_sol * current_price) + actual_fees_usdc
        
        print(f"\n   ✓ Helius parsing completed!")
        print(f"\n   Actual fees collected (from Helius):")
        print(f"   - SOL:  {actual_fees_sol:.6f} SOL (${actual_fees_sol * current_price:.4f})")
        print(f"   - USDC: ${actual_fees_usdc:.4f}")
        print(f"   - Total: ${actual_fees_total:.4f}")
        
    except Exception as e:
        print(f"   ❌ Helius parsing failed: {e}")
        import traceback
        traceback.print_exc()
        return

    # Comparison
    print(f"\n" + "=" * 70)
    print(f"COMPARISON:")
    print(f"=" * 70)
    print(f"\n{'Method':<25} | {'SOL Fees':<12} | {'USDC Fees':<10} | {'Total USD':<10}")
    print(f"-" * 70)
    print(f"{'Pool State (estimate)':<25} | {pending_fees_sol:>12.6f} | ${pending_fees_usdc:>9.4f} | ${pending_fees_total:>9.4f}")
    print(f"{'Helius Parse (actual)':<25} | {actual_fees_sol:>12.6f} | ${actual_fees_usdc:>9.4f} | ${actual_fees_total:>9.4f}")
    
    # Validate
    print(f"\n" + "=" * 70)
    print(f"VALIDATION:")
    print(f"=" * 70)
    
    if actual_fees_total > 0:
        print(f"✓ SUCCESS: Helius successfully parsed fees from transaction!")
        print(f"✓ Method works correctly!")
        
        # Check accuracy
        if pending_fees_total > 0:
            diff_pct = abs(actual_fees_total - pending_fees_total) / pending_fees_total * 100
            print(f"\nAccuracy: {diff_pct:.1f}% difference between estimate and actual")
            
            if diff_pct < 5:
                print(f"✓ Excellent match (< 5% difference)")
            elif diff_pct < 15:
                print(f"✓ Good match (< 15% difference)")
            else:
                print(f"⚠️  Significant difference - may need investigation")
    else:
        print(f"⚠️  WARNING: Helius returned zero fees")
        if pending_fees_total > 0:
            print(f"   Pool state showed ${pending_fees_total:.4f} in fees")
            print(f"   Possible reasons:")
            print(f"   - Transaction not fully indexed yet")
            print(f"   - Fees below minimum threshold")
            print(f"   - Parsing method needs adjustment")
    
    print(f"\n" + "=" * 70)
    print(f"TEST COMPLETE")
    print(f"=" * 70)


if __name__ == "__main__":
    asyncio.run(main())
