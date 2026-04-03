#!/usr/bin/env python3
"""
Test script to verify error tracking in CSV logging.

This script tests the same flow as production code to ensure
error messages are properly captured and displayed in CSV.
"""

import asyncio
import sys
from pathlib import Path
from decimal import Decimal

# Add project root to path
project_root = Path(__file__).parent.parent
sys.path.insert(0, str(project_root))

from test_deployment_v2.csv_logger import CSVLogger, LPManagementRow


def test_error_tracking_in_csv():
    """Test that error messages appear in CSV when retrieval fails."""
    print("=" * 70)
    print("TEST: Error Tracking in CSV Logging")
    print("=" * 70)
    
    # Create test CSV logger
    test_data_dir = Path("test_deployment_v2/test_data_csv_errors")
    test_data_dir.mkdir(exist_ok=True)
    
    csv_logger = CSVLogger(output_dir=str(test_data_dir))
    
    # Test 1: Position open with TVL error
    print("\n--- Test 1: Position open with TVL retrieval error ---")
    csv_logger.log_position_open(
        position_address="TEST_POS_1",
        entry_price=128.50,
        sol_amount=1.0,
        usdc_amount=128.50,
        lower_price=126.0,
        upper_price=131.0,
        tx_signature="TEST_SIG_1",
        open_attempts=1,
        tvl=0.0,  # This should show error if retrieval failed
        volume_24h=0.0,
        tvl_error="API failed: Connection timeout",  # Simulated error
        volume_error="API failed: Connection timeout",  # Simulated error
    )
    
    # Test 2: Position close with fee error
    print("\n--- Test 2: Position close with fee retrieval error ---")
    csv_logger.log_position_close(
        position_address="TEST_POS_1",
        exit_price=129.00,
        sol_withdrawn=0.98,
        usdc_withdrawn=126.50,
        fees_sol=0.0,  # This should show error if retrieval failed
        fees_usdc=0.0,
        tx_signature="TEST_SIG_CLOSE_1",
        rebalance_latency_seconds=0.0,
        tvl=0.0,  # This should show error if retrieval failed
        volume_24h=0.0,
        fees_error="Fee estimation failed: Position state not found",  # Simulated error
        tvl_error="On-chain failed: Pool state missing vault addresses",  # Simulated error
        volume_error="API failed: Cloudflare error 1016",  # Simulated error
    )
    
    # Check CSV file
    csv_file = test_data_dir / "lp_management.csv"
    if csv_file.exists():
        print(f"\n✅ CSV file created: {csv_file}")
        with open(csv_file, 'r') as f:
            content = f.read()
            print(f"\nCSV Content:")
            print(content)
            
            # Check if errors are visible
            if "ERROR" in content.upper() or "FAILED" in content.upper():
                print("\n✅ Error messages found in CSV")
            else:
                print("\n⚠️  No error messages found in CSV - cells are empty")
                print("   This is the problem we need to fix!")
    else:
        print(f"\n❌ CSV file not created")


if __name__ == "__main__":
    test_error_tracking_in_csv()

