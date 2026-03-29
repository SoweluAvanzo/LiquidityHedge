"""
Multi-user adapter module for LP Strategy.

Provides adapter classes that wrap existing single-user modules
to work with the multi-user UserContext system.

This module bridges the gap between:
- The existing code with global singletons
- The new multi-user architecture with UserContext

Usage:
    from multiuser_adapter import create_user_components

    # Get all components for a user
    components = await create_user_components(user_context, db_session)

    # Use components
    components.csv_logger.log_position_open(...)
    await components.trade_executor.open_position(...)
"""

import os
import logging
from dataclasses import dataclass
from typing import Optional, TYPE_CHECKING

if TYPE_CHECKING:
    from user_context import UserContext
    from config import Config
    from csv_logger import CSVLogger
    from session_manager import SessionManager

logger = logging.getLogger(__name__)


# =============================================================================
# USER COMPONENT CONTAINER
# =============================================================================

@dataclass
class UserComponents:
    """
    Container for all user-specific component instances.

    Provides isolated instances of:
    - Configuration (with user overrides)
    - CSV Logger (writes to user's data directory)
    - Session Manager (tracks user's session state)
    - Trade Executor (uses user's hot wallet)
    """
    user_id: int
    config: "Config"
    csv_logger: "CSVLogger"
    session_manager: "SessionManager"
    data_dir: str

    # Trade executor is initialized lazily since it requires async
    _trade_executor: Optional[object] = None

    @property
    def trade_executor(self):
        """Get trade executor (must be initialized first)."""
        if self._trade_executor is None:
            raise RuntimeError("Trade executor not initialized. Call initialize_trade_executor() first.")
        return self._trade_executor


# =============================================================================
# COMPONENT FACTORY
# =============================================================================

async def create_user_components(
    user_context: "UserContext",
    db_session = None
) -> UserComponents:
    """
    Create all required components for a user.

    This factory function creates isolated instances of all strategy
    components configured for a specific user.

    Args:
        user_context: The user's context with config and wallet info
        db_session: Optional database session for session manager

    Returns:
        UserComponents: Container with all user-specific components
    """
    from csv_logger import get_user_csv_logger
    from session_manager import SessionManager

    # Get user-specific CSV logger
    csv_logger = get_user_csv_logger(
        user_id=user_context.user_id,
        base_data_dir=os.getenv('DATA_DIR', '/data')
    )

    # Create user-specific session manager
    session_manager = SessionManager(
        data_dir=user_context.data_dir,
        user_id=user_context.user_id
    )

    logger.info(
        f"Created components for user {user_context.user_id}",
        extra={
            "user_id": user_context.user_id,
            "data_dir": user_context.data_dir,
        }
    )

    return UserComponents(
        user_id=user_context.user_id,
        config=user_context.config,
        csv_logger=csv_logger,
        session_manager=session_manager,
        data_dir=user_context.data_dir,
    )


async def initialize_trade_executor(
    components: UserComponents,
    user_context: "UserContext"
) -> None:
    """
    Initialize the trade executor for a user.

    This must be called separately since it requires async initialization.

    Args:
        components: The user's components container
        user_context: The user's context with wallet info
    """
    from execution import TradeExecutor

    # Create config override with user's wallet
    config = user_context.config

    # Override the wallet private key in config
    # Note: This is a bit hacky but avoids modifying the TradeExecutor class
    original_wallet_key = config.api.wallet_private_key
    config.api.wallet_private_key = user_context.hot_wallet_base58

    try:
        # Create trade executor with user's config
        trade_executor = TradeExecutor(config)
        await trade_executor.initialize()

        components._trade_executor = trade_executor

        logger.info(
            f"Initialized trade executor for user {user_context.user_id}",
            extra={
                "user_id": user_context.user_id,
                "hot_wallet": user_context.hot_wallet_pubkey,
            }
        )

    finally:
        # Restore original config (though this instance shouldn't be reused)
        config.api.wallet_private_key = original_wallet_key


def cleanup_user_components(user_id: int) -> None:
    """
    Clean up all components for a user.

    Call this when a user's session ends to free resources.

    Args:
        user_id: The user's database ID
    """
    from csv_logger import remove_user_csv_logger

    # Clean up CSV logger
    remove_user_csv_logger(user_id)

    logger.info(f"Cleaned up components for user {user_id}")


# =============================================================================
# SESSION MANAGER ADAPTER
# =============================================================================

class UserSessionManager:
    """
    Adapter for SessionManager that adds user isolation.

    Wraps the existing SessionManager to:
    - Track user_id with all operations
    - Write session data to user-specific directory
    - Isolate daily rebalance counts per user
    """

    def __init__(self, base_session_manager: "SessionManager", user_id: int):
        self._manager = base_session_manager
        self._user_id = user_id

    @property
    def user_id(self) -> int:
        return self._user_id

    def start_session(self) -> str:
        """Start a new session for this user."""
        session_id = self._manager.start_session()
        logger.info(
            f"Started session for user {self._user_id}",
            extra={"user_id": self._user_id, "session_id": session_id}
        )
        return session_id

    def get_session_state(self):
        """Get current session state."""
        return self._manager.get_session_state()

    def can_rebalance(self) -> bool:
        """Check if user can perform a normal rebalance today."""
        return self._manager.can_rebalance()

    def can_emergency_rebalance(self) -> bool:
        """Check if user can perform an emergency rebalance."""
        return self._manager.can_emergency_rebalance()

    def record_rebalance(self, **kwargs):
        """Record a rebalance event."""
        return self._manager.record_rebalance(**kwargs)

    def record_position(self, **kwargs):
        """Record a position."""
        return self._manager.register_position(**kwargs)

    def close_position(self, **kwargs):
        """Close a position."""
        return self._manager.close_position(**kwargs)


# =============================================================================
# DATABASE INTEGRATION
# =============================================================================

async def sync_session_to_db(
    components: UserComponents,
    db_session,
    strategy_session_id: int
) -> None:
    """
    Sync session state to database for persistence.

    This updates the UserStrategySession record with current metrics
    from the in-memory session manager.

    Args:
        components: User's components
        db_session: Database session
        strategy_session_id: ID of the UserStrategySession record
    """
    from sqlalchemy import select
    from app.db.models import UserStrategySession
    from decimal import Decimal
    from datetime import datetime, timezone

    result = await db_session.execute(
        select(UserStrategySession).where(UserStrategySession.id == strategy_session_id)
    )
    session_record = result.scalar_one_or_none()

    if not session_record:
        logger.warning(f"Session {strategy_session_id} not found in database")
        return

    # Get session state from manager
    state = components.session_manager.get_session_state()

    if state:
        # Update metrics
        session_record.rebalance_count = state.total_rebalances
        session_record.last_rebalance_at = state.last_rebalance_time
        session_record.last_heartbeat_at = datetime.now(timezone.utc)

        # Update financial metrics if available
        if hasattr(state, 'total_fees_usd'):
            session_record.total_fees_earned_usd = Decimal(str(state.total_fees_usd))
        if hasattr(state, 'total_il_usd'):
            session_record.total_il_usd = Decimal(str(state.total_il_usd))
        if hasattr(state, 'total_tx_costs_usd'):
            session_record.total_tx_costs_usd = Decimal(str(state.total_tx_costs_usd))

    await db_session.commit()


async def record_position_to_db(
    components: UserComponents,
    db_session,
    position_data: dict,
    strategy_session_id: int
) -> int:
    """
    Record a new position to the database.

    Args:
        components: User's components
        db_session: Database session
        position_data: Dictionary with position details
        strategy_session_id: ID of the UserStrategySession record

    Returns:
        int: ID of the created UserPosition record
    """
    from app.db.models import UserPosition
    from decimal import Decimal

    position = UserPosition(
        user_id=components.user_id,
        session_id=strategy_session_id,
        position_pubkey=position_data['position_pubkey'],
        pool_id=position_data['pool_id'],
        lower_tick=position_data['lower_tick'],
        upper_tick=position_data['upper_tick'],
        lower_price=Decimal(str(position_data['lower_price'])),
        upper_price=Decimal(str(position_data['upper_price'])),
        liquidity=Decimal(str(position_data['liquidity'])),
        entry_sol_amount=Decimal(str(position_data['sol_amount'])),
        entry_usdc_amount=Decimal(str(position_data['usdc_amount'])),
        entry_price=Decimal(str(position_data['entry_price'])),
        entry_value_usd=Decimal(str(position_data['entry_value_usd'])),
        open_tx_sig=position_data.get('tx_signature'),
        is_active=True,
    )

    db_session.add(position)
    await db_session.commit()
    await db_session.refresh(position)

    logger.info(
        f"Recorded position to DB for user {components.user_id}",
        extra={
            "user_id": components.user_id,
            "position_id": position.id,
            "position_pubkey": position.position_pubkey,
        }
    )

    return position.id


async def close_position_in_db(
    db_session,
    position_id: int,
    close_data: dict
) -> None:
    """
    Close a position in the database.

    Args:
        db_session: Database session
        position_id: ID of the UserPosition record
        close_data: Dictionary with closing details
    """
    from sqlalchemy import select
    from app.db.models import UserPosition
    from decimal import Decimal
    from datetime import datetime, timezone

    result = await db_session.execute(
        select(UserPosition).where(UserPosition.id == position_id)
    )
    position = result.scalar_one_or_none()

    if not position:
        logger.warning(f"Position {position_id} not found in database")
        return

    position.is_active = False
    position.closed_at = datetime.now(timezone.utc)
    position.exit_price = Decimal(str(close_data.get('exit_price', 0)))
    position.exit_value_usd = Decimal(str(close_data.get('exit_value_usd', 0)))
    position.exit_reason = close_data.get('exit_reason', 'unknown')
    position.close_tx_sig = close_data.get('tx_signature')

    if 'fees_sol' in close_data:
        position.fees_sol_collected = Decimal(str(close_data['fees_sol']))
    if 'fees_usdc' in close_data:
        position.fees_usdc_collected = Decimal(str(close_data['fees_usdc']))
    if 'realized_pnl' in close_data:
        position.realized_pnl_usd = Decimal(str(close_data['realized_pnl']))
    if 'il_usd' in close_data:
        position.il_usd = Decimal(str(close_data['il_usd']))

    await db_session.commit()

    logger.info(
        f"Closed position {position_id} in DB",
        extra={"position_id": position_id, "exit_reason": close_data.get('exit_reason')}
    )


async def record_rebalance_to_db(
    components: UserComponents,
    db_session,
    rebalance_data: dict,
    strategy_session_id: int,
    old_position_id: Optional[int] = None,
    new_position_id: Optional[int] = None
) -> int:
    """
    Record a rebalance event to the database.

    Args:
        components: User's components
        db_session: Database session
        rebalance_data: Dictionary with rebalance details
        strategy_session_id: ID of the UserStrategySession record
        old_position_id: ID of the closed position (if any)
        new_position_id: ID of the new position (if any)

    Returns:
        int: ID of the created UserRebalance record
    """
    from app.db.models import UserRebalance
    from decimal import Decimal

    rebalance = UserRebalance(
        user_id=components.user_id,
        session_id=strategy_session_id,
        old_position_id=old_position_id,
        new_position_id=new_position_id,
        old_lower_tick=rebalance_data.get('old_lower_tick'),
        old_upper_tick=rebalance_data.get('old_upper_tick'),
        new_lower_tick=rebalance_data['new_lower_tick'],
        new_upper_tick=rebalance_data['new_upper_tick'],
        trigger_reason=rebalance_data['trigger_reason'],
        fees_sol_collected=Decimal(str(rebalance_data.get('fees_sol', 0))),
        fees_usdc_collected=Decimal(str(rebalance_data.get('fees_usdc', 0))),
        swap_direction=rebalance_data.get('swap_direction'),
        swap_amount_in=Decimal(str(rebalance_data['swap_amount_in'])) if rebalance_data.get('swap_amount_in') else None,
        swap_amount_out=Decimal(str(rebalance_data['swap_amount_out'])) if rebalance_data.get('swap_amount_out') else None,
        swap_price=Decimal(str(rebalance_data['swap_price'])) if rebalance_data.get('swap_price') else None,
        tx_fee_sol=Decimal(str(rebalance_data.get('tx_fee_sol', 0))),
        priority_fee_sol=Decimal(str(rebalance_data.get('priority_fee_sol', 0))),
        price_at_rebalance=Decimal(str(rebalance_data['price_at_rebalance'])),
        status=rebalance_data.get('status', 'success'),
        error_message=rebalance_data.get('error_message'),
        tx_sig_close=rebalance_data.get('tx_sig_close'),
        tx_sig_swap=rebalance_data.get('tx_sig_swap'),
        tx_sig_open=rebalance_data.get('tx_sig_open'),
    )

    db_session.add(rebalance)
    await db_session.commit()
    await db_session.refresh(rebalance)

    logger.info(
        f"Recorded rebalance to DB for user {components.user_id}",
        extra={
            "user_id": components.user_id,
            "rebalance_id": rebalance.id,
            "trigger_reason": rebalance.trigger_reason,
        }
    )

    return rebalance.id
