"""add dry_run to control_flags

Revision ID: 0003
Revises: 0002
Create Date: 2024-11-29

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '003'
down_revision: Union[str, None] = '002'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Add dry_run column to control_flags table
    op.add_column(
        'control_flags',
        sa.Column('dry_run', sa.Boolean(), nullable=False, server_default='true')
    )


def downgrade() -> None:
    # Remove dry_run column
    op.drop_column('control_flags', 'dry_run')
