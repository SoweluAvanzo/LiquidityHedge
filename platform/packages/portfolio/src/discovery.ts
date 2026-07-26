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
} from "@lh/core/src/market-data/decoder";
import {
  WHIRLPOOL_PROGRAM_ID,
  deriveOrcaPositionPda,
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

  const views: PortfolioPositionView[] = [];
  for (const r of raw) {
    const poolKey = r.position.whirlpool.toBase58();
    const pool = pools.get(poolKey);
    if (!pool) continue;
    const decA = decimals.get(pool.tokenMintA.toBase58());
    const decB = decimals.get(pool.tokenMintB.toBase58());
    if (decA === undefined || decB === undefined) continue;
    views.push(
      buildPositionView({
        positionAddress: r.positionAddress.toBase58(),
        position: r.position,
        whirlpool: pool,
        whirlpoolAddress: poolKey,
        decimalsA: decA,
        decimalsB: decB,
      }),
    );
  }
  return views;
}
