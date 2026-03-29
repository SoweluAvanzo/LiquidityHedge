"""
Orca Whirlpools client.

Provides methods for interacting with Orca Whirlpools CLMM DEX
including pool state queries, position management, and instruction building.
"""

import json
import math
import struct
from dataclasses import dataclass, field
from decimal import Decimal
from pathlib import Path
from typing import Optional, List, Dict, Any, Tuple

import structlog
from solders.pubkey import Pubkey
from solders.keypair import Keypair
from solders.instruction import Instruction

from app.config import get_settings
from .solana_client import SolanaClient, get_solana_client
from .whirlpool_instructions import (
    WhirlpoolInstructionBuilder,
    get_instruction_builder,
    derive_position_pda,
    derive_tick_array_pda,
    derive_associated_token_address,
    derive_associated_token_address_2022,
    get_tick_array_start_index,
    build_create_ata_instruction,
    build_create_ata_instruction_2022,
    TOKEN_PROGRAM_ID,
    TOKEN_2022_PROGRAM_ID,
)
from .transaction_manager import (
    TransactionManager,
    TransactionBundle,
    TransactionReceipt,
    get_transaction_manager,
)

# Position account discriminator (first 8 bytes)
POSITION_DISCRIMINATOR = bytes([170, 188, 143, 228, 122, 64, 247, 208])
WHIRLPOOL_DISCRIMINATOR = bytes([63, 149, 209, 12, 225, 128, 99, 9])

logger = structlog.get_logger(__name__)
settings = get_settings()

# Orca Whirlpool Program ID
WHIRLPOOL_PROGRAM_ID = Pubkey.from_string(settings.orca_whirlpool_program_id)

# Tick spacing for SOL/USDC pool (typically 64 for 1% fee tier)
DEFAULT_TICK_SPACING = 64

# Constants for tick/price math
Q64 = 2**64
MIN_TICK = -443636
MAX_TICK = 443636

# Wrapped SOL (WSOL) mint address
NATIVE_MINT = Pubkey.from_string("So11111111111111111111111111111111111111112")

# System program ID for native SOL transfers
SYSTEM_PROGRAM_ID = Pubkey.from_string("11111111111111111111111111111111")


@dataclass
class PoolState:
    """Orca Whirlpool pool state."""
    pubkey: str
    token_mint_a: str  # SOL
    token_mint_b: str  # USDC
    tick_spacing: int
    tick_current_index: int
    sqrt_price: int  # Q64.64 fixed point
    liquidity: int
    fee_rate: int  # in hundredths of a basis point
    protocol_fee_rate: int
    fee_growth_global_a: int
    fee_growth_global_b: int
    token_vault_a: str
    token_vault_b: str
    # Data source tracking fields
    is_mock_data: bool = False
    data_source: str = "unknown"  # "mainnet", "devnet", "testnet", "mock", "mainnet_fallback"
    original_pubkey: Optional[str] = None  # If using fallback pool, tracks the originally requested pool

    @property
    def current_price_raw(self) -> float:
        """Calculate raw price ratio from sqrt_price (without decimal adjustment)."""
        sqrt_price_decimal = self.sqrt_price / Q64
        return sqrt_price_decimal ** 2

    @property
    def current_price(self) -> float:
        """
        Calculate current price from sqrt_price (token B per token A).

        For SOL/USDC pool:
        - Token A (SOL) has 9 decimals
        - Token B (USDC) has 6 decimals

        The raw price needs adjustment by 10^(decimals_A - decimals_B) = 10^3 = 1000
        to get the actual price in human-readable form (USDC per SOL).
        """
        raw_price = self.current_price_raw
        # Adjust for decimal difference: SOL (9) - USDC (6) = 3 decimals
        # This converts from raw ratio to actual price
        return raw_price * 1000

    @property
    def current_price_inverted(self) -> float:
        """Calculate inverted price (token A per token B)."""
        if self.current_price == 0:
            return 0
        return 1 / self.current_price


@dataclass
class PositionState:
    """Orca Whirlpool position state."""
    pubkey: str
    whirlpool: str
    position_mint: str
    liquidity: int
    tick_lower_index: int
    tick_upper_index: int
    fee_growth_checkpoint_a: int
    fee_growth_checkpoint_b: int
    fee_owed_a: int
    fee_owed_b: int

    @property
    def is_in_range(self) -> bool:
        """Check if position is currently in range (requires pool state)."""
        # This would need pool state to determine
        return True

    def get_price_range(self) -> Tuple[float, float]:
        """Get price range for this position."""
        lower_price = tick_to_price(self.tick_lower_index)
        upper_price = tick_to_price(self.tick_upper_index)
        return (lower_price, upper_price)


@dataclass
class InstructionSet:
    """Set of instructions to execute."""
    instructions: List[Instruction] = field(default_factory=list)
    signers: List[Any] = field(default_factory=list)
    description: str = ""


def tick_to_sqrt_price(tick: int) -> int:
    """Convert tick index to sqrt price (Q64.64)."""
    return int(math.pow(1.0001, tick / 2) * Q64)


def sqrt_price_to_tick(sqrt_price: int) -> int:
    """Convert sqrt price (Q64.64) to tick index."""
    sqrt_price_decimal = sqrt_price / Q64
    if sqrt_price_decimal <= 0:
        return MIN_TICK
    return int(math.log(sqrt_price_decimal ** 2) / math.log(1.0001))


def tick_to_price(tick: int) -> float:
    """
    Convert tick index to price (USDC per SOL).

    The raw tick formula gives price in base units. We adjust for
    the decimal difference between SOL (9) and USDC (6) to get
    the human-readable price.
    """
    raw_price = math.pow(1.0001, tick)
    # Adjust for decimal difference: SOL (9) - USDC (6) = 3 decimals
    return raw_price * 1000


def tick_index_to_sqrt_price(tick: int) -> int:
    """Convert tick index to sqrt price (Q64.64 format)."""
    price = math.pow(1.0001, tick)
    sqrt_price = math.sqrt(price)
    return int(sqrt_price * Q64)


def price_to_tick(price: float, tick_spacing: int = DEFAULT_TICK_SPACING) -> int:
    """
    Convert price (USDC per SOL) to nearest valid tick index.

    The price is in human-readable form (e.g., 140 USDC per SOL).
    We need to convert back to raw form before calculating the tick.
    """
    if price <= 0:
        return MIN_TICK
    # Convert human-readable price to raw ratio
    # Reverse the decimal adjustment: divide by 1000
    raw_price = price / 1000
    tick = int(math.log(raw_price) / math.log(1.0001))
    # Round to nearest tick spacing
    return (tick // tick_spacing) * tick_spacing


def calculate_tick_range(
    current_price: float,
    range_width_pct: float,
    tick_spacing: int = DEFAULT_TICK_SPACING,
) -> Tuple[int, int]:
    """
    Calculate tick range centered on current price.

    Args:
        current_price: Current pool price
        range_width_pct: Range width as percentage (e.g., 2.0 for +/- 1%)
        tick_spacing: Pool tick spacing

    Returns:
        Tuple of (lower_tick, upper_tick)
    """
    half_width = range_width_pct / 200.0  # Convert to half-width decimal

    lower_price = current_price * (1 - half_width)
    upper_price = current_price * (1 + half_width)

    lower_tick = price_to_tick(lower_price, tick_spacing)
    upper_tick = price_to_tick(upper_price, tick_spacing)

    # Ensure ticks are within bounds
    lower_tick = max(MIN_TICK, lower_tick)
    upper_tick = min(MAX_TICK, upper_tick)

    return (lower_tick, upper_tick)


def build_wrap_sol_instructions(
    owner: Pubkey,
    wsol_ata: Pubkey,
    lamports: int,
) -> List[Instruction]:
    """
    Build instructions to wrap native SOL into a WSOL token account.

    For Orca Whirlpools, SOL must be wrapped as WSOL before it can be used
    in liquidity operations. This creates two instructions:
    1. SystemProgram.transfer: Move native SOL to the WSOL ATA
    2. Token.syncNative: Update the token account balance to reflect the SOL

    Args:
        owner: The wallet owner (source of SOL, must sign)
        wsol_ata: The WSOL Associated Token Account (destination)
        lamports: Amount of SOL to wrap in lamports

    Returns:
        List of [transfer_ix, sync_native_ix]
    """
    from solders.instruction import AccountMeta

    # 1. SystemProgram.transfer instruction
    # Instruction data: u32 instruction index (2 for transfer) + u64 lamports
    transfer_data = struct.pack("<IQ", 2, lamports)
    transfer_ix = Instruction(
        program_id=SYSTEM_PROGRAM_ID,
        accounts=[
            AccountMeta(pubkey=owner, is_signer=True, is_writable=True),
            AccountMeta(pubkey=wsol_ata, is_signer=False, is_writable=True),
        ],
        data=transfer_data,
    )

    # 2. Token.syncNative instruction
    # This updates the token account balance to match the lamport balance
    # Instruction index 17 = SyncNative (single account: the token account)
    sync_native_data = bytes([17])  # SyncNative instruction discriminator
    sync_native_ix = Instruction(
        program_id=TOKEN_PROGRAM_ID,
        accounts=[
            AccountMeta(pubkey=wsol_ata, is_signer=False, is_writable=True),
        ],
        data=sync_native_data,
    )

    logger.debug(
        "built_wrap_sol_instructions",
        wsol_ata=str(wsol_ata),
        lamports=lamports,
        sol_amount=lamports / 1e9,
    )

    return [transfer_ix, sync_native_ix]


class OrcaClient:
    """
    Client for Orca Whirlpools CLMM DEX.

    Provides methods for:
    - Pool state queries
    - Position state queries
    - Instruction building for liquidity operations
    - Transaction execution for position management
    """

    def __init__(
        self,
        solana_client: Optional[SolanaClient] = None,
        instruction_builder: Optional[WhirlpoolInstructionBuilder] = None,
        transaction_manager: Optional[TransactionManager] = None,
    ):
        """
        Initialize the Orca client.

        Args:
            solana_client: Solana client instance
            instruction_builder: Whirlpool instruction builder
            transaction_manager: Transaction manager
        """
        self._solana_client = solana_client
        self._instruction_builder = instruction_builder
        self._transaction_manager = transaction_manager
        self._pool_cache: Dict[str, PoolState] = {}
        self._position_cache: Dict[str, PositionState] = {}

    async def _get_solana_client(self) -> SolanaClient:
        """Get or create Solana client."""
        if self._solana_client is None:
            self._solana_client = await get_solana_client()
        return self._solana_client

    def _get_instruction_builder(self) -> WhirlpoolInstructionBuilder:
        """Get or create instruction builder."""
        if self._instruction_builder is None:
            self._instruction_builder = get_instruction_builder()
        return self._instruction_builder

    async def _get_transaction_manager(self) -> TransactionManager:
        """Get or create transaction manager."""
        if self._transaction_manager is None:
            self._transaction_manager = await get_transaction_manager()
        return self._transaction_manager

    def clear_cache(self) -> None:
        """
        Clear all internal caches.

        Clear all internal caches to ensure fresh data is fetched.
        """
        self._pool_cache.clear()
        self._position_cache.clear()
        logger.info("orca_client_cache_cleared")

    async def _get_token_accounts(
        self,
        owner: Pubkey,
        token_mint_a: str,
        token_mint_b: str,
    ) -> Tuple[Pubkey, Pubkey]:
        """Get or derive token accounts for owner."""
        mint_a = Pubkey.from_string(token_mint_a)
        mint_b = Pubkey.from_string(token_mint_b)
        token_account_a = derive_associated_token_address(owner, mint_a)
        token_account_b = derive_associated_token_address(owner, mint_b)
        return token_account_a, token_account_b

    async def _account_exists(self, pubkey: Pubkey) -> bool:
        """Check if an account exists on-chain."""
        solana = await self._get_solana_client()
        try:
            info = await solana.get_account_info(str(pubkey))
            return info is not None
        except Exception:
            return False

    async def _is_token2022_mint(self, mint_pubkey: str) -> bool:
        """
        Check if a mint account is owned by Token2022 program.

        Used to detect whether a position was created with Token Extensions,
        so we can close it with the correct instruction.
        """
        solana = await self._get_solana_client()
        try:
            info = await solana.get_account_info(mint_pubkey)
            if info is None:
                return False
            # Check if the owner is Token2022 program
            owner = str(info.owner)
            return owner == str(TOKEN_2022_PROGRAM_ID)
        except Exception as e:
            logger.warning("failed_to_check_token2022_mint", mint=mint_pubkey, error=str(e))
            return False

    async def _get_initialization_instructions(
        self,
        pool_pubkey: str,
        owner: Pubkey,
        lower_tick: int,
        upper_tick: int,
        pool_state: "PoolState",
    ) -> List[Instruction]:
        """
        Get any initialization instructions needed before opening a position.

        Checks if tick arrays and token accounts exist, and returns
        instructions to create them if they don't.

        Args:
            pool_pubkey: Whirlpool address
            owner: Position owner (wallet)
            lower_tick: Lower tick of the position
            upper_tick: Upper tick of the position
            pool_state: Current pool state

        Returns:
            List of initialization instructions (may be empty)
        """
        instructions = []
        builder = self._get_instruction_builder()
        whirlpool = Pubkey.from_string(pool_pubkey)

        # Check tick arrays
        tick_array_lower_start = get_tick_array_start_index(lower_tick, pool_state.tick_spacing)
        tick_array_upper_start = get_tick_array_start_index(upper_tick, pool_state.tick_spacing)

        tick_array_lower, _ = derive_tick_array_pda(whirlpool, tick_array_lower_start)
        tick_array_upper, _ = derive_tick_array_pda(whirlpool, tick_array_upper_start)

        # Check if lower tick array exists
        if not await self._account_exists(tick_array_lower):
            logger.info(
                "tick_array_not_initialized",
                tick_array=str(tick_array_lower),
                start_tick=tick_array_lower_start,
            )
            init_ix = builder.build_initialize_tick_array(
                whirlpool=whirlpool,
                tick_array=tick_array_lower,
                funder=owner,
                start_tick_index=tick_array_lower_start,
            )
            instructions.append(init_ix)

        # Check if upper tick array exists (if different from lower)
        if tick_array_upper != tick_array_lower:
            if not await self._account_exists(tick_array_upper):
                logger.info(
                    "tick_array_not_initialized",
                    tick_array=str(tick_array_upper),
                    start_tick=tick_array_upper_start,
                )
                init_ix = builder.build_initialize_tick_array(
                    whirlpool=whirlpool,
                    tick_array=tick_array_upper,
                    funder=owner,
                    start_tick_index=tick_array_upper_start,
                )
                instructions.append(init_ix)

        # Check token accounts (ATAs)
        mint_a = Pubkey.from_string(pool_state.token_mint_a)
        mint_b = Pubkey.from_string(pool_state.token_mint_b)
        token_account_a = derive_associated_token_address(owner, mint_a)
        token_account_b = derive_associated_token_address(owner, mint_b)

        if not await self._account_exists(token_account_a):
            logger.info(
                "token_account_not_initialized",
                token_account=str(token_account_a),
                mint=pool_state.token_mint_a,
            )
            create_ix = build_create_ata_instruction(
                payer=owner,
                owner=owner,
                mint=mint_a,
            )
            instructions.append(create_ix)

        if not await self._account_exists(token_account_b):
            logger.info(
                "token_account_not_initialized",
                token_account=str(token_account_b),
                mint=pool_state.token_mint_b,
            )
            create_ix = build_create_ata_instruction(
                payer=owner,
                owner=owner,
                mint=mint_b,
            )
            instructions.append(create_ix)

        if instructions:
            logger.info(
                "initialization_instructions_needed",
                count=len(instructions),
            )

        return instructions

    async def get_pool_state(
        self,
        pool_pubkey: str,
        force_refresh: bool = False,
        use_mainnet_data: bool = True,
    ) -> PoolState:
        """
        Get Whirlpool state from on-chain data.

        Fetches pool state from on-chain data.
        - Allows simulating trades with real market conditions

        Args:
            pool_pubkey: Whirlpool account public key
            force_refresh: Force refresh from chain, bypassing cache
            use_mainnet_data: Fetch from mainnet (default True)

        Returns:
            PoolState: Current pool state with is_mock_data and data_source fields
        """
        # Use cache key for pool
        cache_key = f"{pool_pubkey}:live"

        # Check cache first (unless force refresh requested)
        if not force_refresh and cache_key in self._pool_cache:
            return self._pool_cache[cache_key]

        logger.info("get_pool_state", pool=pool_pubkey)

        # Fetch real on-chain data from configured network
        solana = await self._get_solana_client()
        try:
            account_info = await solana.get_account_info(pool_pubkey)
            if account_info is None:
                raise ValueError(f"Pool account not found: {pool_pubkey}")

            data = account_info.data
            pool_state = self._decode_whirlpool(pool_pubkey, data)
            pool_state.is_mock_data = False
            pool_state.data_source = settings.solana_network
            self._pool_cache[cache_key] = pool_state
            return pool_state

        except Exception as e:
            logger.error("failed_to_get_pool_state", pool=pool_pubkey, error=str(e))
            raise

    async def _fetch_mainnet_pool_data(
        self, pool_pubkey: str, cache_key: str
    ) -> Optional[PoolState]:
        """
        Fetch pool data from mainnet.

        Tries the specified pool first, then falls back to mainnet SOL/USDC pool.

        Returns:
            PoolState if successful, None if fetch fails
        """
        try:
            from .mainnet_client import get_mainnet_client
            mainnet = await get_mainnet_client()

            # Try the specified pool address on mainnet
            data = await mainnet.get_account_data(pool_pubkey)

            if data is not None and len(data) >= 300:
                pool_state = self._decode_whirlpool(pool_pubkey, data)
                pool_state.is_mock_data = False
                pool_state.data_source = "mainnet"
                self._pool_cache[cache_key] = pool_state
                logger.info(
                    "pool_state_from_mainnet",
                    pool=pool_pubkey,
                    price=pool_state.current_price,
                )
                return pool_state

            # Pool doesn't exist on mainnet - try the mainnet SOL/USDC pool as fallback
            logger.warning(
                "pool_not_found_on_mainnet",
                pool=pool_pubkey,
                fallback="trying mainnet SOL/USDC pool",
            )
            mainnet_pool = settings.orca_sol_usdc_pool_mainnet
            if mainnet_pool != pool_pubkey:
                data = await mainnet.get_account_data(mainnet_pool)
                if data is not None and len(data) >= 300:
                    pool_state = self._decode_whirlpool(mainnet_pool, data)
                    pool_state.is_mock_data = False
                    pool_state.data_source = "mainnet_fallback"
                    pool_state.original_pubkey = pool_pubkey  # Track the originally requested pool
                    self._pool_cache[cache_key] = pool_state
                    logger.info(
                        "using_mainnet_sol_usdc_pool",
                        requested=pool_pubkey,
                        using=mainnet_pool,
                        price=pool_state.current_price,
                    )
                    return pool_state

        except Exception as e:
            logger.error("mainnet_pool_fetch_failed", error=str(e))

        return None

    def _create_mock_pool_state(self, pool_pubkey: str, cache_key: str) -> PoolState:
        """
        Create mock pool state when real data is unavailable.

        Used as fallback when mainnet fetch fails.
        """
        mock_vault_a = "11111111111111111111111111111111"  # System program (valid base58)
        mock_vault_b = "11111111111111111111111111111112"  # Valid base58 placeholder

        pool_state = PoolState(
            pubkey=pool_pubkey,
            token_mint_a=settings.sol_mint,
            token_mint_b=settings.usdc_mint,
            tick_spacing=DEFAULT_TICK_SPACING,
            tick_current_index=0,
            sqrt_price=int(150.0 ** 0.5 * Q64),  # Mock ~$150 SOL price
            liquidity=1_000_000_000_000,
            fee_rate=3000,  # 0.3% fee
            protocol_fee_rate=300,
            fee_growth_global_a=0,
            fee_growth_global_b=0,
            token_vault_a=mock_vault_a,
            token_vault_b=mock_vault_b,
            is_mock_data=True,
            data_source="mock",
        )
        self._pool_cache[cache_key] = pool_state
        return pool_state

    def _decode_whirlpool(self, pubkey: str, data: bytes) -> PoolState:
        """Decode Whirlpool account data.

        The Whirlpool account has a minimum size of approximately 653 bytes.
        Structure includes: 8-byte discriminator + various fields.
        """
        # Minimum expected size for a Whirlpool account
        # 8 (discriminator) + 32 (config) + 1 (bump) + 2 (tickSpacing) + 2 (tickSpacingSeed)
        # + 2 (feeRate) + 2 (protocolFeeRate) + 16 (liquidity) + 16 (sqrtPrice)
        # + 4 (tickCurrentIndex) + 8 (protocolFeeOwedA) + 8 (protocolFeeOwedB)
        # + 32 (tokenMintA) + 32 (tokenVaultA) + 16 (feeGrowthGlobalA)
        # + 32 (tokenMintB) + 32 (tokenVaultB) + 16 (feeGrowthGlobalB) + more = ~653 bytes
        MIN_WHIRLPOOL_SIZE = 300  # Conservative minimum

        if data is None or len(data) < MIN_WHIRLPOOL_SIZE:
            raise ValueError(
                f"Invalid Whirlpool account data for {pubkey}: "
                f"expected at least {MIN_WHIRLPOOL_SIZE} bytes, got {len(data) if data else 0}. "
                f"This pool may not exist on the current network (devnet vs mainnet)."
            )

        # Skip 8-byte discriminator
        offset = 8

        # whirlpoolsConfig: Pubkey (32 bytes)
        config = Pubkey.from_bytes(data[offset:offset+32])
        offset += 32

        # whirlpoolBump: [u8; 1]
        offset += 1

        # tickSpacing: u16
        tick_spacing = struct.unpack_from("<H", data, offset)[0]
        offset += 2

        # tickSpacingSeed: [u8; 2]
        offset += 2

        # feeRate: u16
        fee_rate = struct.unpack_from("<H", data, offset)[0]
        offset += 2

        # protocolFeeRate: u16
        protocol_fee_rate = struct.unpack_from("<H", data, offset)[0]
        offset += 2

        # liquidity: u128
        liquidity = int.from_bytes(data[offset:offset+16], "little")
        offset += 16

        # sqrtPrice: u128
        sqrt_price = int.from_bytes(data[offset:offset+16], "little")
        offset += 16

        # tickCurrentIndex: i32
        tick_current_index = struct.unpack_from("<i", data, offset)[0]
        offset += 4

        # protocolFeeOwedA: u64
        offset += 8

        # protocolFeeOwedB: u64
        offset += 8

        # tokenMintA: Pubkey
        token_mint_a = str(Pubkey.from_bytes(data[offset:offset+32]))
        offset += 32

        # tokenVaultA: Pubkey
        token_vault_a = str(Pubkey.from_bytes(data[offset:offset+32]))
        offset += 32

        # feeGrowthGlobalA: u128
        fee_growth_global_a = int.from_bytes(data[offset:offset+16], "little")
        offset += 16

        # tokenMintB: Pubkey
        token_mint_b = str(Pubkey.from_bytes(data[offset:offset+32]))
        offset += 32

        # tokenVaultB: Pubkey
        token_vault_b = str(Pubkey.from_bytes(data[offset:offset+32]))
        offset += 32

        # feeGrowthGlobalB: u128
        fee_growth_global_b = int.from_bytes(data[offset:offset+16], "little")

        return PoolState(
            pubkey=pubkey,
            token_mint_a=token_mint_a,
            token_mint_b=token_mint_b,
            tick_spacing=tick_spacing,
            tick_current_index=tick_current_index,
            sqrt_price=sqrt_price,
            liquidity=liquidity,
            fee_rate=fee_rate,
            protocol_fee_rate=protocol_fee_rate,
            fee_growth_global_a=fee_growth_global_a,
            fee_growth_global_b=fee_growth_global_b,
            token_vault_a=token_vault_a,
            token_vault_b=token_vault_b,
        )

    async def get_position_state(self, position_pubkey: str) -> Optional[PositionState]:
        """
        Get position state from on-chain data.

        Args:
            position_pubkey: Position account public key

        Returns:
            PositionState: Current position state or None
        """
        # Check cache first
        if position_pubkey in self._position_cache:
            return self._position_cache[position_pubkey]

        logger.info("get_position_state", position=position_pubkey)

        # Fetch real on-chain data
        solana = await self._get_solana_client()
        try:
            account_info = await solana.get_account_info(position_pubkey)
            if account_info is None:
                return None

            data = account_info.data
            position_state = self._decode_position(position_pubkey, data)
            self._position_cache[position_pubkey] = position_state
            return position_state

        except Exception as e:
            logger.warning("failed_to_get_position_state", position=position_pubkey, error=str(e))
            return None

    def _decode_position(self, pubkey: str, data: bytes) -> PositionState:
        """Decode Position account data."""
        # Skip 8-byte discriminator
        offset = 8

        # whirlpool: Pubkey
        whirlpool = str(Pubkey.from_bytes(data[offset:offset+32]))
        offset += 32

        # positionMint: Pubkey
        position_mint = str(Pubkey.from_bytes(data[offset:offset+32]))
        offset += 32

        # liquidity: u128
        liquidity = int.from_bytes(data[offset:offset+16], "little")
        offset += 16

        # tickLowerIndex: i32
        tick_lower_index = struct.unpack_from("<i", data, offset)[0]
        offset += 4

        # tickUpperIndex: i32
        tick_upper_index = struct.unpack_from("<i", data, offset)[0]
        offset += 4

        # feeGrowthCheckpointA: u128
        fee_growth_checkpoint_a = int.from_bytes(data[offset:offset+16], "little")
        offset += 16

        # feeOwedA: u64
        fee_owed_a = struct.unpack_from("<Q", data, offset)[0]
        offset += 8

        # feeGrowthCheckpointB: u128
        fee_growth_checkpoint_b = int.from_bytes(data[offset:offset+16], "little")
        offset += 16

        # feeOwedB: u64
        fee_owed_b = struct.unpack_from("<Q", data, offset)[0]

        return PositionState(
            pubkey=pubkey,
            whirlpool=whirlpool,
            position_mint=position_mint,
            liquidity=liquidity,
            tick_lower_index=tick_lower_index,
            tick_upper_index=tick_upper_index,
            fee_growth_checkpoint_a=fee_growth_checkpoint_a,
            fee_growth_checkpoint_b=fee_growth_checkpoint_b,
            fee_owed_a=fee_owed_a,
            fee_owed_b=fee_owed_b,
        )

    async def get_positions_for_wallet(
        self,
        wallet_pubkey: Optional[str] = None,
        pool_pubkey: Optional[str] = None,
    ) -> List[PositionState]:
        """
        Get all Whirlpool positions for a wallet.

        This works by finding position NFTs owned by the wallet, then
        deriving and fetching the position accounts.

        Args:
            wallet_pubkey: Wallet public key
            pool_pubkey: Optional pool filter

        Returns:
            List of PositionState
        """
        logger.info("get_positions_for_wallet", wallet=wallet_pubkey, pool=pool_pubkey)

        # Fetch real on-chain data
        solana = await self._get_solana_client()

        if wallet_pubkey is None:
            wallet_pubkey = str(solana.wallet_pubkey)

        positions = []

        try:
            # Get all token accounts owned by the wallet
            token_accounts = await solana.get_token_accounts_by_owner(wallet_pubkey)

            for token_account in token_accounts:
                # Check if this is a position NFT (amount = 1, decimals = 0)
                if token_account.get("amount", 0) == 1 and token_account.get("decimals", 0) == 0:
                    mint = token_account.get("mint")
                    if not mint:
                        continue

                    # Derive position PDA from mint
                    position_pubkey = self._derive_position_address(mint)
                    if position_pubkey:
                        position = await self.get_position_state(position_pubkey)
                        if position:
                            # Filter by pool if specified
                            if pool_pubkey is None or position.whirlpool == pool_pubkey:
                                positions.append(position)

        except Exception as e:
            logger.warning("failed_to_get_positions", wallet=wallet_pubkey, error=str(e))

        return positions

    def _derive_position_address(self, position_mint: str) -> Optional[str]:
        """Derive position PDA from position mint."""
        try:
            mint_pk = Pubkey.from_string(position_mint)
            # Position PDA seeds: ["position", position_mint]
            position_pk, _ = Pubkey.find_program_address(
                [b"position", bytes(mint_pk)],
                WHIRLPOOL_PROGRAM_ID,
            )
            return str(position_pk)
        except Exception as e:
            logger.debug("failed_to_derive_position", mint=position_mint, error=str(e))
            return None

    async def build_open_position(
        self,
        pool_pubkey: str,
        lower_tick: int,
        upper_tick: int,
        with_metadata: bool = False,
        use_token_extensions: bool = False,
    ) -> InstructionSet:
        """
        Build instructions to open a new position.

        Args:
            pool_pubkey: Whirlpool public key
            lower_tick: Lower tick index
            upper_tick: Upper tick index
            with_metadata: Whether to create position with metadata NFT.
                          Default False - bot doesn't need NFT representation.
                          Saves ~0.015 SOL rent per position.
            use_token_extensions: Whether to use Token2022 for the position mint.
                                 Default False for backwards compatibility.
                                 When True, ALL rent is refundable on close.

        Returns:
            InstructionSet: Instructions to execute with position mint keypair
        """
        solana = await self._get_solana_client()
        builder = self._get_instruction_builder()

        logger.info(
            "build_open_position",
            pool=pool_pubkey,
            lower_tick=lower_tick,
            upper_tick=upper_tick,
            with_metadata=with_metadata,
            use_token_extensions=use_token_extensions,
        )

        # Generate new position mint keypair
        position_mint = Keypair()

        whirlpool = Pubkey.from_string(pool_pubkey)
        owner = solana.wallet_pubkey

        # Build instruction (using Token Extensions or standard SPL Token)
        if use_token_extensions:
            instruction, position_accounts = builder.build_open_position_with_token_extensions(
                funder=owner,
                owner=owner,
                whirlpool=whirlpool,
                position_mint=position_mint,
                tick_lower_index=lower_tick,
                tick_upper_index=upper_tick,
                with_metadata=with_metadata,
            )
        else:
            instruction, position_accounts = builder.build_open_position(
                funder=owner,
                owner=owner,
                whirlpool=whirlpool,
                position_mint=position_mint,
                tick_lower_index=lower_tick,
                tick_upper_index=upper_tick,
                with_metadata=with_metadata,
            )

        return InstructionSet(
            instructions=[instruction],
            signers=[position_mint],
            description=f"Open position: ticks [{lower_tick}, {upper_tick}]" + (" (Token2022)" if use_token_extensions else ""),
        )

    async def build_increase_liquidity(
        self,
        position_pubkey: str,
        liquidity_amount: int,
        token_max_a: int,
        token_max_b: int,
    ) -> InstructionSet:
        """
        Build instructions to add liquidity to a position.

        Args:
            position_pubkey: Position public key
            liquidity_amount: Amount of liquidity to add
            token_max_a: Maximum token A to deposit
            token_max_b: Maximum token B to deposit

        Returns:
            InstructionSet: Instructions to execute
        """
        logger.info(
            "build_increase_liquidity",
            position=position_pubkey,
            liquidity=liquidity_amount,
        )

        solana = await self._get_solana_client()
        builder = self._get_instruction_builder()

        # Get position state to find whirlpool
        position_state = await self.get_position_state(position_pubkey)
        if position_state is None:
            raise ValueError(f"Position not found: {position_pubkey}")

        # Get pool state for vaults and tick spacing
        pool_state = await self.get_pool_state(position_state.whirlpool)

        # Derive accounts
        owner = solana.wallet_pubkey
        position = Pubkey.from_string(position_pubkey)
        whirlpool = Pubkey.from_string(position_state.whirlpool)
        position_mint = Pubkey.from_string(position_state.position_mint)

        # Check if position uses Token2022 for the position token account derivation
        uses_token2022 = await self._is_token2022_mint(position_state.position_mint)
        if uses_token2022:
            position_token_account = derive_associated_token_address_2022(owner, position_mint)
        else:
            position_token_account = derive_associated_token_address(owner, position_mint)

        # Get token accounts
        token_owner_account_a, token_owner_account_b = await self._get_token_accounts(
            owner,
            pool_state.token_mint_a,
            pool_state.token_mint_b,
        )

        # Derive tick array PDAs
        tick_array_lower_start = get_tick_array_start_index(
            position_state.tick_lower_index,
            pool_state.tick_spacing,
        )
        tick_array_upper_start = get_tick_array_start_index(
            position_state.tick_upper_index,
            pool_state.tick_spacing,
        )

        tick_array_lower, _ = derive_tick_array_pda(whirlpool, tick_array_lower_start)
        tick_array_upper, _ = derive_tick_array_pda(whirlpool, tick_array_upper_start)

        # Build instruction
        instruction = builder.build_increase_liquidity(
            whirlpool=whirlpool,
            position=position,
            position_token_account=position_token_account,
            token_owner_account_a=token_owner_account_a,
            token_owner_account_b=token_owner_account_b,
            token_vault_a=Pubkey.from_string(pool_state.token_vault_a),
            token_vault_b=Pubkey.from_string(pool_state.token_vault_b),
            tick_array_lower=tick_array_lower,
            tick_array_upper=tick_array_upper,
            position_authority=owner,
            liquidity_amount=liquidity_amount,
            token_max_a=token_max_a,
            token_max_b=token_max_b,
        )

        return InstructionSet(
            instructions=[instruction],
            signers=[],
            description=f"Increase liquidity: {liquidity_amount}",
        )

    async def build_decrease_liquidity(
        self,
        position_pubkey: str,
        liquidity_amount: int,
        token_min_a: int = 0,
        token_min_b: int = 0,
    ) -> InstructionSet:
        """
        Build instructions to remove liquidity from a position.

        Args:
            position_pubkey: Position public key
            liquidity_amount: Amount of liquidity to remove
            token_min_a: Minimum token A to receive
            token_min_b: Minimum token B to receive

        Returns:
            InstructionSet: Instructions to execute
        """
        logger.info(
            "build_decrease_liquidity",
            position=position_pubkey,
            liquidity=liquidity_amount,
        )

        solana = await self._get_solana_client()
        builder = self._get_instruction_builder()

        # Get position state to find whirlpool
        position_state = await self.get_position_state(position_pubkey)
        if position_state is None:
            raise ValueError(f"Position not found: {position_pubkey}")

        # Get pool state for vaults and tick spacing
        pool_state = await self.get_pool_state(position_state.whirlpool)

        # Derive accounts
        owner = solana.wallet_pubkey
        position = Pubkey.from_string(position_pubkey)
        whirlpool = Pubkey.from_string(position_state.whirlpool)
        position_mint = Pubkey.from_string(position_state.position_mint)

        # Check if position uses Token2022 for the position token account derivation
        uses_token2022 = await self._is_token2022_mint(position_state.position_mint)
        if uses_token2022:
            position_token_account = derive_associated_token_address_2022(owner, position_mint)
        else:
            position_token_account = derive_associated_token_address(owner, position_mint)

        # Get token accounts
        token_owner_account_a, token_owner_account_b = await self._get_token_accounts(
            owner,
            pool_state.token_mint_a,
            pool_state.token_mint_b,
        )

        # Derive tick array PDAs
        tick_array_lower_start = get_tick_array_start_index(
            position_state.tick_lower_index,
            pool_state.tick_spacing,
        )
        tick_array_upper_start = get_tick_array_start_index(
            position_state.tick_upper_index,
            pool_state.tick_spacing,
        )

        tick_array_lower, _ = derive_tick_array_pda(whirlpool, tick_array_lower_start)
        tick_array_upper, _ = derive_tick_array_pda(whirlpool, tick_array_upper_start)

        # Build instruction
        instruction = builder.build_decrease_liquidity(
            whirlpool=whirlpool,
            position=position,
            position_token_account=position_token_account,
            token_owner_account_a=token_owner_account_a,
            token_owner_account_b=token_owner_account_b,
            token_vault_a=Pubkey.from_string(pool_state.token_vault_a),
            token_vault_b=Pubkey.from_string(pool_state.token_vault_b),
            tick_array_lower=tick_array_lower,
            tick_array_upper=tick_array_upper,
            position_authority=owner,
            liquidity_amount=liquidity_amount,
            token_min_a=token_min_a,
            token_min_b=token_min_b,
        )

        return InstructionSet(
            instructions=[instruction],
            signers=[],
            description=f"Decrease liquidity: {liquidity_amount}",
        )

    async def build_collect_fees(
        self,
        position_pubkey: str,
    ) -> InstructionSet:
        """
        Build instructions to collect fees from a position.

        Includes update_fees_and_rewards followed by collect_fees.

        Args:
            position_pubkey: Position public key

        Returns:
            InstructionSet: Instructions to execute
        """
        logger.info("build_collect_fees", position=position_pubkey)

        solana = await self._get_solana_client()
        builder = self._get_instruction_builder()

        # Get position state to find whirlpool
        position_state = await self.get_position_state(position_pubkey)
        if position_state is None:
            raise ValueError(f"Position not found: {position_pubkey}")

        # Get pool state for vaults and tick spacing
        pool_state = await self.get_pool_state(position_state.whirlpool)

        # Derive accounts
        owner = solana.wallet_pubkey
        position = Pubkey.from_string(position_pubkey)
        whirlpool = Pubkey.from_string(position_state.whirlpool)
        position_mint = Pubkey.from_string(position_state.position_mint)

        # Check if position uses Token2022 for the position token account derivation
        uses_token2022 = await self._is_token2022_mint(position_state.position_mint)
        if uses_token2022:
            position_token_account = derive_associated_token_address_2022(owner, position_mint)
        else:
            position_token_account = derive_associated_token_address(owner, position_mint)

        # Get token accounts
        token_owner_account_a, token_owner_account_b = await self._get_token_accounts(
            owner,
            pool_state.token_mint_a,
            pool_state.token_mint_b,
        )

        # Derive tick array PDAs
        tick_array_lower_start = get_tick_array_start_index(
            position_state.tick_lower_index,
            pool_state.tick_spacing,
        )
        tick_array_upper_start = get_tick_array_start_index(
            position_state.tick_upper_index,
            pool_state.tick_spacing,
        )

        tick_array_lower, _ = derive_tick_array_pda(whirlpool, tick_array_lower_start)
        tick_array_upper, _ = derive_tick_array_pda(whirlpool, tick_array_upper_start)

        # Build update fees instruction (must be called before collect)
        update_ix = builder.build_update_fees_and_rewards(
            whirlpool=whirlpool,
            position=position,
            tick_array_lower=tick_array_lower,
            tick_array_upper=tick_array_upper,
        )

        # Build collect fees instruction
        collect_ix = builder.build_collect_fees(
            whirlpool=whirlpool,
            position=position,
            position_token_account=position_token_account,
            token_owner_account_a=token_owner_account_a,
            token_owner_account_b=token_owner_account_b,
            token_vault_a=Pubkey.from_string(pool_state.token_vault_a),
            token_vault_b=Pubkey.from_string(pool_state.token_vault_b),
            position_authority=owner,
        )

        return InstructionSet(
            instructions=[update_ix, collect_ix],
            signers=[],
            description="Collect fees from position",
        )

    async def build_close_position(
        self,
        position_pubkey: str,
        use_token_extensions: bool = False,
    ) -> InstructionSet:
        """
        Build instructions to close a position.

        Note: Position must have 0 liquidity before closing.

        Args:
            position_pubkey: Position public key
            use_token_extensions: Whether this position uses Token2022.
                                 When True, uses close_position_with_token_extensions
                                 to properly close the mint account and return all rent.

        Returns:
            InstructionSet: Instructions to execute
        """
        logger.info("build_close_position", position=position_pubkey, use_token_extensions=use_token_extensions)

        solana = await self._get_solana_client()
        builder = self._get_instruction_builder()

        # Get position state
        position_state = await self.get_position_state(position_pubkey)
        if position_state is None:
            raise ValueError(f"Position not found: {position_pubkey}")

        # Derive accounts
        owner = solana.wallet_pubkey
        position = Pubkey.from_string(position_pubkey)
        position_mint = Pubkey.from_string(position_state.position_mint)

        # Derive token account based on token program
        if use_token_extensions:
            position_token_account = derive_associated_token_address_2022(owner, position_mint)
        else:
            position_token_account = derive_associated_token_address(owner, position_mint)

        # Build close position instruction
        if use_token_extensions:
            instruction = builder.build_close_position_with_token_extensions(
                position=position,
                position_mint=position_mint,
                position_token_account=position_token_account,
                position_authority=owner,
                receiver=owner,  # Receive ALL rent back to wallet (including mint account)
            )
        else:
            instruction = builder.build_close_position(
                position=position,
                position_mint=position_mint,
                position_token_account=position_token_account,
                position_authority=owner,
                receiver=owner,  # Receive rent back to wallet
            )

        return InstructionSet(
            instructions=[instruction],
            signers=[],
            description="Close position" + (" (Token2022)" if use_token_extensions else ""),
        )

    async def estimate_fees_earned(
        self,
        position_pubkey: str,
    ) -> Tuple[Decimal, Decimal]:
        """
        Estimate fees earned by a position.

        Calculates uncollected fees using fee growth checkpoints.

        Args:
            position_pubkey: Position public key

        Returns:
            Tuple of (fees_token_a, fees_token_b) in token amounts
        """
        logger.info("estimate_fees_earned", position=position_pubkey)

        # Get position state
        position_state = await self.get_position_state(position_pubkey)
        if position_state is None:
            return (Decimal(0), Decimal(0))

        # Get pool state
        pool_state = await self.get_pool_state(position_state.whirlpool)

        # Calculate fees earned using fee growth
        # Fee growth is stored as Q64.64 fixed point
        # fees = (fee_growth_global - fee_growth_checkpoint) * liquidity / 2^64

        liquidity = position_state.liquidity
        if liquidity == 0:
            return (Decimal(0), Decimal(0))

        # Fees owed are already calculated and stored in position
        # fee_owed_a and fee_owed_b are in token amounts
        fees_a = Decimal(position_state.fee_owed_a) / Decimal(10**9)  # SOL decimals
        fees_b = Decimal(position_state.fee_owed_b) / Decimal(10**6)  # USDC decimals

        logger.debug(
            "fees_estimated",
            position=position_pubkey,
            fees_sol=float(fees_a),
            fees_usdc=float(fees_b),
        )

        return (fees_a, fees_b)

    async def execute_open_position(
        self,
        pool_pubkey: str,
        lower_tick: int,
        upper_tick: int,
        liquidity_amount: int,
        token_max_a: int,
        token_max_b: int,
    ) -> TransactionReceipt:
        """
        Execute a complete open position transaction.

        Opens a new position and adds initial liquidity.
        Automatically initializes tick arrays and token accounts if needed.

        If USE_TOKEN_EXTENSIONS is enabled in config, uses Token2022 for the
        position NFT, which makes ALL rent fully refundable when closing.
        This saves approximately $1.15 per position cycle.

        Args:
            pool_pubkey: Whirlpool address
            lower_tick: Lower tick index
            upper_tick: Upper tick index
            liquidity_amount: Initial liquidity amount
            token_max_a: Maximum token A to deposit
            token_max_b: Maximum token B to deposit

        Returns:
            TransactionReceipt with result
        """
        # Check Token Extensions config
        use_token_extensions = settings.use_token_extensions
        with_metadata = settings.token_extensions_with_metadata if use_token_extensions else False

        logger.info(
            "execute_open_position",
            pool=pool_pubkey,
            lower_tick=lower_tick,
            upper_tick=upper_tick,
            liquidity=liquidity_amount,
            use_token_extensions=use_token_extensions,
            with_metadata=with_metadata,
        )

        solana = await self._get_solana_client()
        builder = self._get_instruction_builder()
        pool_state = await self.get_pool_state(pool_pubkey)
        owner = solana.wallet_pubkey

        # Get initialization instructions (tick arrays, token accounts)
        # These need to be executed BEFORE opening the position
        init_instructions = await self._get_initialization_instructions(
            pool_pubkey=pool_pubkey,
            owner=owner,
            lower_tick=lower_tick,
            upper_tick=upper_tick,
            pool_state=pool_state,
        )

        # Build open position instruction set
        # Token Extensions: Saves ~$1.15/position by making all rent refundable
        # Without Token Extensions: Standard SPL Token - mint account rent is NOT refunded
        open_ix_set = await self.build_open_position(
            pool_pubkey, lower_tick, upper_tick,
            with_metadata=with_metadata,
            use_token_extensions=use_token_extensions,
        )

        # Get the position mint from signers (it's a Keypair)
        position_mint_keypair = open_ix_set.signers[0] if open_ix_set.signers else None
        if position_mint_keypair is None:
            raise ValueError("Position mint keypair not found in instruction set")

        # Derive position address for increase liquidity
        position_pubkey, _ = derive_position_pda(position_mint_keypair.pubkey())

        whirlpool = Pubkey.from_string(pool_pubkey)
        # Derive position token account with correct program (Token2022 vs standard)
        if use_token_extensions:
            position_token_account = derive_associated_token_address_2022(owner, position_mint_keypair.pubkey())
        else:
            position_token_account = derive_associated_token_address(owner, position_mint_keypair.pubkey())

        token_owner_account_a, token_owner_account_b = await self._get_token_accounts(
            owner,
            pool_state.token_mint_a,
            pool_state.token_mint_b,
        )

        # If token A is native SOL (WSOL), check existing WSOL balance and only wrap what's needed
        # This prevents draining the wallet's native SOL when there's already WSOL available
        wrap_sol_instructions = []
        if pool_state.token_mint_a == str(NATIVE_MINT) and token_max_a > 0:
            # Check existing WSOL balance in the ATA
            existing_wsol_lamports = 0
            try:
                if await self._account_exists(token_owner_account_a):
                    balance_info = await solana.get_token_balance(str(token_owner_account_a))
                    if balance_info:
                        existing_wsol_lamports = int(balance_info.get("amount", "0"))
                        logger.info(
                            "existing_wsol_balance",
                            wsol_ata=str(token_owner_account_a),
                            existing_lamports=existing_wsol_lamports,
                            existing_sol=existing_wsol_lamports / 1e9,
                        )
            except Exception as e:
                logger.warning("failed_to_check_wsol_balance", error=str(e))

            # Calculate how much more SOL we need to wrap (if any)
            lamports_needed = max(0, token_max_a - existing_wsol_lamports)

            if lamports_needed > 0:
                # Check if wallet has enough native SOL for wrapping + rent reserves
                # Estimate rent needed: ~0.015 SOL for position accounts + ~0.005 buffer
                ESTIMATED_RENT_RESERVE = int(0.02 * 1e9)  # 0.02 SOL for rent and fees
                wallet_sol_lamports = int(await solana.get_balance_sol() * 1e9)
                max_wrappable = max(0, wallet_sol_lamports - ESTIMATED_RENT_RESERVE)

                if lamports_needed > max_wrappable:
                    logger.warning(
                        "insufficient_sol_for_full_wrap",
                        needed_lamports=lamports_needed,
                        available_lamports=max_wrappable,
                        wallet_lamports=wallet_sol_lamports,
                        rent_reserve=ESTIMATED_RENT_RESERVE,
                    )
                    lamports_needed = max_wrappable

                if lamports_needed > 0:
                    logger.info(
                        "wrapping_native_sol",
                        wsol_ata=str(token_owner_account_a),
                        lamports=lamports_needed,
                        sol_amount=lamports_needed / 1e9,
                        existing_wsol=existing_wsol_lamports / 1e9,
                        total_after_wrap=(existing_wsol_lamports + lamports_needed) / 1e9,
                    )
                    wrap_sol_instructions = build_wrap_sol_instructions(
                        owner=owner,
                        wsol_ata=token_owner_account_a,
                        lamports=lamports_needed,
                    )
                else:
                    logger.warning(
                        "skipping_sol_wrap_insufficient_balance",
                        wallet_sol=wallet_sol_lamports / 1e9,
                        existing_wsol=existing_wsol_lamports / 1e9,
                    )
            else:
                logger.info(
                    "using_existing_wsol",
                    wsol_ata=str(token_owner_account_a),
                    existing_lamports=existing_wsol_lamports,
                    required_lamports=token_max_a,
                )

        tick_array_lower_start = get_tick_array_start_index(lower_tick, pool_state.tick_spacing)
        tick_array_upper_start = get_tick_array_start_index(upper_tick, pool_state.tick_spacing)

        tick_array_lower, _ = derive_tick_array_pda(whirlpool, tick_array_lower_start)
        tick_array_upper, _ = derive_tick_array_pda(whirlpool, tick_array_upper_start)

        increase_ix = builder.build_increase_liquidity(
            whirlpool=whirlpool,
            position=position_pubkey,
            position_token_account=position_token_account,
            token_owner_account_a=token_owner_account_a,
            token_owner_account_b=token_owner_account_b,
            token_vault_a=Pubkey.from_string(pool_state.token_vault_a),
            token_vault_b=Pubkey.from_string(pool_state.token_vault_b),
            tick_array_lower=tick_array_lower,
            tick_array_upper=tick_array_upper,
            position_authority=owner,
            liquidity_amount=liquidity_amount,
            token_max_a=token_max_a,
            token_max_b=token_max_b,
        )

        # Combine all instructions:
        # 1. init (tick arrays, ATAs)
        # 2. wrap SOL (if token A is WSOL) - must come AFTER ATA creation but BEFORE liquidity
        # 3. open position
        # 4. increase liquidity
        all_instructions = (
            init_instructions +
            wrap_sol_instructions +
            open_ix_set.instructions +
            [increase_ix]
        )

        # Set priority fee from config if enabled
        priority_fee = None
        if settings.tx_priority_fee_enabled:
            priority_fee = settings.tx_priority_fee_microlamports

        bundle = TransactionBundle(
            instructions=all_instructions,
            signers=[position_mint_keypair],
            description=f"Open position [{lower_tick}, {upper_tick}] with liquidity {liquidity_amount}",
            priority_fee=priority_fee,
        )

        logger.info(
            "submitting_open_position_tx",
            total_instructions=len(all_instructions),
            init_instructions=len(init_instructions),
            wrap_sol_instructions=len(wrap_sol_instructions),
        )

        # Submit transaction
        tx_manager = await self._get_transaction_manager()
        receipt = await tx_manager.submit_transaction(bundle)

        # Add position address to receipt metadata for caller reference
        receipt.metadata["position_address"] = str(position_pubkey)
        receipt.metadata["position_mint"] = str(position_mint_keypair.pubkey())
        receipt.metadata["uses_token_extensions"] = use_token_extensions

        logger.info(
            "open_position_executed",
            signature=receipt.signature,
            status=receipt.status.value,
            position=str(position_pubkey),
            uses_token_extensions=use_token_extensions,
        )

        return receipt

    async def execute_close_position(
        self,
        position_pubkey: str,
        collect_fees: bool = True,
    ) -> TransactionReceipt:
        """
        Execute a complete close position transaction.

        Collects fees, removes all liquidity, and closes the position.

        Automatically detects if the position uses Token2022 and uses the
        appropriate close instruction. For Token2022 positions, the mint
        account is also closed, returning ALL rent to the wallet.

        IMPORTANT: Order of operations matters!
        1. UpdateFeesAndRewards + CollectFees (requires liquidity > 0)
        2. DecreaseLiquidity (removes all liquidity)
        3. ClosePosition (burns NFT, reclaims rent)

        Args:
            position_pubkey: Position address
            collect_fees: Whether to collect fees before closing

        Returns:
            TransactionReceipt with result
        """
        logger.info("execute_close_position", position=position_pubkey)

        solana = await self._get_solana_client()
        owner = solana.wallet_pubkey

        # Get position state
        position_state = await self.get_position_state(position_pubkey)
        if position_state is None:
            raise ValueError(f"Position not found: {position_pubkey}")

        # Get pool state to know the token mints
        pool_state = await self.get_pool_state(position_state.whirlpool)

        instructions = []
        signers = []

        # Step 0: Ensure ATAs exist for both tokens before collecting fees
        # This is needed because collect_fees sends tokens to these accounts
        mint_a = Pubkey.from_string(pool_state.token_mint_a)
        mint_b = Pubkey.from_string(pool_state.token_mint_b)
        token_account_a = derive_associated_token_address(owner, mint_a)
        token_account_b = derive_associated_token_address(owner, mint_b)

        if not await self._account_exists(token_account_a):
            logger.info(
                "creating_token_account_for_close",
                token_account=str(token_account_a),
                mint=pool_state.token_mint_a,
            )
            create_ix = build_create_ata_instruction(
                payer=owner,
                owner=owner,
                mint=mint_a,
            )
            instructions.append(create_ix)

        if not await self._account_exists(token_account_b):
            logger.info(
                "creating_token_account_for_close",
                token_account=str(token_account_b),
                mint=pool_state.token_mint_b,
            )
            create_ix = build_create_ata_instruction(
                payer=owner,
                owner=owner,
                mint=mint_b,
            )
            instructions.append(create_ix)

        # Step 1: Collect fees FIRST (requires liquidity > 0)
        # UpdateFeesAndRewards must be called while position has liquidity
        if collect_fees and position_state.liquidity > 0:
            collect_ix_set = await self.build_collect_fees(position_pubkey)
            instructions.extend(collect_ix_set.instructions)
            signers.extend(collect_ix_set.signers)

        # Step 2: Remove all liquidity
        if position_state.liquidity > 0:
            decrease_ix_set = await self.build_decrease_liquidity(
                position_pubkey=position_pubkey,
                liquidity_amount=position_state.liquidity,
            )
            instructions.extend(decrease_ix_set.instructions)
            signers.extend(decrease_ix_set.signers)

        # Step 3: Detect if position uses Token2022 and close appropriately
        # Token2022 positions have their mint owned by Token2022 program
        uses_token2022 = await self._is_token2022_mint(position_state.position_mint)

        logger.info(
            "close_position_token_type",
            position=position_pubkey,
            position_mint=position_state.position_mint,
            uses_token2022=uses_token2022,
        )

        # Step 4: Close position (burns NFT, reclaims rent)
        # For Token2022 positions, this also closes the mint account (full rent refund)
        close_ix_set = await self.build_close_position(position_pubkey, use_token_extensions=uses_token2022)
        instructions.extend(close_ix_set.instructions)
        signers.extend(close_ix_set.signers)

        # Step 4: Unwrap wSOL if token A is native SOL
        # This closes the wSOL ATA and returns SOL to native balance,
        # eliminating the need for separate wSOL cleanup transactions
        if mint_a == NATIVE_MINT:
            from solders.instruction import AccountMeta
            # SPL Token CloseAccount instruction (index 9)
            close_wsol_ix = Instruction(
                program_id=TOKEN_PROGRAM_ID,
                accounts=[
                    AccountMeta(pubkey=token_account_a, is_signer=False, is_writable=True),
                    AccountMeta(pubkey=owner, is_signer=False, is_writable=True),
                    AccountMeta(pubkey=owner, is_signer=True, is_writable=False),
                ],
                data=bytes([9]),  # CloseAccount instruction discriminator
            )
            instructions.append(close_wsol_ix)
            logger.info(
                "appending_wsol_unwrap",
                wsol_ata=str(token_account_a),
                reason="close_position_cleanup",
            )

        # Set priority fee from config if enabled
        priority_fee = None
        if settings.tx_priority_fee_enabled:
            priority_fee = settings.tx_priority_fee_microlamports

        # Build bundle
        bundle = TransactionBundle(
            instructions=instructions,
            signers=signers,
            description=f"Close position {position_pubkey[:8]}...",
            priority_fee=priority_fee,
        )

        # Submit transaction
        tx_manager = await self._get_transaction_manager()
        receipt = await tx_manager.submit_transaction(bundle)

        logger.info(
            "close_position_executed",
            signature=receipt.signature,
            status=receipt.status.value,
            position=position_pubkey,
            uses_token2022=uses_token2022,
        )

        return receipt

    async def execute_rebalance(
        self,
        current_position_pubkey: str,
        new_lower_tick: int,
        new_upper_tick: int,
        liquidity_amount: int,
        token_max_a: int,
        token_max_b: int,
    ) -> Tuple[TransactionReceipt, TransactionReceipt]:
        """
        Execute a complete rebalance operation.

        Closes the current position and opens a new one with different range.

        Args:
            current_position_pubkey: Current position to close
            new_lower_tick: New lower tick
            new_upper_tick: New upper tick
            liquidity_amount: Liquidity for new position
            token_max_a: Maximum token A for new position
            token_max_b: Maximum token B for new position

        Returns:
            Tuple of (close_receipt, open_receipt)
        """
        logger.info(
            "execute_rebalance",
            current_position=current_position_pubkey,
            new_range=f"[{new_lower_tick}, {new_upper_tick}]",
        )

        # Get current position to find pool
        position_state = await self.get_position_state(current_position_pubkey)
        if position_state is None:
            raise ValueError(f"Position not found: {current_position_pubkey}")

        # Close current position
        close_receipt = await self.execute_close_position(
            current_position_pubkey,
            collect_fees=True,
        )

        if not close_receipt.is_success:
            logger.error("rebalance_close_failed", error=close_receipt.error)
            from .transaction_manager import TransactionStatus
            return (close_receipt, TransactionReceipt(
                signature="",
                status=TransactionStatus.FAILED,
                error="Close position failed, skipping open",
            ))

        # Open new position
        open_receipt = await self.execute_open_position(
            pool_pubkey=position_state.whirlpool,
            lower_tick=new_lower_tick,
            upper_tick=new_upper_tick,
            liquidity_amount=liquidity_amount,
            token_max_a=token_max_a,
            token_max_b=token_max_b,
        )

        logger.info(
            "rebalance_completed",
            close_signature=close_receipt.signature,
            open_signature=open_receipt.signature,
        )

        return (close_receipt, open_receipt)


    # =========================================================================
    # High-level position management methods (for API use)
    # =========================================================================

    async def open_position_with_liquidity(
        self,
        lower_tick: int,
        upper_tick: int,
        sol_amount: Decimal,
        usdc_amount: Decimal,
        pool_pubkey: Optional[str] = None,
    ) -> "PositionOperationResult":
        """
        Open a new position with the specified token amounts.

        This is a high-level method that:
        1. Gets the pool state
        2. Calculates the liquidity amount from token deposits
        3. Opens the position and adds liquidity

        Args:
            lower_tick: Lower tick index
            upper_tick: Upper tick index
            sol_amount: Amount of SOL to deposit
            usdc_amount: Amount of USDC to deposit
            pool_pubkey: Optional pool address (defaults to SOL/USDC pool)

        Returns:
            PositionOperationResult with success status and position pubkey
        """
        logger.info(
            "open_position_with_liquidity",
            lower_tick=lower_tick,
            upper_tick=upper_tick,
            sol_amount=float(sol_amount),
            usdc_amount=float(usdc_amount),
        )

        try:
            # Get pool address
            if pool_pubkey is None:
                pool_pubkey = settings.orca_sol_usdc_pool

            # Get pool state
            pool_state = await self.get_pool_state(pool_pubkey)

            # Convert amounts to lamports/base units
            token_max_a = int(sol_amount * Decimal(10**9))  # SOL has 9 decimals
            token_max_b = int(usdc_amount * Decimal(10**6))  # USDC has 6 decimals

            # Calculate liquidity from token amounts
            # For simplicity, use a basic estimate based on geometric mean
            # Real calculation would need sqrt_price at ticks
            liquidity_amount = self._estimate_liquidity_from_amounts(
                pool_state, lower_tick, upper_tick, token_max_a, token_max_b
            )

            if liquidity_amount <= 0:
                # Provide a more informative error message
                error_detail = (
                    f"Could not calculate valid liquidity amount. "
                    f"SOL: {sol_amount}, USDC: {usdc_amount}, "
                    f"Lower tick: {lower_tick}, Upper tick: {upper_tick}, "
                    f"Current sqrt_price: {pool_state.sqrt_price}"
                )
                logger.warning("liquidity_calculation_failed", detail=error_detail)
                return PositionOperationResult(
                    success=False,
                    error_message="Could not calculate valid liquidity amount. Please check your inputs and try again."
                )

            # Execute the open position
            receipt = await self.execute_open_position(
                pool_pubkey=pool_pubkey,
                lower_tick=lower_tick,
                upper_tick=upper_tick,
                liquidity_amount=liquidity_amount,
                token_max_a=token_max_a,
                token_max_b=token_max_b,
            )

            if receipt.is_success:
                # Extract position pubkey from transaction
                # For now, we derive it from the expected address
                return PositionOperationResult(
                    success=True,
                    position_pubkey=receipt.signature,  # Use signature as reference
                    sol_amount=sol_amount,
                    usdc_amount=usdc_amount,
                )
            else:
                return PositionOperationResult(
                    success=False,
                    error_message=receipt.error or "Transaction failed",
                )

        except Exception as e:
            logger.error("open_position_with_liquidity_failed", error=str(e))
            return PositionOperationResult(
                success=False,
                error_message=str(e),
            )

    async def close_position(
        self,
        position_pubkey: str,
    ) -> "PositionOperationResult":
        """
        Close a position, withdrawing all liquidity and collecting fees.

        Args:
            position_pubkey: Position address to close

        Returns:
            PositionOperationResult with amounts received
        """
        logger.info("close_position", position=position_pubkey)

        try:
            # Get position state before closing to know amounts
            position_state = await self.get_position_state(position_pubkey)
            if position_state is None:
                return PositionOperationResult(
                    success=False,
                    error_message=f"Position not found: {position_pubkey}"
                )

            # Get pool state for price calculation
            pool_state = await self.get_pool_state(position_state.whirlpool)

            # Estimate token amounts from liquidity
            sol_amount, usdc_amount = self._estimate_amounts_from_liquidity(
                pool_state, position_state
            )

            # Get fee estimates
            fees_sol, fees_usdc = await self.estimate_fees_earned(position_pubkey)

            # Execute close
            receipt = await self.execute_close_position(
                position_pubkey=position_pubkey,
                collect_fees=True,
            )

            if receipt.is_success:
                return PositionOperationResult(
                    success=True,
                    position_pubkey=position_pubkey,
                    sol_amount=sol_amount,
                    usdc_amount=usdc_amount,
                    fees_sol=fees_sol,
                    fees_usdc=fees_usdc,
                )
            else:
                return PositionOperationResult(
                    success=False,
                    error_message=receipt.error or "Transaction failed",
                )

        except Exception as e:
            logger.error("close_position_failed", error=str(e))
            return PositionOperationResult(
                success=False,
                error_message=str(e),
            )

    async def collect_fees(
        self,
        position_pubkey: str,
    ) -> "PositionOperationResult":
        """
        Collect accumulated fees from a position.

        Args:
            position_pubkey: Position address

        Returns:
            PositionOperationResult with fee amounts collected
        """
        logger.info("collect_fees", position=position_pubkey)

        try:
            # Get fee estimates before collecting
            fees_sol, fees_usdc = await self.estimate_fees_earned(position_pubkey)

            # Build and execute collect fees transaction
            collect_ix_set = await self.build_collect_fees(position_pubkey)

            # Set priority fee from config if enabled
            priority_fee = None
            if settings.tx_priority_fee_enabled:
                priority_fee = settings.tx_priority_fee_microlamports

            bundle = TransactionBundle(
                instructions=collect_ix_set.instructions,
                signers=collect_ix_set.signers,
                description=f"Collect fees from {position_pubkey[:8]}...",
                priority_fee=priority_fee,
            )

            tx_manager = await self._get_transaction_manager()
            receipt = await tx_manager.submit_transaction(bundle)

            if receipt.is_success:
                return PositionOperationResult(
                    success=True,
                    position_pubkey=position_pubkey,
                    fees_sol=fees_sol,
                    fees_usdc=fees_usdc,
                )
            else:
                return PositionOperationResult(
                    success=False,
                    error_message=receipt.error or "Transaction failed",
                )

        except Exception as e:
            logger.error("collect_fees_failed", error=str(e))
            return PositionOperationResult(
                success=False,
                error_message=str(e),
            )

    def _estimate_liquidity_from_amounts(
        self,
        pool_state: PoolState,
        lower_tick: int,
        upper_tick: int,
        token_a_amount: int,
        token_b_amount: int,
    ) -> int:
        """
        Estimate liquidity amount from token deposits.

        Uses the concentrated liquidity formula to calculate liquidity
        based on the price range and deposit amounts.

        For concentrated liquidity math:
        - When price is below range: only token A is needed
        - When price is above range: only token B is needed
        - When price is in range: both tokens needed proportionally

        The formulas use sqrt prices in Q64.64 fixed-point format.
        """
        # Get sqrt prices at ticks (these are in Q64.64 format)
        sqrt_price_lower = tick_index_to_sqrt_price(lower_tick)
        sqrt_price_upper = tick_index_to_sqrt_price(upper_tick)
        sqrt_price_current = pool_state.sqrt_price

        # Validate tick range
        if sqrt_price_upper <= sqrt_price_lower:
            logger.warning(
                "invalid_tick_range",
                lower_tick=lower_tick,
                upper_tick=upper_tick,
                sqrt_price_lower=sqrt_price_lower,
                sqrt_price_upper=sqrt_price_upper,
            )
            return 0

        # If current price is below range, all tokens will be token A (SOL)
        if sqrt_price_current <= sqrt_price_lower:
            if token_a_amount == 0:
                logger.debug("liquidity_calc_price_below_range_no_token_a")
                return 0
            # L = amount_a * sqrt(P_lower) * sqrt(P_upper) / (sqrt(P_upper) - sqrt(P_lower))
            # Using Decimal for precision
            numerator = Decimal(token_a_amount) * Decimal(sqrt_price_lower) * Decimal(sqrt_price_upper)
            denominator = Decimal(sqrt_price_upper - sqrt_price_lower) * Decimal(Q64)
            if denominator == 0:
                return 0
            liquidity = int(numerator / denominator)
            logger.debug(
                "liquidity_calc_below_range",
                token_a=token_a_amount,
                liquidity=liquidity,
            )

        # If current price is above range, all tokens will be token B (USDC)
        elif sqrt_price_current >= sqrt_price_upper:
            if token_b_amount == 0:
                logger.debug("liquidity_calc_price_above_range_no_token_b")
                return 0
            # L = amount_b * Q64 / (sqrt(P_upper) - sqrt(P_lower))
            numerator = Decimal(token_b_amount) * Decimal(Q64)
            denominator = Decimal(sqrt_price_upper - sqrt_price_lower)
            if denominator == 0:
                return 0
            liquidity = int(numerator / denominator)
            logger.debug(
                "liquidity_calc_above_range",
                token_b=token_b_amount,
                liquidity=liquidity,
            )

        # Price is within range - both tokens are used
        else:
            # Calculate liquidity from each token separately
            liq_a = 0
            liq_b = 0

            if token_a_amount > 0:
                # L = amount_a * sqrt(P_current) * sqrt(P_upper) / (sqrt(P_upper) - sqrt(P_current)) / Q64
                # Rearranged for precision: L = amount_a * sqrt(P_current) * sqrt(P_upper) / ((sqrt(P_upper) - sqrt(P_current)) * Q64)
                sqrt_diff_upper = sqrt_price_upper - sqrt_price_current
                if sqrt_diff_upper > 0:
                    numerator = Decimal(token_a_amount) * Decimal(sqrt_price_current) * Decimal(sqrt_price_upper)
                    denominator = Decimal(sqrt_diff_upper) * Decimal(Q64)
                    liq_a = int(numerator / denominator)

            if token_b_amount > 0:
                # L = amount_b * Q64 / (sqrt(P_current) - sqrt(P_lower))
                sqrt_diff_lower = sqrt_price_current - sqrt_price_lower
                if sqrt_diff_lower > 0:
                    numerator = Decimal(token_b_amount) * Decimal(Q64)
                    denominator = Decimal(sqrt_diff_lower)
                    liq_b = int(numerator / denominator)

            logger.debug(
                "liquidity_calc_in_range",
                token_a=token_a_amount,
                token_b=token_b_amount,
                liq_a=liq_a,
                liq_b=liq_b,
                sqrt_price_current=sqrt_price_current,
                sqrt_price_lower=sqrt_price_lower,
                sqrt_price_upper=sqrt_price_upper,
            )

            # Determine liquidity based on what tokens were provided
            if liq_a > 0 and liq_b > 0:
                # Both tokens provided - use minimum to avoid over-depositing one token
                liquidity = min(liq_a, liq_b)
            elif liq_a > 0:
                # Only token A (SOL) provided for in-range position
                # This is valid - the position will be partially filled
                liquidity = liq_a
            elif liq_b > 0:
                # Only token B (USDC) provided for in-range position
                # This is valid - the position will be partially filled
                liquidity = liq_b
            else:
                # No valid liquidity could be calculated
                logger.warning(
                    "liquidity_calc_no_valid_amount",
                    token_a=token_a_amount,
                    token_b=token_b_amount,
                )
                return 0

        return max(liquidity, 0)

    def _estimate_amounts_from_liquidity(
        self,
        pool_state: PoolState,
        position_state: "PositionState",
    ) -> Tuple[Decimal, Decimal]:
        """
        Estimate token amounts from position liquidity.
        """
        liquidity = position_state.liquidity
        if liquidity == 0:
            return (Decimal(0), Decimal(0))

        sqrt_price_lower = tick_index_to_sqrt_price(position_state.tick_lower_index)
        sqrt_price_upper = tick_index_to_sqrt_price(position_state.tick_upper_index)
        sqrt_price_current = pool_state.sqrt_price

        # Calculate amounts based on current price position
        if sqrt_price_current <= sqrt_price_lower:
            # All token A
            amount_a = liquidity * (sqrt_price_upper - sqrt_price_lower) * Q64 / (sqrt_price_lower * sqrt_price_upper)
            amount_b = 0
        elif sqrt_price_current >= sqrt_price_upper:
            # All token B
            amount_a = 0
            amount_b = liquidity * (sqrt_price_upper - sqrt_price_lower) / Q64
        else:
            # Mix of both
            amount_a = liquidity * (sqrt_price_upper - sqrt_price_current) * Q64 / (sqrt_price_current * sqrt_price_upper)
            amount_b = liquidity * (sqrt_price_current - sqrt_price_lower) / Q64

        # Convert to token amounts (SOL: 9 decimals, USDC: 6 decimals)
        sol_amount = Decimal(int(amount_a)) / Decimal(10**9)
        usdc_amount = Decimal(int(amount_b)) / Decimal(10**6)

        return (sol_amount, usdc_amount)


@dataclass
class PositionOperationResult:
    """Result of a position operation (open/close/collect fees)."""
    success: bool
    position_pubkey: Optional[str] = None
    sol_amount: Optional[Decimal] = None
    usdc_amount: Optional[Decimal] = None
    fees_sol: Optional[Decimal] = None
    fees_usdc: Optional[Decimal] = None
    error_message: Optional[str] = None


# Singleton instance
_default_client: Optional[OrcaClient] = None


async def get_orca_client() -> OrcaClient:
    """Get or create the default Orca client singleton."""
    global _default_client
    if _default_client is None:
        _default_client = OrcaClient()
    return _default_client
