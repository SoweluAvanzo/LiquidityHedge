#!/usr/bin/env python3
"""
Test script for wSOL cleanup functionality.

This script tests the wSOL cleanup module without requiring actual Solana
connections. Run with: python test_wsol_cleanup.py
"""

import asyncio
import sys
from pathlib import Path

# Add project root to path
project_root = Path(__file__).parent
sys.path.insert(0, str(project_root))


def test_imports():
    """Test that all modules can be imported."""
    print("Testing imports...")

    try:
        from app.chain.wsol_cleanup import (
            WsolCleanupManager,
            WsolAccountInfo,
            CleanupResult,
            build_close_account_instruction,
            WSOL_MINT,
            WSOL_MINT_STR,
            TOKEN_PROGRAM_ID,
        )
        print("  - wsol_cleanup module: OK")
    except ImportError as e:
        print(f"  - wsol_cleanup module: FAILED - {e}")
        return False

    try:
        from config import Config, WsolCleanupConfig
        print("  - config module: OK")
    except ImportError as e:
        print(f"  - config module: FAILED - {e}")
        return False

    return True


def test_cleanup_result():
    """Test CleanupResult dataclass."""
    print("\nTesting CleanupResult...")

    from app.chain.wsol_cleanup import CleanupResult

    # Test default values
    result = CleanupResult(success=True)
    assert result.success is True
    assert result.accounts_cleaned == 0
    assert result.total_sol_recovered == 0.0
    assert result.signatures == []
    assert result.skipped_accounts == []
    assert result.error is None
    print("  - Default values: OK")

    # Test with values
    result = CleanupResult(
        success=True,
        accounts_cleaned=3,
        total_sol_recovered=1.5,
        signatures=["sig1", "sig2", "sig3"],
        skipped_accounts=["acc1"],
    )
    assert result.accounts_cleaned == 3
    assert result.total_sol_recovered == 1.5
    print("  - With values: OK")

    return True


def test_wsol_account_info():
    """Test WsolAccountInfo dataclass."""
    print("\nTesting WsolAccountInfo...")

    from app.chain.wsol_cleanup import WsolAccountInfo

    # Test without delegation
    account = WsolAccountInfo(
        pubkey="test_pubkey",
        balance_lamports=1_000_000_000,
        balance_sol=1.0,
        owner="owner_pubkey",
    )
    assert account.has_active_delegation is False
    assert account.can_close is True
    print("  - No delegation: OK")

    # Test with delegation
    account_delegated = WsolAccountInfo(
        pubkey="test_pubkey",
        balance_lamports=1_000_000_000,
        balance_sol=1.0,
        owner="owner_pubkey",
        delegated_amount=500_000_000,
        delegate="delegate_pubkey",
    )
    assert account_delegated.has_active_delegation is True
    assert account_delegated.can_close is False
    print("  - With delegation: OK")

    # Test frozen account
    account_frozen = WsolAccountInfo(
        pubkey="test_pubkey",
        balance_lamports=1_000_000_000,
        balance_sol=1.0,
        owner="owner_pubkey",
        is_frozen=True,
    )
    assert account_frozen.can_close is False
    print("  - Frozen account: OK")

    return True


def test_build_instruction():
    """Test instruction building."""
    print("\nTesting instruction building...")

    from app.chain.wsol_cleanup import build_close_account_instruction, TOKEN_PROGRAM_ID
    from solders.pubkey import Pubkey

    account = Pubkey.from_string("So11111111111111111111111111111111111111112")
    destination = Pubkey.from_string("11111111111111111111111111111111")
    owner = Pubkey.from_string("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")

    ix = build_close_account_instruction(
        account=account,
        destination=destination,
        owner=owner,
    )

    assert ix.program_id == TOKEN_PROGRAM_ID
    assert len(ix.accounts) == 3
    assert ix.data == bytes([9])  # CLOSE_ACCOUNT_IX
    print("  - Close instruction: OK")

    return True


def test_config():
    """Test wSOL cleanup config."""
    print("\nTesting configuration...")

    from config import Config, WsolCleanupConfig

    config = Config()

    # Check default values
    assert hasattr(config, 'wsol_cleanup')
    assert config.wsol_cleanup.enabled is True
    assert config.wsol_cleanup.cleanup_on_startup is True
    assert config.wsol_cleanup.cleanup_after_close is True
    assert config.wsol_cleanup.periodic_cleanup is True
    assert config.wsol_cleanup.periodic_interval == 10
    print("  - Default config values: OK")

    return True


def test_cleanup_manager_init():
    """Test WsolCleanupManager initialization."""
    print("\nTesting WsolCleanupManager...")

    from app.chain.wsol_cleanup import WsolCleanupManager

    manager = WsolCleanupManager()
    assert manager.is_enabled is True  # Default enabled
    print("  - Manager initialization: OK")

    return True


async def run_all_tests():
    """Run all tests."""
    print("=" * 60)
    print("wSOL Cleanup Module Tests")
    print("=" * 60)

    all_passed = True

    tests = [
        test_imports,
        test_cleanup_result,
        test_wsol_account_info,
        test_build_instruction,
        test_config,
        test_cleanup_manager_init,
    ]

    for test in tests:
        try:
            if not test():
                all_passed = False
        except Exception as e:
            print(f"  EXCEPTION: {e}")
            all_passed = False

    print("\n" + "=" * 60)
    if all_passed:
        print("ALL TESTS PASSED")
    else:
        print("SOME TESTS FAILED")
    print("=" * 60)

    return all_passed


if __name__ == "__main__":
    success = asyncio.run(run_all_tests())
    sys.exit(0 if success else 1)
