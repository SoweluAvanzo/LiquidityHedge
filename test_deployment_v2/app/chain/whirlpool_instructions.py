"""
Whirlpool instruction builders for Orca CLMM operations.

This module provides low-level instruction building for Orca Whirlpools,
including position management, liquidity operations, and fee collection.

Based on the Whirlpool program IDL and instruction layouts.
"""

import hashlib
import struct
from dataclasses import dataclass
from typing import List, Tuple, Optional

import structlog
from solders.pubkey import Pubkey
from solders.keypair import Keypair
from solders.instruction import Instruction, AccountMeta
from solders.system_program import ID as SYSTEM_PROGRAM_ID

from app.config import get_settings

logger = structlog.get_logger(__name__)
settings = get_settings()

# Program IDs
WHIRLPOOL_PROGRAM_ID = Pubkey.from_string(settings.orca_whirlpool_program_id)
TOKEN_PROGRAM_ID = Pubkey.from_string("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")
TOKEN_2022_PROGRAM_ID = Pubkey.from_string("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb")
ASSOCIATED_TOKEN_PROGRAM_ID = Pubkey.from_string("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL")
RENT_SYSVAR_ID = Pubkey.from_string("SysvarRent111111111111111111111111111111111")
METADATA_PROGRAM_ID = Pubkey.from_string("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s")
# Whirlpool NFT Update Authority - required for Token Extensions positions
WHIRLPOOL_NFT_UPDATE_AUTH = Pubkey.from_string("3axbTs2z5GBy6usVbNVoqEgZMng3vZvMnAoX29BFfwhr")

# Instruction discriminators (first 8 bytes of SHA256 hash of instruction name)
# Format: sha256("global:<instruction_name>")[0:8]
DISCRIMINATORS = {
    "open_position": bytes([135, 128, 47, 77, 15, 152, 240, 49]),
    "open_position_with_metadata": bytes([242, 29, 134, 48, 58, 110, 14, 60]),  # Fixed
    "open_position_with_token_extensions": bytes([212, 47, 95, 92, 114, 102, 131, 250]),  # Token2022
    "increase_liquidity": bytes([46, 156, 243, 118, 13, 205, 251, 178]),
    "decrease_liquidity": bytes([160, 38, 208, 111, 104, 91, 44, 1]),
    "update_fees_and_rewards": bytes([154, 230, 250, 13, 236, 209, 75, 223]),
    "collect_fees": bytes([164, 152, 207, 99, 30, 186, 19, 182]),
    "collect_reward": bytes([70, 5, 132, 87, 86, 235, 177, 34]),
    "close_position": bytes([123, 134, 81, 0, 49, 68, 98, 98]),
    "close_position_with_token_extensions": bytes([1, 182, 135, 59, 155, 25, 99, 223]),  # Token2022
    "swap": bytes([248, 198, 158, 145, 225, 117, 135, 200]),
    "initialize_tick_array": bytes([11, 188, 193, 214, 141, 91, 149, 184]),  # Fixed
}

# Constants
TICK_ARRAY_SIZE = 88  # Number of ticks per tick array
MIN_TICK_INDEX = -443636
MAX_TICK_INDEX = 443636


def compute_discriminator(instruction_name: str) -> bytes:
    """Compute the 8-byte discriminator for an Anchor instruction."""
    preimage = f"global:{instruction_name}"
    hash_bytes = hashlib.sha256(preimage.encode()).digest()
    return hash_bytes[:8]


@dataclass
class WhirlpoolAccounts:
    """Account addresses for Whirlpool operations."""
    whirlpool: Pubkey
    token_vault_a: Pubkey
    token_vault_b: Pubkey
    token_mint_a: Pubkey
    token_mint_b: Pubkey
    token_owner_account_a: Pubkey
    token_owner_account_b: Pubkey
    tick_array_lower: Pubkey
    tick_array_upper: Pubkey


@dataclass
class PositionAccounts:
    """Account addresses for position operations."""
    position: Pubkey
    position_mint: Pubkey
    position_token_account: Pubkey
    position_metadata: Optional[Pubkey] = None
    uses_token_extensions: bool = False  # True if using Token2022


def derive_position_pda(position_mint: Pubkey) -> Tuple[Pubkey, int]:
    """
    Derive position PDA from position mint.

    Seeds: ["position", position_mint]
    """
    return Pubkey.find_program_address(
        [b"position", bytes(position_mint)],
        WHIRLPOOL_PROGRAM_ID,
    )


def derive_tick_array_pda(
    whirlpool: Pubkey,
    start_tick_index: int,
) -> Tuple[Pubkey, int]:
    """
    Derive tick array PDA.

    Seeds: ["tick_array", whirlpool, start_tick_index.to_string()]
    Note: Whirlpool uses STRING representation of tick index, not binary bytes!
    """
    # Convert tick index to string (e.g., -28160 -> "-28160")
    start_tick_string = str(start_tick_index).encode()
    return Pubkey.find_program_address(
        [b"tick_array", bytes(whirlpool), start_tick_string],
        WHIRLPOOL_PROGRAM_ID,
    )


def derive_oracle_pda(whirlpool: Pubkey) -> Tuple[Pubkey, int]:
    """
    Derive oracle PDA.

    Seeds: ["oracle", whirlpool]
    """
    return Pubkey.find_program_address(
        [b"oracle", bytes(whirlpool)],
        WHIRLPOOL_PROGRAM_ID,
    )


def get_tick_array_start_index(tick_index: int, tick_spacing: int) -> int:
    """
    Get the start index of the tick array containing the given tick.

    Args:
        tick_index: The tick index to find
        tick_spacing: Pool tick spacing

    Returns:
        Start tick index of the containing tick array
    """
    ticks_in_array = TICK_ARRAY_SIZE * tick_spacing
    # Python floor division handles negative numbers correctly
    return (tick_index // ticks_in_array) * ticks_in_array


def derive_associated_token_address(
    owner: Pubkey,
    mint: Pubkey,
    token_program_id: Pubkey = TOKEN_PROGRAM_ID,
) -> Pubkey:
    """Derive the associated token account address.

    Args:
        owner: Owner of the token account
        mint: Token mint
        token_program_id: Token program (standard or Token2022)
    """
    ata, _ = Pubkey.find_program_address(
        [bytes(owner), bytes(token_program_id), bytes(mint)],
        ASSOCIATED_TOKEN_PROGRAM_ID,
    )
    return ata


def derive_associated_token_address_2022(
    owner: Pubkey,
    mint: Pubkey,
) -> Pubkey:
    """Derive the associated token account address for Token2022."""
    return derive_associated_token_address(owner, mint, TOKEN_2022_PROGRAM_ID)


def derive_metadata_pda(mint: Pubkey) -> Tuple[Pubkey, int]:
    """Derive the metadata PDA for a token mint."""
    return Pubkey.find_program_address(
        [b"metadata", bytes(METADATA_PROGRAM_ID), bytes(mint)],
        METADATA_PROGRAM_ID,
    )


class WhirlpoolInstructionBuilder:
    """
    Builds instructions for Orca Whirlpool operations.

    Provides methods to construct valid Solana instructions for:
    - Opening and closing positions
    - Adding and removing liquidity
    - Collecting fees and rewards
    """

    def __init__(self, whirlpool_program_id: Pubkey = WHIRLPOOL_PROGRAM_ID):
        """Initialize the instruction builder."""
        self.program_id = whirlpool_program_id

    def build_open_position(
        self,
        funder: Pubkey,
        owner: Pubkey,
        whirlpool: Pubkey,
        position_mint: Keypair,
        tick_lower_index: int,
        tick_upper_index: int,
        with_metadata: bool = False,
    ) -> Tuple[Instruction, PositionAccounts]:
        """
        Build an instruction to open a new position.

        Args:
            funder: Account paying for rent
            owner: Owner of the position
            whirlpool: Whirlpool address
            position_mint: Keypair for the new position NFT mint
            tick_lower_index: Lower tick of the position
            tick_upper_index: Upper tick of the position
            with_metadata: Whether to create metadata for the position NFT

        Returns:
            Tuple of (Instruction, PositionAccounts)
        """
        # Derive position PDA
        position_pubkey, position_bump = derive_position_pda(position_mint.pubkey())

        # Derive position token account (ATA for owner)
        position_token_account = derive_associated_token_address(owner, position_mint.pubkey())

        # Derive metadata PDA and get metadata_update_auth
        metadata_pda = None
        metadata_bump = 0
        if with_metadata:
            metadata_pda, metadata_bump = derive_metadata_pda(position_mint.pubkey())

        # Build accounts - ORDER IS CRITICAL!
        # See: https://github.com/orca-so/whirlpools/blob/main/programs/whirlpool/src/instructions/open_position_with_metadata.rs
        if with_metadata:
            # Whirlpool metadata_update_auth is the Whirlpool program itself (or a designated authority)
            # For Orca Whirlpools, this is typically a fixed address
            METADATA_UPDATE_AUTH = Pubkey.from_string("3axbTs2z5GBy6usVbNVoqEgZMng3vZvMnAoX29BFfwhr")

            accounts = [
                AccountMeta(pubkey=funder, is_signer=True, is_writable=True),           # 0: funder
                AccountMeta(pubkey=owner, is_signer=False, is_writable=False),          # 1: owner
                AccountMeta(pubkey=position_pubkey, is_signer=False, is_writable=True), # 2: position
                AccountMeta(pubkey=position_mint.pubkey(), is_signer=True, is_writable=True),  # 3: position_mint
                AccountMeta(pubkey=metadata_pda, is_signer=False, is_writable=True),    # 4: position_metadata_account
                AccountMeta(pubkey=position_token_account, is_signer=False, is_writable=True), # 5: position_token_account
                AccountMeta(pubkey=whirlpool, is_signer=False, is_writable=False),      # 6: whirlpool
                AccountMeta(pubkey=TOKEN_PROGRAM_ID, is_signer=False, is_writable=False),      # 7: token_program
                AccountMeta(pubkey=SYSTEM_PROGRAM_ID, is_signer=False, is_writable=False),     # 8: system_program
                AccountMeta(pubkey=RENT_SYSVAR_ID, is_signer=False, is_writable=False),        # 9: rent
                AccountMeta(pubkey=ASSOCIATED_TOKEN_PROGRAM_ID, is_signer=False, is_writable=False), # 10: associated_token_program
                AccountMeta(pubkey=METADATA_PROGRAM_ID, is_signer=False, is_writable=False),   # 11: metadata_program
                AccountMeta(pubkey=METADATA_UPDATE_AUTH, is_signer=False, is_writable=False),  # 12: metadata_update_auth
            ]
        else:
            accounts = [
                AccountMeta(pubkey=funder, is_signer=True, is_writable=True),
                AccountMeta(pubkey=owner, is_signer=False, is_writable=False),
                AccountMeta(pubkey=position_pubkey, is_signer=False, is_writable=True),
                AccountMeta(pubkey=position_mint.pubkey(), is_signer=True, is_writable=True),
                AccountMeta(pubkey=position_token_account, is_signer=False, is_writable=True),
                AccountMeta(pubkey=whirlpool, is_signer=False, is_writable=False),
                AccountMeta(pubkey=TOKEN_PROGRAM_ID, is_signer=False, is_writable=False),
                AccountMeta(pubkey=SYSTEM_PROGRAM_ID, is_signer=False, is_writable=False),
                AccountMeta(pubkey=RENT_SYSVAR_ID, is_signer=False, is_writable=False),
                AccountMeta(pubkey=ASSOCIATED_TOKEN_PROGRAM_ID, is_signer=False, is_writable=False),
            ]

        # Build instruction data
        if with_metadata:
            # Format: discriminator (8) + position_bump (1) + metadata_bump (1) + tick_lower (4) + tick_upper (4)
            discriminator = DISCRIMINATORS["open_position_with_metadata"]
            data = discriminator + struct.pack("<BBii", position_bump, metadata_bump, tick_lower_index, tick_upper_index)
        else:
            # Format: discriminator (8) + position_bump (1) + tick_lower (4) + tick_upper (4)
            discriminator = DISCRIMINATORS["open_position"]
            data = discriminator + struct.pack("<Bii", position_bump, tick_lower_index, tick_upper_index)

        instruction = Instruction(
            program_id=self.program_id,
            accounts=accounts,
            data=data,
        )

        position_accounts = PositionAccounts(
            position=position_pubkey,
            position_mint=position_mint.pubkey(),
            position_token_account=position_token_account,
            position_metadata=metadata_pda,
        )

        logger.debug(
            "built_open_position_ix",
            position=str(position_pubkey),
            tick_lower=tick_lower_index,
            tick_upper=tick_upper_index,
        )

        return instruction, position_accounts

    def build_increase_liquidity(
        self,
        whirlpool: Pubkey,
        position: Pubkey,
        position_token_account: Pubkey,
        token_owner_account_a: Pubkey,
        token_owner_account_b: Pubkey,
        token_vault_a: Pubkey,
        token_vault_b: Pubkey,
        tick_array_lower: Pubkey,
        tick_array_upper: Pubkey,
        position_authority: Pubkey,
        liquidity_amount: int,
        token_max_a: int,
        token_max_b: int,
    ) -> Instruction:
        """
        Build an instruction to increase liquidity in a position.

        Args:
            whirlpool: Whirlpool address
            position: Position account address
            position_token_account: Position NFT token account
            token_owner_account_a: Owner's token A account
            token_owner_account_b: Owner's token B account
            token_vault_a: Whirlpool's token A vault
            token_vault_b: Whirlpool's token B vault
            tick_array_lower: Tick array containing lower tick
            tick_array_upper: Tick array containing upper tick
            position_authority: Authority that owns the position (must sign)
            liquidity_amount: Amount of liquidity to add (u128)
            token_max_a: Maximum token A to deposit
            token_max_b: Maximum token B to deposit

        Returns:
            Instruction for increase liquidity
        """
        accounts = [
            AccountMeta(pubkey=whirlpool, is_signer=False, is_writable=True),
            AccountMeta(pubkey=TOKEN_PROGRAM_ID, is_signer=False, is_writable=False),
            AccountMeta(pubkey=position_authority, is_signer=True, is_writable=False),
            AccountMeta(pubkey=position, is_signer=False, is_writable=True),
            AccountMeta(pubkey=position_token_account, is_signer=False, is_writable=False),
            AccountMeta(pubkey=token_owner_account_a, is_signer=False, is_writable=True),
            AccountMeta(pubkey=token_owner_account_b, is_signer=False, is_writable=True),
            AccountMeta(pubkey=token_vault_a, is_signer=False, is_writable=True),
            AccountMeta(pubkey=token_vault_b, is_signer=False, is_writable=True),
            AccountMeta(pubkey=tick_array_lower, is_signer=False, is_writable=True),
            AccountMeta(pubkey=tick_array_upper, is_signer=False, is_writable=True),
        ]

        # Build instruction data
        # Format: discriminator (8) + liquidity_amount (16, u128) + token_max_a (8, u64) + token_max_b (8, u64)
        data = (
            DISCRIMINATORS["increase_liquidity"] +
            liquidity_amount.to_bytes(16, "little") +
            struct.pack("<QQ", token_max_a, token_max_b)
        )

        instruction = Instruction(
            program_id=self.program_id,
            accounts=accounts,
            data=data,
        )

        logger.debug(
            "built_increase_liquidity_ix",
            position=str(position),
            liquidity=liquidity_amount,
            token_max_a=token_max_a,
            token_max_b=token_max_b,
        )

        return instruction

    def build_decrease_liquidity(
        self,
        whirlpool: Pubkey,
        position: Pubkey,
        position_token_account: Pubkey,
        token_owner_account_a: Pubkey,
        token_owner_account_b: Pubkey,
        token_vault_a: Pubkey,
        token_vault_b: Pubkey,
        tick_array_lower: Pubkey,
        tick_array_upper: Pubkey,
        position_authority: Pubkey,
        liquidity_amount: int,
        token_min_a: int = 0,
        token_min_b: int = 0,
    ) -> Instruction:
        """
        Build an instruction to decrease liquidity from a position.

        Args:
            whirlpool: Whirlpool address
            position: Position account address
            position_token_account: Position NFT token account
            token_owner_account_a: Owner's token A account
            token_owner_account_b: Owner's token B account
            token_vault_a: Whirlpool's token A vault
            token_vault_b: Whirlpool's token B vault
            tick_array_lower: Tick array containing lower tick
            tick_array_upper: Tick array containing upper tick
            position_authority: Authority that owns the position (must sign)
            liquidity_amount: Amount of liquidity to remove (u128)
            token_min_a: Minimum token A to receive (slippage protection)
            token_min_b: Minimum token B to receive (slippage protection)

        Returns:
            Instruction for decrease liquidity
        """
        accounts = [
            AccountMeta(pubkey=whirlpool, is_signer=False, is_writable=True),
            AccountMeta(pubkey=TOKEN_PROGRAM_ID, is_signer=False, is_writable=False),
            AccountMeta(pubkey=position_authority, is_signer=True, is_writable=False),
            AccountMeta(pubkey=position, is_signer=False, is_writable=True),
            AccountMeta(pubkey=position_token_account, is_signer=False, is_writable=False),
            AccountMeta(pubkey=token_owner_account_a, is_signer=False, is_writable=True),
            AccountMeta(pubkey=token_owner_account_b, is_signer=False, is_writable=True),
            AccountMeta(pubkey=token_vault_a, is_signer=False, is_writable=True),
            AccountMeta(pubkey=token_vault_b, is_signer=False, is_writable=True),
            AccountMeta(pubkey=tick_array_lower, is_signer=False, is_writable=True),
            AccountMeta(pubkey=tick_array_upper, is_signer=False, is_writable=True),
        ]

        # Build instruction data
        # Format: discriminator (8) + liquidity_amount (16, u128) + token_min_a (8, u64) + token_min_b (8, u64)
        data = (
            DISCRIMINATORS["decrease_liquidity"] +
            liquidity_amount.to_bytes(16, "little") +
            struct.pack("<QQ", token_min_a, token_min_b)
        )

        instruction = Instruction(
            program_id=self.program_id,
            accounts=accounts,
            data=data,
        )

        logger.debug(
            "built_decrease_liquidity_ix",
            position=str(position),
            liquidity=liquidity_amount,
            token_min_a=token_min_a,
            token_min_b=token_min_b,
        )

        return instruction

    def build_update_fees_and_rewards(
        self,
        whirlpool: Pubkey,
        position: Pubkey,
        tick_array_lower: Pubkey,
        tick_array_upper: Pubkey,
    ) -> Instruction:
        """
        Build an instruction to update fees and rewards checkpoints.

        This must be called before collecting fees to ensure accurate calculations.

        Args:
            whirlpool: Whirlpool address
            position: Position account address
            tick_array_lower: Tick array containing lower tick
            tick_array_upper: Tick array containing upper tick

        Returns:
            Instruction for update fees and rewards
        """
        accounts = [
            AccountMeta(pubkey=whirlpool, is_signer=False, is_writable=True),
            AccountMeta(pubkey=position, is_signer=False, is_writable=True),
            AccountMeta(pubkey=tick_array_lower, is_signer=False, is_writable=False),
            AccountMeta(pubkey=tick_array_upper, is_signer=False, is_writable=False),
        ]

        data = DISCRIMINATORS["update_fees_and_rewards"]

        instruction = Instruction(
            program_id=self.program_id,
            accounts=accounts,
            data=data,
        )

        logger.debug("built_update_fees_and_rewards_ix", position=str(position))

        return instruction

    def build_collect_fees(
        self,
        whirlpool: Pubkey,
        position: Pubkey,
        position_token_account: Pubkey,
        token_owner_account_a: Pubkey,
        token_owner_account_b: Pubkey,
        token_vault_a: Pubkey,
        token_vault_b: Pubkey,
        position_authority: Pubkey,
    ) -> Instruction:
        """
        Build an instruction to collect accumulated fees from a position.

        Note: Call update_fees_and_rewards before this instruction.

        Args:
            whirlpool: Whirlpool address
            position: Position account address
            position_token_account: Position NFT token account
            token_owner_account_a: Owner's token A account (receives fees)
            token_owner_account_b: Owner's token B account (receives fees)
            token_vault_a: Whirlpool's token A vault
            token_vault_b: Whirlpool's token B vault
            position_authority: Authority that owns the position (must sign)

        Returns:
            Instruction for collect fees
        """
        accounts = [
            AccountMeta(pubkey=whirlpool, is_signer=False, is_writable=False),
            AccountMeta(pubkey=position_authority, is_signer=True, is_writable=False),
            AccountMeta(pubkey=position, is_signer=False, is_writable=True),
            AccountMeta(pubkey=position_token_account, is_signer=False, is_writable=False),
            AccountMeta(pubkey=token_owner_account_a, is_signer=False, is_writable=True),
            AccountMeta(pubkey=token_vault_a, is_signer=False, is_writable=True),
            AccountMeta(pubkey=token_owner_account_b, is_signer=False, is_writable=True),
            AccountMeta(pubkey=token_vault_b, is_signer=False, is_writable=True),
            AccountMeta(pubkey=TOKEN_PROGRAM_ID, is_signer=False, is_writable=False),
        ]

        data = DISCRIMINATORS["collect_fees"]

        instruction = Instruction(
            program_id=self.program_id,
            accounts=accounts,
            data=data,
        )

        logger.debug("built_collect_fees_ix", position=str(position))

        return instruction

    def build_close_position(
        self,
        position: Pubkey,
        position_mint: Pubkey,
        position_token_account: Pubkey,
        position_authority: Pubkey,
        receiver: Pubkey,
    ) -> Instruction:
        """
        Build an instruction to close a position and burn the NFT.

        Note: Position must have 0 liquidity before closing.

        Args:
            position: Position account address
            position_mint: Position NFT mint
            position_token_account: Position NFT token account
            position_authority: Authority that owns the position (must sign)
            receiver: Account to receive rent exemption SOL

        Returns:
            Instruction for close position
        """
        accounts = [
            AccountMeta(pubkey=position_authority, is_signer=True, is_writable=False),
            AccountMeta(pubkey=receiver, is_signer=False, is_writable=True),
            AccountMeta(pubkey=position, is_signer=False, is_writable=True),
            AccountMeta(pubkey=position_mint, is_signer=False, is_writable=True),
            AccountMeta(pubkey=position_token_account, is_signer=False, is_writable=True),
            AccountMeta(pubkey=TOKEN_PROGRAM_ID, is_signer=False, is_writable=False),
        ]

        data = DISCRIMINATORS["close_position"]

        instruction = Instruction(
            program_id=self.program_id,
            accounts=accounts,
            data=data,
        )

        logger.debug("built_close_position_ix", position=str(position))

        return instruction

    def build_open_position_with_token_extensions(
        self,
        funder: Pubkey,
        owner: Pubkey,
        whirlpool: Pubkey,
        position_mint: Keypair,
        tick_lower_index: int,
        tick_upper_index: int,
        with_metadata: bool = True,
    ) -> Tuple[Instruction, PositionAccounts]:
        """
        Build an instruction to open a new position using Token Extensions (Token2022).

        This uses the Token2022 program for the position mint, which has a key benefit:
        - ALL rent is refundable when closing the position
        - The position mint account is closed along with the position

        This saves approximately 0.0089 SOL (~$1.15) per position cycle compared
        to standard SPL Token, which does not close the mint account.

        Args:
            funder: Account paying for rent
            owner: Owner of the position
            whirlpool: Whirlpool address
            position_mint: Keypair for the new position NFT mint (Token2022)
            tick_lower_index: Lower tick of the position
            tick_upper_index: Upper tick of the position
            with_metadata: Whether to include metadata (Token2022 uses MetadataPointer extension)

        Returns:
            Tuple of (Instruction, PositionAccounts)
        """
        # Derive position PDA (same as standard)
        position_pubkey, position_bump = derive_position_pda(position_mint.pubkey())

        # Derive position token account using Token2022 program
        position_token_account = derive_associated_token_address_2022(owner, position_mint.pubkey())

        # Build accounts for open_position_with_token_extensions
        # Account order matches Orca Whirlpool program:
        # https://github.com/orca-so/whirlpools/blob/main/programs/whirlpool/src/instructions/v2/open_position_with_token_extensions.rs
        #
        # Note: metadata_update_auth is an optional account in Anchor.
        # Even when with_metadata=False, Anchor requires the account slot to be present.
        # When not needed, pass a placeholder account (funder works as a dummy).
        accounts = [
            AccountMeta(pubkey=funder, is_signer=True, is_writable=True),
            AccountMeta(pubkey=owner, is_signer=False, is_writable=False),
            AccountMeta(pubkey=position_pubkey, is_signer=False, is_writable=True),
            AccountMeta(pubkey=position_mint.pubkey(), is_signer=True, is_writable=True),
            AccountMeta(pubkey=position_token_account, is_signer=False, is_writable=True),
            AccountMeta(pubkey=whirlpool, is_signer=False, is_writable=False),
            AccountMeta(pubkey=TOKEN_2022_PROGRAM_ID, is_signer=False, is_writable=False),
            AccountMeta(pubkey=SYSTEM_PROGRAM_ID, is_signer=False, is_writable=False),
            AccountMeta(pubkey=ASSOCIATED_TOKEN_PROGRAM_ID, is_signer=False, is_writable=False),
            # metadata_update_auth - Orca's NFT update authority (always required)
            AccountMeta(pubkey=WHIRLPOOL_NFT_UPDATE_AUTH, is_signer=False, is_writable=False),
        ]

        # Build instruction data
        # Format: discriminator (8) + tick_lower (i32=4) + tick_upper (i32=4) + with_metadata (bool=1)
        # NOTE: Position bump is NOT included - Anchor handles it internally via account constraints
        discriminator = DISCRIMINATORS["open_position_with_token_extensions"]
        data = discriminator + struct.pack("<ii?", tick_lower_index, tick_upper_index, with_metadata)

        instruction = Instruction(
            program_id=self.program_id,
            accounts=accounts,
            data=data,
        )

        position_accounts = PositionAccounts(
            position=position_pubkey,
            position_mint=position_mint.pubkey(),
            position_token_account=position_token_account,
            position_metadata=None,  # Token2022 uses MetadataPointer extension, not separate account
            uses_token_extensions=True,
        )

        logger.debug(
            "built_open_position_with_token_extensions_ix",
            position=str(position_pubkey),
            tick_lower=tick_lower_index,
            tick_upper=tick_upper_index,
            with_metadata=with_metadata,
        )

        return instruction, position_accounts

    def build_close_position_with_token_extensions(
        self,
        position: Pubkey,
        position_mint: Pubkey,
        position_token_account: Pubkey,
        position_authority: Pubkey,
        receiver: Pubkey,
    ) -> Instruction:
        """
        Build an instruction to close a Token2022 position and burn the NFT.

        This instruction properly closes the Token2022 mint account, returning
        ALL rent to the receiver (including the mint account rent that is
        NOT refunded with standard SPL Token positions).

        Note: Position must have 0 liquidity before closing.

        Args:
            position: Position account address
            position_mint: Position NFT mint (Token2022)
            position_token_account: Position NFT token account (Token2022)
            position_authority: Authority that owns the position (must sign)
            receiver: Account to receive all rent SOL

        Returns:
            Instruction for close position with token extensions
        """
        accounts = [
            AccountMeta(pubkey=position_authority, is_signer=True, is_writable=False),
            AccountMeta(pubkey=receiver, is_signer=False, is_writable=True),
            AccountMeta(pubkey=position, is_signer=False, is_writable=True),
            AccountMeta(pubkey=position_mint, is_signer=False, is_writable=True),
            AccountMeta(pubkey=position_token_account, is_signer=False, is_writable=True),
            AccountMeta(pubkey=TOKEN_2022_PROGRAM_ID, is_signer=False, is_writable=False),
        ]

        data = DISCRIMINATORS["close_position_with_token_extensions"]

        instruction = Instruction(
            program_id=self.program_id,
            accounts=accounts,
            data=data,
        )

        logger.debug("built_close_position_with_token_extensions_ix", position=str(position))

        return instruction

    def build_initialize_tick_array(
        self,
        whirlpool: Pubkey,
        tick_array: Pubkey,
        funder: Pubkey,
        start_tick_index: int,
    ) -> Instruction:
        """
        Build an instruction to initialize a tick array.

        Tick arrays must be initialized before positions can be opened
        in that tick range. Each tick array covers TICK_ARRAY_SIZE * tick_spacing ticks.

        Args:
            whirlpool: Whirlpool address
            tick_array: Tick array PDA to initialize
            funder: Account paying for rent (must sign)
            start_tick_index: Starting tick index for this array

        Returns:
            Instruction for initialize tick array
        """
        accounts = [
            AccountMeta(pubkey=whirlpool, is_signer=False, is_writable=False),
            AccountMeta(pubkey=funder, is_signer=True, is_writable=True),
            AccountMeta(pubkey=tick_array, is_signer=False, is_writable=True),
            AccountMeta(pubkey=SYSTEM_PROGRAM_ID, is_signer=False, is_writable=False),
        ]

        # Data: discriminator (8) + start_tick_index (4, i32)
        data = DISCRIMINATORS["initialize_tick_array"] + struct.pack("<i", start_tick_index)

        instruction = Instruction(
            program_id=self.program_id,
            accounts=accounts,
            data=data,
        )

        logger.debug(
            "built_initialize_tick_array_ix",
            tick_array=str(tick_array),
            start_tick=start_tick_index,
        )

        return instruction


def build_create_ata_instruction(
    payer: Pubkey,
    owner: Pubkey,
    mint: Pubkey,
    token_program_id: Pubkey = TOKEN_PROGRAM_ID,
) -> Instruction:
    """
    Build an instruction to create an Associated Token Account.

    Args:
        payer: Account paying for rent (must sign)
        owner: Owner of the new token account
        mint: Token mint
        token_program_id: Token program (standard or Token2022)

    Returns:
        Instruction to create the ATA
    """
    ata = derive_associated_token_address(owner, mint, token_program_id)

    accounts = [
        AccountMeta(pubkey=payer, is_signer=True, is_writable=True),
        AccountMeta(pubkey=ata, is_signer=False, is_writable=True),
        AccountMeta(pubkey=owner, is_signer=False, is_writable=False),
        AccountMeta(pubkey=mint, is_signer=False, is_writable=False),
        AccountMeta(pubkey=SYSTEM_PROGRAM_ID, is_signer=False, is_writable=False),
        AccountMeta(pubkey=token_program_id, is_signer=False, is_writable=False),
    ]

    # The ATA program's create instruction has no data (just call the program)
    instruction = Instruction(
        program_id=ASSOCIATED_TOKEN_PROGRAM_ID,
        accounts=accounts,
        data=bytes(),
    )

    logger.debug(
        "built_create_ata_ix",
        ata=str(ata),
        owner=str(owner),
        mint=str(mint),
        token_program=str(token_program_id),
    )

    return instruction


def build_create_ata_instruction_2022(
    payer: Pubkey,
    owner: Pubkey,
    mint: Pubkey,
) -> Instruction:
    """
    Build an instruction to create a Token2022 Associated Token Account.

    Args:
        payer: Account paying for rent (must sign)
        owner: Owner of the new token account
        mint: Token mint (Token2022)

    Returns:
        Instruction to create the Token2022 ATA
    """
    return build_create_ata_instruction(payer, owner, mint, TOKEN_2022_PROGRAM_ID)


# Singleton instance
_instruction_builder: Optional[WhirlpoolInstructionBuilder] = None


def get_instruction_builder() -> WhirlpoolInstructionBuilder:
    """Get or create the default instruction builder singleton."""
    global _instruction_builder
    if _instruction_builder is None:
        _instruction_builder = WhirlpoolInstructionBuilder()
    return _instruction_builder
