#!/usr/bin/env python3
"""
LP Strategy Orchestrator v2.

Main entry point that orchestrates:
- Market analysis (ATR, volatility, range calculation)
- Position monitoring (holdings, fees, IL)
- Session management (tracking, aggregation)
- Rebalance decisions based on rules

Rebalance Rules:
1. Price out of range -> rebalance (if daily limit not reached)
2. Ratio skew (>=85% or <=15% for insrance (depending on configuratuion) in one token) -> rebalance
3. Emergency: intraday move > 3x ATR -> emergency rebalance (once/day)
4. ATR change >=10% and >=12h since last range update -> update targets

Constraints: for instance 
-i.e. Max 2 normal rebalances per day
- i.e. Max 1 emergency rebalance per day
(depending on config values)
- Range clamped to [3%, 7%]
"""

import asyncio
import signal
import sys
import os
import logging
import argparse
import json
from datetime import datetime, timezone, timedelta, date
from decimal import Decimal
from typing import Optional, List
from aiohttp import web

from dotenv import load_dotenv

# Load environment before importing config
load_dotenv()

from config import get_config, Config
from market_analyzer import MarketAnalyzer, MarketState
from position_monitor import PositionMonitor, PositionSnapshot, SolanaRPCClient
from session_manager import SessionManager, get_session_manager, SwapRecord
from execution import (
    TradeExecutor,
    get_trade_executor,
    calculate_range,
    price_to_tick,
    tick_to_price,
    SwapResult,
    PositionOpenResult,
    PositionCloseResult,
    RebalanceResult,
)
from email_notifier import EmailNotifier, get_email_notifier
from csv_logger import CSVLogger, get_csv_logger
from app.chain.orca_api_client import get_orca_api_client, OrcaAPIClient

# Helius client for parsing ACTUAL fees from transactions
from app.chain.helius_client import (
    HeliusClient,
    initialize_helius_client,
    get_helius_client,
)

# wSOL cleanup imports - added for automatic wSOL account cleanup
try:
    from app.chain.wsol_cleanup import (
        get_wsol_cleanup_manager,
        cleanup_wsol,
        get_wsol_balance,
        CleanupResult,
    )
    WSOL_CLEANUP_AVAILABLE = True
except ImportError:
    WSOL_CLEANUP_AVAILABLE = False
    # Define a minimal CleanupResult for type hints when module unavailable
    from dataclasses import dataclass
    @dataclass
    class CleanupResult:
        success: bool = False
        accounts_cleaned: int = 0
        total_sol_recovered: float = 0.0
        error: Optional[str] = None

logger = logging.getLogger(__name__)

# Graceful shutdown
shutdown_requested = False


def signal_handler(signum, frame):
    global shutdown_requested
    logger.info(f"Received signal {signum}, initiating graceful shutdown...")
    shutdown_requested = True


signal.signal(signal.SIGTERM, signal_handler)
signal.signal(signal.SIGINT, signal_handler)


# ============================================================
# HEALTH CHECK SERVER
# ============================================================

class HealthCheckServer:
    """
    Simple HTTP server for fly.io health checks and status monitoring.

    Endpoints:
    - GET /health - Basic health check (returns 200 if running)
    - GET /status - Detailed status with current state
    - GET /metrics - Prometheus-style metrics
    """

    def __init__(self, orchestrator: 'LPStrategyOrchestrator', port: int = 8080):
        self.orchestrator = orchestrator
        self.port = port
        self.app = web.Application()
        self.runner = None
        self._start_time = datetime.now(timezone.utc)

        # Setup routes
        self.app.router.add_get('/health', self.health_handler)
        self.app.router.add_get('/status', self.status_handler)
        self.app.router.add_get('/metrics', self.metrics_handler)
        self.app.router.add_get('/', self.health_handler)

    async def health_handler(self, request):
        """Basic health check - returns 200 if service is running."""
        return web.json_response({
            'status': 'healthy',
            'service': 'lp-strategy-v2',
            'timestamp': datetime.now(timezone.utc).isoformat(),
        })

    async def status_handler(self, request):
        """Detailed status endpoint."""
        uptime = (datetime.now(timezone.utc) - self._start_time).total_seconds()

        status = {
            'status': 'running' if self.orchestrator._running else 'stopped',
            'uptime_seconds': int(uptime),
            'timestamp': datetime.now(timezone.utc).isoformat(),
        }

        # Add market state if available
        if self.orchestrator._last_market_state:
            market = self.orchestrator._last_market_state
            status['market'] = {
                'price': float(market.price),
                'atr_pct': float(market.atr * 100),
                'lower_target': float(market.lower_target),
                'upper_target': float(market.upper_target),
            }

        # Add position info if available
        if self.orchestrator.position_monitors:
            positions = []
            for addr, monitor in self.orchestrator.position_monitors.items():
                positions.append({
                    'address': addr[:8] + '...',
                    'in_range': monitor._in_range if hasattr(monitor, '_in_range') else None,
                })
            status['positions'] = positions

        # Add session info if available
        if self.orchestrator.session_manager and self.orchestrator.session_manager.is_active:
            session = self.orchestrator.session_manager
            status['session'] = {
                'active': True,
                'start_time': session._start_time.isoformat() if session._start_time else None,
                'rebalances': len(session._rebalances) if hasattr(session, '_rebalances') else 0,
            }

        return web.json_response(status)

    async def metrics_handler(self, request):
        """Prometheus-style metrics endpoint."""
        uptime = (datetime.now(timezone.utc) - self._start_time).total_seconds()

        lines = [
            '# HELP lp_strategy_up LP Strategy service status (1 = up)',
            '# TYPE lp_strategy_up gauge',
            f'lp_strategy_up 1',
            '',
            '# HELP lp_strategy_uptime_seconds Service uptime in seconds',
            '# TYPE lp_strategy_uptime_seconds counter',
            f'lp_strategy_uptime_seconds {int(uptime)}',
        ]

        if self.orchestrator._last_market_state:
            market = self.orchestrator._last_market_state
            lines.extend([
                '',
                '# HELP lp_strategy_price_usd Current SOL price in USD',
                '# TYPE lp_strategy_price_usd gauge',
                f'lp_strategy_price_usd {market.price:.4f}',
                '',
                '# HELP lp_strategy_atr_pct ATR percentage',
                '# TYPE lp_strategy_atr_pct gauge',
                f'lp_strategy_atr_pct {market.atr * 100:.4f}',
            ])

        return web.Response(
            text='\n'.join(lines) + '\n',
            content_type='text/plain'
        )

    async def start(self):
        """Start the health check server."""
        self.runner = web.AppRunner(self.app)
        await self.runner.setup()
        site = web.TCPSite(self.runner, '0.0.0.0', self.port)
        await site.start()
        logger.info(f"Health check server started on port {self.port}")

    async def stop(self):
        """Stop the health check server."""
        if self.runner:
            await self.runner.cleanup()
            logger.info("Health check server stopped")


class LPStrategyOrchestrator:
    """
    Main orchestrator for the LP strategy.

    Coordinates between market analyzer, position monitor, and session manager
    to implement the ATR-based range strategy with rebalance rules.
    """

    def __init__(self, config: Optional[Config] = None):
        self.config = config or get_config()

        # Components
        self.rpc: Optional[SolanaRPCClient] = None
        self.market_analyzer: Optional[MarketAnalyzer] = None
        self.session_manager: Optional[SessionManager] = None
        self.position_monitors: dict[str, PositionMonitor] = {}

        # Trade executor for live execution
        self.trade_executor: Optional[TradeExecutor] = None

        # Email notifier
        self.email_notifier: Optional[EmailNotifier] = None

        # CSV logger for LP Management and Asset/Fees tracking
        self.csv_logger: Optional[CSVLogger] = None

        # Orca API client for TVL and volume metrics
        self.orca_api_client: Optional[OrcaAPIClient] = None

        # Helius client for parsing ACTUAL fees from transactions
        self.helius_client: Optional[HeliusClient] = None

        # State
        self._running = False
        self._last_market_state: Optional[MarketState] = None
        self._price_at_last_rebalance: Optional[float] = None
        self._last_range_update: Optional[datetime] = None

        # Current targets (updated by market analyzer)
        self._lower_target: Optional[float] = None
        self._upper_target: Optional[float] = None

        # Current position tick range
        self._lower_tick: Optional[int] = None
        self._upper_tick: Optional[int] = None

        # wSOL cleanup tracking
        self._wsol_cleanup_manager = None
        self._last_wsol_cleanup_iteration: int = 0

        # Stop-loss tracking (per-position)
        self._position_last_in_range_at: dict[str, datetime] = {}  # Last time each position was in range (keyed by position address)
        self._stop_loss_last_triggered_at: dict[str, datetime] = {}  # Last time stop-loss was executed for each position (for cooldown)
        self._stop_loss_occurred_date: Optional[date] = None  # Date when stop-loss was last triggered (to defer recovery until next day)

        # Upward rebalance tracking (per-position)
        self._last_upward_rebalance_at: dict[str, datetime] = {}  # Last time upward rebalance was executed for each position (for cooldown)

        # Recovery state - set when rebalance fails to open new position
        # See execution.py module docstring "FAILED POSITION OPEN HANDLING & RECOVERY FLOW"
        # for comprehensive documentation on how this recovery system works.
        #
        # Summary:
        # - _needs_position_recovery: Set to True when rebalance close succeeds but open fails
        # - _recovery_reason: The original reason for the rebalance that triggered failure
        # - _recovery_attempts: Counter for recovery attempts in subsequent iterations
        # - _max_recovery_attempts: Maximum attempts before requiring manual intervention
        #
        # Recovery is triggered in _run_iteration when len(position_monitors) == 0
        self._needs_position_recovery: bool = False
        self._recovery_reason: Optional[str] = None
        self._recovery_attempts: int = 0
        self._max_recovery_attempts: int = 8

    async def _calculate_total_portfolio_value(self, market_state: MarketState) -> tuple[float, float]:
        """
        Calculate total portfolio value including wallet and tracked positions.
        
        This is used to ensure capital deployment limits are respected across
        the entire portfolio, not just wallet balance.
        
        IMPORTANT: Reserve value fluctuates with SOL price, so we include it in
        total portfolio calculation to account for this fluctuation.
        
        Args:
            market_state: Current market state with price
            
        Returns:
            Tuple of (total_portfolio_usd, already_deployed_usd)
        """
        # Get wallet balance
        wallet_value = 0.0
        sol_balance = 0.0
        usdc_balance = 0.0
        if self.trade_executor:
            try:
                sol_balance, usdc_balance = await self.trade_executor.get_balances()
                # Include ALL wallet balance (including reserve) in total portfolio
                # Reserve value fluctuates with SOL price, so we need to account for it
                wallet_value = (sol_balance * market_state.price) + usdc_balance
            except Exception as e:
                logger.warning(f"Failed to get wallet balance for portfolio calculation: {e}")
        
        # Get tracked positions value
        already_deployed = 0.0
        for pos_addr, monitor in self.position_monitors.items():
            try:
                snapshot = await monitor.get_snapshot()
                if snapshot:
                    already_deployed += snapshot.current_value_usd
            except Exception as e:
                logger.warning(f"Failed to get snapshot for position {pos_addr}: {e}")
        
        # Total portfolio = wallet (including reserve) + positions
        # This accounts for reserve value fluctuation with SOL price
        total_portfolio = wallet_value + already_deployed
        
        return total_portfolio, already_deployed

    async def _get_email_context(self) -> dict:
        """
        Get common context data for email notifications.
        Returns current market, wallet, pool and session state plus all calculation data.
        """
        context = {
            'price': 0.0,
            'atr_pct': 0.0,
            'atr_absolute': 0.0,
            'lower_target': 0.0,
            'upper_target': 0.0,
            'sol_balance': 0.0,
            'usdc_balance': 0.0,
            'pool_address': self.config.pool.pool_address,
            'tick_current': 0,
            'liquidity': 0,
            'session_state': None,
            # Pool debugging fields
            'pool_sqrt_price': 0,
            'price_source': 'pool',  # Always 'pool' - we use on-chain pool price
            # Range calculation fields
            'raw_range_pct': 0.0,
            'clamped_range_pct': 0.0,
            # Strategy parameters
            'k_coefficient': self.config.range.k_coefficient,
            'min_range_pct': self.config.range.min_range,
            'max_range_pct': self.config.range.max_range,
            'atr_period_days': self.config.atr.period_days,
            'max_rebalances_per_day': self.config.rebalance.max_rebalances_per_day,
            'slippage_bps': self.config.rebalance.slippage_bps,
            # Capital parameters
            'sol_reserve': self.config.capital.min_sol_reserve,
            'deployment_pct': self.config.capital.deployment_pct,
            'max_sol_per_position': self.config.capital.max_sol_per_position,
            'max_usdc_per_position': self.config.capital.max_usdc_per_position,
            # Calculated available amounts
            'available_sol': 0.0,
            'available_usdc': 0.0,
        }

        # Market state
        # NOTE: All values remain as decimals (0.0581 = 5.81%), display functions handle formatting
        if self._last_market_state:
            context['price'] = self._last_market_state.price
            context['atr_pct'] = self._last_market_state.atr  # Decimal: 0.0581 = 5.81%
            context['atr_absolute'] = self._last_market_state.atr_absolute
            context['lower_target'] = self._lower_target or self._last_market_state.lower_target
            context['upper_target'] = self._upper_target or self._last_market_state.upper_target
            context['raw_range_pct'] = self._last_market_state.raw_range  # Decimal: 0.0349 = 3.49%
            context['clamped_range_pct'] = self._last_market_state.clamped_range

        # Wallet balances
        if self.trade_executor:
            try:
                sol_bal, usdc_bal = await self.trade_executor.get_balances()
                context['sol_balance'] = sol_bal
                context['usdc_balance'] = usdc_bal
                # Calculate available amounts after reserve
                context['available_sol'] = max(0, sol_bal - self.config.capital.min_sol_reserve)
                context['available_usdc'] = usdc_bal

                # IMPORTANT: Update session manager with fresh balances before getting summary
                # This ensures PnL calculations use current wallet state
                if self.session_manager and self.session_manager.is_active and self._last_market_state:
                    self.session_manager.update_wallet_balance(
                        Decimal(str(sol_bal)),
                        Decimal(str(usdc_bal)),
                        Decimal(str(self._last_market_state.price))
                    )
            except Exception:
                pass

        # Pool state
        if self.trade_executor:
            try:
                pool_state = await self.trade_executor.get_pool_state()
                if pool_state:
                    context['tick_current'] = getattr(pool_state, 'tick_current_index', 0)
                    context['liquidity'] = getattr(pool_state, 'liquidity', 0)
                    context['pool_sqrt_price'] = getattr(pool_state, 'sqrt_price', 0)
            except Exception:
                pass

        # Session state
        if self.session_manager and self.session_manager.is_active:
            context['session_state'] = self.session_manager.get_session_summary(
                Decimal(str(context['price']))
            )

        return context

    async def _get_pool_metrics_for_csv(self) -> tuple[float, float, float]:
        """
        Get pool metrics (TVL, fee_tier, volume_24h) for CSV logging.

        Returns:
            Tuple of (tvl, fee_tier, volume_24h)
            - tvl: Pool TVL in USD (0.0 if unavailable)
            - fee_tier: Pool fee tier as decimal (e.g., 0.0004 for 0.04%, defaults to 0.0004)
            - volume_24h: Pool 24h volume in USD (0.0 if unavailable)
        """
        tvl = 0.0
        fee_tier = 0.0004  # Default to 0.04% fee tier
        volume_24h = 0.0

        try:
            # Try Orca API first for TVL and volume
            if self.orca_api_client:
                pool_metrics = await self.orca_api_client.get_pool_metrics(
                    self.config.pool.pool_address
                )
                if pool_metrics:
                    tvl = pool_metrics.tvl
                    volume_24h = pool_metrics.volume_24h
                    # Fee rate from API is in decimal form (e.g., 0.0004)
                    # Note: Only use API fee_rate if it looks correct (not default 0.003 for 4bps pool)
                    if pool_metrics.fee_rate > 0:
                        fee_tier = pool_metrics.fee_rate
                    logger.info(f"Pool metrics from Orca API: TVL=${tvl:,.0f}, Vol24h=${volume_24h:,.0f}, fee={fee_tier:.6f}")
                    # Only return early if we got valid TVL from API
                    # If TVL is 0, continue to on-chain calculation
                    if tvl > 0:
                        return tvl, fee_tier, volume_24h
                    else:
                        logger.info("Orca API returned TVL=$0, falling back to on-chain calculation")

            # Get fee_tier from on-chain pool state (more reliable than API for this pool)
            if self.trade_executor:
                pool_state = await self.trade_executor.get_pool_state()
                if pool_state:
                    # On-chain fee_rate is in hundredths of a basis point (e.g., 400 = 4 bps = 0.04%)
                    on_chain_fee_rate = getattr(pool_state, 'fee_rate', 0)
                    if on_chain_fee_rate > 0:
                        fee_tier = on_chain_fee_rate / 1000000.0  # Convert hundredths of bps to decimal (400 -> 0.0004)
                    fee_tier_bps = on_chain_fee_rate / 100.0  # Convert to bps for logging (400 -> 4)
                    logger.info(f"Fee tier from on-chain: {fee_tier:.6f} ({fee_tier_bps:.0f} bps)")

            # Calculate TVL from on-chain vault balances (primary method for this pool)
            if tvl == 0.0 and self.trade_executor:
                from pool_metrics_calculator import calculate_tvl_from_pool_state
                pool_state = await self.trade_executor.get_pool_state()
                if pool_state:
                    tvl, sol_in_pool, usdc_in_pool = await calculate_tvl_from_pool_state(pool_state)
                    logger.info(f"TVL from on-chain calculation: ${tvl:,.0f} (SOL={sol_in_pool:.2f}, USDC=${usdc_in_pool:,.0f})")

        except Exception as e:
            logger.warning(f"Failed to get pool metrics for CSV: {e}")

        return tvl, fee_tier, volume_24h

    async def _parse_actual_fees(
        self,
        tx_signature: str,
        estimated_fees_sol: float = 0.0,
        estimated_fees_usdc: float = 0.0,
    ) -> tuple[float, float]:
        """
        Get realized fees for a position close.

        Uses snapshot-based pending fees as the authoritative source.
        Helius parsing is skipped since it consistently fails to separate
        fees from principal in single-transfer close transactions.

        The snapshot pending fees are calculated from on-chain fee growth data
        (fee_growth_global - fee_growth_checkpoint) * liquidity, which is the
        same math the Whirlpool program uses when collecting fees.

        Args:
            tx_signature: The transaction signature (for logging only)
            estimated_fees_sol: Fees from snapshot pending_fees_a (SOL)
            estimated_fees_usdc: Fees from snapshot pending_fees_b (USDC)

        Returns:
            Tuple of (fees_sol, fees_usdc) from snapshot calculation
        """
        logger.info(f"  Realized fees (from snapshot): {estimated_fees_sol:.6f} SOL, ${estimated_fees_usdc:.2f} USDC")
        if tx_signature:
            logger.debug(f"  Close tx: {tx_signature[:16]}...")

        return (estimated_fees_sol, estimated_fees_usdc)

    async def _perform_wsol_cleanup(self, reason: str = "manual") -> Optional[CleanupResult]:
        """
        Perform wSOL cleanup if enabled.

        Args:
            reason: Reason for cleanup (for logging)

        Returns:
            CleanupResult or None if cleanup is disabled/unavailable
        """
        if not WSOL_CLEANUP_AVAILABLE:
            logger.debug("wsol_cleanup_not_available")
            return None

        if not self.config.wsol_cleanup.enabled:
            logger.debug("wsol_cleanup_disabled_in_config")
            return None

        try:
            # Get or initialize the cleanup manager
            if self._wsol_cleanup_manager is None:
                self._wsol_cleanup_manager = await get_wsol_cleanup_manager()

            logger.info(f"Performing wSOL cleanup ({reason})...")

            # Check for leftover wSOL first
            wsol_balance = await get_wsol_balance()
            if wsol_balance <= 0:
                logger.info("No wSOL accounts to cleanup")
                return CleanupResult(success=True, accounts_cleaned=0)

            logger.info(f"Found {wsol_balance:.6f} wSOL to cleanup")

            # Perform cleanup
            result = await self._wsol_cleanup_manager.cleanup_wsol_accounts(
                min_balance_lamports=self.config.wsol_cleanup.min_balance_lamports,
            )

            if result.success:
                if result.accounts_cleaned > 0:
                    logger.info(
                        f"wSOL cleanup complete: {result.accounts_cleaned} accounts closed, "
                        f"{result.total_sol_recovered:.6f} SOL recovered"
                    )
                else:
                    logger.info("wSOL cleanup: No accounts needed cleanup")

                if result.skipped_accounts:
                    logger.warning(
                        f"wSOL cleanup: {len(result.skipped_accounts)} accounts skipped "
                        "(delegation or frozen)"
                    )
            else:
                logger.error(f"wSOL cleanup failed: {result.error}")

            # Get current price for USD conversion
            current_price = Decimal(0)
            try:
                if self.market_analyzer:
                    market_state = await self.market_analyzer.get_market_state()
                    if market_state:
                        current_price = Decimal(str(market_state.price))
            except Exception as price_err:
                logger.debug(f"Could not get current price for wSOL cleanup cost tracking: {price_err}")

            # Record cleanup in session manager (if session is active)
            if self.session_manager and self.session_manager.is_active:
                self.session_manager.record_wsol_cleanup(
                    accounts_cleaned=result.accounts_cleaned,
                    sol_recovered=Decimal(str(result.total_sol_recovered)),
                    success=result.success,
                    error=result.error,
                    reason=reason,
                    tx_fee_sol=Decimal(str(result.tx_fee_sol)),
                    current_price=current_price,
                )

            return result

        except Exception as e:
            logger.error(f"wSOL cleanup error: {e}")
            # Record failed cleanup
            if self.session_manager and self.session_manager.is_active:
                self.session_manager.record_wsol_cleanup(
                    accounts_cleaned=0,
                    sol_recovered=Decimal(0),
                    success=False,
                    error=str(e),
                    reason=reason,
                    tx_fee_sol=Decimal(0),
                    current_price=Decimal(0),
                )
            return CleanupResult(success=False, error=str(e))

    async def initialize(self) -> bool:
        """Initialize all components."""
        logger.info("=" * 60)
        logger.info("LP STRATEGY v2 - INITIALIZING")
        logger.info("=" * 60)

        # Validate config
        errors = self.config.validate()
        if errors:
            for err in errors:
                logger.error(f"Config error: {err}")
            return False

        self.config.log_config(logger)

        # Initialize RPC client
        self.rpc = SolanaRPCClient(self.config.api.rpc_url)

        # Initialize market analyzer
        self.market_analyzer = MarketAnalyzer(self.config)

        # Initialize session manager
        self.session_manager = get_session_manager()

        # Initialize email notifier
        if self.config.email.enabled:
            self.email_notifier = get_email_notifier(data_dir=self.config.session.data_dir)
            logger.info(f"Email notifications enabled: {len(self.config.email.recipients)} recipients")
        else:
            logger.info("Email notifications disabled")

        # Initialize CSV logger for LP Management and Asset/Fees tracking
        self.csv_logger = get_csv_logger()
        logger.info(f"CSV logger initialized: {self.config.session.data_dir}")

        # Initialize Orca API client for TVL and volume metrics
        self.orca_api_client = get_orca_api_client()
        logger.info("Orca API client initialized")

        # Initialize Helius client for parsing ACTUAL fees from transactions
        if self.config.api.helius_api_key:
            initialize_helius_client(self.config.api.helius_api_key)
            self.helius_client = get_helius_client()
            logger.info("Helius client initialized (ACTUAL fee extraction enabled)")
        else:
            logger.warning("HELIUS_API_KEY not set - fee extraction will use estimates instead of actual values")

        # Initialize trade executor for LIVE execution
        logger.info("Initializing trade executor for LIVE execution...")
        self.trade_executor = await get_trade_executor(self.config)
        logger.info("Trade executor initialized")

        # CRITICAL: Configure market analyzer to use pool price (not Birdeye)
        # This ensures all range calculations use authoritative on-chain price
        async def fetch_pool_price() -> Optional[float]:
            """Fetch current price from pool state (authoritative on-chain price).

            CRITICAL: Uses force_refresh=True to ensure we get the CURRENT price
            from on-chain, not cached data. This is essential for accurate range
            calculations and rebalance decisions.
            """
            try:
                if not self.trade_executor:
                    return None
                # CRITICAL: force_refresh=True ensures we get CURRENT price, not cached
                pool_state = await self.trade_executor.get_pool_state(force_refresh=True)
                if pool_state:
                    return pool_state.current_price
                return None
            except Exception as e:
                logger.error(f"Error fetching pool price: {e}")
                return None

        self.market_analyzer._pool_price_fetcher = fetch_pool_price
        logger.info("MarketAnalyzer configured to use POOL PRICE (not Birdeye) for range calculations")

        # Perform wSOL cleanup on startup if enabled
        if self.config.wsol_cleanup.enabled and self.config.wsol_cleanup.cleanup_on_startup:
            logger.info("Running startup wSOL cleanup...")
            cleanup_result = await self._perform_wsol_cleanup(reason="startup")

            # Wait for cleanup transactions to be confirmed and balances to update
            # This ensures the recovered SOL is reflected in wallet balance calculations
            if cleanup_result and cleanup_result.success and cleanup_result.accounts_cleaned > 0:
                logger.info("Waiting 8 seconds for cleanup transactions to be confirmed...")
                await asyncio.sleep(8)  # Increased from 5 to 8 seconds for full confirmation
                logger.info("Proceeding with initialization using updated balances")

                # CRITICAL FIX: Refetch balances after cleanup to ensure updated values
                # Without this, the portfolio calculation uses stale pre-cleanup balances
                if self.trade_executor:
                    try:
                        sol_after, usdc_after = await self.trade_executor.get_balances()
                        logger.info(f"Post-cleanup balances verified: {sol_after:.4f} SOL, ${usdc_after:.2f} USDC")
                        if cleanup_result.total_sol_recovered > 0:
                            logger.info(f"✅ Recovered {cleanup_result.total_sol_recovered:.4f} SOL from wSOL cleanup")
                    except Exception as e:
                        logger.warning(f"Failed to verify post-cleanup balances: {e}")

        # Get initial market state (now uses pool price for targets)
        logger.info("Fetching initial market data...")
        market_state = await self.market_analyzer.get_market_state()
        if not market_state:
            logger.error("Failed to get initial market state")
            return False

        self._last_market_state = market_state
        # NOTE: _lower_target and _upper_target are stored for display/logging purposes only
        # Fresh targets are ALWAYS recalculated from current pool price when opening positions
        self._lower_target = market_state.lower_target
        self._upper_target = market_state.upper_target
        self._last_range_update = datetime.now(timezone.utc)

        logger.info(f"Initial price: ${market_state.price:.4f}")
        logger.info(f"ATR: {market_state.atr * 100:.2f}%")
        logger.info(f"Target range: ${market_state.lower_target:.4f} - ${market_state.upper_target:.4f}")

        # Get initial balances from actual wallet
        initial_price = Decimal(str(market_state.price))
        if self.trade_executor:
            try:
                sol_balance, usdc_balance = await self.trade_executor.get_balances()
                initial_sol = Decimal(str(sol_balance))
                initial_usdc = Decimal(str(usdc_balance))
                logger.info(f"Initial wallet balances: {initial_sol:.4f} SOL, {initial_usdc:.2f} USDC")
            except Exception as e:
                logger.warning(f"Failed to get wallet balances, using config defaults: {e}")
                initial_sol = Decimal(str(self.config.capital.max_sol_per_position))
                initial_usdc = Decimal(str(self.config.capital.max_usdc_per_position))
        else:
            #Fallback: use config defaults if trade_executor not initialized
            initial_sol = Decimal(str(self.config.capital.max_sol_per_position))
            initial_usdc = Decimal(str(self.config.capital.max_usdc_per_position))
            logger.info(f"Using config balances: {initial_sol:.4f} SOL, {initial_usdc:.2f} USDC")

        # Start session
        self.session_manager.start_session(initial_sol, initial_usdc, initial_price)

        # Set session ID for email notifier
        if self.email_notifier and self.session_manager.state:
            self.email_notifier.set_session_id(self.session_manager.state.session_id)

        logger.info("=" * 60)
        logger.info("INITIALIZATION COMPLETE")
        logger.info("=" * 60)

        # Send app started email notification
        if self.email_notifier:
            try:
                self.email_notifier.notify_app_started(
                    session_id=self.session_manager.state.session_id,
                    price=market_state.price,
                    atr_pct=market_state.atr,  # Decimal format (0.0648 = 6.48%), _format_pct_from_decimal handles display
                    lower_target=market_state.lower_target,
                    upper_target=market_state.upper_target,
                    sol_balance=float(initial_sol),
                    usdc_balance=float(initial_usdc),
                    pool_address=self.config.pool.pool_address,
                )
            except Exception as e:
                logger.warning(f"Failed to send app started email: {e}")

        return True

    async def run(
        self,
        position_address: Optional[str] = None,
        open_price: Optional[float] = None
    ):
        """
        Main strategy loop.

        Args:
            position_address: Existing position to monitor (or None to create new)
            open_price: Opening price for existing position
        """
        if not await self.initialize():
            logger.error("Initialization failed")
            return

        self._running = True
        iteration = 0

        # If we have an existing position, set it up for monitoring
        if position_address:
            monitor = PositionMonitor(
                rpc_client=self.rpc,
                position_address=position_address,
                open_price=open_price,
                config=self.config,
            )
            if await monitor.initialize():
                self.position_monitors[position_address] = monitor
                self._price_at_last_rebalance = open_price or self._last_market_state.price

                # Register with session
                snapshot = await monitor.get_snapshot()
                if snapshot:
                    self.session_manager.register_position(
                        position_address=position_address,
                        open_price=snapshot.open_price,
                        initial_token_a=snapshot.initial_token_a,
                        initial_token_b=snapshot.initial_token_b,
                        lower_price=snapshot.lower_price,
                        upper_price=snapshot.upper_price,
                    )
        else:
            # No existing position - open a new one
            logger.info("No existing position provided - opening new position...")
            await self._open_initial_position()

        logger.info("=" * 60)
        logger.info("STRATEGY LOOP STARTED")
        logger.info("=" * 60)

        end_reason = "shutdown"  # Default reason

        while self._running and not shutdown_requested:
            iteration += 1

            try:
                await self._run_iteration(iteration)
            except Exception as e:
                logger.exception(f"Error in iteration {iteration}: {e}")

            # Check session duration limit
            if self.config.session.duration_minutes > 0:
                session_state = self.session_manager.state
                if session_state:
                    elapsed = (datetime.now(timezone.utc) - session_state.start_time).total_seconds() / 60
                    if elapsed >= self.config.session.duration_minutes:
                        logger.info(f"Session duration limit reached ({self.config.session.duration_minutes} min)")
                        end_reason = "duration_limit"
                        break

            # Wait for next iteration
            await asyncio.sleep(self.config.session.check_interval_seconds)

        # Determine end reason if loop exited due to shutdown signal
        if shutdown_requested:
            end_reason = "manual_stop"

        # End session with proper reason
        await self._shutdown(end_reason=end_reason)

    async def _open_initial_position(self):
        """
        Open initial position with current market state.

        Uses the trade executor to:
        1. Check and swap tokens if needed for balance
        2. Calculate tick range from ATR-based targets
        3. Open position

        CRITICAL: Fetches FRESH market state to ensure range targets are calculated
        from current pool price, not stale cached values.
        """
        if not self.trade_executor:
            logger.error("Trade executor not available")
            # Set recovery flag so _run_iteration() will attempt recovery
            self._needs_position_recovery = True
            self._recovery_reason = "initial_position_no_trade_executor"
            self._recovery_attempts = 0
            return

        # Get fresh market state instead of using cached _last_market_state
        # This ensures targets are calculated from CURRENT pool price
        logger.info("Fetching fresh market state for position open...")
        market_state = await self.market_analyzer.get_market_state()
        if not market_state:
            logger.error("Failed to get market state for position open")
            # Set recovery flag so _run_iteration() will attempt recovery
            self._needs_position_recovery = True
            self._recovery_reason = "initial_position_no_market_state"
            self._recovery_attempts = 0
            return

        # Fetch pool's actual state from on-chain
        # This is CRITICAL - using wrong tick_spacing causes InvalidTickIndex error
        try:
            pool_state = await self.trade_executor.get_pool_state()
            if not pool_state:
                logger.error("Failed to get pool state")
                # Set recovery flag so _run_iteration() will attempt recovery
                self._needs_position_recovery = True
                self._recovery_reason = "initial_position_no_pool_state"
                self._recovery_attempts = 0
                return
            tick_spacing = pool_state.tick_spacing
            logger.info(f"Pool tick_spacing from on-chain: {tick_spacing}")

            # Record pool state to CSV (so it's available in email attachments)
            if self.csv_logger:
                self.csv_logger.log_pool_state(
                    price=pool_state.current_price,
                    sqrt_price=getattr(pool_state, 'sqrt_price', 0),
                    tick_current=getattr(pool_state, 'tick_current_index', 0),
                    tick_spacing=tick_spacing,
                    liquidity=getattr(pool_state, 'liquidity', 0),
                    fee_rate=getattr(pool_state, 'fee_rate', 0),
                    fee_growth_global_a=getattr(pool_state, 'fee_growth_global_a', 0),
                    fee_growth_global_b=getattr(pool_state, 'fee_growth_global_b', 0),
                    pool_address=self.config.pool.pool_address,
                )
        except Exception as e:
            logger.error(f"Failed to get pool state: {e}")
            # Set recovery flag so _run_iteration() will attempt recovery
            self._needs_position_recovery = True
            self._recovery_reason = f"initial_position_pool_state_exception: {str(e)}"
            self._recovery_attempts = 0
            return

        # Calculate tick range from FRESH targets (from current pool price)
        lower_tick = price_to_tick(market_state.lower_target, tick_spacing)
        upper_tick = price_to_tick(market_state.upper_target, tick_spacing)

        # Get capital deployment from config - use deployment_pct to calculate from wallet balance
        # CRITICAL FIX: Apply deployment_pct only ONCE to avoid double application
        deployment_pct = self.config.capital.deployment_pct
        sol_reserve = self.config.capital.min_sol_reserve

        # Get current balances to calculate deployment amount
        sol_balance, usdc_balance = await self.trade_executor.get_balances()

        # Calculate total portfolio value (wallet + existing positions)
        total_portfolio, already_deployed = await self._calculate_total_portfolio_value(market_state)
        
        # Check if this is the first position
        is_first_position = (already_deployed == 0 and len(self.position_monitors) == 0)

        # Initialize remaining_deployable for threshold checks
        target_deployment = total_portfolio * deployment_pct
        remaining_deployable = target_deployment - already_deployed

        if is_first_position:
            # FIRST POSITION: Use wallet-based limits directly (apply deployment_pct once)
            # Since total_portfolio = wallet_value for first position, portfolio calculation is redundant
            # Apply deployment_pct directly to wallet balances
            # Note: Swap mechanism in open_position_with_rebalance() will balance tokens if needed,
            # and execution.py will recalculate max_sol/max_usdc from post-swap balances
            # Simple: deploy deployment_pct of available wallet
            # Note: CLMM typically uses ~90% of provided capital, so actual deployment will be ~deployment_pct * 0.90
            max_sol = (sol_balance - sol_reserve) * deployment_pct
            max_usdc = usdc_balance * deployment_pct
        else:
            # SUBSEQUENT POSITIONS: Use portfolio-based limits (deployment_pct applied once in remaining_deployable)
            # Convert remaining deployable to SOL/USDC (assume 50/50 split)
            remaining_sol_usd = remaining_deployable / 2
            remaining_usdc_usd = remaining_deployable / 2
            remaining_sol = remaining_sol_usd / market_state.price if market_state.price > 0 else 0
            remaining_usdc = remaining_usdc_usd

            # Use wallet balances directly (NOT multiplied by deployment_pct - already applied in remaining_deployable)
            # Take minimum to respect both portfolio limits and wallet availability
            # Note: CLMM typically uses ~90% of provided capital, so actual deployment will be ~remaining_deployable * 0.90
            max_sol = min(sol_balance - sol_reserve, remaining_sol)
            max_usdc = min(usdc_balance, remaining_usdc)
        
        # Ensure non-negative
        max_sol = max(0, max_sol)
        max_usdc = max(0, max_usdc)
        
        # Respect configured maximums as upper bounds (safety limits)
        max_sol = min(max_sol, self.config.capital.max_sol_per_position)
        max_usdc = min(max_usdc, self.config.capital.max_usdc_per_position)
        
        # Log portfolio-aware calculation WITH DETAILED BREAKDOWN
        logger.info("=" * 80)
        logger.info("CAPITAL DEPLOYMENT CALCULATION (Initial Position)")
        logger.info("=" * 80)
        logger.info(f"RAW WALLET BALANCES:")
        logger.info(f"  SOL: {sol_balance:.4f} SOL (${sol_balance * market_state.price:.2f})")
        logger.info(f"  USDC: ${usdc_balance:.2f}")
        logger.info(f"  Reserve: {sol_reserve:.4f} SOL (${sol_reserve * market_state.price:.2f})")
        logger.info(f"  Available SOL: {sol_balance - sol_reserve:.4f} SOL (${(sol_balance - sol_reserve) * market_state.price:.2f})")
        logger.info(f"")
        logger.info(f"PORTFOLIO ANALYSIS:")
        logger.info(f"  Total portfolio: ${total_portfolio:.2f}")
        logger.info(f"  - Wallet value: ${total_portfolio - already_deployed:.2f}")
        logger.info(f"  - Already deployed: ${already_deployed:.2f}")
        logger.info(f"")
        if is_first_position:
            logger.info(f"TARGET DEPLOYMENT ({deployment_pct*100:.0f}%):")
            logger.info(f"  Total wallet value: ${total_portfolio:.2f}")
            logger.info(f"  Target deployment: ${total_portfolio * deployment_pct:.2f}")
            logger.info(f"  Provided to CLMM:")
            logger.info(f"    SOL: {max_sol:.4f} (${max_sol * market_state.price:.2f})")
            logger.info(f"    USDC: ${max_usdc:.2f}")
            logger.info(f"    Total provided: ${(max_sol * market_state.price) + max_usdc:.2f}")
            # Expected actual deployment after CLMM uses ~90% of provided
            expected_actual = (max_sol * market_state.price + max_usdc) * 0.90
            logger.info(f"    Expected actual deployment (~90% of provided): ${expected_actual:.2f} ({expected_actual / total_portfolio * 100:.1f}% of wallet)")
        else:
            logger.info(f"TARGET DEPLOYMENT ({deployment_pct*100:.0f}%):")
            logger.info(f"  Target from portfolio: ${target_deployment:.2f}")
            logger.info(f"  Remaining deployable: ${remaining_deployable:.2f}")
            logger.info(f"  Remaining as 50/50: {remaining_sol:.4f} SOL + ${remaining_usdc:.2f} USDC")
            logger.info(f"")
            logger.info(f"WALLET AVAILABILITY (not multiplied by deployment_pct):")
            logger.info(f"  Available SOL: {sol_balance - sol_reserve:.4f} SOL (${(sol_balance - sol_reserve) * market_state.price:.2f})")
            logger.info(f"  Available USDC: ${usdc_balance:.2f}")
            logger.info(f"")
            logger.info(f"FINAL DEPLOYMENT (min of portfolio-limited & wallet-available):")
            logger.info(f"  SOL: {max_sol:.4f} (${max_sol * market_state.price:.2f})")
            logger.info(f"  USDC: ${max_usdc:.2f}")
            logger.info(f"  Total: ${(max_sol * market_state.price) + max_usdc:.2f}")
            logger.info(f"  Deployment %: {((max_sol * market_state.price) + max_usdc) / total_portfolio * 100:.1f}% of portfolio")
        logger.info("=" * 80)
        
        # Calculate final deployment value
        total_value = (max_sol * market_state.price) + max_usdc
        
        # CRITICAL: Check minimum deployment threshold
        # Small positions are not worth opening due to transaction costs
        # Better to wait for next rebalance to accumulate more capital
        min_deployment = self.config.capital.min_deployment_usd
        
        # If remaining deployable is negative, don't deploy
        if remaining_deployable < 0:
            logger.warning(f"⚠️  Portfolio deployment limit exceeded: ${already_deployed:.2f} / ${target_deployment:.2f} ({already_deployed/target_deployment*100:.1f}%)")
            logger.warning("  Deployment limit already exceeded - will not deploy additional capital")
            max_sol = 0
            max_usdc = 0
            total_value = 0
        # If remaining deployable is below minimum threshold, skip deployment
        elif remaining_deployable < min_deployment:
            logger.info(f"ℹ️  Remaining deployable (${remaining_deployable:.2f}) below minimum threshold (${min_deployment:.2f})")
            logger.info(f"  Skipping position opening - transaction costs would exceed benefits")
            logger.info(f"  Will wait for next rebalance to accumulate more capital")
            logger.info(f"  Note: Reserve value fluctuation may cause small discrepancies")
            max_sol = 0
            max_usdc = 0
            total_value = 0
        # If calculated position value is below minimum, also skip
        elif total_value < min_deployment:
            logger.info(f"ℹ️  Calculated position value (${total_value:.2f}) below minimum threshold (${min_deployment:.2f})")
            logger.info(f"  Skipping position opening - position too small to be cost-effective")
            logger.info(f"  Will wait for next rebalance to accumulate more capital")
            max_sol = 0
            max_usdc = 0
            total_value = 0
        elif remaining_deployable < min_deployment * 1.5:  # Warn if close to threshold
            logger.warning(f"⚠️  Remaining deployable (${remaining_deployable:.2f}) close to minimum threshold (${min_deployment:.2f})")
            logger.warning("  Consider adjusting deployment_pct or manually deployed positions")
            logger.warning("  Note: Reserve value fluctuation may cause small discrepancies")

        # Calculate liquidity (simplified)
        liquidity = int(total_value * 1e6) if total_value > 0 else 0

        # If deployment was skipped due to minimum threshold, set recovery flag to retry
        if total_value == 0:
            logger.info("=" * 50)
            logger.info("SKIPPING INITIAL POSITION OPENING")
            logger.info("=" * 50)
            logger.info("Reason: Deployment amount below minimum threshold")
            logger.info("Action: Setting recovery flag to retry on next iteration")
            # Set recovery flag so _run_iteration() will attempt recovery
            self._needs_position_recovery = True
            self._recovery_reason = "initial_position_skipped_minimum_threshold"
            self._recovery_attempts = 0
            return

        logger.info("=" * 50)
        logger.info("OPENING INITIAL POSITION")
        logger.info("=" * 50)
        logger.info(f"Pool price: ${market_state.price:.4f}")
        logger.info(f"Target range: ${market_state.lower_target:.4f} - ${market_state.upper_target:.4f}")
        logger.info(f"Ticks: [{lower_tick}, {upper_tick}] (tick_spacing={tick_spacing})")
        logger.info(f"Max SOL: {max_sol:.4f}")
        logger.info(f"Max USDC: ${max_usdc:.2f}")

        # ================================================================================
        # CRITICAL FIX: Cleanup wSOL before opening position
        # ================================================================================
        # If wallet has any wSOL (from previous operations, external transfers, or swaps),
        # it must be unwrapped to native SOL BEFORE position opening.
        # Otherwise, Orca will use native SOL balance only, leaving wSOL idle and
        # causing insufficient capital deployment.
        #
        # BUG FIX: This was causing positions to open with <95% of intended capital
        # ================================================================================
        # Note: This cleanup happens AFTER startup cleanup (line 733) to ensure
        # no wSOL exists right before position open for accurate balance calculations
        if self.config.wsol_cleanup.enabled:
            try:
                wsol_balance = await get_wsol_balance()
                if wsol_balance > 0.01:  # More than 0.01 SOL in wSOL
                    logger.info(f"Pre-position-open wSOL cleanup: found {wsol_balance:.4f} wSOL")
                    await self._perform_wsol_cleanup(reason="pre_initial_open")
                    await asyncio.sleep(2)  # Wait for cleanup to finalize
                    # Refetch balances to get updated values
                    sol_balance, usdc_balance = await self.trade_executor.get_balances()
                    logger.info(f"Updated balances after cleanup: SOL={sol_balance:.4f}, USDC=${usdc_balance:.2f}")
            except Exception as e:
                logger.warning(f"Pre-position wSOL cleanup failed: {e}")

        try:
            # Open position with rebalance (includes swap if needed)
            # Returns tuple: (PositionOpenResult, Optional[SwapResult])
            open_result, swap_result = await self.trade_executor.open_position_with_rebalance(
                lower_tick=lower_tick,
                upper_tick=upper_tick,
                max_sol=max_sol,
                max_usdc=max_usdc,
                liquidity=liquidity,
            )

            if swap_result:
                logger.info(f"Pre-position swap executed: {swap_result.input_amount:.4f} -> {swap_result.output_amount:.4f}")
                # Note: Swap email notification is sent AFTER CSV logging below

            if open_result.success:
                logger.info(f"Position opened: {open_result.position_address}")
                logger.info(f"  Signature: {open_result.signature}")
                logger.info(f"  Deposited: {open_result.deposited_sol:.4f} SOL, ${open_result.deposited_usdc:.2f} USDC")

                # ================================================================================
                # CRITICAL FIX: Cleanup wSOL after position opening
                # ================================================================================
                # During position opening, native SOL is wrapped into wSOL ATA, then the
                # increase_liquidity instruction consumes only what's needed for the position.
                # Any REMAINING wSOL must be unwrapped back to native SOL to ensure full
                # capital deployment in future operations.
                #
                # BUG FIX: Previously this only WARNED about remaining wSOL but didn't clean it up,
                # causing ~$500 of capital to sit idle as wSOL instead of being deployed.
                # ================================================================================
                try:
                    wsol_balance = await get_wsol_balance()
                    if wsol_balance > 0.01:  # Any meaningful wSOL should be cleaned up
                        logger.info(f"Post-position wSOL cleanup: found {wsol_balance:.4f} wSOL (~${wsol_balance * market_state.price:.2f})")
                        logger.info(f"  This is normal - excess from SOL wrapping during position opening")
                        logger.info(f"  Cleaning up to convert back to native SOL...")

                        cleanup_result = await self._perform_wsol_cleanup(reason="post_position_open")

                        if cleanup_result and cleanup_result.success and cleanup_result.accounts_cleaned > 0:
                            logger.info(f"  ✅ Post-position wSOL cleanup: recovered {cleanup_result.total_sol_recovered:.4f} SOL")
                            await asyncio.sleep(2)  # Wait for cleanup to finalize

                            # Verify cleanup worked
                            remaining_wsol = await get_wsol_balance()
                            if remaining_wsol < 0.01:
                                logger.info(f"  ✅ Cleanup successful - {remaining_wsol:.6f} wSOL remaining (dust)")
                            else:
                                logger.warning(f"  ⚠️  {remaining_wsol:.4f} wSOL still remains after cleanup!")
                        elif cleanup_result and cleanup_result.success:
                            logger.info(f"  ℹ️  No wSOL accounts to cleanup (already native SOL)")
                        else:
                            logger.error(f"  ❌ Post-position wSOL cleanup failed: {cleanup_result.error if cleanup_result else 'unknown error'}")
                            logger.error(f"     {wsol_balance:.4f} wSOL (~${wsol_balance * market_state.price:.2f}) remains idle!")
                    else:
                        logger.info(f"ℹ️  Minimal wSOL after position open: {wsol_balance:.6f} SOL (dust - OK)")
                except Exception as e:
                    logger.error(f"Failed to cleanup wSOL after position open: {e}")

                # Set up monitoring for new position with ACTUAL deposited amounts for accurate IL tracking
                monitor = PositionMonitor(
                    rpc_client=self.rpc,
                    position_address=open_result.position_address,
                    open_price=market_state.price,
                    config=self.config,
                    initial_token_a=open_result.deposited_sol,  # Actual deposited SOL
                    initial_token_b=open_result.deposited_usdc,  # Actual deposited USDC
                )
                if await monitor.initialize():
                    self.position_monitors[open_result.position_address] = monitor

                    # Register with session
                    self.session_manager.register_position(
                        position_address=open_result.position_address,
                        open_price=Decimal(str(market_state.price)),
                        initial_token_a=Decimal(str(open_result.deposited_sol)),
                        initial_token_b=Decimal(str(open_result.deposited_usdc)),
                        lower_price=Decimal(str(open_result.lower_price)),
                        upper_price=Decimal(str(open_result.upper_price)),
                    )

                    # Update cumulative transaction costs (by category)
                    # Use per-operation ActualCost from balance diffs (ground truth)
                    open_actual_cost = getattr(open_result, 'actual_cost', None)
                    swap_actual_cost = getattr(swap_result, 'actual_cost', None) if swap_result else None

                    logger.info("=" * 60)
                    logger.info("Transaction Costs - Initial position (per-operation actual):")
                    logger.info("=" * 60)
                    
                    if open_actual_cost:
                        self.session_manager.state.add_cost(
                            'position_open',
                            Decimal(str(open_actual_cost.actual_cost_sol)),
                            Decimal(str(open_actual_cost.actual_cost_usd))
                        )
                        logger.info(f"  Open:   ${open_actual_cost.actual_cost_usd:.4f} ({open_actual_cost.actual_cost_sol:.6f} SOL)")
                        logger.info(f"    Balance before: ${open_actual_cost.value_before_usd:.2f}")
                        logger.info(f"    Balance after:  ${open_actual_cost.value_after_usd:.2f}")
                        logger.info(f"    Position value: ${open_actual_cost.position_value_usd:.2f}")
                    else:
                        logger.warning("COST TRACKING: open_result.actual_cost is None for initial open — cost not recorded")

                    if swap_actual_cost:
                        self.session_manager.state.add_cost(
                            'swap',
                            Decimal(str(swap_actual_cost.actual_cost_sol)),
                            Decimal(str(swap_actual_cost.actual_cost_usd))
                        )
                        logger.info(f"  Swap:   ${swap_actual_cost.actual_cost_usd:.4f} ({swap_actual_cost.actual_cost_sol:.6f} SOL) [includes slippage]")
                        logger.info(f"    Balance before: ${swap_actual_cost.value_before_usd:.2f}")
                        logger.info(f"    Balance after:  ${swap_actual_cost.value_after_usd:.2f}")
                    elif swap_result and swap_result.success:
                        logger.warning("COST TRACKING: swap_result.actual_cost is None for successful swap — cost not recorded")

                    total_initial = (
                        (open_actual_cost.actual_cost_usd if open_actual_cost else 0.0) +
                        (swap_actual_cost.actual_cost_usd if swap_actual_cost else 0.0)
                    )
                    logger.info(f"  TOTAL:  ${total_initial:.4f}")
                    
                    # Log cumulative costs for verification
                    cost_breakdown = self.session_manager.state.get_cost_breakdown()
                    logger.info(f"Transaction Costs - Cumulative:")
                    logger.info(f"  Position Open:  ${cost_breakdown['by_category_usd']['position_open']:.4f}")
                    logger.info(f"  Position Close: ${cost_breakdown['by_category_usd']['position_close']:.4f}")
                    logger.info(f"  Swaps:          ${cost_breakdown['by_category_usd']['swap']:.4f}")
                    logger.info(f"  Net Open/Close: ${cost_breakdown.get('net_open_close_usd', 0):.4f}")
                    logger.info(f"  Total Net:      ${cost_breakdown['total_usd']:.4f}")
                    logger.info("=" * 60)
                else:
                    # CRITICAL FIX: Handle monitor initialization failure during initial position open
                    # Position was opened but we can't monitor it - trigger recovery
                    logger.error(f"CRITICAL: Monitor initialization failed for initial position {open_result.position_address}")
                    logger.error("Position exists on-chain but cannot be monitored - triggering recovery")
                    logger.error(f"Position signature for manual verification: {open_result.signature}")
                    self._needs_position_recovery = True
                    self._recovery_reason = "monitor_init_failed_initial_position"
                    self._recovery_attempts = 0

                    # Send email notification about this critical failure
                    if self.email_notifier:
                        try:
                            self.email_notifier.notify_position_lost(
                                position_address=open_result.position_address,
                                reason="monitor_init_failed",
                                details=f"Initial position opened successfully (sig: {open_result.signature}) but monitor.initialize() failed. "
                                       f"Position may exist on-chain. Recovery triggered.",
                                price=market_state.price,
                                session_state=self.session_manager.get_session_state_for_email(),
                            )
                        except Exception as e:
                            logger.warning(f"Failed to send position lost email: {e}")

                # Update tracking state
                self._price_at_last_rebalance = market_state.price
                self._lower_tick = open_result.lower_tick
                self._upper_tick = open_result.upper_tick

                # Log to CSV FIRST (before email) so attachments have data
                # Log swap to CSV (Asset/Fees sheet) if one occurred
                if self.csv_logger and swap_result and swap_result.success:
                    try:
                        self.csv_logger.log_swap(
                            direction=swap_result.direction or "unknown",
                            sol_amount=swap_result.input_amount if swap_result.direction == "sell_sol" else swap_result.output_amount,
                            usdc_amount=swap_result.output_amount if swap_result.direction == "sell_sol" else swap_result.input_amount,
                            price=market_state.price,
                            tx_signature=swap_result.signature,
                        )
                    except Exception as e:
                        logger.warning(f"Failed to log swap to CSV: {e}")

                # Log position open to CSV (LP Management sheet)
                if self.csv_logger:
                    try:
                        # Increment position index and get pool metrics
                        self.session_manager.state.current_position_index += 1
                        tvl, fee_tier, volume_24h = await self._get_pool_metrics_for_csv()

                        # CRITICAL: Ensure CSV values match email values exactly
                        csv_open_cost = open_actual_cost.actual_cost_usd if open_actual_cost else 0.0
                        csv_swap_cost = swap_actual_cost.actual_cost_usd if swap_actual_cost else 0.0
                        csv_total_cost = csv_open_cost + csv_swap_cost
                        
                        # Verify values match what will be sent in email
                        email_open_cost = open_actual_cost.actual_cost_usd if open_actual_cost else 0.0
                        email_swap_cost = swap_actual_cost.actual_cost_usd if swap_actual_cost else 0.0
                        email_total_cost = email_open_cost + email_swap_cost
                        
                        if abs(csv_open_cost - email_open_cost) > 0.0001:
                            logger.warning(f"CSV/EMAIL MISMATCH: Open cost differs - CSV: ${csv_open_cost:.4f}, Email: ${email_open_cost:.4f}")
                        if abs(csv_swap_cost - email_swap_cost) > 0.0001:
                            logger.warning(f"CSV/EMAIL MISMATCH: Swap cost differs - CSV: ${csv_swap_cost:.4f}, Email: ${email_swap_cost:.4f}")
                        if abs(csv_total_cost - email_total_cost) > 0.0001:
                            logger.warning(f"CSV/EMAIL MISMATCH: Total cost differs - CSV: ${csv_total_cost:.4f}, Email: ${email_total_cost:.4f}")

                        # Compute entry price from actual TX-parsed deposit amounts
                        entry_price = (
                            open_result.deposited_usdc / open_result.deposited_sol
                            if open_result.deposited_sol > 0
                            else market_state.price
                        )
                        self.csv_logger.log_position_open(
                            position_address=open_result.position_address,
                            entry_price=entry_price,
                            sol_amount=open_result.deposited_sol,
                            usdc_amount=open_result.deposited_usdc,
                            lower_price=open_result.lower_price,
                            upper_price=open_result.upper_price,
                            tx_signature=open_result.signature,
                            open_attempts=1,
                            tvl=tvl,
                            volume_24h=volume_24h,
                            position_index=self.session_manager.state.current_position_index,
                            open_tx_fee_sol=getattr(open_result, 'tx_fee_sol', 0.0),
                            swap_tx_fee_sol=swap_result.tx_fee_sol if swap_result else 0.0,
                            actual_cost_usd=csv_total_cost,  # Total cost (open + swap)
                            actual_cost_open_usd=csv_open_cost,  # Open operation cost only
                            actual_cost_swap_usd=csv_swap_cost,  # Swap operation cost only
                            market_price=market_state.price,
                        )
                        logger.info(f"CSV logged: Open=${csv_open_cost:.4f}, Swap=${csv_swap_cost:.4f}, Total=${csv_total_cost:.4f}")
                    except Exception as e:
                        logger.warning(f"Failed to log position open to CSV: {e}")

                # Send position opened email notification (AFTER CSV logging so attachments have data)
                if self.email_notifier:
                    try:
                        ctx = await self._get_email_context()
                        # Get actual costs from results if available
                        open_actual_cost = getattr(open_result, 'actual_cost', None)
                        swap_actual_cost = getattr(swap_result, 'actual_cost', None) if swap_result else None
                        
                        # Calculate total cost (open + swap if swap occurred)
                        open_cost_usd = open_actual_cost.actual_cost_usd if open_actual_cost else 0.0
                        swap_cost_usd = swap_actual_cost.actual_cost_usd if swap_actual_cost else 0.0
                        total_cost_usd = open_cost_usd + swap_cost_usd

                        self.email_notifier.notify_position_opened(
                            position_address=open_result.position_address,
                            lower_price=open_result.lower_price,
                            upper_price=open_result.upper_price,
                            deposited_sol=open_result.deposited_sol,
                            deposited_usdc=open_result.deposited_usdc,
                            price=ctx['price'],
                            atr_pct=ctx['atr_pct'],
                            lower_target=ctx['lower_target'],
                            upper_target=ctx['upper_target'],
                            sol_balance=ctx['sol_balance'],
                            usdc_balance=ctx['usdc_balance'],
                            pool_address=ctx['pool_address'],
                            session_state=ctx['session_state'],
                            tick_current=ctx['tick_current'],
                            liquidity=ctx['liquidity'],
                            pool_sqrt_price=ctx['pool_sqrt_price'],
                            price_source=ctx['price_source'],
                            # Range calculation parameters
                            atr_absolute=ctx['atr_absolute'],
                            raw_range_pct=ctx['raw_range_pct'],
                            clamped_range_pct=ctx['clamped_range_pct'],
                            # Strategy parameters
                            k_coefficient=ctx['k_coefficient'],
                            min_range_pct=ctx['min_range_pct'],
                            max_range_pct=ctx['max_range_pct'],
                            atr_period_days=ctx['atr_period_days'],
                            max_rebalances_per_day=ctx['max_rebalances_per_day'],
                            slippage_bps=ctx['slippage_bps'],
                            # Capital parameters
                            sol_reserve=ctx['sol_reserve'],
                            deployment_pct=ctx['deployment_pct'],
                            max_sol_per_position=ctx['max_sol_per_position'],
                            max_usdc_per_position=ctx['max_usdc_per_position'],
                            available_sol=ctx['available_sol'],
                            available_usdc=ctx['available_usdc'],
                            # Actual costs from balance diff (total and per-operation)
                            actual_cost_usd=total_cost_usd,  # Total cost (open + swap)
                            actual_cost_open_usd=open_cost_usd,  # Open operation cost only
                            actual_cost_swap_usd=swap_cost_usd,  # Swap operation cost only (if swap occurred)
                            entry_price=entry_price,  # Deposit ratio price
                        )
                    except Exception as e:
                        logger.warning(f"Failed to send position opened email: {e}")

                # Send swap email notification (AFTER CSV logging so attachments have data)
                if self.email_notifier and swap_result and swap_result.success:
                    try:
                        ctx = await self._get_email_context()
                        # Get actual cost from swap result if available
                        swap_actual_cost = getattr(swap_result, 'actual_cost', None)
                        swap_actual_cost_usd = swap_actual_cost.actual_cost_usd if swap_actual_cost else 0.0

                        self.email_notifier.notify_swap(
                            direction=swap_result.direction or "unknown",
                            input_amount=swap_result.input_amount,
                            output_amount=swap_result.output_amount,
                            input_token=swap_result.input_token or "?",
                            output_token=swap_result.output_token or "?",
                            reason="initial_position",
                            signature=swap_result.signature,
                            price=ctx['price'],
                            atr_pct=ctx['atr_pct'],
                            lower_target=ctx['lower_target'],
                            upper_target=ctx['upper_target'],
                            sol_balance=ctx['sol_balance'],
                            usdc_balance=ctx['usdc_balance'],
                            pool_address=ctx['pool_address'],
                            session_state=ctx['session_state'],
                            tick_current=ctx['tick_current'],
                            liquidity=ctx['liquidity'],
                            tx_fee_sol=swap_result.tx_fee_sol,
                            actual_cost_usd=swap_actual_cost_usd,
                        )
                    except Exception as e:
                        logger.warning(f"Failed to send swap email: {e}")

            else:
                logger.error(f"Failed to open position: {open_result.error}")
                # Set recovery flag so _run_iteration() will attempt recovery
                logger.info("Setting recovery flag to retry on next iteration")
                self._needs_position_recovery = True
                self._recovery_reason = f"initial_position_open_failed: {open_result.error}"
                self._recovery_attempts = 0

                # Send position open failed email
                if self.email_notifier:
                    try:
                        ctx = await self._get_email_context()
                        self.email_notifier.notify_position_open_failed(
                            error=open_result.error or "Unknown error",
                            context="initial",
                            sol_balance=ctx['sol_balance'],
                            usdc_balance=ctx['usdc_balance'],
                            price=ctx['price'],
                            atr_pct=ctx['atr_pct'],
                            lower_target=ctx['lower_target'],
                            upper_target=ctx['upper_target'],
                            pool_address=ctx['pool_address'],
                            session_state=ctx['session_state'],
                            recovery_scheduled=True,
                            recovery_attempts=0,
                            max_recovery_attempts=self._max_recovery_attempts,
                        )
                    except Exception as email_err:
                        logger.warning(f"Failed to send position open failed email: {email_err}")

        except Exception as e:
            logger.exception(f"Error opening initial position: {e}")
            # Set recovery flag so _run_iteration() will attempt recovery
            logger.info("Setting recovery flag to retry on next iteration")
            self._needs_position_recovery = True
            self._recovery_reason = f"initial_position_exception: {str(e)}"
            self._recovery_attempts = 0

            # Send position open failed email for exception
            if self.email_notifier:
                try:
                    ctx = await self._get_email_context()
                    self.email_notifier.notify_position_open_failed(
                        error=str(e),
                        context="initial",
                        sol_balance=ctx['sol_balance'],
                        usdc_balance=ctx['usdc_balance'],
                        price=ctx['price'],
                        atr_pct=ctx['atr_pct'],
                        lower_target=ctx['lower_target'],
                        upper_target=ctx['upper_target'],
                        pool_address=ctx['pool_address'],
                        session_state=ctx['session_state'],
                        recovery_scheduled=True,
                        recovery_attempts=0,
                        max_recovery_attempts=self._max_recovery_attempts,
                    )
                except Exception as email_err:
                    logger.warning(f"Failed to send position open failed email: {email_err}")

    async def _attempt_position_recovery(self, market_state: MarketState):
        """
        Attempt to recover by opening a new position when no active position exists.

        THIS IS PART OF THE CRITICAL RECOVERY MECHANISM FOR LIQUIDITY UTILIZATION.
        See execution.py module docstring "FAILED POSITION OPEN HANDLING & RECOVERY FLOW"
        for comprehensive documentation.

        This method is called when:
        1. A rebalance closed the old position but failed to open a new one
           (detected via _needs_position_recovery flag set in _execute_rebalance)
        2. No positions exist and the bot needs to create one
           (recovery_attempts < max_recovery_attempts serves as automatic retry)

        Key differences from _open_initial_position:
        - Recovery-specific logging with clear "POSITION RECOVERY ATTEMPT" header
        - Email notification on both success (notify_position_recovery) and failure
        - Tracking of recovery attempts via _recovery_attempts counter
        - Uses CURRENT market state (may differ from failed rebalance's state)
        - Conservative balance usage (90% of available) to account for potential issues

        Recovery Flow:
        1. Calculate new range targets from current market state
        2. Fetch current pool tick_spacing from on-chain
        3. Get wallet balances (funds should be sitting idle here)
        4. Calculate conservative max amounts (90% of available)
        5. Attempt open_position_with_rebalance (handles swaps if needed)
        6. On success:
           - Register new position with monitors and session
           - Clear all recovery flags
           - Send success email
        7. On failure:
           - Log error with attempt count
           - Leave flags set for next iteration retry

        Called from: _run_iteration() when len(position_monitors) == 0

        Args:
            market_state: Current market analysis including price, ATR, range targets

        Returns:
            None (updates internal state and sends notifications)
        """
        logger.info("=" * 60)
        logger.info("POSITION RECOVERY ATTEMPT")
        logger.info("=" * 60)

        if not self.trade_executor:
            logger.error("Trade executor not available for recovery")
            return

        # CRITICAL FIX: Check if any positions already exist on-chain before opening a new one
        # This prevents duplicate position opening if a position was opened but monitor initialization failed
        logger.info("Checking for existing positions on-chain before recovery...")
        try:
            # Check if we have any tracked positions first
            if len(self.position_monitors) > 0:
                logger.warning(f"Found {len(self.position_monitors)} tracked position(s) - skipping recovery")
                logger.warning("This should not happen if recovery check is working correctly")
                # Clear recovery flags since we have positions
                self._needs_position_recovery = False
                self._recovery_reason = None
                self._recovery_attempts = 0
                return
            
            # CRITICAL FIX: Query on-chain for existing positions before opening a new one
            # This catches positions that were opened but not tracked (e.g., position address extraction failed)
            logger.info("Querying on-chain for existing positions before recovery...")
            if self.trade_executor and hasattr(self.trade_executor, '_position_executor'):
                position_executor = self.trade_executor._position_executor
                if position_executor and hasattr(position_executor, '_orca_client'):
                    orca_client = position_executor._orca_client
                
                    if orca_client:
                        existing_positions = await orca_client.get_positions_for_wallet(
                            wallet_pubkey=None,  # Uses wallet from trade_executor
                            pool_pubkey=self.config.pool.pool_address,
                        )
                        
                        if existing_positions:
                            logger.warning(f"⚠️  CRITICAL: Found {len(existing_positions)} existing position(s) on-chain that are NOT tracked!")
                            logger.warning("These positions were opened but position address extraction or monitor initialization failed")

                            # Add each untracked position to monitors
                            positions_added = 0
                            for pos_state in existing_positions:
                                position_address = pos_state.pubkey

                                # Skip if already tracked
                                if position_address in self.position_monitors:
                                    logger.info(f"Position {position_address} already tracked, skipping")
                                    continue

                                logger.info(f"Adding untracked position to monitors: {position_address}")
                                logger.info(f"  Liquidity: {pos_state.liquidity:,}")
                                logger.info(f"  Ticks: [{pos_state.tick_lower_index}, {pos_state.tick_upper_index}]")

                                # Create monitor for untracked position
                                monitor = PositionMonitor(
                                    rpc_client=self.rpc,
                                    position_address=position_address,
                                    open_price=None,  # Will be estimated from current state
                                    config=self.config,
                                )

                                if await monitor.initialize():
                                    self.position_monitors[position_address] = monitor
                                    positions_added += 1

                                    # Register with session (estimate initial amounts from current state)
                                    snapshot = await monitor.get_snapshot()
                                    if snapshot:
                                        self.session_manager.register_position(
                                            position_address=position_address,
                                            open_price=Decimal(str(snapshot.current_price)),
                                            initial_token_a=snapshot.initial_token_a,
                                            initial_token_b=snapshot.initial_token_b,
                                            lower_price=snapshot.lower_price,
                                            upper_price=snapshot.upper_price,
                                        )
                                        logger.info(f"✅ Successfully registered untracked position: {position_address}")
                                        logger.info(f"   Current value: ${snapshot.current_value_usd:.2f}")

                            # If we found and added positions, skip recovery
                            if positions_added > 0:
                                logger.info(f"✅ Untracked positions discovered and added ({positions_added} position(s)) - skipping recovery")
                                logger.info("Session PnL will be recalculated on next iteration to include these positions")
                                self._needs_position_recovery = False
                                self._recovery_reason = None
                                self._recovery_attempts = 0
                                return
                            else:
                                logger.warning("Found existing positions but failed to add them to monitors")
                    else:
                        logger.warning("Orca client not available for on-chain position discovery")
                else:
                    logger.warning("Position executor not available for on-chain position discovery")
            else:
                logger.warning("Trade executor not available for on-chain position discovery")
                
        except Exception as e:
            logger.error(f"Error checking for existing positions: {e}")
            logger.exception("Exception during on-chain position discovery")
            logger.warning("Proceeding with recovery - on-chain check failed")

        # CRITICAL FIX: Get fresh market state instead of using passed market_state
        # This ensures targets are calculated from CURRENT pool price
        logger.info("Fetching fresh market state for recovery...")
        fresh_market_state = await self.market_analyzer.get_market_state()
        if not fresh_market_state:
            logger.error("Failed to get market state for recovery")
            return

        # Update display targets (for logging only - actual targets come from fresh_market_state)
        self._lower_target = fresh_market_state.lower_target
        self._upper_target = fresh_market_state.upper_target

        # Fetch pool's actual state from on-chain
        try:
            # CRITICAL: Use fresh pool state for recovery to ensure accurate range calculation
            pool_state = await self.trade_executor.get_pool_state(force_refresh=True)
            if not pool_state:
                logger.error("Failed to get pool state for recovery")
                return
            tick_spacing = pool_state.tick_spacing
            logger.info(f"Pool tick_spacing from on-chain: {tick_spacing}")

            # Record pool state to CSV (so it's available in email attachments)
            if self.csv_logger:
                self.csv_logger.log_pool_state(
                    price=pool_state.current_price,
                    sqrt_price=getattr(pool_state, 'sqrt_price', 0),
                    tick_current=getattr(pool_state, 'tick_current_index', 0),
                    tick_spacing=tick_spacing,
                    liquidity=getattr(pool_state, 'liquidity', 0),
                    fee_rate=getattr(pool_state, 'fee_rate', 0),
                    fee_growth_global_a=getattr(pool_state, 'fee_growth_global_a', 0),
                    fee_growth_global_b=getattr(pool_state, 'fee_growth_global_b', 0),
                    pool_address=self.config.pool.pool_address,
                )
        except Exception as e:
            logger.error(f"Failed to get pool state: {e}")
            return

        # Calculate tick range from FRESH targets (from current pool price)
        lower_tick = price_to_tick(fresh_market_state.lower_target, tick_spacing)
        upper_tick = price_to_tick(fresh_market_state.upper_target, tick_spacing)

        # Get balances
        sol_balance, usdc_balance = await self.trade_executor.get_balances()
        logger.info(f"Recovery balances: {sol_balance:.4f} SOL, ${usdc_balance:.2f} USDC")

        # Calculate max amounts based on config - CRITICAL FIX: Apply deployment_pct only ONCE
        deployment_pct = self.config.capital.deployment_pct
        sol_reserve = self.config.capital.min_sol_reserve

        # Calculate total portfolio value (wallet + existing positions)
        total_portfolio, already_deployed = await self._calculate_total_portfolio_value(fresh_market_state)
        
        # Initialize remaining_deployable for threshold checks
        target_deployment = total_portfolio * deployment_pct
        remaining_deployable = target_deployment - already_deployed
        
        # Check if this is the first position
        is_first_position = (already_deployed == 0 and len(self.position_monitors) == 0)

        if is_first_position:
            # FIRST POSITION: Use wallet-based limits directly (apply deployment_pct once)
            # Note: Swap mechanism in open_position_with_rebalance() will balance tokens if needed,
            # and execution.py will recalculate max_sol/max_usdc from post-swap balances
            # Simple: deploy deployment_pct of available wallet
            # Note: CLMM typically uses ~90% of provided capital, so actual deployment will be ~deployment_pct * 0.90
            max_sol = (sol_balance - sol_reserve) * deployment_pct
            max_usdc = usdc_balance * deployment_pct
        else:
            # SUBSEQUENT POSITIONS: Use portfolio-based limits (deployment_pct applied once in remaining_deployable)
            # Convert remaining deployable to SOL/USDC (assume 50/50 split)
            remaining_sol_usd = remaining_deployable / 2
            remaining_usdc_usd = remaining_deployable / 2
            remaining_sol = remaining_sol_usd / fresh_market_state.price if fresh_market_state.price > 0 else 0
            remaining_usdc = remaining_usdc_usd

            # Use wallet balances directly (NOT multiplied by deployment_pct - already applied in remaining_deployable)
            max_sol = min(sol_balance - sol_reserve, remaining_sol)
            max_usdc = min(usdc_balance, remaining_usdc)
        
        # Ensure non-negative
        max_sol = max(0, max_sol)
        max_usdc = max(0, max_usdc)
        
        # Respect configured maximums as upper bounds (safety limits)
        max_sol = min(max_sol, self.config.capital.max_sol_per_position)
        max_usdc = min(max_usdc, self.config.capital.max_usdc_per_position)
        
        # Log portfolio-aware calculation
        logger.info(f"Recovery - Portfolio-aware capital deployment:")
        logger.info(f"  Total portfolio: ${total_portfolio:.2f} (wallet: ${total_portfolio - already_deployed:.2f} + positions: ${already_deployed:.2f})")
        logger.info(f"  Target deployment ({deployment_pct*100:.0f}%): ${target_deployment:.2f}")
        logger.info(f"  Already deployed: ${already_deployed:.2f}")
        logger.info(f"  Remaining deployable: ${remaining_deployable:.2f}")
        
        # Calculate final deployment value
        total_value = (max_sol * fresh_market_state.price) + max_usdc
        
        # CRITICAL: Check minimum deployment threshold
        min_deployment = self.config.capital.min_deployment_usd
        
        # If remaining deployable is negative, don't deploy
        if remaining_deployable < 0:
            logger.warning(f"⚠️  Portfolio deployment limit exceeded: ${already_deployed:.2f} / ${target_deployment:.2f}")
            logger.warning("  Deployment limit already exceeded - will not deploy additional capital")
            max_sol = 0
            max_usdc = 0
            total_value = 0
        # If remaining deployable is below minimum threshold, skip deployment
        elif remaining_deployable < min_deployment:
            logger.info(f"ℹ️  Remaining deployable (${remaining_deployable:.2f}) below minimum threshold (${min_deployment:.2f})")
            logger.info(f"  Skipping position opening - transaction costs would exceed benefits")
            logger.info(f"  Will wait for next rebalance to accumulate more capital")
            logger.info(f"  Note: Reserve value fluctuation may cause small discrepancies")
            max_sol = 0
            max_usdc = 0
            total_value = 0
        # If calculated position value is below minimum, also skip
        elif total_value < min_deployment:
            logger.info(f"ℹ️  Calculated position value (${total_value:.2f}) below minimum threshold (${min_deployment:.2f})")
            logger.info(f"  Skipping position opening - position too small to be cost-effective")
            logger.info(f"  Will wait for next rebalance to accumulate more capital")
            max_sol = 0
            max_usdc = 0
            total_value = 0
        elif remaining_deployable < min_deployment * 1.5:  # Warn if close to threshold
            logger.warning(f"⚠️  Remaining deployable (${remaining_deployable:.2f}) close to minimum threshold (${min_deployment:.2f})")
            logger.warning("  Note: Reserve value fluctuation may cause small discrepancies")

        # Simple liquidity approximation using fresh pool price
        liquidity = int(total_value * 1e6) if total_value > 0 else 0

        # If deployment was skipped due to minimum threshold, return early
        if total_value == 0:
            logger.info("=" * 50)
            logger.info("SKIPPING POSITION RECOVERY")
            logger.info("=" * 50)
            logger.info("Reason: Deployment amount below minimum threshold")
            logger.info("Action: Will wait for next iteration or rebalance to accumulate more capital")
            logger.info(f"  Recovery attempt: {self._recovery_attempts}")
            # Don't increment recovery attempts - this is not a failure, just waiting for more capital
            return

        logger.info(f"Recovery parameters:")
        logger.info(f"  Pool price: ${fresh_market_state.price:.4f}")
        logger.info(f"  Target range: ${fresh_market_state.lower_target:.4f} - ${fresh_market_state.upper_target:.4f}")
        logger.info(f"  Ticks: [{lower_tick}, {upper_tick}] (spacing={tick_spacing})")
        logger.info(f"  Max amounts: {max_sol:.4f} SOL, ${max_usdc:.2f} USDC")
        logger.info(f"  Recovery attempt: {self._recovery_attempts} (progressive slippage enabled)")

        # ================================================================================
        # CRITICAL FIX: Cleanup wSOL before recovery position open
        # ================================================================================
        # If wallet has any wSOL (from previous operations, failed recovery, or swaps),
        # it must be unwrapped to native SOL BEFORE position opening.
        # Otherwise, Orca will use native SOL balance only, leaving wSOL idle.
        #
        # BUG FIX: This prevents positions from opening with insufficient capital
        # ================================================================================
        if self.config.wsol_cleanup.enabled:
            try:
                wsol_balance = await get_wsol_balance()
                if wsol_balance > 0.01:  # More than 0.01 SOL in wSOL
                    logger.info(f"Pre-recovery-open wSOL cleanup: found {wsol_balance:.4f} wSOL")
                    await self._perform_wsol_cleanup(reason="pre_recovery_open")
                    await asyncio.sleep(2)  # Wait for cleanup to finalize
                    # Refetch balances to get updated values
                    sol_balance, usdc_balance = await self.trade_executor.get_balances()
                    logger.info(f"Updated balances after cleanup: SOL={sol_balance:.4f}, USDC=${usdc_balance:.2f}")
            except Exception as e:
                logger.warning(f"Pre-recovery wSOL cleanup failed: {e}")

        try:
            # Use _recovery_attempts as retry_attempt for PROGRESSIVE SLIPPAGE
            # Recovery attempts across iterations get progressively more slippage tolerance
            # This matches the behavior of immediate retries in rebalance_position
            open_result, swap_result = await self.trade_executor.open_position_with_rebalance(
                lower_tick=lower_tick,
                upper_tick=upper_tick,
                max_sol=max_sol,
                max_usdc=max_usdc,
                liquidity=liquidity,
                retry_attempt=self._recovery_attempts,  # Progressive slippage based on recovery attempts
            )

            # Record swap if one occurred
            if swap_result and swap_result.success:
                # Use direction and token info from SwapResult (set by execution layer)
                direction = swap_result.direction or "unknown"
                input_token = swap_result.input_token or "?"
                output_token = swap_result.output_token or "?"

                self.session_manager.record_swap(
                    direction=direction,
                    input_amount=Decimal(str(swap_result.input_amount)),
                    output_amount=Decimal(str(swap_result.output_amount)),
                    input_token=input_token,
                    output_token=output_token,
                    signature=swap_result.signature,
                    tx_fee_sol=Decimal("0.001"),
                    reason="recovery",
                    price=Decimal(str(fresh_market_state.price)),
                )

            if open_result.success:
                logger.info(f"RECOVERY SUCCESSFUL - Position opened: {open_result.position_address}")

                # ================================================================================
                # CRITICAL FIX: Cleanup wSOL after recovery position opening
                # ================================================================================
                # Same fix as initial position opening - cleanup wSOL created during wrapping
                # ================================================================================
                try:
                    wsol_balance = await get_wsol_balance()
                    if wsol_balance > 0.01:  # Any meaningful wSOL should be cleaned up
                        logger.info(f"Post-recovery wSOL cleanup: found {wsol_balance:.4f} wSOL (~${wsol_balance * fresh_market_state.price:.2f})")
                        logger.info(f"  This is normal - excess from SOL wrapping during position opening")
                        logger.info(f"  Cleaning up to convert back to native SOL...")

                        cleanup_result = await self._perform_wsol_cleanup(reason="post_recovery_open")

                        if cleanup_result and cleanup_result.success and cleanup_result.accounts_cleaned > 0:
                            logger.info(f"  ✅ Post-recovery wSOL cleanup: recovered {cleanup_result.total_sol_recovered:.4f} SOL")
                            await asyncio.sleep(2)  # Wait for cleanup to finalize

                            # Verify cleanup worked
                            remaining_wsol = await get_wsol_balance()
                            if remaining_wsol < 0.01:
                                logger.info(f"  ✅ Cleanup successful - {remaining_wsol:.6f} wSOL remaining (dust)")
                            else:
                                logger.warning(f"  ⚠️  {remaining_wsol:.4f} wSOL still remains after cleanup!")
                        elif cleanup_result and cleanup_result.success:
                            logger.info(f"  ℹ️  No wSOL accounts to cleanup (already native SOL)")
                        else:
                            logger.error(f"  ❌ Post-recovery wSOL cleanup failed: {cleanup_result.error if cleanup_result else 'unknown error'}")
                            logger.error(f"     {wsol_balance:.4f} wSOL (~${wsol_balance * fresh_market_state.price:.2f}) remains idle!")
                    else:
                        logger.info(f"ℹ️  Minimal wSOL after recovery position open: {wsol_balance:.6f} SOL (dust - OK)")
                except Exception as e:
                    logger.error(f"Failed to cleanup wSOL after recovery position open: {e}")

                # Register new position for monitoring with ACTUAL deposited amounts for accurate IL
                new_monitor = PositionMonitor(
                    rpc_client=self.rpc,
                    position_address=open_result.position_address,
                    open_price=market_state.price,
                    config=self.config,
                    initial_token_a=open_result.deposited_sol,  # Actual deposited SOL
                    initial_token_b=open_result.deposited_usdc,  # Actual deposited USDC
                )
                monitor_initialized = await new_monitor.initialize()
                
                if monitor_initialized:
                    self.position_monitors[open_result.position_address] = new_monitor

                    # Register with session
                    self.session_manager.register_position(
                        position_address=open_result.position_address,
                        open_price=Decimal(str(market_state.price)),
                        initial_token_a=Decimal(str(open_result.deposited_sol)),
                        initial_token_b=Decimal(str(open_result.deposited_usdc)),
                        lower_price=Decimal(str(open_result.lower_price)),
                        upper_price=Decimal(str(open_result.upper_price)),
                    )

                    # Update state
                    self._lower_tick = open_result.lower_tick
                    self._upper_tick = open_result.upper_tick
                    self._price_at_last_rebalance = market_state.price

                    # Calculate final slippage used for notification BEFORE clearing state
                    base_slippage_bps = self.config.rebalance.slippage_bps
                    progressive_schedule = [0, 50, 150, 300, 500, 650, 750]
                    final_slippage_bps = base_slippage_bps + progressive_schedule[min(self._recovery_attempts, len(progressive_schedule) - 1)]
                    final_slippage_bps = min(final_slippage_bps, 800)
                    saved_recovery_attempts = self._recovery_attempts
                    saved_recovery_reason = self._recovery_reason

                    # CRITICAL FIX: Only clear recovery state if monitor was successfully initialized
                    # If monitor initialization fails, the position exists on-chain but isn't tracked.
                    # We need to keep recovery flags set so the system can detect and track it on next iteration.
                    self._needs_position_recovery = False
                    self._recovery_reason = None
                    self._recovery_attempts = 0
                    
                    logger.info(f"Position monitor initialized successfully - recovery complete")
                else:
                    # CRITICAL BUG FIX: Monitor initialization failed even though position was opened
                    # This means the position exists on-chain but isn't tracked in position_monitors.
                    # We MUST NOT clear recovery flags, otherwise the system will try to open another position.
                    # Instead, log error and keep recovery flags set. On next iteration, the position
                    # should be detected and added to monitors (or recovery will retry if it still fails).
                    logger.error(f"CRITICAL: Position opened successfully but monitor initialization FAILED!")
                    logger.error(f"Position {open_result.position_address} exists on-chain but is NOT tracked")
                    logger.error(f"Keeping recovery flags set to prevent duplicate position opening")
                    logger.error(f"The position should be detected on the next iteration")
                    # DO NOT clear recovery flags - let the next iteration handle it
                    # The position monitoring loop should detect it, or recovery will retry
                    return  # Exit early - don't send success email or clear flags

                # Log recovery to CSV FIRST (before email so attachments have data)
                if self.csv_logger:
                    try:
                        # Log swap to Asset/Fees sheet if one occurred
                        if swap_result and swap_result.success:
                            self.csv_logger.log_swap(
                                direction=swap_result.direction or "unknown",
                                sol_amount=swap_result.input_amount if swap_result.direction == "sell_sol" else swap_result.output_amount,
                                usdc_amount=swap_result.output_amount if swap_result.direction == "sell_sol" else swap_result.input_amount,
                                price=market_state.price,
                                tx_signature=swap_result.signature,
                            )

                        # Increment position index and get pool metrics
                        self.session_manager.state.current_position_index += 1
                        tvl, fee_tier, volume_24h = await self._get_pool_metrics_for_csv()

                        # Get actual cost from result if available
                        recovery_actual_cost = getattr(open_result, 'actual_cost', None)
                        recovery_actual_cost_usd = recovery_actual_cost.actual_cost_usd if recovery_actual_cost else 0.0

                        # Log new position open
                        # Compute entry price from actual TX-parsed deposit amounts
                        entry_price = (
                            open_result.deposited_usdc / open_result.deposited_sol
                            if open_result.deposited_sol > 0
                            else market_state.price
                        )
                        self.csv_logger.log_position_open(
                            position_address=open_result.position_address,
                            entry_price=entry_price,
                            sol_amount=open_result.deposited_sol,
                            usdc_amount=open_result.deposited_usdc,
                            lower_price=open_result.lower_price,
                            upper_price=open_result.upper_price,
                            tx_signature=open_result.signature,
                            open_attempts=saved_recovery_attempts + 1,  # Total attempts including recovery
                            tvl=tvl,
                            volume_24h=volume_24h,
                            position_index=self.session_manager.state.current_position_index,
                            open_tx_fee_sol=getattr(open_result, 'tx_fee_sol', 0.0),
                            swap_tx_fee_sol=swap_result.tx_fee_sol if swap_result else 0.0,
                            actual_cost_usd=recovery_actual_cost_usd,
                            market_price=market_state.price,
                        )
                    except Exception as e:
                        logger.warning(f"Failed to log recovery to CSV: {e}")

                # Send recovery success email (AFTER CSV logging so attachments have data)
                if self.email_notifier:
                    try:
                        ctx = await self._get_email_context()
                        self.email_notifier.notify_position_recovery(
                            position_address=open_result.position_address,
                            lower_price=open_result.lower_price,
                            upper_price=open_result.upper_price,
                            deposited_sol=open_result.deposited_sol,
                            deposited_usdc=open_result.deposited_usdc,
                            price=ctx['price'],
                            atr_pct=ctx['atr_pct'],
                            lower_target=ctx['lower_target'],
                            upper_target=ctx['upper_target'],
                            sol_balance=ctx['sol_balance'],
                            usdc_balance=ctx['usdc_balance'],
                            pool_address=ctx['pool_address'],
                            session_state=ctx['session_state'],
                            recovery_reason=saved_recovery_reason or "no_active_position",
                            tick_current=ctx['tick_current'],
                            pool_sqrt_price=ctx['pool_sqrt_price'],
                            price_source=ctx['price_source'],
                            # Recovery attempt tracking (using saved values before state was cleared)
                            recovery_attempt=saved_recovery_attempts,
                            max_recovery_attempts=self._max_recovery_attempts,
                            final_slippage_bps=final_slippage_bps,
                        )
                    except Exception as e:
                        logger.warning(f"Failed to send recovery success email: {e}")

            else:
                logger.error(f"RECOVERY FAILED: {open_result.error}")
                logger.error(f"  Recovery attempt {self._recovery_attempts}/{self._max_recovery_attempts}")

                # Send retry notification email if more attempts remain
                if self._recovery_attempts < self._max_recovery_attempts and self.email_notifier:
                    try:
                        # Calculate current and next slippage for notification
                        base_slippage_bps = self.config.rebalance.slippage_bps
                        progressive_schedule = [0, 50, 150, 300, 500, 650, 750]
                        current_slippage = base_slippage_bps + progressive_schedule[min(self._recovery_attempts, len(progressive_schedule) - 1)]
                        current_slippage = min(current_slippage, 800)
                        next_slippage = base_slippage_bps + progressive_schedule[min(self._recovery_attempts + 1, len(progressive_schedule) - 1)]
                        next_slippage = min(next_slippage, 800)

                        self.email_notifier.notify_retry_attempt(
                            operation="recovery",
                            attempt_number=self._recovery_attempts,
                            max_attempts=self._max_recovery_attempts,
                            error_message=open_result.error or "Unknown error",
                            slippage_bps=current_slippage,
                            next_slippage_bps=next_slippage,
                            price=market_state.price,
                            sol_balance=sol_balance,
                            usdc_balance=usdc_balance,
                        )
                    except Exception as e:
                        logger.warning(f"Failed to send recovery retry notification email: {e}")

        except Exception as e:
            logger.exception(f"Exception during position recovery: {e}")

    async def _run_iteration(self, iteration: int):
        """Run a single strategy iteration."""
        from datetime import datetime, timezone

        timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
        current_date = datetime.now(timezone.utc).date()

        logger.info("=" * 60)
        logger.info(f"ITERATION #{iteration} - {timestamp}")
        logger.info("=" * 60)

        # Check if stop-loss occurred yesterday and we need to trigger recovery today
        if self._stop_loss_occurred_date is not None and current_date > self._stop_loss_occurred_date:
            logger.info("=" * 60)
            logger.info("STOP-LOSS RECOVERY: New day detected after stop-loss")
            logger.info(f"Stop-loss occurred on: {self._stop_loss_occurred_date}")
            logger.info(f"Current date: {current_date}")
            logger.info("Triggering position recovery...")
            logger.info("=" * 60)
            self._needs_position_recovery = True
            self._recovery_reason = "stop_loss"
            self._recovery_attempts = 0
            self._stop_loss_occurred_date = None  # Clear the flag

        # 1. Update market state
        market_state = await self.market_analyzer.get_market_state()
        if not market_state:
            logger.warning("Failed to get market state")
            return

        self._last_market_state = market_state

        # 1b. Get and log comprehensive pool state (if trade executor available)
        pool_state = None
        pool_tvl = 0.0
        if self.trade_executor and self.session_manager and self.session_manager.is_active:
            try:
                pool_state = await self.trade_executor.get_pool_state()
                if pool_state:
                    # Extract pool state values
                    pool_price = pool_state.current_price  # Price from on-chain sqrt_price
                    sqrt_price = getattr(pool_state, 'sqrt_price', 0)
                    tick_current = getattr(pool_state, 'tick_current_index', 0)
                    tick_spacing = getattr(pool_state, 'tick_spacing', 1)
                    liquidity = getattr(pool_state, 'liquidity', 0)
                    fee_rate = getattr(pool_state, 'fee_rate', 0)
                    fee_growth_a = getattr(pool_state, 'fee_growth_global_a', 0)
                    fee_growth_b = getattr(pool_state, 'fee_growth_global_b', 0)

                    # Get TVL from Orca API or on-chain calculation
                    try:
                        pool_tvl, _, _ = await self._get_pool_metrics_for_csv()
                    except Exception:
                        pool_tvl = 0.0

                    # Calculate fee tier - fee_rate is in hundredths of a basis point (e.g., 400 = 4 bps = 0.04%)
                    # So fee_rate / 100 = basis points, fee_rate / 10000 = percentage
                    fee_tier_bps = fee_rate / 100.0  # Convert to basis points (400 -> 4 bps)
                    fee_tier_pct = fee_rate / 10000.0  # Convert to percentage (400 -> 0.04%)

                    # === COMPREHENSIVE POOL STATE LOGGING ===
                    logger.info("")
                    logger.info("POOL STATE (from on-chain):")
                    logger.info(f"  Address: {self.config.pool.pool_address}")
                    logger.info(f"  Current Tick: {tick_current}")
                    logger.info(f"  Current Price (SOL/USDC): ${pool_price:.4f} (from sqrt_price)")
                    if pool_price > 0:
                        logger.info(f"  Current Price (USDC/SOL): {1/pool_price:.6f} SOL")
                    logger.info(f"  Pool Liquidity: {liquidity:,}")
                    logger.info(f"  Pool TVL: ${pool_tvl:,.0f}" if pool_tvl > 0 else "  Pool TVL: N/A")
                    logger.info(f"  Fee Tier: {fee_tier_bps:.0f} bps ({fee_tier_pct:.2f}%)")
                    logger.info(f"  Tick Spacing: {tick_spacing}")
                    logger.info(f"  sqrt_price (raw): {sqrt_price}")

                    # Record to session manager (legacy)
                    self.session_manager.record_pool_state(
                        pool_address=self.config.pool.pool_address,
                        price=Decimal(str(pool_price)),
                        sqrt_price=sqrt_price,
                        tick_current=tick_current,
                        liquidity=liquidity,
                        fee_growth_global_a=fee_growth_a,
                        fee_growth_global_b=fee_growth_b,
                        tick_spacing=tick_spacing,
                    )

                    # Record to CSV logger (new global pool state history)
                    if self.csv_logger:
                        self.csv_logger.log_pool_state(
                            price=pool_price,
                            sqrt_price=sqrt_price,
                            tick_current=tick_current,
                            tick_spacing=tick_spacing,
                            liquidity=liquidity,
                            fee_rate=fee_rate,
                            fee_growth_global_a=fee_growth_a,
                            fee_growth_global_b=fee_growth_b,
                            pool_address=self.config.pool.pool_address,
                        )
                else:
                    logger.warning("POOL STATE: Failed to fetch pool state from on-chain")
            except Exception as e:
                logger.warning(f"POOL STATE: Error fetching pool state: {e}")

        # Log market state (from market analyzer - may use different price source)
        logger.info("")
        logger.info("MARKET STATE (from analyzer):")
        logger.info(f"  Price: ${market_state.price:.4f}")
        logger.info(f"  ATR: {market_state.atr*100:.2f}%")
        logger.info(f"  Lower Target: ${market_state.lower_target:.4f}")
        logger.info(f"  Upper Target: ${market_state.upper_target:.4f}")

        # 2. Check if range targets should be updated (volatility adaptation)
        await self._check_range_update(market_state)

        # 2a. PERIODIC ON-CHAIN POSITION DISCOVERY & CLEANUP
        # This catches positions that were opened but not tracked (e.g., position address extraction failed)
        # Also cleans up stale entries in session_manager that don't exist on-chain
        # Run every 10 iterations (~10 minutes) to avoid excessive RPC calls
        if iteration % 10 == 0:
            logger.info("Running periodic on-chain position discovery and cleanup...")
            try:
                if self.trade_executor and hasattr(self.trade_executor, '_position_executor'):
                    position_executor = self.trade_executor._position_executor
                    if position_executor and hasattr(position_executor, '_orca_client'):
                        orca_client = position_executor._orca_client
                        
                        if orca_client:
                            on_chain_positions = await orca_client.get_positions_for_wallet(
                                wallet_pubkey=None,
                                pool_pubkey=self.config.pool.pool_address,
                            )
                            
                            # Get all position addresses from on-chain
                            on_chain_addresses = {pos.pubkey for pos in on_chain_positions}
                            
                            # Find positions that exist on-chain but aren't tracked
                            tracked_addresses = set(self.position_monitors.keys())
                            untracked = [pos for pos in on_chain_positions if pos.pubkey not in tracked_addresses]
                            
                            if untracked:
                                logger.warning(f"⚠️  Found {len(untracked)} untracked position(s) on-chain during periodic check!")
                                
                                for pos_state in untracked:
                                    logger.warning(f"  - {pos_state.pubkey} (liquidity: {pos_state.liquidity:,})")
                                    
                                    # Add to monitors
                                    monitor = PositionMonitor(
                                        rpc_client=self.rpc,
                                        position_address=pos_state.pubkey,
                                        open_price=None,
                                        config=self.config,
                                    )
                                    
                                    if await monitor.initialize():
                                        self.position_monitors[pos_state.pubkey] = monitor
                                        
                                        # Register with session
                                        snapshot = await monitor.get_snapshot()
                                        if snapshot:
                                            self.session_manager.register_position(
                                                position_address=pos_state.pubkey,
                                                open_price=Decimal(str(snapshot.current_price)),
                                                initial_token_a=snapshot.initial_token_a,
                                                initial_token_b=snapshot.initial_token_b,
                                                lower_price=snapshot.lower_price,
                                                upper_price=snapshot.upper_price,
                                            )
                                            logger.info(f"✅ Added untracked position to tracking: {pos_state.pubkey}")
                                            logger.info(f"   Current value: ${snapshot.current_value_usd:.2f}")
                                            logger.info("   Session PnL will be recalculated on next iteration")
                            
                            # ================================================================================
                            # CRITICAL FIX: Clean up stale positions in session_manager that don't exist on-chain
                            # ================================================================================
                            # A position can be in session_manager.state.positions but:
                            # 1. Not exist on-chain (closed externally)
                            # 2. Not be in position_monitors (monitor initialization failed or was removed)
                            #
                            # This causes the positions_active count to be incorrect.
                            # ================================================================================
                            if self.session_manager and self.session_manager.state:
                                session_positions = set(self.session_manager.state.positions.keys())
                                
                                # Find stale entries: positions in session_manager but not on-chain or in monitors
                                stale_in_session = []
                                for pos_addr in session_positions:
                                    if pos_addr not in on_chain_addresses and pos_addr not in tracked_addresses:
                                        stale_in_session.append(pos_addr)
                                
                                if stale_in_session:
                                    logger.warning(f"⚠️  Found {len(stale_in_session)} stale position(s) in session_manager that don't exist on-chain!")
                                    for pos_addr in stale_in_session:
                                        logger.warning(f"  - {pos_addr} (exists in session_manager but not on-chain or in monitors)")
                                        
                                        # Get the position record before removing
                                        pos_record = self.session_manager.state.positions.get(pos_addr)
                                        if pos_record:
                                            logger.warning(f"    Entry value: ${float(pos_record.initial_value_usd):.2f}")
                                            logger.warning(f"    Current value: ${float(pos_record.current_value_usd):.2f}")
                                            logger.warning(f"    Is closed: {pos_record.is_closed}")
                                        
                                        # Remove stale entry from session_manager
                                        # CRITICAL: Only remove if it's truly not on-chain and not being monitored
                                        # If it's closed, it should have been removed already, but handle it gracefully
                                        if pos_addr in self.session_manager.state.positions:
                                            logger.warning(f"    Removing stale position from session_manager...")
                                            
                                            # If the position has close_timestamp, it should have been moved to history already
                                            # But if it's still in positions dict, we need to clean it up
                                            stale_record = self.session_manager.state.positions[pos_addr]
                                            
                                            # Move to history if not already closed
                                            if not stale_record.is_closed:
                                                stale_record.is_closed = True
                                                stale_record.close_reason = "external_closure_detected"
                                                stale_record.close_timestamp = datetime.now(timezone.utc)
                                                stale_record.close_price = Decimal(str(market_state.price))
                                                # Estimate final value from current value (best we can do)
                                                # Since position doesn't exist on-chain, we use tracked current value
                                                stale_record.final_value_usd = stale_record.current_value_usd
                                                
                                                # Update session PnL totals using add_position_closed
                                                # This ensures counts and totals are accurate
                                                # Use tracked values as best estimate
                                                exit_value = stale_record.current_value_usd
                                                entry_value = stale_record.initial_value_usd
                                                realized_fees = stale_record.total_fees_earned_usd
                                                
                                                self.session_manager.state.add_position_closed(
                                                    entry_value_usd=entry_value,
                                                    exit_value_usd=exit_value,
                                                    realized_fees_usd=realized_fees,
                                                    realized_fees_sol=stale_record.total_fees_earned_sol,
                                                    realized_fees_usdc=stale_record.total_fees_earned_usdc,
                                                )
                                                
                                                # Move to history
                                                self.session_manager.state.position_history.append(stale_record)
                                                logger.warning(f"    Moved to position_history with reason: external_closure_detected")
                                                logger.warning(f"    Entry: ${float(entry_value):.2f}, Exit (est): ${float(exit_value):.2f}, Fees: ${float(realized_fees):.2f}")
                                            
                                            # Remove from active positions
                                            del self.session_manager.state.positions[pos_addr]
                                            logger.warning(f"    ✅ Removed stale position from session_manager.state.positions")
                                        
                                        # Clear stop-loss tracking if it exists
                                        if pos_addr in self._position_last_in_range_at:
                                            del self._position_last_in_range_at[pos_addr]
                                        if pos_addr in self._stop_loss_last_triggered_at:
                                            del self._stop_loss_last_triggered_at[pos_addr]
                                        # Clear upward rebalance tracking if it exists
                                        if pos_addr in self._last_upward_rebalance_at:
                                            del self._last_upward_rebalance_at[pos_addr]
                                    
                                    logger.warning(f"✅ Cleaned up {len(stale_in_session)} stale position(s)")
                                
                                # Validation: Compare counts
                                session_count = len(self.session_manager.state.positions)
                                monitor_count = len(self.position_monitors)
                                on_chain_count = len(on_chain_positions)
                                
                                if session_count != monitor_count or session_count != on_chain_count:
                                    logger.warning(f"⚠️  Position count mismatch detected:")
                                    logger.warning(f"    session_manager.state.positions: {session_count}")
                                    logger.warning(f"    position_monitors: {monitor_count}")
                                    logger.warning(f"    on-chain positions: {on_chain_count}")
                                    
                                    if session_count == monitor_count == on_chain_count:
                                        logger.info(f"✅ Position counts now match after cleanup")
                                    else:
                                        logger.error(f"❌ Position counts still mismatched - manual investigation may be required")
                                        # Log detailed breakdown
                                        logger.error(f"    Positions in session_manager but not in monitors:")
                                        session_only = session_positions - tracked_addresses
                                        if session_only:
                                            for addr in session_only:
                                                logger.error(f"      - {addr}")
                                        logger.error(f"    Positions in monitors but not in session_manager:")
                                        monitors_only = tracked_addresses - session_positions
                                        if monitors_only:
                                            for addr in monitors_only:
                                                logger.error(f"      - {addr}")
                                else:
                                    logger.info(f"✅ Position counts match: {session_count} active position(s)")
            except Exception as e:
                logger.warning(f"Periodic position discovery failed: {e}")
                logger.debug("Exception details:", exc_info=True)

        # 2b. RECOVERY CHECK: If no active positions and recovery needed, attempt recovery
        if len(self.position_monitors) == 0:
            logger.warning("NO ACTIVE POSITIONS - Funds are idle in wallet")

            # Only attempt recovery if:
            # 1. Recovery was explicitly triggered (_needs_position_recovery = True), OR
            # 2. We haven't exhausted max attempts yet
            # The counter should only increment when we actually attempt recovery
            if self._needs_position_recovery:
                # Recovery explicitly triggered by failed rebalance
                if self._recovery_attempts < self._max_recovery_attempts:
                    self._recovery_attempts += 1
                    logger.info(f"Attempting position recovery (attempt {self._recovery_attempts}/{self._max_recovery_attempts})...")
                    await self._attempt_position_recovery(market_state)
                    
                    # CRITICAL FIX: After recovery attempt, check again if we now have positions
                    # This handles the case where recovery succeeded but monitor wasn't added yet
                    if len(self.position_monitors) > 0:
                        logger.info("Recovery succeeded - position monitor now active")
                        # Clear recovery flags since we now have a position
                        self._needs_position_recovery = False
                        self._recovery_reason = None
                        self._recovery_attempts = 0
                else:
                    logger.error(f"Max recovery attempts ({self._max_recovery_attempts}) reached. Manual intervention required.")
                    logger.error("Recovery will NOT be re-attempted until manual restart or position is opened externally.")

                    # Send critical failure email for recovery exhaustion
                    if self.email_notifier:
                        try:
                            ctx = await self._get_email_context()
                            self.email_notifier.notify_recovery_exhausted(
                                recovery_reason=self._recovery_reason or "unknown",
                                recovery_attempts=self._recovery_attempts,
                                max_recovery_attempts=self._max_recovery_attempts,
                                sol_balance=ctx['sol_balance'],
                                usdc_balance=ctx['usdc_balance'],
                                price=ctx['price'],
                                atr_pct=ctx['atr_pct'],
                                lower_target=ctx['lower_target'],
                                upper_target=ctx['upper_target'],
                                pool_address=ctx['pool_address'],
                                session_state=ctx['session_state'],
                            )
                        except Exception as e:
                            logger.warning(f"Failed to send recovery exhausted email: {e}")
            else:
                # No active position but recovery not triggered - this shouldn't happen in normal operation
                # Log warning but don't keep incrementing counter indefinitely
                logger.warning("No active position and no recovery flag set. Waiting for manual intervention or restart.")
        else:
            # Reset recovery state if we have a position
            if self._needs_position_recovery or self._recovery_attempts > 0:
                logger.info("Position exists - clearing recovery flags")
                self._needs_position_recovery = False
                self._recovery_reason = None
                self._recovery_attempts = 0

        # 3. Monitor each position
        if len(self.position_monitors) > 0:
            for pos_addr, monitor in list(self.position_monitors.items()):
                snapshot = await monitor.get_snapshot()
                if not snapshot:
                    # Position no longer exists (closed externally or failed to fetch)
                    logger.error(f"Position {pos_addr} returned None snapshot - position likely closed externally")
                    logger.error("Removing dead monitor and triggering recovery if needed")

                    # CRITICAL FIX: Send email notification when position is removed
                    # This was previously silent, leaving users unaware of the issue
                    if self.email_notifier:
                        try:
                            self.email_notifier.notify_position_lost(
                                position_address=pos_addr,
                                reason="snapshot_failed",
                                details="Position monitor returned None snapshot. This could mean: "
                                       "(1) Position was closed externally, "
                                       "(2) RPC node issue, or "
                                       "(3) Position never existed on-chain.",
                                price=market_state.price if market_state else 0.0,
                                session_state=self.session_manager.get_session_state_for_email(),
                            )
                        except Exception as e:
                            logger.warning(f"Failed to send position lost email: {e}")

                    # Remove the dead monitor
                    del self.position_monitors[pos_addr]

                    # Clear stop-loss tracking for this position
                    if pos_addr in self._position_last_in_range_at:
                        del self._position_last_in_range_at[pos_addr]
                    if pos_addr in self._stop_loss_last_triggered_at:
                        del self._stop_loss_last_triggered_at[pos_addr]
                    # Clear upward rebalance tracking for this position
                    if pos_addr in self._last_upward_rebalance_at:
                        del self._last_upward_rebalance_at[pos_addr]

                    # If we now have no positions, trigger recovery
                    if len(self.position_monitors) == 0:
                        logger.error("Last position monitor removed - all positions are gone")
                        logger.error("Setting recovery flag to attempt opening new position")
                        self._needs_position_recovery = True
                        self._recovery_reason = "external_closure_detected"
                        self._recovery_attempts = 0

                    continue

                # Record snapshot
                self.session_manager.record_snapshot(snapshot)

                # Get position state for additional details
                position_state = monitor._position_state
                position_liquidity = position_state.liquidity if position_state else 0
                lower_tick = position_state.tick_lower_index if position_state else 0
                upper_tick = position_state.tick_upper_index if position_state else 0

                # === COMPREHENSIVE POSITION LOGGING ===
                status = "IN RANGE" if snapshot.is_in_range else "OUT OF RANGE"
                logger.info("")
                logger.info(f"POSITION: {pos_addr}")
                logger.info(f"  Lower Tick: {lower_tick} (Price: ${float(snapshot.lower_price):.4f})")
                logger.info(f"  Upper Tick: {upper_tick} (Price: ${float(snapshot.upper_price):.4f})")
                logger.info(f"  Status: {status}")
                logger.info(f"  Position Liquidity: {position_liquidity:,}")

                # Current holdings with detailed breakdown
                sol_amount = float(snapshot.current_token_a)
                usdc_amount = float(snapshot.current_token_b)
                sol_value = sol_amount * market_state.price
                total_value = float(snapshot.current_value_usd)

                logger.info(f"  Current Holdings:")
                logger.info(f"    SOL: {sol_amount:.6f} SOL (${sol_value:.2f})")
                logger.info(f"    USDC: ${usdc_amount:.2f}")
                logger.info(f"    Total Value: ${total_value:.2f}")
                logger.info(f"    Ratio: {snapshot.token_a_ratio*100:.1f}% SOL / {(1-snapshot.token_a_ratio)*100:.1f}% USDC")

                # Impermanent Loss with detailed breakdown
                hodl_value = float(snapshot.hold_value_usd)
                il_usd = float(snapshot.il_usd)
                il_pct = float(snapshot.il_pct)
                logger.info(f"  Impermanent Loss:")
                logger.info(f"    HODL Value: ${hodl_value:.2f} (what you'd have if just held)")
                logger.info(f"    Position Value: ${total_value:.2f}")
                logger.info(f"    IL: ${il_usd:.2f} ({il_pct:.2f}%)")

                # Pending fees with breakdown
                pending_fees_sol = float(snapshot.pending_fees_a)
                pending_fees_usdc = float(snapshot.pending_fees_b)
                pending_fees_sol_usd = pending_fees_sol * market_state.price
                total_pending_fees = float(snapshot.pending_fees_usd)

                logger.info(f"  Pending Fees:")
                logger.info(f"    SOL: {pending_fees_sol:.6f} SOL (${pending_fees_sol_usd:.4f})")
                logger.info(f"    USDC: ${pending_fees_usdc:.4f}")
                logger.info(f"    Total: ${total_pending_fees:.4f}")

                # Calculate hourly accrual rate (if we have position open time)
                if monitor.open_timestamp:
                    position_duration_hours = (datetime.now(timezone.utc) - monitor.open_timestamp).total_seconds() / 3600
                    if position_duration_hours > 0:
                        hourly_rate = total_pending_fees / position_duration_hours
                        daily_projection = hourly_rate * 24
                        logger.info(f"    Hourly Rate: ${hourly_rate:.4f}/hr")
                        logger.info(f"    24h Projection: ${daily_projection:.2f}")
                        logger.info(f"    Position Age: {position_duration_hours:.2f} hours")

                # Net PnL (IL + Fees)
                net_pnl = il_usd + total_pending_fees
                net_pnl_pct = (net_pnl / hodl_value * 100) if hodl_value > 0 else 0
                logger.info(f"  Net PnL (IL + Fees):")
                logger.info(f"    IL: ${il_usd:.2f}")
                logger.info(f"    Fees: +${total_pending_fees:.4f}")
                logger.info(f"    Net: ${net_pnl:.2f} ({net_pnl_pct:.2f}%)")

                # 4. Check rebalance conditions
                rebalance_reason = self._check_rebalance_conditions(snapshot, market_state)

                if rebalance_reason:
                    await self._execute_rebalance(pos_addr, snapshot, market_state, rebalance_reason)
                else:
                    # Check stop-loss conditions when rebalance not possible
                    # Only check if rebalances exhausted OR emergency used (checked inside method)
                    # This ensures stop-loss only activates when normal defenses are unavailable
                    await self._check_stop_loss_conditions(snapshot, market_state)

        # 5. Update wallet balance and log session summary
        total_wallet_usd = None  # Initialize for return on initial wallet calculation
        if self.session_manager.state and self.trade_executor:
            try:
                sol_balance, usdc_balance = await self.trade_executor.get_balances()
                sol_value = sol_balance * market_state.price
                total_wallet_usd = sol_value + usdc_balance

                logger.info("")
                logger.info("WALLET BALANCES:")
                logger.info(f"  SOL: {sol_balance:.6f} SOL (${sol_value:.2f})")
                logger.info(f"  USDC: ${usdc_balance:.2f}")
                logger.info(f"  Total Wallet Value: ${total_wallet_usd:.2f}")

                self.session_manager.update_wallet_balance(
                    Decimal(str(sol_balance)),
                    Decimal(str(usdc_balance)),
                    Decimal(str(market_state.price))
                )
            except Exception as e:
                logger.warning(f"Failed to update wallet balances: {e}")

            summary = self.session_manager.get_session_summary(Decimal(str(market_state.price)))

            # ===== SESSION PNL (POSITION-BASED, NOT WALLET-BASED) =====
            # Calculate current value, pending fees, HODL value, and IL from all open positions
            total_open_value = Decimal(0)
            total_pending_fees = Decimal(0)
            total_open_hodl_value = Decimal(0)  # For strategy alpha calculation
            total_open_il = Decimal(0)  # For strategy alpha calculation
            for pos_addr, monitor in self.position_monitors.items():
                if pos_addr in self.session_manager.state.positions:
                    pos_record = self.session_manager.state.positions[pos_addr]
                    total_open_value += pos_record.current_value_usd
                    total_pending_fees += pos_record.total_fees_earned_usd
                    # Calculate HODL value for this position
                    hodl_value = (pos_record.initial_token_a * Decimal(str(market_state.price))) + pos_record.initial_token_b
                    total_open_hodl_value += hodl_value
                    total_open_il += pos_record.total_il_usd

            # Get session PnL breakdown (THIS IS THE CORRECT WAY TO CALCULATE PNL)
            # Session PnL tracks only capital deployed into positions (not wallet balance)
            session_pnl_data = self.session_manager.state.get_session_pnl(
                open_positions_value_usd=total_open_value,
                pending_fees_usd=total_pending_fees,
            )

            # Get strategy metrics for LP vs HODL comparison
            strategy_metrics = self.session_manager.state.get_strategy_metrics(
                open_positions_value_usd=total_open_value,
                pending_fees_usd=total_pending_fees,
                open_positions_hodl_value_usd=total_open_hodl_value,
                open_positions_il_usd=total_open_il,
            )

            logger.info("")
            logger.info("=" * 40)
            logger.info("SESSION PERFORMANCE")
            logger.info("=" * 40)
            # Show initial wallet, total deployed capital, and currently deployed capital
            initial_wallet = session_pnl_data['initial_wallet_usd']
            total_session_capital = session_pnl_data['total_deployed_usd']
            current_deployed = session_pnl_data['open_entries_value_usd']
            logger.info(f"Initial Wallet Balance: ${initial_wallet:.2f} (session start)")
            logger.info(f"Total Session Capital: ${total_session_capital:.2f} (cumulative across all {session_pnl_data['positions_opened']} positions)")
            
            # Validation: Compare actual tracked positions with session manager count
            actual_monitored = len(self.position_monitors)
            session_count = session_pnl_data['positions_active']
            if actual_monitored != session_count:
                logger.warning(f"⚠️  POSITION COUNT MISMATCH:")
                logger.warning(f"    session_manager.state.positions: {session_count}")
                logger.warning(f"    position_monitors (actual tracked): {actual_monitored}")
                logger.warning(f"    This indicates a stale entry in session_manager that will be cleaned up on next periodic check")
                logger.warning(f"    Using actual monitored count for accuracy: {actual_monitored} active position(s)")
                actual_active = actual_monitored
            else:
                actual_active = session_count
            
            logger.info(f"Currently Deployed: ${current_deployed:.2f} (in {actual_active} active position)")
            logger.info(f"Positions: {session_pnl_data['positions_opened']} opened, {session_pnl_data['positions_closed']} closed, {actual_active} active (monitored)")
            logger.info("")
            logger.info("Open Positions:")
            logger.info(f"  Entry Value: ${session_pnl_data['open_entries_value_usd']:.2f}")
            logger.info(f"  Current Value: ${session_pnl_data['open_positions_value_usd']:.2f}")
            logger.info(f"  Pending Fees: ${session_pnl_data['pending_fees_usd']:.2f}")
            logger.info(f"  Unrealized PnL: ${session_pnl_data['unrealized_pnl_usd']:.2f}")
            logger.info("")
            logger.info("Closed Positions:")
            logger.info(f"  Total Closed: ${session_pnl_data['closed_entries_value_usd']:.2f}")
            logger.info(f"  Realized Fees: ${session_pnl_data['realized_fees_usd']:.2f}")
            logger.info(f"  Realized PnL: ${session_pnl_data['realized_pnl_usd']:.2f}")
            logger.info("")
            logger.info("Session PnL:")
            pnl_sign = "+" if session_pnl_data['session_pnl_usd'] >= 0 else ""
            logger.info(f"  Before Costs: {pnl_sign}${session_pnl_data['session_pnl_usd']:.2f}")
            costs_usd = session_pnl_data['total_costs_usd']
            logger.info(f"  Total Costs:  ${costs_usd:.2f}")
            after_costs = session_pnl_data['session_pnl_after_costs_usd']
            after_sign = "+" if after_costs >= 0 else ""
            logger.info(f"  After Costs:  {after_sign}${after_costs:.2f}")
            after_pct = session_pnl_data['session_pnl_after_costs_pct_initial']
            logger.info(f"  Return on Initial (after costs): {after_sign}{after_pct:.2f}%")
            # Wallet-based return (ground truth)
            current_total_value = (total_wallet_usd if total_wallet_usd is not None else 0) + session_pnl_data['open_positions_value_usd'] + session_pnl_data['pending_fees_usd']
            total_return_on_initial = current_total_value - initial_wallet
            total_return_pct = (total_return_on_initial / initial_wallet * 100) if initial_wallet > 0 else 0
            return_sign = "+" if total_return_on_initial >= 0 else ""
            logger.info(f"  Return on Initial (wallet):      {return_sign}{total_return_pct:.2f}% ({return_sign}${total_return_on_initial:.2f})")
            # Reconciliation gap
            # Formula: gap = wallet_return - session_return_after_costs
            # Negative gap means wallet lost more than session accounts for (untracked costs)
            # Positive gap means wallet gained more than session accounts for (untracked gains)
            reconciliation_gap = total_return_on_initial - after_costs
            gap_sign = "+" if reconciliation_gap >= 0 else ""
            if abs(reconciliation_gap) > 1.0:
                logger.warning(f"  Reconciliation Gap: {gap_sign}${reconciliation_gap:.2f} (wallet vs session — untracked costs)")
                logger.warning(f"    Wallet return: {return_sign}${total_return_on_initial:.2f}")
                logger.warning(f"    Session return (after costs): {after_sign}${after_costs:.2f}")
                logger.warning(f"    Gap indicates: {'Untracked costs' if reconciliation_gap < 0 else 'Untracked gains'}")
            else:
                logger.info(f"  Reconciliation: OK (gap: {gap_sign}${reconciliation_gap:.2f})")
            logger.info("")

            # ===== STRATEGY PERFORMANCE (LP vs HODL) =====
            # Shows whether LP strategy is outperforming a simple HODL strategy
            # Alpha = Fees + IL - TX Costs (IL is typically negative)
            logger.info("Strategy Performance (LP vs HODL):")
            logger.info("  Alpha = Fees + IL - TX Costs")
            market_sign = "+" if strategy_metrics['total_market_movement_usd'] >= 0 else ""
            logger.info(f"  Market Movement: {market_sign}${strategy_metrics['total_market_movement_usd']:.2f} (HODL would have returned)")
            il_sign = "+" if strategy_metrics['total_il_usd'] >= 0 else ""
            logger.info(f"  Impermanent Loss (IL): {il_sign}${strategy_metrics['total_il_usd']:.2f}")
            logger.info(f"  TX Costs: ${strategy_metrics['total_tx_costs_usd']:.2f}")
            alpha_sign = "+" if strategy_metrics['strategy_alpha_usd'] >= 0 else ""
            logger.info(f"  Strategy Alpha: {alpha_sign}${strategy_metrics['strategy_alpha_usd']:.2f} ({alpha_sign}{strategy_metrics['strategy_alpha_pct']:.2f}%)")
            beat_hodl = "outperformed" if strategy_metrics['lp_beat_hodl'] else "underperformed"
            logger.info(f"  --> LP {beat_hodl} HODL by ${abs(strategy_metrics['strategy_alpha_usd']):.2f}")
            logger.info("=" * 40)

            # ===== COST BREAKDOWN =====
            logger.info("")
            logger.info("Cost Breakdown:")
            cost_breakdown = self.session_manager.state.get_cost_breakdown()
            open_cost = cost_breakdown['by_category_usd']['position_open']
            close_cost = cost_breakdown['by_category_usd']['position_close']
            net_open_close = cost_breakdown.get('net_open_close_usd', open_cost + close_cost)
            
            logger.info(f"  Position Open:  ${open_cost:.4f} (cumulative, includes rent)")
            logger.info(f"  Position Close: ${close_cost:.4f} (cumulative, negative = rent refunded)")
            logger.info(f"  Net Open/Close: ${net_open_close:.4f} (cumulative, true cost after rent cancels)")
            logger.info(f"  Swaps:          ${cost_breakdown['by_category_usd']['swap']:.4f} (cumulative)")
            logger.info(f"  wSOL Cleanup:   ${cost_breakdown['by_category_usd']['wsol_cleanup']:.4f} (cumulative)")
            logger.info(f"  Stop-Loss:      ${cost_breakdown['by_category_usd']['stop_loss']:.4f} (cumulative)")
            logger.info(f"  --------------------------------")
            # Total costs = net position costs + other costs
            other_costs = (
                cost_breakdown['by_category_usd']['swap'] +
                cost_breakdown['by_category_usd']['wsol_cleanup'] +
                cost_breakdown['by_category_usd']['stop_loss']
            )
            total_net_costs = net_open_close + other_costs
            logger.info(f"  TOTAL COSTS:    ${total_net_costs:.4f} (net, rent excluded)")
            logger.info("=" * 40)

        logger.info("")
        logger.info("=" * 60)

        # 6. Periodic wSOL cleanup (if enabled)
        if (self.config.wsol_cleanup.enabled and
            self.config.wsol_cleanup.periodic_cleanup and
            iteration > 0 and
            (iteration - self._last_wsol_cleanup_iteration) >= self.config.wsol_cleanup.periodic_interval):
            logger.debug(f"Running periodic wSOL cleanup (iteration {iteration})")
            cleanup_result = await self._perform_wsol_cleanup(reason="periodic")
            if cleanup_result and cleanup_result.success:
                self._last_wsol_cleanup_iteration = iteration

    def _check_rebalance_conditions(
        self,
        snapshot: PositionSnapshot,
        market_state: MarketState
    ) -> Optional[str]:
        """
        Check all rebalance conditions.

        Returns trigger reason or None if no rebalance needed.
        """
        # Check emergency first (can trigger even if daily limit reached)
        if self._price_at_last_rebalance:
            is_emergency = self.market_analyzer.check_emergency_condition(
                market_state.price,
                self._price_at_last_rebalance
            )
            if is_emergency and self.session_manager.can_emergency_rebalance():
                return "emergency"

        # Get daily stats for logging
        daily_stats = None
        if self.session_manager and self.session_manager.state:
            daily_stats = self.session_manager.state.get_daily_stats()

        # Check if daily limit allows normal rebalance
        can_rebalance = self.session_manager.can_rebalance()
        max_rebalances = self.config.rebalance.max_rebalances_per_day

        # Log rebalance status with current counts (always visible at INFO level)
        if daily_stats:
            rebalance_count = daily_stats.rebalance_count
            logger.info(f"Daily rebalances: {rebalance_count}/{max_rebalances} | Can rebalance: {can_rebalance}")
            # CRITICAL: Verify limit is being enforced correctly
            if rebalance_count >= max_rebalances:
                logger.warning(f"⚠️  Rebalance count ({rebalance_count}) already at or above limit ({max_rebalances})")
        else:
            logger.warning("⚠️  Daily stats not available - cannot verify rebalance limit")

        if not can_rebalance:
            # Check if upward rebalance policy allows rebalancing
            if self.config.upward_rebalance.enabled:
                upward_reason = self._check_upward_rebalance_conditions(
                    snapshot, market_state
                )
                if upward_reason:
                    logger.info(f"UPWARD REBALANCE ALLOWED: {upward_reason}")
                    return upward_reason
            
            # Log at INFO level so it's visible in production logs
            logger.info("BLOCKED: Daily rebalance limit reached - cannot rebalance even if out of range")
            # NOTE: Position will be checked again on next iteration. When limit resets at midnight UTC,
            # positions that are still out of range will be rebalanced automatically.
            return None

        # Condition 1: Out of range
        if not snapshot.is_in_range:
            logger.info("Trigger: Position out of range")
            # NOTE: This will trigger rebalance. If limit was just reset, this handles positions
            # that went out of range before the reset.
            return "out_of_range"

        # Condition 2: Ratio skew
        ratio = float(snapshot.token_a_ratio)
        if ratio >= self.config.rebalance.ratio_skew_high:
            logger.info(f"Trigger: Ratio skew high ({ratio*100:.1f}% >= {self.config.rebalance.ratio_skew_high*100}%)")
            return "ratio_skew_high"
        if ratio <= self.config.rebalance.ratio_skew_low:
            logger.info(f"Trigger: Ratio skew low ({ratio*100:.1f}% <= {self.config.rebalance.ratio_skew_low*100}%)")
            return "ratio_skew_low"

        return None

    async def _check_stop_loss_conditions(
        self,
        snapshot: PositionSnapshot,
        market_state: MarketState
    ) -> None:
        """
        Check and execute stop-loss protection if conditions are met.

        STOP-LOSS MECHANISM:
        When price falls significantly below the position's lower bound and rebalancing
        is not possible, this mechanism:
        1. CLOSES the position (withdraws all liquidity)
        2. SWAPS a configured percentage (default 80%) of the resulting SOL to USDC
        3. TRIGGERS position recovery to open a new position

        This protects against further downside by converting SOL exposure to USDC.

        Trigger Conditions:
        1. Stop-loss enabled in config
        2. Rebalances exhausted OR emergency rebalance already used today
        3. Position out of range BELOW lower bound for >= configured duration (default 30 min)
        4. Price declined >= configured threshold from lower bound (default 0.4%)
        5. Cooldown period has passed since last stop-loss execution (default 60 min)

        Args:
            snapshot: Current position snapshot
            market_state: Current market state
        """
        # Check if stop-loss is enabled
        if not self.config.stop_loss.enabled:
            return

        # Check if rebalances are exhausted OR emergency was used today
        can_rebalance = self.session_manager.can_rebalance()
        daily_stats = self.session_manager.state.get_daily_stats() if self.session_manager.state else None
        emergency_used = daily_stats.emergency_used if daily_stats else False
        
        if can_rebalance and not emergency_used:
            # Normal rebalances still available - no need for stop-loss
            return

        # Check if position exists and is out of range BELOW the lower bound
        # Stop-loss only applies when price is BELOW lower bound (downward move exposing to SOL)
        position_id = snapshot.position_address
        lower_price = float(snapshot.lower_price)
        upper_price = float(snapshot.upper_price)
        current_price = market_state.price
        
        # Only trigger if price is BELOW lower bound (not above upper bound)
        is_below_lower = current_price < lower_price
        is_above_upper = current_price > upper_price
        now = datetime.now(timezone.utc)
        
        if snapshot.is_in_range:
            # Position is in range - update last in-range timestamp for this position
            if position_id not in self._position_last_in_range_at or self._position_last_in_range_at[position_id] != now:
                self._position_last_in_range_at[position_id] = now
                logger.debug(f"Position {position_id[:16]}... in range - updating last in-range timestamp")
            return
        
        if is_above_upper:
            # Price is above upper bound - this is not a stop-loss scenario
            # (position is exposed to USDC, not SOL, so no need for stop-loss)
            # But still update last in-range timestamp since it's technically "in range" from stop-loss perspective
            if position_id not in self._position_last_in_range_at or self._position_last_in_range_at[position_id] != now:
                self._position_last_in_range_at[position_id] = now
                logger.debug(f"Position {position_id[:16]}... out of range ABOVE upper bound - updating last in-range timestamp (not applicable for stop-loss)")
            return
        
        if not is_below_lower:
            # Should not happen if is_in_range is False, but defensive check
            return

        # Check if we have a last in-range timestamp for this position
        if position_id not in self._position_last_in_range_at:
            # Never tracked in-range before for this position - try to use position open time as fallback
            monitor = self.position_monitors.get(position_id)
            if monitor and monitor.open_timestamp:
                self._position_last_in_range_at[position_id] = monitor.open_timestamp
                logger.info(f"Position {position_id[:16]}... below lower bound (${lower_price:.4f}) - using position open time as fallback")
            else:
                self._position_last_in_range_at[position_id] = now
                logger.info(f"Position {position_id[:16]}... below lower bound (${lower_price:.4f}) - no previous in-range timestamp, using current time")
            return

        # Check duration threshold: time since position was LAST in range
        last_in_range = self._position_last_in_range_at[position_id]
        duration_minutes = (now - last_in_range).total_seconds() / 60
        if duration_minutes < self.config.stop_loss.out_of_range_duration_minutes:
            logger.debug(
                f"Stop-loss: {duration_minutes:.1f} minutes since position was last in range "
                f"(need {self.config.stop_loss.out_of_range_duration_minutes} minutes)"
            )
            return

        # Check price decline: current_price must be < lower_price * (1 - threshold)
        # Example: if lower_price = $100 and threshold = 0.004, trigger if current_price < $99.60
        # This means price declined by at least 0.4% from the lower bound
        price_threshold = lower_price * (1 - self.config.stop_loss.price_decline_threshold)
        config_breach = current_price < price_threshold

        # Optional second trigger: price below previous day's candle low (UTC)
        prev_day_low = None
        prev_day_breach = False
        try:
            if self.market_analyzer:
                prev_day_low = await self.market_analyzer.get_previous_day_low()
                if prev_day_low is not None:
                    prev_day_breach = current_price < prev_day_low
        except Exception as e:
            logger.warning(f"Stop-loss: Failed to fetch previous day low: {e}")

        if not (config_breach or prev_day_breach):
            price_decline_from_lower = (current_price - lower_price) / lower_price
            extra_context = ""
            if prev_day_low is not None:
                extra_context = f", prev_day_low=${prev_day_low:.4f}"
            logger.debug(
                f"Stop-loss: Current price ${current_price:.4f} >= threshold ${price_threshold:.4f} "
                f"(decline: {price_decline_from_lower*100:.2f}%, need < -{self.config.stop_loss.price_decline_threshold*100:.2f}%)"
                f"{extra_context}"
            )
            return

        # Check cooldown: ensure enough time has passed since last stop-loss execution
        cooldown_minutes = self.config.stop_loss.cooldown_minutes
        last_triggered = self._stop_loss_last_triggered_at.get(position_id)
        if last_triggered:
            minutes_since_last = (now - last_triggered).total_seconds() / 60
            if minutes_since_last < cooldown_minutes:
                logger.debug(
                    f"Stop-loss: Cooldown active - {minutes_since_last:.1f} minutes since last trigger "
                    f"(need {cooldown_minutes} minutes)"
                )
                return

        # All conditions met - execute stop-loss: CLOSE POSITION FIRST, then swap
        logger.warning("=" * 60)
        logger.warning("STOP-LOSS TRIGGERED")
        logger.warning("=" * 60)
        price_decline_from_lower = (current_price - lower_price) / lower_price
        logger.warning(f"Conditions met:")
        logger.warning(f"  - Rebalances exhausted: {not can_rebalance}")
        logger.warning(f"  - Emergency used: {emergency_used}")
        logger.warning(f"  - Time since last in range: {duration_minutes:.1f} minutes (need >= {self.config.stop_loss.out_of_range_duration_minutes})")
        logger.warning(
            f"  - Price decline from lower bound: {price_decline_from_lower*100:.2f}% "
            f"(need < -{self.config.stop_loss.price_decline_threshold*100:.2f}%)"
        )
        if prev_day_low is not None:
            logger.warning(
                f"  - Previous day low: ${prev_day_low:.4f} "
                f"(current ${current_price:.4f} {'<' if prev_day_breach else '>='} prev_day_low)"
            )
        logger.warning(f"  - Lower bound: ${lower_price:.4f}")
        logger.warning(f"  - Current price: ${current_price:.4f} (threshold: ${price_threshold:.4f})")
        logger.warning(f"  - Upper bound: ${upper_price:.4f}")
        if last_triggered:
            logger.warning(f"  - Minutes since last stop-loss: {minutes_since_last:.1f}")

        if not self.trade_executor:
            logger.error("Stop-loss: Trade executor not available")
            return

        try:
            # STEP 1: Close the position first to unlock liquidity
            logger.warning("[STEP 1] Closing position to unlock liquidity...")

            # Get pre-close balance for logging
            pre_close_sol, pre_close_usdc = await self.trade_executor.get_balances()
            logger.warning(f"  Pre-close balance: {pre_close_sol:.6f} SOL, ${pre_close_usdc:.2f} USDC")

            # Get snapshot fees before closing (for accurate fee tracking)
            snapshot_fees_sol = float(snapshot.pending_fees_a) if snapshot.pending_fees_a else 0.0
            snapshot_fees_usdc = float(snapshot.pending_fees_b) if snapshot.pending_fees_b else 0.0
            logger.warning(f"  Pending fees (pre-close): {snapshot_fees_sol:.6f} SOL, ${snapshot_fees_usdc:.2f} USDC")

            # Calculate position value at CURRENT price (not snapshot price) to avoid
            # price mismatch in cost calculation. snapshot.current_value_usd uses the
            # price at snapshot time, but _calculate_actual_cost uses market_state.price.
            # Using snapshot token amounts with current price eliminates this drift.
            if snapshot:
                position_value_for_close = (
                    float(snapshot.current_token_a) * market_state.price
                    + float(snapshot.current_token_b)
                )
            else:
                position_value_for_close = 0.0

            close_result = await self.trade_executor.close_position(
                position_address=position_id,
                collect_fees=True,
                current_price=market_state.price,
                position_value_usd=position_value_for_close,
                pre_close_fees_sol=snapshot_fees_sol,
                pre_close_fees_usdc=snapshot_fees_usdc,
            )

            if not close_result.success:
                logger.error(f"Stop-loss: Failed to close position: {close_result.error}")
                logger.error("Aborting stop-loss - position remains open")
                return

            logger.warning(f"  Position closed successfully: {close_result.signature}")
            logger.warning(f"  Withdrawn: {close_result.withdrawn_sol:.6f} SOL, ${close_result.withdrawn_usdc:.2f} USDC")

            # Use TX-parsed fees from close_result (set by parse_close_position_amounts)
            actual_fees_sol = close_result.fees_collected_sol
            actual_fees_usdc = close_result.fees_collected_usdc
            logger.info(f"  TX-parsed fees: {actual_fees_sol:.6f} SOL, ${actual_fees_usdc:.2f} USDC")

            # Record stop-loss close cost (only if close succeeded and actual_cost is available)
            close_actual = getattr(close_result, 'actual_cost', None)
            if close_actual:
                self.session_manager.state.add_cost(
                    'stop_loss',
                    Decimal(str(close_actual.actual_cost_sol)),
                    Decimal(str(close_actual.actual_cost_usd))
                )
                logger.warning(f"  Stop-loss close cost: ${close_actual.actual_cost_usd:.4f} ({close_actual.actual_cost_sol:.6f} SOL)")
            else:
                logger.warning("COST TRACKING: close_result.actual_cost is None for stop-loss close — cost not recorded")

            # Record position close in session manager
            self.session_manager.close_position(
                position_address=position_id,
                close_price=Decimal(str(market_state.price)),
                final_token_a=Decimal(str(close_result.withdrawn_sol)),
                final_token_b=Decimal(str(close_result.withdrawn_usdc)),
                fees_earned=Decimal(str(snapshot_fees_usdc)),
                tx_fee=Decimal(str(close_result.tx_fee_sol)),
                reason="stop_loss",
                realized_fees_sol=Decimal(str(actual_fees_sol)),
                realized_fees_usdc=Decimal(str(actual_fees_usdc)),
            )

            # Log to CSV with close reason
            # CRITICAL: Get actual cost from close_result if available
            close_actual_cost = getattr(close_result, 'actual_cost', None)
            actual_cost_close_usd = close_actual_cost.actual_cost_usd if close_actual_cost else 0.0
            
            if self.csv_logger:
                try:
                    tvl_at_exit, fee_tier, _ = await self._get_pool_metrics_for_csv()
                    self.csv_logger.log_position_close(
                        position_address=position_id,
                        exit_price=market_state.price,
                        sol_withdrawn=close_result.withdrawn_sol,
                        usdc_withdrawn=close_result.withdrawn_usdc,
                        fees_sol=actual_fees_sol,
                        fees_usdc=actual_fees_usdc,
                        tx_signature=close_result.signature or "",
                        fee_tier=fee_tier,
                        tvl_at_exit=tvl_at_exit,
                        close_tx_fee_sol=close_result.tx_fee_sol,
                                close_reason="stop_loss",
                                actual_cost_close_usd=actual_cost_close_usd,  # CRITICAL: Include actual cost
                            )
                        # CSV is automatically synced in _write_lp_row() via os.fsync()
                except Exception as e:
                    logger.warning(f"Stop-loss: Failed to log position close to CSV: {e}")

            # Unregister position from monitors
            if position_id in self.position_monitors:
                del self.position_monitors[position_id]

            # Clear stop-loss tracking for this closed position
            if position_id in self._position_last_in_range_at:
                del self._position_last_in_range_at[position_id]

            # Schedule recovery for next day (regardless of whether swap succeeds)
            # Position is now closed, so we need to open a new one
            self._stop_loss_occurred_date = now.date()
            logger.warning("Stop-loss: Position closed - recovery scheduled for next day")

            # Send position closed email
            if self.email_notifier:
                try:
                    ctx = await self._get_email_context()
                    stop_loss_close_actual = getattr(close_result, 'actual_cost', None)
                    self.email_notifier.notify_position_closed(
                        position_address=position_id,
                        lower_price=float(snapshot.lower_price),
                        upper_price=float(snapshot.upper_price),
                        withdrawn_sol=close_result.withdrawn_sol,
                        withdrawn_usdc=close_result.withdrawn_usdc,
                        fees_collected_sol=actual_fees_sol,
                        fees_collected_usdc=actual_fees_usdc,
                        close_reason="stop_loss",
                        price=ctx['price'],
                        atr_pct=ctx['atr_pct'],
                        lower_target=ctx['lower_target'],
                        upper_target=ctx['upper_target'],
                        sol_balance=ctx['sol_balance'],
                        usdc_balance=ctx['usdc_balance'],
                        pool_address=ctx['pool_address'],
                        session_state=ctx['session_state'],
                        tick_current=ctx['tick_current'],
                        pool_sqrt_price=ctx.get('pool_sqrt_price', 0),
                        price_source=ctx.get('price_source', 'unknown'),
                        actual_cost_close_usd=stop_loss_close_actual.actual_cost_usd if stop_loss_close_actual else 0.0,
                    )
                except Exception as e:
                    logger.warning(f"Failed to send position closed email: {e}")

            # STEP 2: Get updated balance AFTER closing position
            logger.warning("[STEP 2] Getting balance after position close...")
            await asyncio.sleep(2)  # Allow balance to settle
            sol_balance, usdc_balance = await self.trade_executor.get_balances()
            logger.warning(f"  Post-close balance: {sol_balance:.6f} SOL, ${usdc_balance:.2f} USDC")
            logger.warning(f"  SOL unlocked from position: {sol_balance - pre_close_sol:.6f} SOL")

            sol_reserve = self.config.capital.min_sol_reserve
            available_sol = max(0, sol_balance - sol_reserve)

            if available_sol <= 0.01:  # Minimum threshold
                logger.warning("Stop-loss: Insufficient SOL to swap after position close")
                logger.warning(f"  Available: {available_sol:.6f} SOL (after {sol_reserve:.4f} reserve)")
                # Position was closed successfully, record the trigger time
                self._stop_loss_last_triggered_at[position_id] = now
                logger.warning("=" * 60)
                return

            # STEP 3: Calculate and execute swap
            logger.warning("[STEP 3] Executing stop-loss swap...")
            swap_amount_sol = available_sol * self.config.stop_loss.swap_percentage
            swap_amount_lamports = int(swap_amount_sol * 1e9)

            logger.warning(f"  Available SOL: {available_sol:.6f} (after {sol_reserve:.4f} reserve)")
            logger.warning(f"  Swap percentage: {self.config.stop_loss.swap_percentage*100:.0f}%")
            logger.warning(f"  Swap amount: {swap_amount_sol:.6f} SOL")
            logger.warning(f"  Slippage: {self.config.stop_loss.slippage_bps} bps")

            # Execute swap using JupiterSwapService (Ultra API if configured)
            from app.chain.aggregator_jupiter import JupiterSwapService
            from solders.keypair import Keypair

            # Create swap service with Ultra API support from config
            swap_service = JupiterSwapService(
                use_ultra=self.config.jupiter.use_ultra,
                ultra_gasless=self.config.jupiter.ultra_gasless,
                fallback_enabled=self.config.jupiter.ultra_fallback_enabled,
                circuit_breaker_threshold=self.config.jupiter.ultra_circuit_breaker_threshold,
                circuit_breaker_cooldown=self.config.jupiter.ultra_circuit_breaker_cooldown,
                api_key=self.config.api.jupiter_api_key,
            )

            # Get wallet keypair
            wallet_key = self.config.api.wallet_private_key
            if not wallet_key:
                logger.error("Stop-loss: Wallet private key not available")
                # Position already closed, record trigger time anyway
                self._stop_loss_last_triggered_at[position_id] = now
                return

            wallet_keypair = Keypair.from_base58_string(wallet_key)

            # Execute swap (SwapService handles quote + execution internally)
            sol_mint = self.config.pool.sol_mint
            usdc_mint = self.config.pool.usdc_mint

            logger.warning(f"  Using Jupiter {'Ultra API' if self.config.jupiter.use_ultra else 'Swap API'}")

            swap_result = await swap_service.execute_swap(
                input_mint=sol_mint,
                output_mint=usdc_mint,
                amount=swap_amount_lamports,
                taker_keypair=wallet_keypair,
                slippage_bps=self.config.stop_loss.slippage_bps,
            )

            if swap_result.success:
                logger.warning("Stop-loss swap executed successfully")
                logger.warning(f"  Signature: {swap_result.signature}")
                # SwapResult from service has int amounts
                input_sol = swap_result.input_amount / 1e9
                output_usdc = swap_result.output_amount / 1e6
                logger.warning(f"  Input: {input_sol:.6f} SOL")
                logger.warning(f"  Output: {output_usdc:.2f} USDC")

                # Record swap in session manager
                self.session_manager.record_swap(
                    direction="sell_sol",
                    input_amount=Decimal(str(swap_result.input_amount / 1e9)),
                    output_amount=Decimal(str(swap_result.output_amount / 1e6)),
                    input_token="SOL",
                    output_token="USDC",
                    signature=swap_result.signature,
                    tx_fee_sol=Decimal("0.001"),  # Estimate
                    reason="stop_loss",
                    price=Decimal(str(market_state.price)),
                )

                # Track stop-loss swap cost via add_cost() (actual cost from balance diffs)
                swap_actual_cost = getattr(swap_result, 'actual_cost', None)
                if swap_actual_cost:
                    self.session_manager.state.add_cost(
                        'stop_loss',
                        Decimal(str(swap_actual_cost.actual_cost_sol)),
                        Decimal(str(swap_actual_cost.actual_cost_usd))
                    )
                    logger.warning(f"  Stop-loss swap cost: ${swap_actual_cost.actual_cost_usd:.4f} ({swap_actual_cost.actual_cost_sol:.6f} SOL)")
                else:
                    logger.warning("  Stop-loss swap cost: not available (actual_cost is None)")

                # Record stop-loss trigger time for cooldown tracking
                self._stop_loss_last_triggered_at[position_id] = now

                # Send swap email notification
                if self.email_notifier:
                    try:
                        ctx = await self._get_email_context()
                        # Get actual cost from swap result (already extracted above)
                        swap_actual_cost_usd = swap_actual_cost.actual_cost_usd if swap_actual_cost else 0.0

                        self.email_notifier.notify_swap(
                            direction="sell_sol",
                            input_amount=swap_result.input_amount / 1e9,
                            output_amount=swap_result.output_amount / 1e6,
                            input_token="SOL",
                            output_token="USDC",
                            reason="stop_loss",
                            signature=swap_result.signature,
                            price=ctx['price'],
                            atr_pct=ctx['atr_pct'],
                            lower_target=ctx['lower_target'],
                            upper_target=ctx['upper_target'],
                            sol_balance=ctx['sol_balance'],
                            usdc_balance=ctx['usdc_balance'],
                            pool_address=ctx['pool_address'],
                            session_state=ctx['session_state'],
                            tick_current=ctx['tick_current'],
                            liquidity=ctx['liquidity'],
                            tx_fee_sol=getattr(swap_result, 'tx_fee_sol', 0.0),
                            actual_cost_usd=swap_actual_cost_usd,
                        )
                    except Exception as e:
                        logger.warning(f"Failed to send stop-loss swap email: {e}")

                logger.warning("=" * 60)
                logger.info("Stop-loss swap complete - position recovery already scheduled for next day")
            else:
                logger.error(f"Stop-loss swap failed: {swap_result.error}")
                # Position was already closed, record trigger time to enforce cooldown
                # even on swap failure (to prevent rapid-fire attempts)
                self._stop_loss_last_triggered_at[position_id] = now

        except Exception as e:
            logger.exception(f"Stop-loss: Error during execution: {e}")
            # Don't set trigger time on exception - allow retry next iteration

    def _get_last_rebalance_time(self) -> Optional[datetime]:
        """Get timestamp of last rebalance from session manager."""
        if not self.session_manager or not self.session_manager.state:
            return None
        
        rebalances = self.session_manager.state.rebalances
        if not rebalances:
            return None
        
        # Get most recent rebalance
        last = rebalances[-1]
        return last.timestamp if hasattr(last, 'timestamp') else None

    def _check_upward_rebalance_conditions(
        self,
        snapshot: PositionSnapshot,
        market_state: MarketState
    ) -> Optional[str]:
        """
        Check if upward rebalance conditions are met when daily limit is reached.
        
        Only applies when:
        - Policy is enabled
        - Daily rebalance limit is reached (checked by caller)
        - Price is ABOVE upper limit (not below lower)
        - Price exceeds upper limit by threshold
        - Minimum interval and cooldown conditions met
        
        Returns:
            Reason string if conditions met, None otherwise
        """
        if not self.config.upward_rebalance.enabled:
            return None
        
        position_id = snapshot.position_address
        upper_price = float(snapshot.upper_price)
        current_price = market_state.price
        
        # Only trigger if price is ABOVE upper bound (not below lower)
        if current_price <= upper_price:
            return None
        
        # Check threshold: price must exceed upper by threshold_pct
        threshold_price = upper_price * (1 + self.config.upward_rebalance.threshold_pct)
        if current_price < threshold_price:
            price_excess = (current_price - upper_price) / upper_price * 100
            logger.debug(
                f"Upward rebalance: Price ${current_price:.4f} above upper ${upper_price:.4f} "
                f"but below threshold ${threshold_price:.4f} "
                f"(excess: {price_excess:.2f}%, need >= {self.config.upward_rebalance.threshold_pct*100:.2f}%)"
            )
            return None
        
        # Check minimum interval since last rebalance
        last_rebalance = self._get_last_rebalance_time()
        if last_rebalance:
            minutes_since = (datetime.now(timezone.utc) - last_rebalance).total_seconds() / 60
            if minutes_since < self.config.upward_rebalance.min_interval_minutes:
                logger.debug(
                    f"Upward rebalance: Only {minutes_since:.1f} minutes since last rebalance "
                    f"(need >= {self.config.upward_rebalance.min_interval_minutes} minutes)"
                )
                return None
        
        # Check cooldown: ensure enough time has passed since last upward rebalance
        last_upward = self._last_upward_rebalance_at.get(position_id)
        if last_upward:
            minutes_since = (datetime.now(timezone.utc) - last_upward).total_seconds() / 60
            if minutes_since < self.config.upward_rebalance.cooldown_minutes:
                logger.debug(
                    f"Upward rebalance: Cooldown active - {minutes_since:.1f} minutes since last upward rebalance "
                    f"(need >= {self.config.upward_rebalance.cooldown_minutes} minutes)"
                )
                return None
        
        # All conditions met
        price_excess = (current_price - upper_price) / upper_price * 100
        logger.info(
            f"UPWARD REBALANCE CONDITIONS MET: "
            f"Price ${current_price:.4f} exceeds upper ${upper_price:.4f} by {price_excess:.2f}% "
            f"(threshold: {self.config.upward_rebalance.threshold_pct*100:.2f}%)"
        )
        
        return "upward_profit_capture"

    async def _check_range_update(self, market_state: MarketState):
        """
        Check if range targets should be updated based on ATR change.

        Updates targets if:
        - ATR changed by >= 10%
        - AND >= 12 hours since last range update
        """
        if not self._last_range_update:
            return

        hours_since = (datetime.now(timezone.utc) - self._last_range_update).total_seconds() / 3600
        if hours_since < self.config.atr.min_hours_between_range_updates:
            return

        # Check if targets differ significantly
        if self._lower_target and self._upper_target:
            old_range = self._upper_target - self._lower_target
            new_range = market_state.upper_target - market_state.lower_target

            if old_range > 0:
                range_change = abs(new_range - old_range) / old_range
                if range_change >= self.config.atr.change_threshold:
                    logger.info(f"Range targets updated: {range_change*100:.1f}% change")
                    self._lower_target = market_state.lower_target
                    self._upper_target = market_state.upper_target
                    self._last_range_update = datetime.now(timezone.utc)

    async def _execute_rebalance(
        self,
        position_address: str,
        snapshot: PositionSnapshot,
        market_state: MarketState,
        reason: str
    ):
        """
        Execute a rebalance operation.

        CRITICAL: Fetches FRESH market state to ensure range targets are calculated
        from current pool price, not stale cached values.
        """
        is_emergency = reason == "emergency"
        is_upward_profit_capture = reason == "upward_profit_capture"

        # CRITICAL FIX: Defensive check - verify rebalance is actually allowed
        # This prevents rebalances when the daily limit is reached (should have been
        # checked in _check_rebalance_conditions, but verify here as a safety measure)
        # EXCEPTION: Upward profit capture rebalances are ALWAYS allowed even when limit is reached
        if not is_emergency and not is_upward_profit_capture:
            can_rebalance = self.session_manager.can_rebalance()
            if not can_rebalance:
                logger.error("=" * 60)
                logger.error("CRITICAL BUG: _execute_rebalance called when rebalance limit reached!")
                logger.error(f"Reason: {reason}")
                logger.error("This should have been blocked in _check_rebalance_conditions()")
                logger.error("ABORTING rebalance to prevent position closure")
                logger.error("=" * 60)
                return  # DO NOT execute rebalance - position should remain open

        logger.info("=" * 40)
        logger.info(f"REBALANCE: {reason.upper()}" + (" [EMERGENCY]" if is_emergency else ""))
        logger.info("=" * 40)

        if not self.trade_executor:
            logger.error("Trade executor not available for live execution")
            return

        # CRITICAL FIX: Get fresh market state instead of using passed market_state
        # This ensures targets are calculated from CURRENT pool price
        logger.info("Fetching fresh market state for rebalance...")
        fresh_market_state = await self.market_analyzer.get_market_state()
        if not fresh_market_state:
            logger.error("Failed to get market state for rebalance")
            return

        # Update display targets (for logging only - actual targets come from fresh_market_state)
        self._lower_target = fresh_market_state.lower_target
        self._upper_target = fresh_market_state.upper_target

        # Fetch pool's actual state from on-chain
        # This is CRITICAL - using wrong tick_spacing causes InvalidTickIndex error
        # CRITICAL: Use force_refresh=True to ensure we get CURRENT pool state, not cached
        try:
            pool_state = await self.trade_executor.get_pool_state(force_refresh=True)
            if not pool_state:
                logger.error("Failed to get pool state for rebalance")
                return
            tick_spacing = pool_state.tick_spacing
            logger.info(f"Pool tick_spacing from on-chain: {tick_spacing}")

            # Record pool state to CSV (so it's available in email attachments)
            if self.csv_logger:
                self.csv_logger.log_pool_state(
                    price=pool_state.current_price,
                    sqrt_price=getattr(pool_state, 'sqrt_price', 0),
                    tick_current=getattr(pool_state, 'tick_current_index', 0),
                    tick_spacing=tick_spacing,
                    liquidity=getattr(pool_state, 'liquidity', 0),
                    fee_rate=getattr(pool_state, 'fee_rate', 0),
                    fee_growth_global_a=getattr(pool_state, 'fee_growth_global_a', 0),
                    fee_growth_global_b=getattr(pool_state, 'fee_growth_global_b', 0),
                    pool_address=self.config.pool.pool_address,
                )
        except Exception as e:
            logger.error(f"Failed to get pool state: {e}")
            return

        # Calculate new tick range from FRESH targets (from current pool price)
        new_lower_tick = price_to_tick(fresh_market_state.lower_target, tick_spacing)
        new_upper_tick = price_to_tick(fresh_market_state.upper_target, tick_spacing)

        # Calculate max amounts based on config - CRITICAL FIX: Use deployment_pct from wallet balance
        # Note: After closing position, wallet will have the freed capital, so we calculate from that
        deployment_pct = self.config.capital.deployment_pct
        sol_reserve = self.config.capital.min_sol_reserve

        # Get current balances (position not closed yet, but will be before opening new one)
        sol_balance, usdc_balance = await self.trade_executor.get_balances()

        # Calculate deployment based on percentage of wallet (after reserve)
        # Add position holdings to balance since position will be closed before opening new one
        projected_sol = sol_balance + float(snapshot.current_token_a)
        projected_usdc = usdc_balance + float(snapshot.current_token_b)
        
        # CRITICAL FIX: Portfolio-aware capital deployment
        # Calculate total portfolio value AFTER closing current position
        # (current position will be closed, so exclude it from already_deployed)
        projected_wallet_value = (projected_sol * fresh_market_state.price) + projected_usdc
        
        # Get value of OTHER tracked positions (excluding the one being closed)
        other_positions_value = 0.0
        for pos_addr, monitor in self.position_monitors.items():
            if pos_addr != position_address:  # Exclude position being closed
                try:
                    pos_snapshot = await monitor.get_snapshot()
                    if pos_snapshot:
                        other_positions_value += pos_snapshot.current_value_usd
                except Exception:
                    pass
        
        # Total portfolio after rebalance (wallet + other positions)
        total_portfolio_after = projected_wallet_value + other_positions_value
        
        # Calculate target deployment from total portfolio
        target_deployment = total_portfolio_after * deployment_pct
        
        # Already deployed = other positions (current position will be closed)
        already_deployed = other_positions_value
        
        # Remaining deployable
        remaining_deployable = target_deployment - already_deployed
        
        # Convert remaining deployable to SOL/USDC (assume 50/50 split)
        # CRITICAL FIX: deployment_pct already applied in remaining_deployable, so use wallet balances directly
        remaining_sol_usd = remaining_deployable / 2
        remaining_usdc_usd = remaining_deployable / 2
        remaining_sol = remaining_sol_usd / fresh_market_state.price if fresh_market_state.price > 0 else 0
        remaining_usdc = remaining_usdc_usd
        
        # Use wallet balances directly (NOT multiplied by deployment_pct - already applied in remaining_deployable)
        # Take minimum to respect both portfolio limits and wallet availability
        max_sol = min(projected_sol - sol_reserve, remaining_sol)
        max_usdc = min(projected_usdc, remaining_usdc)
        
        # Simple: use calculated amounts directly
        # Note: CLMM typically uses ~90% of provided capital, so actual deployment will be ~remaining_deployable * 0.90
        
        # Ensure non-negative
        max_sol = max(0, max_sol)
        max_usdc = max(0, max_usdc)

        # Respect configured maximums as upper bounds (safety limits)
        max_sol = min(max_sol, self.config.capital.max_sol_per_position)
        max_usdc = min(max_usdc, self.config.capital.max_usdc_per_position)
        
        # Log portfolio-aware calculation
        logger.info(f"Rebalance - Portfolio-aware capital deployment:")
        logger.info(f"  Total portfolio (after close): ${total_portfolio_after:.2f} (wallet: ${projected_wallet_value:.2f} + other positions: ${other_positions_value:.2f})")
        logger.info(f"  Target deployment ({deployment_pct*100:.0f}%): ${target_deployment:.2f}")
        logger.info(f"  Already deployed (other positions): ${already_deployed:.2f}")
        logger.info(f"  Remaining deployable: ${remaining_deployable:.2f}")
        
        # Calculate final deployment value
        total_value = (max_sol * fresh_market_state.price) + max_usdc
        
        # CRITICAL: Check minimum deployment threshold
        min_deployment = self.config.capital.min_deployment_usd
        
        # If remaining deployable is negative, don't deploy
        if remaining_deployable < 0:
            logger.warning(f"⚠️  Portfolio deployment limit would be exceeded: ${already_deployed:.2f} / ${target_deployment:.2f}")
            logger.warning("  Deployment limit already exceeded - will not deploy additional capital")
            max_sol = 0
            max_usdc = 0
            total_value = 0
        # If remaining deployable is below minimum threshold, skip deployment
        elif remaining_deployable < min_deployment:
            logger.info(f"ℹ️  Remaining deployable (${remaining_deployable:.2f}) below minimum threshold (${min_deployment:.2f})")
            logger.info(f"  Skipping position opening - transaction costs would exceed benefits")
            logger.info(f"  Will wait for next rebalance to accumulate more capital")
            logger.info(f"  Note: Reserve value fluctuation may cause small discrepancies")
            max_sol = 0
            max_usdc = 0
            total_value = 0
        # If calculated position value is below minimum, also skip
        elif total_value < min_deployment:
            logger.info(f"ℹ️  Calculated position value (${total_value:.2f}) below minimum threshold (${min_deployment:.2f})")
            logger.info(f"  Skipping position opening - position too small to be cost-effective")
            logger.info(f"  Will wait for next rebalance to accumulate more capital")
            max_sol = 0
            max_usdc = 0
            total_value = 0
        elif remaining_deployable < min_deployment * 1.5:  # Warn if close to threshold
            logger.warning(f"⚠️  Remaining deployable (${remaining_deployable:.2f}) close to minimum threshold (${min_deployment:.2f})")
            logger.warning("  Note: Reserve value fluctuation may cause small discrepancies")

        # Calculate liquidity using fresh pool price
        liquidity = int(total_value * 1e6) if total_value > 0 else 0

        # If deployment was skipped due to minimum threshold, we still need to close the old position
        # but won't open a new one. The rebalance logic handles max_sol=0, max_usdc=0 correctly.
        if total_value == 0:
            logger.info("=" * 50)
            logger.info("REBALANCE: SKIPPING NEW POSITION OPENING")
            logger.info("=" * 50)
            logger.info("Reason: Deployment amount below minimum threshold")
            logger.info("Action: Will close old position but not open new one")
            logger.info("  Capital will remain in wallet until next rebalance accumulates more")
            logger.info("  This prevents opening positions too small to be cost-effective")

        logger.info(f"Executing rebalance:")
        logger.info(f"  Current position: {position_address}")
        logger.info(f"  Current range: ${float(snapshot.lower_price):.4f} - ${float(snapshot.upper_price):.4f}")
        logger.info(f"  Pool price: ${fresh_market_state.price:.4f}")
        logger.info(f"  New range: ${fresh_market_state.lower_target:.4f} - ${fresh_market_state.upper_target:.4f}")
        logger.info(f"  New ticks: [{new_lower_tick}, {new_upper_tick}] (tick_spacing={tick_spacing})")
        logger.info(f"  Capital deployment calculation:")
        logger.info(f"    deployment_pct: {deployment_pct*100:.0f}% (from config)")
        logger.info(f"    Wallet balances: {sol_balance:.4f} SOL, ${usdc_balance:.2f} USDC")
        logger.info(f"    Position holdings: {float(snapshot.current_token_a):.4f} SOL, ${float(snapshot.current_token_b):.2f} USDC")
        logger.info(f"    Projected balances: {projected_sol:.4f} SOL, ${projected_usdc:.2f} USDC")
        logger.info(f"    Max amounts (after {deployment_pct*100:.0f}%): {max_sol:.4f} SOL, ${max_usdc:.2f} USDC")
        logger.info(f"    Projected position value: ${total_value:.2f}")

        # ============================================================================
        # CRITICAL FIX: Pre-emptive wSOL cleanup before rebalance
        # ============================================================================
        # Unwrap any existing wSOL BEFORE starting rebalance to ensure swaps have
        # access to native SOL. This is especially important if previous rebalance
        # left wSOL in the wallet.
        # ============================================================================
        if self.config.wsol_cleanup.enabled:
            try:
                wsol_balance = await get_wsol_balance()
                if wsol_balance > 0.01:  # More than 0.01 SOL worth
                    logger.info("=" * 80)
                    logger.info("PRE-REBALANCE wSOL CLEANUP")
                    logger.info("=" * 80)
                    logger.info(f"Found {wsol_balance:.4f} wSOL before rebalance")
                    await self._perform_wsol_cleanup(reason="pre_rebalance")
                    await asyncio.sleep(2)  # Wait for unwrap to finalize
                    logger.info("Pre-rebalance cleanup complete")
                    logger.info("=" * 80)
            except Exception as e:
                logger.warning(f"Pre-rebalance wSOL cleanup failed: {e}")
        # ============================================================================

        try:
            # Execute the rebalance: close + swap if needed + open new
            # CRITICAL: Recompute position value at FRESH price to avoid cost measurement
            # drift from using snapshot.current_value_usd (computed at snapshot-time price).
            if snapshot:
                position_value_for_close = (
                    float(snapshot.current_token_a) * fresh_market_state.price
                    + float(snapshot.current_token_b)
                )
            else:
                position_value_for_close = 0.0
            # Get snapshot fees for accurate close cost calculation
            rebalance_snapshot_fees_sol = float(snapshot.pending_fees_a) if snapshot and snapshot.pending_fees_a else 0.0
            rebalance_snapshot_fees_usdc = float(snapshot.pending_fees_b) if snapshot and snapshot.pending_fees_b else 0.0
            logger.info(f"  Snapshot fees for close cost calc: {rebalance_snapshot_fees_sol:.6f} SOL, ${rebalance_snapshot_fees_usdc:.2f} USDC")

            rebalance_result = await self.trade_executor.rebalance_position(
                current_position_address=position_address,
                new_lower_tick=new_lower_tick,
                new_upper_tick=new_upper_tick,
                max_sol=max_sol,
                max_usdc=max_usdc,
                liquidity=liquidity,
                current_price=fresh_market_state.price,
                position_value_usd=position_value_for_close,
                pre_close_fees_sol=rebalance_snapshot_fees_sol,
                pre_close_fees_usdc=rebalance_snapshot_fees_usdc,
            )

            close_result = rebalance_result.close_result
            open_result = rebalance_result.open_result
            swap_result = rebalance_result.swap_result

            # Track swap in session if one occurred
            swap_record = None
            if swap_result and swap_result.success:
                # Use direction and token info from SwapResult (set by execution layer)
                direction = swap_result.direction or "unknown"
                input_token = swap_result.input_token or "?"
                output_token = swap_result.output_token or "?"

                swap_record = self.session_manager.record_swap(
                    direction=direction,
                    input_amount=Decimal(str(swap_result.input_amount)),
                    output_amount=Decimal(str(swap_result.output_amount)),
                    input_token=input_token,
                    output_token=output_token,
                    signature=swap_result.signature,
                    tx_fee_sol=Decimal("0.001"),
                    reason="rebalance",
                    price=Decimal(str(market_state.price)),
                )

                # Send swap email notification
                if self.email_notifier:
                    try:
                        ctx = await self._get_email_context()
                        # Get actual cost from swap result if available
                        swap_actual_cost = getattr(swap_result, 'actual_cost', None)
                        swap_actual_cost_usd = swap_actual_cost.actual_cost_usd if swap_actual_cost else 0.0

                        self.email_notifier.notify_swap(
                            direction=direction,
                            input_amount=swap_result.input_amount,
                            output_amount=swap_result.output_amount,
                            input_token=input_token,
                            output_token=output_token,
                            reason="rebalance",
                            signature=swap_result.signature,
                            price=ctx['price'],
                            atr_pct=ctx['atr_pct'],
                            lower_target=ctx['lower_target'],
                            upper_target=ctx['upper_target'],
                            sol_balance=ctx['sol_balance'],
                            usdc_balance=ctx['usdc_balance'],
                            pool_address=ctx['pool_address'],
                            session_state=ctx['session_state'],
                            tick_current=ctx['tick_current'],
                            liquidity=ctx['liquidity'],
                            tx_fee_sol=swap_result.tx_fee_sol,
                            actual_cost_usd=swap_actual_cost_usd,
                        )
                    except Exception as e:
                        logger.warning(f"Failed to send swap email: {e}")

            if close_result and close_result.success:
                logger.info(f"Position closed: {close_result.signature}")

                # ===== CAPTURE PENDING FEES FROM SNAPSHOT (CRITICAL FIX) =====
                # The snapshot contains the pending fees calculated from on-chain fee growth
                # BEFORE the position was closed. These are the most accurate estimate of
                # what fees were collected, because:
                # 1. close_result.fees_collected_* are never populated (always 0.0)
                # 2. Helius often cannot separate fees from principal (returns 0)
                # 3. Snapshot pending fees are calculated from actual fee growth data
                snapshot_fees_sol = float(snapshot.pending_fees_a) if snapshot.pending_fees_a else 0.0
                snapshot_fees_usdc = float(snapshot.pending_fees_b) if snapshot.pending_fees_b else 0.0

                logger.info(f"  Snapshot pending fees (pre-close): {snapshot_fees_sol:.6f} SOL, ${snapshot_fees_usdc:.2f} USDC")

                # ===== USE TX-PARSED FEES (from parse_close_position_amounts) =====
                actual_fees_sol = close_result.fees_collected_sol
                actual_fees_usdc = close_result.fees_collected_usdc
                logger.info(f"  TX-parsed fees: {actual_fees_sol:.6f} SOL, ${actual_fees_usdc:.2f} USDC")

                # Calculate realized fees USD value for verification logging
                actual_fees_usd = (actual_fees_sol * market_state.price) + actual_fees_usdc
                logger.info(f"  Final realized fees: {actual_fees_sol:.6f} SOL + ${actual_fees_usdc:.2f} USDC = ${actual_fees_usd:.2f} total")

                # Close position in session manager with ACTUAL fees
                self.session_manager.close_position(
                    position_address=position_address,
                    close_price=Decimal(str(market_state.price)),
                    final_token_a=Decimal(str(close_result.withdrawn_sol)),
                    final_token_b=Decimal(str(close_result.withdrawn_usdc)),
                    fees_earned=Decimal(str(snapshot_fees_usdc)),  # Legacy (deprecated) - now uses snapshot
                    tx_fee=Decimal(str(close_result.tx_fee_sol)),
                    reason="rebalance",
                    realized_fees_sol=Decimal(str(actual_fees_sol)),  # ACTUAL from Helius or snapshot fallback
                    realized_fees_usdc=Decimal(str(actual_fees_usdc)),  # ACTUAL from Helius or snapshot fallback
                )

                # ===== VERIFICATION: Log session accumulated fees =====
                logger.info(f"  Session realized fees (cumulative): ${float(self.session_manager.state.session_realized_fees_usd):.2f}")

                # Unregister old position from monitors
                if position_address in self.position_monitors:
                    del self.position_monitors[position_address]

                # Send position closed email notification
                if self.email_notifier:
                    try:
                        ctx = await self._get_email_context()
                        rebalance_close_actual = getattr(close_result, 'actual_cost', None)
                        self.email_notifier.notify_position_closed(
                            position_address=position_address,
                            lower_price=float(snapshot.lower_price),
                            upper_price=float(snapshot.upper_price),
                            withdrawn_sol=close_result.withdrawn_sol,
                            withdrawn_usdc=close_result.withdrawn_usdc,
                            fees_collected_sol=actual_fees_sol,  # Use ACTUAL fees (from Helius or snapshot)
                            fees_collected_usdc=actual_fees_usdc,  # Use ACTUAL fees (from Helius or snapshot)
                            close_reason=reason,
                            price=ctx['price'],
                            atr_pct=ctx['atr_pct'],
                            lower_target=ctx['lower_target'],
                            upper_target=ctx['upper_target'],
                            sol_balance=ctx['sol_balance'],
                            usdc_balance=ctx['usdc_balance'],
                            pool_address=ctx['pool_address'],
                            session_state=ctx['session_state'],
                            tick_current=ctx['tick_current'],
                            pool_sqrt_price=ctx['pool_sqrt_price'],
                            price_source=ctx['price_source'],
                            actual_cost_close_usd=rebalance_close_actual.actual_cost_usd if rebalance_close_actual else 0.0,
                        )
                    except Exception as e:
                        logger.warning(f"Failed to send position closed email: {e}")

                # Perform wSOL cleanup after closing position (if enabled)
                # This recovers any leftover wSOL from the close operation
                if self.config.wsol_cleanup.enabled and self.config.wsol_cleanup.cleanup_after_close:
                    logger.info("Running post-close wSOL cleanup...")
                    await self._perform_wsol_cleanup(reason="after_close")

            if open_result and open_result.success:
                logger.info(f"New position opened: {open_result.position_address}")
                logger.info(f"  Signature: {open_result.signature}")

                # Register new position for monitoring with ACTUAL deposited amounts for accurate IL
                new_monitor = PositionMonitor(
                    rpc_client=self.rpc,
                    position_address=open_result.position_address,
                    open_price=market_state.price,
                    config=self.config,
                    initial_token_a=open_result.deposited_sol,  # Actual deposited SOL
                    initial_token_b=open_result.deposited_usdc,  # Actual deposited USDC
                )
                if await new_monitor.initialize():
                    self.position_monitors[open_result.position_address] = new_monitor

                    # Register with session
                    self.session_manager.register_position(
                        position_address=open_result.position_address,
                        open_price=Decimal(str(market_state.price)),
                        initial_token_a=Decimal(str(open_result.deposited_sol)),
                        initial_token_b=Decimal(str(open_result.deposited_usdc)),
                        lower_price=Decimal(str(open_result.lower_price)),
                        upper_price=Decimal(str(open_result.upper_price)),
                    )

                    # Update tick range tracking
                    self._lower_tick = open_result.lower_tick
                    self._upper_tick = open_result.upper_tick
                else:
                    # CRITICAL FIX: Handle monitor initialization failure after rebalance
                    # Position was opened but we can't monitor it - trigger recovery
                    logger.error(f"CRITICAL: Monitor initialization failed for new position {open_result.position_address}")
                    logger.error("Position exists on-chain but cannot be monitored - triggering recovery")
                    logger.error(f"Position signature for manual verification: {open_result.signature}")
                    self._needs_position_recovery = True
                    self._recovery_reason = "monitor_init_failed_after_rebalance"
                    self._recovery_attempts = 0

                    # Send email notification about this critical failure
                    if self.email_notifier:
                        try:
                            self.email_notifier.notify_position_lost(
                                position_address=open_result.position_address,
                                reason="monitor_init_failed",
                                details=f"Position opened successfully (sig: {open_result.signature}) but monitor.initialize() failed. "
                                       f"Position may exist on-chain. Recovery triggered.",
                                price=market_state.price,
                                session_state=self.session_manager.get_session_state_for_email(),
                            )
                        except Exception as e:
                            logger.warning(f"Failed to send position lost email: {e}")

            # CRITICAL FIX: Only record rebalance when close actually succeeded.
            # A failed close (e.g., transaction timeout) should NOT consume a daily rebalance slot,
            # because the position was never actually rebalanced. The position remains open and will
            # be retried on the next monitoring iteration.
            close_succeeded = close_result and close_result.success
            if not close_succeeded:
                logger.warning("=" * 60)
                logger.warning("REBALANCE NOT RECORDED: Close did not succeed")
                logger.warning(f"  Close result: {close_result}")
                logger.warning(f"  Close success: {close_result.success if close_result else 'N/A'}")
                logger.warning("  Daily rebalance counter NOT incremented (slot preserved)")
                logger.warning("  Position remains tracked - will retry on next iteration")
                logger.warning("=" * 60)

            if close_succeeded:
                # CRITICAL: Verify rebalance limit BEFORE recording (defensive check)
                # This should have been checked in _check_rebalance_conditions, but verify again here
                # EXCEPTION: Upward profit capture rebalances are ALWAYS allowed even when limit is reached
                daily_stats = self.session_manager.state.get_daily_stats() if self.session_manager.state else None
                max_rebalances = self.config.rebalance.max_rebalances_per_day
                is_upward_profit_capture = reason == "upward_profit_capture"
                if daily_stats:
                    current_count = daily_stats.rebalance_count
                    if current_count >= max_rebalances and not is_emergency and not is_upward_profit_capture:
                        logger.error(f"⚠️  CRITICAL: Attempting to record rebalance when limit already reached!")
                        logger.error(f"   Current count: {current_count}, Max: {max_rebalances}")
                        logger.error(f"   This should have been blocked in _check_rebalance_conditions()")
                        logger.error(f"   Recording anyway for audit purposes, but this indicates a bug")

            # Record the rebalance in session with full details (ONLY if close succeeded)
            # Use actual_fees_sol/usdc which contain the realized fees (from Helius or snapshot fallback)
            # Note: These variables are set when close_result.success is True, so we use them if available
            rebalance_fees_sol = actual_fees_sol if close_succeeded else 0.0
            rebalance_fees_usdc = actual_fees_usdc if close_succeeded else 0.0

            if close_succeeded:
                self.session_manager.record_rebalance(
                    position_address=position_address,
                    trigger_reason=reason,
                    is_emergency=is_emergency,
                    price=Decimal(str(market_state.price)),
                    lower_before=snapshot.lower_price,
                    upper_before=snapshot.upper_price,
                    lower_after=Decimal(str(self._lower_target)),
                    upper_after=Decimal(str(self._upper_target)),
                    tx_fee_sol=Decimal(str(rebalance_result.total_tx_fees_sol)),
                    new_position_address=open_result.position_address if open_result and open_result.success else None,
                    withdrawn_sol=Decimal(str(close_result.withdrawn_sol)) if close_result else Decimal(0),
                    withdrawn_usdc=Decimal(str(close_result.withdrawn_usdc)) if close_result else Decimal(0),
                    deposited_sol=Decimal(str(open_result.deposited_sol)) if open_result and open_result.success else Decimal(0),
                    deposited_usdc=Decimal(str(open_result.deposited_usdc)) if open_result and open_result.success else Decimal(0),
                    fees_collected_sol=Decimal(str(rebalance_fees_sol)),  # Use actual fees, not close_result (which is 0)
                    fees_collected_usdc=Decimal(str(rebalance_fees_usdc)),  # Use actual fees, not close_result (which is 0)
                    swap_record=swap_record,
                )

                # Track upward rebalance if reason is upward_profit_capture
                if reason == "upward_profit_capture":
                    self._last_upward_rebalance_at[position_address] = datetime.now(timezone.utc)
                    logger.info(f"Tracked upward rebalance for position {position_address[:16]}... at {datetime.now(timezone.utc).isoformat()}")

            # Update cumulative transaction costs (by category)
            # Use per-operation ActualCost from balance diffs (ground truth)
            # CRITICAL: Only record costs for SUCCESSFUL operations
            close_actual = getattr(close_result, 'actual_cost', None) if close_result else None
            open_actual = getattr(open_result, 'actual_cost', None) if open_result else None
            swap_actual = getattr(swap_result, 'actual_cost', None) if swap_result else None

            logger.info("=" * 60)
            logger.info("Transaction Costs - This rebalance (per-operation actual):")
            logger.info("=" * 60)
            
            # Only record close cost if close succeeded AND actual_cost is available
            if close_result and close_result.success and close_actual:
                self.session_manager.state.add_cost(
                    'position_close',
                    Decimal(str(close_actual.actual_cost_sol)),
                    Decimal(str(close_actual.actual_cost_usd))
                )
                logger.info(f"  Close:  ${close_actual.actual_cost_usd:.4f} ({close_actual.actual_cost_sol:.6f} SOL)")
                logger.info(f"    Balance before: ${close_actual.value_before_usd:.2f}")
                logger.info(f"    Balance after:  ${close_actual.value_after_usd:.2f}")
                logger.info(f"    Position value: ${close_actual.position_value_usd:.2f}")
            elif close_result and close_result.success and not close_actual:
                logger.warning("COST TRACKING: close_result.actual_cost is None for successful close — cost not recorded")
            elif close_result and not close_result.success:
                logger.info(f"  Close:  FAILED - no cost recorded")

            # Only record open cost if open succeeded AND actual_cost is available
            if open_result and open_result.success and open_actual:
                self.session_manager.state.add_cost(
                    'position_open',
                    Decimal(str(open_actual.actual_cost_sol)),
                    Decimal(str(open_actual.actual_cost_usd))
                )
                logger.info(f"  Open:   ${open_actual.actual_cost_usd:.4f} ({open_actual.actual_cost_sol:.6f} SOL)")
                logger.info(f"    Balance before: ${open_actual.value_before_usd:.2f}")
                logger.info(f"    Balance after:  ${open_actual.value_after_usd:.2f}")
                logger.info(f"    Position value: ${open_actual.position_value_usd:.2f}")
            elif open_result and open_result.success and not open_actual:
                logger.warning("COST TRACKING: open_result.actual_cost is None for successful open — cost not recorded")
            elif open_result and not open_result.success:
                logger.info(f"  Open:   FAILED - no cost recorded")

            # Only record swap cost if swap succeeded AND actual_cost is available
            if swap_result and swap_result.success and swap_actual:
                self.session_manager.state.add_cost(
                    'swap',
                    Decimal(str(swap_actual.actual_cost_sol)),
                    Decimal(str(swap_actual.actual_cost_usd))
                )
                logger.info(f"  Swap:   ${swap_actual.actual_cost_usd:.4f} ({swap_actual.actual_cost_sol:.6f} SOL) [includes slippage]")
                logger.info(f"    Balance before: ${swap_actual.value_before_usd:.2f}")
                logger.info(f"    Balance after:  ${swap_actual.value_after_usd:.2f}")
            elif swap_result and swap_result.success and not swap_actual:
                logger.warning("COST TRACKING: swap_result.actual_cost is None for successful swap — cost not recorded")
            elif swap_result and not swap_result.success:
                logger.info(f"  Swap:   FAILED - no cost recorded")

            total_this_rebalance = (
                (close_actual.actual_cost_usd if close_actual else 0.0) +
                (open_actual.actual_cost_usd if open_actual else 0.0) +
                (swap_actual.actual_cost_usd if swap_actual else 0.0)
            )
            logger.info(f"  TOTAL:  ${total_this_rebalance:.4f}")
            
            # Log cumulative costs for verification
            cost_breakdown = self.session_manager.state.get_cost_breakdown()
            logger.info(f"Transaction Costs - Cumulative:")
            logger.info(f"  Position Open:  ${cost_breakdown['by_category_usd']['position_open']:.4f}")
            logger.info(f"  Position Close: ${cost_breakdown['by_category_usd']['position_close']:.4f}")
            logger.info(f"  Swaps:          ${cost_breakdown['by_category_usd']['swap']:.4f}")
            logger.info(f"  Net Open/Close: ${cost_breakdown.get('net_open_close_usd', 0):.4f}")
            logger.info(f"  Total Net:      ${cost_breakdown['total_usd']:.4f}")
            logger.info("=" * 60)

            # CSV Logging for rebalance FIRST (before email so attachments have data)
            if self.csv_logger:
                try:
                    # Get pool metrics for CSV logging (TVL and fee_tier)
                    tvl_at_exit, fee_tier, volume_24h = await self._get_pool_metrics_for_csv()

                    # Log position close with fees (completes the previous position row)
                    # Use ACTUAL fees from Helius (actual_fees_sol, actual_fees_usdc set above)
                    if close_result and close_result.success:
                        self.csv_logger.log_position_close(
                            position_address=position_address,
                            exit_price=market_state.price,
                            sol_withdrawn=close_result.withdrawn_sol,
                            usdc_withdrawn=close_result.withdrawn_usdc,
                            fees_sol=actual_fees_sol,  # ACTUAL from Helius
                            fees_usdc=actual_fees_usdc,  # ACTUAL from Helius
                            tx_signature=close_result.signature,
                            rebalance_latency_seconds=0.0,  # Will be updated with actual timing
                            fee_tier=fee_tier,
                            tvl_at_exit=tvl_at_exit,
                            close_tx_fee_sol=close_result.tx_fee_sol,
                            close_reason=reason,  # Trigger reason for the close
                            actual_cost_close_usd=close_actual.actual_cost_usd if close_actual else 0.0,
                        )
                        # CSV is automatically synced in _write_lp_row() via os.fsync()

                        # Log fee collection to Asset/Fees sheet with ACTUAL fees
                        # DEBUG: Log fee values before conditional check
                        logger.info(f"CSV fee logging check: actual_fees_sol={actual_fees_sol:.6f}, actual_fees_usdc={actual_fees_usdc:.2f}")
                        if actual_fees_sol > 0 or actual_fees_usdc > 0:
                            logger.info(f"  ✓ Logging fee collection to asset_fees_management.csv")
                            self.csv_logger.log_fee_collection(
                                fees_sol=actual_fees_sol,  # ACTUAL from Helius
                                fees_usdc=actual_fees_usdc,  # ACTUAL from Helius
                                price=market_state.price,
                                tx_signature=close_result.signature,
                            )
                        else:
                            logger.warning(f"  ✗ Skipping fee collection CSV log - both fees are 0 (snapshot: {snapshot_fees_sol:.6f} SOL, ${snapshot_fees_usdc:.2f} USDC)")

                    # Log swap to Asset/Fees sheet if one occurred
                    if swap_result and swap_result.success:
                        self.csv_logger.log_swap(
                            direction=swap_result.direction or "unknown",
                            sol_amount=swap_result.input_amount if swap_result.direction == "sell_sol" else swap_result.output_amount,
                            usdc_amount=swap_result.output_amount if swap_result.direction == "sell_sol" else swap_result.input_amount,
                            price=market_state.price,
                            tx_signature=swap_result.signature,
                        )

                    # Log new position open
                    if open_result and open_result.success:
                        # Increment position index for the new position
                        self.session_manager.state.current_position_index += 1

                        # CRITICAL: Ensure CSV values match email values exactly
                        csv_open_cost = open_actual.actual_cost_usd if open_actual else 0.0
                        csv_swap_cost = swap_actual.actual_cost_usd if swap_actual else 0.0
                        csv_total_cost = csv_open_cost + csv_swap_cost
                        
                        # Verify values match what will be sent in email
                        email_open_cost = open_actual.actual_cost_usd if open_actual else 0.0
                        email_swap_cost = swap_actual.actual_cost_usd if swap_actual else 0.0
                        
                        if abs(csv_open_cost - email_open_cost) > 0.0001:
                            logger.warning(f"CSV/EMAIL MISMATCH: Open cost differs - CSV: ${csv_open_cost:.4f}, Email: ${email_open_cost:.4f}")
                        if abs(csv_swap_cost - email_swap_cost) > 0.0001:
                            logger.warning(f"CSV/EMAIL MISMATCH: Swap cost differs - CSV: ${csv_swap_cost:.4f}, Email: ${email_swap_cost:.4f}")
                        
                        # Compute entry price from actual TX-parsed deposit amounts
                        entry_price = (
                            open_result.deposited_usdc / open_result.deposited_sol
                            if open_result.deposited_sol > 0
                            else market_state.price
                        )
                        self.csv_logger.log_position_open(
                            position_address=open_result.position_address,
                            entry_price=entry_price,
                            sol_amount=open_result.deposited_sol,
                            usdc_amount=open_result.deposited_usdc,
                            lower_price=open_result.lower_price,
                            upper_price=open_result.upper_price,
                            tx_signature=open_result.signature,
                            open_attempts=rebalance_result.open_attempts,
                            tvl=tvl_at_exit,
                            volume_24h=volume_24h,
                            position_index=self.session_manager.state.current_position_index,
                            open_tx_fee_sol=getattr(open_result, 'tx_fee_sol', 0.0),
                            swap_tx_fee_sol=swap_result.tx_fee_sol if swap_result else 0.0,
                            actual_cost_usd=csv_total_cost,  # Total cost (open + swap)
                            actual_cost_open_usd=csv_open_cost,  # Open operation cost only
                            actual_cost_swap_usd=csv_swap_cost,  # Swap operation cost only
                            market_price=market_state.price,
                        )
                        logger.info(f"CSV logged: Open=${csv_open_cost:.4f}, Swap=${csv_swap_cost:.4f}, Total=${csv_total_cost:.4f}")
                except Exception as e:
                    logger.warning(f"Failed to log rebalance to CSV: {e}")

            # Send rebalance email notification (AFTER CSV logging so attachments have data)
            # CRITICAL FIX: Only send email if a rebalance was actually attempted
            # (i.e., if rebalance_result exists and close_result exists)
            # This prevents sending misleading emails when rebalance didn't execute
            if self.email_notifier and rebalance_result and close_result:
                try:
                    ctx = await self._get_email_context()
                    # Per-operation actual costs (from balance diffs — already extracted above)
                    email_close_cost = close_actual.actual_cost_usd if close_actual else 0.0
                    email_open_cost = open_actual.actual_cost_usd if open_actual else 0.0
                    email_swap_cost = swap_actual.actual_cost_usd if swap_actual else 0.0
                    total_actual_cost_usd = email_close_cost + email_open_cost + email_swap_cost

                    # Compute entry price for new position
                    rebalance_entry_price = 0.0
                    if open_result and open_result.success and open_result.deposited_sol > 0:
                        rebalance_entry_price = open_result.deposited_usdc / open_result.deposited_sol

                    self.email_notifier.notify_rebalance(
                        old_position_address=position_address,
                        new_position_address=open_result.position_address if open_result and open_result.success else None,
                        trigger_reason=reason,
                        is_emergency=is_emergency,
                        price_before=float(snapshot.current_price) if hasattr(snapshot, 'current_price') else ctx['price'],
                        lower_before=float(snapshot.lower_price),
                        upper_before=float(snapshot.upper_price),
                        lower_after=self._lower_target,
                        upper_after=self._upper_target,
                        withdrawn_sol=close_result.withdrawn_sol if close_result else 0,
                        withdrawn_usdc=close_result.withdrawn_usdc if close_result else 0,
                        deposited_sol=open_result.deposited_sol if open_result and open_result.success else 0,
                        deposited_usdc=open_result.deposited_usdc if open_result and open_result.success else 0,
                        fees_collected_sol=rebalance_fees_sol,  # Use ACTUAL fees (from Helius or snapshot)
                        fees_collected_usdc=rebalance_fees_usdc,  # Use ACTUAL fees (from Helius or snapshot)
                        tx_fee_sol=rebalance_result.total_tx_fees_sol,
                        price=ctx['price'],
                        atr_pct=ctx['atr_pct'],
                        lower_target=ctx['lower_target'],
                        upper_target=ctx['upper_target'],
                        sol_balance=ctx['sol_balance'],
                        usdc_balance=ctx['usdc_balance'],
                        pool_address=ctx['pool_address'],
                        session_state=ctx['session_state'],
                        tick_current=ctx['tick_current'],
                        # Debug info for troubleshooting
                        open_attempts=rebalance_result.open_attempts,
                        open_errors=rebalance_result.open_errors,
                        fully_succeeded=rebalance_result.fully_succeeded,
                        pool_sqrt_price=ctx['pool_sqrt_price'],
                        price_source=ctx['price_source'],
                        # Actual cost from balance diff
                        actual_cost_usd=total_actual_cost_usd,
                        actual_cost_close_usd=email_close_cost,
                        actual_cost_open_usd=email_open_cost,
                        actual_cost_swap_usd=email_swap_cost,
                        entry_price=rebalance_entry_price,
                    )
                except Exception as e:
                    logger.warning(f"Failed to send rebalance email: {e}")

            # CRITICAL: Send failure alert if position open failed after close succeeded
            if close_result and close_result.success and (not open_result or not open_result.success):
                logger.error("=" * 60)
                logger.error("CRITICAL: Position close succeeded but NEW POSITION OPEN FAILED!")
                logger.error("Funds are sitting idle in wallet. Will attempt recovery next iteration.")
                logger.error(f"Open attempts: {rebalance_result.open_attempts}")
                logger.error(f"Errors: {rebalance_result.open_errors}")
                logger.error("=" * 60)

                # Set flag to trigger recovery on next iteration
                self._needs_position_recovery = True
                self._recovery_reason = reason
                self._recovery_attempts = 0  # Reset counter for fresh recovery cycle

                # Send critical failure email
                if self.email_notifier:
                    try:
                        ctx = await self._get_email_context()
                        # Calculate final slippage that was used
                        base_slippage_bps = self.config.rebalance.slippage_bps
                        progressive_schedule = [0, 50, 150, 300, 500, 650, 750]
                        final_slippage_bps = base_slippage_bps + progressive_schedule[min(rebalance_result.open_attempts - 1, len(progressive_schedule) - 1)]
                        final_slippage_bps = min(final_slippage_bps, 800)

                        self.email_notifier.notify_rebalance_failed(
                            old_position_address=position_address,
                            trigger_reason=reason,
                            error_messages=rebalance_result.open_errors,
                            open_attempts=rebalance_result.open_attempts,
                            price=ctx['price'],
                            atr_pct=ctx['atr_pct'],
                            lower_target=ctx['lower_target'],
                            upper_target=ctx['upper_target'],
                            sol_balance=ctx['sol_balance'],
                            usdc_balance=ctx['usdc_balance'],
                            pool_address=ctx['pool_address'],
                            session_state=ctx['session_state'],
                            close_succeeded=True,
                            withdrawn_sol=close_result.withdrawn_sol if close_result else 0,
                            withdrawn_usdc=close_result.withdrawn_usdc if close_result else 0,
                            final_slippage_bps=final_slippage_bps,
                        )
                    except Exception as e:
                        logger.warning(f"Failed to send rebalance failure email: {e}")

        except Exception as e:
            logger.exception(f"Rebalance execution failed: {e}")

        # Update price at last rebalance
        self._price_at_last_rebalance = market_state.price

    async def _shutdown(self, end_reason: str = "shutdown"):
        """
        Graceful shutdown with position closure and email notification.

        Args:
            end_reason: Why the session is ending ('duration_limit', 'manual_stop', 'error', 'shutdown')
        """
        logger.info("=" * 60)
        logger.info(f"SHUTTING DOWN - Reason: {end_reason}")
        logger.info("=" * 60)

        # Get final price
        if self._last_market_state:
            final_price = Decimal(str(self._last_market_state.price))
            final_price_float = self._last_market_state.price
        else:
            final_price = Decimal(0)
            final_price_float = 0.0

        # Track position closure status
        position_closed = False
        closed_position_address = None

        # Close all active positions before ending session
        if self.position_monitors and self.trade_executor:
            logger.info(f"Closing {len(self.position_monitors)} active position(s)...")

            for position_address, monitor in list(self.position_monitors.items()):
                try:
                    logger.info(f"Closing position: {position_address}")

                    # Get snapshot before closing for logging
                    snapshot = await monitor.get_snapshot()

                    # Recompute position value at final price (not snapshot price) for
                    # accurate close cost tracking - avoids price mismatch drift.
                    if snapshot:
                        position_value_for_close = (
                            float(snapshot.current_token_a) * final_price_float
                            + float(snapshot.current_token_b)
                        )
                    else:
                        position_value_for_close = 0.0

                    # Get snapshot fees BEFORE closing for accurate cost calculation
                    shutdown_fees_sol = float(snapshot.pending_fees_a) if snapshot and snapshot.pending_fees_a else 0.0
                    shutdown_fees_usdc = float(snapshot.pending_fees_b) if snapshot and snapshot.pending_fees_b else 0.0

                    # Close the position
                    close_result = await self.trade_executor.close_position(
                        position_address=position_address,
                        collect_fees=True,
                        current_price=final_price_float,
                        position_value_usd=position_value_for_close,
                        pre_close_fees_sol=shutdown_fees_sol,
                        pre_close_fees_usdc=shutdown_fees_usdc,
                    )

                    if close_result and close_result.success:
                        logger.info(f"Position closed successfully: {close_result.signature}")
                        logger.info(f"  Withdrawn: {close_result.withdrawn_sol:.6f} SOL + ${close_result.withdrawn_usdc:.2f} USDC")

                        # ===== CAPTURE PENDING FEES FROM SNAPSHOT (CRITICAL FIX) =====
                        # Use snapshot fees as fallback since close_result.fees_collected_* are always 0
                        snapshot_fees_sol = float(snapshot.pending_fees_a) if snapshot and snapshot.pending_fees_a else 0.0
                        snapshot_fees_usdc = float(snapshot.pending_fees_b) if snapshot and snapshot.pending_fees_b else 0.0
                        logger.info(f"  Snapshot pending fees (pre-close): {snapshot_fees_sol:.6f} SOL + ${snapshot_fees_usdc:.2f} USDC")

                        # ===== USE TX-PARSED FEES (from parse_close_position_amounts) =====
                        actual_fees_sol = close_result.fees_collected_sol
                        actual_fees_usdc = close_result.fees_collected_usdc
                        actual_fees_usd = (actual_fees_sol * final_price_float) + actual_fees_usdc
                        logger.info(f"  TX-parsed fees: {actual_fees_sol:.6f} SOL + ${actual_fees_usdc:.2f} USDC = ${actual_fees_usd:.2f} total")

                        position_closed = True
                        closed_position_address = position_address

                        # Record the close in session manager with ACTUAL fees
                        if self.session_manager:
                            self.session_manager.close_position(
                                position_address=position_address,
                                close_price=final_price,
                                final_token_a=Decimal(str(close_result.withdrawn_sol)),
                                final_token_b=Decimal(str(close_result.withdrawn_usdc)),
                                fees_earned=Decimal(str(snapshot_fees_usdc)),  # Legacy - use snapshot fees
                                tx_fee=Decimal(str(close_result.tx_fee_sol)),
                                reason="session_end",
                                realized_fees_sol=Decimal(str(actual_fees_sol)),  # ACTUAL
                                realized_fees_usdc=Decimal(str(actual_fees_usdc)),  # ACTUAL
                            )
                            # ===== VERIFICATION: Log session accumulated fees =====
                            logger.info(f"  Session realized fees (cumulative): ${float(self.session_manager.state.session_realized_fees_usd):.2f}")

                        # Log to CSV with TVL and fee_tier for volume calculation
                        # Use ACTUAL fees in CSV logging
                        # CRITICAL: Get actual cost from close_result if available
                        close_actual_cost = getattr(close_result, 'actual_cost', None)
                        actual_cost_close_usd = close_actual_cost.actual_cost_usd if close_actual_cost else 0.0
                        
                        if self.csv_logger and snapshot:
                            tvl_at_exit, fee_tier, _ = await self._get_pool_metrics_for_csv()
                            self.csv_logger.log_position_close(
                                position_address=position_address,
                                exit_price=final_price_float,
                                sol_withdrawn=close_result.withdrawn_sol,
                                usdc_withdrawn=close_result.withdrawn_usdc,
                                fees_sol=actual_fees_sol,  # ACTUAL from Helius or snapshot fallback
                                fees_usdc=actual_fees_usdc,  # ACTUAL from Helius or snapshot fallback
                                tx_signature=close_result.signature or "",
                                fee_tier=fee_tier,
                                tvl_at_exit=tvl_at_exit,
                                close_tx_fee_sol=close_result.tx_fee_sol,
                                close_reason="shutdown",  # Session shutdown/manual close
                                actual_cost_close_usd=actual_cost_close_usd,  # CRITICAL: Include actual cost
                            )
                            # CSV is automatically synced in _write_lp_row() via os.fsync()

                        # Send position closed email
                        if self.email_notifier and snapshot:
                            try:
                                ctx = await self._get_email_context()
                                self.email_notifier.notify_position_closed(
                                    position_address=position_address,
                                    lower_price=float(snapshot.lower_price),
                                    upper_price=float(snapshot.upper_price),
                                    withdrawn_sol=close_result.withdrawn_sol,
                                    withdrawn_usdc=close_result.withdrawn_usdc,
                                    fees_collected_sol=actual_fees_sol,  # Use ACTUAL fees
                                    fees_collected_usdc=actual_fees_usdc,  # Use ACTUAL fees
                                    close_reason="session_end",
                                    price=ctx['price'],
                                    atr_pct=ctx['atr_pct'],
                                    lower_target=ctx['lower_target'],
                                    upper_target=ctx['upper_target'],
                                    sol_balance=ctx['sol_balance'],
                                    usdc_balance=ctx['usdc_balance'],
                                    pool_address=ctx['pool_address'],
                                    session_state=ctx['session_state'],
                                    tick_current=ctx['tick_current'],
                                    pool_sqrt_price=ctx['pool_sqrt_price'],
                                    price_source=ctx['price_source'],
                                    actual_cost_close_usd=actual_cost_close_usd,
                                )
                            except Exception as e:
                                logger.warning(f"Failed to send position closed email: {e}")
                    else:
                        error_msg = close_result.error if close_result else "Unknown error"
                        logger.error(f"Failed to close position {position_address}: {error_msg}")

                except Exception as e:
                    logger.exception(f"Error closing position {position_address}: {e}")

            # Clear position monitors
            self.position_monitors.clear()

        # Get final wallet balances
        final_sol_balance = 0.0
        final_usdc_balance = 0.0
        if self.trade_executor:
            try:
                final_sol_balance, final_usdc_balance = await self.trade_executor.get_balances()

                # Update session manager with final balances
                if self.session_manager:
                    self.session_manager.update_wallet_balance(
                        Decimal(str(final_sol_balance)),
                        Decimal(str(final_usdc_balance)),
                        final_price
                    )
            except Exception as e:
                logger.warning(f"Failed to get final balances: {e}")

        # End session and get summary
        summary = {}
        if self.session_manager and self.session_manager.is_active:
            summary = self.session_manager.end_session(final_price)
            logger.info("Session Summary:")
            for key, value in summary.items():
                logger.info(f"  {key}: {value}")

        # Send session ended email with CSV attachments
        if self.email_notifier and summary:
            try:
                # Get price at start from session
                price_at_start = 0.0
                if self.session_manager and self.session_manager.state:
                    # Calculate from initial value and SOL balance
                    initial_sol = float(self.session_manager.state.initial_sol_balance)
                    initial_usdc = float(self.session_manager.state.initial_usdc_balance)
                    initial_total = float(self.session_manager.state.initial_total_usd)
                    if initial_sol > 0:
                        price_at_start = (initial_total - initial_usdc) / initial_sol

                # Calculate strategy metrics (LP vs HODL)
                # At shutdown, all positions are closed, so we use realized data only
                strategy_metrics = {}
                if self.session_manager and self.session_manager.state:
                    strategy_metrics = self.session_manager.state.get_strategy_metrics(
                        open_positions_value_usd=Decimal(0),  # All positions closed
                        pending_fees_usd=Decimal(0),  # No pending fees
                        open_positions_hodl_value_usd=Decimal(0),  # No open positions
                        open_positions_il_usd=Decimal(0),  # No open positions
                    )

                self.email_notifier.notify_session_ended(
                    session_id=summary.get('session_id', 'unknown'),
                    end_reason=end_reason,
                    duration_hours=summary.get('duration_hours', 0),
                    total_rebalances=summary.get('total_rebalances', 0),
                    emergency_rebalances=summary.get('emergency_rebalances', 0),
                    initial_value_usd=summary.get('initial_value_usd', 0),
                    final_value_usd=summary.get('current_wallet_value_usd', 0),
                    net_pnl_usd=summary.get('net_pnl_usd', 0),
                    net_pnl_pct=summary.get('net_pnl_pct', 0),
                    total_fees_collected_usd=summary.get('total_fees_earned_usd', 0),
                    price_at_start=price_at_start,
                    price_at_end=final_price_float,
                    position_closed=position_closed,
                    position_address=closed_position_address,
                    final_sol_balance=final_sol_balance,
                    final_usdc_balance=final_usdc_balance,
                    # NEW: Correct session PnL metrics
                    total_deployed_capital_usd=summary.get('total_deployed_capital_usd', 0),
                    currently_deployed_usd=summary.get('currently_deployed_usd', 0),
                    session_pnl_pct_deployed=summary.get('session_pnl_pct_deployed', 0),
                    session_pnl_pct_initial=summary.get('session_pnl_pct_initial', 0),
                    realized_pnl_usd=summary.get('realized_pnl_usd', 0),
                    unrealized_pnl_usd=summary.get('unrealized_pnl_usd', 0),
                    positions_opened=summary.get('positions_opened', 0),
                    positions_closed=summary.get('positions_closed', 0),
                    # Strategy performance metrics (LP vs HODL)
                    strategy_alpha_usd=strategy_metrics.get('strategy_alpha_usd', 0),
                    strategy_alpha_pct=strategy_metrics.get('strategy_alpha_pct', 0),
                    total_market_movement_usd=strategy_metrics.get('total_market_movement_usd', 0),
                    total_il_usd=strategy_metrics.get('total_il_usd', 0),
                    total_tx_costs_usd=strategy_metrics.get('total_tx_costs_usd', 0),
                    lp_beat_hodl=strategy_metrics.get('lp_beat_hodl', False),
                )
                logger.info("Session ended email sent successfully")
            except Exception as e:
                logger.error(f"Failed to send session ended email: {e}")

        self._running = False

    def stop(self):
        """Stop the strategy loop."""
        self._running = False


def parse_args():
    """Parse command line arguments."""
    parser = argparse.ArgumentParser(
        description='LP Strategy v2 - ATR-based concentrated liquidity management'
    )
    parser.add_argument(
        '--position', '-p',
        default=os.getenv('POSITION_ADDRESS'),
        help='Existing position address to monitor'
    )
    parser.add_argument(
        '--open-price',
        type=float,
        default=float(os.getenv('OPEN_PRICE', 0)) or None,
        help='Opening price of the position'
    )
    parser.add_argument(
        '--interval', '-i',
        type=int,
        default=int(os.getenv('CHECK_INTERVAL_SECONDS', 60)),
        help='Check interval in seconds'
    )
    parser.add_argument(
        '--duration', '-d',
        type=int,
        default=int(os.getenv('SESSION_DURATION_MINUTES', 0)),
        help='Session duration in minutes (0 = unlimited)'
    )
    parser.add_argument(
        '--health-port',
        type=int,
        default=int(os.getenv('HEALTH_PORT', 8080)),
        help='Port for health check HTTP server'
    )
    parser.add_argument(
        '--no-health-server',
        action='store_true',
        default=False,
        help='Disable health check HTTP server'
    )
    return parser.parse_args()


async def main():
    """Entry point."""
    args = parse_args()

    # Setup logging
    logging.basicConfig(
        level=logging.INFO,
        format='%(asctime)s [%(levelname)s] %(message)s',
        datefmt='%Y-%m-%d %H:%M:%S',
        handlers=[logging.StreamHandler(sys.stdout)],
        force=True  # Force reconfiguration even if already configured
    )

    # Update config from args
    config = get_config()
    config.session.check_interval_seconds = args.interval
    config.session.duration_minutes = args.duration

    logger.info("=" * 60)
    logger.info("LP STRATEGY v2 - LIVE TRADING")
    logger.info("=" * 60)
    logger.info(f"Position: {args.position or 'None (will create new)'}")
    logger.info(f"Open price: ${args.open_price:.4f}" if args.open_price else "Open price: auto-detect")
    logger.info(f"Interval: {args.interval}s")
    logger.info(f"Duration: {args.duration}min" if args.duration > 0 else "Duration: unlimited")
    logger.info(f"Health server: {'disabled' if args.no_health_server else f'port {args.health_port}'}")

    # Create orchestrator
    orchestrator = LPStrategyOrchestrator(config)

    # Start health check server (for fly.io)
    health_server = None
    if not args.no_health_server:
        health_server = HealthCheckServer(orchestrator, port=args.health_port)
        await health_server.start()

    try:
        # Run strategy
        await orchestrator.run(
            position_address=args.position,
            open_price=args.open_price
        )
    finally:
        # Cleanup health server
        if health_server:
            await health_server.stop()


if __name__ == "__main__":
    asyncio.run(main())
