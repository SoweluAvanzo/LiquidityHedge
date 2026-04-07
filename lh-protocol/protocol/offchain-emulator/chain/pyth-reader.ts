/**
 * Pyth V2 on-chain price feed reader.
 *
 * Parses the same byte layout as programs/lh-core/src/pyth.rs.
 * Identical offsets, same staleness/confidence checks.
 */

import { Connection, PublicKey } from "@solana/web3.js";
import { PYTH_MAX_STALENESS_S, PYTH_MAX_CONFIDENCE_PPM, PPM } from "../../types";

const PYTH_MAGIC = 0xa1b2c3d4;
const PYTH_STATUS_TRADING = 1;

export interface PythPrice {
  priceE6: number;
  confE6: number;
  timestamp: number;
}

/**
 * Read and validate a Pyth V2 price feed.
 * Returns price and confidence in e6 format.
 *
 * Byte offsets (from pyth.rs):
 *   [0..4]     magic (u32) = 0xa1b2c3d4
 *   [172..176] status (u32) = 1 (TRADING)
 *   [208..216] price (i64)
 *   [216..224] confidence (u64)
 *   [224..228] exponent (i32)
 *   [232..240] timestamp (i64)
 */
/**
 * Read and validate a Pyth V2 price feed.
 * Falls back to Whirlpool-derived price if Pyth feed is stale/unavailable
 * (Pyth V2 push feeds on mainnet are deprecated; pull feeds use a different format).
 */
export async function readPythPrice(
  connection: Connection,
  feedAddress: PublicKey,
  whirlpoolFallback?: { address: PublicKey }
): Promise<PythPrice> {
  const info = await connection.getAccountInfo(feedAddress);
  if (!info) {
    if (whirlpoolFallback) return readWhirlpoolFallback(connection, whirlpoolFallback.address);
    throw new Error(`Pyth feed not found: ${feedAddress.toBase58()}`);
  }
  const data = Buffer.from(info.data);

  if (data.length < 240) {
    if (whirlpoolFallback) return readWhirlpoolFallback(connection, whirlpoolFallback.address);
    throw new Error(`Pyth account too small: ${data.length} < 240`);
  }

  // Magic number check
  const magic = data.readUInt32LE(0);
  if (magic !== PYTH_MAGIC) {
    if (whirlpoolFallback) return readWhirlpoolFallback(connection, whirlpoolFallback.address);
    throw new Error(`Invalid Pyth magic: 0x${magic.toString(16)}`);
  }

  // Status check — Pyth V2 push feeds on mainnet may be deprecated (status=0)
  const status = data.readUInt32LE(172);
  if (status !== PYTH_STATUS_TRADING) {
    if (whirlpoolFallback) return readWhirlpoolFallback(connection, whirlpoolFallback.address);
    throw new Error(`Pyth status not TRADING: ${status}`);
  }

  // Parse price fields
  const price = data.readBigInt64LE(208);
  const conf = data.readBigUInt64LE(216);
  const expo = data.readInt32LE(224);
  const timestamp = Number(data.readBigInt64LE(232));

  // Staleness check
  const now = Math.floor(Date.now() / 1000);
  if (now - timestamp > PYTH_MAX_STALENESS_S) {
    if (whirlpoolFallback) return readWhirlpoolFallback(connection, whirlpoolFallback.address);
    throw new Error(
      `Pyth feed stale: age=${now - timestamp}s, max=${PYTH_MAX_STALENESS_S}s`
    );
  }

  if (price <= BigInt(0)) {
    throw new Error("Pyth price is non-positive");
  }

  // Normalize to e6
  const priceE6 = normalizeToE6(price, expo);
  const confE6 = normalizeToE6(conf, expo);

  // Confidence check: conf <= 5% of price
  const maxConf = Math.floor((priceE6 * PYTH_MAX_CONFIDENCE_PPM) / PPM);
  if (confE6 > maxConf) {
    throw new Error(
      `Pyth confidence too wide: conf=${confE6}, max=${maxConf} (${PYTH_MAX_CONFIDENCE_PPM / 10000}% of price)`
    );
  }

  return { priceE6, confE6, timestamp };
}

/**
 * Fallback: derive price from Orca Whirlpool sqrtPriceX64.
 * Uses 0.5% as a conservative confidence estimate.
 */
async function readWhirlpoolFallback(
  connection: Connection,
  whirlpoolAddress: PublicKey
): Promise<PythPrice> {
  const { decodeWhirlpoolAccount, sqrtPriceX64ToPrice } = await import(
    "../../../clients/cli/whirlpool-ix"
  );
  const info = await connection.getAccountInfo(whirlpoolAddress);
  if (!info) throw new Error("Whirlpool fallback: account not found");
  const wp = decodeWhirlpoolAccount(Buffer.from(info.data));
  const price = sqrtPriceX64ToPrice(wp.sqrtPrice);
  const priceE6 = Math.floor(price * 1_000_000);
  // Conservative confidence: 0.5% of price
  const confE6 = Math.floor(priceE6 * 0.005);
  console.log(`  [Pyth fallback] Using Whirlpool price: $${price.toFixed(4)} (conf: $${(confE6/1e6).toFixed(4)})`);
  return { priceE6, confE6, timestamp: Math.floor(Date.now() / 1000) };
}

/**
 * Normalize a Pyth value with arbitrary exponent to 6 decimal places.
 * Same logic as pyth.rs normalize_to_e6.
 */
function bigPow10(n: number): bigint {
  let result = BigInt(1);
  for (let i = 0; i < n; i++) result *= BigInt(10);
  return result;
}

function normalizeToE6(value: bigint, expo: number): number {
  const targetExpo = -6;
  const shift = targetExpo - expo;
  let result: bigint;
  const absValue = value < BigInt(0) ? -value : value;

  if (shift >= 0) {
    result = absValue / bigPow10(shift);
  } else {
    result = absValue * bigPow10(-shift);
  }

  return Number(result);
}
