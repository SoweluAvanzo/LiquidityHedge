"""add network to control_flags

Revision ID: 004
Revises: 003
Create Date: 2024-11-30

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '004'
down_revision: Union[str, None] = '003'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Add network column to control_flags table
    op.add_column(
        'control_flags',
        sa.Column('network', sa.String(20), nullable=True)
    )


def downgrade() -> None:
    # Remove network column
    op.drop_column('control_flags', 'network')
