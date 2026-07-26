/**
 * Paginated OHLCV ingestion.
 *
 * Root cause being fixed (Phase-0 spike, 2026-07-07): Birdeye caps every
 * OHLCV response at 1000 candles and returns the EARLIEST candles of the
 * requested window. A naive single request for "30 days of 15m candles"
 * therefore yields ~10 days ending three weeks in the past. This module
 * pages forward until the window is covered and reports coverage
 * explicitly so downstream consumers can refuse degraded data.
 */

import {
  Candle,
  CoverageReport,
  OhlcvFetcher,
  Timeframe,
  TIMEFRAME_SECONDS,
} from "./types";

const MAX_PAGES = 200; // hard stop: 200k candles per ingestion call

export interface IngestResult {
  candles: Candle[];
  coverage: CoverageReport;
}

export async function fetchOhlcvPaged(
  fetcher: OhlcvFetcher,
  address: string,
  timeframe: Timeframe,
  timeFrom: number,
  timeTo: number,
): Promise<IngestResult> {
  if (timeTo <= timeFrom) {
    throw new Error(`fetchOhlcvPaged: empty window [${timeFrom}, ${timeTo}]`);
  }
  const step = TIMEFRAME_SECONDS[timeframe];
  const byTime = new Map<number, Candle>();

  let cursor = timeFrom;
  for (let page = 0; page < MAX_PAGES; page++) {
    const { items } = await fetcher({
      address,
      timeframe,
      timeFrom: cursor,
      timeTo,
    });
    if (items.length === 0) break;

    let maxT = cursor;
    for (const c of items) {
      if (c.t >= timeFrom && c.t <= timeTo) byTime.set(c.t, c);
      if (c.t > maxT) maxT = c.t;
    }
    // Advance strictly past the last candle received; stop when the
    // provider has nothing newer inside the window.
    if (maxT + step > timeTo) break;
    if (maxT < cursor + step) break; // no forward progress → avoid spinning
    cursor = maxT + step;
  }

  const candles = [...byTime.values()].sort((a, b) => a.t - b.t);
  return { candles, coverage: computeCoverage(candles, timeframe, timeFrom, timeTo) };
}

export function computeCoverage(
  candles: Candle[],
  timeframe: Timeframe,
  timeFrom: number,
  timeTo: number,
): CoverageReport {
  const step = TIMEFRAME_SECONDS[timeframe];
  const expected = Math.max(1, Math.floor((timeTo - timeFrom) / step));
  let gaps = 0;
  for (let i = 1; i < candles.length; i++) {
    const delta = candles[i].t - candles[i - 1].t;
    if (delta > step) gaps += Math.round(delta / step) - 1;
  }
  const received = candles.length;
  const coverageRatio = Math.min(1, received / expected);
  return {
    requestedFrom: timeFrom,
    requestedTo: timeTo,
    received,
    expected,
    coverageRatio,
    gaps,
    firstT: candles[0]?.t ?? null,
    lastT: candles[candles.length - 1]?.t ?? null,
    // 98%: providers legitimately miss the odd candle; anything worse is
    // degraded data and must be surfaced, not smoothed over.
    complete: coverageRatio >= 0.98 && received > 0,
  };
}

/** Birdeye transport for the paginated fetcher. */
export function makeBirdeyeFetcher(
  apiKey: string,
  baseUrl = "https://public-api.birdeye.so/defi/ohlcv",
  fetchImpl: typeof fetch = fetch,
): OhlcvFetcher {
  return async ({ address, timeframe, timeFrom, timeTo }) => {
    const url =
      `${baseUrl}?address=${address}&type=${timeframe}` +
      `&time_from=${timeFrom}&time_to=${timeTo}`;
    const res = await fetchImpl(url, {
      headers: { "X-API-KEY": apiKey, "x-chain": "solana" },
    });
    if (!res.ok) {
      throw new Error(`Birdeye OHLCV: HTTP ${res.status} ${res.statusText}`);
    }
    const body = (await res.json()) as any;
    if (!body?.success || !Array.isArray(body?.data?.items)) {
      throw new Error(
        `Birdeye OHLCV: malformed response ${JSON.stringify(body).slice(0, 160)}`,
      );
    }
    return {
      items: body.data.items.map((i: any) => ({
        t: i.unixTime,
        o: i.o,
        h: i.h,
        l: i.l,
        c: i.c,
        v: i.v ?? 0,
      })),
    };
  };
}

/** Birdeye PAIR-level OHLCV transport (whirlpool address as `address`) —
 *  same paginated fetcher, pool-specific volume series for fee-intensity
 *  calibration. */
export function makeBirdeyePairFetcher(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): OhlcvFetcher {
  return makeBirdeyeFetcher(apiKey, "https://public-api.birdeye.so/defi/ohlcv/pair", fetchImpl);
}
