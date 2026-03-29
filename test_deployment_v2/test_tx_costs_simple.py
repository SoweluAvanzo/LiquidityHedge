#!/usr/bin/env python3
"""Test transaction cost calculation with real position"""
import asyncio
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from config import Config
from execution import get_trade_executor
import httpx


async def get_tx_fee(rpc_url: str, signature: str) -> dict:
    """Extract transaction fee from RPC."""
    async with httpx.AsyncClient(timeout=30.0) as client:
        payload = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "getTransaction",
            "params": [signature, {"encoding": "jsonParsed", "maxSupportedTransactionVersion": 0}]
        }
        resp = await client.post(rpc_url, json=payload)
        data = resp.json()
        
        result = data.get("result")
        if not result:
            return {"error": "No result"}
        
        meta = result.get("meta", {})
        fee_lamports = meta.get("fee", 0)
        
        return {
            "fee_lamports": fee_lamports,
            "fee_sol": fee_lamports / 1e9,
            "err": meta.get("err")
        }


async def main():
    print("=" * 70)
    print("TRANSACTION COST TEST - $20 Position")
    print("=" * 70)
    
    config = Config()
    trade_executor = await get_trade_executor(config)
    
    # Get state
    pool_state = await trade_executor._orca_client.get_pool_state()
    price = trade_executor._orca_client.sqrt_price_to_price(pool_state.sqrt_price)
    sol_bal, usdc_bal = await trade_executor.get_balances()
    
    print(f"\n1. Current state:")
    print(f"   Price: ${price:.2f}")
    print(f"   Wallet: {sol_bal:.4f} SOL, ${usdc_bal:.2f} USDC")
    
    # $20 position ($10 SOL + $10 USDC)
    test_sol = 10 / price
    test_usdc = 10.0
    
    print(f"\n2. Position size (~$20):")
    print(f"   {test_sol:.4f} SOL (~$10)")
    print(f"   ${test_usdc} USDC")
    
    if sol_bal < test_sol + 0.1 or usdc_bal < test_usdc:
        print(f"\n❌ Insufficient balance!")
        return
    
    # Range
    lower = price * 0.985
    upper = price * 1.015
    
    print(f"\n3. Opening position...")
    pre_open_sol = sol_bal
    
    result = await trade_executor.open_position(
        max_sol=test_sol,
        max_usdc=test_usdc,
        lower_price=lower,
        upper_price=upper,
        slippage_bps=50
    )
    
    if not result.success:
        print(f"❌ Failed to open!")
        return
    
    print(f"   ✅ Opened: {result.position_address}")
    print(f"   Signature: {result.signature}")
    
    await asyncio.sleep(2)
    post_open_sol, _ = await trade_executor.get_balances()
    
    # Parse OPEN tx
    open_fee = await get_tx_fee(config.api.rpc_url, result.signature)
    
    print(f"\n4. OPEN Transaction:")
    print(f"   Fee: {open_fee['fee_lamports']:,} lamports = {open_fee['fee_sol']:.9f} SOL")
    print(f"   USD: ${open_fee['fee_sol'] * price:.6f}")
    print(f"   Balance: {pre_open_sol:.6f} → {post_open_sol:.6f} ({post_open_sol - pre_open_sol:.6f})")
    
    # Wait
    print(f"\n5. Waiting 30s...")
    await asyncio.sleep(30)
    
    # Close
    print(f"\n6. Closing position...")
    pre_close_sol, _ = await trade_executor.get_balances()
    
    close_result = await trade_executor.close_position(
        position_address=result.position_address,
        slippage_bps=50
    )
    
    if not close_result.success:
        print(f"❌ Failed to close!")
        return
    
    print(f"   ✅ Closed!")
    print(f"   Signature: {close_result.signature}")
    
    await asyncio.sleep(2)
    post_close_sol, post_close_usdc = await trade_executor.get_balances()
    
    # Parse CLOSE tx
    close_fee = await get_tx_fee(config.api.rpc_url, close_result.signature)
    
    print(f"\n7. CLOSE Transaction:")
    print(f"   Fee: {close_fee['fee_lamports']:,} lamports = {close_fee['fee_sol']:.9f} SOL")
    print(f"   USD: ${close_fee['fee_sol'] * price:.6f}")
    print(f"   Balance: {pre_close_sol:.6f} → {post_close_sol:.6f} ({post_close_sol - pre_close_sol:.6f})")
    
    # Summary
    total_fee_sol = open_fee['fee_sol'] + close_fee['fee_sol']
    total_fee_usd = total_fee_sol * price
    
    net_sol = post_close_sol - pre_open_sol
    net_usdc = post_close_usdc - usdc_bal
    
    print(f"\n" + "=" * 70)
    print("SUMMARY")
    print("=" * 70)
    print(f"\nTransaction Costs:")
    print(f"  OPEN:  {open_fee['fee_sol']:.9f} SOL (${open_fee['fee_sol'] * price:.6f})")
    print(f"  CLOSE: {close_fee['fee_sol']:.9f} SOL (${close_fee['fee_sol'] * price:.6f})")
    print(f"  TOTAL: {total_fee_sol:.9f} SOL (${total_fee_usd:.6f})")
    print(f"  % of position: {total_fee_usd / 20 * 100:.3f}%")
    
    print(f"\nNet Result:")
    print(f"  SOL: {net_sol:+.6f}")
    print(f"  USDC: {net_usdc:+.2f}")
    print(f"  USD: ${(net_sol * price) + net_usdc:+.4f}")
    
    print(f"\n" + "=" * 70)
    print("IMPLEMENTATION APPROACH")
    print("=" * 70)
    print("""
RPC method to get transaction fee:

getTransaction(signature, {
  "encoding": "jsonParsed",
  "maxSupportedTransactionVersion": 0
})

Extract: result.meta.fee (in lamports)
Convert: fee_sol = fee_lamports / 1e9

This is RELIABLE and can be added to:
- PositionOpenResult.tx_fee_sol
- PositionCloseResult.tx_fee_sol  
- SwapResult.tx_fee_sol
- CSV columns
    """)


if __name__ == "__main__":
    asyncio.run(main())
