import { PublicKey } from "@solana/web3.js";
import * as dotenv from "dotenv";
import * as path from "path";

// Load .env from project root
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

// ─── Program IDs ─────────────────────────────────────────────────────

export const LH_CORE_PROGRAM_ID = new PublicKey(
  process.env.LH_PROGRAM_ID || "CuTEecNBQTu1Joaa7ZikePChbGLstvYKNuW3KQEwhfdA"
);

export const WHIRLPOOL_PROGRAM_ID = new PublicKey(
  "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc"
);

export const TOKEN_PROGRAM_ID = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
);

export const TOKEN_2022_PROGRAM_ID = new PublicKey(
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
);

export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
);

export const SYSTEM_PROGRAM_ID = new PublicKey(
  "11111111111111111111111111111111"
);

export const RENT_SYSVAR_ID = new PublicKey(
  "SysvarRent111111111111111111111111111111111"
);

// ─── Token Mints ─────────────────────────────────────────────────────

export const SOL_MINT = new PublicKey(
  "So11111111111111111111111111111111111111112"
);

// Devnet USDC
const DEVNET_USDC_MINT = new PublicKey(
  "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"
);

// Mainnet USDC
const MAINNET_USDC_MINT = new PublicKey(
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
);

export const CLUSTER = process.env.SOLANA_CLUSTER || "devnet";

export const USDC_MINT =
  CLUSTER === "mainnet-beta" ? MAINNET_USDC_MINT : DEVNET_USDC_MINT;

// ─── Pyth Price Feeds ────────────────────────────────────────────────

// Pyth V2 SOL/USD price feed
const DEVNET_PYTH_SOL_USD = new PublicKey(
  "J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix"
);

const MAINNET_PYTH_SOL_USD = new PublicKey(
  "H6ARHf6YXhGYeQfUzQNGk6rDNnLBQKrenN712K4AQJEG"
);

export const PYTH_SOL_USD_FEED = process.env.PYTH_SOL_USD_FEED
  ? new PublicKey(process.env.PYTH_SOL_USD_FEED)
  : CLUSTER === "mainnet-beta"
  ? MAINNET_PYTH_SOL_USD
  : DEVNET_PYTH_SOL_USD;

// ─── Orca Whirlpool ──────────────────────────────────────────────────

// SOL/USDC Whirlpool pool address — must be set per cluster
// Mainnet: Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE (0.04% fee, tick_spacing=4)
// Devnet: must be discovered or created
export const WHIRLPOOL_ADDRESS = process.env.WHIRLPOOL_ADDRESS
  ? new PublicKey(process.env.WHIRLPOOL_ADDRESS)
  : new PublicKey("Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE"); // mainnet default

// ─── Orca Instruction Discriminators ─────────────────────────────────
// Source: test_deployment_v2/app/chain/whirlpool_instructions.py

export const ORCA_DISCRIMINATORS = {
  openPosition: Buffer.from([135, 128, 47, 77, 15, 152, 240, 49]),
  openPositionWithMetadata: Buffer.from([242, 29, 134, 48, 58, 110, 14, 60]),
  openPositionWithTokenExtensions: Buffer.from([
    212, 47, 95, 92, 114, 102, 131, 250,
  ]),
  increaseLiquidity: Buffer.from([46, 156, 243, 118, 13, 205, 251, 178]),
  decreaseLiquidity: Buffer.from([160, 38, 208, 111, 104, 91, 44, 1]),
  collectFees: Buffer.from([164, 152, 207, 99, 30, 186, 19, 182]),
  closePosition: Buffer.from([123, 134, 81, 0, 49, 68, 98, 98]),
  closePositionWithTokenExtensions: Buffer.from([
    1, 182, 135, 59, 155, 25, 99, 223,
  ]),
} as const;

// ─── Orca Account Discriminators ─────────────────────────────────────

export const ORCA_ACCOUNT_DISCRIMINATORS = {
  position: Buffer.from([170, 188, 143, 228, 122, 64, 247, 208]),
  whirlpool: Buffer.from([63, 149, 209, 12, 225, 128, 99, 9]),
} as const;

// ─── Orca Constants ──────────────────────────────────────────────────

export const TICK_ARRAY_SIZE = 88;
export const MIN_TICK = -443636;
export const MAX_TICK = 443636;

// Q64 fixed-point factor for sqrt_price
export const Q64 = BigInt(1) << BigInt(64);

// ─── LH Protocol PDA Seeds ──────────────────────────────────────────

export const PDA_SEEDS = {
  pool: Buffer.from("pool"),
  poolVault: Buffer.from("pool_vault"),
  shareMint: Buffer.from("share_mint"),
  position: Buffer.from("position"),
  certificate: Buffer.from("certificate"),
  regime: Buffer.from("regime"),
  template: Buffer.from("template"),
} as const;
