"""
Configuration module for LP Strategy v2.

All configurable parameters are defined here with sensible defaults.
Parameters can be overridden via environment variables.
"""

import os
from dataclasses import dataclass, field
from typing import Optional
from decimal import Decimal


def env_float(key: str, default: float) -> float:
    """Get float from environment variable."""
    return float(os.getenv(key, str(default)))


def env_int(key: str, default: int) -> int:
    """Get int from environment variable."""
    return int(os.getenv(key, str(default)))


def env_str(key: str, default: str) -> str:
    """Get string from environment variable."""
    return os.getenv(key, default)


def env_bool(key: str, default: bool) -> bool:
    """Get bool from environment variable."""
    val = os.getenv(key, str(default)).lower()
    return val in ('true', '1', 'yes')


@dataclass
class RangeConfig:
    """Range calculation parameters."""
    # Aggression coefficient K - controls range width relative to ATR
    k_coefficient: float = field(default_factory=lambda: env_float('K_COEFFICIENT', 0.60))
    k_min: float = field(default_factory=lambda: env_float('K_MIN', 0.55))
    k_max: float = field(default_factory=lambda: env_float('K_MAX', 0.65))

    # Range bounds (as decimal, e.g., 0.03 = 3%)
    min_range: float = field(default_factory=lambda: env_float('MIN_RANGE', 0.03))
    max_range: float = field(default_factory=lambda: env_float('MAX_RANGE', 0.07))

    # Market trend prediction - when False (default), use balanced symmetric range
    # centered on current price. When True, adjust range asymmetrically based on
    # detected market trend (e.g., bias range upward in uptrend).
    # NOTE: Currently only balanced mode is implemented. Trend prediction is planned.
    use_trend_prediction: bool = field(default_factory=lambda: env_bool('USE_TREND_PREDICTION', False))

    # Trend bias factor - how much to shift range in trend direction (0.0 to 1.0)
    # Only applies when use_trend_prediction=True
    # 0.0 = no bias (symmetric), 0.5 = shift half the range, 1.0 = full shift
    trend_bias_factor: float = field(default_factory=lambda: env_float('TREND_BIAS_FACTOR', 0.3))


@dataclass
class ATRConfig:
    """ATR (Average True Range) calculation parameters."""
    # ATR period in days
    period_days: int = field(default_factory=lambda: env_int('ATR_PERIOD_DAYS', 14))

    # ATR recalculation interval in hours
    recalc_interval_hours: int = field(default_factory=lambda: env_int('ATR_RECALC_INTERVAL_HOURS', 4))

    # Minimum hours between range updates based on ATR change
    min_hours_between_range_updates: int = field(default_factory=lambda: env_int('MIN_HOURS_BETWEEN_RANGE_UPDATES', 12))

    # Threshold for ATR change to trigger range update (10% = 0.10)
    change_threshold: float = field(default_factory=lambda: env_float('ATR_CHANGE_THRESHOLD', 0.10))


@dataclass
class RebalanceConfig:
    """Rebalance rules and constraints."""
    # Maximum normal rebalances per day
    max_rebalances_per_day: int = field(default_factory=lambda: env_int('MAX_REBALANCES_PER_DAY', 2))

    # Ratio skew thresholds (trigger rebalance if ratio >= high or <= low)
    ratio_skew_high: float = field(default_factory=lambda: env_float('RATIO_SKEW_HIGH', 0.85))
    ratio_skew_low: float = field(default_factory=lambda: env_float('RATIO_SKEW_LOW', 0.15))

    # Emergency rebalance: intraday move threshold as multiple of ATR
    emergency_atr_multiple: float = field(default_factory=lambda: env_float('EMERGENCY_ATR_MULTIPLE', 3.0))

    # Slippage tolerance in basis points
    slippage_bps: int = field(default_factory=lambda: env_int('SLIPPAGE_BPS', 50))

    # DEPRECATED: token_max now uses full wallet balance as authorization ceiling.
    # This field is kept to avoid breaking envs that set TOKEN_MAX_BASE_BUFFER.
    # It is no longer used in execution.py token_max calculation.
    token_max_base_buffer: float = field(default_factory=lambda: env_float('TOKEN_MAX_BASE_BUFFER', 1.10))


@dataclass
class UpwardRebalanceConfig:
    """Upward rebalance policy after daily limit."""
    # Enable upward rebalance policy
    enabled: bool = field(default_factory=lambda: env_bool('UPWARD_REBALANCE_ENABLED', True))
    
    # Threshold: how much price must exceed upper limit to trigger (as decimal, e.g., 0.004 = 0.4%)
    # Can use same as stop-loss threshold or different value
    threshold_pct: float = field(default_factory=lambda: env_float('UPWARD_REBALANCE_THRESHOLD_PCT', 0.004))
    
    # Minimum time since last rebalance (to prevent rapid-fire rebalancing)
    min_interval_minutes: int = field(default_factory=lambda: env_int('UPWARD_REBALANCE_MIN_INTERVAL_MIN', 30))
    
    # Cooldown after upward rebalance (to prevent multiple triggers on same move)
    cooldown_minutes: int = field(default_factory=lambda: env_int('UPWARD_REBALANCE_COOLDOWN_MIN', 60))


@dataclass
class StopLossConfig:
    """Stop-loss configuration for emergency position closure."""
    enabled: bool = field(default_factory=lambda: env_bool('STOP_LOSS_ENABLED', True))
    
    # Minimum time position must be out of range (below lower bound) before triggering
    out_of_range_duration_minutes: int = field(default_factory=lambda: env_int('STOP_LOSS_OUT_OF_RANGE_DURATION_MIN', 30))
    
    # Price decline threshold from lower bound (as decimal, e.g., 0.004 = 0.4%)
    price_decline_threshold: float = field(default_factory=lambda: env_float('STOP_LOSS_PRICE_DECLINE_THRESHOLD', 0.004))
    
    # Cooldown after stop-loss execution (to prevent multiple triggers)
    cooldown_minutes: int = field(default_factory=lambda: env_int('STOP_LOSS_COOLDOWN_MIN', 60))
    
    # Percentage of SOL to swap to USDC after closing position (as decimal, e.g., 0.5 = 50%)
    swap_percentage: float = field(default_factory=lambda: env_float('STOP_LOSS_SWAP_PERCENTAGE', 0.5))
    
    # Slippage tolerance for stop-loss swap (in basis points)
    slippage_bps: int = field(default_factory=lambda: env_int('STOP_LOSS_SLIPPAGE_BPS', 100))


@dataclass
class SessionConfig:
    """Session parameters."""
    # Session duration in minutes (0 = unlimited)
    duration_minutes: int = field(default_factory=lambda: env_int('SESSION_DURATION_MINUTES', 0))

    # Maximum number of positions to manage
    max_positions: int = field(default_factory=lambda: env_int('MAX_POSITIONS', 1))

    # Check interval in seconds
    check_interval_seconds: int = field(default_factory=lambda: env_int('CHECK_INTERVAL_SECONDS', 60))

    # Data output directory
    data_dir: str = field(default_factory=lambda: env_str('DATA_DIR', '/data'))


@dataclass
class CapitalConfig:
    """Capital allocation parameters."""
    # Maximum SOL to use per position
    max_sol_per_position: float = field(default_factory=lambda: env_float('MAX_SOL_PER_POSITION', 50.0))

    # Maximum USDC to use per position
    max_usdc_per_position: float = field(default_factory=lambda: env_float('MAX_USDC_PER_POSITION', 10000.0))

    # Minimum SOL to keep as reserve (for tx fees)
    min_sol_reserve: float = field(default_factory=lambda: env_float('MIN_SOL_RESERVE', 0.10))

    # Capital deployment percentage (0-1)
    # Percentage of available wallet to provide to CLMM
    # Note: CLMM typically uses ~90% of provided capital, so actual deployment will be approximately deployment_pct * 0.90
    # Example: deployment_pct = 0.95 → Provide 95% of wallet → CLMM uses ~85.5% of wallet
    #          deployment_pct = 1.0 → Provide 100% of wallet → CLMM uses ~90% of wallet (maximum)
    deployment_pct: float = field(default_factory=lambda: env_float('CAPITAL_DEPLOYMENT_PCT', 0.95))

    # Minimum deployment amount in USD to open a position
    # Positions smaller than this are not worth opening due to transaction costs
    # Will wait for next rebalance to accumulate more capital
    min_deployment_usd: float = field(default_factory=lambda: env_float('MIN_DEPLOYMENT_USD', 50.0))


@dataclass
class PoolConfig:
    """Pool and token configuration."""
    # SOL/USDC Whirlpool address (default: 0.04% fee tier, tick_spacing=4)
    # Alternative: HJPjoWUrhoZzkNfRpHuieeFk9WcZWjwy6PBjZ81ngndJ (0.30% fee, tick_spacing=64)
    pool_address: str = field(default_factory=lambda: env_str(
        'SOL_USDC_POOL',
        'Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE'
    ))

    # Token mints
    sol_mint: str = "So11111111111111111111111111111111111111112"
    usdc_mint: str = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"

    # Token decimals
    sol_decimals: int = 9
    usdc_decimals: int = 6


@dataclass
class SwapConfig:
    """Token swap configuration for rebalancing."""
    # Enable swapping before opening positions
    enabled: bool = field(default_factory=lambda: env_bool('SWAP_ENABLED', True))

    # Imbalance threshold to trigger swap (5% = 0.05)
    imbalance_threshold: float = field(default_factory=lambda: env_float('SWAP_IMBALANCE_THRESHOLD', 0.05))

    # Slippage for swaps in basis points (0.15% = 15)
    slippage_bps: int = field(default_factory=lambda: env_int('SWAP_SLIPPAGE_BPS', 15))

    # Minimum swap size in USD (skip tiny swaps to reduce costs)
    min_swap_usd: float = field(default_factory=lambda: env_float('SWAP_MIN_USD', 30.0))


@dataclass
class JupiterConfig:
    """Jupiter API configuration for swaps."""
    # Use Jupiter Ultra API instead of standard Swap API
    # Ultra API enables Jupiter rewards eligibility and potentially gasless transactions
    use_ultra: bool = field(default_factory=lambda: env_bool('JUPITER_USE_ULTRA', False))

    # Enable gasless transactions when eligible (Ultra API only)
    # Gasless reduces transaction costs when Jupiter can cover the gas
    ultra_gasless: bool = field(default_factory=lambda: env_bool('JUPITER_ULTRA_GASLESS', True))

    # Fall back to Swap API if Ultra API fails
    ultra_fallback_enabled: bool = field(default_factory=lambda: env_bool('JUPITER_ULTRA_FALLBACK', True))

    # Circuit breaker: number of consecutive failures before switching to fallback
    ultra_circuit_breaker_threshold: int = field(default_factory=lambda: env_int('JUPITER_ULTRA_CIRCUIT_BREAKER', 3))

    # Circuit breaker: cooldown in seconds before retrying Ultra API
    ultra_circuit_breaker_cooldown: int = field(default_factory=lambda: env_int('JUPITER_ULTRA_COOLDOWN_SEC', 300))

    # Prefer direct routes for highly liquid pairs (reduces multi-hop fees)
    only_direct_routes: bool = field(default_factory=lambda: env_bool('JUPITER_ONLY_DIRECT_ROUTES', True))

    # Maximum accounts in swap route (limits route complexity)
    max_accounts: int = field(default_factory=lambda: env_int('JUPITER_MAX_ACCOUNTS', 20))


@dataclass
class TransactionConfig:
    """Transaction execution configuration."""
    # Priority fee in microlamports per compute unit
    # Higher = faster inclusion during network congestion
    # 1000 microlamports ≈ $0.0001 extra per transaction
    priority_fee_microlamports: int = field(
        default_factory=lambda: env_int('TX_PRIORITY_FEE_MICROLAMPORTS', 1000)
    )

    # Compute unit limit for transactions
    # Default 200,000 is sufficient for most LP operations
    compute_unit_limit: int = field(
        default_factory=lambda: env_int('TX_COMPUTE_UNIT_LIMIT', 200_000)
    )

    # Enable priority fees (can be disabled for testing)
    enabled: bool = field(default_factory=lambda: env_bool('TX_PRIORITY_FEE_ENABLED', True))


@dataclass
class TokenExtensionsConfig:
    """Token Extensions (Token2022) configuration for position management.

    Token Extensions provides a key benefit for LP positions:
    - ALL rent is fully refundable when closing positions
    - The position mint account is closed along with the position

    Standard SPL Token positions leave the mint account open, losing ~0.0089 SOL
    (~$1.15 at $130/SOL) per position cycle.

    Verified savings (measured on mainnet 2026-01-22):
    - Token2022 cycle cost: ~$0.01 (network fees only)
    - Standard SPL Token: ~$1.26 (includes non-refundable mint rent)
    - Savings: ~$1.25 per position cycle (99% reduction!)
    """
    # Use Token2022 program for position NFTs
    # When enabled: Uses open_position_with_token_extensions and close_position_with_token_extensions
    # When disabled: Uses standard SPL Token (legacy behavior)
    enabled: bool = field(default_factory=lambda: env_bool('USE_TOKEN_EXTENSIONS', True))

    # Include metadata in Token2022 position NFTs
    # Token2022 uses MetadataPointer extension, which is more efficient than
    # separate Metaplex metadata accounts. Set to False - bot doesn't need NFT display.
    with_metadata: bool = field(default_factory=lambda: env_bool('TOKEN_EXTENSIONS_WITH_METADATA', False))


@dataclass
class WsolCleanupConfig:
    """wSOL (Wrapped SOL) cleanup configuration."""
    # Enable automatic wSOL cleanup
    enabled: bool = field(default_factory=lambda: env_bool('WSOL_CLEANUP_ENABLED', True))

    # Run cleanup on startup
    cleanup_on_startup: bool = field(default_factory=lambda: env_bool('WSOL_CLEANUP_ON_STARTUP', True))

    # Run cleanup after closing positions
    cleanup_after_close: bool = field(default_factory=lambda: env_bool('WSOL_CLEANUP_AFTER_CLOSE', True))

    # Run periodic cleanup during main loop
    periodic_cleanup: bool = field(default_factory=lambda: env_bool('WSOL_PERIODIC_CLEANUP', True))

    # Periodic cleanup interval in iterations (e.g., every 10 iterations)
    periodic_interval: int = field(default_factory=lambda: env_int('WSOL_CLEANUP_INTERVAL', 10))

    # Minimum wSOL balance to trigger cleanup (in lamports)
    # Accounts below this threshold will be skipped
    min_balance_lamports: int = field(default_factory=lambda: env_int('WSOL_MIN_BALANCE_LAMPORTS', 0))


@dataclass
class EmailConfig:
    """Email notification configuration."""
    # Enable email notifications
    enabled: bool = field(default_factory=lambda: env_bool('EMAIL_ENABLED', False))

    # SMTP server settings
    smtp_server: str = field(default_factory=lambda: env_str('EMAIL_SMTP_SERVER', 'smtp.gmail.com'))
    smtp_port: int = field(default_factory=lambda: env_int('EMAIL_SMTP_PORT', 465))

    # Sender credentials
    sender_email: str = field(default_factory=lambda: env_str('EMAIL_SENDER', ''))
    sender_password: str = field(default_factory=lambda: env_str('EMAIL_PASSWORD', ''))

    # Recipients (comma-separated list in env var)
    recipients_str: str = field(default_factory=lambda: env_str('EMAIL_RECIPIENTS', ''))

    @property
    def recipients(self) -> list:
        """Parse recipients from comma-separated string."""
        return [e.strip() for e in self.recipients_str.split(',') if e.strip()]


@dataclass
class APIConfig:
    """External API configuration."""
    # Solana RPC URL
    rpc_url: str = field(default_factory=lambda: env_str('SOLANA_RPC_URL', ''))

    # Birdeye API key (for price/volatility data)
    birdeye_api_key: str = field(default_factory=lambda: env_str('BIRDEYE_API_KEY', ''))

    # Jupiter API key (for token swaps)
    jupiter_api_key: str = field(default_factory=lambda: env_str('JUPITER_API_KEY', ''))

    # Helius API key (for transaction parsing - ACTUAL fees extraction)
    # Get one at https://dev.helius.xyz - required for accurate fee tracking
    helius_api_key: str = field(default_factory=lambda: env_str('HELIUS_API_KEY', ''))

    # Wallet private key (base58 encoded)
    wallet_private_key: str = field(default_factory=lambda: env_str('WALLET_PRIVATE_KEY_BASE58', ''))



@dataclass
class Config:
    """Main configuration container."""
    range: RangeConfig = field(default_factory=RangeConfig)
    atr: ATRConfig = field(default_factory=ATRConfig)
    rebalance: RebalanceConfig = field(default_factory=RebalanceConfig)
    upward_rebalance: UpwardRebalanceConfig = field(default_factory=UpwardRebalanceConfig)
    stop_loss: StopLossConfig = field(default_factory=StopLossConfig)
    session: SessionConfig = field(default_factory=SessionConfig)
    capital: CapitalConfig = field(default_factory=CapitalConfig)
    pool: PoolConfig = field(default_factory=PoolConfig)
    swap: SwapConfig = field(default_factory=SwapConfig)
    jupiter: JupiterConfig = field(default_factory=JupiterConfig)
    transaction: TransactionConfig = field(default_factory=TransactionConfig)
    token_extensions: TokenExtensionsConfig = field(default_factory=TokenExtensionsConfig)
    wsol_cleanup: WsolCleanupConfig = field(default_factory=WsolCleanupConfig)
    email: EmailConfig = field(default_factory=EmailConfig)
    api: APIConfig = field(default_factory=APIConfig)

    def validate(self) -> list[str]:
        """Validate configuration and return list of errors."""
        errors = []

        if not self.api.rpc_url:
            errors.append("SOLANA_RPC_URL is required")

        if not self.api.wallet_private_key:
            errors.append("WALLET_PRIVATE_KEY_BASE58 is required")

        if self.range.k_coefficient < self.range.k_min or self.range.k_coefficient > self.range.k_max:
            errors.append(f"K_COEFFICIENT must be between {self.range.k_min} and {self.range.k_max}")

        if self.range.min_range >= self.range.max_range:
            errors.append("MIN_RANGE must be less than MAX_RANGE")

        if self.rebalance.ratio_skew_low >= self.rebalance.ratio_skew_high:
            errors.append("RATIO_SKEW_LOW must be less than RATIO_SKEW_HIGH")

        return errors

    def log_config(self, logger) -> None:
        """Log current configuration."""
        logger.info("=" * 50)
        logger.info("CONFIGURATION")
        logger.info("=" * 50)
        logger.info(f"Range: K={self.range.k_coefficient}, min={self.range.min_range*100:.1f}%, max={self.range.max_range*100:.1f}%")
        logger.info(f"Range Mode: {'trend_prediction' if self.range.use_trend_prediction else 'balanced'} (symmetric around price)")
        logger.info(f"ATR: period={self.atr.period_days}d, recalc={self.atr.recalc_interval_hours}h, threshold={self.atr.change_threshold*100:.0f}%")
        logger.info(f"Rebalance: max/day={self.rebalance.max_rebalances_per_day}, skew=[{self.rebalance.ratio_skew_low}, {self.rebalance.ratio_skew_high}]")
        logger.info(f"Emergency: {self.rebalance.emergency_atr_multiple}x ATR move")
        logger.info(f"Upward Rebalance: enabled={self.upward_rebalance.enabled}, threshold={self.upward_rebalance.threshold_pct*100:.2f}%, min_interval={self.upward_rebalance.min_interval_minutes}min, cooldown={self.upward_rebalance.cooldown_minutes}min")
        logger.info(f"Stop-Loss: enabled={self.stop_loss.enabled}, out_of_range_duration={self.stop_loss.out_of_range_duration_minutes}min, price_decline={self.stop_loss.price_decline_threshold*100:.2f}%, cooldown={self.stop_loss.cooldown_minutes}min, swap_pct={self.stop_loss.swap_percentage*100:.0f}%")
        logger.info(f"Session: duration={self.session.duration_minutes}min, max_positions={self.session.max_positions}")
        logger.info(f"Capital: max_sol={self.capital.max_sol_per_position}, max_usdc={self.capital.max_usdc_per_position}")
        logger.info(f"wSOL Cleanup: enabled={self.wsol_cleanup.enabled}, on_startup={self.wsol_cleanup.cleanup_on_startup}, after_close={self.wsol_cleanup.cleanup_after_close}")
        logger.info(f"Jupiter: use_ultra={self.jupiter.use_ultra}, gasless={self.jupiter.ultra_gasless}, fallback={self.jupiter.ultra_fallback_enabled}")
        logger.info(f"Transaction: priority_fee={self.transaction.priority_fee_microlamports} microlamports, compute_limit={self.transaction.compute_unit_limit}, enabled={self.transaction.enabled}")
        logger.info(f"Token Extensions: enabled={self.token_extensions.enabled}, with_metadata={self.token_extensions.with_metadata} (saves ~$1.15/position when enabled)")
        logger.info(f"Email: enabled={self.email.enabled}, recipients={len(self.email.recipients)}")
        logger.info("=" * 50)


# Global config instance
_config: Optional[Config] = None


def get_config() -> Config:
    """Get or create global config instance."""
    global _config
    if _config is None:
        _config = Config()
    return _config


def reset_config() -> None:
    """Reset config (useful for testing)."""
    global _config
    _config = None


def create_config_from_user(user_strategy_config) -> Config:
    """
    Create a Config instance from a user's strategy configuration.

    This factory method creates a new Config starting with environment
    defaults and overriding user-configurable parameters.

    Args:
        user_strategy_config: UserStrategyConfig database model or dict-like object
                             with strategy parameters.

    Returns:
        Config: New Config instance with user overrides applied.
    """
    config = Config()

    # Helper to get attribute safely
    def get_attr(obj, key, default):
        if hasattr(obj, key):
            val = getattr(obj, key)
            return float(val) if val is not None else default
        elif isinstance(obj, dict):
            return float(obj.get(key, default))
        return default

    def get_int_attr(obj, key, default):
        if hasattr(obj, key):
            val = getattr(obj, key)
            return int(val) if val is not None else default
        elif isinstance(obj, dict):
            return int(obj.get(key, default))
        return default

    def get_bool_attr(obj, key, default):
        if hasattr(obj, key):
            val = getattr(obj, key)
            return bool(val) if val is not None else default
        elif isinstance(obj, dict):
            return bool(obj.get(key, default))
        return default

    # Apply user overrides to range config
    config.range.k_coefficient = get_attr(user_strategy_config, 'k_coefficient', config.range.k_coefficient)
    config.range.min_range = get_attr(user_strategy_config, 'min_range', config.range.min_range)
    config.range.max_range = get_attr(user_strategy_config, 'max_range', config.range.max_range)

    # Apply user overrides to ATR config
    config.atr.period_days = get_int_attr(user_strategy_config, 'atr_period_days', config.atr.period_days)
    config.atr.change_threshold = get_attr(user_strategy_config, 'atr_change_threshold', config.atr.change_threshold)

    # Apply user overrides to rebalance config
    config.rebalance.max_rebalances_per_day = get_int_attr(
        user_strategy_config, 'max_rebalances_per_day', config.rebalance.max_rebalances_per_day
    )

    # Map ratio_skew_threshold to high/low
    ratio_threshold = get_attr(user_strategy_config, 'ratio_skew_threshold', 0.90)
    config.rebalance.ratio_skew_high = ratio_threshold
    config.rebalance.ratio_skew_low = 1.0 - ratio_threshold

    # Apply user overrides to capital config
    config.capital.deployment_pct = get_attr(user_strategy_config, 'capital_deployment_pct', config.capital.deployment_pct)
    config.capital.max_sol_per_position = get_attr(user_strategy_config, 'max_sol_per_position', config.capital.max_sol_per_position)
    config.capital.min_sol_reserve = get_attr(user_strategy_config, 'min_sol_reserve', config.capital.min_sol_reserve)

    # Apply user overrides to stop loss config
    config.stop_loss.enabled = get_bool_attr(user_strategy_config, 'stop_loss_enabled', config.stop_loss.enabled)
    # Map stop_loss_pct to price_decline_threshold
    stop_loss_pct = get_attr(user_strategy_config, 'stop_loss_pct', 0.10)
    config.stop_loss.price_decline_threshold = stop_loss_pct

    # Apply user overrides to session config
    config.session.check_interval_seconds = get_int_attr(
        user_strategy_config, 'check_interval_seconds', config.session.check_interval_seconds
    )

    return config
