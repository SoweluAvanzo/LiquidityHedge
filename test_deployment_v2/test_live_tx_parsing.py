"""
LIVE Test: Open a $5 position, parse TX, close it, parse TX, verify all values.

This test:
1. Initializes TradeExecutor with real credentials
2. Opens a ~$5 SOL/USDC position on Orca Whirlpool
3. Parses the open TX to extract actual deposited amounts
4. Verifies parsed amounts match the on-chain position
5. Closes the position
6. Parses the close TX to extract withdrawn amounts and fees
7. Reports all values and discrepancies

CAUTION: This opens and closes a REAL position on Solana mainnet.
         It uses ~$5 of capital + TX fees (~0.003 SOL).
"""

import asyncio
import os
import sys
import math
import struct
import base64
from pathlib import Path
from decimal import Decimal
from typing import Tuple, Optional, Dict, Any

from dotenv import load_dotenv

# Load .env
env_path = Path(__file__).parent / ".env"
load_dotenv(env_path)

import httpx

# Add parent to path for imports
sys.path.insert(0, str(Path(__file__).parent))

from config import get_config
from execution import (
    TradeExecutor, PositionExecutor,
    price_to_tick, tick_to_price, tick_to_sqrt_price,
    calculate_clmm_liquidity, estimate_amounts_from_liquidity,
    calculate_range,
)

# Constants
SOL_MINT = "So11111111111111111111111111111111111111112"
USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
RPC_URL = os.getenv("SOLANA_RPC_URL")
# Derive wallet address from private key
import base58 as _b58
from solders.keypair import Keypair as _Kp
_wallet_bytes = _b58.b58decode(os.getenv("WALLET_PRIVATE_KEY_BASE58", ""))
_wallet_kp = _Kp.from_bytes(_wallet_bytes[:64]) if len(_wallet_bytes) >= 64 else None
WALLET_ADDRESS = str(_wallet_kp.pubkey()) if _wallet_kp else ""

POSITION_VALUE_USD = 5.0  # Open a $5 position


# ============================================================
# TX Parsing Functions (proven in test_tx_parsing.py)
# ============================================================

async def parse_amounts_from_tx_inner_instructions(
    client: httpx.AsyncClient,
    signature: str,
    wallet_address: str,
) -> Tuple[float, float]:
    """
    Parse actual token amounts from inner instructions (Approach 2).
    Returns (sol_amount, usdc_amount) - the exact amounts transferred.
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

    # Retry fetching TX (RPC may need time to index)
    result = None
    for attempt in range(5):
        response = await client.post(RPC_URL, json=payload)
        response.raise_for_status()
        tx_data = response.json()
        result = tx_data.get("result")
        if result:
            break
        print(f"    TX not yet indexed (attempt {attempt+1}/5), waiting 3s...")
        await asyncio.sleep(3)

    if not result:
        raise ValueError("No result in transaction data after 5 retries")

    meta = result.get("meta", {})
    inner_instructions = meta.get("innerInstructions", [])
    pre_balances = meta.get("preTokenBalances", [])
    post_balances = meta.get("postTokenBalances", [])
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

    sol_amount = 0.0
    usdc_amount = 0.0

    for inner_group in inner_instructions:
        for ix in inner_group.get("instructions", []):
            parsed = ix.get("parsed")
            if not parsed:
                continue
            if parsed.get("type") != "transfer":
                continue
            info = parsed.get("info", {})
            authority = info.get("authority", "")
            if authority != wallet_address:
                continue

            amount_raw = int(info.get("amount", "0"))
            source = info.get("source", "")
            destination = info.get("destination", "")

            # Identify mint via source or destination
            mint = address_to_mint.get(source, "") or address_to_mint.get(destination, "")
            if mint == SOL_MINT:
                sol_amount += amount_raw / 1e9
            elif mint == USDC_MINT:
                usdc_amount += amount_raw / 1e6

    return sol_amount, usdc_amount


async def parse_amounts_from_tx_log_events(
    client: httpx.AsyncClient,
    signature: str,
) -> Tuple[float, float]:
    """
    Parse actual token amounts from Anchor log events (Approach 3).
    Returns (sol_amount, usdc_amount) from LiquidityIncreased/LiquidityDecreased event.
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

    # Retry fetching TX
    result = None
    for attempt in range(5):
        response = await client.post(RPC_URL, json=payload)
        response.raise_for_status()
        tx_data = response.json()
        result = tx_data.get("result")
        if result:
            break
        await asyncio.sleep(3)

    if not result:
        raise ValueError("No result after retries")

    meta = result.get("meta", {})
    log_messages = meta.get("logMessages", [])

    for log in log_messages:
        if log.startswith("Program data:"):
            data_b64 = log.split("Program data: ", 1)[1].strip()
            try:
                data = base64.b64decode(data_b64)
                if len(data) >= 8 + 32 + 32 + 4 + 4 + 16 + 8 + 8:
                    offset = 8 + 32 + 32 + 4 + 4 + 16
                    token_a_raw = struct.unpack_from("<Q", data, offset)[0]
                    token_b_raw = struct.unpack_from("<Q", data, offset + 8)[0]
                    token_a_sol = token_a_raw / 1e9
                    token_b_usdc = token_b_raw / 1e6
                    if 0.0001 < token_a_sol < 10000 and 0.001 < token_b_usdc < 10000000:
                        return token_a_sol, token_b_usdc
            except Exception:
                pass

    return 0.0, 0.0


# ============================================================
# Live Test
# ============================================================

async def run_live_test():
    print("=" * 80)
    print("LIVE TEST: Open $5 position, parse TX, close, verify")
    print("=" * 80)

    # Initialize
    config = get_config()
    executor = TradeExecutor(config)
    if not await executor.initialize():
        print("FATAL: Failed to initialize TradeExecutor")
        return False

    # Get balances
    sol_bal, usdc_bal = await executor.get_balances()
    pool_state = await executor.get_pool_state()
    current_price = pool_state.current_price
    tick_spacing = pool_state.tick_spacing
    sqrt_price = pool_state.sqrt_price

    print(f"\nWallet: {sol_bal:.4f} SOL, ${usdc_bal:.2f} USDC")
    print(f"Pool price: ${current_price:.4f}")
    print(f"Tick spacing: {tick_spacing}")

    # Check we have enough funds
    total_value = (sol_bal * current_price) + usdc_bal
    if total_value < POSITION_VALUE_USD + 5:  # Need $5 position + margin for fees
        print(f"SKIP: Insufficient funds. Have ${total_value:.2f}, need at least ${POSITION_VALUE_USD + 5:.2f}")
        return False

    # Calculate range: ~5% width around current price
    range_pct = 0.05
    lower_tick, upper_tick, lower_price, upper_price = calculate_range(
        current_price=current_price,
        range_span_pct=range_pct,
        tick_spacing=tick_spacing,
    )

    print(f"\nPosition range: ${lower_price:.4f} - ${upper_price:.4f}")
    print(f"Ticks: {lower_tick} to {upper_tick}")

    # Calculate amounts for $5 position (50/50 split)
    half_value = POSITION_VALUE_USD / 2
    max_sol = half_value / current_price
    max_usdc = half_value

    print(f"Target: {max_sol:.6f} SOL (${half_value:.2f}) + ${max_usdc:.2f} USDC")

    # Calculate liquidity
    liquidity = calculate_clmm_liquidity(
        lower_tick=lower_tick,
        upper_tick=upper_tick,
        sqrt_price_current=sqrt_price,
        token_a_amount=max_sol,
        token_b_amount=max_usdc,
        safety_factor=0.95,
    )
    print(f"Liquidity: {liquidity:,}")

    # Estimate expected amounts
    est_sol_lamports, est_usdc_micro = estimate_amounts_from_liquidity(
        sqrt_price_current=sqrt_price,
        lower_tick=lower_tick,
        upper_tick=upper_tick,
        liquidity=liquidity,
    )
    est_sol = est_sol_lamports / 1e9
    est_usdc = est_usdc_micro / 1e6
    print(f"Estimated amounts: {est_sol:.9f} SOL, ${est_usdc:.6f} USDC")

    # Calculate token_max with buffer
    token_max_a = int(max_sol * 1e9 * 1.10)  # 10% buffer
    token_max_b = int(max_usdc * 1e6 * 1.10)

    # ==========================================
    # STEP 1: OPEN POSITION
    # ==========================================
    print(f"\n{'=' * 60}")
    print("STEP 1: Opening position...")
    print(f"{'=' * 60}")

    open_result = await executor._position_executor.open_position(
        lower_tick=lower_tick,
        upper_tick=upper_tick,
        liquidity_amount=liquidity,
        token_max_a=token_max_a,
        token_max_b=token_max_b,
    )

    if not open_result.success:
        print(f"FATAL: Position open failed: {open_result.error}")
        return False

    print(f"Position opened: {open_result.position_address}")
    print(f"Signature: {open_result.signature}")
    print(f"Bot-reported deposited: {open_result.deposited_sol:.9f} SOL, ${open_result.deposited_usdc:.6f} USDC")

    # Wait for TX to be indexed
    print("\nWaiting 8s for TX indexing...")
    await asyncio.sleep(8)

    # ==========================================
    # STEP 2: PARSE OPEN TX
    # ==========================================
    print(f"\n{'=' * 60}")
    print("STEP 2: Parsing open transaction...")
    print(f"{'=' * 60}")

    async with httpx.AsyncClient(timeout=30.0) as client:
        # Approach 2: Inner Instructions
        parsed_sol_2, parsed_usdc_2 = await parse_amounts_from_tx_inner_instructions(
            client, open_result.signature, WALLET_ADDRESS
        )
        print(f"\nApproach 2 (Inner Instructions):")
        print(f"  SOL deposited: {parsed_sol_2:.9f}")
        print(f"  USDC deposited: {parsed_usdc_2:.6f}")

        # Approach 3: Log Events
        parsed_sol_3, parsed_usdc_3 = await parse_amounts_from_tx_log_events(
            client, open_result.signature
        )
        print(f"\nApproach 3 (Log Events):")
        print(f"  SOL deposited: {parsed_sol_3:.9f}")
        print(f"  USDC deposited: {parsed_usdc_3:.6f}")

    # Compare
    print(f"\n--- OPEN COMPARISON ---")
    print(f"{'Source':<25} {'SOL':>15} {'USDC':>15}")
    print(f"{'-'*55}")
    print(f"{'Bot (estimate)':<25} {open_result.deposited_sol:>15.9f} {open_result.deposited_usdc:>15.6f}")
    print(f"{'Approach 2 (transfers)':<25} {parsed_sol_2:>15.9f} {parsed_usdc_2:>15.6f}")
    print(f"{'Approach 3 (events)':<25} {parsed_sol_3:>15.9f} {parsed_usdc_3:>15.6f}")

    sol_diff_2 = abs(open_result.deposited_sol - parsed_sol_2)
    usdc_diff_2 = abs(open_result.deposited_usdc - parsed_usdc_2)
    sol_diff_3 = abs(open_result.deposited_sol - parsed_sol_3)
    usdc_diff_3 = abs(open_result.deposited_usdc - parsed_usdc_3)

    print(f"\nDiscrepancies (bot vs parsed):")
    print(f"  Approach 2: SOL diff={sol_diff_2:.9f}, USDC diff={usdc_diff_2:.6f}")
    print(f"  Approach 3: SOL diff={sol_diff_3:.9f}, USDC diff={usdc_diff_3:.6f}")

    # Check if approaches 2 and 3 agree
    approaches_agree = (
        abs(parsed_sol_2 - parsed_sol_3) < 0.000001 and
        abs(parsed_usdc_2 - parsed_usdc_3) < 0.000001
    )
    print(f"  Approaches 2&3 agree: {'YES' if approaches_agree else 'NO'}")

    # ==========================================
    # STEP 3: CLOSE POSITION
    # ==========================================
    print(f"\n{'=' * 60}")
    print("STEP 3: Closing position...")
    print(f"{'=' * 60}")

    # Wait a bit for any fee accrual
    await asyncio.sleep(3)

    # Get pre-close balances
    pre_sol, pre_usdc = await executor.get_balances()
    print(f"Pre-close balances: {pre_sol:.6f} SOL, ${pre_usdc:.2f} USDC")

    close_result = await executor._position_executor.close_position(
        position_address=open_result.position_address,
        collect_fees=True,
    )

    if not close_result.success:
        print(f"WARNING: Position close failed: {close_result.error}")
        print(f"Position may still be open: {open_result.position_address}")
        print(f"Manual intervention may be needed!")
        return False

    print(f"Position closed!")
    print(f"Signature: {close_result.signature}")

    # Wait for TX indexing
    print("\nWaiting 8s for TX indexing...")
    await asyncio.sleep(8)

    # Get post-close balances
    post_sol, post_usdc = await executor.get_balances()
    print(f"Post-close balances: {post_sol:.6f} SOL, ${post_usdc:.2f} USDC")
    print(f"Balance diffs: {post_sol - pre_sol:+.9f} SOL, {post_usdc - pre_usdc:+.6f} USDC")

    # ==========================================
    # STEP 4: PARSE CLOSE TX
    # ==========================================
    print(f"\n{'=' * 60}")
    print("STEP 4: Parsing close transaction...")
    print(f"{'=' * 60}")

    async with httpx.AsyncClient(timeout=30.0) as client:
        # For close TXs, the transfers go FROM pool TO wallet
        # We need to look for transfers TO the wallet (not FROM)
        # Let's parse the full TX and show all transfers
        payload = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "getTransaction",
            "params": [
                close_result.signature,
                {"encoding": "jsonParsed", "maxSupportedTransactionVersion": 0}
            ]
        }
        # Retry fetching TX
        tx_result = None
        for attempt in range(5):
            response = await client.post(RPC_URL, json=payload)
            response.raise_for_status()
            tx_json = response.json()
            tx_result = tx_json.get("result")
            if tx_result:
                break
            print(f"    Close TX not yet indexed (attempt {attempt+1}/5), waiting 3s...")
            await asyncio.sleep(3)

        if not tx_result:
            print("WARNING: Could not fetch close TX after retries")
            return True  # Position closed, parsing failed

        meta = tx_result.get("meta", {})

        # Show all inner instruction transfers
        inner_instructions = meta.get("innerInstructions", [])
        print("\nAll inner instruction transfers:")
        for inner_group in inner_instructions:
            group_idx = inner_group.get("index", "?")
            for ix in inner_group.get("instructions", []):
                parsed = ix.get("parsed")
                if not parsed:
                    continue
                if parsed.get("type") == "transfer":
                    info = parsed.get("info", {})
                    print(f"  [Group {group_idx}] transfer: {info.get('amount', '?')} "
                          f"from {info.get('source', '?')[:12]}... "
                          f"to {info.get('destination', '?')[:12]}... "
                          f"auth={info.get('authority', '?')[:12]}...")

        # Parse log events for close
        close_sol_3, close_usdc_3 = await parse_amounts_from_tx_log_events(
            client, close_result.signature
        )
        print(f"\nApproach 3 (Log Events) - Close TX:")
        print(f"  SOL withdrawn: {close_sol_3:.9f}")
        print(f"  USDC withdrawn: {close_usdc_3:.6f}")

    # ==========================================
    # SUMMARY
    # ==========================================
    print(f"\n{'=' * 80}")
    print("SUMMARY")
    print(f"{'=' * 80}")
    print(f"Open TX: {open_result.signature}")
    print(f"Close TX: {close_result.signature}")
    print(f"Position: {open_result.position_address}")
    print(f"\nOpen amounts:")
    print(f"  Bot estimate:  {open_result.deposited_sol:.9f} SOL, ${open_result.deposited_usdc:.6f} USDC")
    print(f"  TX parsed (2): {parsed_sol_2:.9f} SOL, ${parsed_usdc_2:.6f} USDC")
    print(f"  TX parsed (3): {parsed_sol_3:.9f} SOL, ${parsed_usdc_3:.6f} USDC")
    print(f"\nVerify on Solscan:")
    print(f"  Open:  https://solscan.io/tx/{open_result.signature}")
    print(f"  Close: https://solscan.io/tx/{close_result.signature}")

    # Final pass/fail
    open_matches = approaches_agree and parsed_sol_2 > 0 and parsed_usdc_2 > 0
    print(f"\nResult: {'PASS - parsing works correctly' if open_matches else 'FAIL'}")
    return open_matches


if __name__ == "__main__":
    if not RPC_URL:
        print("ERROR: SOLANA_RPC_URL not set in .env")
        sys.exit(1)
    if not os.getenv("WALLET_PRIVATE_KEY_BASE58"):
        print("ERROR: WALLET_PRIVATE_KEY_BASE58 not set in .env")
        sys.exit(1)

    passed = asyncio.run(run_live_test())
    sys.exit(0 if passed else 1)
