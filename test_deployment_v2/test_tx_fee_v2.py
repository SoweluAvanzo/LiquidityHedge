#!/usr/bin/env python3
import asyncio, sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from config import Config
from execution import get_trade_executor
import httpx

async def get_fee(rpc, sig):
    async with httpx.AsyncClient(timeout=30.0) as c:
        r = await c.post(rpc, json={"jsonrpc":"2.0","id":1,"method":"getTransaction","params":[sig,{"encoding":"jsonParsed","maxSupportedTransactionVersion":0}]})
        d = r.json()
        fee = d.get("result",{}).get("meta",{}).get("fee",0)
        return fee / 1e9

async def main():
    print("="*70 + "\nTRANSACTION FEE TEST\n" + "="*70)
    
    cfg = Config()
    ex = await get_trade_executor(cfg)
    
    ps = await ex.get_pool_state()
    from app.chain.orca_client import OrcaClient
    oc = OrcaClient(cfg.api.rpc_url, "", cfg.pool.pool_address, None)
    price = oc.sqrt_price_to_price(ps.sqrt_price)
    
    sol, usdc = await ex.get_balances()
    print(f"\n1. ${price:.2f}, {sol:.4f} SOL, ${usdc:.2f} USDC")
    
    amt_sol, amt_usdc = 10/price, 10.0
    print(f"2. Opening ~$20 ({amt_sol:.4f} SOL + ${amt_usdc})")
    
    if sol < amt_sol + 0.1 or usdc < amt_usdc:
        print("❌ Low balance!"); return
    
    pre = sol
    r = await ex.open_position(amt_sol, amt_usdc, price*0.985, price*1.015, 50)
    if not r.success:
        print("❌ Open failed!"); return
    
    print(f"   ✅ {r.position_address[:16]}...\n   {r.signature}")
    
    await asyncio.sleep(2)
    post, _ = await ex.get_balances()
    
    open_fee = await get_fee(cfg.api.rpc_url, r.signature)
    print(f"\n3. OPEN fee: {open_fee:.9f} SOL = ${open_fee*price:.6f}")
    print(f"   Balance: {pre:.6f} → {post:.6f} ({post-pre:.6f})")
    
    print(f"\n4. Waiting 30s...")
    await asyncio.sleep(30)
    
    print(f"\n5. Closing...")
    pre_c, _ = await ex.get_balances()
    c = await ex.close_position(r.position_address, 50)
    if not c.success:
        print("❌ Close failed!"); return
    
    print(f"   ✅ {c.signature}")
    
    await asyncio.sleep(2)
    post_c, post_usdc = await ex.get_balances()
    
    close_fee = await get_fee(cfg.api.rpc_url, c.signature)
    print(f"\n6. CLOSE fee: {close_fee:.9f} SOL = ${close_fee*price:.6f}")
    print(f"   Balance: {pre_c:.6f} → {post_c:.6f} ({post_c-pre_c:.6f})")
    
    total = open_fee + close_fee
    print(f"\n" + "="*70)
    print("RESULTS")
    print("="*70)
    print(f"\nTransaction Costs:")
    print(f"  OPEN:  {open_fee:.9f} SOL (${open_fee*price:.6f})")
    print(f"  CLOSE: {close_fee:.9f} SOL (${close_fee*price:.6f})")
    print(f"  TOTAL: {total:.9f} SOL (${total*price:.6f})")
    print(f"  % of position: {total*price/20*100:.3f}%")
    
    print(f"\nNet: {post_c-pre:+.6f} SOL, {post_usdc-usdc:+.2f} USDC")
    print(f"USD: ${(post_c-pre)*price + post_usdc-usdc:+.4f}")
    
    print("\n" + "="*70)
    print("Implementation: getTransaction(sig).result.meta.fee / 1e9")
    print("="*70)

if __name__ == "__main__":
    asyncio.run(main())
