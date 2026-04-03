"""Add key_backup_confirmed_at to user_hot_wallets

Revision ID: add_backup_confirmed
Revises:
Create Date: 2026-02-06 09:00:00.000000

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'add_backup_confirmed'
down_revision = '006'
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Add key_backup_confirmed_at column to track when user confirmed backup
    op.add_column(
        'user_hot_wallets',
        sa.Column('key_backup_confirmed_at', sa.DateTime(timezone=True), nullable=True)
    )


def downgrade() -> None:
    op.drop_column('user_hot_wallets', 'key_backup_confirmed_at')
