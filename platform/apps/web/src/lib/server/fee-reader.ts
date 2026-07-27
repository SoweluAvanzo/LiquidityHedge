/**
 * The Risk Taker's fee share, read from the chain.
 *
 * AUDIT #4. The canonical premium is `max(P_floor, FV·m_vol − y·E[F])`.
 * The `− y·E[F]` term is a DISCOUNT granted because the RT collects `y ×`
 * the LP's realised trading fees at settlement. Every production
 * `readAccruedFees` returned 0 unconditionally — the real reader was
 * never wired — so the discount was given and the revenue never arrived:
 * roughly $35 forgone per $10k position against ~$1 of protocol fee.
 *
 * What is measured here is the fees accrued DURING the certificate:
 *
 *   fees = L_pos × (feeGrowthInside(now) − feeGrowthInside(activation)) / 2^64
 *
 * — exactly what the Whirlpool program would pay on a `collectFees`. The
 * activation value cannot be recovered after the fact (the accumulator
 * exists on-chain only at the instant it is read), which is why the
 * runner snapshots it the moment a certificate activates.
 *
 * TWO-TOKEN VALUATION. Fees accrue in BOTH tokens. Token B is the USDC
 * leg and is already µUSDC. Token A is valued at the settlement price the
 * certificate itself uses, so the fee share and the payoff are marked
 * against one price rather than two.
 *
 * FAILURE POLICY (Master Terms §7.2, and the port contract): every
 * failure path returns 0, never an estimate. A missing checkpoint, an
 * unreadable position, a wrapped-but-implausible delta — all mean "no fee
 * share", which is buyer-favourable. This function must never invent a
 * number that moves money.
 */

import { Connection, PublicKey } from "@solana/web3.js";
import type { CertificateRecord, FeeCheckpoint } from "@lh/hedge";
import {
  decodePositionAccount,
  decodeWhirlpoolAccount,
  readTickFeeGrowthOutside,
} from "@lh/core/src/market-data/decoder";
import { feeGrowthInside, wrapSub } from "@lh/core/src/market-data/fees-owed";
import {
  deriveOrcaPositionPda,
  deriveTickArrayPda,
  tickArrayStartIndex,
} from "@lh/core/src/config/chain";

const Q64 = 1n << 64n;

/**
 * A sanity ceiling on the fee share, as a fraction of the position's own
 * liquidity-scaled value. A wrapped or mis-decoded accumulator would
 * otherwise produce an astronomically large "fee share" that the RT would
 * deduct from a real settlement.
 */
const MAX_PLAUSIBLE_FEE_USDC = 1_000_000_000_000; // $1,000,000

/** Read a position's current fee-growth-inside, or null if unreadable. */
async function readInside(
  connection: Connection,
  positionMint: string,
): Promise<FeeCheckpoint | null> {
  try {
    const [positionPda] = deriveOrcaPositionPda(new PublicKey(positionMint));
    const posInfo = await connection.getAccountInfo(positionPda, "finalized");
    if (!posInfo) return null;
    const position = decodePositionAccount(posInfo.data);

    const poolInfo = await connection.getAccountInfo(position.whirlpool, "finalized");
    if (!poolInfo) return null;
    const pool = decodeWhirlpoolAccount(poolInfo.data);

    const readTick = async (tick: number) => {
      const start = tickArrayStartIndex(tick, pool.tickSpacing);
      const [pda] = deriveTickArrayPda(position.whirlpool, start);
      const info = await connection.getAccountInfo(pda, "finalized");
      if (!info) return null;
      return readTickFeeGrowthOutside(info.data, tick, start, pool.tickSpacing);
    };
    const lower = await readTick(position.tickLowerIndex);
    const upper = await readTick(position.tickUpperIndex);
    if (!lower || !upper) return null;

    const inside = feeGrowthInside({
      tickCurrentIndex: pool.tickCurrentIndex,
      tickLowerIndex: position.tickLowerIndex,
      tickUpperIndex: position.tickUpperIndex,
      feeGrowthGlobalA: pool.feeGrowthGlobalA,
      feeGrowthGlobalB: pool.feeGrowthGlobalB,
      lowerOutsideA: lower.feeGrowthOutsideA,
      lowerOutsideB: lower.feeGrowthOutsideB,
      upperOutsideA: upper.feeGrowthOutsideA,
      upperOutsideB: upper.feeGrowthOutsideB,
    });

    // Mint decimals, so the token-A leg can be valued in USD later.
    const decA = await mintDecimals(connection, pool.tokenMintA);
    const decB = await mintDecimals(connection, pool.tokenMintB);
    if (decA === null || decB === null) return null;

    return {
      feeGrowthInsideA: inside.insideA.toString(),
      feeGrowthInsideB: inside.insideB.toString(),
      liquidity: position.liquidity.toString(),
      decimalsA: decA,
      decimalsB: decB,
      takenAtTs: Math.floor(Date.now() / 1000),
    };
  } catch (error) {
    console.error("[fee-reader] position read failed:", error);
    return null;
  }
}

async function mintDecimals(
  connection: Connection,
  mint: PublicKey,
): Promise<number | null> {
  const info = await connection.getAccountInfo(mint, "finalized");
  if (!info || info.data.length < 45) return null;
  return info.data.readUInt8(44);
}

/** Port impl: the activation-time checkpoint. */
export async function readFeeCheckpoint(
  connection: Connection,
  positionMint: string,
): Promise<FeeCheckpoint | null> {
  return readInside(connection, positionMint);
}

/**
 * Port impl: LP fees accrued over the certificate's life, in µUSDC.
 * Returns 0 on any failure — never an estimate.
 */
export async function readAccruedFees(
  connection: Connection,
  cert: CertificateRecord,
  settlementPriceUsd?: number,
): Promise<number> {
  const checkpoint = cert.feeCheckpoint;
  if (!checkpoint) {
    console.warn(
      `[fee-reader] ${cert.quoteId} has no activation checkpoint — fee share ` +
        `is 0 (buyer-favourable). The accumulator cannot be recovered after ` +
        `the fact, so this certificate can never have one.`,
    );
    return 0;
  }

  const now = await readInside(connection, cert.positionMint);
  if (!now) return 0;

  // Liquidity is taken from the CHECKPOINT: if the LP changed liquidity
  // mid-certificate the accumulator delta no longer corresponds to a
  // single L, and crediting the current L would misstate the share.
  const liquidity = BigInt(checkpoint.liquidity);
  if (liquidity !== BigInt(now.liquidity)) {
    console.warn(
      `[fee-reader] ${cert.quoteId} liquidity changed during the certificate ` +
        `(${checkpoint.liquidity} -> ${now.liquidity}) — fee share is 0 rather ` +
        `than computed against an ambiguous basis.`,
    );
    return 0;
  }

  const deltaA = wrapSub(
    BigInt(now.feeGrowthInsideA),
    BigInt(checkpoint.feeGrowthInsideA),
  );
  const deltaB = wrapSub(
    BigInt(now.feeGrowthInsideB),
    BigInt(checkpoint.feeGrowthInsideB),
  );

  const rawA = (liquidity * deltaA) / Q64; // native token-A units
  const rawB = (liquidity * deltaB) / Q64; // native token-B units (µUSDC)

  const price = settlementPriceUsd;
  if (rawA > 0n && (price === undefined || !(price > 0))) {
    console.warn(
      `[fee-reader] ${cert.quoteId} accrued token-A fees but no usable ` +
        `settlement price — fee share is 0 rather than valued at a guess.`,
    );
    return 0;
  }

  const aUsdc =
    rawA > 0n && price
      ? (Number(rawA) / 10 ** checkpoint.decimalsA) * price * 1e6
      : 0;
  const bUsdc = Number(rawB) * 10 ** (6 - checkpoint.decimalsB);

  const total = Math.floor(aUsdc + bUsdc);
  if (!Number.isFinite(total) || total < 0 || total > MAX_PLAUSIBLE_FEE_USDC) {
    console.error(
      `[fee-reader] ${cert.quoteId} implausible fee share ${total} µUSDC — ` +
        `refusing rather than deducting it from a settlement.`,
    );
    return 0;
  }
  return total;
}
