#!/usr/bin/env python3
"""
Token Extensions (Token2022) Cost Comparison Test

This script tests the new Token Extensions implementation by:
1. Opening positions with Token2022 enabled
2. Closing them and measuring actual costs
3. Comparing costs across different position sizes ($10, $50, $100)

IMPORTANT: This test uses REAL funds on mainnet. It will:
- Open and close 3 small positions ($10, $50, $100)
- Measure actual rent costs and refunds
- Report cost savings vs standard SPL Token

Usage:
    python test_token_extensions.py

The script loads credentials from .env file.
"""

import asyncio
import os
import sys
import time
from decimal import Decimal
from pathlib import Path
from dataclasses import dataclass
from typing import Optional, Tuple, List

# Load environment from .env
from dotenv import load_dotenv
load_dotenv()

# Add the current directory to path for imports
sys.path.insert(0, str(Path(__file__).parent))

import structlog
from solders.pubkey import Pubkey

# Configure logging
structlog.configure(
    processors=[
        structlog.stdlib.add_log_level,
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.dev.ConsoleRenderer(colors=True),
    ],
    wrapper_class=structlog.stdlib.BoundLogger,
    context_class=dict,
    logger_factory=structlog.PrintLoggerFactory(),
)

logger = structlog.get_logger(__name__)


@dataclass
class TestResult:
    """Result of a single position open/close test."""
    position_size_usd: float
    use_token_extensions: bool

    # Wallet values (USD)
    wallet_before_open: float
    wallet_after_open: float
    wallet_after_close: float

    # Calculated costs (USD)
    open_cost: float
    close_cost: float
    total_cost: float

    # Precise balances (lamports/micro)
    sol_before_open: float = 0.0
    usdc_before_open: float = 0.0
    sol_after_open: float = 0.0
    usdc_after_open: float = 0.0
    sol_after_close: float = 0.0
    usdc_after_close: float = 0.0

    # Net cost in SOL (most precise measure - excludes price fluctuation)
    net_sol_cost: float = 0.0  # SOL spent on tx fees + rent not recovered

    # Position details
    position_address: Optional[str] = None
    position_mint: Optional[str] = None
    lower_tick: int = 0
    upper_tick: int = 0

    # Timing
    open_time_seconds: float = 0
    close_time_seconds: float = 0

    # Transaction signatures
    open_signature: Optional[str] = None
    close_signature: Optional[str] = None

    # Error if any
    error: Optional[str] = None


async def get_wallet_value_usd(solana_client, sol_price: float) -> Tuple[float, float, float]:
    """Get wallet value in USD (SOL balance, USDC balance, total)."""
    sol_balance = await solana_client.get_balance_sol()

    # Get USDC balance
    usdc_mint = Pubkey.from_string("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")
    from app.chain.whirlpool_instructions import derive_associated_token_address
    usdc_ata = derive_associated_token_address(solana_client.wallet_pubkey, usdc_mint)

    usdc_balance = 0.0
    try:
        balance_info = await solana_client.get_token_balance(str(usdc_ata))
        if balance_info:
            usdc_balance = float(balance_info.get("ui_amount", 0) or 0)
    except Exception:
        pass

    sol_value_usd = sol_balance * sol_price
    total_usd = sol_value_usd + usdc_balance

    return sol_balance, usdc_balance, total_usd


async def run_single_test(
    orca_client,
    solana_client,
    pool_pubkey: str,
    position_size_usd: float,
    use_token_extensions: bool,
    sol_price: float,
) -> TestResult:
    """
    Run a single open/close test and measure costs.

    Args:
        orca_client: Orca client instance
        solana_client: Solana client instance
        pool_pubkey: Pool address
        position_size_usd: Target position size in USD
        use_token_extensions: Whether to use Token2022
        sol_price: Current SOL price

    Returns:
        TestResult with measured costs
    """
    from app.config import get_settings
    settings = get_settings()

    result = TestResult(
        position_size_usd=position_size_usd,
        use_token_extensions=use_token_extensions,
        wallet_before_open=0,
        wallet_after_open=0,
        wallet_after_close=0,
        open_cost=0,
        close_cost=0,
        total_cost=0,
    )

    try:
        # Get pool state
        pool_state = await orca_client.get_pool_state(pool_pubkey)
        current_price = pool_state.current_price

        logger.info(
            "test_starting",
            position_size_usd=position_size_usd,
            use_token_extensions=use_token_extensions,
            current_price=current_price,
        )

        # Calculate position parameters
        # Use a tight range around current price (2% total width = 1% each side)
        range_width_pct = 2.0
        from app.chain.orca_client import calculate_tick_range
        lower_tick, upper_tick = calculate_tick_range(
            current_price, range_width_pct, pool_state.tick_spacing
        )
        result.lower_tick = lower_tick
        result.upper_tick = upper_tick

        # Calculate token amounts for target USD value
        # Split 50/50 between SOL and USDC
        half_value = position_size_usd / 2
        sol_amount = Decimal(str(half_value / sol_price))
        usdc_amount = Decimal(str(half_value))

        # Convert to lamports/base units
        base_a = int(sol_amount * Decimal(10**9))   # SOL lamports (unbuffered)
        base_b = int(usdc_amount * Decimal(10**6))  # USDC base units (unbuffered)

        # Calculate liquidity from unbuffered amounts
        liquidity_amount = orca_client._estimate_liquidity_from_amounts(
            pool_state, lower_tick, upper_tick, base_a, base_b
        )

        # Add buffer to token_max for slippage protection
        buffer = Decimal("1.5")
        token_max_a = int(base_a * buffer)
        token_max_b = int(base_b * buffer)

        if liquidity_amount <= 0:
            result.error = "Failed to calculate liquidity"
            return result

        # Record wallet balance before opening (precise)
        result.sol_before_open, result.usdc_before_open, result.wallet_before_open = await get_wallet_value_usd(solana_client, sol_price)

        print(f"\n  [PRE-OPEN BALANCE]")
        print(f"    SOL:  {result.sol_before_open:.9f} ({int(result.sol_before_open * 1e9)} lamports)")
        print(f"    USDC: {result.usdc_before_open:.6f}")
        print(f"    Total: ${result.wallet_before_open:.4f}")

        logger.info(
            "opening_position",
            sol_amount=float(sol_amount),
            usdc_amount=float(usdc_amount),
            liquidity=liquidity_amount,
            wallet_before=result.wallet_before_open,
        )

        # ===== OPEN POSITION =====
        # Temporarily override the settings for this test
        original_use_token_ext = settings.use_token_extensions
        original_with_metadata = settings.token_extensions_with_metadata

        # Monkey-patch the settings for this test
        # Note: with_metadata=False for now until we implement metadata_update_auth
        settings.__dict__['use_token_extensions'] = use_token_extensions
        settings.__dict__['token_extensions_with_metadata'] = False

        start_time = time.time()

        try:
            open_receipt = await orca_client.execute_open_position(
                pool_pubkey=pool_pubkey,
                lower_tick=lower_tick,
                upper_tick=upper_tick,
                liquidity_amount=liquidity_amount,
                token_max_a=token_max_a,
                token_max_b=token_max_b,
            )
        finally:
            # Restore original settings
            settings.__dict__['use_token_extensions'] = original_use_token_ext
            settings.__dict__['token_extensions_with_metadata'] = original_with_metadata

        result.open_time_seconds = time.time() - start_time
        result.open_signature = open_receipt.signature

        if not open_receipt.is_success:
            result.error = f"Open failed: {open_receipt.error}"
            return result

        result.position_address = open_receipt.metadata.get("position_address")
        result.position_mint = open_receipt.metadata.get("position_mint")

        # Wait for confirmation and balance update
        await asyncio.sleep(3)

        # Record wallet balance after opening (precise)
        result.sol_after_open, result.usdc_after_open, result.wallet_after_open = await get_wallet_value_usd(solana_client, sol_price)

        sol_spent_open = result.sol_before_open - result.sol_after_open
        usdc_spent_open = result.usdc_before_open - result.usdc_after_open
        result.open_cost = result.wallet_before_open - result.wallet_after_open - position_size_usd

        print(f"\n  [POST-OPEN BALANCE]")
        print(f"    SOL:  {result.sol_after_open:.9f} ({int(result.sol_after_open * 1e9)} lamports)")
        print(f"    USDC: {result.usdc_after_open:.6f}")
        print(f"    Total: ${result.wallet_after_open:.4f}")
        print(f"  [OPEN COST BREAKDOWN]")
        print(f"    SOL spent:  {sol_spent_open:.9f} SOL ({int(sol_spent_open * 1e9)} lamports)")
        print(f"    USDC spent: {usdc_spent_open:.6f}")
        print(f"    Estimated open cost (rent+fees): ${result.open_cost:.4f}")
        print(f"    TX: {open_receipt.signature}")

        logger.info(
            "position_opened",
            position=result.position_address,
            signature=open_receipt.signature,
            wallet_after=result.wallet_after_open,
            open_cost=result.open_cost,
        )

        # Wait a bit before closing
        await asyncio.sleep(2)

        # ===== CLOSE POSITION =====
        start_time = time.time()

        close_receipt = await orca_client.execute_close_position(
            position_pubkey=result.position_address,
            collect_fees=True,
        )

        result.close_time_seconds = time.time() - start_time
        result.close_signature = close_receipt.signature

        if not close_receipt.is_success:
            result.error = f"Close failed: {close_receipt.error}"
            return result

        # Wait for confirmation and balance update
        await asyncio.sleep(3)

        # Record wallet balance after closing (precise)
        result.sol_after_close, result.usdc_after_close, result.wallet_after_close = await get_wallet_value_usd(solana_client, sol_price)

        sol_recovered_close = result.sol_after_close - result.sol_after_open
        usdc_recovered_close = result.usdc_after_close - result.usdc_after_open

        # Net SOL cost = SOL before open - SOL after close (precise, no price dependency)
        result.net_sol_cost = result.sol_before_open - result.sol_after_close

        # Close cost = what we didn't get back from the position value
        # Expected: wallet_after_close should be close to wallet_before_open
        result.close_cost = (result.wallet_after_open + position_size_usd) - result.wallet_after_close
        result.total_cost = result.wallet_before_open - result.wallet_after_close

        print(f"\n  [POST-CLOSE BALANCE]")
        print(f"    SOL:  {result.sol_after_close:.9f} ({int(result.sol_after_close * 1e9)} lamports)")
        print(f"    USDC: {result.usdc_after_close:.6f}")
        print(f"    Total: ${result.wallet_after_close:.4f}")
        print(f"  [CLOSE RECOVERY BREAKDOWN]")
        print(f"    SOL recovered: {sol_recovered_close:.9f} SOL ({int(sol_recovered_close * 1e9)} lamports)")
        print(f"    USDC recovered: {usdc_recovered_close:.6f}")
        print(f"    TX: {close_receipt.signature}")
        print(f"  [FULL CYCLE COST]")
        print(f"    Net SOL cost:  {result.net_sol_cost:.9f} SOL ({int(result.net_sol_cost * 1e9)} lamports) = ${result.net_sol_cost * sol_price:.4f}")
        print(f"    USDC change:   {result.usdc_after_close - result.usdc_before_open:+.6f}")
        print(f"    Total USD cost: ${result.total_cost:.4f}")

        logger.info(
            "position_closed",
            signature=close_receipt.signature,
            wallet_after=result.wallet_after_close,
            close_cost=result.close_cost,
            total_cost=result.total_cost,
            net_sol_cost=result.net_sol_cost,
        )

    except Exception as e:
        result.error = str(e)
        logger.error("test_failed", error=str(e))

    return result


def parse_args():
    """Parse command line arguments."""
    import argparse
    parser = argparse.ArgumentParser(description='Token Extensions Cost Comparison Test')
    parser.add_argument('--no-confirm', action='store_true', help='Skip confirmation prompts')
    parser.add_argument('--auto-swap', action='store_true', help='Auto-execute rebalance swap if needed')
    return parser.parse_args()


async def main():
    """Run Token Extensions cost comparison tests."""
    args = parse_args()
    confirm = not args.no_confirm

    print("\n" + "=" * 70)
    print("TOKEN EXTENSIONS (TOKEN2022) COST COMPARISON TEST")
    print("=" * 70)

    # Check required environment variables
    required_vars = [
        "WALLET_PRIVATE_KEY_BASE58",
        "SOLANA_RPC_URL",
        "JUPITER_API_KEY",
    ]

    missing = [v for v in required_vars if not os.getenv(v)]
    if missing:
        print(f"\nERROR: Missing required environment variables: {missing}")
        print("Please ensure .env file contains all required variables.")
        sys.exit(1)

    # Verify USE_TOKEN_EXTENSIONS is set
    print(f"\nConfiguration:")
    print(f"  USE_TOKEN_EXTENSIONS: {os.getenv('USE_TOKEN_EXTENSIONS', 'not set')}")
    print(f"  SOLANA_NETWORK: {os.getenv('SOLANA_NETWORK', 'not set')}")
    print(f"  SOL_USDC_POOL: {os.getenv('SOL_USDC_POOL', 'not set')}")

    # Initialize clients
    print("\nInitializing clients...")

    from app.chain.solana_client import get_solana_client
    from app.chain.orca_client import get_orca_client

    solana_client = await get_solana_client()
    orca_client = await get_orca_client()

    # Get current SOL price
    pool_pubkey = os.getenv("SOL_USDC_POOL", "Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE")
    pool_state = await orca_client.get_pool_state(pool_pubkey)
    sol_price = pool_state.current_price

    print(f"\nCurrent SOL price: ${sol_price:.2f}")

    # Get initial wallet balance
    sol_bal, usdc_bal, total_usd = await get_wallet_value_usd(solana_client, sol_price)
    print(f"Wallet: {sol_bal:.4f} SOL + ${usdc_bal:.2f} USDC = ${total_usd:.2f} total")

    # Safety confirmation
    print("\n" + "!" * 70)
    print("WARNING: This test uses REAL funds on mainnet!")
    print(f"Available balance: ${total_usd:.2f}")
    print("It will open and close positions to measure Token Extensions costs")
    print("Expected cost: ~$1-5 total (mostly rent + fees)")
    print("!" * 70)

    if confirm:
        response = input("\nType 'YES' to continue: ")
        if response != "YES":
            print("Test cancelled.")
            sys.exit(0)
    else:
        print("\n[--no-confirm] Proceeding automatically...")

    # Check if we need to balance the portfolio (swap to ~50/50)
    sol_value = sol_bal * sol_price
    total_value = sol_value + usdc_bal

    if total_value < 5:
        print(f"\nERROR: Wallet balance too low for testing (${total_value:.2f})")
        sys.exit(1)

    sol_pct = sol_value / total_value if total_value > 0 else 0
    usdc_pct = usdc_bal / total_value if total_value > 0 else 0

    print(f"\nPortfolio allocation: {sol_pct*100:.1f}% SOL / {usdc_pct*100:.1f}% USDC")

    # If portfolio is imbalanced (more than 60% one way), swap to balance
    if sol_pct > 0.60 or usdc_pct > 0.60:
        print("\nPortfolio is imbalanced. Need to swap to ~50/50 before testing.")

        # Calculate swap amount
        target_sol_value = total_value / 2
        target_usdc_value = total_value / 2

        if sol_pct > 0.60:
            # Swap SOL to USDC
            excess_sol_value = sol_value - target_sol_value
            swap_sol_amount = excess_sol_value / sol_price
            # Keep some SOL for fees
            swap_sol_amount = max(0, swap_sol_amount - 0.02)

            if swap_sol_amount > 0.01:
                print(f"\nSwapping {swap_sol_amount:.4f} SOL (~${swap_sol_amount * sol_price:.2f}) to USDC...")

                do_swap = args.auto_swap or args.no_confirm
                if not do_swap and confirm:
                    swap_response = input("Type 'SWAP' to execute swap: ")
                    do_swap = (swap_response == "SWAP")
                if do_swap:
                    from app.chain.aggregator_jupiter import JupiterClient
                    jupiter = JupiterClient(api_key=os.getenv("JUPITER_API_KEY"))

                    sol_mint = "So11111111111111111111111111111111111111112"
                    usdc_mint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"

                    swap_lamports = int(swap_sol_amount * 10**9)

                    try:
                        quote = await jupiter.get_quote(
                            input_mint=sol_mint,
                            output_mint=usdc_mint,
                            amount=swap_lamports,
                            slippage_bps=50,
                        )

                        if quote:
                            swap_result = await jupiter.execute_swap(quote=quote)
                            if swap_result.success:
                                print(f"Swap successful: {swap_result.signature}")
                                await asyncio.sleep(5)

                                # Refresh balances
                                sol_bal, usdc_bal, total_usd = await get_wallet_value_usd(solana_client, sol_price)
                                print(f"New wallet: {sol_bal:.4f} SOL + ${usdc_bal:.2f} USDC = ${total_usd:.2f} total")
                            else:
                                print(f"Swap failed: {swap_result.error}")
                        else:
                            print("Failed to get swap quote")
                    except Exception as e:
                        print(f"Swap failed: {e}")
                else:
                    print("Swap cancelled. Continuing with imbalanced portfolio...")

        elif usdc_pct > 0.60:
            # Swap USDC to SOL
            excess_usdc = usdc_bal - target_usdc_value

            if excess_usdc > 1:
                print(f"\nSwapping ${excess_usdc:.2f} USDC to SOL...")

                do_swap = args.auto_swap or args.no_confirm
                if not do_swap and confirm:
                    swap_response = input("Type 'SWAP' to execute swap: ")
                    do_swap = (swap_response == "SWAP")
                if do_swap:
                    from app.chain.aggregator_jupiter import JupiterClient
                    jupiter = JupiterClient(api_key=os.getenv("JUPITER_API_KEY"))

                    sol_mint = "So11111111111111111111111111111111111111112"
                    usdc_mint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"

                    swap_usdc_units = int(excess_usdc * 10**6)

                    try:
                        quote = await jupiter.get_quote(
                            input_mint=usdc_mint,
                            output_mint=sol_mint,
                            amount=swap_usdc_units,
                            slippage_bps=50,
                        )

                        if quote:
                            swap_result = await jupiter.execute_swap(quote=quote)
                            if swap_result.success:
                                print(f"Swap successful: {swap_result.signature}")
                                await asyncio.sleep(5)

                                # Refresh balances
                                sol_bal, usdc_bal, total_usd = await get_wallet_value_usd(solana_client, sol_price)
                                print(f"New wallet: {sol_bal:.4f} SOL + ${usdc_bal:.2f} USDC = ${total_usd:.2f} total")
                            else:
                                print(f"Swap failed: {swap_result.error}")
                        else:
                            print("Failed to get swap quote")
                    except Exception as e:
                        print(f"Swap failed: {e}")
                else:
                    print("Swap cancelled. Continuing with imbalanced portfolio...")

    # Determine position sizes based on available balance
    # Each test needs position_size + ~$2 for fees/rent, and we do 3 tests
    # Plus we need to keep some reserve for transaction fees
    reserve = 2.0  # Keep $2 for tx fees
    available_for_tests = total_usd - reserve

    if available_for_tests < 10:
        print(f"\nERROR: Insufficient balance. Need at least $12, have ${total_usd:.2f}")
        sys.exit(1)

    # Determine position sizes based on available balance
    if available_for_tests >= 200:
        position_sizes = [10, 50, 100]
        print(f"\nUsing standard test sizes: ${position_sizes}")
    elif available_for_tests >= 20:
        # Use smaller test sizes
        max_per_test = (available_for_tests - 6) / 3  # Reserve $2 per test for rent/fees
        position_sizes = [
            min(3, max_per_test),
            min(5, max_per_test),
            min(max_per_test, 7),
        ]
        print(f"\nUsing adjusted test sizes (limited balance): ${position_sizes}")
    else:
        # Single small test
        position_sizes = [min(3, available_for_tests - 3)]
        print(f"\nUsing minimal test size (very limited balance): ${position_sizes}")

    # Results storage
    results: List[TestResult] = []

    # Run tests WITH Token Extensions
    print("\n" + "=" * 70)
    print("TESTING WITH TOKEN EXTENSIONS (Token2022)")
    print("=" * 70)

    for size in position_sizes:
        print(f"\n--- Testing ${size} position ---")
        result = await run_single_test(
            orca_client=orca_client,
            solana_client=solana_client,
            pool_pubkey=pool_pubkey,
            position_size_usd=size,
            use_token_extensions=True,
            sol_price=sol_price,
        )
        results.append(result)

        if result.error:
            print(f"ERROR: {result.error}")
        else:
            print(f"  Open cost:  ${result.open_cost:.4f}")
            print(f"  Close cost: ${result.close_cost:.4f}")
            print(f"  Total cost: ${result.total_cost:.4f}")

        # Wait between tests
        await asyncio.sleep(5)

    # Print summary
    print("\n" + "=" * 70)
    print("TEST RESULTS SUMMARY")
    print("=" * 70)

    print("\n{:<15} {:<20} {:<15} {:<15} {:<15}".format(
        "Position Size", "Token Extensions", "Open Cost", "Close Cost", "Total Cost"
    ))
    print("-" * 80)

    for r in results:
        ext_str = "Token2022" if r.use_token_extensions else "SPL Token"
        if r.error:
            print(f"${r.position_size_usd:<14} {ext_str:<20} ERROR: {r.error[:40]}")
        else:
            print(f"${r.position_size_usd:<14} {ext_str:<20} ${r.open_cost:>13.4f} ${r.close_cost:>13.4f} ${r.total_cost:>13.4f}")

    # Calculate averages
    successful = [r for r in results if not r.error]
    if successful:
        avg_total = sum(r.total_cost for r in successful) / len(successful)
        print("-" * 80)
        print(f"{'Average':<15} {'Token2022':<20} {'':<15} {'':<15} ${avg_total:>13.4f}")

    # Final wallet balance
    print("\n" + "-" * 70)
    sol_bal, usdc_bal, final_total = await get_wallet_value_usd(solana_client, sol_price)
    initial_total = results[0].wallet_before_open if results else 0
    total_spent = initial_total - final_total

    print(f"\nFinal wallet: {sol_bal:.4f} SOL + ${usdc_bal:.2f} USDC = ${final_total:.2f} total")
    print(f"Total spent on all tests: ${total_spent:.4f}")

    # Expected costs comparison
    print("\n" + "=" * 70)
    print("EXPECTED COST COMPARISON (per position cycle)")
    print("=" * 70)
    print("\n  Standard SPL Token:")
    print("    - Position account rent: ~0.0088 SOL (refundable)")
    print("    - Mint account rent:     ~0.0089 SOL (NOT refundable)")
    print("    - Token ATA rent:        ~0.0023 SOL (refundable)")
    print("    - Network fees:          ~0.0002 SOL")
    print(f"    - Total lost per cycle:  ~0.0091 SOL (~${0.0091 * sol_price:.2f})")

    print("\n  Token Extensions (Token2022):")
    print("    - Position account rent: ~0.0088 SOL (refundable)")
    print("    - Mint account rent:     ~0.0089 SOL (REFUNDABLE!)")
    print("    - Token ATA rent:        ~0.0023 SOL (refundable)")
    print("    - Network fees:          ~0.0002 SOL")
    print(f"    - Total lost per cycle:  ~0.0002 SOL (~${0.0002 * sol_price:.2f})")

    print(f"\n  Estimated savings with Token2022: ~${0.0089 * sol_price:.2f} per position cycle")

    print("\n" + "=" * 70)
    print("TEST COMPLETE")
    print("=" * 70)


if __name__ == "__main__":
    asyncio.run(main())
