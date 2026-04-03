"""
Test: Parse actual token amounts from Whirlpool transactions.

Validates multiple approaches for extracting the exact SOL and USDC amounts
deposited/withdrawn in Orca Whirlpool transactions, comparing against known
Solscan values.

Approaches tested:
1. Pre/Post Token Balances from getTransaction RPC (most reliable, no extra deps)
2. Parsed inner instructions (token transfers) from getTransaction RPC
3. Transaction log event parsing (LiquidityIncreased/LiquidityDecreased events)

Known reference data from Solscan:
- TX 5jVCZe...: 4.085252957 SOL + 420.306684 USDC (open position #1)
- TX 3WQCcr...: 3.970867662 SOL + 422.819161 USDC (open position #2)
"""

import asyncio
import os
import sys
import json
import struct
import base64
from pathlib import Path
from dotenv import load_dotenv

# Load .env
env_path = Path(__file__).parent / ".env"
load_dotenv(env_path)

import httpx

# Constants
SOL_MINT = "So11111111111111111111111111111111111111112"
USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
WHIRLPOOL_PROGRAM = "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc"
SOL_USDC_POOL = "Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE"

# Known Solscan values for verification
KNOWN_TXS = {
    "5jVCZe4WnhkShFZepzMng1ga9gnNwv18x78fSFHZkkQMPm7Z7ebaJp2DsGg5mw716VNw3wq1GsTXis43QZEMFk9c": {
        "type": "open",
        "sol_amount": 4.085252957,
        "usdc_amount": 420.306684,
        "description": "Position #1 open",
    },
    "3WQCcr23hdJa3AwoLM9JbSf4ejmQ6CDQwufjAUYDKfoetHH6EyY23QtgohsnfcfMqDqDEFYJ6wRxUwTGRGB5C5oU": {
        "type": "open",
        "sol_amount": 3.970867662,
        "usdc_amount": 422.819161,
        "description": "Position #2 open",
    },
}

RPC_URL = os.getenv("SOLANA_RPC_URL")
WALLET_KEY = os.getenv("WALLET_PRIVATE_KEY_BASE58")
WALLET_ADDRESS = "86AhiHoVKoajGM2NCYHMS3HCNbkz4FWvF11HD2xyncEM"

# ============================================================
# APPROACH 1: Pre/Post Token Balances
# ============================================================

async def approach_1_token_balances(client: httpx.AsyncClient, signature: str) -> dict:
    """
    Parse actual token amounts from pre/postTokenBalances in getTransaction.

    This is the most reliable approach because:
    - preTokenBalances and postTokenBalances are set by the Solana runtime
    - They reflect the exact state before/after the transaction
    - Available on all RPC nodes (no Helius dependency)
    - Works for both open and close positions

    For an OPEN position: wallet balances DECREASE (tokens go into pool)
    For a CLOSE position: wallet balances INCREASE (tokens come from pool)
    """
    payload = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "getTransaction",
        "params": [
            signature,
            {"encoding": "jsonParsed", "maxSupportedTransactionVersion": 0}
        ]
    }

    response = await client.post(RPC_URL, json=payload)
    response.raise_for_status()
    tx_data = response.json()

    result = tx_data.get("result")
    if not result:
        return {"error": "No result in transaction data"}

    meta = result.get("meta", {})
    pre_balances = meta.get("preTokenBalances", [])
    post_balances = meta.get("postTokenBalances", [])

    # Build lookup: {(account_index, mint): amount} for pre and post
    def build_balance_map(balances):
        bmap = {}
        for b in balances:
            mint = b.get("mint", "")
            owner = b.get("owner", "")
            ui_amount = b.get("uiTokenAmount", {}).get("uiAmount")
            if ui_amount is not None:
                bmap[(b["accountIndex"], mint, owner)] = float(ui_amount)
        return bmap

    pre_map = build_balance_map(pre_balances)
    post_map = build_balance_map(post_balances)

    # Find all wallet-owned token balance changes
    sol_change = 0.0
    usdc_change = 0.0

    # Collect all keys from both maps
    all_keys = set(pre_map.keys()) | set(post_map.keys())

    for key in all_keys:
        account_idx, mint, owner = key
        pre_val = pre_map.get(key, 0.0)
        post_val = post_map.get(key, 0.0)
        diff = post_val - pre_val

        if owner == WALLET_ADDRESS:
            if mint == SOL_MINT:
                sol_change += diff
            elif mint == USDC_MINT:
                usdc_change += diff

    # For open positions, amounts are NEGATIVE (tokens leave wallet)
    # We report absolute deposited amounts
    return {
        "sol_deposited": abs(sol_change),
        "usdc_deposited": abs(usdc_change),
        "sol_change": sol_change,
        "usdc_change": usdc_change,
        "raw_pre": pre_balances,
        "raw_post": post_balances,
    }


# ============================================================
# APPROACH 2: Parsed Inner Instructions (Token Transfers)
# ============================================================

async def approach_2_inner_instructions(client: httpx.AsyncClient, signature: str) -> dict:
    """
    Parse token transfer amounts from inner instructions.

    When a position is opened, the increaseLiquidity instruction triggers
    two inner token transfers:
    - Transfer SOL (WSOL) from wallet token account to pool vault A
    - Transfer USDC from wallet token account to pool vault B

    These transfers contain the EXACT amounts deposited.
    """
    payload = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "getTransaction",
        "params": [
            signature,
            {"encoding": "jsonParsed", "maxSupportedTransactionVersion": 0}
        ]
    }

    response = await client.post(RPC_URL, json=payload)
    response.raise_for_status()
    tx_data = response.json()

    result = tx_data.get("result")
    if not result:
        return {"error": "No result"}

    meta = result.get("meta", {})
    inner_instructions = meta.get("innerInstructions", [])

    sol_transferred = 0.0
    usdc_transferred = 0.0
    transfers_found = []

    for inner_group in inner_instructions:
        for ix in inner_group.get("instructions", []):
            parsed = ix.get("parsed")
            if not parsed:
                continue

            ix_type = parsed.get("type", "")
            info = parsed.get("info", {})

            if ix_type == "transfer":
                # SPL token transfer
                authority = info.get("authority", "")
                amount_str = info.get("amount", "0")

                if authority == WALLET_ADDRESS:
                    # This is a transfer FROM the wallet (deposit into pool)
                    # Need to figure out if it's SOL or USDC
                    # We can check the source/destination against known pool vaults
                    # or check pre/postTokenBalances to identify the mint
                    amount_raw = int(amount_str)
                    transfers_found.append({
                        "source": info.get("source", ""),
                        "destination": info.get("destination", ""),
                        "amount_raw": amount_raw,
                        "authority": authority,
                    })

    # Now identify which transfers are SOL vs USDC using postTokenBalances
    # to map account addresses to mints
    pre_balances = meta.get("preTokenBalances", [])
    post_balances = meta.get("postTokenBalances", [])

    # Build account index -> (mint, owner) map from transaction accounts
    account_keys = result.get("transaction", {}).get("message", {}).get("accountKeys", [])

    # Build address -> mint map from token balances
    address_to_mint = {}
    for b in pre_balances + post_balances:
        idx = b.get("accountIndex", -1)
        mint = b.get("mint", "")
        if idx >= 0 and idx < len(account_keys):
            addr = account_keys[idx]
            if isinstance(addr, dict):
                addr = addr.get("pubkey", "")
            address_to_mint[addr] = mint

    for t in transfers_found:
        mint = address_to_mint.get(t["source"], "")
        if mint == SOL_MINT:
            sol_transferred += t["amount_raw"] / 1e9
        elif mint == USDC_MINT:
            usdc_transferred += t["amount_raw"] / 1e6
        else:
            # Try destination
            mint = address_to_mint.get(t["destination"], "")
            if mint == SOL_MINT:
                sol_transferred += t["amount_raw"] / 1e9
            elif mint == USDC_MINT:
                usdc_transferred += t["amount_raw"] / 1e6

    return {
        "sol_deposited": sol_transferred,
        "usdc_deposited": usdc_transferred,
        "transfers_found": len(transfers_found),
        "transfers_detail": transfers_found,
    }


# ============================================================
# APPROACH 3: Transaction Log Events
# ============================================================

async def approach_3_log_events(client: httpx.AsyncClient, signature: str) -> dict:
    """
    Parse LiquidityIncreased / LiquidityDecreased events from transaction logs.

    The Whirlpool program emits events like:
    - LiquidityIncreased: contains tokenAAmount and tokenBAmount
    - LiquidityDecreased: contains tokenAAmount and tokenBAmount

    These are the EXACT amounts the contract used.

    However, these are Anchor events encoded in program logs and require
    decoding the base64 event data.
    """
    payload = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "getTransaction",
        "params": [
            signature,
            {"encoding": "jsonParsed", "maxSupportedTransactionVersion": 0}
        ]
    }

    response = await client.post(RPC_URL, json=payload)
    response.raise_for_status()
    tx_data = response.json()

    result = tx_data.get("result")
    if not result:
        return {"error": "No result"}

    meta = result.get("meta", {})
    log_messages = meta.get("logMessages", [])

    # Look for Anchor event log lines
    # Format: "Program data: <base64-encoded-event>"
    # The event discriminator for Anchor events is sha256("event:<EventName>")[:8]

    events = []
    sol_amount = 0.0
    usdc_amount = 0.0

    for i, log in enumerate(log_messages):
        if log.startswith("Program data:"):
            data_b64 = log.split("Program data: ", 1)[1].strip()
            try:
                data = base64.b64decode(data_b64)
                # Anchor event structure for LiquidityIncreased:
                # 8 bytes discriminator
                # 32 bytes whirlpool pubkey
                # 32 bytes position pubkey
                # 4 bytes tick_lower_index (i32)
                # 4 bytes tick_upper_index (i32)
                # 16 bytes liquidity (u128)
                # 8 bytes token_a_amount (u64)
                # 8 bytes token_b_amount (u64)
                # 8 bytes token_a_transfer_fee (u64)
                # 8 bytes token_b_transfer_fee (u64)

                if len(data) >= 8 + 32 + 32 + 4 + 4 + 16 + 8 + 8:
                    discriminator = data[:8]
                    offset = 8 + 32 + 32 + 4 + 4 + 16  # Skip to token amounts
                    token_a_raw = struct.unpack_from("<Q", data, offset)[0]
                    token_b_raw = struct.unpack_from("<Q", data, offset + 8)[0]

                    # Sanity check: token_a should be in a reasonable SOL range
                    token_a_sol = token_a_raw / 1e9
                    token_b_usdc = token_b_raw / 1e6

                    if 0.001 < token_a_sol < 1000 and 0.01 < token_b_usdc < 1000000:
                        sol_amount = token_a_sol
                        usdc_amount = token_b_usdc
                        events.append({
                            "discriminator": discriminator.hex(),
                            "token_a_lamports": token_a_raw,
                            "token_b_micro_usdc": token_b_raw,
                            "token_a_sol": token_a_sol,
                            "token_b_usdc": token_b_usdc,
                            "data_length": len(data),
                        })
            except Exception as e:
                pass  # Not all "Program data:" lines are events

    return {
        "sol_deposited": sol_amount,
        "usdc_deposited": usdc_amount,
        "events_found": len(events),
        "events_detail": events,
        "log_lines_count": len(log_messages),
    }


# ============================================================
# Main Test Runner
# ============================================================

def check_match(label: str, actual: float, expected: float, tolerance: float = 0.000001) -> bool:
    """Check if actual matches expected within tolerance."""
    diff = abs(actual - expected)
    match = diff <= tolerance
    status = "PASS" if match else "FAIL"
    print(f"  [{status}] {label}: {actual:.9f} (expected {expected:.9f}, diff {diff:.9f})")
    return match


async def test_parsing_approaches():
    """Test all three approaches against known transaction data."""
    print("=" * 80)
    print("TEST: Transaction Parsing Approaches")
    print(f"RPC URL: {RPC_URL[:50]}...")
    print("=" * 80)

    all_passed = True

    async with httpx.AsyncClient(timeout=30.0) as client:
        for sig, expected in KNOWN_TXS.items():
            print(f"\n--- {expected['description']} ---")
            print(f"TX: {sig[:20]}...")
            print(f"Expected: {expected['sol_amount']} SOL, {expected['usdc_amount']} USDC")

            # Approach 1: Pre/Post Token Balances
            print(f"\n  APPROACH 1: Pre/Post Token Balances")
            try:
                r1 = await approach_1_token_balances(client, sig)
                if "error" in r1:
                    print(f"  ERROR: {r1['error']}")
                    all_passed = False
                else:
                    p1_sol = check_match("SOL", r1["sol_deposited"], expected["sol_amount"])
                    p1_usdc = check_match("USDC", r1["usdc_deposited"], expected["usdc_amount"])
                    if not (p1_sol and p1_usdc):
                        all_passed = False
            except Exception as e:
                print(f"  EXCEPTION: {e}")
                all_passed = False

            # Approach 2: Inner Instructions
            print(f"\n  APPROACH 2: Parsed Inner Instructions (Token Transfers)")
            try:
                r2 = await approach_2_inner_instructions(client, sig)
                if "error" in r2:
                    print(f"  ERROR: {r2['error']}")
                    all_passed = False
                else:
                    p2_sol = check_match("SOL", r2["sol_deposited"], expected["sol_amount"])
                    p2_usdc = check_match("USDC", r2["usdc_deposited"], expected["usdc_amount"])
                    print(f"  Transfers found: {r2['transfers_found']}")
                    if not (p2_sol and p2_usdc):
                        all_passed = False
            except Exception as e:
                print(f"  EXCEPTION: {e}")
                all_passed = False

            # Approach 3: Log Events
            print(f"\n  APPROACH 3: Transaction Log Events")
            try:
                r3 = await approach_3_log_events(client, sig)
                if "error" in r3:
                    print(f"  ERROR: {r3['error']}")
                    all_passed = False
                else:
                    p3_sol = check_match("SOL", r3["sol_deposited"], expected["sol_amount"])
                    p3_usdc = check_match("USDC", r3["usdc_deposited"], expected["usdc_amount"])
                    print(f"  Events found: {r3['events_found']}")
                    if not (p3_sol and p3_usdc):
                        all_passed = False
            except Exception as e:
                print(f"  EXCEPTION: {e}")
                all_passed = False

    print(f"\n{'=' * 80}")
    print(f"OVERALL: {'ALL PASSED' if all_passed else 'SOME FAILED'}")
    print(f"{'=' * 80}")
    return all_passed


if __name__ == "__main__":
    if not RPC_URL:
        print("ERROR: SOLANA_RPC_URL not set in .env")
        sys.exit(1)

    passed = asyncio.run(test_parsing_approaches())
    sys.exit(0 if passed else 1)
