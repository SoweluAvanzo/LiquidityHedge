#!/usr/bin/env python3
"""Calculate transaction fee from a signature"""
import asyncio, httpx, sys

async def get_fee(rpc_url, signature):
    async with httpx.AsyncClient(timeout=30.0) as client:
        r = await client.post(rpc_url, json={
            "jsonrpc": "2.0",
            "id": 1,
            "method": "getTransaction",
            "params": [signature, {"encoding": "jsonParsed", "maxSupportedTransactionVersion": 0}]
        })
        data = r.json()
        result = data.get("result")
        if not result:
            print(f"No result for {signature}")
            return None
        
        meta = result.get("meta", {})
        fee_lamports = meta.get("fee", 0)
        fee_sol = fee_lamports / 1e9
        
        pre_balances = meta.get("preBalances", [])
        post_balances = meta.get("postBalances", [])
        
        return {
            "signature": signature,
            "fee_lamports": fee_lamports,
            "fee_sol": fee_sol,
            "pre_balance": pre_balances[0] if pre_balances else 0,
            "post_balance": post_balances[0] if post_balances else 0,
            "balance_change_lamports": (post_balances[0] - pre_balances[0]) if pre_balances and post_balances else 0,
            "err": meta.get("err")
        }

async def main():
    rpc_url = "https://mainnet.helius-rpc.com/?api-key=2ef5fdd0-5c3b-4ae1-a2fc-e12b3fd605e7"
    
    # Use a recent open/close transaction signature from the logs
    # Let's analyze the transaction that opened the current position
    sigs = [
        # Position open signature (example - will use from actual logs)
        "SIGNATURE_HERE"
    ]
    
    print("Transaction Fee Analysis")
    print("=" * 70)
    
    if len(sys.argv) > 1:
        sigs = [sys.argv[1]]
    
    for sig in sigs:
        if sig == "SIGNATURE_HERE":
            print("\nUsage: python calc_tx_fee_from_sig.py <transaction_signature>")
            print("\nExample signatures from production logs:")
            print("  - Look in flyctl logs for 'Signature:' lines")
            return
        
        print(f"\nAnalyzing: {sig}")
        fee_info = await get_fee(rpc_url, sig)
        
        if fee_info:
            print(f"  Fee: {fee_info['fee_lamports']:,} lamports")
            print(f"  Fee: {fee_info['fee_sol']:.9f} SOL")
            print(f"  Fee: ${fee_info['fee_sol'] * 123:.6f} USD (at $123/SOL)")
            print(f"  Balance change: {fee_info['balance_change_lamports']:,} lamports")
            print(f"  Balance change: {fee_info['balance_change_lamports']/1e9:.6f} SOL")
            print(f"  Error: {fee_info['err'] or 'None'}")
    
    print("\n" + "=" * 70)
    print("Implementation for app:")
    print("=" * 70)
    print("""
After each transaction:
1. Call RPC: getTransaction(signature, {"encoding": "jsonParsed"})
2. Extract: result.meta.fee (in lamports)
3. Convert: fee_sol = fee_lamports / 1e9
4. Store in result.tx_fee_sol
5. Log to CSV
6. Include in PnL calculations
    """)

if __name__ == "__main__":
    asyncio.run(main())
