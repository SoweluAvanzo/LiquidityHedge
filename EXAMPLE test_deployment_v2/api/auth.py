"""
Authentication module implementing Sign In With Solana (SIWS).

Provides:
- Nonce generation for signature challenges
- Signature verification using Ed25519
- JWT token generation and validation
- Authentication dependencies for FastAPI
"""

import os
import secrets
import logging
from datetime import datetime, timedelta, timezone
from typing import Optional, Annotated

from fastapi import APIRouter, HTTPException, Depends, Request, Response
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic import BaseModel, Field
from jose import jwt, JWTError

from solders.pubkey import Pubkey
from solders.signature import Signature
import nacl.signing
import base58

from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, delete

from api.dependencies import get_db

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/auth", tags=["authentication"])


# =============================================================================
# CONFIGURATION
# =============================================================================

def get_jwt_secret() -> str:
    """Get JWT secret key from environment."""
    secret = os.getenv("JWT_SECRET_KEY")
    if not secret:
        raise ValueError("JWT_SECRET_KEY environment variable is required")
    return secret


def get_jwt_algorithm() -> str:
    """Get JWT algorithm."""
    return os.getenv("JWT_ALGORITHM", "HS256")


def get_token_expiry_hours() -> int:
    """Get token expiry in hours."""
    return int(os.getenv("JWT_EXPIRY_HOURS", "24"))


def get_nonce_expiry_minutes() -> int:
    """Get nonce expiry in minutes."""
    return int(os.getenv("NONCE_EXPIRY_MINUTES", "5"))


# =============================================================================
# REQUEST/RESPONSE MODELS
# =============================================================================

class NonceRequest(BaseModel):
    """Request for authentication nonce."""
    wallet_pubkey: str = Field(
        ...,
        description="Solana wallet public key (base58 encoded)",
        min_length=32,
        max_length=50
    )


class NonceResponse(BaseModel):
    """Response containing authentication nonce."""
    nonce: str = Field(..., description="Random nonce for signing")
    message: str = Field(..., description="Full message to sign")
    expires_at: datetime = Field(..., description="Nonce expiration time")


class VerifyRequest(BaseModel):
    """Request to verify signed message."""
    wallet_pubkey: str = Field(..., description="Solana wallet public key")
    signature: str = Field(..., description="Ed25519 signature (base58 encoded)")
    nonce: str = Field(..., description="The nonce that was signed")


class VerifyResponse(BaseModel):
    """Response containing JWT token."""
    access_token: str = Field(..., description="JWT access token")
    token_type: str = Field(default="bearer", description="Token type")
    expires_at: datetime = Field(..., description="Token expiration time")
    user_id: int = Field(..., description="User ID")
    wallet_pubkey: str = Field(..., description="Wallet public key")
    hot_wallet_pubkey: Optional[str] = Field(
        None, description="Platform hot wallet address for deposits"
    )


class UserInfo(BaseModel):
    """Current user information from JWT."""
    user_id: int
    wallet_pubkey: str


class LogoutResponse(BaseModel):
    """Response for logout."""
    success: bool = True
    message: str = "Successfully logged out"


# =============================================================================
# NONCE MANAGEMENT
# =============================================================================

def generate_nonce() -> str:
    """Generate a cryptographically secure random nonce."""
    return secrets.token_hex(32)  # 64 character hex string


def create_sign_message(wallet_pubkey: str, nonce: str) -> str:
    """
    Create the message that the user must sign.

    This follows the SIWS standard message format.
    """
    return (
        f"Sign in to LP Strategy Platform\n"
        f"\n"
        f"Wallet: {wallet_pubkey}\n"
        f"Nonce: {nonce}\n"
        f"\n"
        f"This signature proves you own this wallet.\n"
        f"It does not authorize any transactions."
    )


async def store_nonce(
    wallet_pubkey: str,
    nonce: str,
    db: AsyncSession
) -> datetime:
    """Store nonce in database with expiration time."""
    from app.db.models import AuthNonce

    expires_at = datetime.now(timezone.utc) + timedelta(
        minutes=get_nonce_expiry_minutes()
    )

    # Delete any existing unused nonces for this wallet
    await db.execute(
        delete(AuthNonce).where(
            AuthNonce.wallet_pubkey == wallet_pubkey,
            AuthNonce.used == False
        )
    )

    # Create new nonce
    auth_nonce = AuthNonce(
        wallet_pubkey=wallet_pubkey,
        nonce=nonce,
        expires_at=expires_at,
        used=False
    )
    db.add(auth_nonce)
    await db.commit()

    return expires_at


async def verify_and_consume_nonce(
    wallet_pubkey: str,
    nonce: str,
    db: AsyncSession
) -> bool:
    """
    Verify nonce exists, is not expired, not used, and mark as used.

    Returns True if valid, raises HTTPException otherwise.
    """
    from app.db.models import AuthNonce

    result = await db.execute(
        select(AuthNonce).where(
            AuthNonce.wallet_pubkey == wallet_pubkey,
            AuthNonce.nonce == nonce,
            AuthNonce.used == False
        )
    )
    auth_nonce = result.scalar_one_or_none()

    if not auth_nonce:
        raise HTTPException(
            status_code=400,
            detail="Invalid or already used nonce"
        )

    if auth_nonce.expires_at < datetime.now(timezone.utc):
        raise HTTPException(
            status_code=400,
            detail="Nonce has expired"
        )

    # Mark as used
    auth_nonce.used = True
    await db.commit()

    return True


# =============================================================================
# SIGNATURE VERIFICATION
# =============================================================================

def verify_solana_signature(
    wallet_pubkey: str,
    message: str,
    signature: str
) -> bool:
    """
    Verify an Ed25519 signature from a Solana wallet.

    Args:
        wallet_pubkey: Base58 encoded public key
        message: The message that was signed
        signature: Base58 encoded signature

    Returns:
        True if signature is valid, False otherwise
    """
    try:
        # Decode public key
        pubkey_bytes = base58.b58decode(wallet_pubkey)

        # Decode signature
        signature_bytes = base58.b58decode(signature)

        # Message as bytes
        message_bytes = message.encode('utf-8')

        # Create verify key from public key
        verify_key = nacl.signing.VerifyKey(pubkey_bytes)

        # Verify signature
        verify_key.verify(message_bytes, signature_bytes)

        return True

    except Exception as e:
        logger.warning(
            f"Signature verification failed: {e}",
            extra={"wallet_pubkey": wallet_pubkey}
        )
        return False


# =============================================================================
# JWT TOKEN MANAGEMENT
# =============================================================================

def create_access_token(user_id: int, wallet_pubkey: str) -> tuple[str, datetime]:
    """
    Create a JWT access token for authenticated user.

    Returns tuple of (token, expires_at).
    """
    expires_at = datetime.now(timezone.utc) + timedelta(
        hours=get_token_expiry_hours()
    )

    payload = {
        "sub": str(user_id),  # Subject (user ID)
        "wallet": wallet_pubkey,
        "exp": expires_at,
        "iat": datetime.now(timezone.utc),
        "type": "access"
    }

    token = jwt.encode(
        payload,
        get_jwt_secret(),
        algorithm=get_jwt_algorithm()
    )

    return token, expires_at


def decode_token(token: str) -> dict:
    """
    Decode and validate a JWT token.

    Raises HTTPException if token is invalid or expired.
    """
    try:
        payload = jwt.decode(
            token,
            get_jwt_secret(),
            algorithms=[get_jwt_algorithm()]
        )
        return payload

    except jwt.ExpiredSignatureError:
        raise HTTPException(
            status_code=401,
            detail="Token has expired"
        )
    except JWTError as e:
        raise HTTPException(
            status_code=401,
            detail=f"Invalid token: {e}"
        )


# =============================================================================
# AUTHENTICATION DEPENDENCIES
# =============================================================================

# Security scheme for OpenAPI docs
security = HTTPBearer()


async def get_current_user(
    credentials: Annotated[HTTPAuthorizationCredentials, Depends(security)],
    db: AsyncSession = Depends(get_db)  # Will be injected from app dependency
) -> UserInfo:
    """
    Dependency to get current authenticated user from JWT.

    Usage:
        @app.get("/protected")
        async def protected_route(user: UserInfo = Depends(get_current_user)):
            return {"user_id": user.user_id}
    """
    token = credentials.credentials
    payload = decode_token(token)

    return UserInfo(
        user_id=int(payload["sub"]),
        wallet_pubkey=payload["wallet"]
    )


def get_current_user_optional(request: Request) -> Optional[UserInfo]:
    """
    Optional authentication dependency.

    Returns user info if valid token present, None otherwise.
    """
    auth_header = request.headers.get("Authorization")
    if not auth_header or not auth_header.startswith("Bearer "):
        return None

    token = auth_header.split(" ")[1]
    try:
        payload = decode_token(token)
        return UserInfo(
            user_id=int(payload["sub"]),
            wallet_pubkey=payload["wallet"]
        )
    except HTTPException:
        return None


# =============================================================================
# USER MANAGEMENT
# =============================================================================

async def get_or_create_user(
    wallet_pubkey: str,
    db: AsyncSession
) -> tuple[int, Optional[str]]:
    """
    Get existing user or create new one.

    Returns tuple of (user_id, hot_wallet_pubkey or None for new users).
    """
    from app.db.models import User, UserHotWallet

    # Try to find existing user
    result = await db.execute(
        select(User).where(User.wallet_pubkey == wallet_pubkey)
    )
    user = result.scalar_one_or_none()

    if user:
        # Update last login
        user.last_login = datetime.now(timezone.utc)
        await db.commit()

        # Get hot wallet if exists
        result = await db.execute(
            select(UserHotWallet).where(UserHotWallet.user_id == user.id)
        )
        hot_wallet = result.scalar_one_or_none()

        hot_wallet_pubkey = hot_wallet.wallet_pubkey if hot_wallet else None

        return user.id, hot_wallet_pubkey

    # Create new user
    user = User(
        wallet_pubkey=wallet_pubkey,
        last_login=datetime.now(timezone.utc),
        is_active=True,
        settings={}
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)

    logger.info(
        f"Created new user",
        extra={"user_id": user.id, "wallet_pubkey": wallet_pubkey}
    )

    # New users don't have hot wallet yet - it's created on first session start
    return user.id, None


# =============================================================================
# AUDIT LOGGING
# =============================================================================

async def log_auth_event(
    action: str,
    user_id: Optional[int],
    request: Request,
    db: AsyncSession,
    success: bool = True,
    error_message: Optional[str] = None,
    details: Optional[dict] = None
):
    """Log authentication events for security auditing."""
    from app.db.models import AuditLog

    audit_log = AuditLog(
        user_id=user_id,
        action=action,
        resource_type="auth",
        ip_address=request.client.host if request.client else None,
        user_agent=request.headers.get("User-Agent", "")[:500],
        success=success,
        error_message=error_message,
        details=details or {}
    )
    db.add(audit_log)
    await db.commit()


# =============================================================================
# API ENDPOINTS
# =============================================================================

@router.post("/nonce", response_model=NonceResponse)
async def request_nonce(
    request: Request,
    body: NonceRequest,
    db: AsyncSession = Depends(get_db)  # Will be injected
):
    """
    Request a nonce for SIWS authentication.

    The nonce must be signed by the wallet to prove ownership.
    Nonces expire after a short time and can only be used once.
    """
    # Validate wallet address format
    try:
        Pubkey.from_string(body.wallet_pubkey)
    except Exception:
        raise HTTPException(
            status_code=400,
            detail="Invalid wallet public key format"
        )

    # Generate and store nonce
    nonce = generate_nonce()
    expires_at = await store_nonce(body.wallet_pubkey, nonce, db)

    # Create message to sign
    message = create_sign_message(body.wallet_pubkey, nonce)

    return NonceResponse(
        nonce=nonce,
        message=message,
        expires_at=expires_at
    )


@router.post("/verify", response_model=VerifyResponse)
async def verify_signature(
    request: Request,
    body: VerifyRequest,
    db: AsyncSession = Depends(get_db)  # Will be injected
):
    """
    Verify signed message and issue JWT token.

    The user must sign the message returned by /auth/nonce endpoint
    using their Solana wallet.
    """
    # Validate wallet address
    try:
        Pubkey.from_string(body.wallet_pubkey)
    except Exception:
        raise HTTPException(
            status_code=400,
            detail="Invalid wallet public key format"
        )

    # Verify and consume nonce
    await verify_and_consume_nonce(body.wallet_pubkey, body.nonce, db)

    # Recreate message that should have been signed
    message = create_sign_message(body.wallet_pubkey, body.nonce)

    # Verify signature
    if not verify_solana_signature(body.wallet_pubkey, message, body.signature):
        await log_auth_event(
            action="login_failed",
            user_id=None,
            request=request,
            db=db,
            success=False,
            error_message="Invalid signature",
            details={"wallet_pubkey": body.wallet_pubkey}
        )
        raise HTTPException(
            status_code=401,
            detail="Invalid signature"
        )

    # Get or create user
    user_id, hot_wallet_pubkey = await get_or_create_user(body.wallet_pubkey, db)

    # Create JWT token
    access_token, expires_at = create_access_token(user_id, body.wallet_pubkey)

    # Log successful login
    await log_auth_event(
        action="login_success",
        user_id=user_id,
        request=request,
        db=db,
        success=True,
        details={"wallet_pubkey": body.wallet_pubkey}
    )

    logger.info(
        f"User authenticated",
        extra={
            "user_id": user_id,
            "wallet_pubkey": body.wallet_pubkey
        }
    )

    return VerifyResponse(
        access_token=access_token,
        token_type="bearer",
        expires_at=expires_at,
        user_id=user_id,
        wallet_pubkey=body.wallet_pubkey,
        hot_wallet_pubkey=hot_wallet_pubkey
    )


@router.post("/logout", response_model=LogoutResponse)
async def logout(
    request: Request,
    user: UserInfo = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)  # Will be injected
):
    """
    Log out the current user.

    Note: JWT tokens are stateless, so this endpoint mainly serves
    for audit logging purposes. The client should discard the token.
    """
    await log_auth_event(
        action="logout",
        user_id=user.user_id,
        request=request,
        db=db,
        success=True,
        details={"wallet_pubkey": user.wallet_pubkey}
    )

    return LogoutResponse()


@router.get("/me", response_model=UserInfo)
async def get_me(
    user: UserInfo = Depends(get_current_user)
):
    """Get current authenticated user information."""
    return user
