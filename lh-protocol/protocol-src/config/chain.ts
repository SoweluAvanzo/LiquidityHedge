/**
 * Liquidity Hedge Protocol — Chain Configuration
 *
 * Program IDs, token mints, whirlpool addresses, and PDA derivation
 * for mainnet and devnet deployments.
 */

import { PublicKey } from "@solana/web3.js";

// ---------------------------------------------------------------------------
// Program IDs
// ---------------------------------------------------------------------------

export const WHIRLPOOL_PROGRAM_ID = new PublicKey(
  "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",
);

// ---------------------------------------------------------------------------
// Token mints
// ---------------------------------------------------------------------------

export const SOL_MINT = new PublicKey(
  "So11111111111111111111111111111111111111112",
);

export const MAINNET_USDC_MINT = new PublicKey(
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
);

export const DEVNET_USDC_MINT = new PublicKey(
  "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
);

// ---------------------------------------------------------------------------
// Whirlpool addresses
// ---------------------------------------------------------------------------

/** SOL/USDC Whirlpool (mainnet, 0.04% fee tier, tick spacing 64) */
export const MAINNET_WHIRLPOOL = new PublicKey(
  "Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE",
);

// ---------------------------------------------------------------------------
// Pyth oracle feeds
// ---------------------------------------------------------------------------

/** Pyth SOL/USD price feed (mainnet) */
export const PYTH_SOL_USD_FEED = new PublicKey(
  "H6ARHf6YXhGYeQfUzQNGk6rDNnLBQKrenN712K4AQJEG",
);

// ---------------------------------------------------------------------------
// Orca constants
// ---------------------------------------------------------------------------

/** Tick spacing for SOL/USDC 1% fee tier pool */
export const TICK_SPACING = 64;

/** Number of ticks per tick array */
export const TICK_ARRAY_SIZE = 88;

/** Minimum and maximum valid ticks */
export const MIN_TICK = -443636;
export const MAX_TICK = 443636;

// ---------------------------------------------------------------------------
// PDA derivation
// ---------------------------------------------------------------------------

export function deriveOrcaPositionPda(
  positionMint: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("position"), positionMint.toBuffer()],
    WHIRLPOOL_PROGRAM_ID,
  );
}

export function deriveTickArrayPda(
  whirlpool: PublicKey,
  startTickIndex: number,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("tick_array"),
      whirlpool.toBuffer(),
      Buffer.from(startTickIndex.toString()),
    ],
    WHIRLPOOL_PROGRAM_ID,
  );
}

/**
 * Compute the start tick index of the tick array containing a given tick.
 */
export function tickArrayStartIndex(
  tick: number,
  tickSpacing: number,
): number {
  const ticksPerArray = TICK_ARRAY_SIZE * tickSpacing;
  return Math.floor(tick / ticksPerArray) * ticksPerArray;
}
