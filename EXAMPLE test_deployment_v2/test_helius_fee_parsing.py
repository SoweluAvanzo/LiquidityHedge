#!/usr/bin/env python3
"""
Test script for Helius fee parsing.

This script tests the Helius API integration for parsing actual fees
collected from Whirlpool position close transactions.

Usage:
    python test_helius_fee_parsing.py <tx_signature>

Example:
    python test_helius_fee_parsing.py 67RSnQdmsFooRD2U4EYAH1zEV5W7y2aerWudg6WFbFShcf6gm9rCdVok52V2jq1fNNdTNPq74XetNsQoGzmPHzbx
"""

import asyncio
import sys
import os
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

from app.chain.helius_client import HeliusClient


async def test_fee_parsing(tx_signature: str):
    """Test parsing fees from a transaction."""

    print("=" * 70)
    print("HELIUS FEE PARSING TEST")
    print("=" * 70)
    print()

    # Get Helius API key from environment
    helius_api_key = os.getenv("HELIUS_API_KEY")
    if not helius_api_key:
        print("❌ ERROR: HELIUS_API_KEY not found in environment")
        print("   Add HELIUS_API_KEY to your .env file")
        return False

    print(f"✅ Helius API key found")
    print(f"📝 Testing transaction: {tx_signature[:16]}...{tx_signature[-16:]}")
    print()

    # Create Helius client
    client = HeliusClient(helius_api_key)

    # Parse fees
    print("🔄 Fetching and parsing transaction...")
    fees_sol, fees_usdc, error = await client.parse_collected_fees(tx_signature)

    print()
    print("=" * 70)
    print("RESULTS")
    print("=" * 70)

    if fees_sol is not None and fees_usdc is not None:
        print(f"✅ Successfully parsed fees!")
        print()
        print(f"  SOL Fees:  {fees_sol:.6f} SOL")
        print(f"  USDC Fees: ${fees_usdc:.2f}")
        print(f"  Total USD: ${(fees_sol * 128) + fees_usdc:.2f} (assuming $128/SOL)")
        print()
        print("✅ TEST PASSED")
        return True
    else:
        print(f"❌ Failed to parse fees")
        print(f"  Error: {error}")
        print()
        print("❌ TEST FAILED")
        return False


async def test_with_known_transactions():
    """Test with known close transactions from your logs."""

    print("=" * 70)
    print("TESTING WITH KNOWN TRANSACTIONS")
    print("=" * 70)
    print()

    # These are from your log examples
    known_txs = [
        {
            "sig": "67RSnQdmsFooRD2U4EYAH1zEV5W7y2aerWudg6WFbFShcf6gm9rCdVok52V2jq1fNNdTNPq74XetNsQoGzmPHzbx",
            "desc": "Position close from session_20251213 (first position)"
        },
        {
            "sig": "4Ebo5LyFDr2y8ZZ4eqtzCKdbpo3MH7z2YbfEyHKPvmHYVnqSoA3Uv91pcN4FnGvG4dcccogYD7XStyfq8cAvGzoF",
            "desc": "Position open from session_20251213 (second position)"
        }
    ]

    results = []
    for tx_info in known_txs:
        print(f"\nTesting: {tx_info['desc']}")
        print(f"Signature: {tx_info['sig'][:16]}...{tx_info['sig'][-16:]}")
        print("-" * 70)

        success = await test_fee_parsing(tx_info['sig'])
        results.append((tx_info['desc'], success))

        print()

    print("=" * 70)
    print("SUMMARY")
    print("=" * 70)
    for desc, success in results:
        status = "✅ PASS" if success else "❌ FAIL"
        print(f"{status} - {desc}")


async def main():
    """Main entry point."""

    if len(sys.argv) > 1:
        # Test with provided transaction signature
        tx_signature = sys.argv[1]
        await test_fee_parsing(tx_signature)
    else:
        # Test with known transactions
        print("No transaction signature provided.")
        print("Testing with known transactions from logs...")
        print()
        await test_with_known_transactions()


if __name__ == "__main__":
    asyncio.run(main())
