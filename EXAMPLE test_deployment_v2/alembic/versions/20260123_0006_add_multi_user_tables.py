"""Add multi-user platform tables

Revision ID: 0006
Revises: 005
Create Date: 2026-01-23

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = '006'
down_revision: Union[str, None] = '005'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Create users table
    op.create_table(
        'users',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('wallet_pubkey', sa.String(50), nullable=False),
        sa.Column('email', sa.String(255), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('last_login', sa.DateTime(timezone=True), nullable=True),
        sa.Column('is_active', sa.Boolean(), nullable=False, server_default='true'),
        sa.Column('settings', postgresql.JSONB(astext_type=sa.Text()), nullable=False, server_default='{}'),
        sa.PrimaryKeyConstraint('id')
    )
    op.create_index('ix_users_id', 'users', ['id'])
    op.create_index('ix_users_wallet_pubkey', 'users', ['wallet_pubkey'], unique=True)
    op.create_index('ix_users_wallet_active', 'users', ['wallet_pubkey', 'is_active'])

    # Create user_hot_wallets table
    op.create_table(
        'user_hot_wallets',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('user_id', sa.Integer(), nullable=False),
        sa.Column('wallet_pubkey', sa.String(50), nullable=False),
        sa.Column('encrypted_private_key', sa.Text(), nullable=False),
        sa.Column('derivation_index', sa.Integer(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('user_id'),
        sa.UniqueConstraint('derivation_index')
    )
    op.create_index('ix_user_hot_wallets_id', 'user_hot_wallets', ['id'])
    op.create_index('ix_user_hot_wallets_wallet_pubkey', 'user_hot_wallets', ['wallet_pubkey'], unique=True)

    # Create user_strategy_configs table
    op.create_table(
        'user_strategy_configs',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('user_id', sa.Integer(), nullable=False),
        sa.Column('config_name', sa.String(100), nullable=False, server_default='default'),
        # Range Configuration
        sa.Column('k_coefficient', sa.Numeric(4, 2), nullable=False, server_default='0.60'),
        sa.Column('min_range', sa.Numeric(4, 2), nullable=False, server_default='0.03'),
        sa.Column('max_range', sa.Numeric(4, 2), nullable=False, server_default='0.07'),
        # ATR Configuration
        sa.Column('atr_period_days', sa.Integer(), nullable=False, server_default='14'),
        sa.Column('atr_change_threshold', sa.Numeric(4, 2), nullable=False, server_default='0.15'),
        # Rebalance Configuration
        sa.Column('max_rebalances_per_day', sa.Integer(), nullable=False, server_default='2'),
        sa.Column('max_emergency_rebalances', sa.Integer(), nullable=False, server_default='4'),
        sa.Column('ratio_skew_threshold', sa.Numeric(4, 2), nullable=False, server_default='0.90'),
        sa.Column('ratio_skew_emergency', sa.Numeric(4, 2), nullable=False, server_default='0.98'),
        # Capital Configuration
        sa.Column('capital_deployment_pct', sa.Numeric(4, 2), nullable=False, server_default='0.80'),
        sa.Column('max_sol_per_position', sa.Numeric(20, 9), nullable=False, server_default='1.0'),
        sa.Column('min_sol_reserve', sa.Numeric(20, 9), nullable=False, server_default='0.05'),
        # Stop Loss Configuration
        sa.Column('stop_loss_enabled', sa.Boolean(), nullable=False, server_default='false'),
        sa.Column('stop_loss_pct', sa.Numeric(4, 2), nullable=False, server_default='0.10'),
        # Timing Configuration
        sa.Column('check_interval_seconds', sa.Integer(), nullable=False, server_default='30'),
        # Status
        sa.Column('is_active', sa.Boolean(), nullable=False, server_default='true'),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('user_id', 'config_name', name='uq_user_config_name')
    )
    op.create_index('ix_user_strategy_configs_id', 'user_strategy_configs', ['id'])
    op.create_index('ix_user_strategy_configs_user_active', 'user_strategy_configs', ['user_id', 'is_active'])

    # Create user_strategy_sessions table
    op.create_table(
        'user_strategy_sessions',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('user_id', sa.Integer(), nullable=False),
        sa.Column('config_id', sa.Integer(), nullable=True),
        sa.Column('status', sa.String(20), nullable=False, server_default='pending'),
        sa.Column('started_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('stopped_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('celery_task_id', sa.String(50), nullable=True),
        sa.Column('error_message', sa.Text(), nullable=True),
        sa.Column('error_count', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('last_error_at', sa.DateTime(timezone=True), nullable=True),
        # Performance tracking
        sa.Column('initial_value_usd', sa.Numeric(20, 6), nullable=True),
        sa.Column('current_value_usd', sa.Numeric(20, 6), nullable=True),
        sa.Column('total_fees_earned_usd', sa.Numeric(20, 6), nullable=False, server_default='0'),
        sa.Column('total_il_usd', sa.Numeric(20, 6), nullable=False, server_default='0'),
        sa.Column('total_tx_costs_usd', sa.Numeric(20, 6), nullable=False, server_default='0'),
        # Activity tracking
        sa.Column('rebalance_count', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('last_rebalance_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('last_heartbeat_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['config_id'], ['user_strategy_configs.id'], ondelete='SET NULL'),
        sa.PrimaryKeyConstraint('id')
    )
    op.create_index('ix_user_strategy_sessions_id', 'user_strategy_sessions', ['id'])
    op.create_index('ix_user_sessions_user_status', 'user_strategy_sessions', ['user_id', 'status'])
    op.create_index('ix_user_sessions_celery_task', 'user_strategy_sessions', ['celery_task_id'])

    # Create user_metric_snapshots table
    op.create_table(
        'user_metric_snapshots',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('user_id', sa.Integer(), nullable=False),
        sa.Column('session_id', sa.Integer(), nullable=True),
        sa.Column('timestamp', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        # Portfolio value
        sa.Column('total_value_usd', sa.Numeric(20, 6), nullable=False),
        sa.Column('sol_balance', sa.Numeric(20, 9), nullable=False),
        sa.Column('usdc_balance', sa.Numeric(20, 6), nullable=False),
        sa.Column('position_value_usd', sa.Numeric(20, 6), nullable=False, server_default='0'),
        # Performance metrics
        sa.Column('realized_pnl_usd', sa.Numeric(20, 6), nullable=False, server_default='0'),
        sa.Column('unrealized_pnl_usd', sa.Numeric(20, 6), nullable=False, server_default='0'),
        sa.Column('fees_earned_usd', sa.Numeric(20, 6), nullable=False, server_default='0'),
        sa.Column('il_usd', sa.Numeric(20, 6), nullable=False, server_default='0'),
        sa.Column('tx_costs_usd', sa.Numeric(20, 6), nullable=False, server_default='0'),
        # Market data
        sa.Column('sol_price_usd', sa.Numeric(20, 6), nullable=True),
        sa.Column('pool_price', sa.Numeric(20, 6), nullable=True),
        # Position status
        sa.Column('has_active_position', sa.Boolean(), nullable=False, server_default='false'),
        sa.Column('position_in_range', sa.Boolean(), nullable=True),
        sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['session_id'], ['user_strategy_sessions.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id')
    )
    op.create_index('ix_user_metric_snapshots_id', 'user_metric_snapshots', ['id'])
    op.create_index('ix_user_metric_snapshots_timestamp', 'user_metric_snapshots', ['timestamp'])
    op.create_index('ix_user_metrics_user_ts', 'user_metric_snapshots', ['user_id', 'timestamp'])
    op.create_index('ix_user_metrics_session_ts', 'user_metric_snapshots', ['session_id', 'timestamp'])

    # Create user_positions table
    op.create_table(
        'user_positions',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('user_id', sa.Integer(), nullable=False),
        sa.Column('session_id', sa.Integer(), nullable=True),
        sa.Column('position_pubkey', sa.String(100), nullable=False),
        sa.Column('pool_id', sa.String(100), nullable=False),
        # Position parameters
        sa.Column('lower_tick', sa.Integer(), nullable=False),
        sa.Column('upper_tick', sa.Integer(), nullable=False),
        sa.Column('lower_price', sa.Numeric(20, 6), nullable=False),
        sa.Column('upper_price', sa.Numeric(20, 6), nullable=False),
        sa.Column('liquidity', sa.Numeric(38, 0), nullable=False),
        # Token amounts at entry
        sa.Column('entry_sol_amount', sa.Numeric(20, 9), nullable=False),
        sa.Column('entry_usdc_amount', sa.Numeric(20, 6), nullable=False),
        sa.Column('entry_price', sa.Numeric(20, 6), nullable=False),
        sa.Column('entry_value_usd', sa.Numeric(20, 6), nullable=False),
        # Current token amounts
        sa.Column('current_sol_amount', sa.Numeric(20, 9), nullable=True),
        sa.Column('current_usdc_amount', sa.Numeric(20, 6), nullable=True),
        # Fees collected
        sa.Column('fees_sol_collected', sa.Numeric(20, 9), nullable=False, server_default='0'),
        sa.Column('fees_usdc_collected', sa.Numeric(20, 6), nullable=False, server_default='0'),
        # Exit data
        sa.Column('exit_price', sa.Numeric(20, 6), nullable=True),
        sa.Column('exit_value_usd', sa.Numeric(20, 6), nullable=True),
        sa.Column('exit_reason', sa.String(50), nullable=True),
        # PnL calculations
        sa.Column('realized_pnl_usd', sa.Numeric(20, 6), nullable=True),
        sa.Column('il_usd', sa.Numeric(20, 6), nullable=True),
        # Transaction signatures
        sa.Column('open_tx_sig', sa.String(100), nullable=True),
        sa.Column('close_tx_sig', sa.String(100), nullable=True),
        # Timestamps
        sa.Column('opened_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('closed_at', sa.DateTime(timezone=True), nullable=True),
        # Status
        sa.Column('is_active', sa.Boolean(), nullable=False, server_default='true'),
        sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['session_id'], ['user_strategy_sessions.id'], ondelete='SET NULL'),
        sa.PrimaryKeyConstraint('id')
    )
    op.create_index('ix_user_positions_id', 'user_positions', ['id'])
    op.create_index('ix_user_positions_position_pubkey', 'user_positions', ['position_pubkey'], unique=True)
    op.create_index('ix_user_positions_pool_id', 'user_positions', ['pool_id'])
    op.create_index('ix_user_positions_is_active', 'user_positions', ['is_active'])
    op.create_index('ix_user_positions_user_active', 'user_positions', ['user_id', 'is_active'])
    op.create_index('ix_user_positions_session', 'user_positions', ['session_id'])

    # Create user_rebalances table
    op.create_table(
        'user_rebalances',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('user_id', sa.Integer(), nullable=False),
        sa.Column('session_id', sa.Integer(), nullable=True),
        sa.Column('ts', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        # Old position
        sa.Column('old_position_id', sa.Integer(), nullable=True),
        sa.Column('old_lower_tick', sa.Integer(), nullable=True),
        sa.Column('old_upper_tick', sa.Integer(), nullable=True),
        # New position
        sa.Column('new_position_id', sa.Integer(), nullable=True),
        sa.Column('new_lower_tick', sa.Integer(), nullable=False),
        sa.Column('new_upper_tick', sa.Integer(), nullable=False),
        # Trigger reason
        sa.Column('trigger_reason', sa.String(50), nullable=False),
        # Fees collected
        sa.Column('fees_sol_collected', sa.Numeric(20, 9), nullable=False, server_default='0'),
        sa.Column('fees_usdc_collected', sa.Numeric(20, 6), nullable=False, server_default='0'),
        # Swap details
        sa.Column('swap_direction', sa.String(20), nullable=True),
        sa.Column('swap_amount_in', sa.Numeric(20, 9), nullable=True),
        sa.Column('swap_amount_out', sa.Numeric(20, 9), nullable=True),
        sa.Column('swap_price', sa.Numeric(20, 6), nullable=True),
        # Transaction costs
        sa.Column('tx_fee_sol', sa.Numeric(20, 9), nullable=False, server_default='0'),
        sa.Column('priority_fee_sol', sa.Numeric(20, 9), nullable=False, server_default='0'),
        # Price
        sa.Column('price_at_rebalance', sa.Numeric(20, 6), nullable=False),
        # Status
        sa.Column('status', sa.String(20), nullable=False, server_default='success'),
        sa.Column('error_message', sa.Text(), nullable=True),
        # Transaction signatures
        sa.Column('tx_sig_close', sa.String(100), nullable=True),
        sa.Column('tx_sig_swap', sa.String(100), nullable=True),
        sa.Column('tx_sig_open', sa.String(100), nullable=True),
        sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['session_id'], ['user_strategy_sessions.id'], ondelete='SET NULL'),
        sa.ForeignKeyConstraint(['old_position_id'], ['user_positions.id'], ondelete='SET NULL'),
        sa.ForeignKeyConstraint(['new_position_id'], ['user_positions.id'], ondelete='SET NULL'),
        sa.PrimaryKeyConstraint('id')
    )
    op.create_index('ix_user_rebalances_id', 'user_rebalances', ['id'])
    op.create_index('ix_user_rebalances_ts', 'user_rebalances', ['ts'])
    op.create_index('ix_user_rebalances_user_ts', 'user_rebalances', ['user_id', 'ts'])
    op.create_index('ix_user_rebalances_session', 'user_rebalances', ['session_id'])

    # Create user_daily_stats table
    op.create_table(
        'user_daily_stats',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('user_id', sa.Integer(), nullable=False),
        sa.Column('date', sa.Date(), nullable=False),
        # Rebalance tracking
        sa.Column('rebalance_count', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('emergency_rebalance_count', sa.Integer(), nullable=False, server_default='0'),
        # Performance
        sa.Column('fees_earned_usd', sa.Numeric(20, 6), nullable=False, server_default='0'),
        sa.Column('pnl_usd', sa.Numeric(20, 6), nullable=False, server_default='0'),
        sa.Column('tx_costs_usd', sa.Numeric(20, 6), nullable=False, server_default='0'),
        # Activity
        sa.Column('positions_opened', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('positions_closed', sa.Integer(), nullable=False, server_default='0'),
        sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('user_id', 'date', name='uq_user_daily_stats')
    )
    op.create_index('ix_user_daily_stats_id', 'user_daily_stats', ['id'])
    op.create_index('ix_user_daily_stats_date', 'user_daily_stats', ['date'])
    op.create_index('ix_user_daily_stats_user_date', 'user_daily_stats', ['user_id', 'date'])

    # Create auth_nonces table
    op.create_table(
        'auth_nonces',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('wallet_pubkey', sa.String(50), nullable=False),
        sa.Column('nonce', sa.String(64), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('expires_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('used', sa.Boolean(), nullable=False, server_default='false'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('nonce')
    )
    op.create_index('ix_auth_nonces_id', 'auth_nonces', ['id'])
    op.create_index('ix_auth_nonces_wallet_pubkey', 'auth_nonces', ['wallet_pubkey'])
    op.create_index('ix_auth_nonces_wallet_unused', 'auth_nonces', ['wallet_pubkey', 'used'])

    # Create audit_logs table
    op.create_table(
        'audit_logs',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('user_id', sa.Integer(), nullable=True),
        sa.Column('timestamp', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('action', sa.String(50), nullable=False),
        sa.Column('resource_type', sa.String(50), nullable=True),
        sa.Column('resource_id', sa.Integer(), nullable=True),
        sa.Column('ip_address', sa.String(50), nullable=True),
        sa.Column('user_agent', sa.String(500), nullable=True),
        sa.Column('details', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column('success', sa.Boolean(), nullable=False, server_default='true'),
        sa.Column('error_message', sa.Text(), nullable=True),
        sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='SET NULL'),
        sa.PrimaryKeyConstraint('id')
    )
    op.create_index('ix_audit_logs_id', 'audit_logs', ['id'])
    op.create_index('ix_audit_logs_timestamp', 'audit_logs', ['timestamp'])
    op.create_index('ix_audit_logs_action', 'audit_logs', ['action'])
    op.create_index('ix_audit_logs_user_ts', 'audit_logs', ['user_id', 'timestamp'])
    op.create_index('ix_audit_logs_action_ts', 'audit_logs', ['action', 'timestamp'])


def downgrade() -> None:
    # Drop tables in reverse order due to foreign keys
    op.drop_index('ix_audit_logs_action_ts', table_name='audit_logs')
    op.drop_index('ix_audit_logs_user_ts', table_name='audit_logs')
    op.drop_index('ix_audit_logs_action', table_name='audit_logs')
    op.drop_index('ix_audit_logs_timestamp', table_name='audit_logs')
    op.drop_index('ix_audit_logs_id', table_name='audit_logs')
    op.drop_table('audit_logs')

    op.drop_index('ix_auth_nonces_wallet_unused', table_name='auth_nonces')
    op.drop_index('ix_auth_nonces_wallet_pubkey', table_name='auth_nonces')
    op.drop_index('ix_auth_nonces_id', table_name='auth_nonces')
    op.drop_table('auth_nonces')

    op.drop_index('ix_user_daily_stats_user_date', table_name='user_daily_stats')
    op.drop_index('ix_user_daily_stats_date', table_name='user_daily_stats')
    op.drop_index('ix_user_daily_stats_id', table_name='user_daily_stats')
    op.drop_table('user_daily_stats')

    op.drop_index('ix_user_rebalances_session', table_name='user_rebalances')
    op.drop_index('ix_user_rebalances_user_ts', table_name='user_rebalances')
    op.drop_index('ix_user_rebalances_ts', table_name='user_rebalances')
    op.drop_index('ix_user_rebalances_id', table_name='user_rebalances')
    op.drop_table('user_rebalances')

    op.drop_index('ix_user_positions_session', table_name='user_positions')
    op.drop_index('ix_user_positions_user_active', table_name='user_positions')
    op.drop_index('ix_user_positions_is_active', table_name='user_positions')
    op.drop_index('ix_user_positions_pool_id', table_name='user_positions')
    op.drop_index('ix_user_positions_position_pubkey', table_name='user_positions')
    op.drop_index('ix_user_positions_id', table_name='user_positions')
    op.drop_table('user_positions')

    op.drop_index('ix_user_metrics_session_ts', table_name='user_metric_snapshots')
    op.drop_index('ix_user_metrics_user_ts', table_name='user_metric_snapshots')
    op.drop_index('ix_user_metric_snapshots_timestamp', table_name='user_metric_snapshots')
    op.drop_index('ix_user_metric_snapshots_id', table_name='user_metric_snapshots')
    op.drop_table('user_metric_snapshots')

    op.drop_index('ix_user_sessions_celery_task', table_name='user_strategy_sessions')
    op.drop_index('ix_user_sessions_user_status', table_name='user_strategy_sessions')
    op.drop_index('ix_user_strategy_sessions_id', table_name='user_strategy_sessions')
    op.drop_table('user_strategy_sessions')

    op.drop_index('ix_user_strategy_configs_user_active', table_name='user_strategy_configs')
    op.drop_index('ix_user_strategy_configs_id', table_name='user_strategy_configs')
    op.drop_table('user_strategy_configs')

    op.drop_index('ix_user_hot_wallets_wallet_pubkey', table_name='user_hot_wallets')
    op.drop_index('ix_user_hot_wallets_id', table_name='user_hot_wallets')
    op.drop_table('user_hot_wallets')

    op.drop_index('ix_users_wallet_active', table_name='users')
    op.drop_index('ix_users_wallet_pubkey', table_name='users')
    op.drop_index('ix_users_id', table_name='users')
    op.drop_table('users')
