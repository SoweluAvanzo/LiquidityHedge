"""
Jupiter aggregator client.

Provides methods for getting swap quotes and executing swaps
through Jupiter's API.
"""

import base64
import time
from dataclasses import dataclass
from decimal import Decimal
from typing import Optional, Dict, Any, List

import httpx
import structlog
from solders.keypair import Keypair
from solders.transaction import VersionedTransaction

from app.config import get_settings
from .solana_client import SolanaClient, get_solana_client

logger = structlog.get_logger(__name__)
settings = get_settings()

# Common token mints
SOL_MINT = "So11111111111111111111111111111111111111112"
USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"


@dataclass
class Quote:
    """Jupiter swap quote."""
    input_mint: str
    output_mint: str
    in_amount: int
    out_amount: int
    other_amount_threshold: int
    swap_mode: str
    slippage_bps: int
    price_impact_pct: float
    route_plan: List[Dict[str, Any]]
    context_slot: int
    raw_response: Dict[str, Any]

    @property
    def in_amount_decimal(self) -> Decimal:
        """Input amount as decimal (assumes 9 decimals for SOL, 6 for USDC)."""
        # This is simplified - real impl would use token decimals
        return Decimal(self.in_amount) / Decimal(10**9)

    @property
    def out_amount_decimal(self) -> Decimal:
        """Output amount as decimal."""
        return Decimal(self.out_amount) / Decimal(10**6)

    @property
    def effective_price(self) -> float:
        """Calculate effective swap price."""
        if self.in_amount == 0:
            return 0
        return self.out_amount / self.in_amount


@dataclass
class SwapResult:
    """Result of a Jupiter swap execution."""
    success: bool
    signature: Optional[str] = None
    input_amount: int = 0
    output_amount: int = 0
    error: Optional[str] = None


@dataclass
class UltraOrder:
    """Jupiter Ultra API order response (quote + unsigned transaction)."""
    request_id: str
    input_mint: str
    output_mint: str
    in_amount: int
    out_amount: int
    slippage_bps: int
    price_impact_pct: float
    transaction: bytes  # Serialized unsigned transaction
    gasless: bool
    router: str  # 'iris', 'jupiterz', 'dflow', 'okx'
    fee_bps: int
    raw_response: Dict[str, Any]

    @property
    def out_amount_decimal(self) -> Decimal:
        """Output amount as decimal."""
        decimals = 6 if self.output_mint == USDC_MINT else 9
        return Decimal(self.out_amount) / Decimal(10**decimals)


@dataclass
class UltraSwapResult:
    """Result of a Jupiter Ultra swap execution."""
    success: bool
    signature: Optional[str] = None
    input_amount: int = 0
    output_amount: int = 0
    output_amount_result: Optional[int] = None  # Actual amount received
    gasless_used: bool = False
    execution_time_ms: Optional[int] = None
    error: Optional[str] = None
    request_id: Optional[str] = None
    swap_events: Optional[List[Dict[str, Any]]] = None
    fee_bps: int = 0  # Jupiter protocol fee in basis points
    router: str = ""  # Which router handled the swap (iris, jupiterz, dflow, okx)


class JupiterClient:
    """
    Client for Jupiter swap aggregator.

    Provides methods for:
    - Getting swap quotes
    - Building swap transactions
    - Executing swaps
    """

    def __init__(
        self,
        api_url: Optional[str] = None,
        solana_client: Optional[SolanaClient] = None,
        api_key: Optional[str] = None,
    ):
        """
        Initialize the Jupiter client.

        Args:
            api_url: Jupiter API URL
            solana_client: Solana client instance
            api_key: Jupiter API key (required for api.jup.ag endpoints)
        """
        self.api_url = api_url or settings.jupiter_api_url
        self.ultra_api_url = settings.jupiter_ultra_api_url
        self._solana_client = solana_client
        self._api_key = api_key
        self._http_client: Optional[httpx.AsyncClient] = None

    async def _get_http_client(self) -> httpx.AsyncClient:
        """Get or create HTTP client."""
        # CRITICAL FIX: Check if client is closed and recreate if needed
        # If client gets closed (due to timeout, network error, etc.), reusing it
        # causes DNS errors like "[Errno -5] No address associated with hostname"
        if self._http_client is None or self._http_client.is_closed:
            # Close existing client if it exists but is closed
            if self._http_client is not None:
                try:
                    await self._http_client.aclose()
                except Exception:
                    pass  # Ignore errors when closing already-closed client
            
            # Build headers with API key if available (required for api.jup.ag)
            headers = {"Content-Type": "application/json"}
            if self._api_key:
                headers["x-api-key"] = self._api_key
            
            self._http_client = httpx.AsyncClient(
                timeout=30.0,
                headers=headers,
            )
        return self._http_client

    async def _get_solana_client(self) -> SolanaClient:
        """Get or create Solana client."""
        if self._solana_client is None:
            self._solana_client = await get_solana_client()
        return self._solana_client

    async def close(self) -> None:
        """Close HTTP client."""
        if self._http_client:
            await self._http_client.aclose()
            self._http_client = None

    async def get_quote(
        self,
        input_mint: str,
        output_mint: str,
        amount: int,
        slippage_bps: Optional[int] = None,
        swap_mode: str = "ExactIn",
    ) -> Quote:
        """
        Get a swap quote from Jupiter.

        Always fetches REAL quotes from Jupiter API.

        Args:
            input_mint: Input token mint address
            output_mint: Output token mint address
            amount: Amount to swap (in smallest units)
            slippage_bps: Slippage tolerance in basis points
            swap_mode: "ExactIn" or "ExactOut"

        Returns:
            Quote: Swap quote with route info
        """
        logger.info(
            "get_quote",
            input_mint=input_mint,
            output_mint=output_mint,
            amount=amount,
        )

        slippage = slippage_bps or settings.strat_max_slippage_bps

        # Always call real Jupiter API for quotes
        http = await self._get_http_client()
        params = {
            "inputMint": input_mint,
            "outputMint": output_mint,
            "amount": str(amount),
            "slippageBps": slippage,
            "swapMode": swap_mode,
        }
        
        # For highly liquid pairs (SOL/USDC), prefer direct routes to reduce fees
        # Multi-hop routes add 0.3% fee per hop, which can exceed the benefit
        if (hasattr(settings, 'jupiter_only_direct_routes') and 
            settings.jupiter_only_direct_routes and
            ((input_mint == SOL_MINT and output_mint == USDC_MINT) or
             (input_mint == USDC_MINT and output_mint == SOL_MINT))):
            params["onlyDirectRoutes"] = True
            if hasattr(settings, 'jupiter_max_accounts'):
                params["maxAccounts"] = settings.jupiter_max_accounts

        try:
            # Jupiter API v6 uses /swap/v1/quote endpoint (not /v6/quote)
            response = await http.get(f"{self.api_url}/swap/v1/quote", params=params)
            response.raise_for_status()
            data = response.json()

            return Quote(
                input_mint=input_mint,
                output_mint=output_mint,
                in_amount=int(data["inAmount"]),
                out_amount=int(data["outAmount"]),
                other_amount_threshold=int(data.get("otherAmountThreshold", 0)),
                swap_mode=swap_mode,
                slippage_bps=slippage,
                price_impact_pct=float(data.get("priceImpactPct", 0)),
                route_plan=data.get("routePlan", []),
                context_slot=data.get("contextSlot", 0),
                raw_response=data,
            )

        except Exception as e:
            logger.error("quote_failed", error=str(e))
            raise

    async def build_swap_transaction(
        self,
        quote: Quote,
        user_public_key: str,
        wrap_unwrap_sol: bool = True,
    ) -> bytes:
        """
        Build a swap transaction from a quote.

        Args:
            quote: Jupiter quote
            user_public_key: User's wallet public key
            wrap_unwrap_sol: Whether to wrap/unwrap SOL automatically

        Returns:
            bytes: Serialized transaction
        """
        logger.info(
            "build_swap_transaction",
            in_amount=quote.in_amount,
            out_amount=quote.out_amount,
        )

        # Real API call
        http = await self._get_http_client()
        payload = {
            "quoteResponse": quote.raw_response,
            "userPublicKey": user_public_key,
            "wrapAndUnwrapSol": wrap_unwrap_sol,
        }

        try:
            response = await http.post(f"{self.api_url}/swap/v1/swap", json=payload)
            response.raise_for_status()
            data = response.json()

            # Decode base64 transaction
            swap_tx = base64.b64decode(data["swapTransaction"])
            return swap_tx

        except Exception as e:
            logger.error("build_swap_failed", error=str(e))
            raise

    async def execute_swap(
        self,
        quote: Quote,
        user_keypair: Optional[Keypair] = None,
    ) -> SwapResult:
        """
        Execute a swap.

        Args:
            quote: Jupiter quote
            user_keypair: User's keypair for signing

        Returns:
            SwapResult: Result of the swap
        """
        logger.info(
            "execute_swap",
            in_amount=quote.in_amount,
            out_amount=quote.out_amount,
            price_impact=quote.price_impact_pct,
        )

        try:
            solana = await self._get_solana_client()
            user_pubkey = str(solana.wallet_pubkey)

            # Build transaction
            tx_bytes = await self.build_swap_transaction(
                quote=quote,
                user_public_key=user_pubkey,
            )

            if not tx_bytes:
                return SwapResult(
                    success=False,
                    error="Failed to build transaction",
                )

            # Deserialize and sign
            tx = VersionedTransaction.from_bytes(tx_bytes)

            # Send transaction
            result = await solana.send_transaction(tx)

            if not result.success:
                return SwapResult(
                    success=False,
                    error=result.error,
                )

            # Wait for confirmation
            confirmed = await solana.confirm_transaction(result.signature)

            return SwapResult(
                success=confirmed,
                signature=result.signature,
                input_amount=quote.in_amount,
                output_amount=quote.out_amount,
                error=None if confirmed else "Transaction not confirmed",
            )

        except Exception as e:
            logger.error("swap_execution_failed", error=str(e))
            return SwapResult(
                success=False,
                error=str(e),
            )

    async def get_price(
        self,
        input_mint: str,
        output_mint: str,
    ) -> float:
        """
        Get current price for a token pair.

        Always fetches REAL price from Jupiter Price API - never returns mock data.

        Args:
            input_mint: Input token mint
            output_mint: Output token mint

        Returns:
            float: Price of input in terms of output
        """
        logger.info("get_price", input_mint=input_mint, output_mint=output_mint)

        # Always try to get real price from Jupiter Price API
        try:
            http = await self._get_http_client()
            response = await http.get(
                f"{self.api_url}/price",
                params={"ids": input_mint, "vsToken": output_mint},
            )
            response.raise_for_status()
            data = response.json()
            price = float(data.get("data", {}).get(input_mint, {}).get("price", 0))
            if price > 0:
                return price
        except Exception as e:
            logger.warning("jupiter_price_fetch_failed", error=str(e))

        # Fallback: try v6 price API (migrated from deprecated price/v2)
        try:
            http = await self._get_http_client()
            response = await http.get(
                "https://api.jup.ag/v6/price",
                params={"ids": input_mint, "vsToken": output_mint},
            )
            response.raise_for_status()
            data = response.json()
            price = float(data.get("data", {}).get(input_mint, {}).get("price", 0))
            if price > 0:
                return price
        except Exception as e:
            logger.warning("jupiter_price_v2_fetch_failed", error=str(e))

        logger.error("price_fetch_failed", input_mint=input_mint)
        return 0.0


class JupiterUltraClient:
    """
    Client for Jupiter Ultra API.

    Ultra API combines quote + transaction into a single call and handles
    transaction submission, reducing RPC dependency and enabling rewards.

    Endpoints:
    - GET /order: Get quote + unsigned transaction
    - POST /execute: Submit signed transaction

    Reference: https://dev.jup.ag/docs/ultra-api
    """

    ULTRA_BASE_URL = "https://api.jup.ag/ultra/v1"

    def __init__(
        self,
        api_key: Optional[str] = None,
        gasless_enabled: bool = True,
        circuit_breaker_threshold: int = 3,
        circuit_breaker_cooldown: int = 300,
    ):
        """
        Initialize the Ultra client.

        Args:
            api_key: Jupiter API key (required)
            gasless_enabled: Enable gasless transactions when eligible
            circuit_breaker_threshold: Failures before circuit breaker opens
            circuit_breaker_cooldown: Seconds before retrying after circuit opens
        """
        self._api_key = api_key
        self._gasless_enabled = gasless_enabled
        self._circuit_breaker_threshold = circuit_breaker_threshold
        self._circuit_breaker_cooldown = circuit_breaker_cooldown
        self._http_client: Optional[httpx.AsyncClient] = None

        # Circuit breaker state
        self._consecutive_failures: int = 0
        self._circuit_open_until: Optional[float] = None

    async def _get_http_client(self) -> httpx.AsyncClient:
        """Get or create HTTP client with retry on closed."""
        if self._http_client is None or self._http_client.is_closed:
            if self._http_client is not None:
                try:
                    await self._http_client.aclose()
                except Exception:
                    pass

            headers = {"Content-Type": "application/json"}
            if self._api_key:
                headers["x-api-key"] = self._api_key

            self._http_client = httpx.AsyncClient(
                timeout=30.0,
                headers=headers,
            )
        return self._http_client

    def is_circuit_open(self) -> bool:
        """Check if circuit breaker is open (too many failures)."""
        if self._circuit_open_until is None:
            return False
        if time.time() > self._circuit_open_until:
            # Reset circuit breaker
            self._circuit_open_until = None
            self._consecutive_failures = 0
            logger.info("ultra_circuit_breaker_reset")
            return False
        return True

    def _record_failure(self):
        """Record a failure and potentially open circuit breaker."""
        self._consecutive_failures += 1
        if self._consecutive_failures >= self._circuit_breaker_threshold:
            self._circuit_open_until = time.time() + self._circuit_breaker_cooldown
            logger.warning(
                "ultra_circuit_breaker_open",
                failures=self._consecutive_failures,
                cooldown_seconds=self._circuit_breaker_cooldown,
            )

    def _record_success(self):
        """Record a success, resetting failure counter."""
        self._consecutive_failures = 0
        self._circuit_open_until = None

    async def get_order(
        self,
        input_mint: str,
        output_mint: str,
        amount: int,
        taker: str,
        slippage_bps: int = 50,
    ) -> UltraOrder:
        """
        Get an order (quote + unsigned transaction) from Ultra API.

        Args:
            input_mint: Input token mint address
            output_mint: Output token mint address
            amount: Amount to swap (in smallest units)
            taker: Wallet public key that will sign/receive
            slippage_bps: Slippage tolerance (manual mode)

        Returns:
            UltraOrder with transaction ready to sign
        """
        logger.info(
            "ultra_get_order",
            input_mint=input_mint[-8:],
            output_mint=output_mint[-8:],
            amount=amount,
            slippage_bps=slippage_bps,
        )

        http = await self._get_http_client()
        params = {
            "inputMint": input_mint,
            "outputMint": output_mint,
            "amount": str(amount),
            "taker": taker,
            "slippageBps": slippage_bps,  # Manual slippage mode
        }

        try:
            response = await http.get(f"{self.ULTRA_BASE_URL}/order", params=params)
            response.raise_for_status()
            data = response.json()

            # Check for error in response (when transaction is null)
            if data.get("transaction") is None:
                error_code = data.get("errorCode")
                error_msg = data.get("errorMessage", "No transaction returned")
                raise RuntimeError(f"Ultra order failed (code {error_code}): {error_msg}")

            # Decode transaction
            tx_bytes = base64.b64decode(data["transaction"])

            return UltraOrder(
                request_id=data["requestId"],
                input_mint=input_mint,
                output_mint=output_mint,
                in_amount=amount,
                out_amount=int(data["outAmount"]),
                slippage_bps=int(data.get("slippageBps", slippage_bps)),
                price_impact_pct=float(data.get("priceImpactPct", 0)),
                transaction=tx_bytes,
                gasless=data.get("gasless", False),
                router=data.get("router", "unknown"),
                fee_bps=int(data.get("feeBps", 0)),
                raw_response=data,
            )

        except httpx.HTTPStatusError as e:
            error_msg = f"Ultra /order failed: {e.response.status_code}"
            try:
                error_data = e.response.json()
                error_msg = f"{error_msg} - {error_data.get('error', str(error_data))}"
            except Exception:
                pass
            logger.error("ultra_order_failed", error=error_msg)
            raise RuntimeError(error_msg) from e
        except Exception as e:
            logger.error("ultra_order_exception", error=str(e))
            raise

    async def execute_order(
        self,
        order: UltraOrder,
        signed_transaction: bytes,
    ) -> UltraSwapResult:
        """
        Execute a signed order via Ultra API.

        Jupiter handles transaction submission and confirmation.

        Args:
            order: The order from get_order()
            signed_transaction: Transaction signed by taker wallet

        Returns:
            UltraSwapResult with execution details
        """
        start_time = time.time()

        logger.info(
            "ultra_execute_order",
            request_id=order.request_id,
            gasless=order.gasless,
            router=order.router,
        )

        http = await self._get_http_client()
        payload = {
            "signedTransaction": base64.b64encode(signed_transaction).decode("utf-8"),
            "requestId": order.request_id,
        }

        try:
            response = await http.post(f"{self.ULTRA_BASE_URL}/execute", json=payload)
            response.raise_for_status()
            data = response.json()

            execution_time_ms = int((time.time() - start_time) * 1000)

            status = data.get("status", "unknown")
            if status == "Success":
                self._record_success()
                return UltraSwapResult(
                    success=True,
                    signature=data.get("signature"),
                    input_amount=order.in_amount,
                    output_amount=order.out_amount,
                    output_amount_result=int(data.get("outputAmountResult", order.out_amount)),
                    gasless_used=order.gasless,
                    execution_time_ms=execution_time_ms,
                    request_id=order.request_id,
                    swap_events=data.get("swapEvents"),
                    fee_bps=order.fee_bps,
                    router=order.router,
                )
            else:
                error_msg = f"Ultra execute status: {status} - {data.get('error', 'unknown')}"
                self._record_failure()
                return UltraSwapResult(
                    success=False,
                    error=error_msg,
                    request_id=order.request_id,
                    execution_time_ms=execution_time_ms,
                )

        except httpx.HTTPStatusError as e:
            execution_time_ms = int((time.time() - start_time) * 1000)
            error_msg = f"Ultra /execute failed: {e.response.status_code}"
            try:
                error_data = e.response.json()
                error_msg = f"{error_msg} - {error_data.get('error', str(error_data))}"
            except Exception:
                pass
            self._record_failure()
            logger.error("ultra_execute_failed", error=error_msg)
            return UltraSwapResult(
                success=False,
                error=error_msg,
                request_id=order.request_id,
                execution_time_ms=execution_time_ms,
            )
        except Exception as e:
            execution_time_ms = int((time.time() - start_time) * 1000)
            self._record_failure()
            logger.error("ultra_execute_exception", error=str(e))
            return UltraSwapResult(
                success=False,
                error=str(e),
                request_id=order.request_id,
                execution_time_ms=execution_time_ms,
            )

    async def execute_swap(
        self,
        input_mint: str,
        output_mint: str,
        amount: int,
        taker_keypair: Keypair,
        slippage_bps: int = 50,
    ) -> UltraSwapResult:
        """
        High-level swap execution using Ultra API.

        Combines get_order + sign + execute_order into single call.

        Args:
            input_mint: Input token mint
            output_mint: Output token mint
            amount: Amount in smallest units
            taker_keypair: Wallet keypair for signing
            slippage_bps: Slippage tolerance

        Returns:
            UltraSwapResult
        """
        try:
            # Step 1: Get order (quote + unsigned tx)
            order = await self.get_order(
                input_mint=input_mint,
                output_mint=output_mint,
                amount=amount,
                taker=str(taker_keypair.pubkey()),
                slippage_bps=slippage_bps,
            )

            logger.info(
                "ultra_order_received",
                out_amount=order.out_amount,
                gasless=order.gasless,
                router=order.router,
                fee_bps=order.fee_bps,
            )

            # Step 2: Sign transaction
            tx = VersionedTransaction.from_bytes(order.transaction)
            signed_tx = VersionedTransaction(tx.message, [taker_keypair])
            signed_tx_bytes = bytes(signed_tx)

            # Step 3: Execute via Ultra API
            result = await self.execute_order(order, signed_tx_bytes)

            return result

        except Exception as e:
            logger.error("ultra_swap_failed", error=str(e))
            return UltraSwapResult(
                success=False,
                error=str(e),
            )

    async def close(self):
        """Close HTTP client."""
        if self._http_client:
            await self._http_client.aclose()
            self._http_client = None


class JupiterSwapService:
    """
    Unified Jupiter swap service that auto-selects between Swap API and Ultra API.

    Selection logic:
    1. If use_ultra=False -> Always use Swap API
    2. If Ultra circuit breaker is open -> Use Swap API (fallback)
    3. Otherwise -> Use Ultra API

    Provides automatic fallback from Ultra to Swap API on failures.
    """

    def __init__(
        self,
        use_ultra: bool = False,
        ultra_gasless: bool = True,
        fallback_enabled: bool = True,
        circuit_breaker_threshold: int = 3,
        circuit_breaker_cooldown: int = 300,
        api_key: Optional[str] = None,
    ):
        """
        Initialize the swap service.

        Args:
            use_ultra: Whether to use Ultra API
            ultra_gasless: Enable gasless when using Ultra
            fallback_enabled: Fall back to Swap API on Ultra failure
            circuit_breaker_threshold: Ultra failures before fallback
            circuit_breaker_cooldown: Seconds before retrying Ultra
            api_key: Jupiter API key
        """
        self._use_ultra = use_ultra
        self._ultra_gasless = ultra_gasless
        self._fallback_enabled = fallback_enabled
        self._circuit_breaker_threshold = circuit_breaker_threshold
        self._circuit_breaker_cooldown = circuit_breaker_cooldown
        self._api_key = api_key

        # Lazy-initialized clients
        self._swap_client: Optional[JupiterClient] = None
        self._ultra_client: Optional[JupiterUltraClient] = None

    async def _get_swap_client(self) -> JupiterClient:
        """Get or create Swap API client."""
        if self._swap_client is None:
            self._swap_client = JupiterClient(api_key=self._api_key)
        return self._swap_client

    async def _get_ultra_client(self) -> JupiterUltraClient:
        """Get or create Ultra API client."""
        if self._ultra_client is None:
            self._ultra_client = JupiterUltraClient(
                api_key=self._api_key,
                gasless_enabled=self._ultra_gasless,
                circuit_breaker_threshold=self._circuit_breaker_threshold,
                circuit_breaker_cooldown=self._circuit_breaker_cooldown,
            )
        return self._ultra_client

    def _should_use_ultra(self) -> bool:
        """Determine if Ultra API should be used for this swap."""
        if not self._use_ultra:
            return False

        # Check circuit breaker
        if self._ultra_client and self._ultra_client.is_circuit_open():
            logger.info("ultra_circuit_open_using_swap_api")
            return False

        return True

    async def execute_swap(
        self,
        input_mint: str,
        output_mint: str,
        amount: int,
        taker_keypair: Keypair,
        slippage_bps: int = 50,
    ) -> SwapResult:
        """
        Execute a swap using the best available API.

        Returns a unified SwapResult regardless of which API was used.

        Args:
            input_mint: Input token mint
            output_mint: Output token mint
            amount: Amount in smallest units
            taker_keypair: Wallet keypair for signing
            slippage_bps: Slippage tolerance

        Returns:
            SwapResult with execution details
        """
        use_ultra = self._should_use_ultra()

        logger.info(
            "swap_service_execute",
            use_ultra=use_ultra,
            input_mint=input_mint[-8:],
            output_mint=output_mint[-8:],
            amount=amount,
        )

        if use_ultra:
            result = await self._execute_via_ultra(
                input_mint, output_mint, amount, taker_keypair, slippage_bps
            )

            # Fallback to Swap API if Ultra failed and fallback is enabled
            if not result.success and self._fallback_enabled:
                logger.warning(
                    "ultra_failed_falling_back",
                    error=result.error,
                )
                result = await self._execute_via_swap(
                    input_mint, output_mint, amount, taker_keypair, slippage_bps
                )

            return result
        else:
            return await self._execute_via_swap(
                input_mint, output_mint, amount, taker_keypair, slippage_bps
            )

    async def _execute_via_ultra(
        self,
        input_mint: str,
        output_mint: str,
        amount: int,
        taker_keypair: Keypair,
        slippage_bps: int,
    ) -> SwapResult:
        """Execute swap via Ultra API and convert to SwapResult."""
        ultra_client = await self._get_ultra_client()

        ultra_result = await ultra_client.execute_swap(
            input_mint=input_mint,
            output_mint=output_mint,
            amount=amount,
            taker_keypair=taker_keypair,
            slippage_bps=slippage_bps,
        )

        # Use actual result amount if available
        output_amount = ultra_result.output_amount_result or ultra_result.output_amount

        return SwapResult(
            success=ultra_result.success,
            signature=ultra_result.signature,
            input_amount=ultra_result.input_amount,
            output_amount=output_amount,
            error=ultra_result.error,
        )

    async def _execute_via_swap(
        self,
        input_mint: str,
        output_mint: str,
        amount: int,
        taker_keypair: Keypair,
        slippage_bps: int,
    ) -> SwapResult:
        """Execute swap via Swap API."""
        swap_client = await self._get_swap_client()

        # Get quote
        quote = await swap_client.get_quote(
            input_mint=input_mint,
            output_mint=output_mint,
            amount=amount,
            slippage_bps=slippage_bps,
        )

        # Execute swap
        result = await swap_client.execute_swap(
            quote=quote,
            user_keypair=taker_keypair,
        )

        return result

    async def close(self):
        """Close all clients."""
        if self._swap_client:
            await self._swap_client.close()
        if self._ultra_client:
            await self._ultra_client.close()


# Singleton instances
_default_client: Optional[JupiterClient] = None
_default_api_key: Optional[str] = None


async def get_jupiter_swap_service(
    use_ultra: bool = False,
    ultra_gasless: bool = True,
    fallback_enabled: bool = True,
    circuit_breaker_threshold: int = 3,
    circuit_breaker_cooldown: int = 300,
    api_key: Optional[str] = None,
) -> JupiterSwapService:
    """
    Get or create a JupiterSwapService instance.

    Note: This creates a new instance each time for flexibility.
    For singleton behavior, use get_jupiter_client() for Swap API.

    Args:
        use_ultra: Whether to use Ultra API
        ultra_gasless: Enable gasless when using Ultra
        fallback_enabled: Fall back to Swap API on Ultra failure
        circuit_breaker_threshold: Ultra failures before fallback
        circuit_breaker_cooldown: Seconds before retrying Ultra
        api_key: Jupiter API key

    Returns:
        JupiterSwapService instance
    """
    return JupiterSwapService(
        use_ultra=use_ultra,
        ultra_gasless=ultra_gasless,
        fallback_enabled=fallback_enabled,
        circuit_breaker_threshold=circuit_breaker_threshold,
        circuit_breaker_cooldown=circuit_breaker_cooldown,
        api_key=api_key,
    )


async def get_jupiter_client(api_key: Optional[str] = None) -> JupiterClient:
    """
    Get or create the default Jupiter client singleton.
    
    Args:
        api_key: Jupiter API key (required for api.jup.ag endpoints).
                 If provided, will create/update client with this key.
                 If None, uses existing client or creates one without key.
    
    Returns:
        JupiterClient: Jupiter client instance
    """
    global _default_client, _default_api_key
    
    # If API key provided and different from current, recreate client
    if api_key is not None and api_key != _default_api_key:
        if _default_client is not None:
            await _default_client.close()
        _default_client = None
        _default_api_key = api_key
    
    # Create client if needed
    if _default_client is None:
        # Try to get API key from settings if not provided
        if api_key is None:
            # Check if settings has jupiter_api_key attribute
            if hasattr(settings, 'jupiter_api_key') and settings.jupiter_api_key:
                api_key = settings.jupiter_api_key
            _default_api_key = api_key
        else:
            _default_api_key = api_key
        
        _default_client = JupiterClient(api_key=_default_api_key)
    
    return _default_client
