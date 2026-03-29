"""Database module for SOL/USDC Liquidity Manager."""

from .base import Base
from .session import get_db, get_async_db, engine, async_engine
from .models import (
    # Enums
    BotStatus,
    RebalanceStatus,
    SessionStatus,
    # Original models
    StrategyConfig,
    Position,
    Rebalance,
    DailyMetric,
    ControlFlag,
    WalletSession,
    WalletSnapshot,
    HistoricalPoolData,
    HistoricalDataFetchLog,
    # Multi-user models
    User,
    UserHotWallet,
    UserStrategyConfig,
    UserStrategySession,
    UserMetricSnapshot,
    UserPosition,
    UserRebalance,
    UserDailyStats,
    AuthNonce,
    AuditLog,
)

__all__ = [
    # Base and sessions
    "Base",
    "get_db",
    "get_async_db",
    "engine",
    "async_engine",
    # Enums
    "BotStatus",
    "RebalanceStatus",
    "SessionStatus",
    # Original models
    "StrategyConfig",
    "Position",
    "Rebalance",
    "DailyMetric",
    "ControlFlag",
    "WalletSession",
    "WalletSnapshot",
    "HistoricalPoolData",
    "HistoricalDataFetchLog",
    # Multi-user models
    "User",
    "UserHotWallet",
    "UserStrategyConfig",
    "UserStrategySession",
    "UserMetricSnapshot",
    "UserPosition",
    "UserRebalance",
    "UserDailyStats",
    "AuthNonce",
    "AuditLog",
]
