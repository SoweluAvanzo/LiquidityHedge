"""
Portfolio API endpoints.

Provides endpoints for viewing portfolio data:
- Summary/overview
- Active positions
- Historical positions
- Performance metrics
- CSV export
"""

import logging
from datetime import datetime, timezone, date, timedelta
from typing import List, Optional
from decimal import Decimal
from io import StringIO
import csv

from fastapi import APIRouter, HTTPException, Depends
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, and_

from api.auth import get_current_user, UserInfo
from api.dependencies import get_db

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/portfolio", tags=["portfolio"])


# =============================================================================
# REQUEST/RESPONSE MODELS
# =============================================================================

class PortfolioSummary(BaseModel):
    """Portfolio overview/summary."""
    # Balances
    total_value_usd: Decimal = Field(..., description="Total portfolio value in USD")
    sol_balance: Decimal = Field(..., description="SOL balance")
    usdc_balance: Decimal = Field(..., description="USDC balance")
    position_value_usd: Decimal = Field(..., description="Value locked in positions")

    # Performance (session to date)
    session_pnl_usd: Optional[Decimal] = Field(None, description="Session PnL in USD")
    session_pnl_pct: Optional[float] = Field(None, description="Session PnL percentage")
    fees_earned_usd: Decimal = Field(..., description="Total fees earned")
    il_usd: Decimal = Field(..., description="Estimated impermanent loss")
    tx_costs_usd: Decimal = Field(..., description="Transaction costs paid")

    # Current market
    sol_price_usd: Optional[Decimal] = Field(None, description="Current SOL price")

    # Position status
    has_active_position: bool
    position_in_range: Optional[bool] = None
    current_range_pct: Optional[float] = Field(
        None, description="Current position in range (0-100%)"
    )

    # Session info
    active_session_id: Optional[int] = None
    session_uptime_seconds: Optional[int] = None


class PositionResponse(BaseModel):
    """Position information."""
    id: int
    position_pubkey: str
    pool_id: str

    # Range
    lower_price: Decimal
    upper_price: Decimal
    lower_tick: int
    upper_tick: int
    liquidity: Decimal

    # Entry data
    entry_price: Decimal
    entry_sol_amount: Decimal
    entry_usdc_amount: Decimal
    entry_value_usd: Decimal
    opened_at: datetime

    # Current data (if active)
    current_sol_amount: Optional[Decimal] = None
    current_usdc_amount: Optional[Decimal] = None
    current_price: Optional[Decimal] = None
    current_value_usd: Optional[Decimal] = None
    in_range: Optional[bool] = None
    range_position_pct: Optional[float] = Field(
        None, description="Where price is in range (0-100%)"
    )

    # Fees collected
    fees_sol_collected: Decimal
    fees_usdc_collected: Decimal

    # Exit data (if closed)
    exit_price: Optional[Decimal] = None
    exit_value_usd: Optional[Decimal] = None
    exit_reason: Optional[str] = None
    closed_at: Optional[datetime] = None

    # PnL
    realized_pnl_usd: Optional[Decimal] = None
    il_usd: Optional[Decimal] = None

    # Status
    is_active: bool

    # Transaction links
    open_tx_sig: Optional[str] = None
    close_tx_sig: Optional[str] = None


class PositionListResponse(BaseModel):
    """List of positions."""
    positions: List[PositionResponse]
    total: int


class RebalanceResponse(BaseModel):
    """Rebalance event information."""
    id: int
    timestamp: datetime
    trigger_reason: str

    # Position changes
    old_lower_tick: Optional[int]
    old_upper_tick: Optional[int]
    new_lower_tick: int
    new_upper_tick: int

    # Fees collected
    fees_sol_collected: Decimal
    fees_usdc_collected: Decimal

    # Swap info
    swap_direction: Optional[str]
    swap_amount_in: Optional[Decimal]
    swap_amount_out: Optional[Decimal]
    swap_price: Optional[Decimal]

    # Costs
    tx_fee_sol: Decimal
    priority_fee_sol: Decimal

    # Price
    price_at_rebalance: Decimal

    # Status
    status: str
    error_message: Optional[str]

    # Transaction signatures
    tx_sig_close: Optional[str]
    tx_sig_swap: Optional[str]
    tx_sig_open: Optional[str]


class RebalanceListResponse(BaseModel):
    """List of rebalances."""
    rebalances: List[RebalanceResponse]
    total: int


class MetricSnapshot(BaseModel):
    """Point-in-time metric snapshot for charts."""
    timestamp: datetime
    total_value_usd: Decimal
    sol_balance: Decimal
    usdc_balance: Decimal
    position_value_usd: Decimal
    fees_earned_usd: Decimal
    il_usd: Decimal
    sol_price_usd: Optional[Decimal]
    has_active_position: bool


class MetricsHistoryResponse(BaseModel):
    """Historical metrics for charts."""
    snapshots: List[MetricSnapshot]
    start_date: datetime
    end_date: datetime


class DailyStatsResponse(BaseModel):
    """Daily statistics."""
    date: date
    rebalance_count: int
    emergency_rebalance_count: int
    fees_earned_usd: Decimal
    pnl_usd: Decimal
    tx_costs_usd: Decimal
    positions_opened: int
    positions_closed: int


class DailyStatsListResponse(BaseModel):
    """List of daily stats."""
    stats: List[DailyStatsResponse]
    total: int


# =============================================================================
# API ENDPOINTS
# =============================================================================

@router.get("/summary", response_model=PortfolioSummary)
async def get_portfolio_summary(
    user: UserInfo = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Get portfolio summary/overview.

    Returns current balances, performance metrics, and position status.
    """
    from app.db.models import (
        UserStrategySession,
        UserPosition,
        UserMetricSnapshot,
    )

    # Get active session
    result = await db.execute(
        select(UserStrategySession).where(
            UserStrategySession.user_id == user.user_id,
            UserStrategySession.status.in_(["running", "paused"])
        ).order_by(UserStrategySession.created_at.desc()).limit(1)
    )
    session = result.scalar_one_or_none()

    # Get latest metric snapshot
    result = await db.execute(
        select(UserMetricSnapshot)
        .where(UserMetricSnapshot.user_id == user.user_id)
        .order_by(UserMetricSnapshot.timestamp.desc())
        .limit(1)
    )
    snapshot = result.scalar_one_or_none()

    # Get active position
    result = await db.execute(
        select(UserPosition).where(
            UserPosition.user_id == user.user_id,
            UserPosition.is_active == True
        )
    )
    position = result.scalar_one_or_none()

    # Calculate values from snapshot or defaults
    if snapshot:
        total_value = snapshot.total_value_usd
        sol_balance = snapshot.sol_balance
        usdc_balance = snapshot.usdc_balance
        position_value = snapshot.position_value_usd
        fees_earned = snapshot.fees_earned_usd
        il = snapshot.il_usd
        tx_costs = snapshot.tx_costs_usd
        sol_price = snapshot.sol_price_usd
        has_position = snapshot.has_active_position
        in_range = snapshot.position_in_range
    else:
        # No data yet
        total_value = Decimal("0")
        sol_balance = Decimal("0")
        usdc_balance = Decimal("0")
        position_value = Decimal("0")
        fees_earned = Decimal("0")
        il = Decimal("0")
        tx_costs = Decimal("0")
        sol_price = None
        has_position = False
        in_range = None

    # Calculate session PnL
    session_pnl_usd = None
    session_pnl_pct = None
    session_uptime = None

    if session:
        if session.initial_value_usd and session.current_value_usd:
            session_pnl_usd = session.current_value_usd - session.initial_value_usd
            if session.initial_value_usd > 0:
                session_pnl_pct = float(session_pnl_usd / session.initial_value_usd * 100)

        if session.started_at:
            session_uptime = int(
                (datetime.now(timezone.utc) - session.started_at).total_seconds()
            )

    # Calculate range position if we have position
    range_pct = None
    if position and position.lower_price and position.upper_price:
        # TODO: Get current price from snapshot or chain
        pass

    return PortfolioSummary(
        total_value_usd=total_value,
        sol_balance=sol_balance,
        usdc_balance=usdc_balance,
        position_value_usd=position_value,
        session_pnl_usd=session_pnl_usd,
        session_pnl_pct=session_pnl_pct,
        fees_earned_usd=fees_earned,
        il_usd=il,
        tx_costs_usd=tx_costs,
        sol_price_usd=sol_price,
        has_active_position=has_position,
        position_in_range=in_range,
        current_range_pct=range_pct,
        active_session_id=session.id if session else None,
        session_uptime_seconds=session_uptime,
    )


@router.get("/positions", response_model=PositionListResponse)
async def list_positions(
    user: UserInfo = Depends(get_current_user),
    active_only: bool = False,
    limit: int = 50,
    offset: int = 0,
    db: AsyncSession = Depends(get_db)
):
    """List user's positions with optional filter for active only."""
    from app.db.models import UserPosition

    query = select(UserPosition).where(UserPosition.user_id == user.user_id)

    if active_only:
        query = query.where(UserPosition.is_active == True)

    query = query.order_by(UserPosition.opened_at.desc())
    query = query.offset(offset).limit(limit)

    result = await db.execute(query)
    positions = result.scalars().all()

    # Get total count
    count_query = select(func.count(UserPosition.id)).where(
        UserPosition.user_id == user.user_id
    )
    if active_only:
        count_query = count_query.where(UserPosition.is_active == True)
    count_result = await db.execute(count_query)
    total = count_result.scalar()

    return PositionListResponse(
        positions=[
            PositionResponse(
                id=p.id,
                position_pubkey=p.position_pubkey,
                pool_id=p.pool_id,
                lower_price=p.lower_price,
                upper_price=p.upper_price,
                lower_tick=p.lower_tick,
                upper_tick=p.upper_tick,
                liquidity=p.liquidity,
                entry_price=p.entry_price,
                entry_sol_amount=p.entry_sol_amount,
                entry_usdc_amount=p.entry_usdc_amount,
                entry_value_usd=p.entry_value_usd,
                opened_at=p.opened_at,
                current_sol_amount=p.current_sol_amount,
                current_usdc_amount=p.current_usdc_amount,
                fees_sol_collected=p.fees_sol_collected,
                fees_usdc_collected=p.fees_usdc_collected,
                exit_price=p.exit_price,
                exit_value_usd=p.exit_value_usd,
                exit_reason=p.exit_reason,
                closed_at=p.closed_at,
                realized_pnl_usd=p.realized_pnl_usd,
                il_usd=p.il_usd,
                is_active=p.is_active,
                open_tx_sig=p.open_tx_sig,
                close_tx_sig=p.close_tx_sig,
            )
            for p in positions
        ],
        total=total,
    )


@router.get("/positions/{position_id}", response_model=PositionResponse)
async def get_position(
    position_id: int,
    user: UserInfo = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Get details of a specific position."""
    from app.db.models import UserPosition

    result = await db.execute(
        select(UserPosition).where(
            UserPosition.id == position_id,
            UserPosition.user_id == user.user_id
        )
    )
    p = result.scalar_one_or_none()

    if not p:
        raise HTTPException(status_code=404, detail="Position not found")

    return PositionResponse(
        id=p.id,
        position_pubkey=p.position_pubkey,
        pool_id=p.pool_id,
        lower_price=p.lower_price,
        upper_price=p.upper_price,
        lower_tick=p.lower_tick,
        upper_tick=p.upper_tick,
        liquidity=p.liquidity,
        entry_price=p.entry_price,
        entry_sol_amount=p.entry_sol_amount,
        entry_usdc_amount=p.entry_usdc_amount,
        entry_value_usd=p.entry_value_usd,
        opened_at=p.opened_at,
        current_sol_amount=p.current_sol_amount,
        current_usdc_amount=p.current_usdc_amount,
        fees_sol_collected=p.fees_sol_collected,
        fees_usdc_collected=p.fees_usdc_collected,
        exit_price=p.exit_price,
        exit_value_usd=p.exit_value_usd,
        exit_reason=p.exit_reason,
        closed_at=p.closed_at,
        realized_pnl_usd=p.realized_pnl_usd,
        il_usd=p.il_usd,
        is_active=p.is_active,
        open_tx_sig=p.open_tx_sig,
        close_tx_sig=p.close_tx_sig,
    )


@router.get("/rebalances", response_model=RebalanceListResponse)
async def list_rebalances(
    user: UserInfo = Depends(get_current_user),
    session_id: Optional[int] = None,
    limit: int = 50,
    offset: int = 0,
    db: AsyncSession = Depends(get_db)
):
    """List user's rebalance events."""
    from app.db.models import UserRebalance

    query = select(UserRebalance).where(UserRebalance.user_id == user.user_id)

    if session_id:
        query = query.where(UserRebalance.session_id == session_id)

    query = query.order_by(UserRebalance.ts.desc())
    query = query.offset(offset).limit(limit)

    result = await db.execute(query)
    rebalances = result.scalars().all()

    # Get total count
    count_query = select(func.count(UserRebalance.id)).where(
        UserRebalance.user_id == user.user_id
    )
    if session_id:
        count_query = count_query.where(UserRebalance.session_id == session_id)
    count_result = await db.execute(count_query)
    total = count_result.scalar()

    return RebalanceListResponse(
        rebalances=[
            RebalanceResponse(
                id=r.id,
                timestamp=r.ts,
                trigger_reason=r.trigger_reason,
                old_lower_tick=r.old_lower_tick,
                old_upper_tick=r.old_upper_tick,
                new_lower_tick=r.new_lower_tick,
                new_upper_tick=r.new_upper_tick,
                fees_sol_collected=r.fees_sol_collected,
                fees_usdc_collected=r.fees_usdc_collected,
                swap_direction=r.swap_direction,
                swap_amount_in=r.swap_amount_in,
                swap_amount_out=r.swap_amount_out,
                swap_price=r.swap_price,
                tx_fee_sol=r.tx_fee_sol,
                priority_fee_sol=r.priority_fee_sol,
                price_at_rebalance=r.price_at_rebalance,
                status=r.status,
                error_message=r.error_message,
                tx_sig_close=r.tx_sig_close,
                tx_sig_swap=r.tx_sig_swap,
                tx_sig_open=r.tx_sig_open,
            )
            for r in rebalances
        ],
        total=total,
    )


@router.get("/metrics/history", response_model=MetricsHistoryResponse)
async def get_metrics_history(
    user: UserInfo = Depends(get_current_user),
    days: int = 7,
    db: AsyncSession = Depends(get_db)
):
    """
    Get historical metrics for charts.

    Returns metric snapshots for the specified number of days.
    """
    from app.db.models import UserMetricSnapshot

    start_date = datetime.now(timezone.utc) - timedelta(days=days)

    result = await db.execute(
        select(UserMetricSnapshot)
        .where(
            UserMetricSnapshot.user_id == user.user_id,
            UserMetricSnapshot.timestamp >= start_date
        )
        .order_by(UserMetricSnapshot.timestamp.asc())
    )
    snapshots = result.scalars().all()

    return MetricsHistoryResponse(
        snapshots=[
            MetricSnapshot(
                timestamp=s.timestamp,
                total_value_usd=s.total_value_usd,
                sol_balance=s.sol_balance,
                usdc_balance=s.usdc_balance,
                position_value_usd=s.position_value_usd,
                fees_earned_usd=s.fees_earned_usd,
                il_usd=s.il_usd,
                sol_price_usd=s.sol_price_usd,
                has_active_position=s.has_active_position,
            )
            for s in snapshots
        ],
        start_date=start_date,
        end_date=datetime.now(timezone.utc),
    )


@router.get("/daily-stats", response_model=DailyStatsListResponse)
async def get_daily_stats(
    user: UserInfo = Depends(get_current_user),
    days: int = 30,
    db: AsyncSession = Depends(get_db)
):
    """Get daily statistics for the specified number of days."""
    from app.db.models import UserDailyStats

    start_date = date.today() - timedelta(days=days)

    result = await db.execute(
        select(UserDailyStats)
        .where(
            UserDailyStats.user_id == user.user_id,
            UserDailyStats.date >= start_date
        )
        .order_by(UserDailyStats.date.desc())
    )
    stats = result.scalars().all()

    return DailyStatsListResponse(
        stats=[
            DailyStatsResponse(
                date=s.date,
                rebalance_count=s.rebalance_count,
                emergency_rebalance_count=s.emergency_rebalance_count,
                fees_earned_usd=s.fees_earned_usd,
                pnl_usd=s.pnl_usd,
                tx_costs_usd=s.tx_costs_usd,
                positions_opened=s.positions_opened,
                positions_closed=s.positions_closed,
            )
            for s in stats
        ],
        total=len(stats),
    )


@router.get("/export")
async def export_portfolio_csv(
    user: UserInfo = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Export portfolio data as CSV.

    Returns all positions with full details for offline analysis.
    """
    from app.db.models import UserPosition

    result = await db.execute(
        select(UserPosition)
        .where(UserPosition.user_id == user.user_id)
        .order_by(UserPosition.opened_at.desc())
    )
    positions = result.scalars().all()

    # Create CSV
    output = StringIO()
    writer = csv.writer(output)

    # Header
    writer.writerow([
        "id", "position_pubkey", "pool_id",
        "lower_price", "upper_price", "lower_tick", "upper_tick", "liquidity",
        "entry_price", "entry_sol", "entry_usdc", "entry_value_usd",
        "opened_at",
        "exit_price", "exit_value_usd", "exit_reason", "closed_at",
        "fees_sol", "fees_usdc",
        "realized_pnl_usd", "il_usd",
        "is_active",
        "open_tx_sig", "close_tx_sig"
    ])

    # Data
    for p in positions:
        writer.writerow([
            p.id, p.position_pubkey, p.pool_id,
            p.lower_price, p.upper_price, p.lower_tick, p.upper_tick, p.liquidity,
            p.entry_price, p.entry_sol_amount, p.entry_usdc_amount, p.entry_value_usd,
            p.opened_at.isoformat() if p.opened_at else "",
            p.exit_price, p.exit_value_usd, p.exit_reason,
            p.closed_at.isoformat() if p.closed_at else "",
            p.fees_sol_collected, p.fees_usdc_collected,
            p.realized_pnl_usd, p.il_usd,
            p.is_active,
            p.open_tx_sig, p.close_tx_sig
        ])

    output.seek(0)

    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv",
        headers={
            "Content-Disposition": f"attachment; filename=portfolio_export_{user.user_id}_{date.today()}.csv"
        }
    )
