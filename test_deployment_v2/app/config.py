"""
Configuration management using Pydantic Settings.

Reads environment variables and provides a validated configuration object.
"""

from functools import lru_cache
from typing import Optional

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # -------------------------------------------------------------------------
    # Database
    # -------------------------------------------------------------------------
    database_url: str = Field(
        default="postgresql://solbot:secret@localhost:5432/solbot",
        description="PostgreSQL connection URL (sync driver)"
    )
    database_url_async: Optional[str] = Field(
        default=None,
        description="PostgreSQL connection URL (async driver)"
    )

    @field_validator("database_url", mode="before")
    @classmethod
    def fix_postgres_url(cls, v: str) -> str:
        """Convert postgres:// to postgresql:// for SQLAlchemy 2.0 compatibility."""
        if v and v.startswith("postgres://"):
            return v.replace("postgres://", "postgresql://", 1)
        return v

    # -------------------------------------------------------------------------
    # Solana Network
    # -------------------------------------------------------------------------
    solana_rpc_url: str = Field(
        default="https://api.devnet.solana.com",
        description="Solana RPC endpoint URL for wallet operations"
    )
    mainnet_rpc_url: str = Field(
        default="https://api.mainnet-beta.solana.com",
        description="Mainnet RPC endpoint for fetching real pool data"
    )
    solana_websocket_url: str = Field(
        default="wss://api.devnet.solana.com",
        description="Solana WebSocket endpoint URL"
    )
    solana_network: str = Field(
        default="devnet",
        description="Solana network (mainnet-beta, devnet, testnet)"
    )
    wallet_private_key_base58: Optional[str] = Field(
        default=None,
        description="Wallet private key in base58 format"
    )
    wallet_pubkey: Optional[str] = Field(
        default=None,
        description="Wallet public key (derived from private key if not set)"
    )

    # -------------------------------------------------------------------------
    # Simulation Settings
    # -------------------------------------------------------------------------
    sim_initial_sol: float = Field(
        default=10.0,
        ge=0.0,
        description="Initial simulated SOL balance"
    )
    sim_initial_usdc: float = Field(
        default=1000.0,
        ge=0.0,
        description="Initial simulated USDC balance"
    )

    # -------------------------------------------------------------------------
    # Strategy Parameters
    # -------------------------------------------------------------------------
    strat_min_rebalance_interval_sec: int = Field(
        default=3600,
        ge=60,
        description="Minimum seconds between rebalances"
    )
    strat_min_price_move_pct: float = Field(
        default=0.5,
        ge=0.0,
        le=100.0,
        description="Minimum price move percentage to trigger rebalance"
    )
    strat_max_slippage_bps: int = Field(
        default=50,
        ge=1,
        le=1000,
        description="Maximum slippage in basis points"
    )
    strat_max_rebalances_per_hour: int = Field(
        default=6,
        ge=1,
        le=60,
        description="Maximum rebalances allowed per hour"
    )
    strat_range_width_pct: float = Field(
        default=2.0,
        ge=0.1,
        le=50.0,
        description="Range width as percentage of current price"
    )
    strat_market_data_refresh_sec: int = Field(
        default=5,
        ge=1,
        le=300,
        description="Market data refresh interval in seconds"
    )

    # -------------------------------------------------------------------------
    # Bot Configuration
    # -------------------------------------------------------------------------
    bot_enabled: bool = Field(
        default=True,
        description="Enable/disable bot trading loop"
    )
    bot_loop_interval_sec: int = Field(
        default=10,
        ge=1,
        le=300,
        description="Main loop sleep interval in seconds"
    )

    # -------------------------------------------------------------------------
    # API Configuration
    # -------------------------------------------------------------------------
    api_host: str = Field(
        default="0.0.0.0",
        description="API server host"
    )
    api_port: int = Field(
        default=8000,
        ge=1,
        le=65535,
        description="API server port"
    )

    # -------------------------------------------------------------------------
    # Logging
    # -------------------------------------------------------------------------
    log_level: str = Field(
        default="INFO",
        description="Logging level"
    )
    log_format: str = Field(
        default="json",
        description="Logging format (json or text)"
    )

    # -------------------------------------------------------------------------
    # Orca Whirlpools
    # -------------------------------------------------------------------------
    orca_sol_usdc_pool: str = Field(
        default="HJPjoWUrhoZzkNfRpHuieeFk9WcZWjwy6PBjZ81ngndJ",
        description="SOL/USDC Whirlpool address"
    )
    orca_sol_usdc_pool_mainnet: str = Field(
        default="HJPjoWUrhoZzkNfRpHuieeFk9WcZWjwy6PBjZ81ngndJ",
        description="SOL/USDC Whirlpool address on mainnet"
    )
    orca_sol_usdc_market: str = Field(
        default="Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE",
        description="SOL/USDC Market account for TVL/Volume analytics (Solscan)"
    )
    orca_whirlpool_program_id: str = Field(
        default="whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",
        description="Orca Whirlpools program ID"
    )

    # -------------------------------------------------------------------------
    # Jupiter
    # -------------------------------------------------------------------------
    jupiter_api_url: str = Field(
        default="https://api.jup.ag",
        description="Jupiter API base URL (use /swap/v1/quote endpoint for quotes)"
    )
    jupiter_ultra_api_url: str = Field(
        default="https://ultra-api.jup.ag/v1",
        description="Jupiter Ultra API URL"
    )
    jupiter_only_direct_routes: bool = Field(
        default=True,
        description="Prefer direct routes for highly liquid pairs (reduces swap fees)"
    )
    jupiter_max_accounts: int = Field(
        default=20,
        ge=1,
        le=64,
        description="Maximum number of accounts in swap route (limits route complexity)"
    )

    # -------------------------------------------------------------------------
    # Birdeye API
    # -------------------------------------------------------------------------
    birdeye_api_key: Optional[str] = Field(
        default=None,
        description="Birdeye API key for price data (optional)"
    )
    birdeye_api_url: str = Field(
        default="https://public-api.birdeye.so",
        description="Birdeye API base URL"
    )

    # -------------------------------------------------------------------------
    # Cambrian API (Historical Pool Data)
    # -------------------------------------------------------------------------
    cambrian_api_key: Optional[str] = Field(
        default=None,
        description="Cambrian API key for historical Orca Whirlpool data (optional)"
    )

    # -------------------------------------------------------------------------
    # Dune Analytics (Historical Pool Data - Free Tier)
    # -------------------------------------------------------------------------
    dune_api_key: Optional[str] = Field(
        default=None,
        description="Dune Analytics API key for historical pool data (free at dune.com)"
    )

    # -------------------------------------------------------------------------
    # Helius API (On-chain Historical Data)
    # -------------------------------------------------------------------------
    helius_api_key: Optional[str] = Field(
        default=None,
        description="Helius API key for historical on-chain data (free tier: 1M credits/month at helius.dev)"
    )

    # -------------------------------------------------------------------------
    # Solscan API (Historical Pool Data, Transfers, DeFi Activities)
    # -------------------------------------------------------------------------
    solscan_api_key: Optional[str] = Field(
        default=None,
        description="Solscan Pro API key for historical pool data and DeFi activities (sign up at pro.solscan.io)"
    )
    solscan_api_url: str = Field(
        default="https://pro-api.solscan.io/v2.0",
        description="Solscan Pro API base URL"
    )

    # -------------------------------------------------------------------------
    # Token Mints
    # -------------------------------------------------------------------------
    sol_mint: str = Field(
        default="So11111111111111111111111111111111111111112",
        description="Wrapped SOL mint address"
    )
    usdc_mint: str = Field(
        default="EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        description="USDC mint address"
    )

    # -------------------------------------------------------------------------
    # Transaction Settings
    # -------------------------------------------------------------------------
    tx_priority_fee_enabled: bool = Field(
        default=True,
        description="Enable priority fees for faster transaction inclusion"
    )
    tx_priority_fee_microlamports: int = Field(
        default=1000,
        ge=0,
        description="Priority fee in microlamports per compute unit (~$0.0001 at 1000)"
    )
    tx_compute_unit_limit: int = Field(
        default=200000,
        ge=10000,
        le=1400000,
        description="Compute unit limit for transactions"
    )

    # -------------------------------------------------------------------------
    # Token Extensions (Token2022) for Position NFTs
    # -------------------------------------------------------------------------
    use_token_extensions: bool = Field(
        default=True,
        description="Use Token2022 for position NFTs (all rent refundable, saves ~$1.25/position)"
    )
    token_extensions_with_metadata: bool = Field(
        default=False,
        description="Include metadata in Token2022 positions (uses MetadataPointer extension)"
    )

    # -------------------------------------------------------------------------
    # Risk Management
    # -------------------------------------------------------------------------
    min_sol_balance: float = Field(
        default=0.1,
        ge=0.0,
        description="Minimum SOL balance to keep for fees"
    )
    max_position_size_usd: float = Field(
        default=10000.0,
        ge=0.0,
        description="Maximum position size in USD"
    )
    stop_loss_pct: float = Field(
        default=10.0,
        ge=0.0,
        le=100.0,
        description="Emergency stop loss percentage"
    )

    @field_validator("log_level")
    @classmethod
    def validate_log_level(cls, v: str) -> str:
        """Validate log level is a valid Python logging level."""
        valid_levels = {"DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"}
        upper = v.upper()
        if upper not in valid_levels:
            raise ValueError(f"Invalid log level: {v}. Must be one of {valid_levels}")
        return upper

    @field_validator("solana_network")
    @classmethod
    def validate_solana_network(cls, v: str) -> str:
        """Validate Solana network."""
        valid_networks = {"mainnet-beta", "devnet", "testnet"}
        lower = v.lower()
        if lower not in valid_networks:
            raise ValueError(f"Invalid network: {v}. Must be one of {valid_networks}")
        return lower

    @property
    def async_database_url(self) -> str:
        """Get async database URL, converting from sync URL if needed."""
        if self.database_url_async:
            return self.database_url_async
        # Convert postgresql:// to postgresql+asyncpg://
        return self.database_url.replace(
            "postgresql://", "postgresql+asyncpg://"
        )

    @property
    def is_mainnet(self) -> bool:
        """Check if running on mainnet."""
        return self.solana_network == "mainnet-beta"

    @property
    def slippage_decimal(self) -> float:
        """Get slippage as decimal (e.g., 50 bps -> 0.005)."""
        return self.strat_max_slippage_bps / 10000.0


@lru_cache()
def get_settings() -> Settings:
    """
    Get cached settings singleton.

    Returns:
        Settings: Application configuration object
    """
    return Settings()




def get_current_network() -> str:
    """
    Get the current Solana network.

    Checks database for network override, falls back to env setting.

    Returns:
        str: Network name (mainnet-beta, devnet, testnet)
    """
    try:
        from app.db.session import get_db_context
        from app.db.repositories import ControlFlagRepository

        with get_db_context() as db:
            repo = ControlFlagRepository(db)
            flags = repo.get_or_create()
            # Check if network is stored in control flags
            network = getattr(flags, 'network', None)
            if network:
                return network
    except Exception:
        pass
    return get_settings().solana_network


# Convenience export
settings = get_settings()
