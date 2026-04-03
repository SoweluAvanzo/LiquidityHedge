"""
Database repositories for CRUD operations.

Provides a clean abstraction layer between the database models
and the application logic.
"""

from datetime import datetime, date, timedelta
from decimal import Decimal
from typing import Optional, List, Dict, Any

from sqlalchemy import select, update, desc, and_, func
from sqlalchemy.orm import Session
from sqlalchemy.ext.asyncio import AsyncSession

from .models import (
    StrategyConfig,
    Position,
    Rebalance,
    DailyMetric,
    ControlFlag,
    BotStatus,
    RebalanceStatus,
    WalletSession,
    WalletSnapshot,
    HistoricalPoolData,
    HistoricalDataFetchLog,
)


# =============================================================================
# Strategy Config Repository
# =============================================================================

class StrategyConfigRepository:
    """Repository for strategy configuration."""

    def __init__(self, db: Session):
        self.db = db

    def get_all(self) -> List[StrategyConfig]:
        """Get all strategy config parameters."""
        return self.db.query(StrategyConfig).all()

    def get_by_name(self, name: str) -> Optional[StrategyConfig]:
        """Get a config parameter by name."""
        return self.db.query(StrategyConfig).filter(
            StrategyConfig.name == name
        ).first()

    def get_value(self, name: str, default: Any = None) -> Any:
        """Get a typed config value by name."""
        config = self.get_by_name(name)
        if config is None:
            return default
        return config.get_typed_value()

    def set_value(
        self,
        name: str,
        value: Any,
        value_type: str = "str",
        description: Optional[str] = None,
        updated_by: Optional[str] = None,
    ) -> StrategyConfig:
        """Set or update a config parameter."""
        config = self.get_by_name(name)

        if config is None:
            config = StrategyConfig(
                name=name,
                value=str(value),
                value_type=value_type,
                description=description,
                updated_by=updated_by,
            )
            self.db.add(config)
        else:
            config.value = str(value)
            config.value_type = value_type
            if description:
                config.description = description
            config.updated_by = updated_by

        self.db.commit()
        self.db.refresh(config)
        return config

    def get_as_dict(self) -> Dict[str, Any]:
        """Get all config parameters as a dictionary."""
        configs = self.get_all()
        return {c.name: c.get_typed_value() for c in configs}


# =============================================================================
# Position Repository
# =============================================================================

class PositionRepository:
    """Repository for CLMM positions."""

    def __init__(self, db: Session):
        self.db = db

    def get_active_positions(self, dex: Optional[str] = None) -> List[Position]:
        """Get all active positions, optionally filtered by DEX."""
        query = self.db.query(Position).filter(Position.is_active == True)
        if dex:
            query = query.filter(Position.dex == dex)
        return query.all()

    def get_by_pubkey(self, position_pubkey: str) -> Optional[Position]:
        """Get position by its public key."""
        return self.db.query(Position).filter(
            Position.position_pubkey == position_pubkey
        ).first()

    def create(
        self,
        dex: str,
        pool_id: str,
        position_pubkey: str,
        lower_tick: int,
        upper_tick: int,
        liquidity: int,
        amount_sol: Decimal = Decimal(0),
        amount_usdc: Decimal = Decimal(0),
    ) -> Position:
        """Create a new position record."""
        position = Position(
            dex=dex,
            pool_id=pool_id,
            position_pubkey=position_pubkey,
            lower_tick=lower_tick,
            upper_tick=upper_tick,
            liquidity=liquidity,
            amount_sol=amount_sol,
            amount_usdc=amount_usdc,
            is_active=True,
        )
        self.db.add(position)
        self.db.commit()
        self.db.refresh(position)
        return position

    def close_position(self, position_pubkey: str) -> Optional[Position]:
        """Mark a position as closed."""
        position = self.get_by_pubkey(position_pubkey)
        if position:
            position.is_active = False
            position.closed_at = datetime.utcnow()
            self.db.commit()
            self.db.refresh(position)
        return position

    def update_position(
        self,
        position_pubkey: str,
        liquidity: Optional[int] = None,
        amount_sol: Optional[Decimal] = None,
        amount_usdc: Optional[Decimal] = None,
    ) -> Optional[Position]:
        """Update position amounts."""
        position = self.get_by_pubkey(position_pubkey)
        if position:
            if liquidity is not None:
                position.liquidity = liquidity
            if amount_sol is not None:
                position.amount_sol = amount_sol
            if amount_usdc is not None:
                position.amount_usdc = amount_usdc
            self.db.commit()
            self.db.refresh(position)
        return position

    def get_all(self) -> List[Position]:
        """Get all positions."""
        return self.db.query(Position).order_by(desc(Position.id)).all()

    def update(
        self,
        position_id: int,
        liquidity: Optional[int] = None,
        amount_sol: Optional[Decimal] = None,
        amount_usdc: Optional[Decimal] = None,
    ) -> Optional[Position]:
        """Update position by ID."""
        position = self.db.query(Position).filter(Position.id == position_id).first()
        if position:
            if liquidity is not None:
                position.liquidity = liquidity
            if amount_sol is not None:
                position.amount_sol = amount_sol
            if amount_usdc is not None:
                position.amount_usdc = amount_usdc
            self.db.commit()
            self.db.refresh(position)
        return position


# =============================================================================
# Rebalance Repository
# =============================================================================

class RebalanceRepository:
    """Repository for rebalance events."""

    def __init__(self, db: Session):
        self.db = db

    def get_recent(self, limit: int = 10) -> List[Rebalance]:
        """Get the most recent rebalances."""
        return self.db.query(Rebalance).order_by(
            desc(Rebalance.ts)
        ).limit(limit).all()

    def get_last(self, dex: Optional[str] = None) -> Optional[Rebalance]:
        """Get the most recent rebalance."""
        query = self.db.query(Rebalance).order_by(desc(Rebalance.ts))
        if dex:
            query = query.filter(Rebalance.dex == dex)
        return query.first()

    def get_by_time_range(
        self,
        start: datetime,
        end: datetime,
        dex: Optional[str] = None,
    ) -> List[Rebalance]:
        """Get rebalances within a time range."""
        query = self.db.query(Rebalance).filter(
            and_(Rebalance.ts >= start, Rebalance.ts <= end)
        )
        if dex:
            query = query.filter(Rebalance.dex == dex)
        return query.order_by(Rebalance.ts).all()

    def get_since(
        self,
        since: datetime,
        dex: Optional[str] = None,
    ) -> List[Rebalance]:
        """Get all rebalances since a given datetime."""
        query = self.db.query(Rebalance).filter(Rebalance.ts >= since)
        if dex:
            query = query.filter(Rebalance.dex == dex)
        return query.order_by(desc(Rebalance.ts)).all()

    def count_in_last_hour(self, dex: Optional[str] = None) -> int:
        """Count rebalances in the last hour."""
        one_hour_ago = datetime.utcnow() - timedelta(hours=1)
        query = self.db.query(func.count(Rebalance.id)).filter(
            Rebalance.ts >= one_hour_ago
        )
        if dex:
            query = query.filter(Rebalance.dex == dex)
        return query.scalar() or 0

    def create(
        self,
        dex: str,
        pool_id: str,
        new_lower_tick: int,
        new_upper_tick: int,
        old_lower_tick: Optional[int] = None,
        old_upper_tick: Optional[int] = None,
        fees_sol: Decimal = Decimal(0),
        fees_usdc: Decimal = Decimal(0),
        pnl_usd: Optional[Decimal] = None,
        tx_sig_remove: Optional[str] = None,
        tx_sig_add: Optional[str] = None,
        tx_sig_swap: Optional[str] = None,
        status: str = RebalanceStatus.SUCCESS.value,
        error_message: Optional[str] = None,
        raw_info: Optional[Dict] = None,
        price_at_rebalance: Optional[Decimal] = None,
        position_id: Optional[int] = None,
    ) -> Rebalance:
        """Create a new rebalance record."""
        rebalance = Rebalance(
            dex=dex,
            pool_id=pool_id,
            old_lower_tick=old_lower_tick,
            old_upper_tick=old_upper_tick,
            new_lower_tick=new_lower_tick,
            new_upper_tick=new_upper_tick,
            fees_sol=fees_sol,
            fees_usdc=fees_usdc,
            pnl_usd=pnl_usd,
            tx_sig_remove=tx_sig_remove,
            tx_sig_add=tx_sig_add,
            tx_sig_swap=tx_sig_swap,
            status=status,
            error_message=error_message,
            raw_info=raw_info,
            price_at_rebalance=price_at_rebalance,
            position_id=position_id,
        )
        self.db.add(rebalance)
        self.db.commit()
        self.db.refresh(rebalance)
        return rebalance


# =============================================================================
# Daily Metric Repository
# =============================================================================

class DailyMetricRepository:
    """Repository for daily metrics."""

    def __init__(self, db: Session):
        self.db = db

    def get_recent(self, days: int = 30, dex: Optional[str] = None) -> List[DailyMetric]:
        """Get the most recent daily metrics."""
        start_date = date.today() - timedelta(days=days)
        return self.get_range(start_date, date.today(), dex)

    def get_by_date(
        self,
        metric_date: date,
        dex: Optional[str] = None,
    ) -> Optional[DailyMetric]:
        """Get metrics for a specific date."""
        query = self.db.query(DailyMetric).filter(DailyMetric.date == metric_date)
        if dex:
            query = query.filter(DailyMetric.dex == dex)
        return query.first()

    def get_range(
        self,
        start_date: date,
        end_date: date,
        dex: Optional[str] = None,
    ) -> List[DailyMetric]:
        """Get metrics for a date range."""
        query = self.db.query(DailyMetric).filter(
            and_(DailyMetric.date >= start_date, DailyMetric.date <= end_date)
        )
        if dex:
            query = query.filter(DailyMetric.dex == dex)
        return query.order_by(DailyMetric.date).all()

    def get_summary(
        self,
        days: int = 30,
        dex: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Get summary metrics for the last N days."""
        start_date = date.today() - timedelta(days=days)
        metrics = self.get_range(start_date, date.today(), dex)

        if not metrics:
            return {
                "total_fees_usd": Decimal(0),
                "total_il_usd": Decimal(0),
                "total_pnl_usd": Decimal(0),
                "total_rebalances": 0,
                "days": 0,
            }

        return {
            "total_fees_usd": sum(m.fees_usd for m in metrics),
            "total_il_usd": sum(m.il_estimate_usd for m in metrics),
            "total_pnl_usd": sum(m.pnl_usd for m in metrics),
            "total_rebalances": sum(m.num_rebalances for m in metrics),
            "days": len(metrics),
        }

    def upsert(
        self,
        metric_date: date,
        dex: Optional[str] = None,
        **kwargs,
    ) -> DailyMetric:
        """Insert or update daily metrics."""
        metric = self.get_by_date(metric_date, dex)

        if metric is None:
            metric = DailyMetric(date=metric_date, dex=dex, **kwargs)
            self.db.add(metric)
        else:
            for key, value in kwargs.items():
                if hasattr(metric, key) and value is not None:
                    setattr(metric, key, value)

        self.db.commit()
        self.db.refresh(metric)
        return metric


# =============================================================================
# Control Flag Repository
# =============================================================================

class ControlFlagRepository:
    """Repository for bot control flags."""

    def __init__(self, db: Session):
        self.db = db

    def get(self) -> Optional[ControlFlag]:
        """Get the control flags (single row)."""
        return self.db.query(ControlFlag).filter(ControlFlag.id == 1).first()

    def get_or_create(self) -> ControlFlag:
        """Get control flags, creating default if not exists."""
        flags = self.get()
        if flags is None:
            flags = ControlFlag(
                id=1,
                bot_status=BotStatus.RUNNING.value,
            )
            self.db.add(flags)
            self.db.commit()
            self.db.refresh(flags)
        return flags

    def get_bot_status(self) -> BotStatus:
        """Get current bot status."""
        flags = self.get_or_create()
        return BotStatus(flags.bot_status)

    def is_paused(self) -> bool:
        """Check if bot is paused."""
        flags = self.get_or_create()
        return flags.bot_status == BotStatus.PAUSED.value

    def is_safe_mode(self) -> bool:
        """Check if bot is in safe mode."""
        flags = self.get_or_create()
        return flags.safe_mode or flags.bot_status == BotStatus.SAFE_MODE.value

    def set_status(
        self,
        status: BotStatus,
        reason: Optional[str] = None,
    ) -> ControlFlag:
        """Set bot status."""
        flags = self.get_or_create()
        flags.bot_status = status.value
        flags.status_reason = reason
        self.db.commit()
        self.db.refresh(flags)
        return flags

    def pause(self, reason: Optional[str] = None) -> ControlFlag:
        """Pause the bot."""
        return self.set_status(BotStatus.PAUSED, reason)

    def resume(self) -> ControlFlag:
        """Resume the bot."""
        return self.set_status(BotStatus.RUNNING, None)

    def set_safe_mode(self, enabled: bool, reason: Optional[str] = None) -> ControlFlag:
        """Enable or disable safe mode."""
        flags = self.get_or_create()
        flags.safe_mode = enabled
        if enabled:
            flags.bot_status = BotStatus.SAFE_MODE.value
            flags.status_reason = reason
        elif flags.bot_status == BotStatus.SAFE_MODE.value:
            flags.bot_status = BotStatus.RUNNING.value
            flags.status_reason = None
        self.db.commit()
        self.db.refresh(flags)
        return flags

    def update_heartbeat(self) -> ControlFlag:
        """Update bot heartbeat timestamp."""
        flags = self.get_or_create()
        flags.last_heartbeat = datetime.utcnow()
        self.db.commit()
        self.db.refresh(flags)
        return flags

    def set_emergency_stop(self, enabled: bool, reason: Optional[str] = None) -> ControlFlag:
        """Enable or disable emergency stop."""
        flags = self.get_or_create()
        flags.emergency_stop = enabled
        if enabled:
            flags.bot_status = BotStatus.PAUSED.value
            flags.status_reason = reason or "Emergency stop activated"
        self.db.commit()
        self.db.refresh(flags)
        return flags

    def get_sim_balances(self) -> tuple[Decimal, Decimal]:
        """Get simulated balances for DRY_RUN mode."""
        flags = self.get_or_create()
        return (
            flags.sim_sol_balance or Decimal(10),
            flags.sim_usdc_balance or Decimal(1000),
        )

    def update_sim_balances(
        self,
        sol_balance: Decimal,
        usdc_balance: Decimal,
    ) -> ControlFlag:
        """Update simulated balances."""
        flags = self.get_or_create()
        flags.sim_sol_balance = sol_balance
        flags.sim_usdc_balance = usdc_balance
        if flags.sim_started_at is None:
            flags.sim_started_at = datetime.utcnow()
        self.db.commit()
        self.db.refresh(flags)
        return flags

    def reset_simulation(
        self,
        initial_sol: Decimal = Decimal(10),
        initial_usdc: Decimal = Decimal(1000),
    ) -> ControlFlag:
        """Reset simulation to initial balances."""
        flags = self.get_or_create()
        flags.sim_sol_balance = initial_sol
        flags.sim_usdc_balance = initial_usdc
        flags.sim_started_at = datetime.utcnow()
        self.db.commit()
        self.db.refresh(flags)
        return flags

    def is_dry_run(self) -> bool:
        """Check if bot is in DRY_RUN mode."""
        flags = self.get_or_create()
        # Default to True if column doesn't exist yet (migration pending)
        return getattr(flags, 'dry_run', True)

    def set_dry_run(self, enabled: bool, reason: Optional[str] = None) -> ControlFlag:
        """Enable or disable DRY_RUN mode."""
        flags = self.get_or_create()
        flags.dry_run = enabled
        flags.status_reason = reason
        self.db.commit()
        self.db.refresh(flags)
        return flags

    def get_network(self) -> Optional[str]:
        """Get the current network setting."""
        flags = self.get_or_create()
        return getattr(flags, 'network', None)

    def set_network(self, network: str, reason: Optional[str] = None) -> ControlFlag:
        """Set the Solana network (mainnet-beta, devnet, testnet)."""
        valid_networks = {"mainnet-beta", "devnet", "testnet"}
        if network not in valid_networks:
            raise ValueError(f"Invalid network: {network}. Must be one of {valid_networks}")

        flags = self.get_or_create()
        flags.network = network
        flags.status_reason = reason
        self.db.commit()
        self.db.refresh(flags)
        return flags


# =============================================================================
# Wallet Session Repository
# =============================================================================

class WalletSessionRepository:
    """Repository for wallet sessions."""

    def __init__(self, db: Session):
        self.db = db

    def get_by_session_id(self, session_id: str) -> Optional[WalletSession]:
        """Get wallet session by session ID."""
        return self.db.query(WalletSession).filter(
            WalletSession.session_id == session_id
        ).first()

    def get_all(self) -> List[WalletSession]:
        """Get all wallet sessions."""
        return self.db.query(WalletSession).order_by(
            desc(WalletSession.last_accessed)
        ).all()

    def create(
        self,
        session_id: str,
        wallet_pubkey: str,
        wallet_name: Optional[str] = None,
        is_view_only: bool = False,
        encrypted_private_key: Optional[str] = None,
    ) -> WalletSession:
        """Create a new wallet session."""
        session = WalletSession(
            session_id=session_id,
            wallet_pubkey=wallet_pubkey,
            wallet_name=wallet_name,
            is_view_only=is_view_only,
            encrypted_private_key=encrypted_private_key,
        )
        self.db.add(session)
        self.db.commit()
        self.db.refresh(session)
        return session

    def delete(self, session_id: str) -> bool:
        """Delete a wallet session."""
        session = self.get_by_session_id(session_id)
        if session:
            self.db.delete(session)
            self.db.commit()
            return True
        return False

    def update_last_accessed(self, session_id: str) -> Optional[WalletSession]:
        """Update last accessed timestamp."""
        session = self.get_by_session_id(session_id)
        if session:
            session.last_accessed = datetime.utcnow()
            self.db.commit()
            self.db.refresh(session)
        return session


# =============================================================================
# Wallet Snapshot Repository
# =============================================================================

class WalletSnapshotRepository:
    """Repository for wallet balance snapshots."""

    def __init__(self, db: Session):
        self.db = db

    def get_latest(
        self,
        wallet_pubkey: str,
        is_simulated: Optional[bool] = None,
    ) -> Optional[WalletSnapshot]:
        """Get the latest snapshot for a wallet."""
        query = self.db.query(WalletSnapshot).filter(
            WalletSnapshot.wallet_pubkey == wallet_pubkey
        )
        if is_simulated is not None:
            query = query.filter(WalletSnapshot.is_simulated == is_simulated)
        return query.order_by(desc(WalletSnapshot.ts)).first()

    def get_history(
        self,
        wallet_pubkey: str,
        days: int = 30,
        is_simulated: Optional[bool] = None,
    ) -> List[WalletSnapshot]:
        """Get snapshot history for a wallet."""
        start_time = datetime.utcnow() - timedelta(days=days)
        query = self.db.query(WalletSnapshot).filter(
            and_(
                WalletSnapshot.wallet_pubkey == wallet_pubkey,
                WalletSnapshot.ts >= start_time,
            )
        )
        if is_simulated is not None:
            query = query.filter(WalletSnapshot.is_simulated == is_simulated)
        return query.order_by(WalletSnapshot.ts).all()

    def create(
        self,
        wallet_pubkey: str,
        sol_balance: Decimal,
        usdc_balance: Decimal,
        total_value_usd: Decimal,
        sol_price_usd: Optional[Decimal] = None,
        position_value_usd: Optional[Decimal] = None,
        is_simulated: bool = False,
        metadata: Optional[Dict] = None,
    ) -> WalletSnapshot:
        """Create a new wallet snapshot."""
        snapshot = WalletSnapshot(
            wallet_pubkey=wallet_pubkey,
            sol_balance=sol_balance,
            usdc_balance=usdc_balance,
            sol_price_usd=sol_price_usd,
            position_value_usd=position_value_usd or Decimal(0),
            total_value_usd=total_value_usd,
            is_simulated=is_simulated,
            metadata=metadata,
        )
        self.db.add(snapshot)
        self.db.commit()
        self.db.refresh(snapshot)
        return snapshot

    def get_value_series(
        self,
        wallet_pubkey: str,
        days: int = 30,
        is_simulated: Optional[bool] = None,
    ) -> List[Dict[str, Any]]:
        """Get portfolio value time series for charting."""
        snapshots = self.get_history(wallet_pubkey, days, is_simulated)
        return [
            {
                "ts": s.ts.isoformat(),
                "total_value_usd": float(s.total_value_usd),
                "sol_balance": float(s.sol_balance),
                "usdc_balance": float(s.usdc_balance),
                "sol_price_usd": float(s.sol_price_usd) if s.sol_price_usd else None,
            }
            for s in snapshots
        ]


# =============================================================================
# Historical Pool Data Repository
# =============================================================================

class HistoricalPoolDataRepository:
    """Repository for cached historical pool data from Dune/Cambrian."""

    # Default SOL/USDC Whirlpool address
    DEFAULT_POOL = "HJPjoWUrhoZzkNfRpHuieeFk9WcZWjwy6PBjZ81ngndJ"

    def __init__(self, db: Session):
        self.db = db

    def get_by_date_range(
        self,
        start_date: date,
        end_date: date,
        pool_address: str = DEFAULT_POOL,
        data_source: Optional[str] = None,
    ) -> List[HistoricalPoolData]:
        """Get historical data for a date range."""
        query = self.db.query(HistoricalPoolData).filter(
            and_(
                HistoricalPoolData.pool_address == pool_address,
                HistoricalPoolData.date >= start_date,
                HistoricalPoolData.date <= end_date,
            )
        )
        if data_source:
            query = query.filter(HistoricalPoolData.data_source == data_source)
        return query.order_by(HistoricalPoolData.date).all()

    def get_apr_dict(
        self,
        start_date: date,
        end_date: date,
        pool_address: str = DEFAULT_POOL,
    ) -> Dict[str, float]:
        """Get APR values as a dictionary keyed by date string."""
        data = self.get_by_date_range(start_date, end_date, pool_address)
        return {
            d.date.strftime("%Y-%m-%d"): float(d.fee_apr or 0)
            for d in data
        }

    def get_data_coverage(
        self,
        pool_address: str = DEFAULT_POOL,
    ) -> Dict[str, Any]:
        """Get information about what data is cached."""
        query = self.db.query(
            func.min(HistoricalPoolData.date).label("min_date"),
            func.max(HistoricalPoolData.date).label("max_date"),
            func.count(HistoricalPoolData.id).label("total_rows"),
        ).filter(HistoricalPoolData.pool_address == pool_address)

        result = query.first()
        if result and result.total_rows > 0:
            return {
                "has_data": True,
                "min_date": result.min_date.isoformat() if result.min_date else None,
                "max_date": result.max_date.isoformat() if result.max_date else None,
                "total_days": result.total_rows,
            }
        return {
            "has_data": False,
            "min_date": None,
            "max_date": None,
            "total_days": 0,
        }

    def has_data_for_range(
        self,
        start_date: date,
        end_date: date,
        pool_address: str = DEFAULT_POOL,
        min_coverage_pct: float = 0.8,
    ) -> bool:
        """Check if we have sufficient data for a date range."""
        total_days = (end_date - start_date).days + 1
        data = self.get_by_date_range(start_date, end_date, pool_address)
        coverage = len(data) / total_days if total_days > 0 else 0
        return coverage >= min_coverage_pct

    def upsert(
        self,
        pool_address: str,
        date_val: date,
        data_source: str,
        volume_usd: float = 0,
        num_swaps: int = 0,
        fees_usd: float = 0,
        tvl_usd: Optional[float] = None,
        fee_apr: Optional[float] = None,
        fee_rate_bps: Optional[int] = None,
        avg_price: Optional[float] = None,
        high_price: Optional[float] = None,
        low_price: Optional[float] = None,
        raw_data: Optional[Dict] = None,
    ) -> HistoricalPoolData:
        """Insert or update historical pool data."""
        existing = self.db.query(HistoricalPoolData).filter(
            and_(
                HistoricalPoolData.pool_address == pool_address,
                HistoricalPoolData.date == date_val,
                HistoricalPoolData.data_source == data_source,
            )
        ).first()

        if existing:
            existing.volume_usd = volume_usd
            existing.num_swaps = num_swaps
            existing.fees_usd = fees_usd
            existing.tvl_usd = tvl_usd
            existing.fee_apr = fee_apr
            existing.fee_rate_bps = fee_rate_bps
            existing.avg_price = avg_price
            existing.high_price = high_price
            existing.low_price = low_price
            existing.raw_data = raw_data
            self.db.commit()
            self.db.refresh(existing)
            return existing
        else:
            record = HistoricalPoolData(
                pool_address=pool_address,
                date=date_val,
                data_source=data_source,
                volume_usd=volume_usd,
                num_swaps=num_swaps,
                fees_usd=fees_usd,
                tvl_usd=tvl_usd,
                fee_apr=fee_apr,
                fee_rate_bps=fee_rate_bps,
                avg_price=avg_price,
                high_price=high_price,
                low_price=low_price,
                raw_data=raw_data,
            )
            self.db.add(record)
            self.db.commit()
            self.db.refresh(record)
            return record

    def bulk_insert(
        self,
        records: List[Dict[str, Any]],
    ) -> int:
        """Bulk insert historical pool data records."""
        count = 0
        for record in records:
            self.upsert(**record)
            count += 1
        return count

    def log_fetch(
        self,
        data_source: str,
        pool_address: str,
        start_date: date,
        end_date: date,
        status: str,
        rows_fetched: int = 0,
        error_message: Optional[str] = None,
        credits_used: Optional[int] = None,
    ) -> HistoricalDataFetchLog:
        """Log a data fetch operation."""
        log = HistoricalDataFetchLog(
            data_source=data_source,
            pool_address=pool_address,
            start_date=start_date,
            end_date=end_date,
            status=status,
            rows_fetched=rows_fetched,
            error_message=error_message,
            credits_used=credits_used,
        )
        self.db.add(log)
        self.db.commit()
        self.db.refresh(log)
        return log

    def get_last_fetch(
        self,
        pool_address: str = DEFAULT_POOL,
        data_source: Optional[str] = None,
    ) -> Optional[HistoricalDataFetchLog]:
        """Get the most recent fetch log."""
        query = self.db.query(HistoricalDataFetchLog).filter(
            HistoricalDataFetchLog.pool_address == pool_address
        )
        if data_source:
            query = query.filter(HistoricalDataFetchLog.data_source == data_source)
        return query.order_by(desc(HistoricalDataFetchLog.created_at)).first()
