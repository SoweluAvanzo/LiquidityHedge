/**
 * Regime updater (FR-A2): composes the MarketInputs the hedge ledger
 * quotes against.
 *
 *   sigmaAnnual — 30-day realized vol from PAGINATED 15m candles
 *                 (the prototype's truncation bug is structurally fixed),
 *                 computed only when coverage is complete (§E7).
 *   ivRvRatio   — Binance SOL ATM IV / RV; falls back to 1.0 (markup
 *                 floor then binds) when the options feed is unavailable —
 *                 a LOGGED fallback, never a silent one.
 *
 * Pure over injected fetchers/clock — unit-testable offline; the CLI
 * wires the real transports.
 */

import {
  fetchOhlcvPaged,
  computeRealizedVolGuarded,
  OhlcvFetcher,
} from "@lh/market-data";
import { MarketInputs } from "@lh/hedge";

export const SOL_MINT = "So11111111111111111111111111111111111111112";

export interface RegimeUpdateResult {
  inputs: MarketInputs;
  detail: {
    rvAnnual: number;
    rvCandles: number;
    rvCoverageRatio: number;
    ivAnnual: number | null;
    ivSource: string;
    fallbackUsed: boolean;
  };
}

export interface IvSource {
  /** Returns annualized ATM IV (e.g. 0.62) or null when unavailable. */
  fetchIv(tenorSeconds: number): Promise<{ iv: number; label: string } | null>;
}

export async function computeMarketInputs(params: {
  candleFetcher: OhlcvFetcher;
  ivSource: IvSource;
  nowTs: number;
  tenorSeconds?: number;
  rvWindowDays?: number;
}): Promise<RegimeUpdateResult> {
  const tenorSeconds = params.tenorSeconds ?? 604_800;
  const windowDays = params.rvWindowDays ?? 30;
  const timeTo = params.nowTs;
  const timeFrom = timeTo - windowDays * 86_400;

  const { candles, coverage } = await fetchOhlcvPaged(
    params.candleFetcher,
    SOL_MINT,
    "15m",
    timeFrom,
    timeTo,
  );
  // Throws on degraded coverage — the regime must NEVER update on bad data.
  const rv = computeRealizedVolGuarded(candles, "15m", coverage);

  const ivReading = await params.ivSource.fetchIv(tenorSeconds);
  const fallbackUsed = ivReading === null;
  const ivRvRatio = fallbackUsed ? 1.0 : ivReading.iv / rv.sigma;

  return {
    inputs: {
      sigmaAnnual: rv.sigma,
      ivRvRatio,
      regimeUpdatedAtTs: params.nowTs,
    },
    detail: {
      rvAnnual: rv.sigma,
      rvCandles: rv.nReturns + 1,
      rvCoverageRatio: coverage.coverageRatio,
      ivAnnual: ivReading?.iv ?? null,
      ivSource: ivReading?.label ?? "unavailable → ivRv=1.0 (markup floor binds)",
      fallbackUsed,
    },
  };
}
