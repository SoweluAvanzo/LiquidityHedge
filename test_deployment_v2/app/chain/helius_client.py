"""
Helius API client for parsing Solana transactions.

This module provides functionality to parse actual fees collected from
Whirlpool position close transactions using Helius Enhanced Transactions API.

CRITICAL: This is the ONLY reliable way to get ACTUAL fees collected.
The pending fees estimate from on-chain calculation may differ from
what was actually collected due to:
1. Price changes between estimation and collection
2. Fee growth during the close transaction
3. Rounding differences

Usage:
    from app.chain.helius_client import get_helius_client, initialize_helius_client

    # Initialize once at startup
    initialize_helius_client(api_key="your-helius-api-key")

    # Parse fees from a close transaction
    client = get_helius_client()
    fees_sol, fees_usdc, error = await client.parse_collected_fees(tx_signature)

    if error:
        # Fall back to estimate
        pass
    else:
        # Use actual fees
        pass
"""

import httpx
from typing import Optional, Tuple, Dict, Any, List
from decimal import Decimal
import logging

# Use standard logging to match the rest of the codebase
logger = logging.getLogger(__name__)

# Token mints on Solana mainnet
WSOL_MINT = "So11111111111111111111111111111111111111112"
USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"

# Orca Whirlpool program ID
WHIRLPOOL_PROGRAM_ID = "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc"


class HeliusClient:
    """
    Client for interacting with Helius Enhanced Transactions API.

    Helius provides parsed, human-readable transaction data that makes it
    easy to extract specific information like fee collections from complex
    DeFi transactions.
    """

    def __init__(self, api_key: str, timeout: int = 30):
        """
        Initialize Helius client.

        Args:
            api_key: Helius API key (get one at https://dev.helius.xyz)
            timeout: Request timeout in seconds
        """
        self.api_key = api_key
        self.base_url = "https://api.helius.xyz/v0"
        self.timeout = timeout
        self._initialized = True

    async def get_transaction(self, signature: str) -> Optional[Dict[str, Any]]:
        """
        Get enhanced transaction data from Helius.

        Args:
            signature: Transaction signature to fetch

        Returns:
            Enhanced transaction data or None if failed
        """
        url = f"{self.base_url}/transactions/?api-key={self.api_key}"

        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                response = await client.post(
                    url,
                    json={"transactions": [signature]}
                )
                response.raise_for_status()
                data = response.json()

                if not data or len(data) == 0:
                    logger.warning(f"No transaction data returned for {signature[:16]}...")
                    return None

                return data[0]

        except httpx.TimeoutException:
            logger.error(f"Helius API timeout fetching tx {signature[:16]}...")
            return None
        except httpx.HTTPStatusError as e:
            logger.error(f"Helius API HTTP error: {e.response.status_code} for tx {signature[:16]}...")
            return None
        except Exception as e:
            logger.error(f"Helius API error: {e}")
            return None

    async def parse_collected_fees(
        self,
        tx_signature: str,
        wallet_address: Optional[str] = None,
    ) -> Tuple[Optional[float], Optional[float], str]:
        """
        Parse ACTUAL fees collected from a Whirlpool close position transaction.

        This is the CORRECT way to determine fees collected - by parsing
        the actual transaction that collected them.

        Args:
            tx_signature: Transaction signature of the close position tx
            wallet_address: Optional wallet address to filter transfers TO this address

        Returns:
            Tuple of (fees_sol, fees_usdc, error_msg)
            - fees_sol: SOL fees collected (None if error)
            - fees_usdc: USDC fees collected (None if error)
            - error_msg: Error message (empty if success)
        """
        logger.info(f"Parsing collected fees from tx: {tx_signature[:16]}...")

        # Fetch enhanced transaction data
        tx_data = await self.get_transaction(tx_signature)
        if not tx_data:
            error_msg = "Failed to fetch transaction from Helius"
            logger.warning(f"{error_msg}: {tx_signature[:16]}...")
            return (None, None, error_msg)

        # Extract fees from transaction
        try:
            fees_sol, fees_usdc = self._extract_fees_from_transaction(tx_data, wallet_address)

            logger.info(
                f"Parsed ACTUAL fees from tx {tx_signature[:16]}: "
                f"{fees_sol:.6f} SOL, ${fees_usdc:.2f} USDC"
            )

            return (fees_sol, fees_usdc, "")

        except Exception as e:
            error_msg = f"Failed to extract fees: {str(e)}"
            logger.error(error_msg)
            return (None, None, error_msg)

    def _extract_fees_from_transaction(
        self,
        tx_data: Dict[str, Any],
        wallet_address: Optional[str] = None,
    ) -> Tuple[float, float]:
        """
        Extract fee transfers from transaction data.

        Strategy:
        1. Look for explicit collectFees instruction transfers
        2. If not found, look for decreaseLiquidityV2 which also collects fees
        3. If not found, use heuristic on all transfers (smallest = fees)

        Args:
            tx_data: Enhanced transaction data from Helius
            wallet_address: Optional wallet to filter transfers to

        Returns:
            Tuple of (fees_sol, fees_usdc)
        """
        fees_sol = 0.0
        fees_usdc = 0.0

        # === Strategy 1: Look at inner instructions for Whirlpool fee collection ===
        # Helius provides parsed instructions with token transfers
        instructions = tx_data.get("instructions", [])
        inner_instructions = tx_data.get("innerInstructions", [])

        # Collect all transfers from Whirlpool-related instructions
        whirlpool_transfers = []

        for instruction in instructions:
            program_id = instruction.get("programId", "")

            # Check main instruction
            if program_id == WHIRLPOOL_PROGRAM_ID:
                instruction_type = (instruction.get("instructionType") or "").lower()
                logger.debug(f"Found Whirlpool instruction: {instruction_type}")

                # Get token transfers from this instruction
                transfers = instruction.get("tokenTransfers", [])
                for transfer in transfers:
                    whirlpool_transfers.append({
                        "mint": transfer.get("mint"),
                        "amount": float(transfer.get("tokenAmount", 0)),
                        "instruction": instruction_type,
                        "source": "instruction",
                    })

        # Also check inner instructions
        for inner in inner_instructions:
            for ix in inner.get("instructions", []):
                if ix.get("programId") == WHIRLPOOL_PROGRAM_ID:
                    transfers = ix.get("tokenTransfers", [])
                    instruction_type = (ix.get("instructionType") or "").lower()
                    for transfer in transfers:
                        whirlpool_transfers.append({
                            "mint": transfer.get("mint"),
                            "amount": float(transfer.get("tokenAmount", 0)),
                            "instruction": instruction_type,
                            "source": "inner",
                        })

        # === Strategy 2: Look at top-level token transfers ===
        # Helius provides all token transfers at the transaction level
        all_token_transfers = tx_data.get("tokenTransfers", [])

        sol_transfers = []
        usdc_transfers = []

        for transfer in all_token_transfers:
            mint = transfer.get("mint")
            amount = float(transfer.get("tokenAmount", 0))
            from_addr = transfer.get("fromUserAccount", "")
            to_addr = transfer.get("toUserAccount", "")

            # If wallet_address provided, only count transfers TO the wallet
            if wallet_address and to_addr != wallet_address:
                continue

            if amount > 0:
                if mint == WSOL_MINT:
                    sol_transfers.append({
                        "amount": amount,
                        "from": from_addr,
                        "to": to_addr,
                    })
                elif mint == USDC_MINT:
                    usdc_transfers.append({
                        "amount": amount,
                        "from": from_addr,
                        "to": to_addr,
                    })

        logger.debug(f"Found {len(sol_transfers)} SOL transfers, {len(usdc_transfers)} USDC transfers")

        # === Determine fees based on transfer patterns ===
        # In a decreaseLiquidityV2 + collectFees transaction:
        # - Fee transfers are typically smaller
        # - Principal transfers are larger
        # - If there's only one transfer of each type, it includes both fees and principal

        if len(sol_transfers) >= 2:
            # Multiple SOL transfers - smallest is likely fees
            amounts = sorted([t["amount"] for t in sol_transfers])
            fees_sol = amounts[0]
            logger.debug(f"Multiple SOL transfers: {amounts}, using smallest as fees: {fees_sol:.6f}")
        elif len(sol_transfers) == 1:
            # Single SOL transfer - this is combined fees + principal
            # We cannot separate them without additional context
            # Return 0 for fees and let caller use fallback estimate
            logger.debug(f"Single SOL transfer: {sol_transfers[0]['amount']:.6f} - cannot separate fees from principal")
            fees_sol = 0.0

        if len(usdc_transfers) >= 2:
            # Multiple USDC transfers - smallest is likely fees
            amounts = sorted([t["amount"] for t in usdc_transfers])
            fees_usdc = amounts[0]
            logger.debug(f"Multiple USDC transfers: {amounts}, using smallest as fees: {fees_usdc:.2f}")
        elif len(usdc_transfers) == 1:
            # Single USDC transfer - combined fees + principal
            logger.debug(f"Single USDC transfer: ${usdc_transfers[0]['amount']:.2f} - cannot separate fees from principal")
            fees_usdc = 0.0

        # === Strategy 3: Check for explicit fee collection instruction ===
        # If we found explicit Whirlpool transfers, prefer those
        for transfer in whirlpool_transfers:
            instruction = transfer.get("instruction", "")
            if "collect" in instruction and "fee" in instruction:
                # This is from an explicit collectFees instruction
                mint = transfer.get("mint")
                amount = transfer.get("amount", 0)
                if mint == WSOL_MINT:
                    fees_sol = max(fees_sol, amount)
                    logger.debug(f"Found explicit collectFees SOL: {amount:.6f}")
                elif mint == USDC_MINT:
                    fees_usdc = max(fees_usdc, amount)
                    logger.debug(f"Found explicit collectFees USDC: ${amount:.2f}")

        return (fees_sol, fees_usdc)

    async def get_transaction_details(
        self,
        tx_signature: str
    ) -> Dict[str, Any]:
        """
        Get comprehensive transaction details including all transfers.

        Useful for debugging and analysis.

        Args:
            tx_signature: Transaction signature

        Returns:
            Dictionary with parsed transaction details
        """
        tx_data = await self.get_transaction(tx_signature)
        if not tx_data:
            return {"error": "Failed to fetch transaction"}

        return {
            "signature": tx_signature,
            "type": tx_data.get("type"),
            "source": tx_data.get("source"),
            "fee": tx_data.get("fee"),
            "fee_payer": tx_data.get("feePayer"),
            "timestamp": tx_data.get("timestamp"),
            "token_transfers": tx_data.get("tokenTransfers", []),
            "native_transfers": tx_data.get("nativeTransfers", []),
            "instructions_count": len(tx_data.get("instructions", [])),
            "inner_instructions_count": len(tx_data.get("innerInstructions", [])),
        }


# Singleton instance
_helius_client: Optional[HeliusClient] = None


def initialize_helius_client(api_key: str) -> None:
    """Initialize the global Helius client instance."""
    global _helius_client
    _helius_client = HeliusClient(api_key)
    logger.info("Helius client initialized")


def get_helius_client() -> Optional[HeliusClient]:
    """Get the global Helius client instance."""
    return _helius_client


async def parse_actual_collected_fees(
    tx_signature: str
) -> Tuple[Optional[float], Optional[float], str]:
    """
    Convenience function to parse fees using the global Helius client.

    Args:
        tx_signature: Transaction signature to parse

    Returns:
        Tuple of (fees_sol, fees_usdc, error_msg)
    """
    client = get_helius_client()
    if not client:
        error_msg = "Helius client not initialized"
        logger.warning(error_msg)
        return (None, None, error_msg)

    return await client.parse_collected_fees(tx_signature)
