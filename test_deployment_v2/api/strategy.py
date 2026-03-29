"""
Strategy configuration API endpoints.

Provides CRUD operations for user strategy configurations.
"""

import logging
from datetime import datetime, timezone
from typing import List, Optional
from decimal import Decimal

from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel, Field, field_validator
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, delete

from api.auth import get_current_user, UserInfo
from api.dependencies import get_db

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/strategy", tags=["strategy"])


# =============================================================================
# REQUEST/RESPONSE MODELS
# =============================================================================

class StrategyConfigBase(BaseModel):
    """Base strategy configuration fields."""
    config_name: str = Field(
        default="default",
        min_length=1,
        max_length=100,
        description="Name for this configuration"
    )

    # Range Configuration
    k_coefficient: float = Field(
        default=0.60,
        ge=0.50,
        le=1.00,
        description="Aggression coefficient K - controls range width relative to ATR"
    )
    min_range: float = Field(
        default=0.03,
        ge=0.01,
        le=0.15,
        description="Minimum range width (e.g., 0.03 = 3%)"
    )
    max_range: float = Field(
        default=0.07,
        ge=0.02,
        le=0.20,
        description="Maximum range width (e.g., 0.07 = 7%)"
    )

    # ATR Configuration
    atr_period_days: int = Field(
        default=14,
        ge=7,
        le=30,
        description="ATR calculation period in days"
    )
    atr_change_threshold: float = Field(
        default=0.15,
        ge=0.05,
        le=0.50,
        description="ATR change threshold to trigger range update (e.g., 0.15 = 15%)"
    )

    # Rebalance Configuration
    max_rebalances_per_day: int = Field(
        default=2,
        ge=1,
        le=10,
        description="Maximum normal rebalances per day"
    )
    max_emergency_rebalances: int = Field(
        default=4,
        ge=1,
        le=10,
        description="Maximum emergency rebalances per day"
    )
    ratio_skew_threshold: float = Field(
        default=0.90,
        ge=0.70,
        le=0.99,
        description="Ratio skew threshold to trigger rebalance (e.g., 0.90 = 90% one-sided)"
    )

    # Capital Configuration
    capital_deployment_pct: float = Field(
        default=0.80,
        ge=0.50,
        le=1.00,
        description="Percentage of capital to deploy (e.g., 0.80 = 80%)"
    )
    max_sol_per_position: float = Field(
        default=1.0,
        ge=0.1,
        le=100.0,
        description="Maximum SOL per position"
    )
    min_sol_reserve: float = Field(
        default=0.05,
        ge=0.01,
        le=1.0,
        description="Minimum SOL to keep as reserve for transaction fees"
    )

    # Stop Loss Configuration
    stop_loss_enabled: bool = Field(
        default=False,
        description="Enable stop-loss protection"
    )
    stop_loss_pct: float = Field(
        default=0.10,
        ge=0.01,
        le=0.50,
        description="Stop-loss trigger percentage below range (e.g., 0.10 = 10%)"
    )

    # Timing Configuration
    check_interval_seconds: int = Field(
        default=30,
        ge=10,
        le=300,
        description="Position check interval in seconds"
    )

    @field_validator('max_range')
    @classmethod
    def max_range_greater_than_min(cls, v, info):
        """Ensure max_range > min_range."""
        if 'min_range' in info.data and v <= info.data['min_range']:
            raise ValueError('max_range must be greater than min_range')
        return v


class CreateStrategyConfigRequest(StrategyConfigBase):
    """Request to create a new strategy configuration."""
    pass


class UpdateStrategyConfigRequest(BaseModel):
    """Request to update strategy configuration (partial update)."""
    config_name: Optional[str] = Field(None, min_length=1, max_length=100)
    k_coefficient: Optional[float] = Field(None, ge=0.50, le=1.00)
    min_range: Optional[float] = Field(None, ge=0.01, le=0.15)
    max_range: Optional[float] = Field(None, ge=0.02, le=0.20)
    atr_period_days: Optional[int] = Field(None, ge=7, le=30)
    atr_change_threshold: Optional[float] = Field(None, ge=0.05, le=0.50)
    max_rebalances_per_day: Optional[int] = Field(None, ge=1, le=10)
    max_emergency_rebalances: Optional[int] = Field(None, ge=1, le=10)
    ratio_skew_threshold: Optional[float] = Field(None, ge=0.70, le=0.99)
    capital_deployment_pct: Optional[float] = Field(None, ge=0.50, le=1.00)
    max_sol_per_position: Optional[float] = Field(None, ge=0.1, le=100.0)
    min_sol_reserve: Optional[float] = Field(None, ge=0.01, le=1.0)
    stop_loss_enabled: Optional[bool] = None
    stop_loss_pct: Optional[float] = Field(None, ge=0.01, le=0.50)
    check_interval_seconds: Optional[int] = Field(None, ge=10, le=300)
    is_active: Optional[bool] = None


class StrategyConfigResponse(StrategyConfigBase):
    """Strategy configuration response."""
    id: int
    user_id: int
    is_active: bool
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class StrategyConfigListResponse(BaseModel):
    """List of strategy configurations."""
    configs: List[StrategyConfigResponse]
    total: int


# =============================================================================
# API ENDPOINTS
# =============================================================================

@router.get("/configs", response_model=StrategyConfigListResponse)
async def list_configs(
    user: UserInfo = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """List all strategy configurations for the current user."""
    from app.db.models import UserStrategyConfig

    result = await db.execute(
        select(UserStrategyConfig)
        .where(UserStrategyConfig.user_id == user.user_id)
        .order_by(UserStrategyConfig.created_at.desc())
    )
    configs = result.scalars().all()

    return StrategyConfigListResponse(
        configs=[
            StrategyConfigResponse(
                id=c.id,
                user_id=c.user_id,
                config_name=c.config_name,
                k_coefficient=float(c.k_coefficient),
                min_range=float(c.min_range),
                max_range=float(c.max_range),
                atr_period_days=c.atr_period_days,
                atr_change_threshold=float(c.atr_change_threshold),
                max_rebalances_per_day=c.max_rebalances_per_day,
                max_emergency_rebalances=c.max_emergency_rebalances,
                ratio_skew_threshold=float(c.ratio_skew_threshold),
                capital_deployment_pct=float(c.capital_deployment_pct),
                max_sol_per_position=float(c.max_sol_per_position),
                min_sol_reserve=float(c.min_sol_reserve),
                stop_loss_enabled=c.stop_loss_enabled,
                stop_loss_pct=float(c.stop_loss_pct),
                check_interval_seconds=c.check_interval_seconds,
                is_active=c.is_active,
                created_at=c.created_at,
                updated_at=c.updated_at,
            )
            for c in configs
        ],
        total=len(configs)
    )


@router.get("/configs/{config_id}", response_model=StrategyConfigResponse)
async def get_config(
    config_id: int,
    user: UserInfo = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Get a specific strategy configuration."""
    from app.db.models import UserStrategyConfig

    result = await db.execute(
        select(UserStrategyConfig).where(
            UserStrategyConfig.id == config_id,
            UserStrategyConfig.user_id == user.user_id
        )
    )
    config = result.scalar_one_or_none()

    if not config:
        raise HTTPException(status_code=404, detail="Configuration not found")

    return StrategyConfigResponse(
        id=config.id,
        user_id=config.user_id,
        config_name=config.config_name,
        k_coefficient=float(config.k_coefficient),
        min_range=float(config.min_range),
        max_range=float(config.max_range),
        atr_period_days=config.atr_period_days,
        atr_change_threshold=float(config.atr_change_threshold),
        max_rebalances_per_day=config.max_rebalances_per_day,
        max_emergency_rebalances=config.max_emergency_rebalances,
        ratio_skew_threshold=float(config.ratio_skew_threshold),
        capital_deployment_pct=float(config.capital_deployment_pct),
        max_sol_per_position=float(config.max_sol_per_position),
        min_sol_reserve=float(config.min_sol_reserve),
        stop_loss_enabled=config.stop_loss_enabled,
        stop_loss_pct=float(config.stop_loss_pct),
        check_interval_seconds=config.check_interval_seconds,
        is_active=config.is_active,
        created_at=config.created_at,
        updated_at=config.updated_at,
    )


@router.post("/configs", response_model=StrategyConfigResponse, status_code=201)
async def create_config(
    body: CreateStrategyConfigRequest,
    user: UserInfo = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Create a new strategy configuration."""
    from app.db.models import UserStrategyConfig

    # Check for duplicate name
    result = await db.execute(
        select(UserStrategyConfig).where(
            UserStrategyConfig.user_id == user.user_id,
            UserStrategyConfig.config_name == body.config_name
        )
    )
    existing = result.scalar_one_or_none()

    if existing:
        raise HTTPException(
            status_code=400,
            detail=f"Configuration named '{body.config_name}' already exists"
        )

    # Create config
    config = UserStrategyConfig(
        user_id=user.user_id,
        config_name=body.config_name,
        k_coefficient=body.k_coefficient,
        min_range=body.min_range,
        max_range=body.max_range,
        atr_period_days=body.atr_period_days,
        atr_change_threshold=body.atr_change_threshold,
        max_rebalances_per_day=body.max_rebalances_per_day,
        max_emergency_rebalances=body.max_emergency_rebalances,
        ratio_skew_threshold=body.ratio_skew_threshold,
        ratio_skew_emergency=0.98,  # Fixed for now
        capital_deployment_pct=body.capital_deployment_pct,
        max_sol_per_position=body.max_sol_per_position,
        min_sol_reserve=body.min_sol_reserve,
        stop_loss_enabled=body.stop_loss_enabled,
        stop_loss_pct=body.stop_loss_pct,
        check_interval_seconds=body.check_interval_seconds,
        is_active=True,
    )

    db.add(config)
    await db.commit()
    await db.refresh(config)

    logger.info(
        f"Created strategy config",
        extra={
            "user_id": user.user_id,
            "config_id": config.id,
            "config_name": config.config_name
        }
    )

    return StrategyConfigResponse(
        id=config.id,
        user_id=config.user_id,
        config_name=config.config_name,
        k_coefficient=float(config.k_coefficient),
        min_range=float(config.min_range),
        max_range=float(config.max_range),
        atr_period_days=config.atr_period_days,
        atr_change_threshold=float(config.atr_change_threshold),
        max_rebalances_per_day=config.max_rebalances_per_day,
        max_emergency_rebalances=config.max_emergency_rebalances,
        ratio_skew_threshold=float(config.ratio_skew_threshold),
        capital_deployment_pct=float(config.capital_deployment_pct),
        max_sol_per_position=float(config.max_sol_per_position),
        min_sol_reserve=float(config.min_sol_reserve),
        stop_loss_enabled=config.stop_loss_enabled,
        stop_loss_pct=float(config.stop_loss_pct),
        check_interval_seconds=config.check_interval_seconds,
        is_active=config.is_active,
        created_at=config.created_at,
        updated_at=config.updated_at,
    )


@router.put("/configs/{config_id}", response_model=StrategyConfigResponse)
async def update_config(
    config_id: int,
    body: UpdateStrategyConfigRequest,
    user: UserInfo = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Update an existing strategy configuration."""
    from app.db.models import UserStrategyConfig

    result = await db.execute(
        select(UserStrategyConfig).where(
            UserStrategyConfig.id == config_id,
            UserStrategyConfig.user_id == user.user_id
        )
    )
    config = result.scalar_one_or_none()

    if not config:
        raise HTTPException(status_code=404, detail="Configuration not found")

    # Check for name collision if renaming
    if body.config_name and body.config_name != config.config_name:
        result = await db.execute(
            select(UserStrategyConfig).where(
                UserStrategyConfig.user_id == user.user_id,
                UserStrategyConfig.config_name == body.config_name,
                UserStrategyConfig.id != config_id
            )
        )
        if result.scalar_one_or_none():
            raise HTTPException(
                status_code=400,
                detail=f"Configuration named '{body.config_name}' already exists"
            )

    # Update fields
    update_data = body.model_dump(exclude_unset=True)
    for field, value in update_data.items():
        setattr(config, field, value)

    config.updated_at = datetime.now(timezone.utc)

    await db.commit()
    await db.refresh(config)

    logger.info(
        f"Updated strategy config",
        extra={
            "user_id": user.user_id,
            "config_id": config.id,
            "updates": list(update_data.keys())
        }
    )

    return StrategyConfigResponse(
        id=config.id,
        user_id=config.user_id,
        config_name=config.config_name,
        k_coefficient=float(config.k_coefficient),
        min_range=float(config.min_range),
        max_range=float(config.max_range),
        atr_period_days=config.atr_period_days,
        atr_change_threshold=float(config.atr_change_threshold),
        max_rebalances_per_day=config.max_rebalances_per_day,
        max_emergency_rebalances=config.max_emergency_rebalances,
        ratio_skew_threshold=float(config.ratio_skew_threshold),
        capital_deployment_pct=float(config.capital_deployment_pct),
        max_sol_per_position=float(config.max_sol_per_position),
        min_sol_reserve=float(config.min_sol_reserve),
        stop_loss_enabled=config.stop_loss_enabled,
        stop_loss_pct=float(config.stop_loss_pct),
        check_interval_seconds=config.check_interval_seconds,
        is_active=config.is_active,
        created_at=config.created_at,
        updated_at=config.updated_at,
    )


@router.delete("/configs/{config_id}", status_code=204)
async def delete_config(
    config_id: int,
    user: UserInfo = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Delete a strategy configuration."""
    from app.db.models import UserStrategyConfig, UserStrategySession

    # Check if config exists and belongs to user
    result = await db.execute(
        select(UserStrategyConfig).where(
            UserStrategyConfig.id == config_id,
            UserStrategyConfig.user_id == user.user_id
        )
    )
    config = result.scalar_one_or_none()

    if not config:
        raise HTTPException(status_code=404, detail="Configuration not found")

    # Check if config is in use by any active session
    result = await db.execute(
        select(UserStrategySession).where(
            UserStrategySession.config_id == config_id,
            UserStrategySession.status.in_(["pending", "running", "paused"])
        )
    )
    active_session = result.scalar_one_or_none()

    if active_session:
        raise HTTPException(
            status_code=400,
            detail="Cannot delete configuration that is in use by an active session"
        )

    # Delete config
    await db.execute(
        delete(UserStrategyConfig).where(UserStrategyConfig.id == config_id)
    )
    await db.commit()

    logger.info(
        f"Deleted strategy config",
        extra={"user_id": user.user_id, "config_id": config_id}
    )
