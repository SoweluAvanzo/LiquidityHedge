"""
Volume Calculator Module

Calculates pool volume from on-chain fee growth changes.
Volume = (delta_fee_growth * liquidity) / (fee_rate * Q64)
"""

import logging
from typing import Optional, Tuple
from decimal import Decimal

logger = logging.getLogger(__name__)

# Q64 constant (2^64) for fixed-point arithmetic
Q64 = 2**64
Q128 = 2**128


async def calculate_volume_from_fee_growth(
    entry_fee_growth_a: int,
    entry_fee_growth_b: int,
    exit_fee_growth_a: int,
    exit_fee_growth_b: int,
    entry_liquidity: int,
    exit_liquidity: int,
    fee_rate_bps: int,
    entry_price: float,
    exit_price: float,
) -> Tuple[float, str]:
    """
    Calculate total volume from fee growth changes between entry and exit.
    
    Formula:
        delta_fee_growth = exit_fee_growth - entry_fee_growth
        fees = (delta_fee_growth * avg_liquidity) / Q64
        volume = fees / fee_rate
    
    Args:
        entry_fee_growth_a: Fee growth global A at position entry
        entry_fee_growth_b: Fee growth global B at position entry
        exit_fee_growth_a: Fee growth global A at position exit
        exit_fee_growth_b: Fee growth global B at position exit
        entry_liquidity: Pool liquidity at entry
        exit_liquidity: Pool liquidity at exit
        fee_rate_bps: Pool fee rate in basis points (e.g., 4 = 0.04%)
        entry_price: SOL price at entry
        exit_price: SOL price at exit
    
    Returns:
        Tuple of (volume_usd, error_message)
        If error occurs, returns (0.0, error_message)
    """
    try:
        # Calculate fee growth deltas (handle wraparound)
        delta_a = (exit_fee_growth_a - entry_fee_growth_a) % Q128
        delta_b = (exit_fee_growth_b - entry_fee_growth_b) % Q128
        
        # Use average liquidity for calculation
        avg_liquidity = (entry_liquidity + exit_liquidity) // 2
        
        if avg_liquidity == 0:
            return (0.0, "Average liquidity is zero")
        
        # Calculate fees from fee growth delta
        # fees = (delta_fee_growth * liquidity) / Q64
        fees_a_raw = (delta_a * avg_liquidity) // Q64
        fees_b_raw = (delta_b * avg_liquidity) // Q64
        
        # Convert to token amounts
        fees_a_sol = Decimal(fees_a_raw) / Decimal(10**9)  # SOL has 9 decimals
        fees_b_usdc = Decimal(fees_b_raw) / Decimal(10**6)  # USDC has 6 decimals
        
        # Convert fees to USD
        fees_a_usd = float(fees_a_sol) * entry_price  # Use entry price for SOL fees
        fees_b_usd = float(fees_b_usdc)  # USDC is 1:1 with USD
        
        total_fees_usd = fees_a_usd + fees_b_usd
        
        # Calculate volume from fees
        # fee_rate_bps is in hundredths of basis points, so divide by 1,000,000 to get decimal
        fee_rate_decimal = fee_rate_bps / 1_000_000
        
        if fee_rate_decimal == 0:
            return (0.0, "Fee rate is zero")
        
        # Volume = fees / fee_rate
        volume_usd = total_fees_usd / fee_rate_decimal
        
        logger.info(
            f"Volume calculated from fee growth: ${volume_usd:,.2f} "
            f"(fees: ${total_fees_usd:.2f}, fee_rate: {fee_rate_bps/10000:.4f}%)"
        )
        
        return (volume_usd, "")
        
    except Exception as e:
        error_msg = f"Volume calculation failed: {str(e)[:80]}"
        logger.error(f"{error_msg}: {e}", exc_info=True)
        return (0.0, error_msg)






















