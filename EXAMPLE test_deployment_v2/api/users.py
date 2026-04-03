"""
User management API endpoints.

Provides endpoints for:
- User profile management
- Hot wallet information
- User settings
"""

import logging
from datetime import datetime, timezone
from typing import Optional
from decimal import Decimal

from fastapi import APIRouter, HTTPException, Depends, Request
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from api.auth import get_current_user, UserInfo
from api.dependencies import get_db

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/user", tags=["user"])


# =============================================================================
# REQUEST/RESPONSE MODELS
# =============================================================================

class UserProfile(BaseModel):
    """User profile information."""
    user_id: int
    wallet_pubkey: str = Field(..., description="User's main wallet (authentication)")
    email: Optional[str] = None
    created_at: datetime
    last_login: Optional[datetime] = None
    is_active: bool


class HotWalletInfo(BaseModel):
    """Platform hot wallet information for deposits."""
    wallet_pubkey: str = Field(..., description="Hot wallet address for deposits")
    derivation_index: int
    created_at: datetime
    sol_balance: Optional[Decimal] = Field(None, description="Current SOL balance")
    usdc_balance: Optional[Decimal] = Field(None, description="Current USDC balance")
    backup_confirmed: bool = Field(False, description="Whether user confirmed backup")


class HotWalletCreationResponse(BaseModel):
    """
    Response when creating a new hot wallet.

    IMPORTANT: The private_key is only shown ONCE at creation time.
    User must save it immediately - it will never be shown again.
    """
    wallet_pubkey: str = Field(..., description="Hot wallet address")
    private_key_base58: str = Field(
        ...,
        description="Private key in base58 format. SAVE THIS IMMEDIATELY. It will NOT be shown again."
    )
    derivation_index: int
    created_at: datetime
    warning: str = Field(
        default="CRITICAL: Save this private key NOW. You will NOT be able to retrieve it later. "
                "Anyone with this key has full control of the wallet."
    )


class ConfirmBackupRequest(BaseModel):
    """Request to confirm private key backup."""
    confirmation_text: str = Field(
        ...,
        description="Must be exactly: 'I HAVE SAVED MY PRIVATE KEY'"
    )


class UserProfileWithHotWallet(UserProfile):
    """User profile with hot wallet information."""
    hot_wallet: Optional[HotWalletInfo] = None


class UpdateProfileRequest(BaseModel):
    """Request to update user profile."""
    email: Optional[str] = Field(None, max_length=255)


class UserSettings(BaseModel):
    """User settings/preferences."""
    email_notifications: bool = True
    daily_summary_email: bool = False
    alert_on_rebalance: bool = True
    alert_on_stop_loss: bool = True
    theme: str = "dark"


class UpdateSettingsRequest(BaseModel):
    """Request to update user settings."""
    email_notifications: Optional[bool] = None
    daily_summary_email: Optional[bool] = None
    alert_on_rebalance: Optional[bool] = None
    alert_on_stop_loss: Optional[bool] = None
    theme: Optional[str] = None


# =============================================================================
# API ENDPOINTS
# =============================================================================

@router.get("/profile", response_model=UserProfileWithHotWallet)
async def get_profile(
    user: UserInfo = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)  # Injected by app
):
    """Get current user's profile including hot wallet information."""
    from app.db.models import User, UserHotWallet

    # Get user
    result = await db.execute(
        select(User).where(User.id == user.user_id)
    )
    db_user = result.scalar_one_or_none()

    if not db_user:
        raise HTTPException(status_code=404, detail="User not found")

    # Get hot wallet if exists
    result = await db.execute(
        select(UserHotWallet).where(UserHotWallet.user_id == user.user_id)
    )
    hot_wallet = result.scalar_one_or_none()

    hot_wallet_info = None
    if hot_wallet:
        # TODO: Fetch actual balances from chain
        hot_wallet_info = HotWalletInfo(
            wallet_pubkey=hot_wallet.wallet_pubkey,
            derivation_index=hot_wallet.derivation_index,
            created_at=hot_wallet.created_at,
            sol_balance=None,  # Will be populated later
            usdc_balance=None,
            backup_confirmed=hot_wallet.key_backup_confirmed_at is not None,
        )

    return UserProfileWithHotWallet(
        user_id=db_user.id,
        wallet_pubkey=db_user.wallet_pubkey,
        email=db_user.email,
        created_at=db_user.created_at,
        last_login=db_user.last_login,
        is_active=db_user.is_active,
        hot_wallet=hot_wallet_info,
    )


@router.put("/profile", response_model=UserProfile)
async def update_profile(
    body: UpdateProfileRequest,
    user: UserInfo = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Update current user's profile."""
    from app.db.models import User

    result = await db.execute(
        select(User).where(User.id == user.user_id)
    )
    db_user = result.scalar_one_or_none()

    if not db_user:
        raise HTTPException(status_code=404, detail="User not found")

    # Update fields
    if body.email is not None:
        db_user.email = body.email

    await db.commit()
    await db.refresh(db_user)

    logger.info(f"User {user.user_id} updated profile")

    return UserProfile(
        user_id=db_user.id,
        wallet_pubkey=db_user.wallet_pubkey,
        email=db_user.email,
        created_at=db_user.created_at,
        last_login=db_user.last_login,
        is_active=db_user.is_active,
    )


@router.get("/settings", response_model=UserSettings)
async def get_settings(
    user: UserInfo = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Get current user's settings."""
    from app.db.models import User

    result = await db.execute(
        select(User).where(User.id == user.user_id)
    )
    db_user = result.scalar_one_or_none()

    if not db_user:
        raise HTTPException(status_code=404, detail="User not found")

    # Parse settings from JSONB with defaults
    settings = db_user.settings or {}

    return UserSettings(
        email_notifications=settings.get("email_notifications", True),
        daily_summary_email=settings.get("daily_summary_email", False),
        alert_on_rebalance=settings.get("alert_on_rebalance", True),
        alert_on_stop_loss=settings.get("alert_on_stop_loss", True),
        theme=settings.get("theme", "dark"),
    )


@router.put("/settings", response_model=UserSettings)
async def update_settings(
    body: UpdateSettingsRequest,
    user: UserInfo = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Update current user's settings."""
    from app.db.models import User

    result = await db.execute(
        select(User).where(User.id == user.user_id)
    )
    db_user = result.scalar_one_or_none()

    if not db_user:
        raise HTTPException(status_code=404, detail="User not found")

    # Merge updates into existing settings
    settings = db_user.settings or {}

    if body.email_notifications is not None:
        settings["email_notifications"] = body.email_notifications
    if body.daily_summary_email is not None:
        settings["daily_summary_email"] = body.daily_summary_email
    if body.alert_on_rebalance is not None:
        settings["alert_on_rebalance"] = body.alert_on_rebalance
    if body.alert_on_stop_loss is not None:
        settings["alert_on_stop_loss"] = body.alert_on_stop_loss
    if body.theme is not None:
        settings["theme"] = body.theme

    db_user.settings = settings
    await db.commit()

    logger.info(f"User {user.user_id} updated settings")

    return UserSettings(**settings)


@router.post("/hot-wallet")
async def create_hot_wallet(
    user: UserInfo = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Create a hot wallet for the user if they don't have one.

    **IMPORTANT**: On first creation, this returns the private key ONCE.
    The user MUST save it immediately - it will never be shown again.

    If the wallet already exists, only returns public information.

    Returns:
        - HotWalletCreationResponse (with private key) on NEW wallet creation
        - HotWalletInfo (without private key) if wallet already exists
    """
    from app.db.models import UserHotWallet
    from user_context import get_context_manager, decrypt_private_key
    import base58

    # Check if hot wallet already exists
    result = await db.execute(
        select(UserHotWallet).where(UserHotWallet.user_id == user.user_id)
    )
    existing = result.scalar_one_or_none()

    if existing:
        # Wallet exists - DO NOT return private key
        return HotWalletInfo(
            wallet_pubkey=existing.wallet_pubkey,
            derivation_index=existing.derivation_index,
            created_at=existing.created_at,
            backup_confirmed=existing.key_backup_confirmed_at is not None,
        )

    # Create hot wallet via context manager
    ctx_manager = get_context_manager()
    context = await ctx_manager.get_or_create(user.user_id, db)

    # Get the newly created hot wallet
    result = await db.execute(
        select(UserHotWallet).where(UserHotWallet.user_id == user.user_id)
    )
    hot_wallet = result.scalar_one()

    # Decrypt private key for ONE-TIME display
    private_key_bytes = decrypt_private_key(hot_wallet.encrypted_private_key)
    private_key_base58 = base58.b58encode(private_key_bytes).decode('utf-8')

    logger.info(
        f"Created hot wallet for user {user.user_id} - PRIVATE KEY REVEALED ONCE",
        extra={"hot_wallet_pubkey": hot_wallet.wallet_pubkey}
    )

    # Return with private key - THIS IS THE ONLY TIME IT WILL BE SHOWN
    return HotWalletCreationResponse(
        wallet_pubkey=hot_wallet.wallet_pubkey,
        private_key_base58=private_key_base58,
        derivation_index=hot_wallet.derivation_index,
        created_at=hot_wallet.created_at,
    )


@router.get("/hot-wallet/balance")
async def get_hot_wallet_balance(
    user: UserInfo = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Get current balance of user's hot wallet."""
    from app.db.models import UserHotWallet

    result = await db.execute(
        select(UserHotWallet).where(UserHotWallet.user_id == user.user_id)
    )
    hot_wallet = result.scalar_one_or_none()

    if not hot_wallet:
        raise HTTPException(
            status_code=404,
            detail="Hot wallet not found. Create one first."
        )

    # TODO: Fetch actual balances from Solana RPC
    # This would use the SolanaClient to get token balances

    return {
        "wallet_pubkey": hot_wallet.wallet_pubkey,
        "sol_balance": "0",  # Placeholder
        "usdc_balance": "0",  # Placeholder
        "last_updated": datetime.now(timezone.utc).isoformat(),
    }


@router.post("/hot-wallet/confirm-backup")
async def confirm_hot_wallet_backup(
    body: ConfirmBackupRequest,
    user: UserInfo = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Confirm that user has backed up their hot wallet private key.

    This must be called after creating a hot wallet to acknowledge
    that the private key has been safely stored.

    The confirmation_text must be exactly: "I HAVE SAVED MY PRIVATE KEY"
    """
    from app.db.models import UserHotWallet

    # Verify confirmation text
    expected = "I HAVE SAVED MY PRIVATE KEY"
    if body.confirmation_text != expected:
        raise HTTPException(
            status_code=400,
            detail=f"Confirmation text must be exactly: '{expected}'"
        )

    # Get hot wallet
    result = await db.execute(
        select(UserHotWallet).where(UserHotWallet.user_id == user.user_id)
    )
    hot_wallet = result.scalar_one_or_none()

    if not hot_wallet:
        raise HTTPException(
            status_code=404,
            detail="Hot wallet not found. Create one first."
        )

    if hot_wallet.key_backup_confirmed_at:
        return {
            "status": "already_confirmed",
            "message": "Backup was already confirmed",
            "confirmed_at": hot_wallet.key_backup_confirmed_at.isoformat(),
        }

    # Mark backup as confirmed
    hot_wallet.key_backup_confirmed_at = datetime.now(timezone.utc)
    await db.commit()

    logger.info(
        f"User {user.user_id} confirmed hot wallet backup",
        extra={"hot_wallet_pubkey": hot_wallet.wallet_pubkey}
    )

    return {
        "status": "confirmed",
        "message": "Private key backup confirmed. You can now deposit funds to your hot wallet.",
        "confirmed_at": hot_wallet.key_backup_confirmed_at.isoformat(),
    }


@router.get("/hot-wallet/backup-status")
async def get_backup_status(
    user: UserInfo = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Check if user has confirmed their hot wallet backup."""
    from app.db.models import UserHotWallet

    result = await db.execute(
        select(UserHotWallet).where(UserHotWallet.user_id == user.user_id)
    )
    hot_wallet = result.scalar_one_or_none()

    if not hot_wallet:
        return {
            "has_hot_wallet": False,
            "backup_confirmed": False,
        }

    return {
        "has_hot_wallet": True,
        "wallet_pubkey": hot_wallet.wallet_pubkey,
        "backup_confirmed": hot_wallet.key_backup_confirmed_at is not None,
        "confirmed_at": hot_wallet.key_backup_confirmed_at.isoformat() if hot_wallet.key_backup_confirmed_at else None,
    }
