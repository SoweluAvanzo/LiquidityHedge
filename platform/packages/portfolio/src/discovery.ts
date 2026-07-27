/**
 * Position discovery over RPC (FR-M1): find all Orca Whirlpool positions
 * owned by a wallet by scanning its NFT-shaped token accounts (amount 1,
 * decimals 0), deriving the position PDA per candidate mint, and decoding
 * the accounts that exist. Supports both Token and Token-2022 programs
 * (newer Whirlpool position NFTs are Token-2022).
 */

import { Connection, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import {
  decodePositionAccount,
  decodeWhirlpoolAccount,
  PositionData,
  WhirlpoolData,
  readTickFeeGrowthOutside,
} from "@lh/core/src/market-data/decoder";
import {
  feeGrowthInside,
  uncollectedFees,
} from "@lh/core/src/market-data/fees-owed";
import {
  WHIRLPOOL_PROGRAM_ID,
  deriveOrcaPositionPda,
  deriveTickArrayPda,
  tickArrayStartIndex,
} from "@lh/core/src/config/chain";
import { buildPositionView } from "./views";
import { PortfolioPositionView } from "./types";

const ACCOUNT_BATCH = 100;

function chunk<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

/** SPL mint layout: decimals is the u8 at offset 44 (same for Token-2022 base). */
function parseMintDecimals(data: Buffer): number {
  if (data.length < 45) throw new Error("mint account too short");
  return data.readUInt8(44);
}

async function findCandidateNftMints(
  connection: Connection,
  owner: PublicKey,
): Promise<PublicKey[]> {
  const mints: PublicKey[] = [];
  for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    const { value } = await connection.getParsedTokenAccountsByOwner(owner, {
      programId,
    });
    for (const { account } of value) {
      const info = (account.data as any)?.parsed?.info;
      const amount = info?.tokenAmount;
      if (amount?.amount === "1" && amount?.decimals === 0) {
        mints.push(new PublicKey(info.mint));
      }
    }
  }
  return mints;
}

export interface DiscoveredPosition {
  positionAddress: PublicKey;
  position: PositionData;
}

/** Resolve candidate NFT mints to actual Whirlpool position accounts. */
export async function discoverRawPositions(
  connection: Connection,
  owner: PublicKey,
): Promise<DiscoveredPosition[]> {
  const mints = await findCandidateNftMints(connection, owner);
  const pdas = mints.map((m) => deriveOrcaPositionPda(m)[0]);

  const found: DiscoveredPosition[] = [];
  for (const batch of chunk(pdas, ACCOUNT_BATCH)) {
    const infos = await connection.getMultipleAccountsInfo(batch);
    infos.forEach((info, i) => {
      if (!info || !info.owner.equals(WHIRLPOOL_PROGRAM_ID)) return;
      try {
        found.push({
          positionAddress: batch[i],
          position: decodePositionAccount(info.data),
        });
      } catch {
        // Not a decodable Whirlpool position (e.g. other program state at
        // a colliding PDA) — skip; discovery must not fail the whole scan.
      }
    });
  }
  return found;
}

/**
 * Full portfolio fetch: positions + their whirlpools + mint decimals,
 * assembled into serializable views (FR-M2).
 */
export async function fetchPortfolio(
  connection: Connection,
  owner: PublicKey,
): Promise<PortfolioPositionView[]> {
  const raw = await discoverRawPositions(connection, owner);
  if (raw.length === 0) return [];

  // Fetch each distinct whirlpool once.
  const poolKeys = [...new Set(raw.map((r) => r.position.whirlpool.toBase58()))];
  const poolInfos = await connection.getMultipleAccountsInfo(
    poolKeys.map((k) => new PublicKey(k)),
  );
  const pools = new Map<string, WhirlpoolData>();
  poolKeys.forEach((k, i) => {
    const info = poolInfos[i];
    if (info) pools.set(k, decodeWhirlpoolAccount(info.data));
  });

  // Fetch decimals for each distinct token mint once.
  const mintKeys = [
    ...new Set(
      [...pools.values()].flatMap((p) => [
        p.tokenMintA.toBase58(),
        p.tokenMintB.toBase58(),
      ]),
    ),
  ];
  const mintInfos = await connection.getMultipleAccountsInfo(
    mintKeys.map((k) => new PublicKey(k)),
  );
  const decimals = new Map<string, number>();
  mintKeys.forEach((k, i) => {
    const info = mintInfos[i];
    if (info) decimals.set(k, parseMintDecimals(info.data));
  });

  // Tick arrays holding each position's lower/upper tick. Needed because
  // a position's `feeOwedA/B` is only a CHECKPOINT, written when the
  // position was last touched — everything earned since then lives in
  // these accounts. Without them the dashboard reports "0 SOL + 0 USDC"
  // on a position that has plainly been earning.
  const tickArrayKeys = new Map<string, PublicKey>();
  for (const r of raw) {
    const pool = pools.get(r.position.whirlpool.toBase58());
    if (!pool) continue;
    for (const tick of [r.position.tickLowerIndex, r.position.tickUpperIndex]) {
      const start = tickArrayStartIndex(tick, pool.tickSpacing);
      const [pda] = deriveTickArrayPda(r.position.whirlpool, start);
      tickArrayKeys.set(pda.toBase58(), pda);
    }
  }
  const taKeys = [...tickArrayKeys.keys()];
  const tickArrays = new Map<string, Buffer>();
  for (let i = 0; i < taKeys.length; i += 100) {
    const slice = taKeys.slice(i, i + 100);
    const infos = await connection.getMultipleAccountsInfo(
      slice.map((k) => tickArrayKeys.get(k)!),
    );
    slice.forEach((k, j) => {
      const info = infos[j];
      if (info) tickArrays.set(k, info.data as Buffer);
    });
  }

  // §1.2 torn-read gate: feeGrowthInside mixes pool state with tick
  // state read in SEPARATE RPC calls; a swap crossing a boundary tick in
  // between pairs a stale tickCurrentIndex with a post-crossing
  // fee_growth_outside — plausible garbage. Re-read the pools and treat
  // inside as trustworthy only where the accumulator did not move. The
  // fee DISPLAY below keeps its long-standing behaviour; only the
  // persisted-snapshot fields are gated.
  const stablePools = new Set<string>();
  try {
    const recheck = await connection.getMultipleAccountsInfo(
      poolKeys.map((k) => new PublicKey(k)),
    );
    poolKeys.forEach((k, i) => {
      const info = recheck[i];
      const first = pools.get(k);
      if (!info || !first) return;
      try {
        const again = decodeWhirlpoolAccount(info.data);
        if (
          again.feeGrowthGlobalA === first.feeGrowthGlobalA &&
          again.feeGrowthGlobalB === first.feeGrowthGlobalB &&
          again.tickCurrentIndex === first.tickCurrentIndex
        ) {
          stablePools.add(k);
        }
      } catch {
        // undecodable re-read — pool stays unverified
      }
    });
  } catch {
    // recheck unavailable — no pool is verified, no inside is attached
  }

  /** Real uncollected fees, or null when the tick data is unavailable. */
  const realFees = (
    position: PositionData,
    pool: WhirlpoolData,
  ): { feesA: bigint; feesB: bigint; insideA: bigint; insideB: bigint } | null => {
    try {
      const read = (tick: number) => {
        const start = tickArrayStartIndex(tick, pool.tickSpacing);
        const [pda] = deriveTickArrayPda(position.whirlpool, start);
        const key = pda.toBase58();
        const data = tickArrays.get(key);
        return data
          ? readTickFeeGrowthOutside(data, tick, start, pool.tickSpacing)
          : null;
      };
      const lower = read(position.tickLowerIndex);
      const upper = read(position.tickUpperIndex);
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
      const fees = uncollectedFees({
        liquidity: position.liquidity,
        feeOwedA: position.feeOwedA,
        feeOwedB: position.feeOwedB,
        feeGrowthCheckpointA: position.feeGrowthCheckpointA,
        feeGrowthCheckpointB: position.feeGrowthCheckpointB,
        insideA: inside.insideA,
        insideB: inside.insideB,
      });
      // §1.2: the inside accumulator itself travels on the view so the
      // web app can persist it as a position-fee snapshot.
      return { ...fees, insideA: inside.insideA, insideB: inside.insideB };
    } catch {
      return null; // a fee display must never break the portfolio
    }
  };

  const views: PortfolioPositionView[] = [];
  for (const r of raw) {
    const poolKey = r.position.whirlpool.toBase58();
    const pool = pools.get(poolKey);
    if (!pool) continue;
    const decA = decimals.get(pool.tokenMintA.toBase58());
    const decB = decimals.get(pool.tokenMintB.toBase58());
    if (decA === undefined || decB === undefined) continue;
    const view = buildPositionView({
      positionAddress: r.positionAddress.toBase58(),
      position: r.position,
      whirlpool: pool,
      whirlpoolAddress: poolKey,
      decimalsA: decA,
      decimalsB: decB,
    });
    const fees = realFees(r.position, pool);
    if (fees) {
      view.feeOwedA = fees.feesA;
      view.feeOwedB = fees.feesB;
      view.feesAreExact = true;
      if (stablePools.has(poolKey)) {
        view.feeGrowthInsideA = fees.insideA.toString();
        view.feeGrowthInsideB = fees.insideB.toString();
      }
    }
    views.push(view);
  }
  return views;
}
