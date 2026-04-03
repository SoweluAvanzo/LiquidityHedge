#!/usr/bin/env python3
"""
Swap and Position Cost Analysis Script

This script measures the actual costs of:
1. Jupiter swaps (Swap API and Ultra API)
2. Orca Whirlpool position open/close operations

By recording wallet value before and after each operation:
- Testing multiple trade sizes ($5, $50, $200)
- Comparing Jupiter Swap API vs Ultra API
- Testing both swap directions (SOL->USDC and USDC->SOL)
- Testing position open and close at different sizes

LIVE TRADING ONLY - No dry run mode.

Usage:
    python test_swap_costs.py
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

# Pool configuration - use the production pool
SOL_USDC_POOL = os.getenv("SOL_USDC_POOL", "HJPjoWUrhoZzkNfRpHuieeFk9WcZWjwy6PBjZ81ngndJ")

# Configuration
RPC_URL = os.getenv("SOLANA_RPC_URL", "https://api.mainnet-beta.solana.com")
WALLET_KEY = os.getenv("WALLET_PRIVATE_KEY_BASE58")
JUPITER_API_KEY = os.getenv("JUPITER_API_KEY", "63dadbb1-483c-409d-9205-84c9935af09d")

# Test amounts in USD
TEST_AMOUNTS_USD = [5.0, 50.0, 200.0]

# Slippage settings
SLIPPAGE_BPS = 100  # 1%

# Orca constants
Q64 = 2**64
DEFAULT_TICK_SPACING = 4  # For HJPjo... pool (1bp pool)


@dataclass
class WalletState:
    """Snapshot of wallet balances."""
    sol_balance: float  # Native SOL
    usdc_balance: float
    sol_price: float
    timestamp: datetime = field(default_factory=datetime.utcnow)

    @property
    def total_value_usd(self) -> float:
        """Total wallet value in USD."""
        return (self.sol_balance * self.sol_price) + self.usdc_balance

    def __str__(self) -> str:
        return (f"SOL: {self.sol_balance:.6f} (${self.sol_balance * self.sol_price:.2f}), "
                f"USDC: ${self.usdc_balance:.2f}, Total: ${self.total_value_usd:.2f}")


@dataclass
class TestResult:
    """Result of a single test."""
    test_name: str
    operation_type: str  # 'swap', 'position_open', 'position_close'
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
        slippage_bps: int = 100,
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
        slippage_bps: int = 100,
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
        slippage_bps: int = 100,
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

    async def get_pool_state(self):
        """Get current pool state."""
        return await self._orca_client.get_pool_state(self.pool_address, force_refresh=True)

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


class CostTester:
    """Main test orchestrator."""

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
        """Get current wallet state."""
        sol_balance = await self.rpc_client.get_sol_balance(self.wallet_pubkey)
        usdc_balance = await self.rpc_client.get_token_balance(self.wallet_pubkey, USDC_MINT)
        sol_price = await self.price_client.get_sol_price()

        return WalletState(
            sol_balance=sol_balance,
            usdc_balance=usdc_balance,
            sol_price=sol_price,
        )

    async def run_swap_test(
        self,
        amount_usd: float,
        direction: str,
        api_type: str,
    ) -> TestResult:
        """Run a single swap test."""
        test_name = f"SWAP_{direction}_{amount_usd}USD_{api_type}"
        print(f"\n{'='*60}")
        print(f"Running: {test_name}")
        print(f"{'='*60}")

        state_before = await self.get_wallet_state()
        print(f"Before: {state_before}")

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
                    input_mint, output_mint, input_amount_raw, self.keypair, SLIPPAGE_BPS
                )
                metadata = {"api": "swap_api"}
            else:
                success, signature, in_amt, out_amt, error, extra_meta = await self.ultra_client.execute_swap(
                    input_mint, output_mint, input_amount_raw, self.keypair, SLIPPAGE_BPS
                )
                metadata = {"api": "ultra_api", **extra_meta}

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

    async def run_position_test(self, amount_usd: float) -> TestResult:
        """Run a position open/close test cycle."""
        test_name = f"POSITION_CYCLE_{amount_usd}USD"
        print(f"\n{'='*60}")
        print(f"Running: {test_name}")
        print(f"{'='*60}")

        state_before = await self.get_wallet_state()
        print(f"Before: {state_before}")

        start_time = time.time()
        position_address = None

        try:
            # Calculate position parameters
            current_price = state_before.sol_price
            range_width = 0.03  # 3% range

            lower_price = current_price * (1 - range_width / 2)
            upper_price = current_price * (1 + range_width / 2)

            # Split amount 50/50 between SOL and USDC
            sol_amount = (amount_usd / 2) / current_price
            usdc_amount = amount_usd / 2

            print(f"\n--- OPENING POSITION ---")
            print(f"  Target amount: ${amount_usd}")
            print(f"  Current price: ${current_price:.2f}")
            print(f"  Range: ${lower_price:.2f} - ${upper_price:.2f}")

            success, open_sig, position_address, error = await self.orca_tester.open_position(
                lower_price=lower_price,
                upper_price=upper_price,
                sol_amount=sol_amount,
                usdc_amount=usdc_amount,
            )

            if not success:
                print(f"OPEN FAILED: {error}")
                execution_time_ms = int((time.time() - start_time) * 1000)
                return TestResult(
                    test_name=test_name,
                    operation_type="position_cycle",
                    amount_usd=amount_usd,
                    wallet_value_before=state_before.total_value_usd,
                    wallet_value_after=state_before.total_value_usd,
                    total_cost_usd=0,
                    cost_percentage=0,
                    execution_time_ms=execution_time_ms,
                    signature=open_sig,
                    success=False,
                    error=f"Open failed: {error}",
                )

            print(f"  Open signature: {open_sig}")
            print(f"  Position: {position_address}")

            # Wait for position to settle
            await asyncio.sleep(5)

            state_after_open = await self.get_wallet_state()
            print(f"After open: {state_after_open}")

            # Now close the position
            print(f"\n--- CLOSING POSITION ---")

            success, close_sig, error = await self.orca_tester.close_position(position_address)

            if not success:
                print(f"CLOSE FAILED: {error}")
                execution_time_ms = int((time.time() - start_time) * 1000)
                return TestResult(
                    test_name=test_name,
                    operation_type="position_cycle",
                    amount_usd=amount_usd,
                    wallet_value_before=state_before.total_value_usd,
                    wallet_value_after=state_after_open.total_value_usd,
                    total_cost_usd=state_before.total_value_usd - state_after_open.total_value_usd,
                    cost_percentage=0,
                    execution_time_ms=int((time.time() - start_time) * 1000),
                    signature=close_sig,
                    success=False,
                    error=f"Close failed: {error}",
                    metadata={"open_sig": open_sig, "position": position_address},
                )

            print(f"  Close signature: {close_sig}")

            # Wait for close to settle
            await asyncio.sleep(3)

            execution_time_ms = int((time.time() - start_time) * 1000)

            state_after_close = await self.get_wallet_state()
            print(f"After close: {state_after_close}")

            total_cost_usd = state_before.total_value_usd - state_after_close.total_value_usd
            cost_percentage = (total_cost_usd / amount_usd) * 100

            print(f"\nTotal cost: ${total_cost_usd:.4f} ({cost_percentage:.2f}%)")
            print(f"Execution time: {execution_time_ms}ms")

            return TestResult(
                test_name=test_name,
                operation_type="position_cycle",
                amount_usd=amount_usd,
                wallet_value_before=state_before.total_value_usd,
                wallet_value_after=state_after_close.total_value_usd,
                total_cost_usd=total_cost_usd,
                cost_percentage=cost_percentage,
                execution_time_ms=execution_time_ms,
                signature=close_sig,
                success=True,
                metadata={
                    "open_sig": open_sig,
                    "close_sig": close_sig,
                    "position": position_address,
                    "lower_price": lower_price,
                    "upper_price": upper_price,
                },
            )

        except Exception as e:
            execution_time_ms = int((time.time() - start_time) * 1000)
            print(f"ERROR: {e}")
            import traceback
            traceback.print_exc()

            return TestResult(
                test_name=test_name,
                operation_type="position_cycle",
                amount_usd=amount_usd,
                wallet_value_before=state_before.total_value_usd,
                wallet_value_after=state_before.total_value_usd,
                total_cost_usd=0,
                cost_percentage=0,
                execution_time_ms=execution_time_ms,
                success=False,
                error=str(e),
            )

    async def run_all_tests(self):
        """Run all tests."""
        print("\n" + "="*80)
        print("SWAP AND POSITION COST ANALYSIS - LIVE TRADING")
        print("="*80)
        print(f"Wallet: {self.wallet_pubkey}")
        print(f"RPC: {RPC_URL[:50]}...")
        print(f"Pool: {SOL_USDC_POOL}")
        print(f"Test amounts: {TEST_AMOUNTS_USD}")
        print(f"Slippage: {SLIPPAGE_BPS} bps")

        # Initialize Orca client
        await self.orca_tester.initialize()

        # Record initial state
        self.initial_state = await self.get_wallet_state()
        print(f"\nInitial wallet state: {self.initial_state}")

        if self.initial_state.sol_balance < 0.1:
            print(f"WARNING: Low SOL balance ({self.initial_state.sol_balance:.4f})")

        # =====================================
        # PHASE 1: Swap Tests
        # =====================================
        print("\n" + "="*80)
        print("PHASE 1: SWAP TESTS")
        print("="*80)

        swap_tests = []
        for amount in TEST_AMOUNTS_USD:
            if self.initial_state.usdc_balance >= amount:
                # Test USDC->SOL then SOL->USDC for each API
                swap_tests.append((amount, "USDC_TO_SOL", "swap_api"))
                swap_tests.append((amount, "SOL_TO_USDC", "swap_api"))
                swap_tests.append((amount, "USDC_TO_SOL", "ultra_api"))
                swap_tests.append((amount, "SOL_TO_USDC", "ultra_api"))
            else:
                print(f"Skipping ${amount} swap tests - insufficient USDC")

        for amount, direction, api_type in swap_tests:
            try:
                result = await self.run_swap_test(amount, direction, api_type)
                self.results.append(result)
                await asyncio.sleep(2)
            except Exception as e:
                print(f"Test failed: {e}")

        # =====================================
        # PHASE 2: Position Tests
        # =====================================
        print("\n" + "="*80)
        print("PHASE 2: POSITION OPEN/CLOSE TESTS")
        print("="*80)

        # Refresh wallet state
        current_state = await self.get_wallet_state()

        for amount in TEST_AMOUNTS_USD:
            # Check if we have enough for position
            sol_needed = (amount / 2) / current_state.sol_price
            usdc_needed = amount / 2

            if current_state.sol_balance >= sol_needed + 0.1 and current_state.usdc_balance >= usdc_needed:
                try:
                    result = await self.run_position_test(amount)
                    self.results.append(result)
                    await asyncio.sleep(3)
                    current_state = await self.get_wallet_state()
                except Exception as e:
                    print(f"Position test failed: {e}")
            else:
                print(f"Skipping ${amount} position test - insufficient balance")
                print(f"  Need: {sol_needed:.4f} SOL + 0.1 reserve, ${usdc_needed:.2f} USDC")
                print(f"  Have: {current_state.sol_balance:.4f} SOL, ${current_state.usdc_balance:.2f} USDC")

        # Print summary
        self.print_summary()

        # Restore initial state
        await self.restore_initial_state()

    def print_summary(self):
        """Print test summary."""
        print("\n" + "="*80)
        print("TEST SUMMARY")
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
            print(f"{'Test Name':<45} {'Cost $':<12} {'Cost %':<10} {'Time ms':<10}")
            print("-"*80)

            for r in successful:
                print(f"{r.test_name:<45} ${r.total_cost_usd:<11.4f} {r.cost_percentage:<9.2f}% {r.execution_time_ms:<10}")

            # Group by operation type
            print("\n" + "-"*80)
            print("COST BY OPERATION TYPE")
            print("-"*80)

            swap_results = [r for r in successful if r.operation_type == "swap"]
            position_results = [r for r in successful if r.operation_type == "position_cycle"]

            if swap_results:
                avg_cost_pct = sum(r.cost_percentage for r in swap_results) / len(swap_results)
                avg_cost_usd = sum(r.total_cost_usd for r in swap_results) / len(swap_results)
                print(f"Swaps: Avg cost {avg_cost_pct:.3f}% (${avg_cost_usd:.4f}) - {len(swap_results)} tests")

            if position_results:
                avg_cost_pct = sum(r.cost_percentage for r in position_results) / len(position_results)
                avg_cost_usd = sum(r.total_cost_usd for r in position_results) / len(position_results)
                print(f"Positions: Avg cost {avg_cost_pct:.3f}% (${avg_cost_usd:.4f}) - {len(position_results)} tests")

            # Swap API comparison
            swap_api = [r for r in swap_results if r.metadata.get("api") == "swap_api"]
            ultra_api = [r for r in swap_results if r.metadata.get("api") == "ultra_api"]

            if swap_api:
                avg = sum(r.cost_percentage for r in swap_api) / len(swap_api)
                print(f"\nJupiter Swap API: Avg {avg:.3f}% - {len(swap_api)} tests")
            if ultra_api:
                avg = sum(r.cost_percentage for r in ultra_api) / len(ultra_api)
                print(f"Jupiter Ultra API: Avg {avg:.3f}% - {len(ultra_api)} tests")

            # Cost by amount
            print("\n" + "-"*80)
            print("COST BY AMOUNT")
            print("-"*80)

            for amount in TEST_AMOUNTS_USD:
                amount_results = [r for r in successful if r.amount_usd == amount]
                if amount_results:
                    avg_pct = sum(r.cost_percentage for r in amount_results) / len(amount_results)
                    avg_usd = sum(r.total_cost_usd for r in amount_results) / len(amount_results)
                    print(f"${amount}: Avg {avg_pct:.3f}% (${avg_usd:.4f}) - {len(amount_results)} tests")

        if failed:
            print("\n" + "-"*80)
            print("FAILED OPERATIONS")
            print("-"*80)
            for r in failed:
                print(f"{r.test_name}: {r.error}")

    async def restore_initial_state(self):
        """Restore wallet to initial state."""
        print("\n" + "="*80)
        print("RESTORING WALLET TO INITIAL STATE")
        print("="*80)

        if not self.initial_state:
            print("No initial state recorded")
            return

        current_state = await self.get_wallet_state()
        print(f"Current: {current_state}")
        print(f"Target: {self.initial_state}")

        usdc_diff = current_state.usdc_balance - self.initial_state.usdc_balance
        print(f"USDC difference: {usdc_diff:+.2f}")

        if abs(usdc_diff) > 1.0:
            if usdc_diff < 0:
                # Need more USDC - sell SOL
                amount_usd = abs(usdc_diff)
                sol_to_sell = amount_usd / current_state.sol_price

                if current_state.sol_balance - sol_to_sell > 0.05:
                    print(f"\nSelling {sol_to_sell:.6f} SOL to restore USDC...")
                    input_raw = int(sol_to_sell * 1e9)
                    success, sig, _, _, error = await self.swap_client.execute_swap(
                        SOL_MINT, USDC_MINT, input_raw, self.keypair, SLIPPAGE_BPS
                    )
                    print(f"Restoration: {'Success' if success else f'Failed: {error}'}")
                else:
                    print("Not enough SOL for restoration")
            else:
                # Have excess USDC - buy SOL
                amount_usdc = abs(usdc_diff)
                if amount_usdc <= current_state.usdc_balance:
                    print(f"\nBuying SOL with ${amount_usdc:.2f} USDC...")
                    input_raw = int(amount_usdc * 1e6)
                    success, sig, _, _, error = await self.swap_client.execute_swap(
                        USDC_MINT, SOL_MINT, input_raw, self.keypair, SLIPPAGE_BPS
                    )
                    print(f"Restoration: {'Success' if success else f'Failed: {error}'}")
        else:
            print("Wallet already close to initial state")

        await asyncio.sleep(3)
        final_state = await self.get_wallet_state()
        print(f"\nFinal: {final_state}")
        total_cost = self.initial_state.total_value_usd - final_state.total_value_usd
        print(f"Total cost of all operations: ${total_cost:.4f}")


async def main():
    """Main entry point."""
    print("="*80)
    print("SWAP AND POSITION COST ANALYSIS")
    print("="*80)
    print("This executes LIVE trades to measure costs.")
    print()

    tester = CostTester()
    await tester.run_all_tests()


if __name__ == "__main__":
    asyncio.run(main())
