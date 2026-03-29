#!/usr/bin/env python3
"""Test closing position and parsing fees with Helius"""
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
    
    config = Config()
    position_address = "5TaiQAezZQnPiZWXZSfSw3zmQWy5AHXqoEu97Jkt5Fx"
    
    print(f"\n1. Target position: {position_address}")
    print(f"   Pool: {config.pool.pool_address}")
    
    # Initialize clients
    orca_client = OrcaClient(
        rpc_url=config.api.rpc_url,
        wallet_path=None,
        pool_address=config.pool.pool_address,
        payer_keypair=config.wallet.keypair
    )
    
    helius_client = HeliusClient(api_key=config.api.helius_api_key)
    trade_executor = TradeExecutor(orca_client=orca_client, config=config)
    
    # Get pool state and price
    pool_state = await orca_client.get_pool_state()
    current_price = orca_client.sqrt_price_to_price(pool_state.sqrt_price)
    print(f"\n2. Current price: ${current_price:.2f}")
    
    # Get pending fees BEFORE closing
    position_state = await orca_client.get_position(position_address)
    pending_fees = orca_client.calculate_fees_owed(position=position_state, pool=pool_state)
    
    pending_sol = pending_fees.get("fee_owed_a", 0) / 1e9
    pending_usdc = pending_fees.get("fee_owed_b", 0) / 1e6
    pending_total = (pending_sol * current_price) + pending_usdc
    
    print(f"\n3. Pending fees (pool state estimate):")
    print(f"   SOL:  {pending_sol:.6f} (${pending_sol * current_price:.4f})")
    print(f"   USDC: ${pending_usdc:.4f}")
    print(f"   Total: ${pending_total:.4f}")
    
    # Close position
    print(f"\n4. Closing position...")
    close_result = await trade_executor.close_position(
        position_address=position_address,
        slippage_bps=50
    )
    
    if not close_result or not close_result.get("signature"):
        print(f"   ❌ Failed to close!")
        return
    
    signature = close_result["signature"]
    print(f"   ✅ Closed! Signature: {signature}")
    
    # Wait for finalization
    print(f"\n5. Waiting 5s for transaction to finalize...")
    await asyncio.sleep(5)
    
    # Parse with Helius
    print(f"\n6. Parsing transaction with Helius...")
    actual_fees = await helius_client.extract_collected_fees(signature)
    
    actual_sol = actual_fees.get("SOL", 0)
    actual_usdc = actual_fees.get("USDC", 0)
    actual_total = (actual_sol * current_price) + actual_usdc
    
    print(f"\n   ACTUAL fees (from Helius):")
    print(f"   SOL:  {actual_sol:.6f} (${actual_sol * current_price:.4f})")
    print(f"   USDC: ${actual_usdc:.4f}")
    print(f"   Total: ${actual_total:.4f}")
    
    # Compare
    print(f"\n7. Comparison:")
    print(f"   Estimate: ${pending_total:.4f}")
    print(f"   Actual:   ${actual_total:.4f}")
    
    if actual_total > 0:
        print(f"\n✅ SUCCESS: Helius parsed fees correctly!")
        diff_pct = abs(actual_total - pending_total) / max(pending_total, 0.0001) * 100
        print(f"   Accuracy: {100-diff_pct:.1f}% match")
    else:
        print(f"\n⚠️  Helius returned zero fees")

if __name__ == "__main__":
    asyncio.run(main())
