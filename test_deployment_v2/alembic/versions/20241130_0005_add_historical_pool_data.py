"""Add historical pool data tables for Dune caching

Revision ID: 0005
Revises: 0004
Create Date: 2024-11-30

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = '005'
down_revision: Union[str, None] = '004'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Create historical_pool_data table
    op.create_table(
        'historical_pool_data',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('pool_address', sa.String(100), nullable=False),
        sa.Column('data_source', sa.String(50), nullable=False, server_default='dune'),
        sa.Column('date', sa.Date(), nullable=False),
        sa.Column('volume_usd', sa.Numeric(20, 6), nullable=False, server_default='0'),
        sa.Column('num_swaps', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('fees_usd', sa.Numeric(20, 6), nullable=False, server_default='0'),
        sa.Column('fee_rate_bps', sa.Integer(), nullable=True),
        sa.Column('tvl_usd', sa.Numeric(20, 6), nullable=True),
        sa.Column('fee_apr', sa.Numeric(10, 4), nullable=True),
        sa.Column('avg_price', sa.Numeric(20, 6), nullable=True),
        sa.Column('high_price', sa.Numeric(20, 6), nullable=True),
        sa.Column('low_price', sa.Numeric(20, 6), nullable=True),
        sa.Column('raw_data', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('pool_address', 'date', 'data_source', name='uq_historical_pool_data')
    )
    op.create_index('ix_historical_pool_data_pool_date', 'historical_pool_data', ['pool_address', 'date'])
    op.create_index('ix_historical_pool_data_pool_address', 'historical_pool_data', ['pool_address'])
    op.create_index('ix_historical_pool_data_date', 'historical_pool_data', ['date'])
    op.create_index('ix_historical_pool_data_id', 'historical_pool_data', ['id'])

    # Create historical_data_fetch_log table
    op.create_table(
        'historical_data_fetch_log',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('data_source', sa.String(50), nullable=False),
        sa.Column('pool_address', sa.String(100), nullable=False),
        sa.Column('start_date', sa.Date(), nullable=False),
        sa.Column('end_date', sa.Date(), nullable=False),
        sa.Column('status', sa.String(20), nullable=False),
        sa.Column('rows_fetched', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('error_message', sa.Text(), nullable=True),
        sa.Column('credits_used', sa.Integer(), nullable=True),
        sa.PrimaryKeyConstraint('id')
    )
    op.create_index('ix_fetch_log_source_pool', 'historical_data_fetch_log', ['data_source', 'pool_address'])
    op.create_index('ix_historical_data_fetch_log_id', 'historical_data_fetch_log', ['id'])


def downgrade() -> None:
    op.drop_index('ix_historical_data_fetch_log_id', table_name='historical_data_fetch_log')
    op.drop_index('ix_fetch_log_source_pool', table_name='historical_data_fetch_log')
    op.drop_table('historical_data_fetch_log')

    op.drop_index('ix_historical_pool_data_id', table_name='historical_pool_data')
    op.drop_index('ix_historical_pool_data_date', table_name='historical_pool_data')
    op.drop_index('ix_historical_pool_data_pool_address', table_name='historical_pool_data')
    op.drop_index('ix_historical_pool_data_pool_date', table_name='historical_pool_data')
    op.drop_table('historical_pool_data')
