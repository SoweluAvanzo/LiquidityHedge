"""
Strategy execution tasks for Celery workers.

Main tasks:
- run_user_strategy_session: Long-running task that executes strategy for a user

Maintenance tasks:
- cleanup_old_snapshots: Remove old metric snapshots
- cleanup_expired_nonces: Remove expired auth nonces
"""

import os
import asyncio
import logging
from datetime import datetime, timezone, timedelta
from decimal import Decimal

from celery import shared_task
from sqlalchemy import select, delete, and_
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine, async_sessionmaker

from tasks.celery_app import celery_app

logger = logging.getLogger(__name__)


# =============================================================================
# DATABASE SESSION FOR TASKS
# =============================================================================

def get_async_session_factory():
    """Create async session factory for Celery tasks."""
    database_url = os.getenv("DATABASE_URL", "")
    if database_url.startswith("postgres://"):
        database_url = database_url.replace("postgres://", "postgresql+asyncpg://", 1)
    elif database_url.startswith("postgresql://"):
        database_url = database_url.replace("postgresql://", "postgresql+asyncpg://", 1)

    engine = create_async_engine(
        database_url,
        pool_pre_ping=True,
        pool_size=5,
    )

    return async_sessionmaker(
        bind=engine,
        class_=AsyncSession,
        autocommit=False,
        autoflush=False,
        expire_on_commit=False,
    )


# =============================================================================
# HELPER FUNCTIONS
# =============================================================================

def run_async(coro):
    """Run an async coroutine in a sync context."""
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


async def update_session_status(
    db: AsyncSession,
    session_id: int,
    status: str,
    error_message: str = None,
    **kwargs
):
    """Update session status in database."""
    from app.db.models import UserStrategySession

    result = await db.execute(
        select(UserStrategySession).where(UserStrategySession.id == session_id)
    )
    session = result.scalar_one_or_none()

    if session:
        session.status = status
        if error_message:
            session.error_message = error_message
            session.error_count += 1
            session.last_error_at = datetime.now(timezone.utc)

        for key, value in kwargs.items():
            if hasattr(session, key):
                setattr(session, key, value)

        await db.commit()


async def record_metric_snapshot(
    db: AsyncSession,
    user_id: int,
    session_id: int,
    snapshot_data: dict
):
    """Record a metric snapshot to database."""
    from app.db.models import UserMetricSnapshot

    snapshot = UserMetricSnapshot(
        user_id=user_id,
        session_id=session_id,
        **snapshot_data
    )
    db.add(snapshot)
    await db.commit()


async def send_ws_update(user_id: int, message: dict):
    """Send WebSocket update to user (via Redis pub/sub)."""
    try:
        import redis.asyncio as redis
        redis_url = os.getenv("REDIS_URL", "redis://localhost:6379/0")
        client = redis.from_url(redis_url)
        await client.publish(
            f"user:{user_id}:updates",
            str(message)
        )
        await client.close()
    except Exception as e:
        logger.warning(f"Failed to send WS update: {e}")


# =============================================================================
# MAIN STRATEGY EXECUTION TASK
# =============================================================================

@celery_app.task(
    bind=True,
    name="tasks.strategy_tasks.run_user_strategy_session",
    max_retries=3,
    default_retry_delay=60,
    autoretry_for=(Exception,),
    retry_backoff=True,
)
def run_user_strategy_session(self, user_id: int, session_id: int):
    """
    Long-running task that executes the LP strategy for a user.

    This task:
    1. Loads user context (config, wallet, etc.)
    2. Runs the strategy loop until stopped/paused
    3. Records metrics periodically
    4. Sends real-time updates via WebSocket

    Args:
        user_id: User's database ID
        session_id: Strategy session ID
    """
    logger.info(f"Starting strategy session for user {user_id}, session {session_id}")

    async def async_run():
        """Async implementation of the strategy runner."""
        from app.db.models import UserStrategySession, SessionStatus

        SessionFactory = get_async_session_factory()

        async with SessionFactory() as db:
            # Load session
            result = await db.execute(
                select(UserStrategySession).where(UserStrategySession.id == session_id)
            )
            session = result.scalar_one_or_none()

            if not session:
                logger.error(f"Session {session_id} not found")
                return {"status": "error", "message": "Session not found"}

            if session.user_id != user_id:
                logger.error(f"Session {session_id} does not belong to user {user_id}")
                return {"status": "error", "message": "Session user mismatch"}

            # Update session status
            await update_session_status(
                db, session_id, SessionStatus.RUNNING.value,
                started_at=datetime.now(timezone.utc)
            )

            try:
                # Import and create user context
                from user_context import get_context_manager

                ctx_manager = get_context_manager()
                context = await ctx_manager.get_or_create(
                    user_id, db, session.config_id
                )
                context.session_id = session_id

                # Get initial portfolio value
                initial_value = await get_portfolio_value(context, db)
                await update_session_status(
                    db, session_id, SessionStatus.RUNNING.value,
                    initial_value_usd=initial_value
                )

                # Run strategy loop
                await run_strategy_loop(context, session_id, db, self)

                # Session ended normally
                await update_session_status(
                    db, session_id, SessionStatus.STOPPED.value,
                    stopped_at=datetime.now(timezone.utc)
                )

                return {"status": "stopped", "session_id": session_id}

            except Exception as e:
                logger.exception(f"Strategy session error: {e}")
                await update_session_status(
                    db, session_id, SessionStatus.ERROR.value,
                    error_message=str(e)
                )
                raise

            finally:
                # Clean up user context
                ctx_manager.remove_context(user_id)

    return run_async(async_run())


async def get_portfolio_value(context, db: AsyncSession) -> Decimal:
    """Get current portfolio value from chain."""
    # TODO: Implement actual balance fetching
    # For now, return a placeholder
    return Decimal("0")


async def run_strategy_loop(context, session_id: int, db: AsyncSession, task):
    """
    Main strategy execution loop.

    Mirrors the logic from lp_strategy.py but with multi-user support.
    """
    from app.db.models import UserStrategySession, SessionStatus

    logger.info(f"Starting strategy loop for session {session_id}")

    iteration = 0
    last_snapshot_time = datetime.now(timezone.utc)
    snapshot_interval = timedelta(minutes=5)

    while True:
        iteration += 1

        # Check session status (for pause/stop commands)
        result = await db.execute(
            select(UserStrategySession).where(UserStrategySession.id == session_id)
        )
        session = result.scalar_one_or_none()

        if not session:
            logger.warning(f"Session {session_id} no longer exists")
            break

        if session.status == SessionStatus.STOPPED.value:
            logger.info(f"Session {session_id} stopped by user")
            break

        if session.status == SessionStatus.PAUSED.value:
            logger.info(f"Session {session_id} paused, waiting...")
            await asyncio.sleep(10)
            continue

        # Update heartbeat
        session.last_heartbeat_at = datetime.now(timezone.utc)
        await db.commit()

        try:
            # Run one iteration of the strategy
            await run_strategy_iteration(context, session_id, db)

            # Record snapshot periodically
            if datetime.now(timezone.utc) - last_snapshot_time > snapshot_interval:
                await record_portfolio_snapshot(context, session_id, db)
                last_snapshot_time = datetime.now(timezone.utc)

        except Exception as e:
            logger.error(f"Iteration {iteration} error: {e}")
            session.error_count += 1
            session.last_error_at = datetime.now(timezone.utc)
            session.error_message = str(e)

            # Check if too many errors
            if session.error_count >= 10:
                logger.error(f"Too many errors, stopping session {session_id}")
                session.status = SessionStatus.ERROR.value
                await db.commit()
                break

            await db.commit()

        # Wait for next check interval
        await asyncio.sleep(context.config.session.check_interval_seconds)


async def run_strategy_iteration(context, session_id: int, db: AsyncSession):
    """
    Run one iteration of the strategy.

    This implements the core strategy logic:
    1. Check if position exists
    2. If no position, check if we should open one
    3. If position exists, check if it's in range
    4. If out of range, check if we should rebalance
    5. Update position metrics
    """
    from app.db.models import UserPosition, UserStrategySession

    logger.debug(f"Running strategy iteration for session {session_id}")

    # Check for active position
    result = await db.execute(
        select(UserPosition).where(
            UserPosition.user_id == context.user_id,
            UserPosition.is_active == True
        )
    )
    active_position = result.scalar_one_or_none()

    if not active_position:
        # No position - check if we should open one
        await check_and_open_position(context, session_id, db)
    else:
        # Have position - monitor it
        await monitor_position(context, active_position, session_id, db)


async def check_and_open_position(context, session_id: int, db: AsyncSession):
    """
    Check conditions and open a new position if appropriate.

    This is a placeholder - actual implementation would:
    1. Check wallet balances
    2. Calculate optimal range based on ATR
    3. Execute position opening via OrcaClient
    """
    logger.debug(f"Checking if should open position for session {session_id}")

    # TODO: Implement actual position opening logic
    # This would use the existing execution.py module
    # but with the user's context (wallet, config)
    pass


async def monitor_position(context, position, session_id: int, db: AsyncSession):
    """
    Monitor an active position and rebalance if needed.

    This is a placeholder - actual implementation would:
    1. Fetch current pool price
    2. Check if price is in position range
    3. Check rebalance conditions (skew, out of range, etc.)
    4. Execute rebalance if needed
    5. Update position metrics
    """
    logger.debug(f"Monitoring position {position.id} for session {session_id}")

    # TODO: Implement actual monitoring logic
    # This would use the existing position_monitor.py module
    # but with the user's context
    pass


async def record_portfolio_snapshot(context, session_id: int, db: AsyncSession):
    """Record a metric snapshot for the user."""
    from app.db.models import UserMetricSnapshot, UserPosition

    # Get active position
    result = await db.execute(
        select(UserPosition).where(
            UserPosition.user_id == context.user_id,
            UserPosition.is_active == True
        )
    )
    active_position = result.scalar_one_or_none()

    # TODO: Fetch actual balances from chain
    snapshot = UserMetricSnapshot(
        user_id=context.user_id,
        session_id=session_id,
        total_value_usd=Decimal("0"),
        sol_balance=Decimal("0"),
        usdc_balance=Decimal("0"),
        position_value_usd=Decimal("0"),
        has_active_position=active_position is not None,
    )

    db.add(snapshot)
    await db.commit()

    # Send WebSocket update
    await send_ws_update(context.user_id, {
        "type": "metrics_update",
        "data": {
            "session_id": session_id,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "has_position": active_position is not None,
        }
    })


# =============================================================================
# MAINTENANCE TASKS
# =============================================================================

@celery_app.task(name="tasks.strategy_tasks.cleanup_old_snapshots")
def cleanup_old_snapshots():
    """
    Clean up old metric snapshots to manage database size.

    Keeps:
    - All snapshots from last 7 days
    - Hourly snapshots from 7-30 days ago
    - Daily snapshots from 30-90 days ago
    - Deletes everything older than 90 days
    """
    logger.info("Running cleanup_old_snapshots task")

    async def async_cleanup():
        from app.db.models import UserMetricSnapshot

        SessionFactory = get_async_session_factory()

        async with SessionFactory() as db:
            cutoff_90_days = datetime.now(timezone.utc) - timedelta(days=90)

            # Delete snapshots older than 90 days
            result = await db.execute(
                delete(UserMetricSnapshot)
                .where(UserMetricSnapshot.timestamp < cutoff_90_days)
            )
            deleted = result.rowcount
            await db.commit()

            logger.info(f"Deleted {deleted} snapshots older than 90 days")

            return {"deleted": deleted}

    return run_async(async_cleanup())


@celery_app.task(name="tasks.strategy_tasks.cleanup_expired_nonces")
def cleanup_expired_nonces():
    """Clean up expired authentication nonces."""
    logger.info("Running cleanup_expired_nonces task")

    async def async_cleanup():
        from app.db.models import AuthNonce

        SessionFactory = get_async_session_factory()

        async with SessionFactory() as db:
            now = datetime.now(timezone.utc)

            # Delete expired nonces
            result = await db.execute(
                delete(AuthNonce)
                .where(AuthNonce.expires_at < now)
            )
            deleted = result.rowcount
            await db.commit()

            logger.info(f"Deleted {deleted} expired nonces")

            return {"deleted": deleted}

    return run_async(async_cleanup())


@celery_app.task(name="tasks.strategy_tasks.check_stale_sessions")
def check_stale_sessions():
    """
    Check for sessions that haven't sent heartbeat in a while.

    Marks them as errored so users know something went wrong.
    """
    logger.info("Running check_stale_sessions task")

    async def async_check():
        from app.db.models import UserStrategySession, SessionStatus

        SessionFactory = get_async_session_factory()

        async with SessionFactory() as db:
            stale_cutoff = datetime.now(timezone.utc) - timedelta(minutes=10)

            # Find stale running sessions
            result = await db.execute(
                select(UserStrategySession)
                .where(
                    UserStrategySession.status == SessionStatus.RUNNING.value,
                    UserStrategySession.last_heartbeat_at < stale_cutoff
                )
            )
            stale_sessions = result.scalars().all()

            for session in stale_sessions:
                logger.warning(
                    f"Session {session.id} for user {session.user_id} is stale"
                )
                session.status = SessionStatus.ERROR.value
                session.error_message = "Worker stopped responding (heartbeat timeout)"
                session.error_count += 1

            await db.commit()

            return {"stale_sessions": len(stale_sessions)}

    return run_async(async_check())
