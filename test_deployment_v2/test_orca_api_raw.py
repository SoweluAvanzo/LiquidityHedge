#!/usr/bin/env python3
"""
Test Orca API raw response to see what it actually returns.
"""

import asyncio
import sys
from pathlib import Path
from dotenv import load_dotenv

project_root = Path(__file__).parent.parent
sys.path.insert(0, str(project_root))

load_dotenv()

import httpx
import json

async def test_orca_api_raw():
    """Test Orca API and see raw response."""
    pool_address = "HJPjoWUrhoZzkNfRpHuieeFk9WcZWjwy6PBjZ81ngndJ"
    url = f"https://api.mainnet.orca.so/v1/whirlpool/{pool_address}"
    
    print(f"Testing Orca API: {url}")
    print("=" * 70)
    
    async with httpx.AsyncClient(timeout=30.0) as client:
        try:
            response = await client.get(url)
            print(f"Status Code: {response.status_code}")
            print(f"Headers: {dict(response.headers)}")
            print("\n" + "=" * 70)
            print("RAW JSON RESPONSE:")
            print("=" * 70)
            
            data = response.json()
            print(json.dumps(data, indent=2))
            
            print("\n" + "=" * 70)
            print("EXTRACTED VALUES:")
            print("=" * 70)
            print(f"tvl: {data.get('tvl')}")
            print(f"volume: {data.get('volume')}")
            print(f"price: {data.get('price')}")
            print(f"feeRate: {data.get('feeRate')}")
            
        except Exception as e:
            print(f"Error: {e}")
            import traceback
            traceback.print_exc()

if __name__ == "__main__":
    asyncio.run(test_orca_api_raw())























