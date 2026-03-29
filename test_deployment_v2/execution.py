"""
Execution Module for LP Strategy v2.

Handles live trade execution including:
- Opening/closing Orca Whirlpool positions
- Jupiter swaps for token rebalancing
- Transaction management

Adapted from notebook live_lp_manager.ipynb execution logic.

================================================================================
FAILED POSITION OPEN HANDLING & RECOVERY FLOW
================================================================================

This is a CRITICAL system component that ensures liquidity is not left idle
when position opens fail. Understanding this flow is essential for maintaining
optimal capital utilization.

PROBLEM STATEMENT:
------------------
During a rebalance operation, we must:
1. Close the existing position (withdrawing funds to wallet)
2. Optionally swap tokens to achieve 50/50 balance
3. Open a new position at the updated price range

If step 3 fails, funds sit idle in the wallet earning no yield. This is a
critical failure state that must be detected and recovered from automatically.

FAILURE SCENARIOS (Why Position Opens Can Fail):
------------------------------------------------
1. TICK_INDEX ERRORS:
   - Tick boundaries must be multiples of pool's tick_spacing
   - If calculated ticks don't align, transaction fails with InvalidTickIndex
   - Solution: Always fetch tick_spacing from on-chain pool state before calculating ticks

2. INSUFFICIENT FUNDS:
   - Slippage during swap leaves insufficient tokens
   - TX fees consumed more than expected
   - Solution: Retry with refreshed balances, unrecoverable if wallet truly empty

3. SLIPPAGE EXCEEDED:
   - Price moved too much between quote and execution
   - Solution: Retry (price may stabilize) or accept wider slippage

4. NETWORK/RPC ERRORS:
   - Transaction timeout, RPC node issues
   - Solution: Automatic retry with exponential backoff

5. LIQUIDITY CALCULATION MISMATCH:
   - Calculated liquidity exceeds what tokens can provide
   - Solution: Recalculate with actual available balances on retry

RETRY MECHANISM (execution.py - rebalance_position):
----------------------------------------------------
The rebalance_position method implements immediate retry for failed opens:

    max_open_retries: int = 3  # Default: 3 attempts
    retry_delays = [2, 5, 10]  # Increasing delays between retries

    For each attempt:
    1. Fetch fresh wallet balances
    2. Recalculate liquidity based on actual available tokens
    3. Attempt to open position
    4. If "insufficient funds" error → stop retrying (unrecoverable)
    5. If other error → wait, then retry
    6. Track all errors in RebalanceResult.open_errors for debugging

    RebalanceResult fields for tracking:
    - fully_succeeded: bool     # True only if close AND open both succeeded
    - open_attempts: int        # How many open attempts were made
    - open_errors: List[str]    # All error messages from failed attempts

RECOVERY MECHANISM (lp_strategy.py):
------------------------------------
If all retries fail during rebalance, the recovery system activates:

1. DETECTION (in _execute_rebalance):
   ```python
   if close_result.success and (not open_result or not open_result.success):
       self._needs_position_recovery = True
       self._recovery_reason = reason
       # Send CRITICAL failure email
   ```

2. RECOVERY STATE VARIABLES:
   - _needs_position_recovery: bool  # Flag indicating recovery needed
   - _recovery_reason: str           # Why recovery is needed
   - _recovery_attempts: int         # Current recovery attempt count
   - _max_recovery_attempts: int = 8 # Max attempts before manual intervention (matches progressive slippage schedule: 7 increments = 8 attempts: 0-7)

3. RECOVERY EXECUTION (in _run_iteration):
   Each iteration checks for no active positions:
   ```python
   if len(self.position_monitors) == 0:
       if self._needs_position_recovery or self._recovery_attempts < 5:
           await self._attempt_position_recovery(market_state)
   ```

4. RECOVERY ATTEMPT (_attempt_position_recovery):
   - Recalculates range based on CURRENT market state (may differ from original)
   - Uses 90% of available balances (conservative)
   - Attempts open_position_with_rebalance (which handles swaps if needed)
   - On success: clears recovery flags, registers new position
   - On failure: logs error, increments attempt counter

5. MAX RECOVERY REACHED:
   After 8 failed recovery attempts:
   - Logs warning that manual intervention may be required
   - Funds remain idle in wallet
   - Operator must investigate (check logs, wallet, pool state)

EMAIL NOTIFICATIONS:
--------------------
The system sends detailed emails at each stage:

1. notify_rebalance_failed(): Sent when rebalance close succeeds but open fails
   - Contains: error messages, attempt count, withdrawn amounts
   - Indicates: funds are idle, automatic recovery will be attempted

2. notify_position_recovery(): Sent when recovery succeeds
   - Contains: new position details, recovery reason
   - Indicates: system has self-healed

3. notify_rebalance(): Regular rebalance notification includes:
   - open_attempts: how many tries it took
   - open_errors: any errors encountered
   - fully_succeeded: whether the operation fully completed

LIQUIDITY UTILIZATION IMPACT:
-----------------------------
This system is critical for liquidity utilization because:

- Idle funds earn 0% yield (opportunity cost)
- Position open failures are NOT rare in volatile markets
- Average recovery time: 1-5 iterations (1-5 minutes)
- Without recovery: funds could sit idle indefinitely
- With recovery: maximum idle time is bounded by retry/recovery mechanism

MONITORING & DEBUGGING:
-----------------------
To investigate failed position opens:

1. Check logs for "CRITICAL: Position close succeeded but NEW POSITION OPEN FAILED!"
2. Review RebalanceResult fields:
   - open_attempts: were all retries exhausted?
   - open_errors: what specific errors occurred?
3. Check wallet balances: are funds actually available?
4. Verify tick calculations: are they multiples of tick_spacing?
5. Check market volatility: extreme moves may cause repeated failures

CONFIGURATION:
--------------
Related config options (environment variables):
- MAX_SOL_PER_POSITION: Maximum SOL to use per position
- MAX_USDC_PER_POSITION: Maximum USDC to use per position
- MIN_SOL_RESERVE: SOL kept in wallet for TX fees (never deposited)
- SLIPPAGE_BPS: Slippage tolerance for position operations

================================================================================
"""

import asyncio
import structlog
import math
import struct
import base64
import random
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
from typing import Optional, Tuple, Dict, Any, List
from dataclasses import field

import httpx
from solders.keypair import Keypair
from solders.pubkey import Pubkey
from solders.transaction import VersionedTransaction
from solders.message import MessageV0
import base58

from config import get_config, Config
from email_notifier import get_email_notifier

# Import V6 Jupiter client
from app.chain.aggregator_jupiter import get_jupiter_client, Quote as JupiterQuote
from app.chain.aggregator_jupiter import SwapResult as JupiterSwapResult

logger = structlog.get_logger(__name__)

# Constants
SOL_MINT = "So11111111111111111111111111111111111111112"
USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
Q64 = 2**64

# Orca Whirlpool program
WHIRLPOOL_PROGRAM_ID = "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc"

# Jupiter API - MIGRATED TO V6
# V6 client is imported from app/chain/aggregator_jupiter
# Old V1 API constant removed (was: "https://api.jup.ag/swap/v1")


# ============================================================
# DATA TYPES
# ============================================================

@dataclass
class SwapResult:
    """Result of a Jupiter swap."""
    success: bool
    signature: Optional[str] = None
    input_amount: float = 0.0
    output_amount: float = 0.0
    error: Optional[str] = None
    # Direction and token tracking - set by the caller who knows the swap direction
    direction: Optional[str] = None  # 'sell_sol' or 'buy_sol'
    input_token: Optional[str] = None  # 'SOL' or 'USDC'
    output_token: Optional[str] = None  # 'SOL' or 'USDC'
    tx_fee_sol: float = 0.0  # Transaction fee (from RPC)
    skipped: bool = False  # Swap skipped due to min swap threshold
    # Ultra API tracking fields
    used_ultra_api: bool = False
    gasless_used: bool = False
    execution_time_ms: Optional[int] = None
    # Actual cost tracking (balance-based)
    actual_cost: Optional['ActualCost'] = None


@dataclass
class PositionOpenResult:
    """Result of opening a position."""
    success: bool
    position_address: Optional[str] = None
    signature: Optional[str] = None
    deposited_sol: float = 0.0
    deposited_usdc: float = 0.0
    liquidity: int = 0
    lower_tick: int = 0
    upper_tick: int = 0
    lower_price: float = 0.0
    upper_price: float = 0.0
    error: Optional[str] = None


@dataclass
class PositionCloseResult:
    """Result of closing a position."""
    success: bool
    signature: Optional[str] = None
    withdrawn_sol: float = 0.0
    withdrawn_usdc: float = 0.0
    fees_collected_sol: float = 0.0
    fees_collected_usdc: float = 0.0
    tx_fee_sol: float = 0.0  # Actual tx fee (calculated from balance diff)
    error: Optional[str] = None
    # Actual cost tracking (balance-based)
    actual_cost: Optional['ActualCost'] = None


@dataclass
class PositionOpenResultWithFee(PositionOpenResult):
    """Position open result with actual tx fee."""
    tx_fee_sol: float = 0.0  # Actual tx fee (calculated from balance diff)
    # Actual cost tracking (balance-based)
    actual_cost: Optional['ActualCost'] = None


@dataclass
class RebalanceResult:
    """Result of a full rebalance operation."""
    close_result: Optional[PositionCloseResult] = None
    open_result: Optional[PositionOpenResult] = None
    swap_result: Optional[SwapResult] = None
    total_tx_fees_sol: float = 0.0
    # Track if the rebalance fully succeeded (close AND open both worked)
    fully_succeeded: bool = False
    # Track retry attempts for debugging
    open_attempts: int = 0
    open_errors: List[str] = field(default_factory=list)
    # Per-operation actual cost tracking (balance-based)
    total_actual_cost: Optional['ActualCost'] = None
    # Whole-rebalance cost: single measurement from start to end of entire rebalance
    # Avoids inter-operation snapshot timing noise
    whole_rebalance_cost_usd: float = 0.0


@dataclass
class ActualCost:
    """
    Actual cost from wallet balance difference.

    Captures ALL costs including:
    - Transaction fees (base + priority)
    - Slippage (price impact during swaps)
    - Account rent for new accounts
    - Liquidity calculation rounding losses

    This is more accurate than RPC-reported fees which only capture TX fees.
    """
    # Before operation
    sol_before: float = 0.0
    usdc_before: float = 0.0
    value_before_usd: float = 0.0

    # After operation
    sol_after: float = 0.0
    usdc_after: float = 0.0
    value_after_usd: float = 0.0

    # Position value adjustment (for opens/closes)
    position_value_usd: float = 0.0

    # Calculated costs
    actual_cost_usd: float = 0.0
    actual_cost_sol: float = 0.0

    # RPC comparison
    rpc_fee_sol: float = 0.0
    rpc_fee_usd: float = 0.0

    # Metadata
    price_at_calc: float = 0.0
    operation_type: str = ""  # 'swap', 'position_open', 'position_close'


# ============================================================
# JUPITER CLIENT (V6 MIGRATION)
# ============================================================
# 
# MIGRATED FROM V1 TO V6 API (December 31, 2025)
# 
# The embedded V1 client has been removed and replaced with
# the proper V6 client from app/chain/aggregator_jupiter.py
# 
# This fixes:
# 1. Route staleness issues (primary)
# 2. API deprecation (secondary)
# 
# The V6 client uses a different interface:
# - V1: execute_swap(input_mint, output_mint, amount, slippage_bps, wallet_keypair)
# - V6: get_quote(...) then execute_swap(quote, user_keypair)
# 
# A wrapper adapter is provided below to maintain compatibility.
# ============================================================

class JupiterClientAdapter:
    """
    Adapter wrapper for Jupiter client to maintain compatibility
    with existing code that expects the V1 interface.

    This adapter:
    1. Wraps JupiterSwapService which auto-selects between Swap API and Ultra API
    2. Provides the same interface as the old V1 client
    3. Converts SwapResult types (V6 uses int amounts, we need float)
    4. Handles direction/token metadata
    5. Supports Jupiter Ultra API for rewards eligibility when configured
    """

    def __init__(self, api_key: str = "", rpc_url: str = "", config: Optional[Config] = None):
        """
        Initialize adapter.

        Args:
            api_key: Jupiter API key
            rpc_url: RPC URL (kept for compatibility)
            config: Strategy config for Ultra API settings
        """
        self.api_key = api_key
        self.rpc_url = rpc_url
        self._config = config
        self._v6_client = None  # For quotes and test_connection
        self._swap_service = None  # For swap execution

    async def _get_v6_client(self):
        """Get or create V6 Jupiter client instance."""
        if self._v6_client is None:
            api_key = self.api_key if self.api_key else None
            self._v6_client = await get_jupiter_client(api_key=api_key)
        return self._v6_client

    async def _get_swap_service(self):
        """Get or create JupiterSwapService instance."""
        if self._swap_service is None:
            from app.chain.aggregator_jupiter import JupiterSwapService

            # Get Ultra settings from config
            use_ultra = False
            ultra_gasless = True
            fallback_enabled = True
            circuit_breaker_threshold = 3
            circuit_breaker_cooldown = 300

            if self._config and hasattr(self._config, 'jupiter'):
                use_ultra = self._config.jupiter.use_ultra
                ultra_gasless = self._config.jupiter.ultra_gasless
                fallback_enabled = self._config.jupiter.ultra_fallback_enabled
                circuit_breaker_threshold = self._config.jupiter.ultra_circuit_breaker_threshold
                circuit_breaker_cooldown = self._config.jupiter.ultra_circuit_breaker_cooldown

            self._swap_service = JupiterSwapService(
                use_ultra=use_ultra,
                ultra_gasless=ultra_gasless,
                fallback_enabled=fallback_enabled,
                circuit_breaker_threshold=circuit_breaker_threshold,
                circuit_breaker_cooldown=circuit_breaker_cooldown,
                api_key=self.api_key if self.api_key else None,
            )
        return self._swap_service

    async def test_connection(self) -> Tuple[bool, str]:
        """Test if Jupiter API is reachable."""
        try:
            client = await self._get_v6_client()
            # Test with a small quote
            quote = await client.get_quote(
                input_mint=SOL_MINT,
                output_mint=USDC_MINT,
                amount=int(0.001 * 1e9),  # 0.001 SOL
                slippage_bps=50,
            )
            out_amount = quote.out_amount / 1e6  # Convert to USDC
            ultra_status = "Ultra enabled" if (self._config and hasattr(self._config, 'jupiter') and self._config.jupiter.use_ultra) else "Swap API"
            return True, f"Connected ({ultra_status}). 0.001 SOL = ${out_amount:.4f} USDC"
        except Exception as e:
            return False, str(e)

    async def get_quote(
        self,
        input_mint: str,
        output_mint: str,
        amount: int,
        slippage_bps: int = 100,
    ) -> Optional[Dict]:
        """
        Get swap quote from Jupiter V6 API.

        Returns dict format for compatibility with old code.
        """
        try:
            client = await self._get_v6_client()
            quote = await client.get_quote(
                input_mint=input_mint,
                output_mint=output_mint,
                amount=amount,
                slippage_bps=slippage_bps,
            )
            # Convert Quote object to dict format for compatibility
            return {
                "inAmount": str(quote.in_amount),
                "outAmount": str(quote.out_amount),
                "priceImpactPct": quote.price_impact_pct,
                "contextSlot": quote.context_slot,
                "routePlan": quote.route_plan,
            }
        except Exception as e:
            logger.error(f"Jupiter quote error: {e}")
            return None

    async def execute_swap(
        self,
        input_mint: str,
        output_mint: str,
        amount: int,
        slippage_bps: int = 100,
        wallet_keypair: Keypair = None,
    ) -> SwapResult:
        """
        Execute a swap via Jupiter API (Ultra or Swap API based on config).

        This method maintains the same interface as the old V1 client
        but uses JupiterSwapService internally for Ultra API support.

        Args:
            input_mint: Token to sell
            output_mint: Token to buy
            amount: Amount in smallest units
            slippage_bps: Slippage tolerance
            wallet_keypair: Wallet keypair for signing

        Returns:
            SwapResult with transaction details (execution.py format)
        """
        if wallet_keypair is None:
            return SwapResult(success=False, error="No wallet keypair provided")

        try:
            swap_service = await self._get_swap_service()

            # Execute swap via SwapService (handles Ultra/Swap API selection)
            service_result = await swap_service.execute_swap(
                input_mint=input_mint,
                output_mint=output_mint,
                amount=amount,
                taker_keypair=wallet_keypair,
                slippage_bps=slippage_bps,
            )

            # Convert amounts from int to float
            if input_mint == SOL_MINT:
                input_amount = service_result.input_amount / 1e9  # SOL (9 decimals)
                output_amount = service_result.output_amount / 1e6  # USDC (6 decimals)
            else:
                input_amount = service_result.input_amount / 1e6  # USDC (6 decimals)
                output_amount = service_result.output_amount / 1e9  # SOL (9 decimals)

            # Create execution.py SwapResult
            result = SwapResult(
                success=service_result.success,
                signature=service_result.signature,
                input_amount=input_amount,
                output_amount=output_amount,
                error=service_result.error,
                # Note: direction, input_token, output_token, tx_fee_sol
                # are set by the caller who knows the swap direction
            )

            logger.info(f"Jupiter swap: {input_amount:.4f} -> {output_amount:.4f}")

            return result

        except Exception as e:
            logger.exception(f"Swap execution error: {e}")
            return SwapResult(success=False, error=f"Execution error: {e}")


# Keep old class name for compatibility during migration
# TODO: Remove this alias after verifying everything works
JupiterClient = JupiterClientAdapter


# ============================================================
# OLD V1 JUPITER CLIENT (REMOVED)
# ============================================================
# 
# The embedded V1 client (lines 269-XXX) has been removed.
# 
# Migration completed: December 31, 2025
# - Replaced with V6 client from app/chain/aggregator_jupiter.py
# - Uses JupiterClientAdapter wrapper for compatibility
# - Fixes route staleness and API deprecation issues
# 
# Old V1 client code removed:
# - JupiterClient class (was lines 269-XXX)
# - _wait_for_confirmation method
# - JUPITER_API_BASE constant (was line 194)
# ============================================================

# OLD V1 CLIENT CODE REMOVED - Using V6 client via adapter above


# ============================================================
# TRANSACTION PARSING - Extract exact on-chain token amounts
# ============================================================

async def parse_open_position_amounts(
    rpc_url: str,
    signature: str,
    wallet_address: str,
) -> Tuple[float, float]:
    """
    Parse EXACT deposited token amounts from an open position transaction.

    Uses the inner instruction transfers (Approach 2) which have been verified
    to produce exact matches with Solscan values.

    Args:
        rpc_url: Solana RPC URL
        signature: Transaction signature
        wallet_address: Wallet public key string

    Returns:
        (sol_deposited, usdc_deposited) - exact amounts from the transaction

    Raises:
        ValueError: If transaction cannot be fetched or parsed
    """
    async with httpx.AsyncClient(timeout=30.0) as client:
        payload = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "getTransaction",
            "params": [
                signature,
                {"encoding": "jsonParsed", "maxSupportedTransactionVersion": 0}
            ]
        }

        # Retry fetching (RPC may need time to index)
        max_fetch_attempts = 12
        result = None
        for attempt in range(max_fetch_attempts):
            response = await client.post(rpc_url, json=payload)
            response.raise_for_status()
            tx_data = response.json()
            result = tx_data.get("result")
            if result:
                break
            wait_s = min(3 + attempt, 8)  # 3s, 4s, 5s, 6s, 7s, 8s, 8s...
            logger.info(f"  TX not yet indexed (attempt {attempt+1}/{max_fetch_attempts}), waiting {wait_s}s...")
            await asyncio.sleep(wait_s)

        if not result:
            raise ValueError(f"Transaction {signature[:16]}... not found after {max_fetch_attempts} attempts")

        meta = result.get("meta", {})
        if meta.get("err"):
            raise ValueError(f"Transaction failed: {meta['err']}")

        inner_instructions = meta.get("innerInstructions", [])
        pre_balances = meta.get("preTokenBalances", [])
        post_balances = meta.get("postTokenBalances", [])
        account_keys = result.get("transaction", {}).get("message", {}).get("accountKeys", [])

        # Build address -> mint map from token balances
        address_to_mint = {}
        for b in pre_balances + post_balances:
            idx = b.get("accountIndex", -1)
            mint = b.get("mint", "")
            if 0 <= idx < len(account_keys):
                addr = account_keys[idx]
                if isinstance(addr, dict):
                    addr = addr.get("pubkey", "")
                address_to_mint[addr] = mint

        sol_deposited = 0.0
        usdc_deposited = 0.0

        for inner_group in inner_instructions:
            for ix in inner_group.get("instructions", []):
                parsed = ix.get("parsed")
                if not parsed or parsed.get("type") != "transfer":
                    continue
                info = parsed.get("info", {})
                if info.get("authority") != wallet_address:
                    continue

                amount_raw = int(info.get("amount", "0"))
                source = info.get("source", "")
                destination = info.get("destination", "")
                mint = address_to_mint.get(source, "") or address_to_mint.get(destination, "")

                if mint == SOL_MINT:
                    sol_deposited += amount_raw / 1e9
                elif mint == USDC_MINT:
                    usdc_deposited += amount_raw / 1e6

        if sol_deposited == 0.0 and usdc_deposited == 0.0:
            raise ValueError(f"No wallet transfers found in TX {signature[:16]}...")

        logger.info(f"  TX parsed (exact): {sol_deposited:.9f} SOL, ${usdc_deposited:.6f} USDC")
        return sol_deposited, usdc_deposited


async def parse_close_position_amounts(
    rpc_url: str,
    signature: str,
) -> Tuple[float, float, float, float]:
    """
    Parse EXACT withdrawn amounts and fees from a close position transaction.

    Uses Anchor log events (Approach 3) for principal amounts and inner instruction
    group analysis for fee amounts. Verified to match Solscan exactly.

    The close TX structure is:
    - collectFees instruction → small transfers (fees)
    - decreaseLiquidity instruction → large transfers (principal)
    - closePosition instruction → account cleanup

    Args:
        rpc_url: Solana RPC URL
        signature: Transaction signature

    Returns:
        (principal_sol, principal_usdc, fees_sol, fees_usdc) - exact amounts

    Raises:
        ValueError: If transaction cannot be fetched or parsed
    """
    async with httpx.AsyncClient(timeout=30.0) as client:
        payload = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "getTransaction",
            "params": [
                signature,
                {"encoding": "jsonParsed", "maxSupportedTransactionVersion": 0}
            ]
        }

        # Retry fetching (RPC may need time to index)
        max_fetch_attempts = 12
        result = None
        for attempt in range(max_fetch_attempts):
            response = await client.post(rpc_url, json=payload)
            response.raise_for_status()
            tx_data = response.json()
            result = tx_data.get("result")
            if result:
                break
            wait_s = min(3 + attempt, 8)  # 3s, 4s, 5s, 6s, 7s, 8s, 8s...
            logger.info(f"  TX not yet indexed (attempt {attempt+1}/{max_fetch_attempts}), waiting {wait_s}s...")
            await asyncio.sleep(wait_s)

        if not result:
            raise ValueError(f"Transaction {signature[:16]}... not found after {max_fetch_attempts} attempts")

        meta = result.get("meta", {})
        if meta.get("err"):
            raise ValueError(f"Transaction failed: {meta['err']}")

        inner_instructions = meta.get("innerInstructions", [])
        pre_balances = meta.get("preTokenBalances", [])
        post_balances = meta.get("postTokenBalances", [])
        account_keys = result.get("transaction", {}).get("message", {}).get("accountKeys", [])

        # Build address -> mint map
        address_to_mint = {}
        for b in pre_balances + post_balances:
            idx = b.get("accountIndex", -1)
            mint = b.get("mint", "")
            if 0 <= idx < len(account_keys):
                addr = account_keys[idx]
                if isinstance(addr, dict):
                    addr = addr.get("pubkey", "")
                address_to_mint[addr] = mint

        # Parse inner instruction groups to separate fees from principal.
        # Close TX has instructions in order:
        #   [compute budget] [compute budget] [updateFeesAndRewards+collectFees] [decreaseLiquidity] [closePosition] [wsol unwrap]
        # Inner instruction groups correspond to outer instruction indices.
        # We collect transfers per group and identify fees (smallest group) vs principal (largest group).
        group_transfers = {}
        for inner_group in inner_instructions:
            group_idx = inner_group.get("index", -1)
            sol_amount = 0.0
            usdc_amount = 0.0
            for ix in inner_group.get("instructions", []):
                parsed = ix.get("parsed")
                if not parsed or parsed.get("type") != "transfer":
                    continue
                info = parsed.get("info", {})
                amount_raw = int(info.get("amount", "0"))
                source = info.get("source", "")
                destination = info.get("destination", "")
                mint = address_to_mint.get(source, "") or address_to_mint.get(destination, "")
                if mint == SOL_MINT:
                    sol_amount += amount_raw / 1e9
                elif mint == USDC_MINT:
                    usdc_amount += amount_raw / 1e6
            if sol_amount > 0 or usdc_amount > 0:
                group_transfers[group_idx] = (sol_amount, usdc_amount)

        # Identify principal vs fees by finding the group with the largest total
        # Principal group has much larger amounts than fee group
        principal_sol = 0.0
        principal_usdc = 0.0
        fees_sol = 0.0
        fees_usdc = 0.0

        if len(group_transfers) >= 2:
            # Sort groups by total value (largest = principal)
            sorted_groups = sorted(
                group_transfers.items(),
                key=lambda x: x[1][0] + x[1][1],
                reverse=True,
            )
            principal_sol, principal_usdc = sorted_groups[0][1]
            # Sum all remaining groups as fees
            for _, (s, u) in sorted_groups[1:]:
                fees_sol += s
                fees_usdc += u
        elif len(group_transfers) == 1:
            # Only one group with transfers = principal (no fees collected)
            _, (principal_sol, principal_usdc) = list(group_transfers.items())[0]

        # Cross-validate with log events (LiquidityDecreased)
        log_messages = meta.get("logMessages", [])
        for log_line in log_messages:
            if log_line.startswith("Program data:"):
                data_b64 = log_line.split("Program data: ", 1)[1].strip()
                try:
                    data = base64.b64decode(data_b64)
                    if len(data) >= 8 + 32 + 32 + 4 + 4 + 16 + 8 + 8:
                        offset = 8 + 32 + 32 + 4 + 4 + 16
                        ta = struct.unpack_from("<Q", data, offset)[0]
                        tb = struct.unpack_from("<Q", data, offset + 8)[0]
                        event_sol = ta / 1e9
                        event_usdc = tb / 1e6
                        if 0.0001 < event_sol < 100000 and 0.001 < event_usdc < 100000000:
                            # Validate against inner instruction parsing
                            if abs(event_sol - principal_sol) > 0.001 or abs(event_usdc - principal_usdc) > 0.01:
                                logger.warning(
                                    f"  Close TX parsing mismatch: "
                                    f"inner={principal_sol:.9f}/{principal_usdc:.6f} "
                                    f"vs event={event_sol:.9f}/{event_usdc:.6f}"
                                )
                                # Trust the log event (more authoritative)
                                principal_sol = event_sol
                                principal_usdc = event_usdc
                            break
                except Exception:
                    pass

        if principal_sol == 0.0 and principal_usdc == 0.0:
            raise ValueError(f"No principal amounts found in close TX {signature[:16]}...")

        logger.info(
            f"  Close TX parsed: principal={principal_sol:.9f} SOL + ${principal_usdc:.6f} USDC, "
            f"fees={fees_sol:.9f} SOL + ${fees_usdc:.6f} USDC"
        )
        return principal_sol, principal_usdc, fees_sol, fees_usdc


async def parse_swap_amounts(
    rpc_url: str,
    signature: str,
    wallet_address: str,
) -> Tuple[float, float, float, float]:
    """
    Parse exact input/output amounts from a swap transaction.

    Uses preTokenBalances/postTokenBalances and native SOL balance diffs
    from getTransaction to compute exact wallet-level token changes.

    For SOL, combines native lamport balance diff with wSOL token account
    changes, since Jupiter wraps/unwraps SOL during swaps.

    Args:
        rpc_url: Solana RPC URL
        signature: Transaction signature
        wallet_address: Wallet public key string

    Returns:
        (input_sol, input_usdc, output_sol, output_usdc) where
        one pair is zero depending on swap direction.
        For sell_sol: input_sol > 0, output_usdc > 0, others = 0
        For buy_sol: input_usdc > 0, output_sol > 0, others = 0
    """
    async with httpx.AsyncClient(timeout=30.0) as client:
        payload = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "getTransaction",
            "params": [
                signature,
                {"encoding": "jsonParsed", "maxSupportedTransactionVersion": 0}
            ]
        }

        max_fetch_attempts = 12
        result = None
        for attempt in range(max_fetch_attempts):
            response = await client.post(rpc_url, json=payload)
            response.raise_for_status()
            tx_data = response.json()
            result = tx_data.get("result")
            if result:
                break
            wait_s = min(3 + attempt, 8)  # 3s, 4s, 5s, 6s, 7s, 8s, 8s...
            logger.info(f"  Swap TX not yet indexed (attempt {attempt+1}/{max_fetch_attempts}), waiting {wait_s}s...")
            await asyncio.sleep(wait_s)

        if not result:
            raise ValueError(f"Swap transaction {signature[:16]}... not found after {max_fetch_attempts} attempts")

        meta = result.get("meta", {})
        if meta.get("err"):
            raise ValueError(f"Swap transaction failed: {meta['err']}")

        account_keys = result.get("transaction", {}).get("message", {}).get("accountKeys", [])
        pre_token_balances = meta.get("preTokenBalances", [])
        post_token_balances = meta.get("postTokenBalances", [])
        pre_balances = meta.get("preBalances", [])
        post_balances = meta.get("postBalances", [])

        # Find wallet index in account keys
        wallet_idx = -1
        for i, key in enumerate(account_keys):
            addr = key.get("pubkey", key) if isinstance(key, dict) else key
            if addr == wallet_address:
                wallet_idx = i
                break

        if wallet_idx < 0:
            raise ValueError(f"Wallet {wallet_address[:16]}... not found in transaction accounts")

        # Calculate native SOL diff (lamports) for the wallet
        native_sol_diff = 0.0
        if wallet_idx < len(pre_balances) and wallet_idx < len(post_balances):
            fee_lamports = meta.get("fee", 0)
            # Add back fee to isolate the swap amount from TX cost
            native_sol_diff = (post_balances[wallet_idx] - pre_balances[wallet_idx] + fee_lamports) / 1e9

        # Calculate token balance diffs for wallet-owned token accounts
        # Build map: (owner, mint) -> (pre_amount, post_amount)
        def get_token_diff(mint: str) -> float:
            """Sum up all token balance changes for wallet-owned accounts of given mint."""
            pre_amounts = {}
            post_amounts = {}
            for bal in pre_token_balances:
                if bal.get("mint") == mint and bal.get("owner") == wallet_address:
                    idx = bal.get("accountIndex", -1)
                    ui_amount = bal.get("uiTokenAmount", {}).get("uiAmount")
                    if ui_amount is not None:
                        pre_amounts[idx] = float(ui_amount)
            for bal in post_token_balances:
                if bal.get("mint") == mint and bal.get("owner") == wallet_address:
                    idx = bal.get("accountIndex", -1)
                    ui_amount = bal.get("uiTokenAmount", {}).get("uiAmount")
                    if ui_amount is not None:
                        post_amounts[idx] = float(ui_amount)
            # Sum diffs across all accounts
            all_indices = set(pre_amounts.keys()) | set(post_amounts.keys())
            total_diff = 0.0
            for idx in all_indices:
                total_diff += post_amounts.get(idx, 0.0) - pre_amounts.get(idx, 0.0)
            return total_diff

        wsol_diff = get_token_diff(SOL_MINT)
        usdc_diff = get_token_diff(USDC_MINT)

        # Total SOL change = native lamport diff + wSOL token diff
        total_sol_diff = native_sol_diff + wsol_diff

        # Determine direction and amounts
        input_sol = 0.0
        input_usdc = 0.0
        output_sol = 0.0
        output_usdc = 0.0

        if total_sol_diff < -0.0001:
            # Sold SOL
            input_sol = abs(total_sol_diff)
            output_usdc = max(0.0, usdc_diff)
        elif total_sol_diff > 0.0001:
            # Bought SOL
            output_sol = total_sol_diff
            input_usdc = abs(min(0.0, usdc_diff))
        else:
            # Ambiguous — use USDC diff to determine
            if usdc_diff > 0.01:
                output_usdc = usdc_diff
            elif usdc_diff < -0.01:
                input_usdc = abs(usdc_diff)

        logger.info(
            f"  Swap TX parsed: in={input_sol:.6f} SOL + ${input_usdc:.2f} USDC, "
            f"out={output_sol:.6f} SOL + ${output_usdc:.2f} USDC"
        )

        return input_sol, input_usdc, output_sol, output_usdc


# ============================================================
# SOLANA CLIENT
# ============================================================

class SolanaExecutionClient:
    """
    Solana client for transaction execution.

    Provides wallet management and transaction submission.
    """

    def __init__(self, rpc_url: str, wallet_key_base58: str = ""):
        self.rpc_url = rpc_url
        self._wallet: Optional[Keypair] = None
        self._request_id = 0

        if wallet_key_base58:
            self.load_wallet(wallet_key_base58)

    def load_wallet(self, private_key_base58: str) -> None:
        """Load wallet from base58 private key."""
        key_bytes = base58.b58decode(private_key_base58)
        self._wallet = Keypair.from_bytes(key_bytes)
        logger.info(f"Wallet loaded: {self._wallet.pubkey()}")

    @property
    def wallet(self) -> Optional[Keypair]:
        return self._wallet

    @property
    def wallet_pubkey(self) -> Optional[Pubkey]:
        return self._wallet.pubkey() if self._wallet else None

    async def _rpc_call(self, method: str, params: List = None) -> Any:
        """Make RPC call."""
        self._request_id += 1
        payload = {
            "jsonrpc": "2.0",
            "id": self._request_id,
            "method": method,
            "params": params or []
        }

        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(self.rpc_url, json=payload)
            data = resp.json()

            if "error" in data:
                raise Exception(f"RPC error: {data['error']}")

            return data.get("result")

    async def get_balance_sol(self) -> float:
        """Get SOL balance."""
        if not self._wallet:
            return 0.0

        result = await self._rpc_call("getBalance", [
            str(self._wallet.pubkey()),
            {"commitment": "confirmed"}
        ])
        lamports = result.get("value", 0)
        return lamports / 1e9

    async def get_token_balance(self, mint: str) -> float:
        """Get token balance for a specific mint."""
        if not self._wallet:
            return 0.0

        try:
            result = await self._rpc_call("getTokenAccountsByOwner", [
                str(self._wallet.pubkey()),
                {"mint": mint},
                {"encoding": "jsonParsed", "commitment": "confirmed"}
            ])

            accounts = result.get("value", [])
            total = 0.0
            for acc in accounts:
                parsed = acc.get("account", {}).get("data", {}).get("parsed", {})
                info = parsed.get("info", {})
                token_amount = info.get("tokenAmount", {})
                total += float(token_amount.get("uiAmount", 0))

            return total

        except Exception as e:
            logger.warning(f"Failed to get token balance: {e}")
            return 0.0

    async def get_usdc_balance(self) -> float:
        """Get USDC balance."""
        return await self.get_token_balance(USDC_MINT)

    async def get_wsol_balance(self) -> float:
        """Get WSOL balance."""
        return await self.get_token_balance(SOL_MINT)

    async def get_balances(self, include_wsol: bool = True) -> Tuple[float, float]:
        """
        Get both SOL and USDC balances.

        Args:
            include_wsol: If True, includes wSOL balance in SOL total.
                         This is important because wSOL IS SOL, just wrapped.

        Returns:
            Tuple of (total_sol, usdc) where total_sol includes native + wSOL
        """
        native_sol = await self.get_balance_sol()
        usdc = await self.get_usdc_balance()

        if include_wsol:
            wsol = await self.get_wsol_balance()
            if wsol > 0:
                logger.info(f"Balance includes wSOL: {wsol:.4f} wSOL + {native_sol:.4f} native = {native_sol + wsol:.4f} total SOL")
            return native_sol + wsol, usdc

        return native_sol, usdc


# ============================================================
# POSITION EXECUTOR
# ============================================================

class PositionExecutor:
    """
    Executes position open/close operations via Orca Whirlpools.

    Uses the app's OrcaClient for actual transaction building and execution.
    """

    def __init__(self, config: Config):
        self.config = config
        self._orca_client = None
        self._solana_client = None

    async def initialize(self) -> bool:
        """Initialize clients."""
        try:
            # Import from app module
            import sys
            from pathlib import Path

            # Add project root to path
            project_root = Path(__file__).parent.parent
            if str(project_root) not in sys.path:
                sys.path.insert(0, str(project_root))

            from app.chain.orca_client import get_orca_client, OrcaClient
            from app.chain.solana_client import get_solana_client, SolanaClient

            # Initialize clients
            self._solana_client = await get_solana_client()
            self._solana_client.load_wallet(self.config.api.wallet_private_key)

            self._orca_client = await get_orca_client()

            logger.info("PositionExecutor initialized")
            return True

        except Exception as e:
            logger.error(f"Failed to initialize PositionExecutor: {e}")
            return False

    async def get_pool_state(self, pool_address: str = None, force_refresh: bool = True):
        """
        Get current pool state.
        
        Args:
            pool_address: Pool address (uses config default if None)
            force_refresh: If True, bypass cache and fetch fresh data from chain
        """
        if not self._orca_client:
            raise RuntimeError("PositionExecutor not initialized")

        pool = pool_address or self.config.pool.pool_address
        return await self._orca_client.get_pool_state(pool, force_refresh=force_refresh)

    async def open_position(
        self,
        lower_tick: int,
        upper_tick: int,
        liquidity_amount: int,
        token_max_a: int,
        token_max_b: int,
        pool_address: str = None,
        slippage_buffer_bps: int = 200,
    ) -> PositionOpenResult:
        """
        Open a new position.

        Args:
            lower_tick: Lower tick index
            upper_tick: Upper tick index
            liquidity_amount: Liquidity to provide
            token_max_a: Max SOL to deposit (in lamports)
            token_max_b: Max USDC to deposit (in micro-USDC)
            pool_address: Optional pool address
            slippage_buffer_bps: Slippage buffer in basis points (default 200 = 2%)

        Returns:
            PositionOpenResult with transaction details
        """
        if not self._orca_client:
            return PositionOpenResult(success=False, error="Not initialized")

        try:
            pool = pool_address or self.config.pool.pool_address

            # NOTE: token_max values already include generous buffers from caller
            # (typically 50% + 2x safety, capped at wallet balance).
            # DO NOT apply additional buffers here as it would push values above
            # available wallet balance and cause "insufficient funds" errors.
            # The slippage_buffer_bps parameter is preserved for API compatibility
            # but is intentionally not applied to prevent double buffering.

            receipt = await self._orca_client.execute_open_position(
                pool_pubkey=pool,
                lower_tick=lower_tick,
                upper_tick=upper_tick,
                liquidity_amount=liquidity_amount,
                token_max_a=token_max_a,
                token_max_b=token_max_b,
            )

            if receipt.is_success:
                position_address = receipt.metadata.get('position_address', 'unknown')
                logger.info(f"Position opened: {position_address}")
                logger.info(f"  Signature: {receipt.signature}")

                # Parse EXACT deposited amounts from the confirmed transaction.
                # This replaces the old estimate_amounts_from_liquidity() approach which
                # used a stale sqrt_price and produced wrong SOL/USDC splits.
                lower_price = tick_to_price(lower_tick)
                upper_price = tick_to_price(upper_tick)

                actual_sol = 0.0
                actual_usdc = 0.0
                actual_liquidity = liquidity_amount

                try:
                    wallet_addr = str(self._solana_client.wallet_pubkey)
                    actual_sol, actual_usdc = await parse_open_position_amounts(
                        rpc_url=self.config.api.rpc_url,
                        signature=receipt.signature,
                        wallet_address=wallet_addr,
                    )
                    logger.info(f"  TX-parsed deposited: {actual_sol:.9f} SOL, ${actual_usdc:.6f} USDC")
                    logger.info(f"  Max provided: {token_max_a / 1e9:.6f} SOL, ${token_max_b / 1e6:.2f} USDC")

                    # Log utilization for analysis
                    sol_pct = (actual_sol / (token_max_a / 1e9) * 100) if token_max_a > 0 else 0
                    usdc_pct = (actual_usdc / (token_max_b / 1e6) * 100) if token_max_b > 0 else 0
                    logger.info(f"  Utilization: SOL {sol_pct:.1f}%, USDC {usdc_pct:.1f}%")

                    # Also verify position exists on-chain (query liquidity)
                    position_state = None
                    for attempt in range(5):
                        await asyncio.sleep(1.0 + attempt)
                        position_state = await self._orca_client.get_position_state(position_address)
                        if position_state is not None:
                            actual_liquidity = position_state.liquidity
                            logger.info(f"  On-chain liquidity: {actual_liquidity:,}")
                            break
                    if position_state is None:
                        logger.error(f"CRITICAL: Could not verify position {position_address} on-chain after 5 attempts")
                        return PositionOpenResult(
                            success=False,
                            error=f"Position verification failed: could not query position state for {position_address}. TX signature: {receipt.signature}"
                        )

                except Exception as e:
                    logger.error(f"CRITICAL: Failed to parse open TX or verify position: {e}")
                    logger.error("Returning FAILURE to trigger proper recovery flow")
                    return PositionOpenResult(
                        success=False,
                        error=f"TX parsing / position verification failed: {e}. TX signature: {receipt.signature}"
                    )

                return PositionOpenResult(
                    success=True,
                    position_address=position_address,
                    signature=receipt.signature,
                    deposited_sol=actual_sol,
                    deposited_usdc=actual_usdc,
                    liquidity=actual_liquidity,
                    lower_tick=lower_tick,
                    upper_tick=upper_tick,
                    lower_price=lower_price,
                    upper_price=upper_price,
                )
            else:
                return PositionOpenResult(
                    success=False,
                    error=receipt.error or "Unknown error"
                )

        except Exception as e:
            logger.exception(f"Failed to open position: {e}")
            return PositionOpenResult(success=False, error=str(e))

    async def close_position(
        self,
        position_address: str,
        collect_fees: bool = True,
    ) -> PositionCloseResult:
        """
        Close a position and collect fees.

        Args:
            position_address: Position to close
            collect_fees: Whether to collect pending fees

        Returns:
            PositionCloseResult with transaction details
        """
        if not self._orca_client:
            return PositionCloseResult(success=False, error="Not initialized")

        try:
            receipt = await self._orca_client.execute_close_position(
                position_pubkey=position_address,
                collect_fees=collect_fees,
            )

            if receipt.is_success:
                logger.info(f"Position closed: {position_address}")
                logger.info(f"  Signature: {receipt.signature}")

                return PositionCloseResult(
                    success=True,
                    signature=receipt.signature,
                )
            else:
                # CRITICAL FIX: Verify position actually exists before treating as failure
                # If transaction timed out, the position might have been closed successfully
                if receipt.status.value == "timeout" and receipt.signature:
                    logger.warning(
                        "close_position_timeout_verifying_state",
                        position=position_address,
                        signature=receipt.signature,
                    )

                    # Check if position still exists on-chain
                    try:
                        await asyncio.sleep(2)  # Give chain time to update
                        position_state = await self._orca_client.get_position_state(position_address)

                        if position_state is None:
                            # Position doesn't exist = close succeeded!
                            logger.info(
                                "close_position_timeout_but_succeeded",
                                position=position_address,
                                signature=receipt.signature,
                                message="Position no longer exists on-chain, treating as successful close",
                            )
                            return PositionCloseResult(
                                success=True,
                                signature=receipt.signature,
                            )
                        else:
                            logger.error(
                                "close_position_timeout_and_failed",
                                position=position_address,
                                signature=receipt.signature,
                                message="Position still exists on-chain, close actually failed",
                            )
                    except Exception as verify_error:
                        logger.error(
                            "close_position_verification_error",
                            position=position_address,
                            error=str(verify_error),
                        )

                return PositionCloseResult(
                    success=False,
                    signature=receipt.signature if hasattr(receipt, 'signature') else "",
                    error=receipt.error or "Unknown error"
                )

        except Exception as e:
            logger.exception(f"Failed to close position: {e}")
            return PositionCloseResult(success=False, error=str(e))


# ============================================================
# TRADE EXECUTOR (Main Entry Point)
# ============================================================

class TradeExecutor:
    """
    Main trade executor that coordinates swaps and position management.

    Handles the complete flow:
    1. Check balances
    2. Swap if needed to rebalance tokens
    3. Open position
    4. Monitor and close when needed
    """

    def __init__(self, config: Config = None):
        self.config = config or get_config()

        # Clients
        self._solana_client: Optional[SolanaExecutionClient] = None
        self._jupiter: Optional[JupiterClient] = None
        self._position_executor: Optional[PositionExecutor] = None

        # Settings
        self.swap_enabled = self.config.swap.enabled
        self.swap_imbalance_threshold = self.config.swap.imbalance_threshold
        # Note: swap_slippage_bps removed - all swaps now use progressive slippage
        # passed explicitly from open_position_with_rebalance() retry logic

    async def initialize(self) -> bool:
        """Initialize all clients."""
        try:
            # Initialize Solana client
            self._solana_client = SolanaExecutionClient(
                rpc_url=self.config.api.rpc_url,
                wallet_key_base58=self.config.api.wallet_private_key,
            )

            # Initialize Jupiter client with Ultra API support if configured
            jupiter_key = self.config.api.__dict__.get('jupiter_api_key', '')
            self._jupiter = JupiterClient(
                api_key=jupiter_key,
                rpc_url=self.config.api.rpc_url,
                config=self.config,  # Pass config for Ultra API settings
            )

            # Test Jupiter connection
            ok, msg = await self._jupiter.test_connection()
            if ok:
                logger.info(f"Jupiter connected: {msg}")
            else:
                logger.warning(f"Jupiter connection issue: {msg}")

            # Initialize position executor
            self._position_executor = PositionExecutor(self.config)
            if not await self._position_executor.initialize():
                logger.warning("Position executor initialization failed - using limited mode")

            # Get initial balances
            sol, usdc = await self._solana_client.get_balances()
            logger.info(f"Wallet balances: {sol:.4f} SOL, ${usdc:.2f} USDC")

            return True

        except Exception as e:
            logger.exception(f"Failed to initialize TradeExecutor: {e}")
            return False

    @property
    def wallet(self) -> Optional[Keypair]:
        return self._solana_client.wallet if self._solana_client else None

    async def get_balances(self) -> Tuple[float, float]:
        """Get current SOL and USDC balances."""
        if not self._solana_client:
            return 0.0, 0.0
        return await self._solana_client.get_balances()

    async def _snapshot_wallet_value(self, price: float) -> Tuple[float, float, float]:
        """
        Get wallet value snapshot: (sol, usdc, total_usd).

        Includes wSOL balance for accurate tracking.

        Args:
            price: Current SOL price for USD conversion

        Returns:
            Tuple of (sol_balance, usdc_balance, total_value_usd)
        """
        sol, usdc = await self.get_balances()  # Already includes wSOL
        total_usd = (sol * price) + usdc
        return sol, usdc, total_usd

    async def _calculate_actual_cost(
        self,
        sol_before: float,
        usdc_before: float,
        value_before: float,
        price: float,
        operation_type: str,
        position_value: float = 0.0,
        rpc_fee_sol: float = 0.0,
        wait_for_settlement: bool = True,
        fees_collected_usd: float = 0.0,  # NEW: Fees collected when closing (to properly calculate cost)
    ) -> ActualCost:
        """
        Calculate actual cost after operation completes.

        Compares wallet balance before and after to capture true costs including:
        - TX fees, slippage, rent, and rounding losses.

        Args:
            sol_before: SOL balance before operation
            usdc_before: USDC balance before operation
            value_before: Total USD value before operation
            price: Current SOL price
            operation_type: 'swap', 'position_open', or 'position_close'
            position_value: Value of position created/closed (for position ops)
            rpc_fee_sol: RPC-reported fee for comparison
            wait_for_settlement: Wait 2s for wSOL cleanup to settle

        Returns:
            ActualCost with calculated values
        """
        # Wait for wSOL cleanup and balance settlement
        if wait_for_settlement:
            await asyncio.sleep(2)

        sol_after, usdc_after, value_after = await self._snapshot_wallet_value(price)

        # Calculate cost based on operation type
        if operation_type == 'swap':
            # Swap: cost = value_before - value_after
            # CRITICAL: Use the SAME price for both snapshots to avoid price movement artifacts
            # If price changes between snapshots, we'd incorrectly attribute price gains/losses to swap cost
            # We already have value_before and value_after calculated with the same price parameter,
            # so this should be correct. However, if price changed between the two snapshot calls,
            # we need to recalculate using consistent pricing.
            #
            # Recalculate both values using the current price parameter to ensure consistency
            value_before_recalc = (sol_before * price) + usdc_before
            value_after_recalc = (sol_after * price) + usdc_after
            actual_cost_usd = value_before_recalc - value_after_recalc
            
            # Sanity check: Swaps should always cost something (fees + slippage)
            # If cost is negative, it means we gained value, which could indicate:
            # 1. Price moved significantly between snapshots (should use fixed price)
            # 2. wSOL cleanup happened between snapshots (should be handled separately)
            # 3. Calculation error
            if actual_cost_usd < 0:
                logger.warning(
                    f"swap: Negative cost detected (${actual_cost_usd:.4f}) - this may indicate "
                    f"price movement between snapshots or calculation error. "
                    f"value_before=${value_before:.4f}, value_after=${value_after:.4f}, "
                    f"value_before_recalc=${value_before_recalc:.4f}, value_after_recalc=${value_after_recalc:.4f}, "
                    f"price=${price:.4f}"
                )
                # For negative costs, use a minimum estimate based on tx_fee
                # This prevents negative swap costs from skewing total costs
                if rpc_fee_sol > 0:
                    actual_cost_usd = rpc_fee_sol * price
                    logger.info(f"  Using RPC fee as minimum swap cost: ${actual_cost_usd:.4f}")
                else:
                    # Estimate minimum swap cost (tx_fee + small slippage estimate)
                    ESTIMATED_MIN_SWAP_COST_USD = 0.01  # ~$0.01 minimum
                    actual_cost_usd = ESTIMATED_MIN_SWAP_COST_USD
                    logger.info(f"  Using estimated minimum swap cost: ${actual_cost_usd:.4f}")
        elif operation_type == 'position_open':
            # Open: Track total non-position cost (rent + tx_fee) - rent will be refunded on close
            #
            # IMPORTANT: Rent is a deposit that gets refunded when closing, so the NET cost
            # over a full cycle (open + close) is just the tx_fees. However, we cannot separate
            # rent from tx_fee using balance diff alone at open time.
            #
            # Balance analysis when opening:
            # - Before: wallet = value_before
            # - After: wallet = value_after = value_before - position_value - rent_paid - tx_fee
            # - Position created with: tokens worth position_value
            #
            # Total spent = value_before - value_after = position_value + rent_paid + tx_fee
            # We know position_value (tokens deposited), so:
            # rent_paid + tx_fee = (value_before - value_after) - position_value
            #
            # SOLUTION: Record the MEASURED total (rent_paid + tx_fee) as the cost.
            # When the position closes, we'll get rent_refund back, and the net cost
            # will be calculated correctly across the full cycle.
            #
            # Note: position_value is correctly calculated as just the tokens deposited
            # (deposited_sol * price + deposited_usdc), which does NOT include rent.
            total_non_position_cost = value_before - value_after - position_value
            
            if total_non_position_cost < 0:
                logger.error(
                    f"position_open: Negative non-position cost (${total_non_position_cost:.4f}) - "
                    f"this indicates an error in calculation. value_before=${value_before:.4f}, "
                    f"value_after=${value_after:.4f}, position_value=${position_value:.4f}"
                )
                actual_cost_usd = 0.0  # Error case, don't record negative cost
            else:
                # Record the MEASURED total cost (rent + tx_fee)
                # This will be offset by rent refund on close
                actual_cost_usd = total_non_position_cost
            
            logger.info(
                f"position_open: MEASURED cost=${actual_cost_usd:.4f} "
                f"(includes rent_paid + tx_fee, position_value=${position_value:.4f})"
            )
        elif operation_type == 'position_close':
            # Close: cost = transaction fee - rent refund (negative, so rent cancels in net calculation)
            # 
            # IMPORTANT: Rent is a deposit that gets refunded when closing. To properly cancel
            # rent in the net calculation (open + close), we need to record:
            # - Open: rent_paid + tx_fee_open (positive)
            # - Close: tx_fee_close - rent_refund (negative, since rent_refund > tx_fee)
            # - Net: (rent_paid + tx_fee_open) + (tx_fee_close - rent_refund) ≈ tx_fee_open + tx_fee_close
            #
            # Balance analysis when closing:
            # - Before: wallet = value_before
            # - Position contains: tokens worth position_value
            # - After: wallet = value_after = value_before + position_value + fees_collected + rent_refund - tx_fee
            #
            # Balance diff = value_after - value_before = position_value + fees_collected + rent_refund - tx_fee
            #
            # To calculate close cost (tx_fee - rent_refund):
            # rent_refund - tx_fee = balance_diff - position_value - fees_collected
            # close_cost = tx_fee - rent_refund = -(balance_diff - position_value - fees_collected)
            # close_cost = position_value + fees_collected - balance_diff
            balance_diff = value_after - value_before
            
            # Calculate expected received (position tokens + fees)
            expected_received = position_value + fees_collected_usd if fees_collected_usd > 0 else position_value
            
            # Calculate rent_refund - tx_fee from balance diff
            # balance_diff = position_value + fees_collected + rent_refund - tx_fee
            # So: rent_refund - tx_fee = balance_diff - position_value - fees_collected
            rent_refund_minus_tx_fee = balance_diff - expected_received
            
            # CRITICAL: If fees_collected_usd is 0 but balance_diff suggests fees were collected,
            # we may be making the cost too negative. Check for this:
            # If balance_diff > position_value by a significant amount (> $0.10), it likely includes fees
            # that weren't accounted for. In this case, we should warn but still calculate correctly.
            if fees_collected_usd == 0 and balance_diff > position_value + 0.10:
                logger.warning(
                    f"position_close: WARNING - balance_diff (${balance_diff:.4f}) significantly exceeds "
                    f"position_value (${position_value:.4f}), suggesting fees were collected but not provided. "
                    f"This may cause the cost calculation to be more negative than it should be. "
                    f"Consider providing fees_collected_usd for accurate cost tracking."
                )
            
            # Close cost = tx_fee - rent_refund (negative, since rent_refund > tx_fee)
            # This is the negative of (rent_refund - tx_fee)
            actual_cost_usd = -rent_refund_minus_tx_fee
            
            # Verify the calculation makes sense:
            # - If rent_refund >> tx_fee, then rent_refund_minus_tx_fee is large positive
            # - So actual_cost_usd = -large_positive = large negative (correct!)
            # - This will cancel with the open cost (rent_paid + tx_fee_open)
            
            logger.info(
                f"position_close: MEASURED cost=${actual_cost_usd:.4f} (tx_fee - rent_refund, "
                f"rent_refund_minus_tx_fee=${rent_refund_minus_tx_fee:.4f}, "
                f"balance_diff=${balance_diff:.4f}, position_value=${position_value:.4f}, "
                f"fees_collected=${fees_collected_usd:.4f})"
            )
            
            # Sanity check: If actual_cost_usd is positive, it means tx_fee > rent_refund (unlikely)
            # In this case, we should use the RPC fee if available, or a small estimate
            if actual_cost_usd > 0:
                if rpc_fee_sol > 0:
                    # Use RPC fee as the actual cost (most accurate)
                    actual_cost_usd = rpc_fee_sol * price
                    logger.warning(
                        f"position_close: Calculated cost was positive (unexpected), using RPC fee: ${actual_cost_usd:.4f}"
                    )
                else:
                    # Estimate tx_fee as a small positive value
                    ESTIMATED_TX_FEE_SOL = 0.000005
                    estimated_tx_fee_usd = ESTIMATED_TX_FEE_SOL * price
                    actual_cost_usd = estimated_tx_fee_usd
                    logger.warning(
                        f"position_close: Calculated cost was positive (unexpected), using estimated tx_fee: ${actual_cost_usd:.4f}"
                    )
        else:
            actual_cost_usd = value_before - value_after

        actual_cost_sol = actual_cost_usd / price if price > 0 else 0.0

        cost = ActualCost(
            sol_before=sol_before,
            usdc_before=usdc_before,
            value_before_usd=value_before,
            sol_after=sol_after,
            usdc_after=usdc_after,
            value_after_usd=value_after,
            position_value_usd=position_value,
            actual_cost_usd=actual_cost_usd,
            actual_cost_sol=actual_cost_sol,
            rpc_fee_sol=rpc_fee_sol,
            rpc_fee_usd=rpc_fee_sol * price,
            price_at_calc=price,
            operation_type=operation_type,
        )

        # Log the calculation
        logger.info("=" * 60)
        logger.info(f"ACTUAL COST ({operation_type.upper()}): ${actual_cost_usd:.4f}")
        logger.info(f"  Before: {sol_before:.6f} SOL + ${usdc_before:.2f} = ${value_before:.2f}")
        logger.info(f"  After:  {sol_after:.6f} SOL + ${usdc_after:.2f} = ${value_after:.2f}")
        if position_value > 0:
            logger.info(f"  Position value: ${position_value:.2f}")
        if rpc_fee_sol > 0:
            rpc_fee_usd = rpc_fee_sol * price
            underreport = actual_cost_usd / rpc_fee_usd if rpc_fee_usd > 0 else 0
            logger.info(f"  RPC fee: {rpc_fee_sol:.9f} SOL (${rpc_fee_usd:.6f}) - underreport: {underreport:.0f}x")
        logger.info("=" * 60)

        return cost

    async def get_transaction_fee(self, signature: str) -> float:
        """
        Extract transaction fee from Solana RPC.

        This method calls getTransaction on the RPC to fetch the transaction metadata
        and extracts the fee field, which is provided in lamports.

        Args:
            signature: Transaction signature to fetch

        Returns:
            Transaction fee in SOL (0.0 if fetch fails)
        """
        if not signature:
            return 0.0

        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                payload = {
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "getTransaction",
                    "params": [
                        signature,
                        {
                            "encoding": "jsonParsed",
                            "maxSupportedTransactionVersion": 0
                        }
                    ]
                }

                response = await client.post(self.config.api.rpc_url, json=payload)
                response.raise_for_status()
                tx_data = response.json()

                result = tx_data.get("result")
                if not result:
                    logger.warning(f"No result in transaction data for {signature}")
                    return 0.0

                meta = result.get("meta", {})
                fee_lamports = meta.get("fee", 0)
                fee_sol = fee_lamports / 1e9

                logger.debug(f"Transaction fee for {signature[:16]}...: {fee_lamports:,} lamports = {fee_sol:.9f} SOL")
                return fee_sol

        except Exception as e:
            logger.warning(f"Could not fetch transaction fee for {signature[:16]}...: {e}")
            return 0.0

    async def get_pool_price(self) -> float:
        """Get current pool price."""
        if not self._position_executor:
            raise RuntimeError("Not initialized")
        pool_state = await self._position_executor.get_pool_state()
        return pool_state.current_price

    async def get_pool_tick_spacing(self) -> int:
        """
        Get the pool's tick spacing from on-chain state.

        IMPORTANT: Always use this value for tick calculations.
        Different fee tiers have different tick spacings:
        - 0.01% fee tier: tick_spacing = 1
        - 0.05% fee tier: tick_spacing = 8
        - 0.30% fee tier: tick_spacing = 64 (most common for SOL/USDC)
        - 1.00% fee tier: tick_spacing = 128

        Returns:
            int: The pool's tick spacing
        """
        if not self._position_executor:
            raise RuntimeError("Not initialized")
        pool_state = await self._position_executor.get_pool_state()
        tick_spacing = pool_state.tick_spacing
        logger.debug(f"Pool tick_spacing: {tick_spacing}")
        return tick_spacing

    async def get_pool_state(self, force_refresh: bool = False):
        """
        Get the full pool state from on-chain.

        Args:
            force_refresh: If True, bypass cache and fetch fresh data from chain

        Returns:
            Pool state object with tick_spacing, current_price, sqrt_price, etc.
        """
        if not self._position_executor:
            raise RuntimeError("Not initialized")
        return await self._position_executor.get_pool_state(force_refresh=force_refresh)

    async def validate_balances(self) -> Tuple[bool, str]:
        """
        Validate that we have sufficient balances to operate.

        Checks:
        - SOL balance > reserve (for tx fees)
        - Total value > minimum threshold

        Returns: (is_valid, message)
        """
        sol_balance, usdc_balance = await self.get_balances()
        sol_reserve = self.config.capital.min_sol_reserve

        if sol_balance < sol_reserve:
            return False, f"Insufficient SOL: {sol_balance:.4f} < {sol_reserve:.4f} reserve"

        # Check minimum operating balance
        try:
            price = await self.get_pool_price()
            total_value = (sol_balance * price) + usdc_balance
            min_value = 5.0  # Minimum $5 to operate

            if total_value < min_value:
                return False, f"Total value ${total_value:.2f} below minimum ${min_value:.2f}"

        except Exception as e:
            return False, f"Could not get pool price: {e}"

        return True, f"OK: {sol_balance:.4f} SOL, ${usdc_balance:.2f} USDC"

    async def check_and_swap_for_balance(
        self,
        current_price: float,
        sol_balance: float,
        usdc_balance: float,
        slippage_bps: int,
    ) -> Tuple[float, float, Optional[SwapResult]]:
        """
        Check if swap is needed and execute if so.

        This ensures we have roughly 50/50 token split before opening positions.

        IMPORTANT: The SOL reserve is excluded from the balance calculation
        to ensure we always keep enough SOL for transaction fees.

        PROGRESSIVE SLIPPAGE:
        When called from open_position_with_rebalance during retries, slippage_bps
        is passed with progressive values to handle high volatility.

        Args:
            current_price: Current SOL/USDC price
            sol_balance: Current SOL balance
            usdc_balance: Current USDC balance
            slippage_bps: Slippage tolerance in basis points (required)

        Returns: (new_sol_balance, new_usdc_balance, SwapResult or None)
        """
        # Use provided slippage (now required parameter)
        effective_swap_slippage = slippage_bps
        if not self.swap_enabled:
            return sol_balance, usdc_balance, None

        # Get reserve amount
        sol_reserve = self.config.capital.min_sol_reserve

        # Calculate current ratio - EXCLUDE reserve from available SOL
        available_sol = max(0, sol_balance - sol_reserve)
        sol_value = available_sol * current_price
        usdc_value = usdc_balance
        total_value = sol_value + usdc_value

        if total_value <= 0:
            return sol_balance, usdc_balance, None

        sol_pct = sol_value / total_value
        usdc_pct = usdc_value / total_value

        logger.info(f"=" * 80)
        logger.info(f"TOKEN BALANCE CHECK (for swap decision)")
        logger.info(f"=" * 80)
        logger.info(f"Total capital (excluding {sol_reserve:.4f} SOL reserve): ${total_value:.2f}")

        # ENHANCED: Show breakdown of SOL composition (native vs wSOL)
        native_sol_balance = await self._solana_client.get_balance_sol()  # Native only
        wsol_balance_amount = sol_balance - native_sol_balance  # Calculate wSOL portion
        logger.info(f"  Available SOL: {available_sol:.4f} (${sol_value:.2f}) = {sol_pct*100:.1f}%")
        if wsol_balance_amount > 0.001:
            logger.warning(f"    ⚠️  WARNING: {wsol_balance_amount:.4f} SOL is wSOL (wrapped)")
            logger.warning(f"    Native SOL: {native_sol_balance:.4f}")
            logger.warning(f"    If swap needed, Jupiter can only use NATIVE SOL!")
        logger.info(f"  USDC: ${usdc_balance:.2f} = {usdc_pct*100:.1f}%")
        logger.info(f"  Reserved SOL: {sol_reserve:.4f} (not included in ratio)")

        target_pct = 0.50
        threshold = self.swap_imbalance_threshold
        deviation_from_target = abs(sol_pct - target_pct)
        severe_imbalance = deviation_from_target >= 0.20  # 70/30 split or worse

        logger.info(f"Swap trigger threshold: {threshold*100:.0f}% deviation from 50/50")

        swap_direction = None
        swap_amount = 0

        if sol_pct > target_pct + threshold:
            # Too much SOL, sell some for USDC
            swap_direction = "sell_sol"
            excess_sol_value = sol_value - (total_value * target_pct)
            swap_amount = excess_sol_value / current_price
            # CRITICAL FIX: Account for transaction fees more conservatively
            # Jupiter swap needs SOL for:
            # 1. The swap amount itself
            # 2. Transaction fees (~0.000005 SOL)
            # 3. Account rent if creating new accounts
            # Reserve is already excluded from available_sol, but we need additional buffer
            # for the swap transaction itself
            TX_FEE_BUFFER_SOL = 0.001  # ~0.001 SOL for swap transaction fees
            max_swapable_sol = max(0, available_sol - TX_FEE_BUFFER_SOL)
            swap_amount = min(swap_amount * 0.95, max_swapable_sol)  # 95% of excess, but cap at available

        elif usdc_pct > target_pct + threshold:
            # Too much USDC, buy SOL
            swap_direction = "buy_sol"
            excess_usdc = usdc_value - (total_value * target_pct)
            swap_amount = excess_usdc * 0.95  # Buffer for fees
            # No USDC buffer needed - unlike SOL, USDC has no rent/gas requirements
            # The swap and CLMM already handle slippage; keeping USDC reserve is unnecessary
            swap_amount = min(swap_amount, usdc_balance)

        if swap_direction is None:
            logger.info(f"✅ Status: BALANCED - No swap needed")
            logger.info(f"  Deviation from 50/50: {abs(sol_pct - 0.5)*100:.1f}% (within {threshold*100:.0f}% threshold)")
            logger.info(f"=" * 80)
            return sol_balance, usdc_balance, None

        logger.warning(f"⚠️  Status: IMBALANCED - Swap required")
        logger.info(f"  Direction: {swap_direction}")
        logger.info(f"  Deviation: {abs(sol_pct - 0.5)*100:.1f}% (exceeds {threshold*100:.0f}% threshold)")
        
        # Check minimum swap threshold to avoid tiny, cost-inefficient swaps
        min_swap_usd = self.config.swap.min_swap_usd
        if swap_direction == "sell_sol":
            swap_value_usd = swap_amount * current_price
        else:  # buy_sol
            swap_value_usd = swap_amount
        
        if swap_value_usd < min_swap_usd:
            logger.info(f"  ⚠️  Swap amount (${swap_value_usd:.2f}) below minimum threshold (${min_swap_usd:.2f})")
            logger.info(f"  Skipping swap to avoid cost-inefficient transaction")
            logger.info(f"  Position will open with slightly imbalanced ratio (acceptable for small amounts)")
            logger.info(f"=" * 80)
            # Return a SwapResult indicating it was skipped
            skipped_result = SwapResult(
                success=False,
                skipped=True,
                error=f"Swap skipped: amount ${swap_value_usd:.2f} < minimum ${min_swap_usd:.2f}"
            )
            return sol_balance, usdc_balance, skipped_result
        
        logger.info(f"  Using slippage: {effective_swap_slippage} bps ({effective_swap_slippage/100:.1f}%)")
        logger.info(f"=" * 80)

        # Snapshot wallet BEFORE swap for actual cost calculation
        snap_sol_before, snap_usdc_before, snap_value_before = await self._snapshot_wallet_value(current_price)

        # Execute swap with effective slippage (may be progressive on retries)
        if swap_direction == "sell_sol":
            logger.info(f"  Swapping: {swap_amount:.4f} SOL -> USDC")
            amount_lamports = int(swap_amount * 1e9)
            result = await self._jupiter.execute_swap(
                input_mint=SOL_MINT,
                output_mint=USDC_MINT,
                amount=amount_lamports,
                slippage_bps=effective_swap_slippage,
                wallet_keypair=self.wallet,
            )
            # Set direction and token metadata on the result
            result.direction = "sell_sol"
            result.input_token = "SOL"
            result.output_token = "USDC"
        else:  # buy_sol
            logger.info(f"  Swapping: ${swap_amount:.2f} USDC -> SOL")
            amount_micro = int(swap_amount * 1e6)
            result = await self._jupiter.execute_swap(
                input_mint=USDC_MINT,
                output_mint=SOL_MINT,
                amount=amount_micro,
                slippage_bps=effective_swap_slippage,
                wallet_keypair=self.wallet,
            )
            # Set direction and token metadata on the result
            result.direction = "buy_sol"
            result.input_token = "USDC"
            result.output_token = "SOL"

        if result.success:
            logger.info(f"  Swap SUCCESS: {result.signature}")

            # ================================================================================
            # CRITICAL FIX (Option 4): Wait for swap confirmation and balance update
            # ================================================================================
            # Swap transaction may take 2-5 seconds to finalize on Solana.
            # If we fetch balances too quickly, we get pre-swap balances, causing
            # the system to proceed with imbalanced tokens and trigger capital deployment bug.
            #
            # Solution: Wait and poll for balance changes to confirm swap is reflected.
            # FIX: Also wait before fetching tx fee so RPC has time to index the transaction
            # ================================================================================
            logger.info(f"  Waiting for swap transaction to finalize and reflect in balances...")
            await asyncio.sleep(3)  # Initial wait for finalization

            # Fetch transaction fee from RPC (AFTER wait so transaction is indexed)
            result.tx_fee_sol = await self.get_transaction_fee(result.signature)
            logger.info(f"  Swap transaction fee: {result.tx_fee_sol:.9f} SOL")

            # Parse exact swap amounts from TX (replaces Jupiter quote amounts)
            try:
                wallet_addr = str(self._solana_client.wallet_pubkey)
                parsed_in_sol, parsed_in_usdc, parsed_out_sol, parsed_out_usdc = (
                    await parse_swap_amounts(
                        rpc_url=self.config.api.rpc_url,
                        signature=result.signature,
                        wallet_address=wallet_addr,
                    )
                )
                # Update result with TX-parsed amounts (more accurate than Jupiter quote)
                old_input = result.input_amount
                old_output = result.output_amount
                if result.direction == "sell_sol":
                    result.input_amount = parsed_in_sol
                    result.output_amount = parsed_out_usdc
                else:  # buy_sol
                    result.input_amount = parsed_in_usdc
                    result.output_amount = parsed_out_sol

                # Log comparison for verification
                if abs(old_input - result.input_amount) > 0.001 or abs(old_output - result.output_amount) > 0.01:
                    logger.info(
                        f"  Swap amounts updated from TX parse: "
                        f"input {old_input:.6f} -> {result.input_amount:.6f}, "
                        f"output {old_output:.6f} -> {result.output_amount:.6f}"
                    )
            except Exception as e:
                logger.warning(f"  Failed to parse swap TX amounts (keeping Jupiter quote): {e}")

            # Poll up to 5 times to confirm balances updated
            swap_confirmed = False
            for attempt in range(5):
                new_sol, new_usdc = await self.get_balances()

                # Check if balances changed significantly (swap is reflected)
                sol_diff = abs(new_sol - sol_balance)
                usdc_diff = abs(new_usdc - usdc_balance)

                if sol_diff > 0.01 or usdc_diff > 1.0:  # Meaningful change detected
                    logger.info(f"  ✅ Swap confirmed - balances updated:")
                    logger.info(f"     SOL: {sol_balance:.4f} → {new_sol:.4f} (Δ {sol_diff:.4f})")
                    logger.info(f"     USDC: ${usdc_balance:.2f} → ${new_usdc:.2f} (Δ ${usdc_diff:.2f})")
                    swap_confirmed = True
                    break
                else:
                    logger.warning(f"  ⚠️  Swap not yet reflected in balances (attempt {attempt + 1}/5)")
                    if attempt < 4:  # Don't sleep on last attempt
                        await asyncio.sleep(2)

            if not swap_confirmed:
                logger.error(f"  ❌ CRITICAL: Swap transaction succeeded but balances didn't update after 13 seconds!")
                logger.error(f"     This may indicate RPC issues or transaction confirmation delays")
                logger.error(f"     Proceeding with last fetched balances, but capital deployment may be affected")

            # ================================================================================
            # CRITICAL FIX: Cleanup wSOL after USDC->SOL swap
            # ================================================================================
            # When swapping USDC->SOL, Jupiter outputs to wSOL token account, not native SOL.
            # This wSOL must be unwrapped to native SOL before position opening, otherwise:
            # 1. Position opening will have insufficient native SOL to wrap
            # 2. Capital won't be fully deployed (wSOL sits idle in wallet)
            #
            # BUG FIX: This was causing ~$430 of wSOL to remain undeployed in production
            # ================================================================================
            if swap_direction == "buy_sol":
                # Retry logic for wSOL cleanup - prevents leaving ~$200-400 of wSOL idle
                from app.chain.wsol_cleanup import cleanup_wsol
                max_cleanup_retries = 3
                cleanup_success = False

                for cleanup_attempt in range(max_cleanup_retries):
                    try:
                        logger.info(f"  Running post-swap wSOL cleanup (attempt {cleanup_attempt + 1}/{max_cleanup_retries})...")
                        wsol_cleanup = await cleanup_wsol()
                        if wsol_cleanup.success and wsol_cleanup.accounts_cleaned > 0:
                            logger.info(f"  ✅ Post-swap wSOL cleanup: recovered {wsol_cleanup.total_sol_recovered:.4f} SOL from {wsol_cleanup.accounts_cleaned} accounts")
                            await asyncio.sleep(2)  # Wait for cleanup to finalize
                            # Refetch balances after cleanup to get accurate native SOL balance
                            new_sol, new_usdc = await self.get_balances()
                            logger.info(f"  Updated balances after cleanup: SOL={new_sol:.4f}, USDC=${new_usdc:.2f}")
                            cleanup_success = True
                            break
                        elif wsol_cleanup.success:
                            logger.info(f"  No wSOL to cleanup (good - swap may have auto-unwrapped)")
                            cleanup_success = True
                            break
                        else:
                            logger.warning(f"  Post-swap wSOL cleanup failed (attempt {cleanup_attempt + 1}): {wsol_cleanup.error}")
                            if cleanup_attempt < max_cleanup_retries - 1:
                                await asyncio.sleep(1.5 * (cleanup_attempt + 1))  # Backoff before retry
                    except Exception as e:
                        logger.warning(f"  Post-swap wSOL cleanup exception (attempt {cleanup_attempt + 1}): {e}")
                        if cleanup_attempt < max_cleanup_retries - 1:
                            await asyncio.sleep(1.5 * (cleanup_attempt + 1))  # Backoff before retry

                if not cleanup_success:
                    logger.error(f"  ❌ wSOL cleanup failed after {max_cleanup_retries} attempts - wSOL may remain idle in wallet")

            # Calculate ACTUAL swap cost from balance difference
            result.actual_cost = await self._calculate_actual_cost(
                sol_before=snap_sol_before,
                usdc_before=snap_usdc_before,
                value_before=snap_value_before,
                price=current_price,
                operation_type='swap',
                rpc_fee_sol=result.tx_fee_sol,
                wait_for_settlement=False,  # Already waited during swap confirmation
            )

            # Return the full SwapResult for accounting
            return new_sol, new_usdc, result
        else:
            logger.error(f"  Swap FAILED: {result.error}")
            # FIX #1: Return failed SwapResult instead of None so downstream code
            # can distinguish "swap attempted but failed" from "no swap needed"
            return sol_balance, usdc_balance, result

    async def open_position_with_rebalance(
        self,
        lower_tick: int,
        upper_tick: int,
        max_sol: float,
        max_usdc: float,
        liquidity: int,
        retry_attempt: int = 0,
    ) -> Tuple[PositionOpenResult, Optional[SwapResult]]:
        """
        Open a position, rebalancing tokens first if needed.

        IMPORTANT: This method enforces SOL reserve to ensure enough SOL
        remains for transaction fees and rent deposits.

        PROGRESSIVE SLIPPAGE TOLERANCE:
        To handle high volatility scenarios, slippage tolerance increases
        with each retry attempt:
        - Attempt 0 (first try): base slippage (50 bps = 0.5%)
        - Attempt 1: +50 bps = 100 bps (1.0%)
        - Attempt 2: +100 bps = 200 bps (2.0%)
        - Attempt 3+: +150 bps = 350 bps (3.5% max - emergency mode)

        This progressive approach ensures:
        1. Normal operations use tight slippage (minimize value loss)
        2. Failed attempts get more tolerance (prioritize success)
        3. Maximum slippage is bounded (prevent excessive loss)

        FRESH PRICE ON EVERY CALL:
        Each call fetches current pool state, ensuring:
        1. Token ratios are calculated with current price
        2. Swaps (if needed) use current market conditions
        3. Liquidity calculations use accurate sqrt_price

        Args:
            lower_tick: Lower tick for position
            upper_tick: Upper tick for position
            max_sol: Maximum SOL to use (will be clamped by reserve)
            max_usdc: Maximum USDC to use
            liquidity: Target liquidity (will be recalculated with CLMM math)
            retry_attempt: Current retry attempt number (0-based, for progressive slippage)

        Returns:
            Tuple of (PositionOpenResult, SwapResult or None)
        """
        # Get current balances and pool state (including sqrt_price for accurate liquidity calc)
        # CRITICAL: Fresh fetch on every call ensures current market conditions are used
        # MUST use force_refresh=True to prevent TokenMaxExceeded errors from stale sqrt_price
        sol_balance, usdc_balance = await self.get_balances()
        pool_state = await self.get_pool_state(force_refresh=True)
        current_price = pool_state.current_price  # Float for logging
        sqrt_price_current = pool_state.sqrt_price  # Exact Q64.64 for liquidity calc
        tick_spacing = pool_state.tick_spacing

        # NOTE: Open cost snapshot is taken right before position open (after swap)
        # to avoid double-counting swap costs. See line near open_position call.

        # ================================================================================
        # CRITICAL FIX: Calculate SAFE tick range directly from pool sqrt_price
        # ================================================================================
        # PROBLEM: The input lower_tick/upper_tick were calculated from Birdeye price,
        # but the Whirlpool contract uses pool sqrt_price. If these differ by even 0.1%,
        # the price can end up OUTSIDE the range, causing TokenMaxExceeded errors.
        #
        # SOLUTION: Derive the tick range directly from the on-chain sqrt_price with
        # padding to guarantee the price is IN RANGE at execution time.
        #
        # This fixes the root cause of repeated TokenMaxExceeded (6017) errors where:
        # - Target range: $132.72 - $137.74
        # - Actual price: $137.80 (ABOVE the upper bound!)
        # ================================================================================
        original_lower_price = tick_to_price(lower_tick)
        original_upper_price = tick_to_price(upper_tick)

        # Calculate the desired range width from the input ticks
        # range_width = (upper - lower) / sqrt(upper * lower)
        # For geometric symmetry, this is approximately (multiplier^2 - 1)
        original_range_width = (original_upper_price - original_lower_price) / math.sqrt(original_lower_price * original_upper_price)

        # Use the new SAFE tick range calculation that derives directly from sqrt_price
        # This GUARANTEES the current price is IN the range using the CENTERED approach
        new_lower_tick, new_upper_tick = calculate_safe_tick_range_from_sqrt_price(
            sqrt_price_current=sqrt_price_current,
            tick_spacing=tick_spacing,
            range_width_pct=original_range_width,
        )

        # Log the range recalculation
        recentered_lower_price = tick_to_price(new_lower_tick)
        recentered_upper_price = tick_to_price(new_upper_tick)

        logger.info(f"SAFE TICK RANGE CALCULATION (prevents TokenMaxExceeded):")
        logger.info(f"  Input ticks: [{lower_tick}, {upper_tick}] = ${original_lower_price:.4f} - ${original_upper_price:.4f}")
        logger.info(f"  Pool price: ${current_price:.4f}")
        logger.info(f"  Pool sqrt_price: {sqrt_price_current}")
        logger.info(f"  Original range width: {original_range_width*100:.2f}%")
        logger.info(f"  New safe ticks: [{new_lower_tick}, {new_upper_tick}] = ${recentered_lower_price:.4f} - ${recentered_upper_price:.4f}")

        # Verify the current price is IN the new range
        sqrt_price_lower = tick_to_sqrt_price(new_lower_tick)
        sqrt_price_upper = tick_to_sqrt_price(new_upper_tick)
        price_position = "IN RANGE"
        if sqrt_price_current <= sqrt_price_lower:
            price_position = "BELOW RANGE"
            logger.warning(f"  WARNING: Price BELOW range - this should not happen!")
        elif sqrt_price_current >= sqrt_price_upper:
            price_position = "ABOVE RANGE"
            logger.warning(f"  WARNING: Price ABOVE range - this should not happen!")
        logger.info(f"  Price position: {price_position}")

        # Use the safe ticks
        lower_tick = new_lower_tick
        upper_tick = new_upper_tick

        # Get reserve from config
        sol_reserve = self.config.capital.min_sol_reserve

        # PROGRESSIVE SLIPPAGE CALCULATION
        # Base slippage + additional tolerance per retry attempt
        # This handles high volatility scenarios where initial slippage is too tight
        base_slippage_bps = self.config.rebalance.slippage_bps  # Default: 15 bps (0.15%)
        # Progressive schedule: Conservative increments (+15, +30, +45, +50 bps max)
        # Prevents losing large amounts to slippage during high volatility
        progressive_slippage_schedule = [0, 15, 30, 45, 50]  # Additional bps per attempt
        additional_bps = progressive_slippage_schedule[min(retry_attempt, len(progressive_slippage_schedule) - 1)]
        effective_slippage_bps = base_slippage_bps + additional_bps
        # Cap at 100 bps (1.0%) to prevent excessive slippage costs
        effective_slippage_bps = min(effective_slippage_bps, 100)

        # Separate swap slippage from position slippage (swap costs are more sensitive)
        swap_base_slippage_bps = self.config.swap.slippage_bps
        swap_slippage_bps = min(swap_base_slippage_bps + additional_bps, 100)

        logger.info("=" * 50)
        logger.info("OPENING POSITION WITH REBALANCE")
        logger.info("=" * 50)
        logger.info(f"Retry attempt: {retry_attempt} (position slippage: {effective_slippage_bps} bps, swap slippage: {swap_slippage_bps} bps)")
        logger.info(f"Current balances: {sol_balance:.4f} SOL, ${usdc_balance:.2f} USDC")
        logger.info(f"Current price: ${current_price:.2f} (sqrt_price: {sqrt_price_current})")
        logger.info(f"SOL reserve: {sol_reserve:.4f} SOL")

        # Check if we have enough SOL for reserve
        available_sol = sol_balance - sol_reserve
        if available_sol <= 0:
            logger.error(f"Insufficient SOL: {sol_balance:.4f} SOL, need at least {sol_reserve:.4f} reserve")
            return PositionOpenResult(
                success=False,
                error=f"Insufficient SOL balance. Have {sol_balance:.4f}, need {sol_reserve:.4f} reserve"
            ), None

        # Check and swap if needed - returns SwapResult object if swap occurred
        # Pass progressive swap slippage (separate from position slippage for cost control)
        pre_swap_sol = sol_balance
        pre_swap_usdc = usdc_balance
        sol_balance, usdc_balance, swap_result = await self.check_and_swap_for_balance(
            current_price, sol_balance, usdc_balance, swap_slippage_bps
        )

        # CRITICAL LOGGING: Track swap execution and balance changes
        if swap_result:
            if swap_result.success:
                logger.info(f"✅ SWAP EXECUTED SUCCESSFULLY: {swap_result.signature}")
                logger.info(f"  Pre-swap:  {pre_swap_sol:.4f} SOL + ${pre_swap_usdc:.2f} USDC = ${(pre_swap_sol * current_price + pre_swap_usdc):.2f}")
                logger.info(f"  Post-swap: {sol_balance:.4f} SOL + ${usdc_balance:.2f} USDC = ${(sol_balance * current_price + usdc_balance):.2f}")
                logger.info(f"  Direction: {swap_result.direction}")
            else:
                logger.error(f"❌ SWAP FAILED: {swap_result.error}")
                logger.error(f"  This may cause capital deployment issues if tokens are imbalanced!")
                logger.error(f"  Current balances: {sol_balance:.4f} SOL (${sol_balance * current_price:.2f}) + ${usdc_balance:.2f} USDC")
        else:
            logger.info(f"ℹ️  NO SWAP NEEDED - tokens already balanced")

        # ================================================================================
        # CRITICAL FIX (Option 2): Mandatory Swap with Retries for Severe Imbalance
        # ================================================================================
        # After initial swap attempt, check if tokens are still severely imbalanced.
        # If so, this indicates:
        # 1. Swap wasn't triggered (shouldn't happen, but defensive check)
        # 2. Swap failed (network, slippage, liquidity)
        # 3. Swap didn't execute fully
        #
        # Solution: Retry swap with progressively higher slippage to ensure balance.
        # This prevents capital deployment bug caused by "Limited by USDC" logic.
        # ================================================================================
        available_sol = sol_balance - sol_reserve
        sol_value = available_sol * current_price
        usdc_value = usdc_balance
        total_value = sol_value + usdc_value

        if total_value > 0:
            sol_pct_post_swap = sol_value / total_value
            severe_imbalance_threshold = 0.70  # 70% of one token (30% deviation from 50/50)

            if sol_pct_post_swap > severe_imbalance_threshold or sol_pct_post_swap < (1 - severe_imbalance_threshold):
                imbalance_pct = abs(sol_pct_post_swap - 0.5) * 100
                logger.error(f"=" * 80)
                logger.error(f"🚨 CRITICAL: SEVERE TOKEN IMBALANCE DETECTED 🚨")
                logger.error(f"=" * 80)
                logger.error(f"Post-swap token balance: {sol_pct_post_swap*100:.1f}% SOL / {(1-sol_pct_post_swap)*100:.1f}% USDC")
                logger.error(f"Deviation from 50/50: {imbalance_pct:.1f}%")
                logger.error(f"Threshold for concern: {(severe_imbalance_threshold-0.5)*100:.0f}% deviation")
                logger.error(f"")

                # Check if we already tried a swap
                if swap_result:
                    if swap_result.success:
                        logger.error(f"Swap executed but tokens still imbalanced - may need larger swap amount")
                    else:
                        logger.error(f"Swap failed with error: {swap_result.error}")
                        logger.error(f"Retrying swap with HIGHER SLIPPAGE after brief delay...")

                        # FIX #3: Add delay before retry to allow transient issues to resolve
                        # (RPC congestion, Jupiter API rate limits, network issues, etc.)
                        await asyncio.sleep(3)

                        # FIX #4: CRITICAL - Refetch current price before retry
                        # The initial current_price may be stale after delays and market movements.
                        # Using stale price causes swap amount calculations to be wrong, leading to
                        # Jupiter transaction simulation failures (error 0x1).
                        # This is the ROOT CAUSE of repeated swap failures during rebalancing.
                        logger.info("=" * 80)
                        logger.info("🔄 REFETCHING CURRENT PRICE FOR SWAP RETRY")
                        logger.info("=" * 80)
                        logger.info(f"Previous price (potentially stale): ${current_price:.4f}")

                        try:
                            # Force refresh to get CURRENT on-chain price
                            fresh_pool_state = await self.get_pool_state(force_refresh=True)
                            if fresh_pool_state:
                                previous_price = current_price
                                current_price = fresh_pool_state.current_price
                                sqrt_price_current = fresh_pool_state.sqrt_price

                                price_change_pct = abs(current_price - previous_price) / previous_price * 100
                                logger.info(f"Current price (fresh from chain): ${current_price:.4f}")
                                logger.info(f"Price change: {price_change_pct:.2f}% ({'+' if current_price > previous_price else '-'}${abs(current_price - previous_price):.4f})")

                                if price_change_pct > 0.1:
                                    logger.warning(f"⚠️  Significant price movement detected ({price_change_pct:.2f}%)")
                                    logger.warning(f"   Using fresh price prevents swap calculation errors")
                            else:
                                logger.warning("Failed to fetch fresh pool state, using previous price")
                                logger.warning("This may cause swap retry to fail if price has moved significantly")
                        except Exception as e:
                            logger.error(f"Exception fetching fresh price: {e}")
                            logger.error("Proceeding with previous price - swap may fail if price moved")

                        logger.info("=" * 80)

                        # CRITICAL FIX: Refetch balances before retry
                        # The initial swap may have partially succeeded or balances may have changed
                        # Using stale balances causes "insufficient lamports" errors
                        logger.info("🔄 REFETCHING CURRENT BALANCES FOR SWAP RETRY")
                        fresh_sol_balance, fresh_usdc_balance = await self.get_balances()
                        logger.info(f"Previous balances: {sol_balance:.4f} SOL, ${usdc_balance:.2f} USDC")
                        logger.info(f"Fresh balances: {fresh_sol_balance:.4f} SOL, ${fresh_usdc_balance:.2f} USDC")
                        sol_balance = fresh_sol_balance
                        usdc_balance = fresh_usdc_balance

                        # Retry with 2x swap slippage (use swap slippage, not position slippage)
                        # Recalculate swap slippage for retry (use base + additional for retry)
                        retry_swap_slippage_bps = min(swap_base_slippage_bps * 2, 500)  # Cap at 5%
                        logger.warning(f"Retry swap slippage: {retry_swap_slippage_bps} bps ({retry_swap_slippage_bps/100:.1f}%)")

                        sol_balance, usdc_balance, swap_result_retry = await self.check_and_swap_for_balance(
                            current_price,  # NOW USING FRESH PRICE!
                            sol_balance,  # NOW USING FRESH BALANCES!
                            usdc_balance,  # NOW USING FRESH BALANCES!
                            retry_swap_slippage_bps
                        )

                        if swap_result_retry and swap_result_retry.success:
                            logger.info(f"✅ Retry swap succeeded: {swap_result_retry.signature}")
                            # Update available_sol after successful retry
                            available_sol = sol_balance - sol_reserve
                            # Update swap_result to the successful retry
                            swap_result = swap_result_retry
                        else:
                            logger.error(f"❌ Retry swap also failed!")
                            logger.error(f"This will likely cause capital deployment issues")
                            logger.error(f"BLOCKING position opening to prevent capital waste")
                            logger.error(f"=" * 80)

                            # Send critical failure email notification
                            try:
                                from email_notifier import get_email_notifier
                                notifier = get_email_notifier()
                                notifier.notify_critical_failure(
                                    failure_type="SWAP_FAILURE",
                                    error_details={
                                        'initial_error': swap_result.error if swap_result else 'Unknown',
                                        'retry_attempted': True,
                                        'retry_slippage_bps': retry_swap_slippage_bps,
                                        'retry_error': swap_result_retry.error if swap_result_retry else 'Unknown',
                                        'sol_pct': sol_pct_post_swap,
                                        'usdc_pct': 1 - sol_pct_post_swap,
                                    },
                                    sol_balance=sol_balance,
                                    usdc_balance=usdc_balance,
                                    price=current_price,
                                )
                            except Exception as e:
                                logger.error(f"Failed to send critical failure email: {e}")

                            # BLOCK position opening - don't waste capital with severe imbalance
                            return PositionOpenResult(
                                success=False,
                                error=f"Cannot open position: tokens severely imbalanced ({sol_pct_post_swap*100:.1f}% SOL) and swap failed after retry. Blocking to prevent capital waste."
                            ), swap_result
                else:
                    # FIX #2: Removed redundant "forced swap" logic
                    # After Fix #1, swap_result will never be None when a swap was actually
                    # triggered. This branch should only be hit if truly no swap was needed,
                    # which should NEVER happen when severely imbalanced (93.9% > 10% threshold).
                    # If we ever reach here, it indicates a critical bug in swap decision logic.
                    logger.critical(f"=" * 80)
                    logger.critical(f"🐛 CRITICAL BUG: Severe imbalance but swap_result is None!")
                    logger.critical(f"=" * 80)
                    logger.critical(f"Wallet: {sol_pct_post_swap*100:.1f}% SOL / {(1-sol_pct_post_swap)*100:.1f}% USDC")
                    logger.critical(f"Swap threshold: 10% (should trigger at 60%)")
                    logger.critical(f"This indicates a bug in swap decision threshold logic")
                    logger.critical(f"Blocking position opening - manual intervention required")
                    logger.critical(f"=" * 80)

                    return PositionOpenResult(
                        success=False,
                        error=f"CRITICAL BUG: Severe imbalance ({sol_pct_post_swap*100:.1f}% SOL) but no swap was triggered. This should never happen."
                    ), None

                # Final balance check after all swap attempts
                available_sol = sol_balance - sol_reserve
                sol_value = available_sol * current_price
                usdc_value = usdc_balance
                total_value = sol_value + usdc_value
                final_sol_pct = sol_value / total_value if total_value > 0 else 0.5

                logger.info(f"Final token balance after swap retries: {final_sol_pct*100:.1f}% SOL / {(1-final_sol_pct)*100:.1f}% USDC")

                if abs(final_sol_pct - 0.5) > 0.3:  # Still >30% imbalanced
                    logger.error(f"❌ CRITICAL: Tokens still severely imbalanced after all retry attempts")
                    logger.error(f"BLOCKING position opening to prevent capital deployment bug")
                    return PositionOpenResult(
                        success=False,
                        error=f"Cannot open position: tokens remain severely imbalanced ({final_sol_pct*100:.1f}% SOL) after all swap attempts"
                    ), swap_result
                else:
                    logger.info(f"✅ Token balance acceptable - proceeding with position opening")
                    logger.info(f"=" * 80)

        # Recalculate available SOL after swap (or if no swap)
        if swap_result:
            # Recalculate available SOL after swap
            available_sol = sol_balance - sol_reserve

            # ================================================================================
            # CRITICAL FIX: Recalculate max_sol/max_usdc after swap
            # ================================================================================
            # After a swap, token balances have changed significantly. We MUST recalculate
            # from POST-SWAP balances to ensure proper capital deployment.
            #
            # IMPORTANT: The max_sol/max_usdc passed in were calculated BEFORE the position
            # close and swap. After these operations, the actual available capital may be
            # DIFFERENT (position close adds funds, swap changes ratios). We need to use
            # the CURRENT post-swap balances, not the outdated pre-close values.
            #
            # However, we must apply deployment_pct only ONCE. Since we're recalculating
            # from fresh balances, we apply deployment_pct here (not preserving old target).
            #
            # Example: Position was 99% SOL, projected USDC was $45.
            # After swap: SOL reduced, USDC increased to $455.
            # Old logic: max_usdc = $45 (from pre-swap) → wastes $400 USDC! ❌
            # New logic: Recalculate from post-swap balances → uses all available ✅
            # ================================================================================
            deployment_pct = self.config.capital.deployment_pct
            
            # Calculate total capital value from ACTUAL post-swap balances
            total_capital_value = (sol_balance - sol_reserve) * current_price + usdc_balance
            target_deployment_value = total_capital_value * deployment_pct
            
            logger.info(f"POST-SWAP capital recalculation:")
            logger.info(f"  Post-swap balances: {sol_balance:.4f} SOL, ${usdc_balance:.2f} USDC")
            logger.info(f"  Total capital value: ${total_capital_value:.2f}")
            logger.info(f"  Target deployment ({deployment_pct*100:.0f}%): ${target_deployment_value:.2f}")

            # Split 50/50 and respect configured maximums
            max_sol = min((target_deployment_value / 2) / current_price,
                          self.config.capital.max_sol_per_position)
            max_usdc = min(target_deployment_value / 2,
                           self.config.capital.max_usdc_per_position)

            logger.info(f"  Recalculated max_sol: {max_sol:.4f} SOL")
            logger.info(f"  Recalculated max_usdc: ${max_usdc:.2f}")
            logger.info(f"  Target deployment: ${target_deployment_value:.2f}")
        else:
            available_sol = sol_balance - sol_reserve

        # Enforce reserve: max_sol cannot exceed available SOL (after reserve)
        actual_max_sol = min(max_sol, available_sol)
        if actual_max_sol < max_sol:
            logger.info(f"SOL clamped: requested={max_sol:.4f}, available={available_sol:.4f}, final={actual_max_sol:.4f}")

        # Clamp USDC to available balance - no buffer needed
        # Unlike SOL (which needs reserve for tx fees), USDC has no rent/gas requirements
        actual_max_usdc = min(max_usdc, usdc_balance)
        if actual_max_usdc < max_usdc:
            logger.info(f"USDC clamped: requested={max_usdc:.2f}, available={usdc_balance:.2f}, final={actual_max_usdc:.2f}")

        # ================================================================================
        # CRITICAL FIX: Rebalance clamped amounts to ensure 50/50 value ratio
        # ================================================================================
        # After clamping by config limits and available balances, the amounts may not be
        # 50/50 value balanced. However, we must PRESERVE the total value intended by
        # deployment_pct, not reduce it to the minimum token value.
        #
        # BUG FIX: Previous logic used min(sol_value, usdc_value) which could dramatically
        # reduce position size if tokens were imbalanced. For example:
        # - deployment_pct = 0.9, intended: $900
        # - After close: $850 SOL + $50 USDC (imbalanced)
        # - Old logic: min($850, $50) = $50 → Final: $100 (11% of intended!) ❌
        # - New logic: Preserve $900 total, achieve 50/50 → Final: $900 (90% as intended) ✅
        #
        # The correct approach:
        # 1. Calculate total value we can achieve (may be limited by available tokens)
        # 2. Split that total 50/50 between SOL and USDC
        # 3. Only reduce if we don't have enough of one token
        # ================================================================================
        sol_value = actual_max_sol * current_price
        usdc_value = actual_max_usdc
        total_value = sol_value + usdc_value

        if total_value > 0:
            sol_pct = sol_value / total_value
            usdc_pct = usdc_value / total_value

            logger.info(f"PRE-REBALANCE token values:")
            logger.info(f"  SOL: {actual_max_sol:.4f} (${sol_value:.2f}) = {sol_pct*100:.1f}%")
            logger.info(f"  USDC: ${actual_max_usdc:.2f} = {usdc_pct*100:.1f}%")
            logger.info(f"  Total value: ${total_value:.2f}")

            # Only adjust if there's significant imbalance (>5%)
            imbalance = abs(sol_pct - 0.5)
            if imbalance > 0.05:
                # Calculate 50/50 balanced amounts
                target_value_each = total_value / 2

                # Calculate how much of each token we need for 50/50
                needed_sol = target_value_each / current_price
                needed_usdc = target_value_each

                logger.info(f"TOKEN REBALANCING REQUIRED:")
                logger.info(f"  Current imbalance: {imbalance*100:.1f}% (>{5.0:.1f}% threshold)")
                logger.info(f"  Target value each: ${target_value_each:.2f}")
                logger.info(f"  Needed for 50/50: {needed_sol:.4f} SOL + ${needed_usdc:.2f} USDC")
                logger.info(f"  Available: {actual_max_sol:.4f} SOL + ${actual_max_usdc:.2f} USDC")

                # Check if we have enough of each token
                # If we don't have enough of one, we're limited by that token
                if needed_sol <= actual_max_sol and needed_usdc <= actual_max_usdc:
                    # We have enough of both - use the full 50/50 split
                    balanced_sol = needed_sol
                    balanced_usdc = needed_usdc
                    logger.info(f"✅ REBALANCING tokens to 50/50 (preserving total value):")
                    logger.info(f"  SOL: {actual_max_sol:.4f} -> {balanced_sol:.4f}")
                    logger.info(f"  USDC: ${actual_max_usdc:.2f} -> ${balanced_usdc:.2f}")
                    logger.info(f"  Total value preserved: ${total_value:.2f}")
                else:
                    # Limited by one token - use what we have and match the other
                    if needed_sol > actual_max_sol:
                        # Limited by SOL - use all available SOL, match USDC
                        balanced_sol = actual_max_sol
                        balanced_usdc = (actual_max_sol * current_price)
                        final_value = (balanced_sol * current_price) + balanced_usdc
                        logger.warning(f"⚠️  REBALANCING tokens (LIMITED BY SOL):")
                        logger.warning(f"  Needed {needed_sol:.4f} SOL but only have {actual_max_sol:.4f} SOL")
                        logger.warning(f"  SOL: {actual_max_sol:.4f} (all available)")
                        logger.warning(f"  USDC: ${actual_max_usdc:.2f} -> ${balanced_usdc:.2f}")
                        logger.warning(f"  Final deployment: ${final_value:.2f} (reduced from ${total_value:.2f})")
                    else:
                        # Limited by USDC - use ALL available tokens to maximize deployment
                        # CRITICAL FIX: Don't reduce SOL to match USDC. Accept temporary imbalance
                        # to maximize capital deployment. CLMM will naturally balance the position
                        # based on current price and range anyway.
                        balanced_usdc = actual_max_usdc  # Use all available USDC
                        balanced_sol = actual_max_sol    # Use all available SOL (don't reduce!)

                        final_value = (balanced_sol * current_price) + balanced_usdc
                        final_sol_pct = (balanced_sol * current_price) / final_value if final_value > 0 else 0

                        logger.warning(f"⚠️  REBALANCING tokens (LIMITED BY USDC):")
                        logger.warning(f"  Needed ${needed_usdc:.2f} USDC but only have ${actual_max_usdc:.2f} USDC")
                        logger.warning(f"  DEPLOYING MAXIMUM OF BOTH TOKENS (accepting temporary imbalance):")
                        logger.warning(f"    SOL: {balanced_sol:.4f} (all available, ${balanced_sol * current_price:.2f})")
                        logger.warning(f"    USDC: ${balanced_usdc:.2f} (all available)")
                        logger.warning(f"  Final deployment: ${final_value:.2f}")
                        logger.warning(f"  Input ratio: {final_sol_pct*100:.1f}% SOL / {(1-final_sol_pct)*100:.1f}% USDC")
                        logger.warning(f"  Note: CLMM will use what it needs; position composition will be ~50/50")

                actual_max_sol = balanced_sol
                actual_max_usdc = balanced_usdc
            else:
                logger.info(f"✅ Tokens already balanced (imbalance={imbalance*100:.1f}%)")

        # ================================================================================
        # DEPLOYMENT VALIDATION: Ensure we're deploying the expected percentage
        # ================================================================================
        deployment_pct = self.config.capital.deployment_pct
        total_available_value = (sol_balance - sol_reserve) * current_price + usdc_balance
        expected_deployment = total_available_value * deployment_pct
        expected_min_deployment = expected_deployment * 0.8  # 80% of target
        actual_deployment_value = (actual_max_sol * current_price) + actual_max_usdc
        deployment_ratio = (actual_deployment_value / total_available_value) if total_available_value > 0 else 0

        logger.info(f"=" * 80)
        logger.info(f"CAPITAL DEPLOYMENT VALIDATION")
        logger.info(f"=" * 80)
        logger.info(f"Total available capital: ${total_available_value:.2f}")
        logger.info(f"  - SOL: {sol_balance:.4f} (${(sol_balance - sol_reserve) * current_price:.2f} after reserve)")
        logger.info(f"  - USDC: ${usdc_balance:.2f}")
        logger.info(f"Target deployment ({deployment_pct*100:.0f}%): ${expected_deployment:.2f}")
        logger.info(f"Actual deployment: ${actual_deployment_value:.2f}")
        logger.info(f"  - SOL: {actual_max_sol:.4f} (${actual_max_sol * current_price:.2f})")
        logger.info(f"  - USDC: ${actual_max_usdc:.2f}")
        logger.info(f"Deployment ratio: {deployment_ratio*100:.1f}%")

        if actual_deployment_value < expected_min_deployment:
            capital_wasted = total_available_value - actual_deployment_value
            logger.error(f"=" * 80)
            logger.error(f"🚨 CRITICAL: CAPITAL DEPLOYMENT SEVERELY UNDERUTILIZED 🚨")
            logger.error(f"=" * 80)
            logger.error(f"Expected deployment: ${expected_deployment:.2f} ({deployment_pct*100:.0f}%)")
            logger.error(f"Actual deployment: ${actual_deployment_value:.2f} ({deployment_ratio*100:.1f}%)")
            logger.error(f"Capital underutilized: ${capital_wasted:.2f}")
            logger.error(f"This indicates a bug in capital calculation or swap failure!")
            logger.error(f"")
            logger.error(f"Diagnostic Information:")
            logger.error(f"  - Swap executed: {'YES' if swap_result and swap_result.success else 'NO' if swap_result else 'NOT NEEDED'}")
            if swap_result and not swap_result.success:
                logger.error(f"  - Swap error: {swap_result.error}")
            logger.error(f"  - Pre-rebalance SOL: {actual_max_sol:.4f} ({sol_pct*100:.1f}% of value)")
            logger.error(f"  - Pre-rebalance USDC: ${actual_max_usdc:.2f} ({usdc_pct*100:.1f}% of value)")
            logger.error(f"  - Token imbalance triggered: {imbalance > 0.02 if 'imbalance' in locals() else 'Unknown'}")
            logger.error(f"=" * 80)

            # Send critical failure email notification for capital deployment issue
            try:
                from email_notifier import get_email_notifier
                notifier = get_email_notifier()
                notifier.notify_critical_failure(
                    failure_type="CAPITAL_DEPLOYMENT",
                    error_details={
                        'total_available': total_available_value,
                        'expected_deployment': expected_deployment,
                        'actual_deployment': actual_deployment_value,
                        'deployment_ratio': deployment_ratio,
                        'capital_wasted': capital_wasted,
                        'swap_executed': swap_result and swap_result.success,
                        'swap_failed': swap_result and not swap_result.success,
                        'swap_error': swap_result.error if (swap_result and not swap_result.success) else None,
                    },
                    sol_balance=sol_balance,
                    usdc_balance=usdc_balance,
                    price=current_price,
                )
            except Exception as e:
                logger.error(f"Failed to send capital deployment failure email: {e}")
        elif deployment_ratio < deployment_pct * 0.9:
            logger.warning(f"⚠️  Capital deployment below 90% of target ({deployment_ratio*100:.1f}% vs {deployment_pct*100:.0f}%)")
        else:
            logger.info(f"✅ Capital deployment within expected range")
        logger.info(f"=" * 80)

        # Ensure we have something to deposit
        if actual_max_sol <= 0.001 and actual_max_usdc <= 1.0:
            logger.error(f"Insufficient funds for position after reserve")
            return PositionOpenResult(
                success=False,
                error=f"Insufficient funds after reserve. Available: {actual_max_sol:.4f} SOL, ${actual_max_usdc:.2f} USDC"
            ), swap_result

        # IMPORTANT: Calculate liquidity using CLMM math based on actual available amounts
        # The simple formula (total_value * 1e6) is wrong for concentrated liquidity!
        # We use the exact on-chain sqrt_price for accurate liquidity calculation.
        #
        # CRITICAL: Use a MORE AGGRESSIVE safety factor (0.95 = 5% reduction)
        # This accounts for:
        # 1. Rounding differences between our math and on-chain math
        # 2. Any price movement between this calculation and transaction execution
        # 3. The contract's specific handling of edge cases
        actual_liquidity = calculate_clmm_liquidity(
            lower_tick=lower_tick,
            upper_tick=upper_tick,
            sqrt_price_current=sqrt_price_current,  # Use exact on-chain value
            token_a_amount=actual_max_sol,
            token_b_amount=actual_max_usdc,
            safety_factor=0.95,  # 5% reduction to prevent TokenMaxExceeded
        )

        logger.info(f"Liquidity calculated using CLMM math:")
        logger.info(f"  Passed liquidity (from config, WRONG): {liquidity:,}")
        logger.info(f"  Actual liquidity (CLMM formula): {actual_liquidity:,}")
        logger.info(f"  Available tokens: {actual_max_sol:.4f} SOL, ${actual_max_usdc:.2f} USDC")

        # Use the properly calculated liquidity
        liquidity = actual_liquidity

        # CRITICAL: Estimate the actual token amounts that will be required for this liquidity
        # This ensures token_max values are correctly set based on price position
        sqrt_price_lower = tick_to_sqrt_price(lower_tick)
        sqrt_price_upper = tick_to_sqrt_price(upper_tick)

        expected_sol_lamports, expected_usdc_micro = estimate_amounts_from_liquidity(
            sqrt_price_current=sqrt_price_current,
            lower_tick=lower_tick,
            upper_tick=upper_tick,
            liquidity=liquidity,
        )

        expected_sol = expected_sol_lamports / 1e9
        expected_usdc = expected_usdc_micro / 1e6

        logger.info(f"Expected amounts from liquidity {liquidity:,}:")
        logger.info(f"  Expected SOL: {expected_sol:.6f}")
        logger.info(f"  Expected USDC: ${expected_usdc:.2f}")

        # Determine price position to understand token requirements
        price_below_range = sqrt_price_current <= sqrt_price_lower
        price_above_range = sqrt_price_current >= sqrt_price_upper

        if price_below_range:
            logger.info(f"  Position type: PRICE BELOW RANGE (100% SOL deposit)")
        elif price_above_range:
            logger.info(f"  Position type: PRICE ABOVE RANGE (100% USDC deposit)")
        else:
            logger.info(f"  Position type: PRICE IN RANGE (mixed SOL/USDC deposit)")

        # ================================================================================
        # token_max = full wallet balance (authorization ceiling)
        # ================================================================================
        # The liquidity amount (with safety_factor=0.95) controls actual deposit.
        # token_max is just the max the contract may pull — setting it to wallet
        # balance eliminates TokenMaxExceeded (6017) from buffer clipping.
        # ================================================================================
        wallet_sol_lamports = int(sol_balance * 1e9)
        wallet_usdc_micro = int(usdc_balance * 1e6)

        token_max_a = max(wallet_sol_lamports, 1000)  # Floor at 1000 lamports
        token_max_b = max(wallet_usdc_micro, 1000)    # Floor at 1000 micro-USDC

        logger.info(f"Token max set to wallet balance (authorization ceiling):")
        logger.info(f"  Wallet: {sol_balance:.4f} SOL, ${usdc_balance:.2f} USDC")
        logger.info(f"  token_max_a: {token_max_a:,} lamports ({token_max_a/1e9:.4f} SOL)")
        logger.info(f"  token_max_b: {token_max_b:,} micro-USDC (${token_max_b/1e6:.2f})")
        logger.info(f"  Expected deposit: {expected_sol:.6f} SOL, ${expected_usdc:.2f} USDC")
        logger.info(f"  Headroom SOL: {((token_max_a/1e9) - expected_sol):.6f}")
        logger.info(f"  Headroom USDC: ${((token_max_b/1e6) - expected_usdc):.2f}")

        logger.info(f"Opening position:")
        logger.info(f"  Ticks: [{lower_tick}, {upper_tick}]")
        logger.info(f"  Max SOL: {actual_max_sol:.4f} (requested: {max_sol:.4f})")
        logger.info(f"  Max USDC: ${actual_max_usdc:.2f} (requested: ${max_usdc:.2f})")
        logger.info(f"  Liquidity: {liquidity:,}")
        logger.info(f"  SOL remaining after: ~{sol_balance - actual_max_sol:.4f} (reserve: {sol_reserve:.4f})")
        logger.info(f"  Token max (wallet ceiling): {token_max_a:,} lamports, {token_max_b:,} micro-USDC")

        # CRITICAL FIX: Re-snapshot wallet AFTER swap so open cost only captures
        # rent + tx fees, NOT swap slippage (which is tracked separately under 'swap' category).
        # Previously snap_sol_before was from line ~1582 (before swap), causing double-counting
        # of swap cost in both 'position_open' and 'swap' categories.
        snap_sol_before, snap_usdc_before, snap_value_before = await self._snapshot_wallet_value(current_price)

        # Open position with progressive slippage buffer
        # The buffer should match the effective_slippage_bps to allow for price movement
        open_result = await self._position_executor.open_position(
            lower_tick=lower_tick,
            upper_tick=upper_tick,
            liquidity_amount=liquidity,
            token_max_a=token_max_a,
            token_max_b=token_max_b,
            slippage_buffer_bps=effective_slippage_bps,
        )

        # Fetch transaction fee from RPC if position opened successfully
        if open_result.success and open_result.signature:
            # FIX: Wait for transaction to be indexed on RPC before fetching fee
            # Without this delay, getTransaction returns null and fee becomes 0.0
            logger.info(f"  Waiting 5 seconds for transaction to be indexed on RPC...")
            await asyncio.sleep(5)

            tx_fee_sol = await self.get_transaction_fee(open_result.signature)

            # Calculate position value for actual cost calculation
            position_value = (open_result.deposited_sol * current_price) + open_result.deposited_usdc

            # Calculate ACTUAL cost from balance difference
            # Only calculate actual_cost if open succeeded
            actual_cost = None
            if open_result.success:
                actual_cost = await self._calculate_actual_cost(
                    sol_before=snap_sol_before,
                    usdc_before=snap_usdc_before,
                    value_before=snap_value_before,
                    price=current_price,
                    operation_type='position_open',
                    position_value=position_value,
                    rpc_fee_sol=tx_fee_sol,
                    wait_for_settlement=False,  # Already waited above
                )
            else:
                logger.info("  Open failed - not calculating costs")

            # Convert to PositionOpenResultWithFee to add tx_fee_sol and actual_cost
            open_with_fee = PositionOpenResultWithFee(
                success=open_result.success,
                position_address=open_result.position_address,
                signature=open_result.signature,
                deposited_sol=open_result.deposited_sol,
                deposited_usdc=open_result.deposited_usdc,
                liquidity=open_result.liquidity,
                lower_tick=open_result.lower_tick,
                upper_tick=open_result.upper_tick,
                lower_price=open_result.lower_price,
                upper_price=open_result.upper_price,
                error=open_result.error,
                tx_fee_sol=tx_fee_sol,
                actual_cost=actual_cost,
            )
            logger.info(f"  Open transaction fee: {open_with_fee.tx_fee_sol:.9f} SOL")
            return open_with_fee, swap_result

        return open_result, swap_result

    async def close_position(
        self,
        position_address: str,
        collect_fees: bool = True,
        current_price: float = 0.0,
        position_value_usd: float = 0.0,
        pre_close_fees_sol: float = 0.0,
        pre_close_fees_usdc: float = 0.0,
    ) -> PositionCloseResult:
        """Close a position with actual fee tracking from balance differences.

        Args:
            position_address: Position to close
            collect_fees: Whether to collect fees during close
            current_price: Current SOL price for cost tracking
            position_value_usd: Position value for cost calculation
            pre_close_fees_sol: Pending fees in SOL read from on-chain/snapshot BEFORE close.
                These are used for accurate cost calculation since the close tx collects
                fees into the wallet alongside the principal, making them indistinguishable
                from balance diffs alone.
            pre_close_fees_usdc: Pending fees in USDC read from on-chain/snapshot BEFORE close.
        """
        logger.info(f"Closing position: {position_address}")

        # ===== READ ON-CHAIN FEE_OWED AS MINIMUM BOUND =====
        # fee_owed_a/fee_owed_b from position state are the fees accumulated since
        # last updateFeesAndRewards call (stale but guaranteed minimum).
        # If caller didn't provide pre_close_fees, read them from chain as fallback.
        if pre_close_fees_sol == 0.0 and pre_close_fees_usdc == 0.0:
            try:
                if self._position_executor and self._position_executor._orca_client:
                    orca = self._position_executor._orca_client
                    pos_state = await orca.get_position_state(position_address)
                    if pos_state:
                        pre_close_fees_sol = pos_state.fee_owed_a / 1e9
                        pre_close_fees_usdc = pos_state.fee_owed_b / 1e6
                        logger.info(
                            f"On-chain fee_owed (stale minimum): "
                            f"{pre_close_fees_sol:.6f} SOL, ${pre_close_fees_usdc:.2f} USDC"
                        )
            except Exception as e:
                logger.warning(f"Failed to read on-chain fee_owed: {e}")

        if pre_close_fees_sol > 0 or pre_close_fees_usdc > 0:
            logger.info(
                f"Pre-close fees for cost calc: "
                f"{pre_close_fees_sol:.6f} SOL, ${pre_close_fees_usdc:.2f} USDC"
            )

        # Get balance before close and snapshot for actual cost
        pre_sol, pre_usdc = await self.get_balances()
        snap_value_before = (pre_sol * current_price) + pre_usdc if current_price > 0 else 0.0

        close_result = await self._position_executor.close_position(
            position_address=position_address,
            collect_fees=collect_fees,
        )

        # Parse EXACT principal and fee amounts from the close transaction.
        # This replaces the old balance-diff approach which conflated principal + fees.
        if close_result.success or (close_result.signature and close_result.signature != ""):
            # Fetch transaction fee from RPC
            if close_result.signature:
                try:
                    logger.info(f"  Waiting for close TX to be indexed on RPC...")
                    close_result.tx_fee_sol = await self.get_transaction_fee(close_result.signature)
                except Exception as e:
                    logger.warning(f"Could not fetch tx fee: {e}")
                    close_result.tx_fee_sol = 0.0

            # Parse close TX to separate principal from fees
            try:
                principal_sol, principal_usdc, parsed_fees_sol, parsed_fees_usdc = (
                    await parse_close_position_amounts(
                        rpc_url=self.config.api.rpc_url,
                        signature=close_result.signature,
                    )
                )
                close_result.withdrawn_sol = principal_sol
                close_result.withdrawn_usdc = principal_usdc
                close_result.fees_collected_sol = parsed_fees_sol
                close_result.fees_collected_usdc = parsed_fees_usdc

                logger.info(f"Close TX parsed (exact):")
                logger.info(f"  Principal: {principal_sol:.9f} SOL, ${principal_usdc:.6f} USDC")
                logger.info(f"  Fees:      {parsed_fees_sol:.9f} SOL, ${parsed_fees_usdc:.6f} USDC")
                logger.info(f"  TX fee:    {close_result.tx_fee_sol:.9f} SOL")

            except Exception as e:
                logger.error(f"Failed to parse close TX: {e}")
                # No fallback — report zero so CSV shows the problem clearly
                close_result.withdrawn_sol = 0.0
                close_result.withdrawn_usdc = 0.0
                close_result.fees_collected_sol = 0.0
                close_result.fees_collected_usdc = 0.0

            # Also log balance diff for cross-reference (informational only)
            await asyncio.sleep(2)
            post_sol, post_usdc = await self.get_balances()
            sol_diff = post_sol - pre_sol
            usdc_diff = post_usdc - pre_usdc
            logger.info(f"  Balance diff (cross-ref): {sol_diff:+.6f} SOL, {usdc_diff:+.2f} USDC")

            # Detect timeout success: balance changed but close_result.success is False
            if not close_result.success and (abs(sol_diff) > 0.01 or abs(usdc_diff) > 1.0):
                logger.warning(
                    "close_marked_failed_but_balances_changed",
                    sol_diff=sol_diff,
                    usdc_diff=usdc_diff,
                    message="Close was marked as failed (likely timeout) but balances changed significantly.",
                )

            # Determine if close actually succeeded
            close_actually_succeeded = close_result.success
            if not close_result.success and (abs(sol_diff) > 0.01 or abs(usdc_diff) > 1.0):
                close_actually_succeeded = True
                logger.info("  Close succeeded on-chain despite timeout - will calculate costs")

            # Calculate actual cost if close succeeded
            if close_actually_succeeded and current_price > 0:
                fees_collected_usd = (
                    close_result.fees_collected_sol * current_price
                ) + close_result.fees_collected_usdc

                logger.info(
                    f"Fees for cost calc: ${fees_collected_usd:.4f} "
                    f"({close_result.fees_collected_sol:.6f} SOL + "
                    f"${close_result.fees_collected_usdc:.2f} USDC)"
                )

                # Use TX-parsed principal for position_value (more accurate than snapshot estimate)
                effective_position_value = position_value_usd
                if close_result.withdrawn_sol > 0 or close_result.withdrawn_usdc > 0:
                    tx_parsed_value = (close_result.withdrawn_sol * current_price) + close_result.withdrawn_usdc
                    if abs(tx_parsed_value - position_value_usd) > 1.0:
                        logger.info(
                            f"  Position value updated from TX parse: "
                            f"${position_value_usd:.2f} -> ${tx_parsed_value:.2f}"
                        )
                    effective_position_value = tx_parsed_value

                close_result.actual_cost = await self._calculate_actual_cost(
                    sol_before=pre_sol,
                    usdc_before=pre_usdc,
                    value_before=snap_value_before,
                    price=current_price,
                    operation_type='position_close',
                    position_value=effective_position_value,
                    rpc_fee_sol=close_result.tx_fee_sol,
                    wait_for_settlement=False,
                    fees_collected_usd=fees_collected_usd,
                )
            else:
                close_result.actual_cost = None
                logger.info("  Close failed - not calculating costs")

        return close_result

    async def rebalance_position(
        self,
        current_position_address: str,
        new_lower_tick: int,
        new_upper_tick: int,
        max_sol: float,
        max_usdc: float,
        liquidity: int,
        max_open_retries: int = 8,  # Match progressive slippage schedule length
        current_price: float = 0.0,  # SOL price for accurate cost tracking
        position_value_usd: float = 0.0,  # Position value for close cost calculation
        pre_close_fees_sol: float = 0.0,  # Pending fees from snapshot/on-chain (SOL)
        pre_close_fees_usdc: float = 0.0,  # Pending fees from snapshot/on-chain (USDC)
    ) -> RebalanceResult:
        """
        Rebalance: close current position and open a new one.

        THIS IS A CRITICAL METHOD FOR LIQUIDITY UTILIZATION.
        See module docstring "FAILED POSITION OPEN HANDLING & RECOVERY FLOW"
        for comprehensive documentation on the retry and recovery mechanisms.

        Tracks pre/post balances to calculate actual transaction fees.
        Implements retry logic for failed position opens.

        IMPORTANT: The retry mechanism here (max_open_retries) provides
        IMMEDIATE retry within the same rebalance operation. If all retries
        fail, the RebalanceResult.fully_succeeded will be False, and the
        caller (lp_strategy._execute_rebalance) will trigger the RECOVERY
        mechanism which runs in subsequent iterations.

        Flow:
        1. Record initial balances
        2. Close current position
        3. Wait for balance settlement
        4. Attempt to open new position (with retry loop):
           - Fetch fresh balances before each attempt
           - Recalculate max amounts after subtracting SOL reserve
           - Try open_position_with_rebalance (includes swap if needed)
           - If "insufficient funds" error → stop (unrecoverable)
           - If other error → wait and retry
        5. Record final balances and calculate actual TX fees
        6. Return RebalanceResult with detailed tracking fields

        Args:
            current_position_address: Position to close
            new_lower_tick: Lower tick for new position
            new_upper_tick: Upper tick for new position
            max_sol: Maximum SOL to use
            max_usdc: Maximum USDC to use
            liquidity: Target liquidity
            max_open_retries: Number of retry attempts for opening position (default: 3)

        Returns:
            RebalanceResult containing:
            - close_result: PositionCloseResult (always attempted)
            - open_result: PositionOpenResult (may be None if all attempts failed)
            - swap_result: SwapResult if token swap was performed
            - fully_succeeded: bool - True only if BOTH close and open succeeded
            - open_attempts: int - How many open attempts were made (1 to max_open_retries)
            - open_errors: List[str] - All error messages from failed attempts
            - total_tx_fees_sol: float - Calculated from balance differences
        """
        logger.info("=" * 50)
        logger.info("REBALANCING POSITION")
        logger.info("=" * 50)

        result = RebalanceResult()

        # Get balance at very start of rebalance
        initial_sol, initial_usdc = await self.get_balances()
        logger.info(f"Initial balance: {initial_sol:.6f} SOL, ${initial_usdc:.2f} USDC")

        # Step 1: Close current position
        logger.info(f"[STEP 1] Closing position: {current_position_address[:16]}...")
        close_result = await self.close_position(
            current_position_address,
            collect_fees=True,
            current_price=current_price,
            position_value_usd=position_value_usd,
            pre_close_fees_sol=pre_close_fees_sol,
            pre_close_fees_usdc=pre_close_fees_usdc,
        )
        result.close_result = close_result
        result.total_tx_fees_sol += close_result.tx_fee_sol

        if not close_result.success:
            logger.error(f"Failed to close position: {close_result.error}")
            result.open_errors.append(f"Close failed: {close_result.error}")
            return result

        logger.info(f"Position closed: {close_result.signature}")

        # Get balance after close (before swap/open)
        post_close_sol, post_close_usdc = await self.get_balances()
        logger.info(f"Balance after close: {post_close_sol:.6f} SOL, ${post_close_usdc:.2f} USDC")

        # Wait for balance to settle
        await asyncio.sleep(2)

        # ============================================================================
        # CRITICAL FIX: Unwrap wSOL before attempting swap
        # ============================================================================
        # Position close returns SOL as wSOL. Jupiter swaps need native SOL.
        # Without unwrapping here, swaps fail with "insufficient lamports" because
        # Jupiter can only access native SOL, not wSOL token accounts.
        # ============================================================================
        try:
            from app.chain.wsol_cleanup import get_wsol_cleanup_manager, get_wsol_balance

            # Check if we have wSOL to unwrap
            wsol_balance = await get_wsol_balance()
            if wsol_balance > 0.001:  # Only cleanup if meaningful wSOL exists
                logger.info("=" * 80)
                logger.info("UNWRAPPING wSOL BEFORE SWAP")
                logger.info("=" * 80)
                logger.info(f"Found {wsol_balance:.4f} wSOL to unwrap...")

                cleanup_manager = await get_wsol_cleanup_manager()
                cleanup_result = await cleanup_manager.cleanup_wsol_accounts()

                if cleanup_result.success and cleanup_result.accounts_cleaned > 0:
                    logger.info(f"✅ Successfully unwrapped {cleanup_result.total_sol_recovered:.4f} SOL")
                    logger.info(f"   Closed {cleanup_result.accounts_cleaned} wSOL account(s)")

                    # Wait for unwrap transaction to finalize and reflect in balance
                    logger.info("   Waiting for unwrap to finalize...")
                    await asyncio.sleep(3)

                    # Log new native SOL balance for verification
                    new_sol_balance = await self._solana_client.get_balance_sol()
                    logger.info(f"   Native SOL balance after unwrap: {new_sol_balance:.4f} SOL")
                    logger.info("=" * 80)
                elif not cleanup_result.success:
                    logger.warning(f"⚠️  wSOL cleanup failed: {cleanup_result.error}")
                    logger.warning("   Swap may fail due to insufficient native SOL")
            else:
                logger.debug("No significant wSOL to unwrap before swap")

        except Exception as e:
            logger.error(f"❌ wSOL pre-swap cleanup error: {e}")
            logger.warning("   Proceeding anyway - swap may fail if wSOL isn't unwrapped")
        # ============================================================================

        # Step 2: Open new position (with swap if needed) - WITH RETRY LOGIC
        logger.info(f"[STEP 2] Opening new position (max {max_open_retries} attempts)...")

        open_result = None
        swap_result = None
        retry_delays = [2, 4, 8, 12, 16]  # Geometric backoff for 5 retries (~45s total max)

        for attempt in range(max_open_retries):
            result.open_attempts = attempt + 1
            logger.info(f"  Open attempt {attempt + 1}/{max_open_retries}...")

            # Get current balances before this attempt
            pre_open_sol, pre_open_usdc = await self.get_balances()
            logger.info(f"  Pre-open balance: {pre_open_sol:.6f} SOL, ${pre_open_usdc:.2f} USDC")

            try:
                # Pass retry_attempt to enable PROGRESSIVE SLIPPAGE
                # Each attempt gets higher slippage tolerance to handle volatility
                open_result, swap_result = await self.open_position_with_rebalance(
                    lower_tick=new_lower_tick,
                    upper_tick=new_upper_tick,
                    max_sol=max_sol,
                    max_usdc=max_usdc,
                    liquidity=liquidity,
                    retry_attempt=attempt,  # 0-based for progressive slippage
                )

                if open_result.success:
                    logger.info(f"  Position opened successfully on attempt {attempt + 1}")
                    result.fully_succeeded = True
                    break
                else:
                    error_msg = f"Attempt {attempt + 1}: {open_result.error}"
                    result.open_errors.append(error_msg)
                    logger.warning(f"  Open failed: {open_result.error}")

                    # Check if this is an unrecoverable error (won't improve with retries)
                    error_lower = (open_result.error or "").lower()
                    unrecoverable_patterns = [
                        "insufficient",           # Insufficient funds/balance
                        # NOTE: TokenMaxExceeded (6017) is NOT unrecoverable!
                        # Higher slippage → higher token_max → can fix this error.
                        # Removed "tokenmaxexceeded" and "6017" to allow retry.
                        "5003",                   # RentExemption error
                        "rent",                   # Rent-related errors
                        "accountnotfound",        # Account doesn't exist
                    ]
                    if any(pattern in error_lower for pattern in unrecoverable_patterns):
                        logger.error(f"  Unrecoverable error detected - won't retry: {open_result.error}")
                        break

            except Exception as e:
                error_msg = f"Attempt {attempt + 1}: Exception - {str(e)}"
                result.open_errors.append(error_msg)
                logger.exception(f"  Exception during open: {e}")

            # Wait before retry (if not last attempt)
            if attempt < max_open_retries - 1:
                delay = retry_delays[min(attempt, len(retry_delays) - 1)]
                logger.info(f"  Waiting {delay}s before retry...")

                # Send retry notification email
                # Calculate current and next slippage for the notification
                # MUST match the progressive_slippage_schedule in open_position_with_rebalance
                base_slippage_bps = self.config.rebalance.slippage_bps
                progressive_schedule = [0, 15, 30, 45, 50]  # Conservative: max +50 bps
                current_slippage = base_slippage_bps + progressive_schedule[min(attempt, len(progressive_schedule) - 1)]
                current_slippage = min(current_slippage, 100)  # Cap at 1.0%
                next_slippage = base_slippage_bps + progressive_schedule[min(attempt + 1, len(progressive_schedule) - 1)]
                next_slippage = min(next_slippage, 100)  # Cap at 1.0%

                try:
                    notifier = get_email_notifier()
                    # Use fresh pool state for accurate price in notification
                    pool_state = await self.get_pool_state(force_refresh=True)
                    notifier.notify_retry_attempt(
                        operation="rebalance",
                        attempt_number=attempt + 1,
                        max_attempts=max_open_retries,
                        error_message=result.open_errors[-1] if result.open_errors else "Unknown error",
                        slippage_bps=current_slippage,
                        next_slippage_bps=next_slippage,
                        price=pool_state.current_price,
                        sol_balance=pre_open_sol,
                        usdc_balance=pre_open_usdc,
                        position_address=current_position_address,
                    )
                except Exception as e:
                    logger.warning(f"Failed to send retry notification email: {e}")

                # Add jitter to prevent synchronized RPC load from multiple instances
                jitter = delay * random.uniform(0, 0.2)
                await asyncio.sleep(delay + jitter)

                # Refresh balances for next attempt
                # CRITICAL FIX: Apply deployment_pct when recalculating max amounts
                # Previous bug: was using 100% of balance instead of configured deployment_pct
                fresh_sol, fresh_usdc = await self.get_balances()
                sol_reserve = self.config.capital.min_sol_reserve
                deployment_pct = self.config.capital.deployment_pct
                
                # Calculate deployment based on percentage of wallet (after reserve)
                max_sol = (fresh_sol - sol_reserve) * deployment_pct
                max_usdc = fresh_usdc * deployment_pct
                
                # Respect configured maximums as upper bounds (safety limits)
                max_sol = min(max_sol, self.config.capital.max_sol_per_position)
                max_usdc = min(max_usdc, self.config.capital.max_usdc_per_position)
                
                logger.info(f"  Updated max amounts for retry (deployment_pct={deployment_pct*100:.0f}%): {max_sol:.4f} SOL, ${max_usdc:.2f} USDC")

        result.open_result = open_result
        result.swap_result = swap_result

        # Get final balance to calculate actual fees
        await asyncio.sleep(1)
        final_sol, final_usdc = await self.get_balances()

        # Calculate actual balance changes from the entire rebalance operation
        # These are REAL values derived from wallet balance differences - no estimates

        if open_result and open_result.success:
            deposited_sol = open_result.deposited_sol
            deposited_usdc = open_result.deposited_usdc
        else:
            deposited_sol = 0
            deposited_usdc = 0

        # Net changes to wallet
        net_sol_change = final_sol - initial_sol
        net_usdc_change = final_usdc - initial_usdc

        # Calculate total transaction fees from actual RPC data
        # We now have tx_fee_sol populated from RPC for each transaction
        result.total_tx_fees_sol = close_result.tx_fee_sol

        # Add open transaction fee if position was opened
        if open_result and open_result.success:
            open_tx_fee = getattr(open_result, 'tx_fee_sol', 0.0)
            result.total_tx_fees_sol += open_tx_fee

        # Add swap transaction fee if swap was performed
        if swap_result and swap_result.success:
            result.total_tx_fees_sol += swap_result.tx_fee_sol

        logger.info(f"Rebalance balance summary:")
        logger.info(f"  Initial: {initial_sol:.6f} SOL, ${initial_usdc:.2f} USDC")
        logger.info(f"  Final:   {final_sol:.6f} SOL, ${final_usdc:.2f} USDC")
        logger.info(f"  Net SOL change: {net_sol_change:+.6f} SOL")
        logger.info(f"  Net USDC change: {net_usdc_change:+.2f} USDC")
        logger.info(f"  Close net SOL: {close_result.withdrawn_sol:+.6f} SOL")
        logger.info(f"  Close net USDC: {close_result.withdrawn_usdc:+.2f} USDC")
        logger.info(f"  Deposited: {deposited_sol:.6f} SOL, ${deposited_usdc:.2f} USDC")
        logger.info(f"  Transaction Fees (from RPC):")
        logger.info(f"    Close fee: {close_result.tx_fee_sol:.9f} SOL")
        if open_result and open_result.success:
            logger.info(f"    Open fee:  {getattr(open_result, 'tx_fee_sol', 0.0):.9f} SOL")
        if swap_result and swap_result.success:
            logger.info(f"    Swap fee:  {swap_result.tx_fee_sol:.9f} SOL")
        logger.info(f"  Total TX Fees: {result.total_tx_fees_sol:.9f} SOL")
        logger.info(f"  Open attempts: {result.open_attempts}, Fully succeeded: {result.fully_succeeded}")

        # Aggregate actual costs from individual operations into total_actual_cost
        # This captures the true cost including slippage, rent, and price impact
        close_actual = getattr(close_result, 'actual_cost', None)
        open_actual = getattr(open_result, 'actual_cost', None) if open_result else None
        swap_actual = getattr(swap_result, 'actual_cost', None) if swap_result else None

        if close_actual or open_actual or swap_actual:
            # Sum up all actual costs
            total_actual_cost_usd = 0.0
            total_actual_cost_sol = 0.0

            if close_actual:
                total_actual_cost_usd += close_actual.actual_cost_usd
                total_actual_cost_sol += close_actual.actual_cost_sol
            if open_actual:
                total_actual_cost_usd += open_actual.actual_cost_usd
                total_actual_cost_sol += open_actual.actual_cost_sol
            if swap_actual:
                total_actual_cost_usd += swap_actual.actual_cost_usd
                total_actual_cost_sol += swap_actual.actual_cost_sol

            # Derive price from close_actual (which always runs first and has valid price)
            # Use value_before and sol_before to calculate: price = (value - usdc) / sol
            derived_price = 0.0
            if close_actual and close_actual.sol_before > 0:
                derived_price = (close_actual.value_before_usd - close_actual.usdc_before) / close_actual.sol_before

            # Create aggregated ActualCost object
            result.total_actual_cost = ActualCost(
                sol_before=initial_sol,
                usdc_before=initial_usdc,
                value_before_usd=(initial_sol * derived_price) + initial_usdc if derived_price > 0 else 0.0,
                sol_after=final_sol,
                usdc_after=final_usdc,
                value_after_usd=(final_sol * derived_price) + final_usdc if derived_price > 0 else 0.0,
                position_value_usd=(deposited_sol * derived_price) + deposited_usdc if open_result and open_result.success and derived_price > 0 else 0.0,
                actual_cost_usd=total_actual_cost_usd,
                actual_cost_sol=total_actual_cost_sol,
                rpc_fee_sol=result.total_tx_fees_sol,
            )

            logger.info(f"  Actual Costs (balance-based):")
            logger.info(f"    Close: ${close_actual.actual_cost_usd:.4f}" if close_actual else "    Close: N/A")
            logger.info(f"    Open:  ${open_actual.actual_cost_usd:.4f}" if open_actual else "    Open:  N/A")
            logger.info(f"    Swap:  ${swap_actual.actual_cost_usd:.4f}" if swap_actual else "    Swap:  N/A")
            logger.info(f"    Total: ${total_actual_cost_usd:.4f} ({total_actual_cost_sol:.6f} SOL)")
            if result.total_tx_fees_sol > 0 and derived_price > 0:
                ratio = total_actual_cost_usd / (result.total_tx_fees_sol * derived_price)
                logger.info(f"    RPC underreports by: ~{ratio:.1f}x")

        # ===== WHOLE-REBALANCE COST (single start-to-end measurement) =====
        # This avoids inter-operation snapshot timing noise by measuring the entire
        # rebalance as one atomic balance change.
        #
        # Formula: total_cost = (value_before + old_pos_value) - (value_after + new_pos_value) + fees_collected
        # Where:
        #   value_before/after = wallet value (SOL * price + USDC)
        #   old_pos_value = position value before close (provided by caller)
        #   new_pos_value = deposited value after open
        #   fees_collected = LP fees collected during close
        if current_price > 0:
            initial_value = (initial_sol * current_price) + initial_usdc
            final_value = (final_sol * current_price) + final_usdc
            new_pos_value = (deposited_sol * current_price) + deposited_usdc if open_result and open_result.success else 0.0
            fees_collected_value = (pre_close_fees_sol * current_price) + pre_close_fees_usdc

            # total_value_before = wallet + old_position = initial_value + position_value_usd
            # total_value_after = wallet + new_position = final_value + new_pos_value
            # cost = total_before - total_after + fees (fees are value that came back to wallet)
            # But fees are ALREADY in final_value (they go to wallet), so:
            # cost = (initial_value + position_value_usd) - (final_value + new_pos_value)
            result.whole_rebalance_cost_usd = (initial_value + position_value_usd) - (final_value + new_pos_value)

            logger.info(f"  Whole-rebalance cost (single measurement): ${result.whole_rebalance_cost_usd:.4f}")
            logger.info(f"    Before: wallet=${initial_value:.2f} + position=${position_value_usd:.2f} = ${initial_value + position_value_usd:.2f}")
            logger.info(f"    After:  wallet=${final_value:.2f} + position=${new_pos_value:.2f} = ${final_value + new_pos_value:.2f}")
            logger.info(f"    Fees collected (in wallet): ${fees_collected_value:.4f}")

            # Cross-check: compare whole-rebalance cost to sum of per-operation costs
            if result.total_actual_cost:
                per_op_total = result.total_actual_cost.actual_cost_usd
                discrepancy = abs(result.whole_rebalance_cost_usd - per_op_total)
                if discrepancy > 1.0:
                    logger.warning(
                        f"  Cost measurement discrepancy: whole=${result.whole_rebalance_cost_usd:.4f} vs "
                        f"per-op=${per_op_total:.4f} (diff=${discrepancy:.4f})"
                    )
                else:
                    logger.info(f"  Cost cross-check OK: diff=${discrepancy:.4f}")

        # Warn if calculated fees seem unusual (for investigation, not for correction)
        if result.total_tx_fees_sol < 0:
            logger.warning(f"  UNUSUAL: Negative calculated fees ({result.total_tx_fees_sol:.6f}) - investigate")
        elif result.total_tx_fees_sol > 0.1:
            logger.warning(f"  UNUSUAL: High calculated fees ({result.total_tx_fees_sol:.6f}) - investigate")

        if open_result and open_result.success:
            logger.info(f"New position opened: {open_result.position_address}")
        else:
            logger.error(f"FAILED to open new position after {result.open_attempts} attempts!")
            if result.open_errors:
                logger.error(f"  Errors: {result.open_errors}")

        return result


# ============================================================
# UTILITY FUNCTIONS
# ============================================================

def tick_to_sqrt_price(tick: int) -> int:
    """
    Convert tick index to sqrt price in Q64.64 fixed-point format.

    Args:
        tick: Tick index

    Returns:
        Sqrt price as Q64.64 fixed-point integer
    """
    return int(math.pow(1.0001, tick / 2) * Q64)


def sqrt_price_to_tick(sqrt_price: int) -> int:
    """
    Convert Q64.64 sqrt price back to tick index.

    This is the inverse of tick_to_sqrt_price().

    Args:
        sqrt_price: Sqrt price in Q64.64 format

    Returns:
        Tick index (not aligned to spacing)
    """
    # sqrt_price = 1.0001^(tick/2) * Q64
    # sqrt_price / Q64 = 1.0001^(tick/2)
    # log(sqrt_price/Q64) / log(1.0001) = tick/2
    # tick = 2 * log(sqrt_price/Q64) / log(1.0001)
    if sqrt_price <= 0:
        return -443636
    ratio = sqrt_price / Q64
    if ratio <= 0:
        return -443636
    tick = 2 * math.log(ratio) / math.log(1.0001)
    return int(tick)


def calculate_safe_tick_range_from_sqrt_price(
    sqrt_price_current: int,
    tick_spacing: int,
    range_width_pct: float = 0.04,
) -> Tuple[int, int]:
    """
    Calculate a tick range that is GUARANTEED to contain the current price.

    This function derives the tick range directly from the on-chain sqrt_price,
    ensuring there is no discrepancy between the price used for range calculation
    and the price the Whirlpool contract will use.

    CRITICAL: This prevents TokenMaxExceeded errors caused by price being
    outside the calculated range due to:
    1. Stale prices from external APIs (Birdeye)
    2. Price movement between calculation and execution
    3. Rounding differences between our math and on-chain math

    Args:
        sqrt_price_current: Exact sqrt price from pool state (Q64.64 format)
        tick_spacing: Pool tick spacing (must match on-chain)
        range_width_pct: Desired range width as decimal (0.04 = 4%)

    Returns:
        Tuple of (lower_tick, upper_tick), both aligned to tick_spacing
    """
    # CENTERED APPROACH FOR OPTIMAL RANGE CALCULATION
    # ================================================
    # This approach centers the range on the current tick, providing:
    # 1. Consistent range widths regardless of price position within tick boundaries
    # 2. Balanced token distribution (price near center of range)
    # 3. Minimum overhead from tick_spacing alignment
    #
    # Algorithm:
    # 1. Calculate the exact tick span needed for the target range width
    # 2. Round up to the nearest multiple of tick_spacing
    # 3. Center this span on the current tick (aligned to tick_spacing)
    # 4. Safety check to ensure current tick is in range

    # Convert sqrt_price to raw tick (not aligned)
    current_tick_raw = sqrt_price_to_tick(sqrt_price_current)

    # Step 1: Calculate exact tick span for target range width
    # Range width as a price ratio: price_upper / price_lower = 1 + range_width_pct
    # Since price = 1.0001^tick, we have: 1.0001^(tick_span) = 1 + range_width_pct
    # Therefore: tick_span = log(1 + range_width_pct) / log(1.0001)
    price_ratio = 1 + range_width_pct
    raw_tick_span = math.log(price_ratio) / math.log(1.0001)

    # Step 2: Round up to multiple of tick_spacing
    # This is the minimum number of tick_spacings needed to cover the target range
    num_tick_spacings = math.ceil(raw_tick_span / tick_spacing)

    # Step 3: Center the range on current tick
    # First, align current tick to tick_spacing (floor)
    current_tick_aligned = (current_tick_raw // tick_spacing) * tick_spacing

    # Distribute tick_spacings evenly below and above current tick
    # For odd num_tick_spacings, put the extra one above (upper bound)
    lower_spacings = num_tick_spacings // 2
    upper_spacings = num_tick_spacings - lower_spacings

    lower_tick = current_tick_aligned - (lower_spacings * tick_spacing)
    upper_tick = current_tick_aligned + (upper_spacings * tick_spacing)

    # Step 4: Safety check - ensure current tick is actually in range
    # Due to the floor alignment, current_tick_raw might be slightly above current_tick_aligned
    # Edge case: if current_tick_raw is very close to but below lower_tick, expand down
    # Edge case: if current_tick_raw is >= upper_tick, expand up
    if current_tick_raw < lower_tick:
        logger.warning(
            f"Centered range edge case (below): current_tick_raw={current_tick_raw} < "
            f"lower_tick={lower_tick}. Expanding range down."
        )
        lower_tick -= tick_spacing
    elif current_tick_raw >= upper_tick:
        logger.warning(
            f"Centered range edge case (above): current_tick_raw={current_tick_raw} >= "
            f"upper_tick={upper_tick}. Expanding range up."
        )
        upper_tick += tick_spacing

    # Final validation
    if upper_tick <= lower_tick:
        upper_tick = lower_tick + tick_spacing

    # Calculate actual range for logging
    actual_span = upper_tick - lower_tick
    actual_range_pct = (math.pow(1.0001, actual_span) - 1)
    overhead_pct = (actual_range_pct / range_width_pct - 1) * 100 if range_width_pct > 0 else 0

    # Calculate position within range (0% = at lower, 100% = at upper)
    position_in_range = ((current_tick_raw - lower_tick) / actual_span * 100) if actual_span > 0 else 50

    logger.info(f"Safe tick range (CENTERED approach):")
    logger.info(f"  sqrt_price: {sqrt_price_current}")
    logger.info(f"  current_tick_raw: {current_tick_raw}, aligned: {current_tick_aligned}")
    logger.info(f"  target_range_width: {range_width_pct*100:.2f}%")
    logger.info(f"  actual_range_width: {actual_range_pct*100:.2f}% (overhead: {overhead_pct:.1f}%)")
    logger.info(f"  tick_spacing: {tick_spacing}, raw_tick_span: {raw_tick_span:.1f}, aligned_span: {actual_span}")
    logger.info(f"  result: [{lower_tick}, {upper_tick}]")
    logger.info(f"  price position in range: {position_in_range:.1f}%")

    return lower_tick, upper_tick


def calculate_clmm_liquidity(
    lower_tick: int,
    upper_tick: int,
    sqrt_price_current: int,
    token_a_amount: float,  # SOL in native units (e.g., 0.14)
    token_b_amount: float,  # USDC in native units (e.g., 19.12)
    safety_factor: float = 0.99,  # Small buffer for rounding differences
) -> int:
    """
    Calculate CLMM liquidity from token amounts using Orca's Q64.64 sqrt price math.

    This matches Orca Whirlpool's liquidity calculation using Q64 fixed-point format.

    IMPORTANT: This function properly handles all three price scenarios:
    1. Price BELOW range: Only token A (SOL) is needed, liquidity from token A only
    2. Price ABOVE range: Only token B (USDC) is needed, liquidity from token B only
    3. Price IN range: Both tokens needed, use min(liq_from_a, liq_from_b)

    The sqrt_price_current MUST NOT be clamped - the actual price determines which
    formula to use, and the Whirlpool contract will use the same actual price.

    Args:
        lower_tick: Lower tick of the range
        upper_tick: Upper tick of the range
        sqrt_price_current: Current sqrt price from pool state (Q64.64 format integer)
        token_a_amount: Amount of token A (SOL) in native units
        token_b_amount: Amount of token B (USDC) in native units
        safety_factor: Reduce calculated liquidity by this factor (0.99 = 1% reduction)
                       Small buffer accounts for tick_to_sqrt_price rounding and timing

    Returns:
        Liquidity amount as integer (matching Orca's format)
    """
    from decimal import Decimal, getcontext
    getcontext().prec = 50  # High precision for large numbers

    # Convert token amounts to base units (lamports / micro-USDC)
    token_a_lamports = int(token_a_amount * 1e9)  # SOL -> lamports
    token_b_micro = int(token_b_amount * 1e6)     # USDC -> micro-USDC

    # Get sqrt prices in Q64.64 fixed-point format (matching Orca)
    sqrt_price_lower = tick_to_sqrt_price(lower_tick)
    sqrt_price_upper = tick_to_sqrt_price(upper_tick)

    # DO NOT CLAMP sqrt_price_current - we need the actual price to determine
    # which formula applies. The Whirlpool contract uses the real price.

    logger.info(f"CLMM liquidity calculation (Q64 math):")
    logger.info(f"  Token A (lamports): {token_a_lamports:,}")
    logger.info(f"  Token B (micro-USDC): {token_b_micro:,}")
    logger.info(f"  Sqrt prices (Q64): lower={sqrt_price_lower}, upper={sqrt_price_upper}, current={sqrt_price_current}")

    # Determine price position relative to range
    price_below_range = sqrt_price_current <= sqrt_price_lower
    price_above_range = sqrt_price_current >= sqrt_price_upper

    logger.info(f"  Price position: {'BELOW RANGE' if price_below_range else 'ABOVE RANGE' if price_above_range else 'IN RANGE'}")

    # CASE 1: Price is BELOW the range - only token A (SOL) is deposited
    if price_below_range:
        if token_a_lamports <= 0:
            logger.warning("Price below range but no token A (SOL) provided - cannot provide liquidity")
            return 0

        # L = amount_a * sqrt(P_lower) * sqrt(P_upper) / ((sqrt(P_upper) - sqrt(P_lower)) * Q64)
        sqrt_diff = sqrt_price_upper - sqrt_price_lower
        if sqrt_diff <= 0:
            logger.warning("Invalid tick range: sqrt_price_upper <= sqrt_price_lower")
            return 0

        numerator = Decimal(token_a_lamports) * Decimal(sqrt_price_lower) * Decimal(sqrt_price_upper)
        denominator = Decimal(sqrt_diff) * Decimal(Q64)
        raw_liquidity = int(numerator / denominator)

        logger.info(f"LIQUIDITY CALCULATION RESULTS (PRICE BELOW RANGE):")
        logger.info(f"  Only token A (SOL) used: {token_a_lamports:,} lamports")
        logger.info(f"  Token B (USDC) will be: 0 (not used when price below range)")
        logger.info(f"  Raw liquidity: {raw_liquidity:,}")

        liquidity = int(raw_liquidity * safety_factor)
        logger.info(f"  Final liquidity: {liquidity:,} (with {safety_factor*100:.0f}% safety factor)")
        return liquidity

    # CASE 2: Price is ABOVE the range - only token B (USDC) is deposited
    if price_above_range:
        if token_b_micro <= 0:
            logger.warning("Price above range but no token B (USDC) provided - cannot provide liquidity")
            return 0

        # L = amount_b * Q64 / (sqrt(P_upper) - sqrt(P_lower))
        sqrt_diff = sqrt_price_upper - sqrt_price_lower
        if sqrt_diff <= 0:
            logger.warning("Invalid tick range: sqrt_price_upper <= sqrt_price_lower")
            return 0

        numerator = Decimal(token_b_micro) * Decimal(Q64)
        denominator = Decimal(sqrt_diff)
        raw_liquidity = int(numerator / denominator)

        logger.info(f"LIQUIDITY CALCULATION RESULTS (PRICE ABOVE RANGE):")
        logger.info(f"  Only token B (USDC) used: {token_b_micro:,} micro-USDC")
        logger.info(f"  Token A (SOL) will be: 0 (not used when price above range)")
        logger.info(f"  Raw liquidity: {raw_liquidity:,}")

        liquidity = int(raw_liquidity * safety_factor)
        logger.info(f"  Final liquidity: {liquidity:,} (with {safety_factor*100:.0f}% safety factor)")
        return liquidity

    # CASE 3: Price is IN RANGE - both tokens are deposited
    # Calculate liquidity from each token and take the minimum (limiting factor)
    liq_from_a = 0
    liq_from_b = 0

    if token_a_lamports > 0:
        # L = amount_a * sqrt(P_current) * sqrt(P_upper) / ((sqrt(P_upper) - sqrt(P_current)) * Q64)
        sqrt_diff_upper = sqrt_price_upper - sqrt_price_current
        if sqrt_diff_upper > 0:
            numerator = Decimal(token_a_lamports) * Decimal(sqrt_price_current) * Decimal(sqrt_price_upper)
            denominator = Decimal(sqrt_diff_upper) * Decimal(Q64)
            liq_from_a = int(numerator / denominator)

    if token_b_micro > 0:
        # L = amount_b * Q64 / (sqrt(P_current) - sqrt(P_lower))
        sqrt_diff_lower = sqrt_price_current - sqrt_price_lower
        if sqrt_diff_lower > 0:
            numerator = Decimal(token_b_micro) * Decimal(Q64)
            denominator = Decimal(sqrt_diff_lower)
            liq_from_b = int(numerator / denominator)

    # Take the minimum (limiting factor) to avoid TokenMaxExceeded error
    if liq_from_a == 0 and liq_from_b == 0:
        logger.warning("Could not calculate liquidity - no valid token contribution")
        return 0

    if liq_from_a > 0 and liq_from_b > 0:
        raw_liquidity = min(liq_from_a, liq_from_b)
        limiting = 'SOL' if liq_from_a <= liq_from_b else 'USDC'
        utilization_pct = min(liq_from_a, liq_from_b) / max(liq_from_a, liq_from_b) * 100
    elif liq_from_a > 0:
        raw_liquidity = liq_from_a
        limiting = 'SOL'
        utilization_pct = 100.0
    else:
        raw_liquidity = liq_from_b
        limiting = 'USDC'
        utilization_pct = 100.0

    # Apply small safety factor to account for:
    # 1. Rounding in tick_to_sqrt_price() vs on-chain tick boundaries
    # 2. Any price movement between fetching pool state and transaction execution
    liquidity = int(raw_liquidity * safety_factor)

    logger.info(f"LIQUIDITY CALCULATION RESULTS (PRICE IN RANGE):")
    logger.info(f"  Liquidity from SOL: {liq_from_a:,}")
    logger.info(f"  Liquidity from USDC: {liq_from_b:,}")
    logger.info(f"  Ratio (liq_a/liq_b): {liq_from_a/liq_from_b:.3f}" if liq_from_b > 0 else f"  Ratio: N/A (liq_b=0)")
    logger.info(f"  Limiting factor: {limiting}")
    logger.info(f"  Utilization: {utilization_pct:.1f}% of non-limiting token")
    logger.info(f"  Raw liquidity: {raw_liquidity:,}")
    logger.info(f"  Final liquidity: {liquidity:,} (with {safety_factor*100:.0f}% safety factor)")

    return liquidity


def tick_to_price(tick: int, decimal_adjustment: int = 3) -> float:
    """Convert tick index to price."""
    raw_price = math.pow(1.0001, tick)
    return raw_price * (10 ** decimal_adjustment)


def price_to_tick(price: float, tick_spacing: int, decimal_adjustment: int = 3) -> int:
    """
    Convert price to tick index, aligned to tick spacing.

    IMPORTANT: tick_spacing MUST match the pool's actual tick spacing.
    Different fee tiers have different tick spacings:
    - 0.01% fee tier: tick_spacing = 1
    - 0.05% fee tier: tick_spacing = 8  (NOT commonly used for SOL/USDC)
    - 0.30% fee tier: tick_spacing = 64 (SOL/USDC pool HJPjoWUrhoZzkNfRpHuieeFk9WcZWjwy6PBjZ81ngndJ)
    - 1.00% fee tier: tick_spacing = 128

    Args:
        price: Price in USD
        tick_spacing: Pool tick spacing (MUST be fetched from pool state)
        decimal_adjustment: Decimal adjustment for token pair (3 for SOL/USDC)

    Returns:
        Tick index aligned to tick_spacing
    """
    if tick_spacing <= 0:
        raise ValueError(f"Invalid tick_spacing: {tick_spacing}. Must be positive integer.")
    if price <= 0:
        return -443636
    raw_price = price / (10 ** decimal_adjustment)
    tick = int(math.log(raw_price) / math.log(1.0001))
    # Align to tick spacing (floor division to get lower bound)
    aligned_tick = (tick // tick_spacing) * tick_spacing
    logger.debug(f"price_to_tick: price=${price:.4f} -> raw_tick={tick} -> aligned_tick={aligned_tick} (spacing={tick_spacing})")
    return aligned_tick


def calculate_range(
    current_price: float,
    range_span_pct: float,
    tick_spacing: int,
) -> Tuple[int, int, float, float]:
    """
    Calculate tick range for a position.

    IMPORTANT: tick_spacing MUST match the pool's actual tick spacing.
    Fetch it from pool state using get_pool_tick_spacing() or pool_state.tick_spacing.

    Args:
        current_price: Current market price
        range_span_pct: Total range span as decimal (e.g., 0.02 = 2%)
        tick_spacing: Pool tick spacing (MUST be fetched from pool state)

    Returns:
        (lower_tick, upper_tick, actual_lower_price, actual_upper_price)
    """
    if tick_spacing <= 0:
        raise ValueError(f"Invalid tick_spacing: {tick_spacing}. Must be positive integer.")

    half_span = range_span_pct / 2

    lower_price = current_price * (1 - half_span)
    upper_price = current_price * (1 + half_span)

    lower_tick = price_to_tick(lower_price, tick_spacing)
    upper_tick = price_to_tick(upper_price, tick_spacing)

    # Ensure upper_tick is strictly greater than lower_tick
    # If they're equal due to narrow range, bump upper_tick by one tick_spacing
    if upper_tick <= lower_tick:
        upper_tick = lower_tick + tick_spacing
        logger.warning(f"Range too narrow, adjusting upper_tick: {lower_tick} -> {upper_tick}")

    actual_lower = tick_to_price(lower_tick)
    actual_upper = tick_to_price(upper_tick)

    logger.info(f"Range calculation: price=${current_price:.2f}, span={range_span_pct*100:.1f}%")
    logger.info(f"  Ticks: [{lower_tick}, {upper_tick}] (spacing={tick_spacing})")
    logger.info(f"  Prices: ${actual_lower:.2f} - ${actual_upper:.2f}")

    # Validate ticks are properly aligned
    if lower_tick % tick_spacing != 0:
        raise ValueError(f"lower_tick {lower_tick} not aligned to tick_spacing {tick_spacing}")
    if upper_tick % tick_spacing != 0:
        raise ValueError(f"upper_tick {upper_tick} not aligned to tick_spacing {tick_spacing}")

    return lower_tick, upper_tick, actual_lower, actual_upper


def calculate_liquidity_from_amounts(
    sqrt_price_current: int,
    lower_tick: int,
    upper_tick: int,
    token_a_amount: int,
    token_b_amount: int,
) -> int:
    """
    Calculate liquidity amount from token deposits for Orca Whirlpool CLMM.

    This implements the proper concentrated liquidity math based on the
    Uniswap V3 / Orca Whirlpool formulas.

    For concentrated liquidity:
    - When price < lower_tick: only token A (SOL) is deposited
      L = amount_a * sqrt(P_lower) * sqrt(P_upper) / (sqrt(P_upper) - sqrt(P_lower)) / Q64

    - When price > upper_tick: only token B (USDC) is deposited
      L = amount_b * Q64 / (sqrt(P_upper) - sqrt(P_lower))

    - When lower_tick <= price <= upper_tick: both tokens are deposited
      L_a = amount_a * sqrt(P_current) * sqrt(P_upper) / ((sqrt(P_upper) - sqrt(P_current)) * Q64)
      L_b = amount_b * Q64 / (sqrt(P_current) - sqrt(P_lower))
      L = min(L_a, L_b)  # Use minimum to avoid over-depositing

    Args:
        sqrt_price_current: Current sqrt price from pool state (Q64.64 format)
        lower_tick: Lower tick of the position
        upper_tick: Upper tick of the position
        token_a_amount: Amount of token A in smallest units (lamports for SOL)
        token_b_amount: Amount of token B in smallest units (micro-USDC)

    Returns:
        Liquidity amount as integer
    """
    from decimal import Decimal, getcontext
    getcontext().prec = 50  # High precision for large numbers

    # Convert tick indices to sqrt prices (Q64.64 format)
    sqrt_price_lower = tick_to_sqrt_price(lower_tick)
    sqrt_price_upper = tick_to_sqrt_price(upper_tick)

    # Validate tick range
    if sqrt_price_upper <= sqrt_price_lower:
        logger.warning(
            f"Invalid tick range: lower={lower_tick}, upper={upper_tick}, "
            f"sqrt_lower={sqrt_price_lower}, sqrt_upper={sqrt_price_upper}"
        )
        return 0

    logger.debug(
        f"calculate_liquidity_from_amounts: "
        f"sqrt_current={sqrt_price_current}, sqrt_lower={sqrt_price_lower}, "
        f"sqrt_upper={sqrt_price_upper}, token_a={token_a_amount}, token_b={token_b_amount}"
    )

    # Case 1: Current price is below the range (all tokens will be token A)
    if sqrt_price_current <= sqrt_price_lower:
        if token_a_amount == 0:
            logger.debug("Price below range but no token A provided")
            return 0

        # L = amount_a * sqrt(P_lower) * sqrt(P_upper) / (sqrt(P_upper) - sqrt(P_lower)) / Q64
        numerator = Decimal(token_a_amount) * Decimal(sqrt_price_lower) * Decimal(sqrt_price_upper)
        denominator = Decimal(sqrt_price_upper - sqrt_price_lower) * Decimal(Q64)

        if denominator == 0:
            return 0

        liquidity = int(numerator / denominator)
        logger.info(f"Liquidity (price below range): {liquidity:,} from {token_a_amount} token_a")
        return max(liquidity, 0)

    # Case 2: Current price is above the range (all tokens will be token B)
    elif sqrt_price_current >= sqrt_price_upper:
        if token_b_amount == 0:
            logger.debug("Price above range but no token B provided")
            return 0

        # L = amount_b * Q64 / (sqrt(P_upper) - sqrt(P_lower))
        numerator = Decimal(token_b_amount) * Decimal(Q64)
        denominator = Decimal(sqrt_price_upper - sqrt_price_lower)

        if denominator == 0:
            return 0

        liquidity = int(numerator / denominator)
        logger.info(f"Liquidity (price above range): {liquidity:,} from {token_b_amount} token_b")
        return max(liquidity, 0)

    # Case 3: Current price is within the range (both tokens will be used)
    else:
        liq_a = 0
        liq_b = 0

        if token_a_amount > 0:
            # L_a = amount_a * sqrt(P_current) * sqrt(P_upper) / ((sqrt(P_upper) - sqrt(P_current)) * Q64)
            sqrt_diff_upper = sqrt_price_upper - sqrt_price_current
            if sqrt_diff_upper > 0:
                numerator = Decimal(token_a_amount) * Decimal(sqrt_price_current) * Decimal(sqrt_price_upper)
                denominator = Decimal(sqrt_diff_upper) * Decimal(Q64)
                liq_a = int(numerator / denominator)

        if token_b_amount > 0:
            # L_b = amount_b * Q64 / (sqrt(P_current) - sqrt(P_lower))
            sqrt_diff_lower = sqrt_price_current - sqrt_price_lower
            if sqrt_diff_lower > 0:
                numerator = Decimal(token_b_amount) * Decimal(Q64)
                denominator = Decimal(sqrt_diff_lower)
                liq_b = int(numerator / denominator)

        logger.debug(
            f"Liquidity calculation (in range): "
            f"liq_a={liq_a:,}, liq_b={liq_b:,}, token_a={token_a_amount}, token_b={token_b_amount}"
        )

        # Use minimum of both to avoid over-depositing one token
        if liq_a > 0 and liq_b > 0:
            liquidity = min(liq_a, liq_b)
            logger.info(f"Liquidity (in range, both tokens): {liquidity:,} (min of {liq_a:,} and {liq_b:,})")
        elif liq_a > 0:
            liquidity = liq_a
            logger.info(f"Liquidity (in range, token A only): {liquidity:,}")
        elif liq_b > 0:
            liquidity = liq_b
            logger.info(f"Liquidity (in range, token B only): {liquidity:,}")
        else:
            logger.warning("Could not calculate liquidity - both liq_a and liq_b are 0")
            return 0

        return max(liquidity, 0)


def estimate_amounts_from_liquidity(
    sqrt_price_current: int,
    lower_tick: int,
    upper_tick: int,
    liquidity: int,
) -> Tuple[int, int]:
    """
    Estimate token amounts that would be held by a position with given liquidity.

    This is the inverse of calculate_liquidity_from_amounts().
    Used for verifying position values after opening.

    Args:
        sqrt_price_current: Current sqrt price from pool state (Q64.64 format)
        lower_tick: Lower tick of the position
        upper_tick: Upper tick of the position
        liquidity: Liquidity amount

    Returns:
        Tuple of (token_a_amount, token_b_amount) in smallest units
    """
    from decimal import Decimal, getcontext
    getcontext().prec = 50

    sqrt_price_lower = tick_to_sqrt_price(lower_tick)
    sqrt_price_upper = tick_to_sqrt_price(upper_tick)

    if liquidity == 0:
        return (0, 0)

    # Case 1: Price below range - all token A
    if sqrt_price_current <= sqrt_price_lower:
        # amount_a = L * (sqrt(P_upper) - sqrt(P_lower)) * Q64 / (sqrt(P_lower) * sqrt(P_upper))
        numerator = Decimal(liquidity) * Decimal(sqrt_price_upper - sqrt_price_lower) * Decimal(Q64)
        denominator = Decimal(sqrt_price_lower) * Decimal(sqrt_price_upper)
        amount_a = int(numerator / denominator) if denominator > 0 else 0
        return (amount_a, 0)

    # Case 2: Price above range - all token B
    elif sqrt_price_current >= sqrt_price_upper:
        # amount_b = L * (sqrt(P_upper) - sqrt(P_lower)) / Q64
        amount_b = int(Decimal(liquidity) * Decimal(sqrt_price_upper - sqrt_price_lower) / Decimal(Q64))
        return (0, amount_b)

    # Case 3: Price in range - both tokens
    else:
        # amount_a = L * (sqrt(P_upper) - sqrt(P_current)) * Q64 / (sqrt(P_current) * sqrt(P_upper))
        numerator_a = Decimal(liquidity) * Decimal(sqrt_price_upper - sqrt_price_current) * Decimal(Q64)
        denominator_a = Decimal(sqrt_price_current) * Decimal(sqrt_price_upper)
        amount_a = int(numerator_a / denominator_a) if denominator_a > 0 else 0

        # amount_b = L * (sqrt(P_current) - sqrt(P_lower)) / Q64
        amount_b = int(Decimal(liquidity) * Decimal(sqrt_price_current - sqrt_price_lower) / Decimal(Q64))

        return (amount_a, amount_b)


# ============================================================
# MODULE INITIALIZATION
# ============================================================

_trade_executor: Optional[TradeExecutor] = None


async def get_trade_executor(config: Config = None) -> TradeExecutor:
    """Get or create global trade executor."""
    global _trade_executor

    if _trade_executor is None:
        _trade_executor = TradeExecutor(config)
        await _trade_executor.initialize()

    return _trade_executor


def reset_trade_executor() -> None:
    """Reset global trade executor."""
    global _trade_executor
    _trade_executor = None
