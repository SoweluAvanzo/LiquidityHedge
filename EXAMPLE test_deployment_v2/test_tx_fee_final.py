#!/usr/bin/env python3
"""Test transaction fee extraction from real transactions"""
import asyncio
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from config import Config
from execution import get_trade_executor
import httpx


async def get_tx_fee(rpc_url: str, sig: str) -> dict:
    """Get transaction fee from RPC"""
    async with httpx.AsyncClient(timeout=30.0) as client:
        r = await client.post(rpc_url, json={
            "jsonrpc": "2.0",
            "id": 1,
            "method": "getTransaction",
            "params": [sig, {"encoding": "jsonParsed", "maxSupportedTransactionVersion": 0}]
        })
        data = r.json()
        result = data.get("result")
        if not result:
            return {"error": "No result"}
        
        fee_lamports = result.get("meta", {}).get("fee", 0)
        return {"fee_lamports": fee_lamports, "fee_sol": fee_lamports / 1e9}


async def main():
    print("=" * 70)
    print("TRANSACTION FEE CALCULATION TEST")
    print("=" * 70)
    
    config = Config()
    executor = await get_trade_executor(config)
    
    # State
    price = (await executor.get_pool_state()).price
    sol, usdc = await executor.get_balances()
    
    print(f"\n1. State: ${price:.2f}, {sol:.4f} SOL, ${usdc:.2f} USDC")
    
    # $20 position
    amt_sol = 10 / price
    amt_usdc = 10.0
    
    print(f"2. Opening ~$20 position ({amt_sol:.4f} SOL + ${amt_usdc})")
    
    if sol < amt_sol + 0.1 or usdc < amt_usdc:
        print("❌ Insufficient balance!")
        return
    
    # Open
    pre_sol = sol
    r = await executor.open_position(
        max_sol=amt_sol,
        max_usdc=amt_usdc,
        lower_price=price*0.985,
        upper_price=price*1.015,
        slippage_bps=50
    )
    
    if not r.success:
        print(f"❌ Open failed!")
        return
    
    print(f"   ✅ {r.position_address[:16]}...")
    print(f"   Sig: {r.signature}")
    
    await asyncio.sleep(2)
    post_sol, _ = await executor.get_balances()
    
    # Get OPEN fee
    open_fee = await get_tx_fee(config.api.rpc_url, r.signature)
    print(f"\n3. OPEN tx fee:")
    print(f"   {open_fee['fee_lamports']:,} lamports = {open_fee['fee_sol']:.9f} SOL")
    print(f"   ${open_fee['fee_sol'] * price:.6f} USD")
    print(f"   Balance change: {post_sol - pre_sol:.6f} SOL")
    
    # Wait
    print(f"\n4. Waiting 30s for fees...")
    await asyncio.sleep(30)
    
    # Close
    print(f"\n5. Closing...")
    pre_close_sol, _ = await executor.get_balances()
    
    c = await executor.close_position(r.position_address, slippage_bps=50)
    if not c.success:
        print(f"❌ Close failed!")
        return
    
    print(f"   ✅ Closed: {c.signature}")
    
    await asyncio.sleep(2)
    post_close_sol, post_close_usdc = await executor.get_balances()
    
    # Get CLOSE fee
    close_fee = await get_tx_fee(config.api.rpc_url, c.signature)
    print(f"\n6. CLOSE tx fee:")
    print(f"   {close_fee['fee_lamports']:,} lamports = {close_fee['fee_sol']:.9f} SOL")
    print(f"   ${close_fee['fee_sol'] * price:.6f} USD")
    print(f"   Balance change: {post_close_sol - pre_close_sol:.6f} SOL")
    
    # Summary
    total_fee = open_fee['fee_sol'] + close_fee['fee_sol']
    total_usd = total_fee * price
    
    print(f"\n" + "=" * 70)
    print("RESULTS")
    print("=" * 70)
    print(f"\nTransaction Costs:")
    print(f"  OPEN:  {open_fee['fee_sol']:.9f} SOL (${open_fee['fee_sol'] * price:.6f})")
    print(f"  CLOSE: {close_fee['fee_sol']:.9f} SOL (${close_fee['fee_sol'] * price:.6f})")
    print(f"  TOTAL: {total_fee:.9f} SOL (${total_usd:.6f})")
    print(f"  % of $20 position: {total_usd / 20 * 100:.3f}%")
    
    net_sol = post_close_sol - pre_sol
    net_usdc = post_close_usdc - usdc
    print(f"\nNet P&L:")
    print(f"  SOL: {net_sol:+.6f}")
    print(f"  USDC: {net_usdc:+.2f}")
    print(f"  Total: ${(net_sol * price) + net_usdc:+.4f}")
    
    print(f"\n" + "=" * 70)
    print("IMPLEMENTATION")
    print("=" * 70)
    print("""
To add to app:

1. After each transaction, call RPC:
   
   getTransaction(signature, {"encoding": "jsonParsed"})
   fee_lamports = result.meta.fee
   fee_sol = fee_lamports / 1e9

2. Update result objects:
   result.tx_fee_sol = fee_sol

3. Add to CSV:
   - "Open TX Fee (SOL)"
   - "Close TX Fee (SOL)"
   - "Total TX Fees (USD)"

4. Include in PnL:
   net_pnl = (exit_value - entry_value) + fees_collected - tx_costs
    """)
    print("=" * 70)


if __name__ == "__main__":
    asyncio.run(main())
