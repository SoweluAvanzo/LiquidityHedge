"""
User context management for multi-user LP strategy platform.

Provides isolated execution contexts for each user, including:
- Per-user configuration instances
- Per-user wallet management (HD wallet derivation)
- Per-user session and data isolation
- Encryption for sensitive data at rest
"""

import os
import secrets
import hashlib
import logging
from dataclasses import dataclass, field
from typing import Dict, Optional, TYPE_CHECKING
from datetime import datetime

from cryptography.fernet import Fernet
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
import base64

from solders.keypair import Keypair
from solders.pubkey import Pubkey
import base58

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession
    from app.db.models import User, UserHotWallet, UserStrategyConfig as DBUserStrategyConfig

from config import Config, RangeConfig, ATRConfig, RebalanceConfig, StopLossConfig, CapitalConfig, SessionConfig


logger = logging.getLogger(__name__)


# =============================================================================
# ENCRYPTION UTILITIES
# =============================================================================

def get_encryption_key() -> bytes:
    """
    Get or derive the master encryption key.

    The key is derived from ENCRYPTION_MASTER_KEY environment variable.
    This key should be a 32-byte random string set as a Fly.io secret.
    """
    master_key = os.getenv('ENCRYPTION_MASTER_KEY')
    if not master_key:
        raise ValueError("ENCRYPTION_MASTER_KEY environment variable is required")

    # Derive a Fernet key from the master key using PBKDF2
    salt = b'lp_strategy_multiuser_v1'  # Static salt for consistency
    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=32,
        salt=salt,
        iterations=100000,
    )
    key = base64.urlsafe_b64encode(kdf.derive(master_key.encode()))
    return key


def encrypt_private_key(private_key_bytes: bytes) -> str:
    """Encrypt a private key for storage."""
    fernet = Fernet(get_encryption_key())
    encrypted = fernet.encrypt(private_key_bytes)
    return base64.b64encode(encrypted).decode('utf-8')


def decrypt_private_key(encrypted_key: str) -> bytes:
    """Decrypt a private key from storage."""
    fernet = Fernet(get_encryption_key())
    encrypted_bytes = base64.b64decode(encrypted_key.encode('utf-8'))
    return fernet.decrypt(encrypted_bytes)


# =============================================================================
# HD WALLET DERIVATION
# =============================================================================

def get_master_seed() -> bytes:
    """
    Get the master seed for HD wallet derivation.

    The seed is derived from HD_WALLET_MASTER_SEED environment variable.
    This should be a 64-byte (512-bit) seed from a BIP-39 mnemonic.
    """
    seed_hex = os.getenv('HD_WALLET_MASTER_SEED')
    if not seed_hex:
        raise ValueError("HD_WALLET_MASTER_SEED environment variable is required")

    return bytes.fromhex(seed_hex)


def derive_user_keypair(derivation_index: int) -> Keypair:
    """
    Derive a user's hot wallet keypair from the master seed.

    Uses a simplified derivation scheme based on HMAC-SHA512.
    For production, consider using proper BIP-44 derivation.

    Path: m/44'/501'/account'/0' (conceptually)
    Where account = derivation_index

    Args:
        derivation_index: Unique index for this user's wallet

    Returns:
        Keypair: Derived Solana keypair
    """
    master_seed = get_master_seed()

    # Derive child key using HMAC-SHA512
    # This creates a deterministic but unique key per index
    derivation_data = f"lp_platform:user:{derivation_index}".encode()

    # Use HMAC-SHA512 to derive key material
    import hmac
    derived = hmac.new(master_seed, derivation_data, hashlib.sha512).digest()

    # Use first 32 bytes as the private key seed
    private_key_seed = derived[:32]

    # Create keypair from the seed
    keypair = Keypair.from_seed(private_key_seed)

    return keypair


# =============================================================================
# USER CONFIGURATION
# =============================================================================

@dataclass
class UserConfig:
    """
    User-specific configuration that overrides default Config values.

    Maps database UserStrategyConfig fields to the Config dataclass structure.
    """
    # User identification
    user_id: int
    config_id: int
    config_name: str = "default"

    # Range parameters
    k_coefficient: float = 0.60
    min_range: float = 0.03
    max_range: float = 0.07

    # ATR parameters
    atr_period_days: int = 14
    atr_change_threshold: float = 0.15

    # Rebalance parameters
    max_rebalances_per_day: int = 2
    max_emergency_rebalances: int = 4
    ratio_skew_threshold: float = 0.90
    ratio_skew_emergency: float = 0.98

    # Capital parameters
    capital_deployment_pct: float = 0.80
    max_sol_per_position: float = 1.0
    min_sol_reserve: float = 0.05

    # Stop loss parameters
    stop_loss_enabled: bool = False
    stop_loss_pct: float = 0.10

    # Timing parameters
    check_interval_seconds: int = 30

    @classmethod
    def from_db_config(cls, db_config: "DBUserStrategyConfig") -> "UserConfig":
        """Create UserConfig from database model."""
        return cls(
            user_id=db_config.user_id,
            config_id=db_config.id,
            config_name=db_config.config_name,
            k_coefficient=float(db_config.k_coefficient),
            min_range=float(db_config.min_range),
            max_range=float(db_config.max_range),
            atr_period_days=db_config.atr_period_days,
            atr_change_threshold=float(db_config.atr_change_threshold),
            max_rebalances_per_day=db_config.max_rebalances_per_day,
            max_emergency_rebalances=db_config.max_emergency_rebalances,
            ratio_skew_threshold=float(db_config.ratio_skew_threshold),
            ratio_skew_emergency=float(db_config.ratio_skew_emergency),
            capital_deployment_pct=float(db_config.capital_deployment_pct),
            max_sol_per_position=float(db_config.max_sol_per_position),
            min_sol_reserve=float(db_config.min_sol_reserve),
            stop_loss_enabled=db_config.stop_loss_enabled,
            stop_loss_pct=float(db_config.stop_loss_pct),
            check_interval_seconds=db_config.check_interval_seconds,
        )

    def to_config(self) -> Config:
        """
        Create a full Config instance with user overrides applied.

        Starts with default Config (which reads from env vars) and
        overrides user-configurable parameters.
        """
        config = Config()

        # Apply user overrides to range config
        config.range.k_coefficient = self.k_coefficient
        config.range.min_range = self.min_range
        config.range.max_range = self.max_range

        # Apply user overrides to ATR config
        config.atr.period_days = self.atr_period_days
        config.atr.change_threshold = self.atr_change_threshold

        # Apply user overrides to rebalance config
        config.rebalance.max_rebalances_per_day = self.max_rebalances_per_day
        # Map threshold to high/low
        config.rebalance.ratio_skew_high = self.ratio_skew_threshold
        config.rebalance.ratio_skew_low = 1.0 - self.ratio_skew_threshold

        # Apply user overrides to capital config
        config.capital.deployment_pct = self.capital_deployment_pct
        config.capital.max_sol_per_position = self.max_sol_per_position
        config.capital.min_sol_reserve = self.min_sol_reserve

        # Apply user overrides to stop loss config
        config.stop_loss.enabled = self.stop_loss_enabled
        # Map stop_loss_pct to price_decline_threshold
        config.stop_loss.price_decline_threshold = self.stop_loss_pct

        # Apply user overrides to session config
        config.session.check_interval_seconds = self.check_interval_seconds

        return config


# =============================================================================
# USER CONTEXT
# =============================================================================

@dataclass
class UserContext:
    """
    Isolated execution context for a single user.

    Contains all user-specific instances needed for strategy execution:
    - User identification
    - Hot wallet keypair for transactions
    - User-specific configuration
    - Session ID for tracking
    - Data directory for CSV output

    All strategy execution components should accept a UserContext
    instead of relying on global singletons.
    """
    # User identification
    user_id: int
    wallet_pubkey: str  # User's main wallet (for authentication)

    # Hot wallet for strategy execution
    hot_wallet_keypair: Keypair
    hot_wallet_pubkey: str

    # Configuration
    user_config: UserConfig
    config: Config  # Full config with user overrides

    # Session tracking
    session_id: Optional[int] = None

    # Data directory for this user
    data_dir: str = field(default="")

    def __post_init__(self):
        """Set up user-specific data directory."""
        if not self.data_dir:
            base_dir = os.getenv('DATA_DIR', '/data')
            self.data_dir = os.path.join(base_dir, 'users', str(self.user_id))

        # Ensure directory exists
        os.makedirs(self.data_dir, exist_ok=True)

    @property
    def hot_wallet_base58(self) -> str:
        """Get hot wallet private key as base58 (for API/SDK compatibility)."""
        return base58.b58encode(bytes(self.hot_wallet_keypair)).decode('utf-8')

    def get_csv_path(self, filename: str) -> str:
        """Get full path for a CSV file in user's data directory."""
        return os.path.join(self.data_dir, filename)


# =============================================================================
# USER CONTEXT MANAGER
# =============================================================================

class UserContextManager:
    """
    Manages UserContext instances for multi-user execution.

    Handles:
    - Loading user data from database
    - Creating/deriving hot wallets
    - Caching active contexts
    - Context cleanup on session end
    """

    def __init__(self):
        self._contexts: Dict[int, UserContext] = {}
        self._lock = None  # Will be asyncio.Lock() when needed

    async def get_or_create(
        self,
        user_id: int,
        db_session: "AsyncSession",
        config_id: Optional[int] = None
    ) -> UserContext:
        """
        Get or create an isolated context for a user.

        Args:
            user_id: The user's database ID
            db_session: Database session for loading user data
            config_id: Optional specific config to use (otherwise uses active config)

        Returns:
            UserContext: Isolated context for the user
        """
        # Import here to avoid circular imports
        from sqlalchemy import select
        from app.db.models import User, UserHotWallet, UserStrategyConfig

        # Check cache first
        if user_id in self._contexts:
            context = self._contexts[user_id]
            # Update config if specified
            if config_id and context.user_config.config_id != config_id:
                context = await self._update_context_config(context, config_id, db_session)
            return context

        # Load user from database
        result = await db_session.execute(
            select(User).where(User.id == user_id)
        )
        user = result.scalar_one_or_none()
        if not user:
            raise ValueError(f"User {user_id} not found")

        if not user.is_active:
            raise ValueError(f"User {user_id} is not active")

        # Load or create hot wallet
        hot_wallet = await self._get_or_create_hot_wallet(user_id, db_session)

        # Decrypt and recreate keypair
        private_key_bytes = decrypt_private_key(hot_wallet.encrypted_private_key)
        hot_wallet_keypair = Keypair.from_bytes(private_key_bytes)

        # Load user config
        user_config = await self._load_user_config(user_id, config_id, db_session)

        # Create full config with overrides
        config = user_config.to_config()

        # Create context
        context = UserContext(
            user_id=user_id,
            wallet_pubkey=user.wallet_pubkey,
            hot_wallet_keypair=hot_wallet_keypair,
            hot_wallet_pubkey=hot_wallet.wallet_pubkey,
            user_config=user_config,
            config=config,
        )

        # Cache context
        self._contexts[user_id] = context

        logger.info(
            f"Created context for user {user_id}",
            extra={
                "user_id": user_id,
                "wallet_pubkey": user.wallet_pubkey,
                "hot_wallet_pubkey": hot_wallet.wallet_pubkey,
                "config_name": user_config.config_name,
            }
        )

        return context

    async def _get_or_create_hot_wallet(
        self,
        user_id: int,
        db_session: "AsyncSession"
    ) -> "UserHotWallet":
        """Get existing hot wallet or create new one for user."""
        from sqlalchemy import select, func
        from app.db.models import UserHotWallet

        # Check for existing hot wallet
        result = await db_session.execute(
            select(UserHotWallet).where(UserHotWallet.user_id == user_id)
        )
        hot_wallet = result.scalar_one_or_none()

        if hot_wallet:
            return hot_wallet

        # Get next derivation index
        max_index_result = await db_session.execute(
            select(func.max(UserHotWallet.derivation_index))
        )
        max_index = max_index_result.scalar()
        if max_index is None:
            max_index = -1
        derivation_index = max_index + 1

        # Derive keypair
        keypair = derive_user_keypair(derivation_index)

        # Encrypt private key
        encrypted_key = encrypt_private_key(bytes(keypair))

        # Create hot wallet record
        hot_wallet = UserHotWallet(
            user_id=user_id,
            wallet_pubkey=str(keypair.pubkey()),
            encrypted_private_key=encrypted_key,
            derivation_index=derivation_index,
        )

        db_session.add(hot_wallet)
        await db_session.commit()
        await db_session.refresh(hot_wallet)

        logger.info(
            f"Created hot wallet for user {user_id}",
            extra={
                "user_id": user_id,
                "hot_wallet_pubkey": str(keypair.pubkey()),
                "derivation_index": derivation_index,
            }
        )

        return hot_wallet

    async def _load_user_config(
        self,
        user_id: int,
        config_id: Optional[int],
        db_session: "AsyncSession"
    ) -> UserConfig:
        """Load user configuration from database."""
        from sqlalchemy import select
        from app.db.models import UserStrategyConfig

        if config_id:
            # Load specific config
            result = await db_session.execute(
                select(UserStrategyConfig).where(
                    UserStrategyConfig.id == config_id,
                    UserStrategyConfig.user_id == user_id
                )
            )
        else:
            # Load active config (most recent active)
            result = await db_session.execute(
                select(UserStrategyConfig)
                .where(
                    UserStrategyConfig.user_id == user_id,
                    UserStrategyConfig.is_active == True
                )
                .order_by(UserStrategyConfig.created_at.desc())
                .limit(1)
            )

        db_config = result.scalar_one_or_none()

        if not db_config:
            # Create default config for user
            db_config = UserStrategyConfig(
                user_id=user_id,
                config_name="default",
            )
            db_session.add(db_config)
            await db_session.commit()
            await db_session.refresh(db_config)

            logger.info(f"Created default config for user {user_id}")

        return UserConfig.from_db_config(db_config)

    async def _update_context_config(
        self,
        context: UserContext,
        config_id: int,
        db_session: "AsyncSession"
    ) -> UserContext:
        """Update context with new configuration."""
        user_config = await self._load_user_config(context.user_id, config_id, db_session)
        config = user_config.to_config()

        context.user_config = user_config
        context.config = config

        return context

    def get_context(self, user_id: int) -> Optional[UserContext]:
        """Get cached context for user (if exists)."""
        return self._contexts.get(user_id)

    def remove_context(self, user_id: int) -> None:
        """Remove user context from cache (e.g., on session end)."""
        if user_id in self._contexts:
            del self._contexts[user_id]
            logger.info(f"Removed context for user {user_id}")

    def clear_all(self) -> None:
        """Clear all cached contexts."""
        self._contexts.clear()
        logger.info("Cleared all user contexts")

    @property
    def active_users(self) -> list[int]:
        """Get list of user IDs with active contexts."""
        return list(self._contexts.keys())


# Global context manager instance
_context_manager: Optional[UserContextManager] = None


def get_context_manager() -> UserContextManager:
    """Get or create global context manager instance."""
    global _context_manager
    if _context_manager is None:
        _context_manager = UserContextManager()
    return _context_manager


def reset_context_manager() -> None:
    """Reset global context manager (useful for testing)."""
    global _context_manager
    if _context_manager:
        _context_manager.clear_all()
    _context_manager = None
