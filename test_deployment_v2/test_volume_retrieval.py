#!/usr/bin/env python3
"""
Test script to verify 24h volume retrieval from Orca API.
"""

import asyncio
import sys
from pathlib import Path

# Add parent directory to path
sys.path.insert(0, str(Path(__file__).parent))

from dotenv import load_dotenv
load_dotenv()

from app.chain.orca_api_client import get_orca_api_client


async def test_volume_retrieval():
    """Test 24h volume retrieval from Orca API."""

    pool_address = "Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE"

    print("=" * 80)
    print("VOLUME RETRIEVAL TEST")
    print("=" * 80)
    print(f"\nPool Address: {pool_address}")
    print()

    try:
        # Get Orca API client
        api_client = get_orca_api_client()
        print("✅ Orca API client initialized")

        # Fetch pool metrics
        print("\n" + "=" * 80)
        print("Fetching Pool Metrics from Orca API")
        print("=" * 80)

        metrics = await api_client.get_pool_metrics(pool_address)

        if not metrics:
            print("❌ ERROR: Pool metrics returned None")
            print("   This could mean:")
            print("   - The pool address is invalid")
            print("   - The Orca API is down")
            print("   - The API rate limit was hit")
            return

        print(f"✅ Pool metrics retrieved")
        print(f"\n   TVL:         ${metrics.tvl:,.2f}" if metrics.tvl is not None else "   TVL:         None")
        print(f"   Volume 24h:  ${metrics.volume_24h:,.2f}" if metrics.volume_24h is not None else "   Volume 24h:  None")
        print(f"   Fee 24h:     ${metrics.fee_24h:,.2f}" if metrics.fee_24h is not None else "   Fee 24h:     None")
        print(f"   Price:       ${metrics.price:.2f}" if metrics.price is not None else "   Price:       None")

        # Diagnostic checks
        print("\n" + "=" * 80)
        print("Diagnostic Checks")
        print("=" * 80)

        if metrics.tvl is None:
            print("⚠️  TVL is None - API might not have this data")
        elif metrics.tvl == 0:
            print("⚠️  TVL is 0 - Pool might be empty or API data is stale")
        else:
            print(f"✅ TVL looks good: ${metrics.tvl:,.2f}")

        if metrics.volume_24h is None:
            print("❌ Volume 24h is None - THIS IS THE PROBLEM!")
            print("   The Orca API is not returning volume data")
            print("   Possible causes:")
            print("   - API endpoint changed")
            print("   - Pool doesn't have volume data yet (new pool)")
            print("   - API response format changed")
        elif metrics.volume_24h == 0:
            print("⚠️  Volume 24h is 0 - Pool might have no recent trades")
        else:
            print(f"✅ Volume 24h looks good: ${metrics.volume_24h:,.2f}")

        print("\n" + "=" * 80)
        print("TEST COMPLETE")
        print("=" * 80)

    except Exception as e:
        print(f"\n❌ ERROR during test: {e}")
        import traceback
        traceback.print_exc()


if __name__ == "__main__":
    asyncio.run(test_volume_retrieval())
