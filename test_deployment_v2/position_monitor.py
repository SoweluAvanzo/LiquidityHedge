"""
Position Monitor Module for LP Strategy v2.

Adapted from v1 position_monitor.py with modular design.
Monitors Orca Whirlpool positions and provides real-time metrics.
"""

import asyncio
import struct
import math
import logging
import random
from datetime import datetime, timezone
from dataclasses import dataclass
from typing import Optional, Tuple, List, Dict, Any
from decimal import Decimal

import httpx
from solders.pubkey import Pubkey
import base58

from config import get_config, Config

logger = logging.getLogger(__name__)

# Math constants
Q64 = 2**64
Q128 = 2**128

# Orca Whirlpool program
WHIRLPOOL_PROGRAM_ID = "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc"
TICK_ARRAY_SIZE = 88


# ============================================================
# DATA TYPES
# ============================================================

@dataclass
class PoolState:
    """Orca Whirlpool pool state."""
    pubkey: str
    token_mint_a: str
    token_mint_b: str
    tick_spacing: int
    tick_current_index: int
    sqrt_price: int
    liquidity: int
    fee_rate: int
    protocol_fee_rate: int
    fee_growth_global_a: int
    fee_growth_global_b: int
    token_a_decimals: int = 9
    token_b_decimals: int = 6

    @property
    def current_price(self) -> float:
        """Price adjusted for token decimals (B per A)."""
        sqrt_price_decimal = self.sqrt_price / Q64
        raw_price = sqrt_price_decimal ** 2
        decimal_adjustment = 10 ** (self.token_a_decimals - self.token_b_decimals)
        return raw_price * decimal_adjustment


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

    def get_price_range(self, decimal_adjustment: int = 3) -> Tuple[float, float]:
        """Get price range as (lower, upper)."""
        lower = tick_to_price(self.tick_lower_index, decimal_adjustment)
        upper = tick_to_price(self.tick_upper_index, decimal_adjustment)
        return (lower, upper)


@dataclass
class TickData:
    """Data for a single tick."""
    initialized: bool
    liquidity_net: int
    liquidity_gross: int
    fee_growth_outside_a: int
    fee_growth_outside_b: int


@dataclass
class PositionSnapshot:
    """Point-in-time position metrics."""
    timestamp: datetime
    position_address: str

    # Price data
    current_price: Decimal
    open_price: Decimal
    price_change_pct: Decimal

    # Range info
    lower_price: Decimal
    upper_price: Decimal
    is_in_range: bool

    # Current holdings
    current_token_a: Decimal  # SOL
    current_token_b: Decimal  # USDC
    current_value_usd: Decimal

    # Initial holdings (at open)
    initial_token_a: Decimal
    initial_token_b: Decimal
    initial_value_usd: Decimal

    # Token ratio
    token_a_ratio: Decimal  # 0-1, share of value in token A

    # Impermanent Loss
    hold_value_usd: Decimal
    il_usd: Decimal
    il_pct: Decimal

    # Fees
    pending_fees_a: Decimal
    pending_fees_b: Decimal
    pending_fees_usd: Decimal

    # TX costs
    tx_fees_sol: Decimal
    tx_fees_usd: Decimal

    def to_dict(self) -> dict:
        """Convert to dictionary."""
        return {
            'timestamp': self.timestamp.isoformat(),
            'position': self.position_address[:8] + '...',
            'price': float(self.current_price),
            'price_change_pct': float(self.price_change_pct),
            'in_range': self.is_in_range,
            'token_a': float(self.current_token_a),
            'token_b': float(self.current_token_b),
            'value_usd': float(self.current_value_usd),
            'token_a_ratio': float(self.token_a_ratio),
            'il_usd': float(self.il_usd),
            'il_pct': float(self.il_pct),
            'pending_fees_usd': float(self.pending_fees_usd),
        }


# ============================================================
# MATH UTILITIES
# ============================================================

def tick_to_price(tick: int, decimal_adjustment: int = 3) -> float:
    """Convert tick index to price."""
    raw_price = math.pow(1.0001, tick)
    return raw_price * (10 ** decimal_adjustment)


def tick_index_to_sqrt_price(tick: int) -> int:
    """Convert tick index to sqrt price (Q64.64 format)."""
    price = math.pow(1.0001, tick)
    sqrt_price = math.sqrt(price)
    return int(sqrt_price * Q64)


def estimate_amounts_from_liquidity(
    pool_state: PoolState,
    position_state: PositionState,
) -> Tuple[Decimal, Decimal]:
    """Estimate token amounts from position liquidity."""
    liquidity = position_state.liquidity
    if liquidity == 0:
        return (Decimal(0), Decimal(0))

    sqrt_price_lower = tick_index_to_sqrt_price(position_state.tick_lower_index)
    sqrt_price_upper = tick_index_to_sqrt_price(position_state.tick_upper_index)
    sqrt_price_current = pool_state.sqrt_price

    if sqrt_price_current <= sqrt_price_lower:
        amount_a = liquidity * (sqrt_price_upper - sqrt_price_lower) * Q64 / (sqrt_price_lower * sqrt_price_upper)
        amount_b = 0
    elif sqrt_price_current >= sqrt_price_upper:
        amount_a = 0
        amount_b = liquidity * (sqrt_price_upper - sqrt_price_lower) / Q64
    else:
        amount_a = liquidity * (sqrt_price_upper - sqrt_price_current) * Q64 / (sqrt_price_current * sqrt_price_upper)
        amount_b = liquidity * (sqrt_price_current - sqrt_price_lower) / Q64

    token_a_amount = Decimal(int(amount_a)) / Decimal(10**pool_state.token_a_decimals)
    token_b_amount = Decimal(int(amount_b)) / Decimal(10**pool_state.token_b_decimals)

    return (token_a_amount, token_b_amount)


def estimate_amounts_at_price(
    position_state: PositionState,
    pool_state: PoolState,
    target_price: float
) -> Tuple[Decimal, Decimal]:
    """Estimate token amounts at a specific price."""
    liquidity = position_state.liquidity
    if liquidity == 0:
        return (Decimal(0), Decimal(0))

    decimal_adjustment = pool_state.token_a_decimals - pool_state.token_b_decimals
    raw_price = target_price / (10 ** decimal_adjustment)
    sqrt_price_target = int(math.sqrt(raw_price) * Q64)

    sqrt_price_lower = tick_index_to_sqrt_price(position_state.tick_lower_index)
    sqrt_price_upper = tick_index_to_sqrt_price(position_state.tick_upper_index)

    if sqrt_price_target <= sqrt_price_lower:
        amount_a = liquidity * (sqrt_price_upper - sqrt_price_lower) * Q64 / (sqrt_price_lower * sqrt_price_upper)
        amount_b = 0
    elif sqrt_price_target >= sqrt_price_upper:
        amount_a = 0
        amount_b = liquidity * (sqrt_price_upper - sqrt_price_lower) / Q64
    else:
        amount_a = liquidity * (sqrt_price_upper - sqrt_price_target) * Q64 / (sqrt_price_target * sqrt_price_upper)
        amount_b = liquidity * (sqrt_price_target - sqrt_price_lower) / Q64

    token_a_amount = Decimal(int(amount_a)) / Decimal(10**pool_state.token_a_decimals)
    token_b_amount = Decimal(int(amount_b)) / Decimal(10**pool_state.token_b_decimals)

    return (token_a_amount, token_b_amount)


# ============================================================
# ACCOUNT DECODERS
# ============================================================

def decode_whirlpool(pubkey: str, data: bytes) -> PoolState:
    """Decode Whirlpool account data."""
    offset = 8  # Skip discriminator

    offset += 32  # whirlpoolsConfig
    offset += 1   # whirlpoolBump

    tick_spacing = struct.unpack_from("<H", data, offset)[0]
    offset += 2
    offset += 2  # tickSpacingSeed

    fee_rate = struct.unpack_from("<H", data, offset)[0]
    offset += 2

    protocol_fee_rate = struct.unpack_from("<H", data, offset)[0]
    offset += 2

    liquidity = int.from_bytes(data[offset:offset+16], "little")
    offset += 16

    sqrt_price = int.from_bytes(data[offset:offset+16], "little")
    offset += 16

    tick_current_index = struct.unpack_from("<i", data, offset)[0]
    offset += 4

    offset += 8  # protocolFeeOwedA
    offset += 8  # protocolFeeOwedB

    token_mint_a = base58.b58encode(data[offset:offset+32]).decode()
    offset += 32
    offset += 32  # tokenVaultA

    fee_growth_global_a = int.from_bytes(data[offset:offset+16], "little")
    offset += 16

    token_mint_b = base58.b58encode(data[offset:offset+32]).decode()
    offset += 32
    offset += 32  # tokenVaultB

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
    )


def decode_position(pubkey: str, data: bytes) -> PositionState:
    """Decode Position account data."""
    offset = 8  # Skip discriminator

    whirlpool = base58.b58encode(data[offset:offset+32]).decode()
    offset += 32

    position_mint = base58.b58encode(data[offset:offset+32]).decode()
    offset += 32

    liquidity = int.from_bytes(data[offset:offset+16], "little")
    offset += 16

    tick_lower_index = struct.unpack_from("<i", data, offset)[0]
    offset += 4

    tick_upper_index = struct.unpack_from("<i", data, offset)[0]
    offset += 4

    fee_growth_checkpoint_a = int.from_bytes(data[offset:offset+16], "little")
    offset += 16

    fee_owed_a = struct.unpack_from("<Q", data, offset)[0]
    offset += 8

    fee_growth_checkpoint_b = int.from_bytes(data[offset:offset+16], "little")
    offset += 16

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


def decode_tick_array(data: bytes, tick_spacing: int) -> Dict[int, TickData]:
    """Decode tick array and return tick data map."""
    offset = 8  # Skip discriminator
    start_tick_index = struct.unpack_from("<i", data, offset)[0]
    offset += 4

    ticks = {}
    TICK_SIZE = 113

    for i in range(TICK_ARRAY_SIZE):
        tick_offset = offset + i * TICK_SIZE

        initialized = data[tick_offset] != 0
        tick_offset += 1

        liquidity_net = int.from_bytes(data[tick_offset:tick_offset+16], "little", signed=True)
        tick_offset += 16

        liquidity_gross = int.from_bytes(data[tick_offset:tick_offset+16], "little")
        tick_offset += 16

        fee_growth_outside_a = int.from_bytes(data[tick_offset:tick_offset+16], "little")
        tick_offset += 16

        fee_growth_outside_b = int.from_bytes(data[tick_offset:tick_offset+16], "little")

        tick_index = start_tick_index + i * tick_spacing
        ticks[tick_index] = TickData(
            initialized=initialized,
            liquidity_net=liquidity_net,
            liquidity_gross=liquidity_gross,
            fee_growth_outside_a=fee_growth_outside_a,
            fee_growth_outside_b=fee_growth_outside_b,
        )

    return ticks


# ============================================================
# RPC CLIENT
# ============================================================

class SolanaRPCClient:
    """Simple Solana RPC client."""

    def __init__(self, rpc_url: str):
        self.rpc_url = rpc_url
        self._request_id = 0

    async def _call(self, method: str, params: List = None) -> Any:
        self._request_id += 1
        payload = {
            "jsonrpc": "2.0",
            "id": self._request_id,
            "method": method,
            "params": params or []
        }

        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(self.rpc_url, json=payload)
            data = resp.json()

            if "error" in data:
                raise Exception(f"RPC error: {data['error']}")

            return data.get("result")

    async def get_account_info(self, pubkey: str, encoding: str = "base64") -> Optional[Dict]:
        """Get account info."""
        result = await self._call("getAccountInfo", [
            pubkey,
            {"encoding": encoding, "commitment": "confirmed"}
        ])
        return result.get("value") if result else None

    async def get_multiple_accounts(self, pubkeys: List[str]) -> List[Optional[Dict]]:
        """Get multiple accounts in one call."""
        result = await self._call("getMultipleAccounts", [
            pubkeys,
            {"encoding": "base64", "commitment": "confirmed"}
        ])
        return result.get("value", []) if result else []


# ============================================================
# POSITION MONITOR
# ============================================================

class PositionMonitor:
    """
    Monitors an Orca Whirlpool position.

    Provides real-time metrics including:
    - Current holdings and value
    - Price and range status
    - Impermanent loss
    - Pending fees
    - Token ratio (for rebalance decisions)

    IL Calculation Notes:
    - IL compares current position value vs "HODL value" (what tokens would be worth if just held)
    - HODL value = (initial_token_a * current_price) + initial_token_b
    - For accurate IL, we need the ACTUAL deposited amounts, not estimated amounts from liquidity
    - When creating a new position, pass initial_token_a and initial_token_b from the open result
    """

    def __init__(
        self,
        rpc_client: SolanaRPCClient,
        position_address: str,
        open_price: Optional[float] = None,
        config: Optional[Config] = None,
        initial_token_a: Optional[float] = None,  # Actual deposited SOL amount
        initial_token_b: Optional[float] = None,  # Actual deposited USDC amount
    ):
        self.rpc = rpc_client
        self.position_address = position_address
        self.config = config or get_config()

        # Opening data - use actual deposited amounts if provided
        self.open_price = Decimal(str(open_price)) if open_price else None
        self.open_timestamp: Optional[datetime] = None
        self.initial_token_a: Optional[Decimal] = Decimal(str(initial_token_a)) if initial_token_a is not None else None
        self.initial_token_b: Optional[Decimal] = Decimal(str(initial_token_b)) if initial_token_b is not None else None

        # Cached states
        self._pool_state: Optional[PoolState] = None
        self._position_state: Optional[PositionState] = None

        # Cumulative tracking
        self.cumulative_tx_fees_sol = Decimal(0)

    async def initialize(self) -> bool:
        """Initialize monitor and fetch position data."""
        try:
            position = await self._get_position_state()
            if not position:
                logger.error(f"Position not found: {self.position_address}")
                return False

            pool = await self._get_pool_state(position.whirlpool)
            if not pool:
                logger.error(f"Pool not found: {position.whirlpool}")
                return False

            # IMPORTANT: Use actual deposited amounts if provided (most accurate for IL)
            # Only estimate from liquidity if not provided
            if self.initial_token_a is None or self.initial_token_b is None:
                if self.open_price:
                    # Estimate based on open price and liquidity
                    self.initial_token_a, self.initial_token_b = estimate_amounts_at_price(
                        position, pool, float(self.open_price)
                    )
                    logger.info(f"  Initial amounts estimated from open price and liquidity")
                else:
                    # Fallback: Use current amounts as initial (IL will start at 0)
                    self.initial_token_a, self.initial_token_b = estimate_amounts_from_liquidity(pool, position)
                    self.open_price = Decimal(str(pool.current_price))
                    logger.info(f"  Initial amounts from current position (IL starts at 0)")
            else:
                logger.info(f"  Initial amounts from actual deposited values (accurate IL)")

            # Set open price if not provided
            if not self.open_price:
                self.open_price = Decimal(str(pool.current_price))

            self.open_timestamp = datetime.now(timezone.utc)

            # Calculate initial value for logging
            initial_value_usd = (self.initial_token_a * self.open_price) + self.initial_token_b

            lower, upper = position.get_price_range(pool.token_a_decimals - pool.token_b_decimals)
            logger.info(f"Position initialized: {self.position_address[:16]}...")
            logger.info(f"  Range: ${lower:.4f} - ${upper:.4f}")
            logger.info(f"  Open price: ${self.open_price:.4f}")
            logger.info(f"  Initial: {self.initial_token_a:.6f} SOL + {self.initial_token_b:.2f} USDC")
            logger.info(f"  Initial value: ${initial_value_usd:.2f} (HODL baseline)")

            return True

        except Exception as e:
            logger.error(f"Failed to initialize position monitor: {e}")
            return False

    async def _get_account_data(self, pubkey: str) -> Optional[bytes]:
        """Fetch and decode account data."""
        account = await self.rpc.get_account_info(pubkey)
        if not account:
            return None

        import base64
        data = account['data']
        if isinstance(data, list):
            return base64.b64decode(data[0])
        return base64.b64decode(data)

    async def _get_pool_state(self, pool_address: Optional[str] = None) -> Optional[PoolState]:
        """Fetch pool state."""
        address = pool_address or (self._position_state.whirlpool if self._position_state else None)
        if not address:
            return None

        data = await self._get_account_data(address)
        if not data:
            return None

        self._pool_state = decode_whirlpool(address, data)
        return self._pool_state

    async def _get_position_state(self) -> Optional[PositionState]:
        """Fetch position state."""
        data = await self._get_account_data(self.position_address)
        if not data:
            return None

        self._position_state = decode_position(self.position_address, data)
        return self._position_state

    def _get_tick_array_pda(self, whirlpool: str, start_tick: int) -> str:
        """Derive tick array PDA."""
        whirlpool_pubkey = Pubkey.from_string(whirlpool)
        program_id = Pubkey.from_string(WHIRLPOOL_PROGRAM_ID)
        start_tick_str = str(start_tick).encode()

        pda, _ = Pubkey.find_program_address(
            [b"tick_array", bytes(whirlpool_pubkey), start_tick_str],
            program_id,
        )
        return str(pda)

    async def _get_tick_data(self, tick_index: int, pool: PoolState) -> Optional[TickData]:
        """Fetch tick data from tick array."""
        ticks_in_array = TICK_ARRAY_SIZE * pool.tick_spacing
        start_tick = (tick_index // ticks_in_array) * ticks_in_array

        tick_array_pda = self._get_tick_array_pda(pool.pubkey, start_tick)
        data = await self._get_account_data(tick_array_pda)
        if not data:
            return None

        ticks = decode_tick_array(data, pool.tick_spacing)
        return ticks.get(tick_index)

    async def _calculate_pending_fees(
        self,
        position: PositionState,
        pool: PoolState
    ) -> Tuple[int, int]:
        """Calculate uncollected fees."""
        tick_lower_data = await self._get_tick_data(position.tick_lower_index, pool)
        tick_upper_data = await self._get_tick_data(position.tick_upper_index, pool)

        if not tick_lower_data or not tick_upper_data:
            return (position.fee_owed_a, position.fee_owed_b)

        # Calculate fee growth inside range
        def calc_fee_growth_inside(is_token_a: bool) -> int:
            if is_token_a:
                fg_global = pool.fee_growth_global_a
                fg_outside_lower = tick_lower_data.fee_growth_outside_a
                fg_outside_upper = tick_upper_data.fee_growth_outside_a
            else:
                fg_global = pool.fee_growth_global_b
                fg_outside_lower = tick_lower_data.fee_growth_outside_b
                fg_outside_upper = tick_upper_data.fee_growth_outside_b

            if pool.tick_current_index >= position.tick_lower_index:
                fg_below = fg_outside_lower
            else:
                fg_below = fg_global - fg_outside_lower

            if pool.tick_current_index < position.tick_upper_index:
                fg_above = fg_outside_upper
            else:
                fg_above = fg_global - fg_outside_upper

            return (fg_global - fg_below - fg_above) % Q128

        fg_inside_a = calc_fee_growth_inside(True)
        fg_inside_b = calc_fee_growth_inside(False)

        delta_a = (fg_inside_a - position.fee_growth_checkpoint_a) % Q128
        delta_b = (fg_inside_b - position.fee_growth_checkpoint_b) % Q128

        uncollected_a = position.fee_owed_a + ((delta_a * position.liquidity) // Q64)
        uncollected_b = position.fee_owed_b + ((delta_b * position.liquidity) // Q64)

        return (uncollected_a, uncollected_b)

    async def get_snapshot(self, max_retries: int = 3) -> Optional[PositionSnapshot]:
        """
        Get current position snapshot with retry logic for transient errors.

        Returns:
            PositionSnapshot if successful
            None if position truly doesn't exist (after retries)

        The retry logic helps distinguish between:
        - Transient RPC errors (retry and succeed)
        - Position actually closed/missing (return None after all retries fail)
        """
        last_error = None

        for attempt in range(max_retries):
            try:
                position = await self._get_position_state()
                pool = await self._get_pool_state()

                if not position or not pool:
                    if attempt < max_retries - 1:
                        # Could be transient, retry
                        logger.warning(
                            f"Position/pool query returned None (attempt {attempt + 1}/{max_retries}), retrying..."
                        )
                        # Add jitter to prevent synchronized RPC load from multiple instances
                        base_delay = 1.0 * (attempt + 1)
                        jitter = base_delay * random.uniform(0, 0.2)
                        await asyncio.sleep(base_delay + jitter)
                        continue
                    else:
                        # All retries exhausted - position likely doesn't exist
                        logger.error(
                            f"Position query returned None after {max_retries} attempts - "
                            f"position likely closed or never existed"
                        )
                        return None

                current_price = Decimal(str(pool.current_price))
                decimal_adj = pool.token_a_decimals - pool.token_b_decimals

                # Range info
                lower, upper = position.get_price_range(decimal_adj)
                is_in_range = (
                    pool.tick_current_index >= position.tick_lower_index and
                    pool.tick_current_index < position.tick_upper_index
                )

                # Current amounts
                current_a, current_b = estimate_amounts_from_liquidity(pool, position)
                current_value = (current_a * current_price) + current_b

                # Initial amounts (calculated at init)
                initial_a = self.initial_token_a or current_a
                initial_b = self.initial_token_b or current_b
                open_price = self.open_price or current_price
                initial_value = (initial_a * open_price) + initial_b

                # Token ratio (share of value in token A)
                if current_value > 0:
                    token_a_ratio = (current_a * current_price) / current_value
                else:
                    token_a_ratio = Decimal("0.5")

                # Hold value and IL
                hold_value = (initial_a * current_price) + initial_b
                il_usd = current_value - hold_value
                il_pct = (il_usd / hold_value * 100) if hold_value > 0 else Decimal(0)

                # Price change
                price_change_pct = ((current_price - open_price) / open_price * 100) if open_price > 0 else Decimal(0)

                # Pending fees
                fees_a, fees_b = await self._calculate_pending_fees(position, pool)
                pending_a = Decimal(fees_a) / Decimal(10**pool.token_a_decimals)
                pending_b = Decimal(fees_b) / Decimal(10**pool.token_b_decimals)
                pending_usd = (pending_a * current_price) + pending_b

                # TX fees
                tx_fees_usd = self.cumulative_tx_fees_sol * current_price

                return PositionSnapshot(
                    timestamp=datetime.now(timezone.utc),
                    position_address=self.position_address,
                    current_price=current_price,
                    open_price=open_price,
                    price_change_pct=price_change_pct,
                    lower_price=Decimal(str(lower)),
                    upper_price=Decimal(str(upper)),
                    is_in_range=is_in_range,
                    current_token_a=current_a,
                    current_token_b=current_b,
                    current_value_usd=current_value,
                    initial_token_a=initial_a,
                    initial_token_b=initial_b,
                    initial_value_usd=initial_value,
                    token_a_ratio=token_a_ratio,
                    hold_value_usd=hold_value,
                    il_usd=il_usd,
                    il_pct=il_pct,
                    pending_fees_a=pending_a,
                    pending_fees_b=pending_b,
                    pending_fees_usd=pending_usd,
                    tx_fees_sol=self.cumulative_tx_fees_sol,
                    tx_fees_usd=tx_fees_usd,
                )

            except Exception as e:
                last_error = e
                if attempt < max_retries - 1:
                    logger.warning(
                        f"Error getting snapshot (attempt {attempt + 1}/{max_retries}): {e}. Retrying..."
                    )
                    await asyncio.sleep(1.0 * (attempt + 1))  # Backoff
                    continue
                else:
                    logger.error(
                        f"Error getting snapshot after {max_retries} attempts: {e}"
                    )
                    return None

        # Should not reach here, but return None as fallback
        logger.error(f"get_snapshot exhausted all retries. Last error: {last_error}")
        return None

    def add_tx_fee(self, fee_sol: Decimal) -> None:
        """Add transaction fee to cumulative total."""
        self.cumulative_tx_fees_sol += fee_sol

    def check_out_of_range(self, snapshot: PositionSnapshot) -> bool:
        """Check if position is out of range."""
        return not snapshot.is_in_range

    def check_ratio_skew(self, snapshot: PositionSnapshot) -> bool:
        """Check if token ratio is skewed beyond thresholds."""
        ratio = float(snapshot.token_a_ratio)
        return (
            ratio >= self.config.rebalance.ratio_skew_high or
            ratio <= self.config.rebalance.ratio_skew_low
        )


async def main():
    """Test the position monitor."""
    import sys
    from dotenv import load_dotenv
    import os

    load_dotenv()

    logging.basicConfig(
        level=logging.INFO,
        format='%(asctime)s [%(levelname)s] %(message)s',
        handlers=[logging.StreamHandler(sys.stdout)]
    )

    rpc_url = os.getenv('SOLANA_RPC_URL')
    if not rpc_url:
        print("SOLANA_RPC_URL required")
        return

    # Test with a position address
    position = os.getenv('POSITION_ADDRESS', 'GV7X2KmrWbqQ8MaGVzrXd7b8RKFHRztY4wUEy9drDaAr')
    open_price = float(os.getenv('OPEN_PRICE', '138.697'))

    rpc = SolanaRPCClient(rpc_url)
    monitor = PositionMonitor(rpc, position, open_price)

    if await monitor.initialize():
        snapshot = await monitor.get_snapshot()
        if snapshot:
            print("\n" + "=" * 50)
            print("POSITION SNAPSHOT")
            print("=" * 50)
            for key, value in snapshot.to_dict().items():
                print(f"  {key}: {value}")
            print("=" * 50)


if __name__ == "__main__":
    asyncio.run(main())
