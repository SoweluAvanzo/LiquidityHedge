"""
Session management API endpoints.

Provides endpoints for managing user strategy sessions:
- Start/stop/pause/resume sessions
- Monitor session status
- View session history
"""

import logging
from datetime import datetime, timezone
from typing import List, Optional
from decimal import Decimal

from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, and_

from api.auth import get_current_user, UserInfo
from api.dependencies import get_db
from app.db.models import SessionStatus

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/sessions", tags=["sessions"])


# =============================================================================
# REQUEST/RESPONSE MODELS
# =============================================================================

class StartSessionRequest(BaseModel):
    """Request to start a new strategy session."""
    config_id: Optional[int] = Field(
        None,
        description="Strategy config ID to use. If not provided, uses default config."
    )


class SessionResponse(BaseModel):
    """Strategy session response."""
    id: int
    user_id: int
    config_id: Optional[int]
    config_name: Optional[str] = None
    status: str
    started_at: Optional[datetime]
    stopped_at: Optional[datetime]
    created_at: datetime

    # Performance metrics
    initial_value_usd: Optional[Decimal]
    current_value_usd: Optional[Decimal]
    total_fees_earned_usd: Decimal
    total_il_usd: Decimal
    total_tx_costs_usd: Decimal
    pnl_usd: Optional[Decimal] = Field(None, description="Total PnL (current - initial)")
    pnl_pct: Optional[float] = Field(None, description="PnL percentage")

    # Activity
    rebalance_count: int
    last_rebalance_at: Optional[datetime]
    last_heartbeat_at: Optional[datetime]

    # Error info
    error_message: Optional[str]
    error_count: int

    # Celery task
    celery_task_id: Optional[str]

    class Config:
        from_attributes = True


class SessionListResponse(BaseModel):
    """List of sessions."""
    sessions: List[SessionResponse]
    total: int


class SessionStatusResponse(BaseModel):
    """Quick session status check."""
    has_active_session: bool
    session_id: Optional[int]
    status: Optional[str]
    uptime_seconds: Optional[int]


# =============================================================================
# HELPER FUNCTIONS
# =============================================================================

def calculate_session_pnl(session) -> tuple[Optional[Decimal], Optional[float]]:
    """Calculate session PnL."""
    if session.initial_value_usd and session.current_value_usd:
        pnl_usd = session.current_value_usd - session.initial_value_usd
        pnl_pct = float(pnl_usd / session.initial_value_usd * 100) if session.initial_value_usd > 0 else None
        return pnl_usd, pnl_pct
    return None, None


def session_to_response(session, config_name: str = None) -> SessionResponse:
    """Convert database session to response model."""
    pnl_usd, pnl_pct = calculate_session_pnl(session)

    return SessionResponse(
        id=session.id,
        user_id=session.user_id,
        config_id=session.config_id,
        config_name=config_name,
        status=session.status,
        started_at=session.started_at,
        stopped_at=session.stopped_at,
        created_at=session.created_at,
        initial_value_usd=session.initial_value_usd,
        current_value_usd=session.current_value_usd,
        total_fees_earned_usd=session.total_fees_earned_usd,
        total_il_usd=session.total_il_usd,
        total_tx_costs_usd=session.total_tx_costs_usd,
        pnl_usd=pnl_usd,
        pnl_pct=pnl_pct,
        rebalance_count=session.rebalance_count,
        last_rebalance_at=session.last_rebalance_at,
        last_heartbeat_at=session.last_heartbeat_at,
        error_message=session.error_message,
        error_count=session.error_count,
        celery_task_id=session.celery_task_id,
    )


# =============================================================================
# API ENDPOINTS
# =============================================================================

@router.get("/status", response_model=SessionStatusResponse)
async def get_session_status(
    user: UserInfo = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Quick check for active session status.

    Useful for dashboard to show if user has running strategy.
    """
    from app.db.models import UserStrategySession

    result = await db.execute(
        select(UserStrategySession).where(
            UserStrategySession.user_id == user.user_id,
            UserStrategySession.status.in_(["running", "pending", "paused"])
        ).order_by(UserStrategySession.created_at.desc()).limit(1)
    )
    session = result.scalar_one_or_none()

    if not session:
        return SessionStatusResponse(
            has_active_session=False,
            session_id=None,
            status=None,
            uptime_seconds=None,
        )

    uptime = None
    if session.started_at:
        uptime = int((datetime.now(timezone.utc) - session.started_at).total_seconds())

    return SessionStatusResponse(
        has_active_session=True,
        session_id=session.id,
        status=session.status,
        uptime_seconds=uptime,
    )


@router.get("", response_model=SessionListResponse)
async def list_sessions(
    user: UserInfo = Depends(get_current_user),
    status: Optional[str] = None,
    limit: int = 20,
    offset: int = 0,
    db: AsyncSession = Depends(get_db)
):
    """List user's strategy sessions with optional status filter."""
    from app.db.models import UserStrategySession, UserStrategyConfig

    query = (
        select(UserStrategySession, UserStrategyConfig.config_name)
        .outerjoin(
            UserStrategyConfig,
            UserStrategySession.config_id == UserStrategyConfig.id
        )
        .where(UserStrategySession.user_id == user.user_id)
    )

    if status:
        query = query.where(UserStrategySession.status == status)

    query = query.order_by(UserStrategySession.created_at.desc())
    query = query.offset(offset).limit(limit)

    result = await db.execute(query)
    rows = result.all()

    # Get total count
    count_query = select(UserStrategySession).where(
        UserStrategySession.user_id == user.user_id
    )
    if status:
        count_query = count_query.where(UserStrategySession.status == status)
    count_result = await db.execute(count_query)
    total = len(count_result.scalars().all())

    return SessionListResponse(
        sessions=[
            session_to_response(session, config_name)
            for session, config_name in rows
        ],
        total=total,
    )


@router.get("/{session_id}", response_model=SessionResponse)
async def get_session(
    session_id: int,
    user: UserInfo = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Get details of a specific session."""
    from app.db.models import UserStrategySession, UserStrategyConfig

    result = await db.execute(
        select(UserStrategySession, UserStrategyConfig.config_name)
        .outerjoin(
            UserStrategyConfig,
            UserStrategySession.config_id == UserStrategyConfig.id
        )
        .where(
            UserStrategySession.id == session_id,
            UserStrategySession.user_id == user.user_id
        )
    )
    row = result.one_or_none()

    if not row:
        raise HTTPException(status_code=404, detail="Session not found")

    session, config_name = row
    return session_to_response(session, config_name)


@router.post("", response_model=SessionResponse, status_code=201)
async def start_session(
    body: StartSessionRequest,
    user: UserInfo = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Start a new strategy session.

    Creates a new session and spawns a Celery task to run the strategy.
    Only one active session per user is allowed.
    """
    from app.db.models import UserStrategySession, UserStrategyConfig, UserHotWallet

    # Check for existing active session
    result = await db.execute(
        select(UserStrategySession).where(
            UserStrategySession.user_id == user.user_id,
            UserStrategySession.status.in_(["pending", "running", "paused"])
        )
    )
    existing = result.scalar_one_or_none()

    if existing:
        raise HTTPException(
            status_code=400,
            detail=f"Already have an active session (ID: {existing.id}, status: {existing.status})"
        )

    # Check user has hot wallet
    result = await db.execute(
        select(UserHotWallet).where(UserHotWallet.user_id == user.user_id)
    )
    hot_wallet = result.scalar_one_or_none()

    if not hot_wallet:
        raise HTTPException(
            status_code=400,
            detail="No hot wallet found. Create one via /user/hot-wallet first."
        )

    # Verify config if specified
    config_name = None
    if body.config_id:
        result = await db.execute(
            select(UserStrategyConfig).where(
                UserStrategyConfig.id == body.config_id,
                UserStrategyConfig.user_id == user.user_id
            )
        )
        config = result.scalar_one_or_none()
        if not config:
            raise HTTPException(status_code=404, detail="Strategy config not found")
        config_name = config.config_name
    else:
        # Get default config
        result = await db.execute(
            select(UserStrategyConfig)
            .where(
                UserStrategyConfig.user_id == user.user_id,
                UserStrategyConfig.is_active == True
            )
            .order_by(UserStrategyConfig.created_at.desc())
            .limit(1)
        )
        config = result.scalar_one_or_none()
        if config:
            body.config_id = config.id
            config_name = config.config_name

    # Create session record
    session = UserStrategySession(
        user_id=user.user_id,
        config_id=body.config_id,
        status=SessionStatus.PENDING.value,
    )
    db.add(session)
    await db.commit()
    await db.refresh(session)

    # Spawn Celery task
    try:
        from tasks.strategy_tasks import run_user_strategy_session
        task = run_user_strategy_session.delay(user.user_id, session.id)

        # Update session with task ID
        session.celery_task_id = task.id
        session.started_at = datetime.now(timezone.utc)
        session.status = SessionStatus.RUNNING.value
        await db.commit()
        await db.refresh(session)

        logger.info(
            f"Started strategy session",
            extra={
                "user_id": user.user_id,
                "session_id": session.id,
                "celery_task_id": task.id
            }
        )
    except Exception as e:
        # Update session with error
        session.status = SessionStatus.ERROR.value
        session.error_message = str(e)
        await db.commit()

        logger.error(f"Failed to start session: {e}")
        raise HTTPException(
            status_code=500,
            detail=f"Failed to start session: {e}"
        )

    return session_to_response(session, config_name)


@router.put("/{session_id}/pause", response_model=SessionResponse)
async def pause_session(
    session_id: int,
    user: UserInfo = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Pause a running session."""
    from app.db.models import UserStrategySession

    result = await db.execute(
        select(UserStrategySession).where(
            UserStrategySession.id == session_id,
            UserStrategySession.user_id == user.user_id
        )
    )
    session = result.scalar_one_or_none()

    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    if session.status != SessionStatus.RUNNING.value:
        raise HTTPException(
            status_code=400,
            detail=f"Cannot pause session in status: {session.status}"
        )

    # Update status (worker will check and pause on next iteration)
    session.status = SessionStatus.PAUSED.value
    await db.commit()
    await db.refresh(session)

    logger.info(f"Paused session {session_id} for user {user.user_id}")

    return session_to_response(session)


@router.put("/{session_id}/resume", response_model=SessionResponse)
async def resume_session(
    session_id: int,
    user: UserInfo = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Resume a paused session."""
    from app.db.models import UserStrategySession

    result = await db.execute(
        select(UserStrategySession).where(
            UserStrategySession.id == session_id,
            UserStrategySession.user_id == user.user_id
        )
    )
    session = result.scalar_one_or_none()

    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    if session.status != SessionStatus.PAUSED.value:
        raise HTTPException(
            status_code=400,
            detail=f"Cannot resume session in status: {session.status}"
        )

    # Update status (worker will check and resume)
    session.status = SessionStatus.RUNNING.value
    await db.commit()
    await db.refresh(session)

    logger.info(f"Resumed session {session_id} for user {user.user_id}")

    return session_to_response(session)


@router.delete("/{session_id}", response_model=SessionResponse)
async def stop_session(
    session_id: int,
    user: UserInfo = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Stop a running or paused session.

    This will signal the Celery worker to gracefully stop and
    close any open positions.
    """
    from app.db.models import UserStrategySession

    result = await db.execute(
        select(UserStrategySession).where(
            UserStrategySession.id == session_id,
            UserStrategySession.user_id == user.user_id
        )
    )
    session = result.scalar_one_or_none()

    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    if session.status not in [
        SessionStatus.RUNNING.value,
        SessionStatus.PAUSED.value,
        SessionStatus.PENDING.value
    ]:
        raise HTTPException(
            status_code=400,
            detail=f"Cannot stop session in status: {session.status}"
        )

    # Try to revoke Celery task
    if session.celery_task_id:
        try:
            from celery import current_app
            current_app.control.revoke(session.celery_task_id, terminate=True)
        except Exception as e:
            logger.warning(f"Failed to revoke Celery task: {e}")

    # Update session status
    session.status = SessionStatus.STOPPED.value
    session.stopped_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(session)

    logger.info(f"Stopped session {session_id} for user {user.user_id}")

    return session_to_response(session)
