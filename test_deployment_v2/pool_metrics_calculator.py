"""
Pool Metrics Calculator - On-Chain TVL Calculation

Calculates TVL and other pool metrics directly from on-chain data,
without relying on external APIs.

This module provides functions to:
- Calculate TVL from pool vault balances
- Estimate volume from fee growth (when available)
- All calculations use direct blockchain data
"""

import logging
from typing import Optional, Tuple
from decimal import Decimal

logger = logging.getLogger(__name__)


async def calculate_tvl_from_pool_state(
    pool_state,
    solana_client=None,
) -> Tuple[float, float]:
    """
    Calculate TVL (Total Value Locked) from on-chain pool state.

    TVL = (vault_a_balance * current_price) + vault_b_balance

    Args:
        pool_state: PoolState object with vault addresses and current price
        solana_client: Optional Solana client (will create if not provided)

    Returns:
        Tuple of (tvl_usd, sol_balance, usdc_balance)
        - tvl_usd: Total Value Locked in USD
        - sol_balance: SOL balance in vault (for reference)
        - usdc_balance: USDC balance in vault (for reference)
    """
    try:
        # Validate pool_state is a PoolState object, not a float or other type
        if not hasattr(pool_state, 'token_vault_a') or not hasattr(pool_state, 'token_vault_b'):
            logger.error(f"Invalid pool_state type: {type(pool_state)}. Expected PoolState object.")
            return 0.0, 0.0, 0.0
        
        # Import here to avoid circular dependencies
        if solana_client is None:
            from app.chain.solana_client import get_solana_client
            solana_client = await get_solana_client()

        # Get vault addresses from pool state
        vault_a = pool_state.token_vault_a
        vault_b = pool_state.token_vault_b

        if not vault_a or not vault_b:
            logger.warning("Pool state missing vault addresses")
            return 0.0, 0.0, 0.0

        # Fetch vault balances - try multiple methods
        sol_balance = 0.0
        usdc_balance = 0.0
        
        # Method 1: Try mainnet client (if available)
        try:
            from app.chain.mainnet_client import get_mainnet_client
            mainnet_client = await get_mainnet_client()
            
            # Get balances in base units (lamports for SOL, micro-units for USDC)
            sol_balance_base = await mainnet_client.get_token_account_balance(vault_a)
            usdc_balance_base = await mainnet_client.get_token_account_balance(vault_b)
            
            # Convert to human-readable units
            # SOL has 9 decimals, USDC has 6 decimals
            sol_balance = float(sol_balance_base) / 1e9
            usdc_balance = float(usdc_balance_base) / 1e6
            
            logger.debug(f"Vault balances fetched via mainnet client: SOL={sol_balance:.2f}, USDC={usdc_balance:.2f}")
            
        except Exception as e:
            logger.debug(f"Mainnet client not available or failed: {e}, trying solana client")
            # Method 2: Fallback to solana_client
            try:
                # Ensure solana_client is available
                if solana_client is None:
                    from app.chain.solana_client import get_solana_client
                    solana_client = await get_solana_client()
                
                # Get token balance using solana_client (returns dict with ui_amount)
                sol_balance_info = await solana_client.get_token_balance(vault_a)
                usdc_balance_info = await solana_client.get_token_balance(vault_b)
                
                if sol_balance_info and usdc_balance_info:
                    sol_balance = float(sol_balance_info.get("ui_amount", 0))
                    usdc_balance = float(usdc_balance_info.get("ui_amount", 0))
                    logger.debug(f"Vault balances fetched via solana client: SOL={sol_balance:.2f}, USDC={usdc_balance:.2f}")
                else:
                    logger.warning(f"Could not fetch vault balances - sol_balance_info={sol_balance_info}, usdc_balance_info={usdc_balance_info}")
                    return 0.0, 0.0, 0.0
            except Exception as e2:
                logger.error(f"Failed to fetch vault balances via solana client: {e2}", exc_info=True)
                return 0.0, 0.0, 0.0
        
        # Validate balances
        if sol_balance <= 0 and usdc_balance <= 0:
            logger.warning(f"Both vault balances are zero or negative: SOL={sol_balance}, USDC={usdc_balance}")
            return 0.0, 0.0, 0.0

        # Get current price from pool state
        current_price = pool_state.current_price

        # Calculate TVL
        # TVL = (SOL balance * SOL price) + USDC balance
        sol_value_usd = sol_balance * current_price
        tvl_usd = sol_value_usd + usdc_balance

        logger.info(
            f"TVL calculated from on-chain data: "
            f"SOL={sol_balance:.2f} (${sol_value_usd:.2f}), "
            f"USDC=${usdc_balance:.2f}, "
            f"TVL=${tvl_usd:.2f}"
        )

        return tvl_usd, sol_balance, usdc_balance

    except Exception as e:
        logger.error(f"Error calculating TVL from pool state: {e}", exc_info=True)
        return 0.0, 0.0, 0.0


async def estimate_volume_from_fee_growth(
    pool_state,
    previous_fee_growth_a: Optional[int] = None,
    previous_fee_growth_b: Optional[int] = None,
    time_delta_seconds: Optional[float] = None,
) -> float:
    """
    Estimate 24h volume from fee growth changes.

    This is an approximation based on:
    - Fee growth represents cumulative fees earned
    - Fees = Volume * fee_rate
    - Volume = Fees / fee_rate

    Note: This requires tracking fee_growth over time to calculate changes.
    For a simple 24h estimate, we'd need to compare current vs 24h ago.

    Args:
        pool_state: Current PoolState
        previous_fee_growth_a: Fee growth A from previous snapshot (optional)
        previous_fee_growth_b: Fee growth B from previous snapshot (optional)
        time_delta_seconds: Time difference in seconds (optional)

    Returns:
        Estimated 24h volume in USD (0.0 if calculation not possible)
    """
    try:
        # If we don't have historical data, we can't calculate volume
        if previous_fee_growth_a is None or previous_fee_growth_b is None:
            logger.debug("Cannot estimate volume: missing historical fee growth data")
            return 0.0

        # Calculate fee growth delta
        fee_growth_delta_a = pool_state.fee_growth_global_a - previous_fee_growth_a
        fee_growth_delta_b = pool_state.fee_growth_global_b - previous_fee_growth_b

        # Fee growth is in Q128 format (fixed point with 128 bits)
        # Convert to decimal
        Q128 = 2 ** 128
        fee_growth_a_decimal = float(fee_growth_delta_a) / Q128
        fee_growth_b_decimal = float(fee_growth_delta_b) / Q128

        # Get fee rate (in hundredths of a basis point, e.g., 400 = 4 bps = 0.04%)
        fee_rate_hundredths_bps = pool_state.fee_rate
        fee_rate = fee_rate_hundredths_bps / 1000000.0  # Convert to decimal (400 -> 0.0004 for 4 bps)

        if fee_rate == 0:
            logger.warning("Pool fee rate is 0, cannot estimate volume")
            return 0.0

        # Estimate volume from fees
        # Fees = Volume * fee_rate
        # Volume = Fees / fee_rate
        # We need to convert fee growth to actual fees earned
        # This is complex and requires knowing the liquidity distribution
        # For a rough estimate, we can use the average of both tokens

        # This is a simplified approximation
        # In reality, fee growth needs to be converted using liquidity math
        # For now, return 0 to indicate we can't accurately calculate this
        logger.debug("Volume estimation from fee growth requires complex liquidity math - not implemented")
        return 0.0

    except Exception as e:
        logger.warning(f"Error estimating volume from fee growth: {e}")
        return 0.0

