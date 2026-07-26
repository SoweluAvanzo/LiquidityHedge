/**
 * MarketInputs for hedge quoting (server-only), composed by the
 * @lh/ops-jobs regime updater from live sources:
 *
 *   sigmaAnnual — 30-day realized vol from paginated Birdeye 15m candles
 *                 (refuses degraded coverage, §E7);
 *   ivRvRatio   — Binance SOL ATM IV / RV (logged fallback to 1.0 when
 *                 the options feed is unavailable — markup floor binds).
 *
 * Cached for 10 minutes per process: comfortably inside the ledger's
 * regimeMaxAgeSeconds = 900, so a cached snapshot can never be refused
 * as stale. The in-flight promise is cached (not just the result) so a
 * cold-cache burst performs exactly one upstream fetch.
 */

import { makeBirdeyeFetcher } from "@lh/market-data";
import { fetchSolAtmImpliedVol } from "@lh/core/src/market-data/binance-iv-adapter";
import { computeMarketInputs, type RegimeUpdateResult } from "@lh/ops-jobs";
import { birdeyeApiKey } from "./birdeye";
import { HedgeUnavailableError } from "./hedge-ledger";

const TTL_MS = 10 * 60 * 1000;

interface MarketCache {
  fetchedAt: number;
  promise: Promise<RegimeUpdateResult>;
}

// One cache per process (survives dev HMR), same pattern as the ledger.
const registry = globalThis as unknown as { __lhHedgeMarket?: MarketCache };

export async function getMarketInputs(
  tenorSeconds: number,
): Promise<RegimeUpdateResult> {
  const apiKey = birdeyeApiKey();
  if (!apiKey) {
    throw new HedgeUnavailableError(
      "market data not configured (BIRDEYE_API_KEY)",
    );
  }

  const now = Date.now();
  const cached = registry.__lhHedgeMarket;
  if (cached && now - cached.fetchedAt < TTL_MS) return cached.promise;

  const promise = computeMarketInputs({
    candleFetcher: makeBirdeyeFetcher(apiKey),
    ivSource: {
      fetchIv: async (tenor) => {
        const est = await fetchSolAtmImpliedVol(tenor);
        return est ? { iv: est.markIV, label: `binance:${est.symbol}` } : null;
      },
    },
    nowTs: Math.floor(now / 1000),
    tenorSeconds,
  });
  registry.__lhHedgeMarket = { fetchedAt: now, promise };
  // A failed refresh must not poison the cache for its TTL.
  promise.catch(() => {
    if (registry.__lhHedgeMarket?.promise === promise) {
      registry.__lhHedgeMarket = undefined;
    }
  });
  return promise;
}
