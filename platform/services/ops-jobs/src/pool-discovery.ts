/**
 * Pool discovery: rank Orca whirlpools by TVL and persist the tracked set.
 *
 * The snapshot collector is pool-agnostic — one whirlpool account plus its
 * two vaults per pool — so tracking N pools costs 3N account reads per
 * cycle (≈ 3N/100 RPC calls). Tracking the top ~50 pools is a handful of
 * calls every 15 minutes.
 *
 * Per-pool token decimals are required for correct price and TVL, so the
 * tracked-set file carries them (from Orca's token metadata endpoint).
 */

export interface TrackedPool {
  address: string;
  symbolA: string;
  symbolB: string;
  /** -1 when the Orca list lacks metadata — resolved on-chain by the collector. */
  decimalsA: number;
  decimalsB: number;
  /** Quote-token mint; decides whether TVL is USD (see isUsdQuote). */
  quoteMint: string;
  feeRate: number;
  /** TVL (USDC) at discovery time — ranking only, not authoritative. */
  tvlUsdcAtDiscovery: number;
}

const V2_POOLS = "https://api.orca.so/v2/solana/pools";
const V1_LIST = "https://api.mainnet.orca.so/v1/whirlpool/list";

export interface DiscoverOptions {
  /** Track every pool with at least this much 24h volume (USDC). */
  minVolume24hUsdc?: number;
  /** Hard cap on tracked pools (RPC-budget guard). */
  maxPools?: number;
  fetchImpl?: typeof fetch;
}

export interface DiscoveryResult {
  pools: TrackedPool[];
  /** Pools whose metadata came from chain instead of the Orca list. */
  skippedNoMetadata: number;
  /** Pools scanned across all pages before the threshold cut. */
  scanned: number;
  /** True when the max-pools cap truncated the set. */
  truncated: boolean;
}

/**
 * Walk the whole Orca pool universe (cursor-paginated, TVL-descending) and
 * keep every pool whose 24h volume clears the threshold. Volume — not TVL —
 * is the right filter: fee accrual is volume-driven, and a large idle pool
 * contributes nothing to a fee-yield dataset.
 */
export async function discoverPoolsByVolume(
  opts?: DiscoverOptions,
): Promise<DiscoveryResult> {
  const f = opts?.fetchImpl ?? fetch;
  const minVolume = opts?.minVolume24hUsdc ?? 10_000;
  const maxPools = opts?.maxPools ?? 400;

  // v1 carries token metadata (symbols + decimals) for the whole universe.
  const v1Res = await f(V1_LIST);
  if (!v1Res.ok) throw new Error(`Orca v1 list: HTTP ${v1Res.status}`);
  const v1 = (await v1Res.json()) as {
    whirlpools?: {
      address: string;
      tokenA: { mint: string; symbol: string; decimals: number };
      tokenB: { mint: string; symbol: string; decimals: number };
    }[];
  };
  const meta = new Map(
    (v1.whirlpools ?? []).map((w) => [
      w.address,
      {
        symbolA: w.tokenA.symbol,
        symbolB: w.tokenB.symbol,
        decimalsA: w.tokenA.decimals,
        decimalsB: w.tokenB.decimals,
        mintB: w.tokenB.mint,
      },
    ]),
  );

  const pools: TrackedPool[] = [];
  let skippedNoMetadata = 0;
  let scanned = 0;
  let truncated = false;
  let cursor: string | null = null;

  // TVL-descending pages; stop once volume-qualifying pools dry up.
  for (let page = 0; page < 40; page++) {
    const url = `${V2_POOLS}?limit=50&sort=tvl:desc${cursor ? `&after=${cursor}` : ""}`;
    const res = await f(url);
    if (!res.ok) throw new Error(`Orca v2 pools: HTTP ${res.status}`);
    const body = (await res.json()) as {
      data?: {
        address: string;
        tvlUsdc?: string | number;
        feeRate?: number;
        stats?: { "24h"?: { volume?: string | number } };
      }[];
      meta?: { cursor?: { next?: string | null } };
    };
    const items = body.data ?? [];
    if (items.length === 0) break;
    scanned += items.length;

    let qualifyingOnPage = 0;
    for (const p of items) {
      const volume = Number(p.stats?.["24h"]?.volume ?? 0);
      if (!Number.isFinite(volume) || volume < minVolume) continue;
      qualifyingOnPage++;
      const m = meta.get(p.address);
      if (!m) skippedNoMetadata++; // resolved on-chain by the collector
      pools.push({
        address: p.address,
        symbolA: m?.symbolA ?? "",
        symbolB: m?.symbolB ?? "",
        decimalsA: m?.decimalsA ?? -1,
        decimalsB: m?.decimalsB ?? -1,
        quoteMint: m?.mintB ?? "",
        feeRate: p.feeRate ?? 0,
        tvlUsdcAtDiscovery: Number(p.tvlUsdc ?? 0),
      });
      if (pools.length >= maxPools) {
        truncated = true;
        break;
      }
    }
    if (truncated) break;
    cursor = body.meta?.cursor?.next ?? null;
    if (!cursor) break;
    // Pages are TVL-ordered; once a whole page has no qualifying pool the
    // tail is dominated by dust — stop rather than walking thousands.
    if (qualifyingOnPage === 0 && page > 2) break;
  }

  if (pools.length === 0) {
    throw new Error(
      `pool discovery found no pools with 24h volume ≥ $${minVolume} (scanned ${scanned})`,
    );
  }
  return { pools, skippedNoMetadata, scanned, truncated };
}
