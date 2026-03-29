#!/usr/bin/env python3
"""
Unit tests for CSV logging with new comprehensive data fields.

Tests the 2025-12 enhancements:
1. TX fee tracking (tx_fee_sol for each operation)
2. Pool metrics (TVL, Volume from Orca API)
3. Price comparison (Birdeye vs pool price)
4. IL tracking for open positions
5. Fee accrual tracking (fee_growth_checkpoint values)
"""

import os
import sys
import csv
import tempfile
import unittest
from datetime import datetime, timezone
from unittest.mock import Mock, AsyncMock, patch

# Add test_deployment_v2 to path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from csv_logger import (
    CSVLogger,
    LPManagementRow,
    AssetFeeRow,
    PoolStateRow,
)

# Get column constants from CSVLogger class
LP_COLUMNS = CSVLogger.LP_COLUMNS
ASSET_FEE_COLUMNS = CSVLogger.ASSET_FEE_COLUMNS
POOL_STATE_COLUMNS = CSVLogger.POOL_STATE_COLUMNS


class TestLPManagementRow(unittest.TestCase):
    """Test LPManagementRow dataclass with new fields."""

    def test_new_tx_fee_fields_exist(self):
        """Verify new TX fee fields are present."""
        row = LPManagementRow(position_address="test123")
        self.assertTrue(hasattr(row, 'tx_fee_open_sol'))
        self.assertTrue(hasattr(row, 'tx_fee_close_sol'))
        self.assertTrue(hasattr(row, 'tx_fee_total_sol'))
        self.assertEqual(row.tx_fee_open_sol, 0.0)
        self.assertEqual(row.tx_fee_close_sol, 0.0)
        self.assertEqual(row.tx_fee_total_sol, 0.0)

    def test_new_il_fields_exist(self):
        """Verify new IL tracking fields are present."""
        row = LPManagementRow(position_address="test123")
        self.assertTrue(hasattr(row, 'current_il_usd'))
        self.assertTrue(hasattr(row, 'current_il_pct'))
        self.assertEqual(row.current_il_usd, 0.0)
        self.assertEqual(row.current_il_pct, 0.0)

    def test_new_fee_accrual_fields_exist(self):
        """Verify new fee accrual tracking fields are present."""
        row = LPManagementRow(position_address="test123")
        self.assertTrue(hasattr(row, 'fee_growth_checkpoint_a'))
        self.assertTrue(hasattr(row, 'fee_growth_checkpoint_b'))
        self.assertTrue(hasattr(row, 'pending_fees_sol'))
        self.assertTrue(hasattr(row, 'pending_fees_usdc'))

    def test_new_price_comparison_fields_exist(self):
        """Verify new price comparison fields are present."""
        row = LPManagementRow(position_address="test123")
        self.assertTrue(hasattr(row, 'birdeye_price_entry'))
        self.assertTrue(hasattr(row, 'pool_price_entry'))

    def test_to_csv_row_returns_dict(self):
        """Verify to_csv_row() returns a dictionary."""
        row = LPManagementRow(
            position_address="test123",
            entry_price=225.0,
            tx_fee_open_sol=0.001,
            birdeye_price_entry=225.5,
            pool_price_entry=225.0,
        )
        csv_row = row.to_csv_row()

        # Should be a dict with all expected columns
        self.assertIsInstance(csv_row, dict)
        self.assertEqual(len(csv_row), len(LP_COLUMNS))

        # Check new fields are included
        self.assertIn('TX Fee Open (SOL)', csv_row)
        self.assertIn('Birdeye price (entry)', csv_row)
        self.assertIn('Pool price (entry)', csv_row)


class TestAssetFeeRow(unittest.TestCase):
    """Test AssetFeeRow dataclass with new fields."""

    def test_new_tx_fee_field_exists(self):
        """Verify new TX fee field is present."""
        row = AssetFeeRow()
        self.assertTrue(hasattr(row, 'tx_fee_sol'))
        self.assertEqual(row.tx_fee_sol, 0.0)

    def test_new_birdeye_price_field_exists(self):
        """Verify new Birdeye price field is present."""
        row = AssetFeeRow()
        self.assertTrue(hasattr(row, 'birdeye_price'))
        self.assertEqual(row.birdeye_price, 0.0)

    def test_to_csv_row_returns_dict(self):
        """Verify to_csv_row() returns a dictionary."""
        row = AssetFeeRow(
            type="swap",
            tx_fee_sol=0.0005,
            birdeye_price=225.0,
        )
        csv_row = row.to_csv_row()

        # Should be a dict with all expected columns
        self.assertIsInstance(csv_row, dict)
        self.assertEqual(len(csv_row), len(ASSET_FEE_COLUMNS))

        # Check new fields are included
        self.assertIn('TX Fee (SOL)', csv_row)
        self.assertIn('Birdeye Price', csv_row)


class TestPoolStateRow(unittest.TestCase):
    """Test PoolStateRow dataclass with new fields."""

    def test_new_pool_metrics_fields_exist(self):
        """Verify new pool metrics fields are present."""
        row = PoolStateRow()
        self.assertTrue(hasattr(row, 'tvl'))
        self.assertTrue(hasattr(row, 'volume_24h'))
        self.assertTrue(hasattr(row, 'volume_tvl_ratio'))
        self.assertEqual(row.tvl, 0.0)
        self.assertEqual(row.volume_24h, 0.0)
        self.assertEqual(row.volume_tvl_ratio, 0.0)

    def test_new_price_comparison_field_exists(self):
        """Verify new Birdeye price field is present."""
        row = PoolStateRow()
        self.assertTrue(hasattr(row, 'birdeye_price'))
        self.assertEqual(row.birdeye_price, 0.0)

    def test_new_position_tracking_fields_exist(self):
        """Verify new position tracking fields are present."""
        row = PoolStateRow()
        self.assertTrue(hasattr(row, 'position_il_usd'))
        self.assertTrue(hasattr(row, 'position_il_pct'))
        self.assertTrue(hasattr(row, 'pending_fees_sol'))
        self.assertTrue(hasattr(row, 'pending_fees_usdc'))

    def test_to_csv_row_returns_dict(self):
        """Verify to_csv_row() returns a dictionary."""
        row = PoolStateRow(
            price=225.0,
            tvl=1000000.0,
            volume_24h=500000.0,
            birdeye_price=225.5,
        )
        csv_row = row.to_csv_row()

        # Should be a dict with all expected columns
        self.assertIsInstance(csv_row, dict)
        self.assertEqual(len(csv_row), len(POOL_STATE_COLUMNS))

        # Check new fields are included
        self.assertIn('TVL ($)', csv_row)
        self.assertIn('Volume 24h ($)', csv_row)
        self.assertIn('Birdeye Price', csv_row)


class TestCSVLoggerNewFields(unittest.TestCase):
    """Test CSVLogger with new comprehensive fields."""

    def setUp(self):
        """Create a temporary directory for test CSV files."""
        self.temp_dir = tempfile.mkdtemp()
        # Mock config to use temp directory
        with patch('csv_logger.get_config') as mock_config:
            mock_config.return_value.session.data_dir = self.temp_dir
            self.csv_logger = CSVLogger(output_dir=self.temp_dir)

    def tearDown(self):
        """Clean up temporary files."""
        import shutil
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def test_log_position_open_with_new_fields(self):
        """Test log_position_open accepts new parameters."""
        self.csv_logger.log_position_open(
            position_address="test_position_123",
            entry_price=225.0,
            sol_amount=1.0,
            usdc_amount=225.0,
            lower_price=220.0,
            upper_price=230.0,
            tx_signature="test_sig",
            open_attempts=1,
            tvl=1000000.0,
            volume_24h=500000.0,
            tx_fee_sol=0.001,
            birdeye_price=225.5,
            pool_price=225.0,
            fee_growth_checkpoint_a=12345,
            fee_growth_checkpoint_b=67890,
        )

        # Verify position is tracked
        current = self.csv_logger.get_current_position()
        self.assertIsNotNone(current)
        self.assertEqual(current.position_address, "test_position_123")
        self.assertEqual(current.tx_fee_open_sol, 0.001)
        self.assertEqual(current.birdeye_price_entry, 225.5)
        self.assertEqual(current.pool_price_entry, 225.0)

    def test_log_position_close_with_tx_fee(self):
        """Test log_position_close accepts tx_fee_sol parameter."""
        # First open a position
        self.csv_logger.log_position_open(
            position_address="test_position_456",
            entry_price=225.0,
            sol_amount=1.0,
            usdc_amount=225.0,
            lower_price=220.0,
            upper_price=230.0,
            tx_signature="open_sig",
        )

        # Close it with tx fee
        self.csv_logger.log_position_close(
            position_address="test_position_456",
            exit_price=230.0,
            sol_withdrawn=0.95,
            usdc_withdrawn=235.0,
            fees_sol=0.001,
            fees_usdc=0.5,
            tx_signature="close_sig",
            tx_fee_sol=0.002,
        )

        # Verify position was closed
        current = self.csv_logger.get_current_position()
        self.assertIsNone(current)

    def test_log_swap_with_new_fields(self):
        """Test log_swap accepts new parameters."""
        self.csv_logger.log_swap(
            direction="sell_sol",
            sol_amount=0.5,
            usdc_amount=112.5,
            price=225.0,
            tx_signature="swap_sig",
            tx_fee_sol=0.0005,
            birdeye_price=225.5,
        )

        # Verify swap was logged (check file exists and has data)
        asset_fee_file = os.path.join(self.temp_dir, "asset_fees_management.csv")
        self.assertTrue(os.path.exists(asset_fee_file))

        # Read and verify content
        with open(asset_fee_file, 'r') as f:
            reader = csv.DictReader(f)
            rows = list(reader)
            self.assertEqual(len(rows), 1)
            self.assertIn('TX Fee (SOL)', rows[0])

    def test_log_pool_state_with_new_fields(self):
        """Test log_pool_state accepts new parameters."""
        self.csv_logger.log_pool_state(
            price=225.0,
            sqrt_price=277145889579725455648,
            tick_current=-30000,
            tick_spacing=64,
            liquidity=1000000000,
            fee_rate=3000,
            fee_growth_global_a=12345678,
            fee_growth_global_b=87654321,
            pool_address="test_pool",
            tvl=1000000.0,
            volume_24h=500000.0,
            birdeye_price=225.5,
            position_il_usd=-5.0,
            position_il_pct=-0.5,
            pending_fees_sol=0.001,
            pending_fees_usdc=0.2,
        )

        # Verify pool state was logged (check file exists and has data)
        pool_state_file = os.path.join(self.temp_dir, "pool_state_history.csv")
        self.assertTrue(os.path.exists(pool_state_file))

        # Read and verify content
        with open(pool_state_file, 'r') as f:
            reader = csv.DictReader(f)
            rows = list(reader)
            self.assertEqual(len(rows), 1)
            self.assertIn('TVL ($)', rows[0])
            self.assertIn('Volume 24h ($)', rows[0])
            self.assertIn('Birdeye Price', rows[0])

    def test_update_position_il(self):
        """Test update_position_il method updates current position."""
        # First open a position
        self.csv_logger.log_position_open(
            position_address="test_position_il",
            entry_price=225.0,
            sol_amount=1.0,
            usdc_amount=225.0,
            lower_price=220.0,
            upper_price=230.0,
            tx_signature="open_sig",
        )

        # Update IL
        self.csv_logger.update_position_il(
            current_price=230.0,
            pending_fees_sol=0.002,
            pending_fees_usdc=0.5,
        )

        # Verify IL was updated
        current = self.csv_logger.get_current_position()
        self.assertIsNotNone(current)
        self.assertEqual(current.pending_fees_sol, 0.002)
        self.assertEqual(current.pending_fees_usdc, 0.5)


class TestColumnHeaders(unittest.TestCase):
    """Test that column headers include all new fields."""

    def test_lp_columns_include_tx_fees(self):
        """LP_COLUMNS should include TX fee columns."""
        self.assertIn('TX Fee Open (SOL)', LP_COLUMNS)
        self.assertIn('TX Fee Close (SOL)', LP_COLUMNS)
        self.assertIn('TX Fee Total (SOL)', LP_COLUMNS)

    def test_lp_columns_include_il_tracking(self):
        """LP_COLUMNS should include IL tracking columns."""
        self.assertIn('Current IL ($)', LP_COLUMNS)
        self.assertIn('Current IL (%)', LP_COLUMNS)

    def test_lp_columns_include_fee_accrual(self):
        """LP_COLUMNS should include fee accrual columns."""
        self.assertIn('Fee Checkpoint A', LP_COLUMNS)
        self.assertIn('Fee Checkpoint B', LP_COLUMNS)
        self.assertIn('Pending Fees SOL', LP_COLUMNS)
        self.assertIn('Pending Fees USDC', LP_COLUMNS)

    def test_lp_columns_include_price_comparison(self):
        """LP_COLUMNS should include price comparison columns."""
        self.assertIn('Birdeye price (entry)', LP_COLUMNS)
        self.assertIn('Pool price (entry)', LP_COLUMNS)

    def test_asset_fee_columns_include_tx_fee(self):
        """ASSET_FEE_COLUMNS should include TX fee column."""
        self.assertIn('TX Fee (SOL)', ASSET_FEE_COLUMNS)
        self.assertIn('Birdeye Price', ASSET_FEE_COLUMNS)

    def test_pool_state_columns_include_metrics(self):
        """POOL_STATE_COLUMNS should include pool metrics."""
        self.assertIn('TVL ($)', POOL_STATE_COLUMNS)
        self.assertIn('Volume 24h ($)', POOL_STATE_COLUMNS)
        self.assertIn('Volume/TVL', POOL_STATE_COLUMNS)
        self.assertIn('Birdeye Price', POOL_STATE_COLUMNS)
        self.assertIn('Price Diff (%)', POOL_STATE_COLUMNS)

    def test_pool_state_columns_include_position_tracking(self):
        """POOL_STATE_COLUMNS should include position tracking."""
        self.assertIn('Position IL ($)', POOL_STATE_COLUMNS)
        self.assertIn('Position IL (%)', POOL_STATE_COLUMNS)
        self.assertIn('Pending Fees SOL', POOL_STATE_COLUMNS)
        self.assertIn('Pending Fees USDC', POOL_STATE_COLUMNS)


if __name__ == '__main__':
    unittest.main(verbosity=2)
