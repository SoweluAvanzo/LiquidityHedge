#!/usr/bin/env python3
"""
Production-Matched Swap and Position Cost Analysis Script

This script measures the actual costs matching PRODUCTION configuration:
1. Uses the SAME pool as production (4 bps fee pool)
2. Uses the SAME slippage settings (15 bps base)
3. Tests full rebalance cycle (close -> wSOL cleanup -> swap -> open)
4. Includes wSOL cleanup costs

LIVE TRADING ONLY - No dry run mode.

Usage:
    python test_swap_costs_production.py
"""

import asyncio
import math
import os
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal
from pathlib import Path
from typing import Optional, List, Dict, Any, Tuple

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent))
sys.path.insert(0, str(Path(__file__).parent.parent))

import httpx
import base58
from dotenv import load_dotenv
from solders.keypair import Keypair
from solders.pubkey import Pubkey

# Load environment variables
load_dotenv()

# Token mints
SOL_MINT = "So11111111111111111111111111111111111111112"
USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"

# ============================================================================
# PRODUCTION-MATCHED CONFIGURATION
# ============================================================================
# Use the SAME pool as production (4 bps fee pool, tick_spacing=4)
SOL_USDC_POOL = "Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE"

# Use production RPC
RPC_URL = os.getenv("SOLANA_RPC_URL", "https://api.mainnet-beta.solana.com")
WALLET_KEY = os.getenv("WALLET_PRIVATE_KEY_BASE58")
JUPITER_API_KEY = os.getenv("JUPITER_API_KEY", "63dadbb1-483c-409d-9205-84c9935af09d")

# Test amounts in USD
TEST_AMOUNTS_USD = [50.0, 200.0]  # Skip $5 - too small for meaningful cost analysis

# ============================================================================
# PRODUCTION-MATCHED SLIPPAGE SETTINGS
# ============================================================================
# These match fly.toml and fly-instance2.toml settings
SWAP_SLIPPAGE_BPS = 15  # Instance 1: 15 bps, Instance 2: 20 bps
POSITION_SLIPPAGE_BPS = 15  # SLIPPAGE_BPS setting

# Progressive slippage schedule (from execution.py - UPDATED 2025)
# New conservative schedule: max +50 bps added to base, capped at 100 bps total
PROGRESSIVE_SLIPPAGE_SCHEDULE = [0, 15, 30, 45, 50]  # Added on retries (max +50 bps)
MAX_SLIPPAGE_BPS_CAP = 100  # Hard cap at 1.0% (was 800 bps / 8%)

# Whether to use Ultra API (production uses Ultra)
USE_ULTRA_API = True

# Orca constants
Q64 = 2**64
DEFAULT_TICK_SPACING = 4  # For 4 bps fee pool


@dataclass
class WalletState:
    """Snapshot of wallet balances."""
    sol_balance: float  # Native SOL
    usdc_balance: float
    wsol_balance: float  # Wrapped SOL (separate)
    sol_price: float
    timestamp: datetime = field(default_factory=datetime.utcnow)

    @property
    def total_value_usd(self) -> float:
        """Total wallet value in USD (including wSOL)."""
        return ((self.sol_balance + self.wsol_balance) * self.sol_price) + self.usdc_balance

    def __str__(self) -> str:
        wsol_str = f", wSOL: {self.wsol_balance:.6f}" if self.wsol_balance > 0.0001 else ""
        return (f"SOL: {self.sol_balance:.6f} (${self.sol_balance * self.sol_price:.2f}){wsol_str}, "
                f"USDC: ${self.usdc_balance:.2f}, Total: ${self.total_value_usd:.2f}")


@dataclass
class TestResult:
    """Result of a single test."""
    test_name: str
    operation_type: str  # 'swap', 'position_open', 'position_close', 'wsol_cleanup', 'rebalance_cycle'
    amount_usd: float

    # Costs
    wallet_value_before: float
    wallet_value_after: float
    total_cost_usd: float
    cost_percentage: float

    # Timing
    execution_time_ms: int

    # Transaction details
    signature: Optional[str] = None
    success: bool = True
    error: Optional[str] = None

    # Operation-specific metadata
    metadata: Dict[str, Any] = field(default_factory=dict)


class SolanaRPCClient:
    """Simple Solana RPC client for balance queries."""

    def __init__(self, rpc_url: str):
        self.rpc_url = rpc_url
        self._request_id = 0

    async def _rpc_call(self, method: str, params: List = None) -> Any:
        """Make an RPC call."""
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

    async def get_sol_balance(self, pubkey: str) -> float:
        """Get SOL balance in SOL (not lamports)."""
        result = await self._rpc_call("getBalance", [pubkey, {"commitment": "confirmed"}])
        lamports = result.get("value", 0)
        return lamports / 1e9

    async def get_token_balance(self, owner: str, mint: str) -> float:
        """Get SPL token balance."""
        result = await self._rpc_call("getTokenAccountsByOwner", [
            owner,
            {"mint": mint},
            {"encoding": "jsonParsed", "commitment": "confirmed"}
        ])

        accounts = result.get("value", [])
        total = 0.0
        for acc in accounts:
            parsed = acc.get("account", {}).get("data", {}).get("parsed", {})
            info = parsed.get("info", {})
            token_amount = info.get("tokenAmount", {})
            total += float(token_amount.get("uiAmount", 0) or 0)

        return total

    async def get_wsol_balance(self, owner: str) -> float:
        """Get wSOL balance specifically."""
        return await self.get_token_balance(owner, SOL_MINT)


class JupiterPriceClient:
    """Client to get SOL price from Jupiter."""

    def __init__(self, api_key: str = ""):
        self.api_key = api_key
        self.base_url = "https://api.jup.ag"

    async def get_sol_price(self) -> float:
        """Get current SOL price in USDC."""
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["x-api-key"] = self.api_key

        async with httpx.AsyncClient(timeout=30.0, headers=headers) as client:
            params = {
                "inputMint": SOL_MINT,
                "outputMint": USDC_MINT,
                "amount": str(int(1e9)),  # 1 SOL
                "slippageBps": 50,
            }
            resp = await client.get(f"{self.base_url}/swap/v1/quote", params=params)
            resp.raise_for_status()
            data = resp.json()

            in_amount = int(data["inAmount"])
            out_amount = int(data["outAmount"])

            price = (out_amount / 1e6) / (in_amount / 1e9)
            return price


class JupiterSwapClient:
    """Jupiter Swap API client (standard v1 endpoint)."""

    def __init__(self, api_key: str, rpc_url: str):
        self.api_key = api_key
        self.rpc_url = rpc_url
        self.base_url = "https://api.jup.ag"

    async def get_quote(
        self,
        input_mint: str,
        output_mint: str,
        amount: int,
        slippage_bps: int = 15,
    ) -> Dict[str, Any]:
        """Get a swap quote."""
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["x-api-key"] = self.api_key

        params = {
            "inputMint": input_mint,
            "outputMint": output_mint,
            "amount": str(amount),
            "slippageBps": slippage_bps,
            "onlyDirectRoutes": True,  # Match production setting
            "maxAccounts": 20,  # Match production setting
        }

        async with httpx.AsyncClient(timeout=30.0, headers=headers) as client:
            resp = await client.get(f"{self.base_url}/swap/v1/quote", params=params)
            resp.raise_for_status()
            return resp.json()

    async def execute_swap(
        self,
        input_mint: str,
        output_mint: str,
        amount: int,
        keypair: Keypair,
        slippage_bps: int = 15,
    ) -> Tuple[bool, Optional[str], int, int, Optional[str]]:
        """Execute a swap via Jupiter Swap API."""
        from solders.transaction import VersionedTransaction
        import base64

        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["x-api-key"] = self.api_key

        async with httpx.AsyncClient(timeout=60.0, headers=headers) as client:
            quote = await self.get_quote(input_mint, output_mint, amount, slippage_bps)
            in_amount = int(quote["inAmount"])
            out_amount = int(quote["outAmount"])

            swap_payload = {
                "quoteResponse": quote,
                "userPublicKey": str(keypair.pubkey()),
                "wrapAndUnwrapSol": True,
            }

            resp = await client.post(f"{self.base_url}/swap/v1/swap", json=swap_payload)
            resp.raise_for_status()
            swap_data = resp.json()

            tx_bytes = base64.b64decode(swap_data["swapTransaction"])
            tx = VersionedTransaction.from_bytes(tx_bytes)
            signed_tx = VersionedTransaction(tx.message, [keypair])

            send_payload = {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "sendTransaction",
                "params": [
                    base64.b64encode(bytes(signed_tx)).decode("utf-8"),
                    {"encoding": "base64", "skipPreflight": False, "preflightCommitment": "confirmed"}
                ]
            }

            async with httpx.AsyncClient(timeout=60.0) as rpc_client:
                rpc_resp = await rpc_client.post(self.rpc_url, json=send_payload)
                rpc_data = rpc_resp.json()

                if "error" in rpc_data:
                    return False, None, in_amount, out_amount, str(rpc_data["error"])

                signature = rpc_data["result"]
                confirmed = await self._confirm_transaction(signature)
                return confirmed, signature, in_amount, out_amount, None

    async def _confirm_transaction(self, signature: str, timeout: int = 60) -> bool:
        """Wait for transaction confirmation."""
        start = time.time()
        while time.time() - start < timeout:
            payload = {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "getSignatureStatuses",
                "params": [[signature], {"searchTransactionHistory": True}]
            }
            async with httpx.AsyncClient(timeout=30.0) as client:
                resp = await client.post(self.rpc_url, json=payload)
                data = resp.json()
                statuses = data.get("result", {}).get("value", [])
                if statuses and statuses[0]:
                    status = statuses[0]
                    if status.get("confirmationStatus") in ["confirmed", "finalized"]:
                        return status.get("err") is None
            await asyncio.sleep(1)
        return False


class JupiterUltraClient:
    """Jupiter Ultra API client."""

    ULTRA_BASE_URL = "https://api.jup.ag/ultra/v1"

    def __init__(self, api_key: str, rpc_url: str):
        self.api_key = api_key
        self.rpc_url = rpc_url

    async def execute_swap(
        self,
        input_mint: str,
        output_mint: str,
        amount: int,
        keypair: Keypair,
        slippage_bps: int = 15,
    ) -> Tuple[bool, Optional[str], int, int, Optional[str], Dict[str, Any]]:
        """Execute a swap via Jupiter Ultra API."""
        from solders.transaction import VersionedTransaction
        import base64

        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["x-api-key"] = self.api_key

        metadata = {}

        async with httpx.AsyncClient(timeout=60.0, headers=headers) as client:
            params = {
                "inputMint": input_mint,
                "outputMint": output_mint,
                "amount": str(amount),
                "taker": str(keypair.pubkey()),
                "slippageBps": slippage_bps,
            }

            order_resp = await client.get(f"{self.ULTRA_BASE_URL}/order", params=params)
            order_resp.raise_for_status()
            order_data = order_resp.json()

            if order_data.get("transaction") is None:
                error_msg = order_data.get("errorMessage", "No transaction returned")
                return False, None, amount, 0, error_msg, metadata

            in_amount = amount
            out_amount = int(order_data["outAmount"])
            request_id = order_data["requestId"]

            metadata = {
                "request_id": request_id,
                "gasless": order_data.get("gasless", False),
                "router": order_data.get("router", "unknown"),
                "fee_bps": order_data.get("feeBps", 0),
            }

            tx_bytes = base64.b64decode(order_data["transaction"])
            tx = VersionedTransaction.from_bytes(tx_bytes)
            signed_tx = VersionedTransaction(tx.message, [keypair])
            signed_tx_bytes = bytes(signed_tx)

            execute_payload = {
                "signedTransaction": base64.b64encode(signed_tx_bytes).decode("utf-8"),
                "requestId": request_id,
            }

            exec_resp = await client.post(f"{self.ULTRA_BASE_URL}/execute", json=execute_payload)
            exec_resp.raise_for_status()
            exec_data = exec_resp.json()

            status = exec_data.get("status", "unknown")
            signature = exec_data.get("signature")

            if status == "Success":
                actual_out = int(exec_data.get("outputAmountResult", out_amount))
                return True, signature, in_amount, actual_out, None, metadata
            else:
                error_msg = f"Status: {status} - {exec_data.get('error', 'unknown')}"
                return False, signature, in_amount, out_amount, error_msg, metadata


class OrcaPositionTester:
    """Test Orca position operations using the existing bot infrastructure."""

    def __init__(self, rpc_url: str, keypair: Keypair, pool_address: str):
        self.rpc_url = rpc_url
        self.keypair = keypair
        self.pool_address = pool_address
        self._orca_client = None
        self._solana_client = None

    async def initialize(self):
        """Initialize Orca and Solana clients."""
        from app.chain.orca_client import OrcaClient
        from app.chain.solana_client import SolanaClient

        self._solana_client = SolanaClient(rpc_url=self.rpc_url)
        await self._solana_client.connect()
        self._solana_client._wallet = self.keypair

        self._orca_client = OrcaClient(solana_client=self._solana_client)
        print(f"Initialized Orca client for pool: {self.pool_address}")
        print(f"Pool: 4 bps fee pool (production config)")

    async def get_pool_state(self):
        """Get current pool state."""
        return await self._orca_client.get_pool_state(self.pool_address, force_refresh=True)

    async def cleanup_wsol(self) -> Tuple[bool, float, Optional[str]]:
        """
        Cleanup wSOL accounts.
        Returns: (success, sol_recovered, signature)
        """
        try:
            from app.chain.wsol_cleanup import get_wsol_cleanup_manager, get_wsol_balance

            wsol_balance = await get_wsol_balance()
            if wsol_balance < 0.001:
                return True, 0.0, None

            print(f"  Found {wsol_balance:.6f} wSOL to cleanup...")
            cleanup_manager = await get_wsol_cleanup_manager()
            result = await cleanup_manager.cleanup_wsol_accounts()

            if result.success:
                sig = result.signatures[0] if result.signatures else None
                return True, result.total_sol_recovered, sig
            else:
                return False, 0.0, None

        except Exception as e:
            print(f"  wSOL cleanup error: {e}")
            return False, 0.0, None

    async def open_position(
        self,
        lower_price: float,
        upper_price: float,
        sol_amount: float,
        usdc_amount: float,
    ) -> Tuple[bool, Optional[str], Optional[str], Optional[str]]:
        """
        Open a position with specified range and amounts.

        Returns: (success, signature, position_address, error)
        """
        try:
            pool_state = await self.get_pool_state()

            # Calculate ticks from prices
            lower_tick = self._price_to_tick(lower_price, pool_state.tick_spacing)
            upper_tick = self._price_to_tick(upper_price, pool_state.tick_spacing)

            # Ensure ticks are properly ordered and aligned
            if lower_tick >= upper_tick:
                lower_tick = upper_tick - pool_state.tick_spacing

            # Convert amounts to raw
            token_max_a = int(sol_amount * 1e9)  # SOL
            token_max_b = int(usdc_amount * 1e6)  # USDC

            # Calculate liquidity from amounts
            liquidity = self._calculate_liquidity(
                pool_state.sqrt_price,
                lower_tick,
                upper_tick,
                token_max_a,
                token_max_b,
            )

            print(f"  Opening position: ticks [{lower_tick}, {upper_tick}]")
            print(f"  Price range: ${lower_price:.2f} - ${upper_price:.2f}")
            print(f"  Amounts: {sol_amount:.6f} SOL, ${usdc_amount:.2f} USDC")
            print(f"  Liquidity: {liquidity:,}")

            receipt = await self._orca_client.execute_open_position(
                pool_pubkey=self.pool_address,
                lower_tick=lower_tick,
                upper_tick=upper_tick,
                liquidity_amount=liquidity,
                token_max_a=token_max_a,
                token_max_b=token_max_b,
            )

            if receipt.is_success:
                position_address = receipt.metadata.get("position_address")
                return True, receipt.signature, position_address, None
            else:
                return False, receipt.signature, None, receipt.error

        except Exception as e:
            import traceback
            traceback.print_exc()
            return False, None, None, str(e)

    async def close_position(self, position_address: str) -> Tuple[bool, Optional[str], Optional[str]]:
        """
        Close a position.

        Returns: (success, signature, error)
        """
        try:
            print(f"  Closing position: {position_address}")

            receipt = await self._orca_client.execute_close_position(
                position_pubkey=position_address,
                collect_fees=True,
            )

            if receipt.is_success:
                return True, receipt.signature, None
            else:
                return False, receipt.signature, receipt.error

        except Exception as e:
            import traceback
            traceback.print_exc()
            return False, None, str(e)

    def _price_to_tick(self, price: float, tick_spacing: int) -> int:
        """Convert price to tick index."""
        if price <= 0:
            return -443636

        # Convert human-readable price to raw ratio
        raw_price = price / 1000
        tick = int(math.log(raw_price) / math.log(1.0001))
        # Round to tick spacing
        return (tick // tick_spacing) * tick_spacing

    def _calculate_liquidity(
        self,
        sqrt_price_current: int,
        lower_tick: int,
        upper_tick: int,
        token_max_a: int,
        token_max_b: int,
    ) -> int:
        """Calculate liquidity from token amounts."""
        sqrt_price_lower = self._tick_to_sqrt_price(lower_tick)
        sqrt_price_upper = self._tick_to_sqrt_price(upper_tick)

        # Calculate liquidity from both token amounts
        if sqrt_price_current <= sqrt_price_lower:
            # All token A
            if token_max_a == 0:
                return 0
            liquidity = int(token_max_a * (sqrt_price_lower * sqrt_price_upper) /
                           (sqrt_price_upper - sqrt_price_lower) / Q64 * Q64)
        elif sqrt_price_current >= sqrt_price_upper:
            # All token B
            if token_max_b == 0:
                return 0
            liquidity = int(token_max_b * Q64 / (sqrt_price_upper - sqrt_price_lower))
        else:
            # Both tokens - use the smaller of the two
            liquidity_a = int(token_max_a * (sqrt_price_current * sqrt_price_upper) /
                             (sqrt_price_upper - sqrt_price_current) / Q64 * Q64)
            liquidity_b = int(token_max_b * Q64 / (sqrt_price_current - sqrt_price_lower))
            liquidity = min(liquidity_a, liquidity_b) if liquidity_a > 0 and liquidity_b > 0 else max(liquidity_a, liquidity_b)

        # Apply safety factor
        return int(liquidity * 0.95)

    def _tick_to_sqrt_price(self, tick: int) -> int:
        """Convert tick to sqrt price."""
        return int(math.pow(1.0001, tick / 2) * Q64)


class ProductionCostTester:
    """Main test orchestrator - production configuration matched."""

    def __init__(self):
        self.rpc_client = SolanaRPCClient(RPC_URL)
        self.price_client = JupiterPriceClient(JUPITER_API_KEY)
        self.swap_client = JupiterSwapClient(JUPITER_API_KEY, RPC_URL)
        self.ultra_client = JupiterUltraClient(JUPITER_API_KEY, RPC_URL)

        if not WALLET_KEY:
            raise ValueError("WALLET_PRIVATE_KEY_BASE58 not set")
        key_bytes = base58.b58decode(WALLET_KEY)
        self.keypair = Keypair.from_bytes(key_bytes)
        self.wallet_pubkey = str(self.keypair.pubkey())

        self.orca_tester = OrcaPositionTester(RPC_URL, self.keypair, SOL_USDC_POOL)

        self.results: List[TestResult] = []
        self.initial_state: Optional[WalletState] = None

    async def get_wallet_state(self) -> WalletState:
        """Get current wallet state including wSOL."""
        sol_balance = await self.rpc_client.get_sol_balance(self.wallet_pubkey)
        usdc_balance = await self.rpc_client.get_token_balance(self.wallet_pubkey, USDC_MINT)
        wsol_balance = await self.rpc_client.get_wsol_balance(self.wallet_pubkey)
        sol_price = await self.price_client.get_sol_price()

        return WalletState(
            sol_balance=sol_balance,
            usdc_balance=usdc_balance,
            wsol_balance=wsol_balance,
            sol_price=sol_price,
        )

    async def run_swap_test(
        self,
        amount_usd: float,
        direction: str,
        api_type: str,
        slippage_bps: int = SWAP_SLIPPAGE_BPS,
    ) -> TestResult:
        """Run a single swap test with production slippage."""
        test_name = f"SWAP_{direction}_{amount_usd}USD_{api_type}_{slippage_bps}bps"
        print(f"\n{'='*60}")
        print(f"Running: {test_name}")
        print(f"{'='*60}")

        state_before = await self.get_wallet_state()
        print(f"Before: {state_before}")
        print(f"Slippage: {slippage_bps} bps ({slippage_bps/100:.2f}%)")

        if direction == "SOL_TO_USDC":
            input_mint = SOL_MINT
            output_mint = USDC_MINT
            input_amount_raw = int((amount_usd / state_before.sol_price) * 1e9)
        else:
            input_mint = USDC_MINT
            output_mint = SOL_MINT
            input_amount_raw = int(amount_usd * 1e6)

        start_time = time.time()

        try:
            if api_type == "swap_api":
                success, signature, in_amt, out_amt, error = await self.swap_client.execute_swap(
                    input_mint, output_mint, input_amount_raw, self.keypair, slippage_bps
                )
                metadata = {"api": "swap_api", "slippage_bps": slippage_bps}
            else:
                success, signature, in_amt, out_amt, error, extra_meta = await self.ultra_client.execute_swap(
                    input_mint, output_mint, input_amount_raw, self.keypair, slippage_bps
                )
                metadata = {"api": "ultra_api", "slippage_bps": slippage_bps, **extra_meta}

            execution_time_ms = int((time.time() - start_time) * 1000)

            if not success:
                print(f"FAILED: {error}")
                return TestResult(
                    test_name=test_name,
                    operation_type="swap",
                    amount_usd=amount_usd,
                    wallet_value_before=state_before.total_value_usd,
                    wallet_value_after=state_before.total_value_usd,
                    total_cost_usd=0,
                    cost_percentage=0,
                    execution_time_ms=execution_time_ms,
                    signature=signature,
                    success=False,
                    error=error,
                    metadata=metadata,
                )

            await asyncio.sleep(3)
            state_after = await self.get_wallet_state()
            print(f"After: {state_after}")

            total_cost_usd = state_before.total_value_usd - state_after.total_value_usd
            cost_percentage = (total_cost_usd / amount_usd) * 100

            print(f"Signature: {signature}")
            print(f"Total cost: ${total_cost_usd:.4f} ({cost_percentage:.2f}%)")
            print(f"Execution time: {execution_time_ms}ms")

            return TestResult(
                test_name=test_name,
                operation_type="swap",
                amount_usd=amount_usd,
                wallet_value_before=state_before.total_value_usd,
                wallet_value_after=state_after.total_value_usd,
                total_cost_usd=total_cost_usd,
                cost_percentage=cost_percentage,
                execution_time_ms=execution_time_ms,
                signature=signature,
                success=True,
                metadata=metadata,
            )

        except Exception as e:
            execution_time_ms = int((time.time() - start_time) * 1000)
            print(f"ERROR: {e}")
            import traceback
            traceback.print_exc()

            return TestResult(
                test_name=test_name,
                operation_type="swap",
                amount_usd=amount_usd,
                wallet_value_before=state_before.total_value_usd,
                wallet_value_after=state_before.total_value_usd,
                total_cost_usd=0,
                cost_percentage=0,
                execution_time_ms=execution_time_ms,
                success=False,
                error=str(e),
            )

    async def run_wsol_cleanup_test(self) -> Optional[TestResult]:
        """Test wSOL cleanup costs."""
        test_name = "WSOL_CLEANUP"
        print(f"\n{'='*60}")
        print(f"Running: {test_name}")
        print(f"{'='*60}")

        state_before = await self.get_wallet_state()
        print(f"Before: {state_before}")

        if state_before.wsol_balance < 0.001:
            print("No wSOL to cleanup - skipping")
            return None

        start_time = time.time()

        success, sol_recovered, signature = await self.orca_tester.cleanup_wsol()
        execution_time_ms = int((time.time() - start_time) * 1000)

        await asyncio.sleep(3)
        state_after = await self.get_wallet_state()
        print(f"After: {state_after}")

        # Cost = value lost (should be minimal, just tx fee)
        total_cost_usd = state_before.total_value_usd - state_after.total_value_usd
        cost_percentage = (total_cost_usd / (state_before.wsol_balance * state_before.sol_price)) * 100 if state_before.wsol_balance > 0 else 0

        print(f"SOL recovered: {sol_recovered:.6f}")
        print(f"Total cost: ${total_cost_usd:.4f} ({cost_percentage:.2f}%)")

        return TestResult(
            test_name=test_name,
            operation_type="wsol_cleanup",
            amount_usd=state_before.wsol_balance * state_before.sol_price,
            wallet_value_before=state_before.total_value_usd,
            wallet_value_after=state_after.total_value_usd,
            total_cost_usd=total_cost_usd,
            cost_percentage=cost_percentage,
            execution_time_ms=execution_time_ms,
            signature=signature,
            success=success,
            metadata={"sol_recovered": sol_recovered},
        )

    async def run_full_rebalance_cycle_test(self, amount_usd: float) -> TestResult:
        """
        Test a FULL rebalance cycle as done in production:
        1. Open position
        2. Close position
        3. wSOL cleanup
        4. Swap (if needed)
        5. Open new position

        This matches what happens in execution.py rebalance_position()
        """
        test_name = f"FULL_REBALANCE_CYCLE_{amount_usd}USD"
        print(f"\n{'='*80}")
        print(f"Running: {test_name}")
        print(f"{'='*80}")
        print("This simulates a FULL rebalance cycle as in production")
        print("Steps: Open -> Close -> wSOL Cleanup -> Swap -> Open")

        state_before = await self.get_wallet_state()
        print(f"INITIAL STATE: {state_before}")

        start_time = time.time()
        all_signatures = []
        errors = []

        # Calculate position parameters
        current_price = state_before.sol_price
        range_width = 0.03  # 3% range (matches production MIN_RANGE)

        lower_price = current_price * (1 - range_width / 2)
        upper_price = current_price * (1 + range_width / 2)

        # Split amount 50/50 between SOL and USDC
        sol_amount = (amount_usd / 2) / current_price
        usdc_amount = amount_usd / 2

        # ============================================
        # STEP 1: OPEN INITIAL POSITION
        # ============================================
        print(f"\n[STEP 1/5] OPENING INITIAL POSITION")
        print(f"  Range: ${lower_price:.2f} - ${upper_price:.2f}")

        success, open_sig1, position_address, error = await self.orca_tester.open_position(
            lower_price=lower_price,
            upper_price=upper_price,
            sol_amount=sol_amount,
            usdc_amount=usdc_amount,
        )

        if not success:
            print(f"  FAILED: {error}")
            errors.append(f"Initial open: {error}")
            return TestResult(
                test_name=test_name,
                operation_type="rebalance_cycle",
                amount_usd=amount_usd,
                wallet_value_before=state_before.total_value_usd,
                wallet_value_after=state_before.total_value_usd,
                total_cost_usd=0,
                cost_percentage=0,
                execution_time_ms=int((time.time() - start_time) * 1000),
                success=False,
                error="; ".join(errors),
            )

        all_signatures.append(("open1", open_sig1))
        print(f"  Position opened: {position_address}")
        await asyncio.sleep(3)

        state_after_open1 = await self.get_wallet_state()
        print(f"  After open: {state_after_open1}")
        open1_cost = state_before.total_value_usd - state_after_open1.total_value_usd
        print(f"  Open cost: ${open1_cost:.4f}")

        # ============================================
        # STEP 2: CLOSE POSITION
        # ============================================
        print(f"\n[STEP 2/5] CLOSING POSITION")

        success, close_sig, error = await self.orca_tester.close_position(position_address)

        if not success:
            print(f"  FAILED: {error}")
            errors.append(f"Close: {error}")
            return TestResult(
                test_name=test_name,
                operation_type="rebalance_cycle",
                amount_usd=amount_usd,
                wallet_value_before=state_before.total_value_usd,
                wallet_value_after=(await self.get_wallet_state()).total_value_usd,
                total_cost_usd=state_before.total_value_usd - (await self.get_wallet_state()).total_value_usd,
                cost_percentage=0,
                execution_time_ms=int((time.time() - start_time) * 1000),
                success=False,
                error="; ".join(errors),
            )

        all_signatures.append(("close", close_sig))
        await asyncio.sleep(3)

        state_after_close = await self.get_wallet_state()
        print(f"  After close: {state_after_close}")
        close_cost = state_after_open1.total_value_usd - state_after_close.total_value_usd
        print(f"  Close cost: ${close_cost:.4f}")

        # ============================================
        # STEP 3: wSOL CLEANUP (as in production)
        # ============================================
        print(f"\n[STEP 3/5] wSOL CLEANUP")

        wsol_success, wsol_recovered, wsol_sig = await self.orca_tester.cleanup_wsol()
        if wsol_sig:
            all_signatures.append(("wsol_cleanup", wsol_sig))

        await asyncio.sleep(3)
        state_after_wsol = await self.get_wallet_state()
        print(f"  After wSOL cleanup: {state_after_wsol}")
        wsol_cost = state_after_close.total_value_usd - state_after_wsol.total_value_usd
        print(f"  wSOL cleanup cost: ${wsol_cost:.4f} (recovered {wsol_recovered:.6f} SOL)")

        # ============================================
        # STEP 4: SWAP (simulating balance adjustment)
        # ============================================
        print(f"\n[STEP 4/5] BALANCE SWAP (simulating rebalance)")

        # In production, this swaps to achieve target ratio
        # For testing, do a small swap to measure cost
        swap_amount = min(50.0, state_after_wsol.usdc_balance * 0.2)  # 20% of USDC or $50

        if swap_amount > 10:
            swap_result = await self.run_swap_test(
                swap_amount, "USDC_TO_SOL", "ultra_api" if USE_ULTRA_API else "swap_api",
                slippage_bps=SWAP_SLIPPAGE_BPS
            )
            if swap_result.signature:
                all_signatures.append(("swap", swap_result.signature))
            swap_cost = swap_result.total_cost_usd
        else:
            print("  Skipping swap - insufficient balance")
            swap_cost = 0

        await asyncio.sleep(3)
        state_after_swap = await self.get_wallet_state()
        print(f"  After swap: {state_after_swap}")
        print(f"  Swap cost: ${swap_cost:.4f}")

        # ============================================
        # STEP 5: OPEN NEW POSITION (completing rebalance)
        # ============================================
        print(f"\n[STEP 5/5] OPENING NEW POSITION")

        # Recalculate with current price and balances
        current_price2 = state_after_swap.sol_price
        lower_price2 = current_price2 * (1 - range_width / 2)
        upper_price2 = current_price2 * (1 + range_width / 2)

        # Use available balances
        available_sol = max(0, state_after_swap.sol_balance - 0.1)  # Reserve 0.1 SOL
        available_usdc = state_after_swap.usdc_balance

        # Target 50/50 value split
        total_available = (available_sol * current_price2) + available_usdc
        target_sol_value = total_available / 2
        target_usdc_value = total_available / 2

        sol_amount2 = min(available_sol, target_sol_value / current_price2)
        usdc_amount2 = min(available_usdc, target_usdc_value)

        print(f"  Range: ${lower_price2:.2f} - ${upper_price2:.2f}")
        print(f"  Deploying: {sol_amount2:.4f} SOL, ${usdc_amount2:.2f} USDC")

        success2, open_sig2, position_address2, error2 = await self.orca_tester.open_position(
            lower_price=lower_price2,
            upper_price=upper_price2,
            sol_amount=sol_amount2,
            usdc_amount=usdc_amount2,
        )

        if success2:
            all_signatures.append(("open2", open_sig2))
            print(f"  Position opened: {position_address2}")
        else:
            print(f"  FAILED: {error2}")
            errors.append(f"Re-open: {error2}")

        await asyncio.sleep(3)
        state_after_open2 = await self.get_wallet_state()
        print(f"  After re-open: {state_after_open2}")
        open2_cost = state_after_swap.total_value_usd - state_after_open2.total_value_usd
        print(f"  Re-open cost: ${open2_cost:.4f}")

        # ============================================
        # CLEANUP: Close the new position to return to initial state
        # ============================================
        if success2 and position_address2:
            print(f"\n[CLEANUP] Closing test position")
            await asyncio.sleep(2)
            await self.orca_tester.close_position(position_address2)
            await asyncio.sleep(2)
            await self.orca_tester.cleanup_wsol()

        execution_time_ms = int((time.time() - start_time) * 1000)

        # Final state
        await asyncio.sleep(3)
        state_final = await self.get_wallet_state()
        print(f"\n{'='*80}")
        print(f"FINAL STATE: {state_final}")

        total_cost_usd = state_before.total_value_usd - state_final.total_value_usd
        cost_percentage = (total_cost_usd / amount_usd) * 100

        print(f"\n{'='*80}")
        print(f"REBALANCE CYCLE COST BREAKDOWN:")
        print(f"{'='*80}")
        print(f"  Initial open:     ${open1_cost:.4f}")
        print(f"  Close position:   ${close_cost:.4f}")
        print(f"  wSOL cleanup:     ${wsol_cost:.4f}")
        print(f"  Swap:             ${swap_cost:.4f}")
        print(f"  Re-open position: ${open2_cost:.4f}")
        print(f"  ---")
        print(f"  TOTAL CYCLE:      ${total_cost_usd:.4f} ({cost_percentage:.2f}% of ${amount_usd})")
        print(f"  Execution time:   {execution_time_ms}ms")
        print(f"{'='*80}")

        return TestResult(
            test_name=test_name,
            operation_type="rebalance_cycle",
            amount_usd=amount_usd,
            wallet_value_before=state_before.total_value_usd,
            wallet_value_after=state_final.total_value_usd,
            total_cost_usd=total_cost_usd,
            cost_percentage=cost_percentage,
            execution_time_ms=execution_time_ms,
            signature=open_sig2,
            success=success2 and not errors,
            error="; ".join(errors) if errors else None,
            metadata={
                "open1_cost": open1_cost,
                "close_cost": close_cost,
                "wsol_cost": wsol_cost,
                "swap_cost": swap_cost,
                "open2_cost": open2_cost,
                "signatures": all_signatures,
            },
        )

    async def run_all_tests(self):
        """Run all tests with production configuration."""
        print("\n" + "="*80)
        print("PRODUCTION-MATCHED COST ANALYSIS")
        print("="*80)
        print(f"Wallet: {self.wallet_pubkey}")
        print(f"RPC: {RPC_URL[:50]}...")
        print(f"Pool: {SOL_USDC_POOL} (4 bps fee - PRODUCTION)")
        print(f"Test amounts: {TEST_AMOUNTS_USD}")
        print(f"Swap slippage: {SWAP_SLIPPAGE_BPS} bps (PRODUCTION)")
        print(f"Position slippage: {POSITION_SLIPPAGE_BPS} bps (PRODUCTION)")
        print(f"Use Ultra API: {USE_ULTRA_API} (PRODUCTION)")

        # Initialize Orca client
        await self.orca_tester.initialize()

        # Record initial state
        self.initial_state = await self.get_wallet_state()
        print(f"\nInitial wallet state: {self.initial_state}")

        if self.initial_state.sol_balance < 0.1:
            print(f"WARNING: Low SOL balance ({self.initial_state.sol_balance:.4f})")

        # =====================================
        # PHASE 1: Swap Tests with Production Slippage
        # =====================================
        print("\n" + "="*80)
        print("PHASE 1: SWAP TESTS (PRODUCTION SLIPPAGE)")
        print("="*80)

        for amount in TEST_AMOUNTS_USD:
            if self.initial_state.usdc_balance >= amount:
                # Test Ultra API with production slippage
                result = await self.run_swap_test(amount, "USDC_TO_SOL", "ultra_api", SWAP_SLIPPAGE_BPS)
                self.results.append(result)
                await asyncio.sleep(2)

                # Swap back
                result = await self.run_swap_test(amount, "SOL_TO_USDC", "ultra_api", SWAP_SLIPPAGE_BPS)
                self.results.append(result)
                await asyncio.sleep(2)

        # =====================================
        # PHASE 2: wSOL Cleanup Test
        # =====================================
        print("\n" + "="*80)
        print("PHASE 2: wSOL CLEANUP TEST")
        print("="*80)

        # Create some wSOL first by doing a swap without auto-unwrap
        # (In practice, wSOL comes from position closes)
        cleanup_result = await self.run_wsol_cleanup_test()
        if cleanup_result:
            self.results.append(cleanup_result)

        # =====================================
        # PHASE 3: FULL REBALANCE CYCLE TEST
        # =====================================
        print("\n" + "="*80)
        print("PHASE 3: FULL REBALANCE CYCLE TEST (PRODUCTION SIMULATION)")
        print("="*80)

        current_state = await self.get_wallet_state()

        for amount in TEST_AMOUNTS_USD:
            # Check if we have enough for full cycle
            sol_needed = (amount / 2) / current_state.sol_price
            usdc_needed = amount / 2

            if current_state.sol_balance >= sol_needed + 0.2 and current_state.usdc_balance >= usdc_needed:
                try:
                    result = await self.run_full_rebalance_cycle_test(amount)
                    self.results.append(result)
                    await asyncio.sleep(5)
                    current_state = await self.get_wallet_state()
                except Exception as e:
                    print(f"Rebalance cycle test failed: {e}")
                    import traceback
                    traceback.print_exc()
            else:
                print(f"Skipping ${amount} rebalance test - insufficient balance")
                print(f"  Need: {sol_needed:.4f} SOL + 0.2 reserve, ${usdc_needed:.2f} USDC")
                print(f"  Have: {current_state.sol_balance:.4f} SOL, ${current_state.usdc_balance:.2f} USDC")

        # Print summary
        self.print_summary()

    def print_summary(self):
        """Print test summary."""
        print("\n" + "="*80)
        print("TEST SUMMARY - PRODUCTION CONFIGURATION")
        print("="*80)

        successful = [r for r in self.results if r.success]
        failed = [r for r in self.results if not r.success]

        print(f"\nTotal tests: {len(self.results)}")
        print(f"Successful: {len(successful)}")
        print(f"Failed: {len(failed)}")

        if successful:
            print("\n" + "-"*80)
            print("SUCCESSFUL OPERATIONS")
            print("-"*80)
            print(f"{'Test Name':<50} {'Cost $':<12} {'Cost %':<10} {'Time ms':<10}")
            print("-"*80)

            for r in successful:
                print(f"{r.test_name:<50} ${r.total_cost_usd:<11.4f} {r.cost_percentage:<9.2f}% {r.execution_time_ms:<10}")

            # Group by operation type
            print("\n" + "-"*80)
            print("COST BY OPERATION TYPE")
            print("-"*80)

            swap_results = [r for r in successful if r.operation_type == "swap"]
            rebalance_results = [r for r in successful if r.operation_type == "rebalance_cycle"]
            cleanup_results = [r for r in successful if r.operation_type == "wsol_cleanup"]

            if swap_results:
                avg_cost_pct = sum(r.cost_percentage for r in swap_results) / len(swap_results)
                avg_cost_usd = sum(r.total_cost_usd for r in swap_results) / len(swap_results)
                print(f"Swaps ({SWAP_SLIPPAGE_BPS}bps): Avg cost {avg_cost_pct:.3f}% (${avg_cost_usd:.4f}) - {len(swap_results)} tests")

            if cleanup_results:
                avg_cost_usd = sum(r.total_cost_usd for r in cleanup_results) / len(cleanup_results)
                print(f"wSOL Cleanup: Avg cost ${avg_cost_usd:.4f} - {len(cleanup_results)} tests")

            if rebalance_results:
                avg_cost_pct = sum(r.cost_percentage for r in rebalance_results) / len(rebalance_results)
                avg_cost_usd = sum(r.total_cost_usd for r in rebalance_results) / len(rebalance_results)
                print(f"Full Rebalance Cycle: Avg cost {avg_cost_pct:.3f}% (${avg_cost_usd:.4f}) - {len(rebalance_results)} tests")

                # Breakdown
                for r in rebalance_results:
                    if r.metadata:
                        print(f"  Breakdown for ${r.amount_usd}:")
                        print(f"    Open:  ${r.metadata.get('open1_cost', 0):.4f}")
                        print(f"    Close: ${r.metadata.get('close_cost', 0):.4f}")
                        print(f"    wSOL:  ${r.metadata.get('wsol_cost', 0):.4f}")
                        print(f"    Swap:  ${r.metadata.get('swap_cost', 0):.4f}")
                        print(f"    Reopen:${r.metadata.get('open2_cost', 0):.4f}")

        if failed:
            print("\n" + "-"*80)
            print("FAILED OPERATIONS")
            print("-"*80)
            for r in failed:
                print(f"{r.test_name}: {r.error}")

        # Final analysis
        print("\n" + "="*80)
        print("COMPARISON: TEST vs PRODUCTION")
        print("="*80)
        print("Test Configuration:")
        print(f"  Pool: {SOL_USDC_POOL} (4 bps fee)")
        print(f"  Swap Slippage: {SWAP_SLIPPAGE_BPS} bps")
        print(f"  Ultra API: {USE_ULTRA_API}")
        print("\nProduction Configuration (fly.toml - UPDATED 2025):")
        print("  Pool: Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE (4 bps fee)")
        print("  Swap Slippage: 15-20 bps base + progressive (capped at 100 bps / 1.0%)")
        print("  Progressive schedule: [0, 15, 30, 45, 50] bps added on retries")
        print("  Retry delays: [2, 4, 8, 12, 16] seconds (5 retries max)")
        print("  Ultra API: true")
        print("  Priority Fees: 1000 microlamports per compute unit")
        print("\nKey Changes from Cost Optimization:")
        print("  - Max slippage reduced from 800 bps (8%) to 100 bps (1.0%)")
        print("  - Retries reduced from 8 to 5")
        print("  - Priority fees added for faster confirmation")


async def main():
    """Main entry point."""
    print("="*80)
    print("PRODUCTION-MATCHED SWAP AND POSITION COST ANALYSIS")
    print("="*80)
    print("This executes LIVE trades matching PRODUCTION configuration.")
    print()

    tester = ProductionCostTester()
    await tester.run_all_tests()


if __name__ == "__main__":
    asyncio.run(main())
