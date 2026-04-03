"""Add wallet tracking tables

Revision ID: 002
Revises: 001
Create Date: 2024-11-29

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = '002'
down_revision: Union[str, None] = '001'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Create wallet_sessions table
    op.create_table(
        'wallet_sessions',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('session_id', sa.String(length=64), nullable=False),
        sa.Column('wallet_pubkey', sa.String(length=50), nullable=False),
        sa.Column('wallet_name', sa.String(length=100), nullable=True),
        sa.Column('is_view_only', sa.Boolean(), server_default='false', nullable=False),
        sa.Column('encrypted_private_key', sa.Text(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('last_accessed', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('session_id', name='uq_wallet_sessions_session_id')
    )
    op.create_index(op.f('ix_wallet_sessions_wallet_pubkey'), 'wallet_sessions', ['wallet_pubkey'], unique=False)

    # Create wallet_snapshots table
    op.create_table(
        'wallet_snapshots',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('wallet_pubkey', sa.String(length=50), nullable=False),
        sa.Column('ts', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('sol_balance', sa.Numeric(precision=20, scale=9), nullable=False),
        sa.Column('usdc_balance', sa.Numeric(precision=20, scale=6), nullable=False),
        sa.Column('sol_price_usd', sa.Numeric(precision=20, scale=6), nullable=True),
        sa.Column('position_value_usd', sa.Numeric(precision=20, scale=6), server_default='0', nullable=True),
        sa.Column('total_value_usd', sa.Numeric(precision=20, scale=6), nullable=False),
        sa.Column('is_simulated', sa.Boolean(), server_default='false', nullable=False),
        sa.Column('extra_data', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_wallet_snapshots_id'), 'wallet_snapshots', ['id'], unique=False)
    op.create_index('ix_wallet_snapshots_wallet_ts', 'wallet_snapshots', ['wallet_pubkey', 'ts'], unique=False)
    op.create_index(op.f('ix_wallet_snapshots_ts'), 'wallet_snapshots', ['ts'], unique=False)

    # Add simulation columns to control_flags
    op.add_column('control_flags', sa.Column('sim_sol_balance', sa.Numeric(precision=20, scale=9), server_default='10', nullable=True))
    op.add_column('control_flags', sa.Column('sim_usdc_balance', sa.Numeric(precision=20, scale=6), server_default='1000', nullable=True))
    op.add_column('control_flags', sa.Column('sim_started_at', sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    # Remove simulation columns from control_flags
    op.drop_column('control_flags', 'sim_started_at')
    op.drop_column('control_flags', 'sim_usdc_balance')
    op.drop_column('control_flags', 'sim_sol_balance')

    # Drop wallet_snapshots
    op.drop_index(op.f('ix_wallet_snapshots_ts'), table_name='wallet_snapshots')
    op.drop_index('ix_wallet_snapshots_wallet_ts', table_name='wallet_snapshots')
    op.drop_index(op.f('ix_wallet_snapshots_id'), table_name='wallet_snapshots')
    op.drop_table('wallet_snapshots')

    # Drop wallet_sessions
    op.drop_index(op.f('ix_wallet_sessions_wallet_pubkey'), table_name='wallet_sessions')
    op.drop_table('wallet_sessions')
