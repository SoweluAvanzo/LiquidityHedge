"""Initial schema - Create all tables

Revision ID: 001
Revises:
Create Date: 2024-11-28

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = '001'
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Create strategy_config table
    op.create_table(
        'strategy_config',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('name', sa.String(length=100), nullable=False),
        sa.Column('value', sa.Text(), nullable=False),
        sa.Column('value_type', sa.String(length=20), nullable=False),
        sa.Column('description', sa.Text(), nullable=True),
        sa.Column('updated_by', sa.String(length=100), nullable=True),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('name', name='uq_strategy_config_name')
    )
    op.create_index(op.f('ix_strategy_config_id'), 'strategy_config', ['id'], unique=False)
    op.create_index(op.f('ix_strategy_config_name'), 'strategy_config', ['name'], unique=False)

    # Create positions table
    op.create_table(
        'positions',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('dex', sa.String(length=50), nullable=False),
        sa.Column('pool_id', sa.String(length=100), nullable=False),
        sa.Column('position_pubkey', sa.String(length=100), nullable=False),
        sa.Column('lower_tick', sa.Integer(), nullable=False),
        sa.Column('upper_tick', sa.Integer(), nullable=False),
        sa.Column('liquidity', sa.Numeric(precision=38, scale=0), nullable=False),
        sa.Column('amount_sol', sa.Numeric(precision=20, scale=9), nullable=False, server_default='0'),
        sa.Column('amount_usdc', sa.Numeric(precision=20, scale=6), nullable=False, server_default='0'),
        sa.Column('opened_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=True),
        sa.Column('closed_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('is_active', sa.Boolean(), nullable=True, server_default='true'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('position_pubkey')
    )
    op.create_index(op.f('ix_positions_id'), 'positions', ['id'], unique=False)
    op.create_index(op.f('ix_positions_dex'), 'positions', ['dex'], unique=False)
    op.create_index(op.f('ix_positions_pool_id'), 'positions', ['pool_id'], unique=False)
    op.create_index(op.f('ix_positions_is_active'), 'positions', ['is_active'], unique=False)
    op.create_index('ix_positions_dex_pool', 'positions', ['dex', 'pool_id'], unique=False)
    op.create_index('ix_positions_active_dex', 'positions', ['is_active', 'dex'], unique=False)

    # Create rebalances table
    op.create_table(
        'rebalances',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('ts', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('dex', sa.String(length=50), nullable=False),
        sa.Column('pool_id', sa.String(length=100), nullable=False),
        sa.Column('old_lower_tick', sa.Integer(), nullable=True),
        sa.Column('old_upper_tick', sa.Integer(), nullable=True),
        sa.Column('new_lower_tick', sa.Integer(), nullable=False),
        sa.Column('new_upper_tick', sa.Integer(), nullable=False),
        sa.Column('fees_sol', sa.Numeric(precision=20, scale=9), nullable=False, server_default='0'),
        sa.Column('fees_usdc', sa.Numeric(precision=20, scale=6), nullable=False, server_default='0'),
        sa.Column('pnl_usd', sa.Numeric(precision=20, scale=6), nullable=True),
        sa.Column('tx_sig_remove', sa.String(length=100), nullable=True),
        sa.Column('tx_sig_add', sa.String(length=100), nullable=True),
        sa.Column('tx_sig_swap', sa.String(length=100), nullable=True),
        sa.Column('status', sa.String(length=20), nullable=False, server_default='success'),
        sa.Column('error_message', sa.Text(), nullable=True),
        sa.Column('raw_info', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column('price_at_rebalance', sa.Numeric(precision=20, scale=6), nullable=True),
        sa.Column('position_id', sa.Integer(), nullable=True),
        sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_rebalances_id'), 'rebalances', ['id'], unique=False)
    op.create_index(op.f('ix_rebalances_ts'), 'rebalances', ['ts'], unique=False)
    op.create_index(op.f('ix_rebalances_dex'), 'rebalances', ['dex'], unique=False)
    op.create_index(op.f('ix_rebalances_pool_id'), 'rebalances', ['pool_id'], unique=False)
    op.create_index('ix_rebalances_ts_status', 'rebalances', ['ts', 'status'], unique=False)
    op.create_index('ix_rebalances_dex_ts', 'rebalances', ['dex', 'ts'], unique=False)

    # Create metrics_daily table
    op.create_table(
        'metrics_daily',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('date', sa.Date(), nullable=False),
        sa.Column('dex', sa.String(length=50), nullable=True),
        sa.Column('fees_usd', sa.Numeric(precision=20, scale=6), nullable=False, server_default='0'),
        sa.Column('il_estimate_usd', sa.Numeric(precision=20, scale=6), nullable=False, server_default='0'),
        sa.Column('pnl_usd', sa.Numeric(precision=20, scale=6), nullable=False, server_default='0'),
        sa.Column('volume_usd', sa.Numeric(precision=20, scale=6), nullable=True),
        sa.Column('num_rebalances', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('avg_liquidity', sa.Numeric(precision=38, scale=0), nullable=True),
        sa.Column('time_in_range_pct', sa.Numeric(precision=5, scale=2), nullable=True),
        sa.Column('open_price', sa.Numeric(precision=20, scale=6), nullable=True),
        sa.Column('close_price', sa.Numeric(precision=20, scale=6), nullable=True),
        sa.Column('high_price', sa.Numeric(precision=20, scale=6), nullable=True),
        sa.Column('low_price', sa.Numeric(precision=20, scale=6), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('date', 'dex', name='uq_metrics_daily_date_dex')
    )
    op.create_index(op.f('ix_metrics_daily_id'), 'metrics_daily', ['id'], unique=False)
    op.create_index(op.f('ix_metrics_daily_date'), 'metrics_daily', ['date'], unique=False)
    op.create_index(op.f('ix_metrics_daily_dex'), 'metrics_daily', ['dex'], unique=False)
    op.create_index('ix_metrics_daily_date_dex', 'metrics_daily', ['date', 'dex'], unique=False)

    # Create control_flags table
    op.create_table(
        'control_flags',
        sa.Column('id', sa.Integer(), nullable=False, server_default='1'),
        sa.Column('bot_status', sa.String(length=20), nullable=False, server_default='running'),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('safe_mode', sa.Boolean(), nullable=True, server_default='false'),
        sa.Column('emergency_stop', sa.Boolean(), nullable=True, server_default='false'),
        sa.Column('last_heartbeat', sa.DateTime(timezone=True), nullable=True),
        sa.Column('status_reason', sa.Text(), nullable=True),
        sa.PrimaryKeyConstraint('id')
    )

    # Insert default control flags row
    op.execute(
        "INSERT INTO control_flags (id, bot_status, safe_mode, emergency_stop) "
        "VALUES (1, 'running', false, false) "
        "ON CONFLICT (id) DO NOTHING"
    )


def downgrade() -> None:
    op.drop_table('control_flags')
    op.drop_index('ix_metrics_daily_date_dex', table_name='metrics_daily')
    op.drop_index(op.f('ix_metrics_daily_dex'), table_name='metrics_daily')
    op.drop_index(op.f('ix_metrics_daily_date'), table_name='metrics_daily')
    op.drop_index(op.f('ix_metrics_daily_id'), table_name='metrics_daily')
    op.drop_table('metrics_daily')
    op.drop_index('ix_rebalances_dex_ts', table_name='rebalances')
    op.drop_index('ix_rebalances_ts_status', table_name='rebalances')
    op.drop_index(op.f('ix_rebalances_pool_id'), table_name='rebalances')
    op.drop_index(op.f('ix_rebalances_dex'), table_name='rebalances')
    op.drop_index(op.f('ix_rebalances_ts'), table_name='rebalances')
    op.drop_index(op.f('ix_rebalances_id'), table_name='rebalances')
    op.drop_table('rebalances')
    op.drop_index('ix_positions_active_dex', table_name='positions')
    op.drop_index('ix_positions_dex_pool', table_name='positions')
    op.drop_index(op.f('ix_positions_is_active'), table_name='positions')
    op.drop_index(op.f('ix_positions_pool_id'), table_name='positions')
    op.drop_index(op.f('ix_positions_dex'), table_name='positions')
    op.drop_index(op.f('ix_positions_id'), table_name='positions')
    op.drop_table('positions')
    op.drop_index(op.f('ix_strategy_config_name'), table_name='strategy_config')
    op.drop_index(op.f('ix_strategy_config_id'), table_name='strategy_config')
    op.drop_table('strategy_config')
