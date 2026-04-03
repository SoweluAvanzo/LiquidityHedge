"""Chain clients for Solana and DeFi protocols."""

from .solana_client import SolanaClient
from .orca_client import OrcaClient, PoolState, PositionState
from .aggregator_jupiter import JupiterClient, Quote, SwapResult
from .wsol_cleanup import (
    WsolCleanupManager,
    WsolAccountInfo,
    CleanupResult,
    get_wsol_cleanup_manager,
    cleanup_wsol,
    get_wsol_balance,
)

__all__ = [
    "SolanaClient",
    "OrcaClient",
    "PoolState",
    "PositionState",
    "JupiterClient",
    "Quote",
    "SwapResult",
    # wSOL cleanup
    "WsolCleanupManager",
    "WsolAccountInfo",
    "CleanupResult",
    "get_wsol_cleanup_manager",
    "cleanup_wsol",
    "get_wsol_balance",
]
