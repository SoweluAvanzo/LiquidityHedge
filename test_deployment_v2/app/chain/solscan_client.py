"""
Solscan Pro API client for historical pool data.

Provides:
1. Market/pool data (TVL proxy, volume, trades)
2. DeFi activities (swaps, liquidity adds/removes)
3. Historical transfer data

Solscan Pro API: https://pro-api.solscan.io/pro-api-docs/v2.0
"""

from dataclasses import dataclass, field
from datetime import datetime, timezone, timedelta
from decimal import Decimal
from typing import Optional, List, Dict, Any, Literal
from enum import Enum
import asyncio

import httpx
import structlog

from app.config import get_settings

logger = structlog.get_logger(__name__)
settings = get_settings()


class DeFiActivityType(str, Enum):
    """DeFi activity types supported by Solscan."""
    TOKEN_SWAP = "ACTIVITY_TOKEN_SWAP"
    AGG_TOKEN_SWAP = "ACTIVITY_AGG_TOKEN_SWAP"
    TOKEN_ADD_LIQ = "ACTIVITY_TOKEN_ADD_LIQ"
    TOKEN_REMOVE_LIQ = "ACTIVITY_TOKEN_REMOVE_LIQ"
    POOL_CREATE = "ACTIVITY_POOL_CREATE"
    SPL_TOKEN_STAKE = "ACTIVITY_SPL_TOKEN_STAKE"
    LST_STAKE = "ACTIVITY_LST_STAKE"
    SPL_TOKEN_UNSTAKE = "ACTIVITY_SPL_TOKEN_UNSTAKE"
    LST_UNSTAKE = "ACTIVITY_LST_UNSTAKE"
    TOKEN_DEPOSIT_VAULT = "ACTIVITY_TOKEN_DEPOSIT_VAULT"
    TOKEN_WITHDRAW_VAULT = "ACTIVITY_TOKEN_WITHDRAW_VAULT"


class TransferActivityType(str, Enum):
    """Transfer activity types supported by Solscan."""
    SPL_TRANSFER = "ACTIVITY_SPL_TRANSFER"
    SPL_BURN = "ACTIVITY_SPL_BURN"
    SPL_MINT = "ACTIVITY_SPL_MINT"
    SPL_CREATE_ACCOUNT = "ACTIVITY_SPL_CREATE_ACCOUNT"
    SPL_CLOSE_ACCOUNT = "ACTIVITY_SPL_CLOSE_ACCOUNT"


@dataclass
class PoolMarket:
    """Pool/market data from Solscan."""
    pool_address: str
    program_id: str
    token1: str
    token1_account: str
    token2: str
    token2_account: str
    created_time: datetime
    total_trades_24h: int
    total_volume_24h: float

    @classmethod
    def from_api_response(cls, data: Dict[str, Any]) -> "PoolMarket":
        """Create from Solscan API response."""
        return cls(
            pool_address=data.get("pool_address", ""),
            program_id=data.get("program_id", ""),
            token1=data.get("token1", ""),
            token1_account=data.get("token1_account", ""),
            token2=data.get("token2", ""),
            token2_account=data.get("token2_account", ""),
            created_time=datetime.fromtimestamp(
                data.get("created_time", 0), tz=timezone.utc
            ),
            total_trades_24h=data.get("total_trades_24h", 0),
            total_volume_24h=float(data.get("total_volume_24h", 0)),
        )


@dataclass
class DeFiActivity:
    """DeFi activity record from Solscan."""
    block_id: int
    trans_id: str
    block_time: datetime
    activity_type: str
    from_address: str
    to_address: str
    platform: str
    source: str

    # Token swap details (for swap activities)
    token1: Optional[str] = None
    token1_amount: Optional[float] = None
    token1_decimals: Optional[int] = None
    token2: Optional[str] = None
    token2_amount: Optional[float] = None
    token2_decimals: Optional[int] = None

    # Value in USD (if available)
    value_usd: Optional[float] = None

    @classmethod
    def from_api_response(cls, data: Dict[str, Any]) -> "DeFiActivity":
        """Create from Solscan API response."""
        block_time = data.get("block_time", 0)
        if isinstance(block_time, str):
            block_time_dt = datetime.fromisoformat(block_time.replace("Z", "+00:00"))
        else:
            block_time_dt = datetime.fromtimestamp(block_time, tz=timezone.utc)

        return cls(
            block_id=data.get("block_id", 0),
            trans_id=data.get("trans_id", ""),
            block_time=block_time_dt,
            activity_type=data.get("activity_type", ""),
            from_address=data.get("from_address", ""),
            to_address=data.get("to_address", ""),
            platform=data.get("platform", ""),
            source=data.get("source", ""),
            token1=data.get("token1"),
            token1_amount=float(data["token1_amount"]) if data.get("token1_amount") else None,
            token1_decimals=data.get("token1_decimals"),
            token2=data.get("token2"),
            token2_amount=float(data["token2_amount"]) if data.get("token2_amount") else None,
            token2_decimals=data.get("token2_decimals"),
            value_usd=float(data["value"]) if data.get("value") else None,
        )


@dataclass
class TokenTransfer:
    """Token transfer record from Solscan."""
    block_id: int
    trans_id: str
    block_time: datetime
    activity_type: str
    from_address: str
    to_address: str
    token_address: str
    token_decimals: int
    amount: int  # Raw amount (before decimals)
    flow: str  # "in" or "out"

    @property
    def amount_decimal(self) -> Decimal:
        """Get amount with decimals applied."""
        return Decimal(self.amount) / Decimal(10 ** self.token_decimals)

    @classmethod
    def from_api_response(cls, data: Dict[str, Any]) -> "TokenTransfer":
        """Create from Solscan API response."""
        block_time = data.get("block_time", 0)
        if isinstance(block_time, str):
            block_time_dt = datetime.fromisoformat(block_time.replace("Z", "+00:00"))
        else:
            block_time_dt = datetime.fromtimestamp(block_time, tz=timezone.utc)

        return cls(
            block_id=data.get("block_id", 0),
            trans_id=data.get("trans_id", ""),
            block_time=block_time_dt,
            activity_type=data.get("activity_type", ""),
            from_address=data.get("from_address", ""),
            to_address=data.get("to_address", ""),
            token_address=data.get("token_address", ""),
            token_decimals=data.get("token_decimals", 0),
            amount=data.get("amount", 0),
            flow=data.get("flow", ""),
        )


@dataclass
class DailyPoolStats:
    """Aggregated daily pool statistics."""
    date: datetime
    pool_address: str
    volume_usd: float
    trade_count: int
    add_liquidity_count: int
    remove_liquidity_count: int
    net_liquidity_usd: float  # adds - removes
    avg_swap_size_usd: float

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary."""
        return {
            "date": self.date.isoformat(),
            "pool_address": self.pool_address,
            "volume_usd": self.volume_usd,
            "trade_count": self.trade_count,
            "add_liquidity_count": self.add_liquidity_count,
            "remove_liquidity_count": self.remove_liquidity_count,
            "net_liquidity_usd": self.net_liquidity_usd,
            "avg_swap_size_usd": self.avg_swap_size_usd,
        }


@dataclass
class TokenBalance:
    """Token balance in a portfolio."""
    token_address: str
    token_symbol: str
    token_name: str
    token_decimals: int
    amount: int  # Raw amount
    balance: float  # Adjusted balance
    token_price: float  # USD price
    value: float  # USD value

    @classmethod
    def from_api_response(cls, data: Dict[str, Any]) -> "TokenBalance":
        """Create from Solscan API response."""
        return cls(
            token_address=data.get("token_address", ""),
            token_symbol=data.get("token_symbol", ""),
            token_name=data.get("token_name", ""),
            token_decimals=data.get("token_decimals", 0),
            amount=data.get("amount", 0),
            balance=float(data.get("balance", 0)),
            token_price=float(data.get("token_price", 0)),
            value=float(data.get("value", 0)),
        )


@dataclass
class AccountPortfolio:
    """Account portfolio with TVL calculation."""
    address: str
    total_value: float  # Total USD value (TVL for pools)
    native_sol_balance: float  # SOL balance
    native_sol_value: float  # SOL value in USD
    sol_price: float  # Current SOL price
    tokens: List[TokenBalance]
    timestamp: datetime = field(default_factory=lambda: datetime.now(timezone.utc))

    @property
    def tvl_usd(self) -> float:
        """Get TVL (total_value is the TVL for pool accounts)."""
        return self.total_value

    def get_token_balance(self, token_address: str) -> Optional[TokenBalance]:
        """Get balance for a specific token."""
        for t in self.tokens:
            if t.token_address == token_address:
                return t
        return None

    @classmethod
    def from_api_response(cls, address: str, data: Dict[str, Any]) -> "AccountPortfolio":
        """Create from Solscan API response."""
        native = data.get("native_balance", {})
        tokens = [
            TokenBalance.from_api_response(t)
            for t in data.get("tokens", [])
        ]

        return cls(
            address=address,
            total_value=float(data.get("total_value", 0)),
            native_sol_balance=float(native.get("balance", 0)),
            native_sol_value=float(native.get("value", 0)),
            sol_price=float(native.get("token_price", 0)),
            tokens=tokens,
        )

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary."""
        return {
            "address": self.address,
            "total_value": self.total_value,
            "tvl_usd": self.tvl_usd,
            "native_sol_balance": self.native_sol_balance,
            "native_sol_value": self.native_sol_value,
            "sol_price": self.sol_price,
            "timestamp": self.timestamp.isoformat(),
            "tokens": [
                {
                    "token_address": t.token_address,
                    "token_symbol": t.token_symbol,
                    "balance": t.balance,
                    "value": t.value,
                }
                for t in self.tokens
            ],
        }


class SolscanClient:
    """
    Solscan Pro API client.

    Provides access to:
    - Pool/market data (volume, trades)
    - DeFi activities (swaps, liquidity operations)
    - Token transfers
    """

    # Orca Whirlpool program ID
    ORCA_WHIRLPOOL_PROGRAM = "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc"

    # Orca SOL-USDC Market (main pool with highest TVL)
    # This is the market account shown in Solscan analytics
    ORCA_SOL_USDC_MARKET = "Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE"

    # Token addresses
    SOL_MINT = "So11111111111111111111111111111111111111112"
    USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"

    def __init__(
        self,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
    ):
        """
        Initialize Solscan client.

        Args:
            api_key: Solscan Pro API key
            base_url: API base URL
        """
        self._api_key = api_key or getattr(settings, 'solscan_api_key', None)
        self._base_url = base_url or getattr(settings, 'solscan_api_url', 'https://pro-api.solscan.io/v2.0')
        self._http_client: Optional[httpx.AsyncClient] = None

    @property
    def is_configured(self) -> bool:
        """Check if API key is configured."""
        return bool(self._api_key)

    async def _get_client(self) -> httpx.AsyncClient:
        """Get or create HTTP client."""
        if self._http_client is None or self._http_client.is_closed:
            self._http_client = httpx.AsyncClient(
                timeout=30.0,
                headers={
                    "token": self._api_key,
                    "Content-Type": "application/json",
                }
            )
        return self._http_client

    async def close(self):
        """Close HTTP client."""
        if self._http_client and not self._http_client.is_closed:
            await self._http_client.aclose()

    async def _request(
        self,
        endpoint: str,
        params: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """
        Make API request.

        Args:
            endpoint: API endpoint path
            params: Query parameters

        Returns:
            API response data
        """
        if not self.is_configured:
            raise ValueError("Solscan API key not configured. Set SOLSCAN_API_KEY in environment.")

        client = await self._get_client()
        url = f"{self._base_url}/{endpoint.lstrip('/')}"

        # Filter out None values from params
        if params:
            params = {k: v for k, v in params.items() if v is not None}

        logger.debug("solscan_request", url=url, params=params)

        try:
            response = await client.get(url, params=params)
            response.raise_for_status()
            data = response.json()

            if not data.get("success", False):
                error = data.get("errors", {})
                raise ValueError(f"Solscan API error: {error}")

            return data

        except httpx.HTTPStatusError as e:
            if e.response.status_code == 401:
                raise ValueError("Solscan API authentication failed. Check your API key.")
            elif e.response.status_code == 429:
                raise ValueError("Solscan API rate limit exceeded. Try again later.")
            else:
                raise ValueError(f"Solscan API error: {e.response.status_code} - {e.response.text}")

    # =========================================================================
    # Account Portfolio/Balance Endpoints
    # =========================================================================

    async def get_account_portfolio(
        self,
        address: str,
        exclude_low_score_tokens: bool = True,
    ) -> AccountPortfolio:
        """
        Get account portfolio with total value (TVL for pool accounts).

        Args:
            address: Account/pool address
            exclude_low_score_tokens: Filter out low reputation tokens

        Returns:
            AccountPortfolio with TVL and token balances
        """
        data = await self._request(
            "account/portfolio",
            params={
                "address": address,
                "exclude_low_score_tokens": str(exclude_low_score_tokens).lower(),
            }
        )

        return AccountPortfolio.from_api_response(address, data.get("data", {}))

    async def get_pool_tvl(
        self,
        pool_address: Optional[str] = None,
    ) -> float:
        """
        Get current TVL for a pool.

        Args:
            pool_address: Pool address (defaults to main SOL/USDC pool)

        Returns:
            TVL in USD
        """
        if pool_address is None:
            pool_address = self.ORCA_SOL_USDC_MARKET

        portfolio = await self.get_account_portfolio(pool_address)
        return portfolio.tvl_usd

    async def get_pool_tvl_with_breakdown(
        self,
        pool_address: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Get TVL with token breakdown.

        Args:
            pool_address: Pool address

        Returns:
            Dict with TVL and token details
        """
        if pool_address is None:
            pool_address = self.ORCA_SOL_USDC_MARKET

        portfolio = await self.get_account_portfolio(pool_address)

        # Find SOL and USDC balances
        sol_balance = portfolio.get_token_balance(self.SOL_MINT)
        usdc_balance = portfolio.get_token_balance(self.USDC_MINT)

        return {
            "pool_address": pool_address,
            "tvl_usd": portfolio.tvl_usd,
            "sol_price": portfolio.sol_price,
            "timestamp": portfolio.timestamp.isoformat(),
            "sol": {
                "balance": sol_balance.balance if sol_balance else portfolio.native_sol_balance,
                "value_usd": sol_balance.value if sol_balance else portfolio.native_sol_value,
            },
            "usdc": {
                "balance": usdc_balance.balance if usdc_balance else 0,
                "value_usd": usdc_balance.value if usdc_balance else 0,
            },
            "other_tokens": [
                {
                    "symbol": t.token_symbol,
                    "balance": t.balance,
                    "value_usd": t.value,
                }
                for t in portfolio.tokens
                if t.token_address not in [self.SOL_MINT, self.USDC_MINT]
            ],
        }

    # =========================================================================
    # Market/Pool Endpoints
    # =========================================================================

    async def get_market_list(
        self,
        program: Optional[str] = None,
        token_address: Optional[str] = None,
        sort_by: Literal["created_time", "volumes_24h", "trades_24h"] = "volumes_24h",
        sort_order: Literal["asc", "desc"] = "desc",
        page: int = 1,
        page_size: int = 100,
    ) -> List[PoolMarket]:
        """
        Get list of pool markets.

        Args:
            program: Filter by program (e.g., Orca Whirlpool program)
            token_address: Filter by token address
            sort_by: Sort field
            sort_order: Sort direction
            page: Page number
            page_size: Items per page

        Returns:
            List of pool markets
        """
        data = await self._request(
            "market/list",
            params={
                "program": program,
                "token_address": token_address,
                "sort_by": sort_by,
                "sort_order": sort_order,
                "page": page,
                "page_size": page_size,
            }
        )

        markets = []
        for item in data.get("data", []):
            try:
                markets.append(PoolMarket.from_api_response(item))
            except Exception as e:
                logger.warning("solscan_parse_market_error", error=str(e), item=item)

        return markets

    async def get_orca_whirlpools(
        self,
        token_address: Optional[str] = None,
        sort_by: Literal["created_time", "volumes_24h", "trades_24h"] = "volumes_24h",
        page: int = 1,
        page_size: int = 100,
    ) -> List[PoolMarket]:
        """
        Get Orca Whirlpool markets specifically.

        Args:
            token_address: Filter by token (e.g., SOL or USDC mint)
            sort_by: Sort field
            page: Page number
            page_size: Items per page

        Returns:
            List of Orca Whirlpool markets
        """
        return await self.get_market_list(
            program=self.ORCA_WHIRLPOOL_PROGRAM,
            token_address=token_address,
            sort_by=sort_by,
            page=page,
            page_size=page_size,
        )

    async def get_sol_usdc_pools(self) -> List[PoolMarket]:
        """
        Get SOL/USDC Whirlpool markets.

        Returns:
            List of SOL/USDC pools sorted by volume
        """
        # Get pools containing SOL
        sol_pools = await self.get_orca_whirlpools(token_address=self.SOL_MINT)

        # Filter for SOL/USDC pairs
        sol_usdc_pools = [
            p for p in sol_pools
            if (p.token1 == self.SOL_MINT and p.token2 == self.USDC_MINT) or
               (p.token1 == self.USDC_MINT and p.token2 == self.SOL_MINT)
        ]

        return sol_usdc_pools

    # =========================================================================
    # DeFi Activity Endpoints
    # =========================================================================

    async def get_token_defi_activities(
        self,
        token_address: str,
        activity_types: Optional[List[DeFiActivityType]] = None,
        platform: Optional[str] = None,
        from_time: Optional[int] = None,
        to_time: Optional[int] = None,
        page: int = 1,
        page_size: int = 100,
        sort_order: Literal["asc", "desc"] = "desc",
    ) -> List[DeFiActivity]:
        """
        Get DeFi activities for a token.

        Args:
            token_address: Token mint address
            activity_types: Filter by activity types
            platform: Filter by platform/pool address
            from_time: Start timestamp (unix seconds)
            to_time: End timestamp (unix seconds)
            page: Page number
            page_size: Items per page
            sort_order: Sort direction

        Returns:
            List of DeFi activities
        """
        params = {
            "address": token_address,
            "platform": platform,
            "from_time": from_time,
            "to_time": to_time,
            "page": page,
            "page_size": page_size,
            "sort_by": "block_time",
            "sort_order": sort_order,
        }

        if activity_types:
            params["activity_type"] = [t.value for t in activity_types]

        data = await self._request("token/defi/activities", params=params)

        activities = []
        for item in data.get("data", []):
            try:
                activities.append(DeFiActivity.from_api_response(item))
            except Exception as e:
                logger.warning("solscan_parse_activity_error", error=str(e), item=item)

        return activities

    async def get_account_defi_activities(
        self,
        account_address: str,
        activity_types: Optional[List[DeFiActivityType]] = None,
        token: Optional[str] = None,
        from_time: Optional[int] = None,
        to_time: Optional[int] = None,
        page: int = 1,
        page_size: int = 100,
        sort_order: Literal["asc", "desc"] = "desc",
    ) -> List[DeFiActivity]:
        """
        Get DeFi activities for an account (wallet or pool).

        Args:
            account_address: Account/wallet/pool address
            activity_types: Filter by activity types
            token: Filter by token address
            from_time: Start timestamp (unix seconds)
            to_time: End timestamp (unix seconds)
            page: Page number
            page_size: Items per page
            sort_order: Sort direction

        Returns:
            List of DeFi activities
        """
        params = {
            "address": account_address,
            "token": token,
            "from_time": from_time,
            "to_time": to_time,
            "page": page,
            "page_size": page_size,
            "sort_by": "block_time",
            "sort_order": sort_order,
        }

        if activity_types:
            params["activity_type"] = [t.value for t in activity_types]

        data = await self._request("account/defi/activities", params=params)

        activities = []
        for item in data.get("data", []):
            try:
                activities.append(DeFiActivity.from_api_response(item))
            except Exception as e:
                logger.warning("solscan_parse_activity_error", error=str(e), item=item)

        return activities

    # =========================================================================
    # Transfer Endpoints
    # =========================================================================

    async def get_account_transfers(
        self,
        account_address: str,
        activity_types: Optional[List[TransferActivityType]] = None,
        token: Optional[str] = None,
        flow: Optional[Literal["in", "out"]] = None,
        from_time: Optional[int] = None,
        to_time: Optional[int] = None,
        page: int = 1,
        page_size: int = 100,
        sort_order: Literal["asc", "desc"] = "desc",
    ) -> List[TokenTransfer]:
        """
        Get token transfers for an account.

        Args:
            account_address: Account address
            activity_types: Filter by transfer types
            token: Filter by token address
            flow: Filter by direction ("in" or "out")
            from_time: Start timestamp (unix seconds)
            to_time: End timestamp (unix seconds)
            page: Page number
            page_size: Items per page
            sort_order: Sort direction

        Returns:
            List of token transfers
        """
        params = {
            "address": account_address,
            "token": token,
            "flow": flow,
            "from_time": from_time,
            "to_time": to_time,
            "page": page,
            "page_size": page_size,
            "sort_by": "block_time",
            "sort_order": sort_order,
        }

        if activity_types:
            params["activity_type"] = [t.value for t in activity_types]

        data = await self._request("account/transfer", params=params)

        transfers = []
        for item in data.get("data", []):
            try:
                transfers.append(TokenTransfer.from_api_response(item))
            except Exception as e:
                logger.warning("solscan_parse_transfer_error", error=str(e), item=item)

        return transfers

    # =========================================================================
    # Historical Data Aggregation
    # =========================================================================

    async def get_pool_daily_stats(
        self,
        pool_address: str,
        days: int = 30,
    ) -> List[DailyPoolStats]:
        """
        Get aggregated daily statistics for a pool.

        Fetches DeFi activities and aggregates by day.
        Note: Solscan has a 6-month historical limit.

        Args:
            pool_address: Pool address
            days: Number of days of history

        Returns:
            List of daily statistics
        """
        now = datetime.now(timezone.utc)
        from_time = int((now - timedelta(days=days)).timestamp())
        to_time = int(now.timestamp())

        # Fetch all swap activities for the pool
        all_activities: List[DeFiActivity] = []
        page = 1

        while True:
            activities = await self.get_account_defi_activities(
                account_address=pool_address,
                activity_types=[
                    DeFiActivityType.TOKEN_SWAP,
                    DeFiActivityType.AGG_TOKEN_SWAP,
                    DeFiActivityType.TOKEN_ADD_LIQ,
                    DeFiActivityType.TOKEN_REMOVE_LIQ,
                ],
                from_time=from_time,
                to_time=to_time,
                page=page,
                page_size=100,
                sort_order="asc",
            )

            if not activities:
                break

            all_activities.extend(activities)
            page += 1

            # Respect rate limits
            await asyncio.sleep(0.2)

            # Safety limit
            if page > 100:
                logger.warning("solscan_page_limit", msg="Reached 100 page limit")
                break

        logger.info(
            "solscan_fetched_activities",
            pool=pool_address,
            total_activities=len(all_activities),
            days=days,
        )

        # Aggregate by day
        daily_stats: Dict[str, DailyPoolStats] = {}

        for activity in all_activities:
            date_key = activity.block_time.strftime("%Y-%m-%d")

            if date_key not in daily_stats:
                daily_stats[date_key] = DailyPoolStats(
                    date=datetime.strptime(date_key, "%Y-%m-%d").replace(tzinfo=timezone.utc),
                    pool_address=pool_address,
                    volume_usd=0.0,
                    trade_count=0,
                    add_liquidity_count=0,
                    remove_liquidity_count=0,
                    net_liquidity_usd=0.0,
                    avg_swap_size_usd=0.0,
                )

            stats = daily_stats[date_key]

            if activity.activity_type in [DeFiActivityType.TOKEN_SWAP.value, DeFiActivityType.AGG_TOKEN_SWAP.value]:
                stats.trade_count += 1
                if activity.value_usd:
                    stats.volume_usd += activity.value_usd
            elif activity.activity_type == DeFiActivityType.TOKEN_ADD_LIQ.value:
                stats.add_liquidity_count += 1
                if activity.value_usd:
                    stats.net_liquidity_usd += activity.value_usd
            elif activity.activity_type == DeFiActivityType.TOKEN_REMOVE_LIQ.value:
                stats.remove_liquidity_count += 1
                if activity.value_usd:
                    stats.net_liquidity_usd -= activity.value_usd

        # Calculate averages
        for stats in daily_stats.values():
            if stats.trade_count > 0:
                stats.avg_swap_size_usd = stats.volume_usd / stats.trade_count

        return sorted(daily_stats.values(), key=lambda x: x.date)

    async def get_sol_usdc_volume_history(
        self,
        pool_address: Optional[str] = None,
        days: int = 30,
    ) -> List[Dict[str, Any]]:
        """
        Get historical volume data for SOL/USDC pool.

        Args:
            pool_address: Pool address (defaults to main SOL/USDC pool)
            days: Number of days

        Returns:
            List of daily volume records
        """
        if pool_address is None:
            pool_address = settings.orca_sol_usdc_pool

        stats = await self.get_pool_daily_stats(pool_address, days=days)

        return [s.to_dict() for s in stats]

    # =========================================================================
    # Historical TVL Estimation
    # =========================================================================

    async def get_historical_tvl(
        self,
        pool_address: Optional[str] = None,
        days: int = 30,
    ) -> Dict[str, float]:
        """
        Estimate historical TVL by working backwards from current TVL.

        Method:
        1. Fetch current TVL from portfolio API
        2. Fetch historical transfers
        3. Calculate daily net flows (inflows - outflows)
        4. Work backwards: TVL(day-1) = TVL(day) - net_flow(day)

        This is an approximation since it assumes all transfers
        affect TVL, but it's more accurate than a constant assumption.

        Args:
            pool_address: Pool/market address
            days: Number of days of history

        Returns:
            Dict mapping date string (YYYY-MM-DD) to estimated TVL in USD
        """
        if pool_address is None:
            pool_address = self.ORCA_SOL_USDC_MARKET

        logger.info("estimating_historical_tvl", pool=pool_address, days=days)

        # Step 1: Get current TVL
        current_portfolio = await self.get_account_portfolio(pool_address)
        current_tvl = current_portfolio.tvl_usd

        logger.info("current_tvl_fetched", tvl=current_tvl)

        # Step 2: Fetch historical transfers
        now = datetime.now(timezone.utc)
        from_time = int((now - timedelta(days=days)).timestamp())
        to_time = int(now.timestamp())

        all_transfers: List[TokenTransfer] = []
        page = 1

        while True:
            transfers = await self.get_account_transfers(
                account_address=pool_address,
                from_time=from_time,
                to_time=to_time,
                page=page,
                page_size=100,
                sort_order="desc",  # Most recent first
            )

            if not transfers:
                break

            all_transfers.extend(transfers)
            page += 1

            # Rate limiting
            await asyncio.sleep(0.2)

            # Safety limit
            if page > 200:
                logger.warning("solscan_transfer_page_limit", msg="Reached 200 page limit")
                break

        logger.info("transfers_fetched", count=len(all_transfers))

        # Step 3: Calculate daily net flows
        # Group transfers by date and calculate net flow
        daily_flows: Dict[str, float] = {}

        for transfer in all_transfers:
            date_str = transfer.block_time.strftime("%Y-%m-%d")

            if date_str not in daily_flows:
                daily_flows[date_str] = 0.0

            # Get USD value (Value column from CSV = USD value)
            # Flow: "in" = positive, "out" = negative
            # For TVL: inflows increase TVL, outflows decrease TVL
            # But for swaps, in and out cancel each other
            # We need to look at NET flow to estimate TVL change

            # Since each swap has matching in/out, net should be ~0 for swaps
            # Liquidity adds have net positive, removes have net negative
            value_usd = float(transfer.amount) / (10 ** transfer.token_decimals)

            # Get price for the token to convert to USD
            # For simplicity, we'll use the flow direction and assume
            # the Value column in CSV represents USD value
            # Since we're working with the raw API, we need to estimate
            if transfer.token_address == self.SOL_MINT:
                # Use current SOL price as approximation
                value_usd = value_usd * current_portfolio.sol_price
            # USDC is already in USD

            if transfer.flow == "in":
                daily_flows[date_str] += value_usd
            else:
                daily_flows[date_str] -= value_usd

        # Step 4: Work backwards from current TVL
        # Sort dates in reverse chronological order
        sorted_dates = sorted(daily_flows.keys(), reverse=True)

        historical_tvl: Dict[str, float] = {}
        running_tvl = current_tvl
        today_str = now.strftime("%Y-%m-%d")

        # Set today's TVL
        historical_tvl[today_str] = current_tvl

        # Work backwards
        for date_str in sorted_dates:
            if date_str == today_str:
                continue

            # TVL yesterday = TVL today - net_flow_today
            # So working backwards: TVL(date) = running_tvl - net_flow(next_day)
            net_flow = daily_flows.get(date_str, 0)

            # Reverse the flow to get previous day's TVL
            running_tvl = running_tvl - net_flow
            historical_tvl[date_str] = max(0, running_tvl)  # TVL can't be negative

        logger.info(
            "historical_tvl_estimated",
            days_with_data=len(historical_tvl),
            min_tvl=min(historical_tvl.values()) if historical_tvl else 0,
            max_tvl=max(historical_tvl.values()) if historical_tvl else 0,
        )

        return historical_tvl

    async def get_historical_pool_data(
        self,
        pool_address: Optional[str] = None,
        days: int = 30,
    ) -> List[Dict[str, Any]]:
        """
        Get comprehensive historical pool data including TVL, volume, and APR.

        This is the main method for backtesting data. Returns daily records with:
        - date: Date string
        - tvl_usd: Estimated TVL
        - volume_usd: Trading volume
        - trade_count: Number of trades
        - daily_fees: Fee income (volume * fee_rate)
        - apr_pct: Annualized APR based on that day's TVL

        Args:
            pool_address: Pool address
            days: Number of days

        Returns:
            List of daily pool data records
        """
        if pool_address is None:
            pool_address = self.ORCA_SOL_USDC_MARKET

        # Fetch TVL history and daily stats in parallel
        tvl_task = self.get_historical_tvl(pool_address, days)
        stats_task = self.get_pool_daily_stats(pool_address, days)

        historical_tvl, daily_stats = await asyncio.gather(tvl_task, stats_task)

        # Fee rate (64 bps for SOL/USDC pool)
        fee_rate = 64 / 10000  # 0.64%

        # Combine data
        result = []
        for stats in daily_stats:
            date_str = stats.date.strftime("%Y-%m-%d")
            tvl = historical_tvl.get(date_str, 0)

            daily_fees = stats.volume_usd * fee_rate
            apr_pct = (daily_fees / tvl * 365 * 100) if tvl > 0 else 0

            result.append({
                "date": date_str,
                "tvl_usd": tvl,
                "volume_usd": stats.volume_usd,
                "trade_count": stats.trade_count,
                "daily_fees": daily_fees,
                "apr_pct": apr_pct,
                "add_liquidity_count": stats.add_liquidity_count,
                "remove_liquidity_count": stats.remove_liquidity_count,
                "net_liquidity_usd": stats.net_liquidity_usd,
            })

        return sorted(result, key=lambda x: x["date"])


# =============================================================================
# Singleton and Helpers
# =============================================================================

_default_client: Optional[SolscanClient] = None


async def get_solscan_client() -> SolscanClient:
    """Get or create the default Solscan client singleton."""
    global _default_client
    if _default_client is None:
        _default_client = SolscanClient()
    return _default_client


def is_solscan_configured() -> bool:
    """Check if Solscan API is configured."""
    api_key = getattr(settings, 'solscan_api_key', None)
    return bool(api_key)
