"""SQLAlchemy ORM models for SOL/USDC Liquidity Manager."""

from datetime import datetime, date
from decimal import Decimal
from enum import Enum
from typing import Optional

from sqlalchemy import (
    Column,
    Integer,
    String,
    DateTime,
    Date,
    Numeric,
    Boolean,
    Text,
    Index,
    UniqueConstraint,
    ForeignKey,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from .base import Base


class BotStatus(str, Enum):
    """Bot status enumeration."""
    RUNNING = "running"
    PAUSED = "paused"
    SAFE_MODE = "safe_mode"


class RebalanceStatus(str, Enum):
    """Rebalance status enumeration."""
    SUCCESS = "success"
    FAILED = "failed"
    PARTIAL = "partial"


class SessionStatus(str, Enum):
    """User strategy session status enumeration."""
    PENDING = "pending"
    RUNNING = "running"
    PAUSED = "paused"
    STOPPED = "stopped"
    ERROR = "error"


# =============================================================================
# MULTI-USER MODELS
# =============================================================================

class User(Base):
    """
    User account linked to Solana wallet.

    Users authenticate via Sign In With Solana (SIWS) by proving ownership
    of their wallet through signature verification.
    """
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    wallet_pubkey = Column(String(50), unique=True, nullable=False, index=True)
    email = Column(String(255), nullable=True)
    created_at = Column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False
    )
    last_login = Column(DateTime(timezone=True), nullable=True)
    is_active = Column(Boolean, default=True, nullable=False)
    settings = Column(JSONB, default={}, nullable=False)

    # Relationships
    hot_wallet = relationship("UserHotWallet", back_populates="user", uselist=False)
    strategy_configs = relationship("UserStrategyConfig", back_populates="user")
    sessions = relationship("UserStrategySession", back_populates="user")
    metric_snapshots = relationship("UserMetricSnapshot", back_populates="user")
    positions = relationship("UserPosition", back_populates="user")

    __table_args__ = (
        Index("ix_users_wallet_active", "wallet_pubkey", "is_active"),
    )


class UserHotWallet(Base):
    """
    Platform-managed hot wallet for each user.

    Each user gets a dedicated hot wallet derived from a master HD wallet
    using BIP44 derivation paths. The private key is encrypted at rest.
    Users deposit funds to this wallet for automated strategy execution.
    """
    __tablename__ = "user_hot_wallets"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), unique=True, nullable=False)
    wallet_pubkey = Column(String(50), nullable=False, unique=True, index=True)
    encrypted_private_key = Column(Text, nullable=False)  # Fernet encrypted
    derivation_index = Column(Integer, nullable=False, unique=True)
    created_at = Column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False
    )
    # Track if user has backed up their private key
    key_backup_confirmed_at = Column(DateTime(timezone=True), nullable=True)

    # Relationship
    user = relationship("User", back_populates="hot_wallet")


class UserStrategyConfig(Base):
    """
    Per-user strategy parameters.

    Users can have multiple strategy configurations but only one active
    at a time per session. Parameters mirror the existing Config dataclass.
    """
    __tablename__ = "user_strategy_configs"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    config_name = Column(String(100), default="default", nullable=False)

    # Range Configuration
    k_coefficient = Column(Numeric(4, 2), default=0.60, nullable=False)
    min_range = Column(Numeric(4, 2), default=0.03, nullable=False)
    max_range = Column(Numeric(4, 2), default=0.07, nullable=False)

    # ATR Configuration
    atr_period_days = Column(Integer, default=14, nullable=False)
    atr_change_threshold = Column(Numeric(4, 2), default=0.15, nullable=False)

    # Rebalance Configuration
    max_rebalances_per_day = Column(Integer, default=2, nullable=False)
    max_emergency_rebalances = Column(Integer, default=4, nullable=False)
    ratio_skew_threshold = Column(Numeric(4, 2), default=0.90, nullable=False)
    ratio_skew_emergency = Column(Numeric(4, 2), default=0.98, nullable=False)

    # Capital Configuration
    capital_deployment_pct = Column(Numeric(4, 2), default=0.80, nullable=False)
    max_sol_per_position = Column(Numeric(20, 9), default=1.0, nullable=False)
    min_sol_reserve = Column(Numeric(20, 9), default=0.05, nullable=False)

    # Stop Loss Configuration
    stop_loss_enabled = Column(Boolean, default=False, nullable=False)
    stop_loss_pct = Column(Numeric(4, 2), default=0.10, nullable=False)

    # Timing Configuration
    check_interval_seconds = Column(Integer, default=30, nullable=False)

    # Status
    is_active = Column(Boolean, default=True, nullable=False)
    created_at = Column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False
    )
    updated_at = Column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False
    )

    # Relationship
    user = relationship("User", back_populates="strategy_configs")
    sessions = relationship("UserStrategySession", back_populates="config")

    __table_args__ = (
        Index("ix_user_strategy_configs_user_active", "user_id", "is_active"),
        UniqueConstraint("user_id", "config_name", name="uq_user_config_name"),
    )


class UserStrategySession(Base):
    """
    Running strategy session for a user.

    Tracks the lifecycle of a user's strategy execution including
    Celery task ID for background execution.
    """
    __tablename__ = "user_strategy_sessions"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    config_id = Column(Integer, ForeignKey("user_strategy_configs.id", ondelete="SET NULL"), nullable=True)

    status = Column(String(20), default=SessionStatus.PENDING.value, nullable=False)
    started_at = Column(DateTime(timezone=True), nullable=True)
    stopped_at = Column(DateTime(timezone=True), nullable=True)

    # Celery task tracking
    celery_task_id = Column(String(50), nullable=True, index=True)

    # Error tracking
    error_message = Column(Text, nullable=True)
    error_count = Column(Integer, default=0, nullable=False)
    last_error_at = Column(DateTime(timezone=True), nullable=True)

    # Performance tracking
    initial_value_usd = Column(Numeric(20, 6), nullable=True)
    current_value_usd = Column(Numeric(20, 6), nullable=True)
    total_fees_earned_usd = Column(Numeric(20, 6), default=0, nullable=False)
    total_il_usd = Column(Numeric(20, 6), default=0, nullable=False)
    total_tx_costs_usd = Column(Numeric(20, 6), default=0, nullable=False)

    # Activity tracking
    rebalance_count = Column(Integer, default=0, nullable=False)
    last_rebalance_at = Column(DateTime(timezone=True), nullable=True)
    last_heartbeat_at = Column(DateTime(timezone=True), nullable=True)

    created_at = Column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False
    )

    # Relationships
    user = relationship("User", back_populates="sessions")
    config = relationship("UserStrategyConfig", back_populates="sessions")
    metric_snapshots = relationship("UserMetricSnapshot", back_populates="session")
    positions = relationship("UserPosition", back_populates="session")
    rebalances = relationship("UserRebalance", back_populates="session")

    __table_args__ = (
        Index("ix_user_sessions_user_status", "user_id", "status"),
        Index("ix_user_sessions_celery_task", "celery_task_id"),
    )


class UserMetricSnapshot(Base):
    """
    Periodic metric snapshots for user dashboards.

    Captured at regular intervals during strategy execution
    to power portfolio charts and performance tracking.
    """
    __tablename__ = "user_metric_snapshots"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    session_id = Column(Integer, ForeignKey("user_strategy_sessions.id", ondelete="CASCADE"), nullable=True)
    timestamp = Column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
        index=True
    )

    # Portfolio value
    total_value_usd = Column(Numeric(20, 6), nullable=False)
    sol_balance = Column(Numeric(20, 9), nullable=False)
    usdc_balance = Column(Numeric(20, 6), nullable=False)
    position_value_usd = Column(Numeric(20, 6), default=0, nullable=False)

    # Performance metrics
    realized_pnl_usd = Column(Numeric(20, 6), default=0, nullable=False)
    unrealized_pnl_usd = Column(Numeric(20, 6), default=0, nullable=False)
    fees_earned_usd = Column(Numeric(20, 6), default=0, nullable=False)
    il_usd = Column(Numeric(20, 6), default=0, nullable=False)
    tx_costs_usd = Column(Numeric(20, 6), default=0, nullable=False)

    # Market data
    sol_price_usd = Column(Numeric(20, 6), nullable=True)
    pool_price = Column(Numeric(20, 6), nullable=True)

    # Position status
    has_active_position = Column(Boolean, default=False, nullable=False)
    position_in_range = Column(Boolean, nullable=True)

    # Relationships
    user = relationship("User", back_populates="metric_snapshots")
    session = relationship("UserStrategySession", back_populates="metric_snapshots")

    __table_args__ = (
        Index("ix_user_metrics_user_ts", "user_id", "timestamp"),
        Index("ix_user_metrics_session_ts", "session_id", "timestamp"),
    )


class UserPosition(Base):
    """
    User-specific CLMM position tracking.

    Links positions to specific users and sessions for multi-user support.
    """
    __tablename__ = "user_positions"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    session_id = Column(Integer, ForeignKey("user_strategy_sessions.id", ondelete="SET NULL"), nullable=True)

    # Position identification
    position_pubkey = Column(String(100), nullable=False, unique=True, index=True)
    pool_id = Column(String(100), nullable=False, index=True)

    # Position parameters
    lower_tick = Column(Integer, nullable=False)
    upper_tick = Column(Integer, nullable=False)
    lower_price = Column(Numeric(20, 6), nullable=False)
    upper_price = Column(Numeric(20, 6), nullable=False)
    liquidity = Column(Numeric(38, 0), nullable=False)

    # Token amounts at entry
    entry_sol_amount = Column(Numeric(20, 9), nullable=False)
    entry_usdc_amount = Column(Numeric(20, 6), nullable=False)
    entry_price = Column(Numeric(20, 6), nullable=False)
    entry_value_usd = Column(Numeric(20, 6), nullable=False)

    # Current token amounts (updated periodically)
    current_sol_amount = Column(Numeric(20, 9), nullable=True)
    current_usdc_amount = Column(Numeric(20, 6), nullable=True)

    # Fees collected
    fees_sol_collected = Column(Numeric(20, 9), default=0, nullable=False)
    fees_usdc_collected = Column(Numeric(20, 6), default=0, nullable=False)

    # Exit data (populated when closed)
    exit_price = Column(Numeric(20, 6), nullable=True)
    exit_value_usd = Column(Numeric(20, 6), nullable=True)
    exit_reason = Column(String(50), nullable=True)  # rebalance, stop_loss, manual, etc.

    # PnL calculations
    realized_pnl_usd = Column(Numeric(20, 6), nullable=True)
    il_usd = Column(Numeric(20, 6), nullable=True)

    # Transaction signatures
    open_tx_sig = Column(String(100), nullable=True)
    close_tx_sig = Column(String(100), nullable=True)

    # Timestamps
    opened_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    closed_at = Column(DateTime(timezone=True), nullable=True)

    # Status
    is_active = Column(Boolean, default=True, nullable=False, index=True)

    # Relationships
    user = relationship("User", back_populates="positions")
    session = relationship("UserStrategySession", back_populates="positions")

    __table_args__ = (
        Index("ix_user_positions_user_active", "user_id", "is_active"),
        Index("ix_user_positions_session", "session_id"),
    )


class UserRebalance(Base):
    """
    User-specific rebalance event log.

    Records every rebalance attempt with full details for user's session.
    """
    __tablename__ = "user_rebalances"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    session_id = Column(Integer, ForeignKey("user_strategy_sessions.id", ondelete="SET NULL"), nullable=True)

    ts = Column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
        index=True
    )

    # Old position
    old_position_id = Column(Integer, ForeignKey("user_positions.id", ondelete="SET NULL"), nullable=True)
    old_lower_tick = Column(Integer, nullable=True)
    old_upper_tick = Column(Integer, nullable=True)

    # New position
    new_position_id = Column(Integer, ForeignKey("user_positions.id", ondelete="SET NULL"), nullable=True)
    new_lower_tick = Column(Integer, nullable=False)
    new_upper_tick = Column(Integer, nullable=False)

    # Trigger reason
    trigger_reason = Column(String(50), nullable=False)  # out_of_range, ratio_skew, emergency, manual

    # Fees collected during rebalance
    fees_sol_collected = Column(Numeric(20, 9), default=0, nullable=False)
    fees_usdc_collected = Column(Numeric(20, 6), default=0, nullable=False)

    # Swap details (if any)
    swap_direction = Column(String(20), nullable=True)  # SOL_TO_USDC, USDC_TO_SOL
    swap_amount_in = Column(Numeric(20, 9), nullable=True)
    swap_amount_out = Column(Numeric(20, 9), nullable=True)
    swap_price = Column(Numeric(20, 6), nullable=True)

    # Transaction costs
    tx_fee_sol = Column(Numeric(20, 9), default=0, nullable=False)
    priority_fee_sol = Column(Numeric(20, 9), default=0, nullable=False)

    # Price at rebalance
    price_at_rebalance = Column(Numeric(20, 6), nullable=False)

    # Status
    status = Column(String(20), nullable=False, default=RebalanceStatus.SUCCESS.value)
    error_message = Column(Text, nullable=True)

    # Transaction signatures
    tx_sig_close = Column(String(100), nullable=True)
    tx_sig_swap = Column(String(100), nullable=True)
    tx_sig_open = Column(String(100), nullable=True)

    # Relationships
    session = relationship("UserStrategySession", back_populates="rebalances")

    __table_args__ = (
        Index("ix_user_rebalances_user_ts", "user_id", "ts"),
        Index("ix_user_rebalances_session", "session_id"),
    )


class UserDailyStats(Base):
    """
    Per-user daily statistics tracking.

    Tracks daily limits like rebalance counts per user,
    enabling enforcement of per-user daily limits.
    """
    __tablename__ = "user_daily_stats"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    date = Column(Date, nullable=False, index=True)

    # Rebalance tracking
    rebalance_count = Column(Integer, default=0, nullable=False)
    emergency_rebalance_count = Column(Integer, default=0, nullable=False)

    # Performance
    fees_earned_usd = Column(Numeric(20, 6), default=0, nullable=False)
    pnl_usd = Column(Numeric(20, 6), default=0, nullable=False)
    tx_costs_usd = Column(Numeric(20, 6), default=0, nullable=False)

    # Activity
    positions_opened = Column(Integer, default=0, nullable=False)
    positions_closed = Column(Integer, default=0, nullable=False)

    __table_args__ = (
        UniqueConstraint("user_id", "date", name="uq_user_daily_stats"),
        Index("ix_user_daily_stats_user_date", "user_id", "date"),
    )


class AuthNonce(Base):
    """
    Authentication nonces for SIWS (Sign In With Solana).

    Stores temporary nonces for wallet signature verification.
    Nonces expire after a short time to prevent replay attacks.
    """
    __tablename__ = "auth_nonces"

    id = Column(Integer, primary_key=True, index=True)
    wallet_pubkey = Column(String(50), nullable=False, index=True)
    nonce = Column(String(64), nullable=False, unique=True)
    created_at = Column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False
    )
    expires_at = Column(DateTime(timezone=True), nullable=False)
    used = Column(Boolean, default=False, nullable=False)

    __table_args__ = (
        Index("ix_auth_nonces_wallet_unused", "wallet_pubkey", "used"),
    )


class AuditLog(Base):
    """
    Audit log for security-sensitive operations.

    Tracks all wallet operations, config changes, and authentication events.
    """
    __tablename__ = "audit_logs"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    timestamp = Column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
        index=True
    )

    action = Column(String(50), nullable=False, index=True)  # login, logout, deposit, withdraw, config_change, etc.
    resource_type = Column(String(50), nullable=True)  # user, session, position, config, etc.
    resource_id = Column(Integer, nullable=True)

    # Request context
    ip_address = Column(String(50), nullable=True)
    user_agent = Column(String(500), nullable=True)

    # Action details
    details = Column(JSONB, nullable=True)

    # Status
    success = Column(Boolean, default=True, nullable=False)
    error_message = Column(Text, nullable=True)

    __table_args__ = (
        Index("ix_audit_logs_user_ts", "user_id", "timestamp"),
        Index("ix_audit_logs_action_ts", "action", "timestamp"),
    )


class StrategyConfig(Base):
    """
    Strategy configuration parameters.

    Stores key-value pairs for strategy parameters that can be
    updated via the API without redeploying.
    """
    __tablename__ = "strategy_config"

    id = Column(Integer, primary_key=True, index=True)
    created_at = Column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False
    )
    updated_at = Column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False
    )

    name = Column(String(100), nullable=False, index=True)
    value = Column(Text, nullable=False)
    value_type = Column(String(20), nullable=False, default="str")
    description = Column(Text, nullable=True)
    updated_by = Column(String(100), nullable=True)

    __table_args__ = (
        UniqueConstraint("name", name="uq_strategy_config_name"),
    )

    def get_typed_value(self):
        """Return value cast to the appropriate Python type."""
        type_map = {
            "int": int,
            "float": float,
            "bool": lambda x: x.lower() in ("true", "1", "yes"),
            "str": str,
            "json": lambda x: __import__("json").loads(x),
        }
        converter = type_map.get(self.value_type, str)
        return converter(self.value)


class Position(Base):
    """
    CLMM position tracking.

    Stores currently open and historical concentrated liquidity positions
    across different DEXs.
    """
    __tablename__ = "positions"

    id = Column(Integer, primary_key=True, index=True)
    created_at = Column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False
    )

    # DEX and pool identification
    dex = Column(String(50), nullable=False, index=True)
    pool_id = Column(String(100), nullable=False, index=True)
    position_pubkey = Column(String(100), nullable=False, unique=True)

    # Position parameters
    lower_tick = Column(Integer, nullable=False)
    upper_tick = Column(Integer, nullable=False)
    liquidity = Column(Numeric(38, 0), nullable=False)

    # Token amounts
    amount_sol = Column(Numeric(20, 9), nullable=False, default=0)
    amount_usdc = Column(Numeric(20, 6), nullable=False, default=0)

    # Timestamps
    opened_at = Column(DateTime(timezone=True), server_default=func.now())
    closed_at = Column(DateTime(timezone=True), nullable=True)

    # Status
    is_active = Column(Boolean, default=True, index=True)

    __table_args__ = (
        Index("ix_positions_dex_pool", "dex", "pool_id"),
        Index("ix_positions_active_dex", "is_active", "dex"),
    )


class Rebalance(Base):
    """
    Rebalance event log.

    Records every rebalance attempt with full details including
    transaction signatures, fees collected, and PnL.
    """
    __tablename__ = "rebalances"

    id = Column(Integer, primary_key=True, index=True)
    ts = Column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
        index=True
    )

    # DEX and pool identification
    dex = Column(String(50), nullable=False, index=True)
    pool_id = Column(String(100), nullable=False, index=True)

    # Old position range
    old_lower_tick = Column(Integer, nullable=True)
    old_upper_tick = Column(Integer, nullable=True)

    # New position range
    new_lower_tick = Column(Integer, nullable=False)
    new_upper_tick = Column(Integer, nullable=False)

    # Fees collected during rebalance
    fees_sol = Column(Numeric(20, 9), nullable=False, default=0)
    fees_usdc = Column(Numeric(20, 6), nullable=False, default=0)

    # Estimated PnL (including IL and fees)
    pnl_usd = Column(Numeric(20, 6), nullable=True)

    # Transaction signatures
    tx_sig_remove = Column(String(100), nullable=True)
    tx_sig_add = Column(String(100), nullable=True)
    tx_sig_swap = Column(String(100), nullable=True)

    # Status and error handling
    status = Column(String(20), nullable=False, default=RebalanceStatus.SUCCESS.value)
    error_message = Column(Text, nullable=True)

    # Additional metadata
    raw_info = Column(JSONB, nullable=True)

    # Price at rebalance time
    price_at_rebalance = Column(Numeric(20, 6), nullable=True)

    # Position reference
    position_id = Column(Integer, nullable=True)

    __table_args__ = (
        Index("ix_rebalances_ts_status", "ts", "status"),
        Index("ix_rebalances_dex_ts", "dex", "ts"),
    )


class DailyMetric(Base):
    """
    Daily aggregated metrics.

    Stores daily summaries of performance including fees, IL, and PnL.
    """
    __tablename__ = "metrics_daily"

    id = Column(Integer, primary_key=True, index=True)
    date = Column(Date, nullable=False, index=True)
    dex = Column(String(50), nullable=True, index=True)

    # Financial metrics
    fees_usd = Column(Numeric(20, 6), nullable=False, default=0)
    il_estimate_usd = Column(Numeric(20, 6), nullable=False, default=0)
    pnl_usd = Column(Numeric(20, 6), nullable=False, default=0)

    # Volume and activity
    volume_usd = Column(Numeric(20, 6), nullable=True)
    num_rebalances = Column(Integer, nullable=False, default=0)

    # Position metrics
    avg_liquidity = Column(Numeric(38, 0), nullable=True)
    time_in_range_pct = Column(Numeric(5, 2), nullable=True)

    # Price metrics
    open_price = Column(Numeric(20, 6), nullable=True)
    close_price = Column(Numeric(20, 6), nullable=True)
    high_price = Column(Numeric(20, 6), nullable=True)
    low_price = Column(Numeric(20, 6), nullable=True)

    created_at = Column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False
    )

    __table_args__ = (
        UniqueConstraint("date", "dex", name="uq_metrics_daily_date_dex"),
        Index("ix_metrics_daily_date_dex", "date", "dex"),
    )


class ControlFlag(Base):
    """
    Global control flags for the bot.

    Single-row table that controls bot behavior (pause, resume, safe mode).
    """
    __tablename__ = "control_flags"

    id = Column(Integer, primary_key=True, default=1)
    bot_status = Column(
        String(20),
        nullable=False,
        default=BotStatus.RUNNING.value
    )
    updated_at = Column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False
    )

    # Additional flags
    safe_mode = Column(Boolean, default=False)
    emergency_stop = Column(Boolean, default=False)
    dry_run = Column(Boolean, default=True)  # DRY_RUN mode flag (overrides env var)

    # Network selection (overrides env var)
    network = Column(String(20), nullable=True)  # mainnet-beta, devnet, testnet

    # Last bot heartbeat
    last_heartbeat = Column(DateTime(timezone=True), nullable=True)

    # Reason for current status
    status_reason = Column(Text, nullable=True)

    # Simulation balances (for DRY_RUN mode)
    sim_sol_balance = Column(Numeric(20, 9), default=10)
    sim_usdc_balance = Column(Numeric(20, 6), default=1000)
    sim_started_at = Column(DateTime(timezone=True), nullable=True)


class WalletSession(Base):
    """
    Wallet session for UI wallet switching.

    Allows users to connect multiple wallets and switch between them.
    """
    __tablename__ = "wallet_sessions"

    id = Column(Integer, primary_key=True)
    session_id = Column(String(64), nullable=False, unique=True)
    wallet_pubkey = Column(String(50), nullable=False, index=True)
    wallet_name = Column(String(100), nullable=True)
    is_view_only = Column(Boolean, default=False, nullable=False)
    encrypted_private_key = Column(Text, nullable=True)  # NULL for view-only
    created_at = Column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False
    )
    last_accessed = Column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False
    )


class WalletSnapshot(Base):
    """
    Wallet balance snapshot for portfolio tracking.

    Stores periodic snapshots of wallet balances and portfolio value.
    """
    __tablename__ = "wallet_snapshots"

    id = Column(Integer, primary_key=True, index=True)
    wallet_pubkey = Column(String(50), nullable=False)
    ts = Column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
        index=True
    )

    # Balances
    sol_balance = Column(Numeric(20, 9), nullable=False)
    usdc_balance = Column(Numeric(20, 6), nullable=False)

    # Price and value
    sol_price_usd = Column(Numeric(20, 6), nullable=True)
    position_value_usd = Column(Numeric(20, 6), default=0)
    total_value_usd = Column(Numeric(20, 6), nullable=False)

    # Simulation flag
    is_simulated = Column(Boolean, default=False, nullable=False)

    # Additional data
    extra_data = Column(JSONB, nullable=True)

    __table_args__ = (
        Index("ix_wallet_snapshots_wallet_ts", "wallet_pubkey", "ts"),
    )


class HistoricalPoolData(Base):
    """
    Cached historical pool data from Dune Analytics.

    Stores daily volume, fees, and calculated APR to avoid repeated API calls.
    Data is fetched once and cached for backtesting use.
    """
    __tablename__ = "historical_pool_data"

    id = Column(Integer, primary_key=True, index=True)
    created_at = Column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False
    )

    # Pool identification
    pool_address = Column(String(100), nullable=False, index=True)
    data_source = Column(String(50), nullable=False, default="dune")  # dune, cambrian, etc.

    # Date for this data point
    date = Column(Date, nullable=False, index=True)

    # Volume and activity metrics
    volume_usd = Column(Numeric(20, 6), nullable=False, default=0)
    num_swaps = Column(Integer, nullable=False, default=0)

    # Fee metrics
    fees_usd = Column(Numeric(20, 6), nullable=False, default=0)
    fee_rate_bps = Column(Integer, nullable=True)  # Pool fee rate in basis points

    # TVL if available
    tvl_usd = Column(Numeric(20, 6), nullable=True)

    # Calculated APR (fees / TVL * 365 * 100)
    fee_apr = Column(Numeric(10, 4), nullable=True)

    # Price data if available
    avg_price = Column(Numeric(20, 6), nullable=True)
    high_price = Column(Numeric(20, 6), nullable=True)
    low_price = Column(Numeric(20, 6), nullable=True)

    # Raw data from source (for debugging)
    raw_data = Column(JSONB, nullable=True)

    __table_args__ = (
        UniqueConstraint("pool_address", "date", "data_source", name="uq_historical_pool_data"),
        Index("ix_historical_pool_data_pool_date", "pool_address", "date"),
    )


class HistoricalDataFetchLog(Base):
    """
    Log of historical data fetch operations.

    Tracks when data was fetched, from what source, and status.
    """
    __tablename__ = "historical_data_fetch_log"

    id = Column(Integer, primary_key=True, index=True)
    created_at = Column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False
    )

    # Fetch details
    data_source = Column(String(50), nullable=False)  # dune, cambrian, etc.
    pool_address = Column(String(100), nullable=False)

    # Date range fetched
    start_date = Column(Date, nullable=False)
    end_date = Column(Date, nullable=False)

    # Results
    status = Column(String(20), nullable=False)  # success, failed, partial
    rows_fetched = Column(Integer, nullable=False, default=0)
    error_message = Column(Text, nullable=True)

    # Credits used (for Dune)
    credits_used = Column(Integer, nullable=True)

    __table_args__ = (
        Index("ix_fetch_log_source_pool", "data_source", "pool_address"),
    )
