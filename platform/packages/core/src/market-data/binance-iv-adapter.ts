/**
 * Binance-options SOL implied-volatility adapter.
 *
 * Replaces the hardcoded `ivRvRatio = 1.08` in the regime snapshot with
 * a measurement-driven value derived from Binance's public options feed.
 *
 * Why Binance (not Deribit or OKX):
 *   - Deribit trades BTC/ETH/XRP but no SOL options (empirical check:
 *     `/public/get_instruments?currency=SOL` returns an empty array).
 *   - OKX returns no SOL options on `instType=OPTION&uly=SOL-USD`.
 *   - Binance's /eapi does trade SOL options with active mark IVs.
 *
 * Pricing convention:
 *   - `markIV` is annualized as a decimal (e.g. 0.55 = 55%).
 *   - We pull the ATM call — strike closest to current spot, delta
 *     closest to 0.50 — since ATM IV is the least distorted by skew.
 *
 * Usage:
 *   const iv = await fetchSolAtmImpliedVol(tenorSeconds);
 *   const ivRvRatio = iv !== null ? iv / realizedVol : fallback;
 *
 * If Binance is unreachable or returns no matching expiry, returns
 * `null` so callers can fall back to a governance default and log the
 * incident. This is the same "null → governance-visible fallback"
 * pattern as the concentration-factor probe.
 */

// ---------------------------------------------------------------------------
// Binance eapi responses (narrow to fields we use)
// ---------------------------------------------------------------------------

interface BinanceOptionContractInfo {
  symbol: string; // e.g. "SOL-260424-88-C"
  underlying: string; // e.g. "SOLUSDT"
  expiryDate: number; // unix ms
  strikePrice: string;
  side: "CALL" | "PUT";
}

interface BinanceExchangeInfo {
  optionSymbols?: BinanceOptionContractInfo[];
}

interface BinanceMarkRow {
  symbol: string;
  markPrice: string;
  markIV: string; // annualized decimal
  delta: string;
  bidIV?: string;
  askIV?: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SolIvEstimate {
  /** ATM implied volatility, annualized decimal (e.g. 0.55 = 55%). */
  markIV: number;
  /** Instrument symbol chosen, for audit. */
  symbol: string;
  /** |delta − 0.5| of the chosen call (closer to 0 = more ATM). */
  deltaDistance: number;
  /** Option expiry timestamp (unix ms). */
  expiryTs: number;
  /** Expiry distance from the requested tenor (days, positive = expiry is later). */
  expiryMismatchDays: number;
  fetchedAt: Date;
}

const BINANCE_BASE = "https://eapi.binance.com/eapi/v1";

/**
 * Fetch the ATM call's implied volatility for SOL, for an expiry as
 * close as possible to `tenorSeconds` from now.
 *
 * Strategy (robust to market drift):
 *   1. `/exchangeInfo` → list of all live SOL options.
 *   2. Filter to the expiry closest to `now + tenorSeconds`.
 *   3. `/mark` → mark IVs for every SOL option (one call, small payload).
 *   4. Join by symbol, keep calls only, pick the one with delta closest
 *      to 0.5 among the target expiry.
 *   5. Return its `markIV`.
 *
 * Returns null on any fault (network, empty response, no matching expiry,
 * no ATM call in the expiry cohort). Callers log and fall back.
 */
export async function fetchSolAtmImpliedVol(
  tenorSeconds: number,
): Promise<SolIvEstimate | null> {
  try {
    const [infoRes, markRes] = await Promise.all([
      fetch(`${BINANCE_BASE}/exchangeInfo`),
      fetch(`${BINANCE_BASE}/mark`),
    ]);
    if (!infoRes.ok || !markRes.ok) return null;
    const info = (await infoRes.json()) as BinanceExchangeInfo;
    const marks = (await markRes.json()) as BinanceMarkRow[];

    const solContracts = (info.optionSymbols ?? []).filter(
      (c) => typeof c.symbol === "string" && c.symbol.startsWith("SOL-"),
    );
    if (solContracts.length === 0) return null;

    // Target expiry = now + tenor (ms).
    const targetMs = Date.now() + tenorSeconds * 1_000;

    // Pick a unique expiry closest to target.
    const expirySet = Array.from(
      new Set(solContracts.map((c) => c.expiryDate)),
    );
    expirySet.sort((a, b) => Math.abs(a - targetMs) - Math.abs(b - targetMs));
    const chosenExpiry = expirySet[0];
    if (chosenExpiry === undefined) return null;

    // Calls in the chosen expiry.
    const callsInExpiry = solContracts.filter(
      (c) => c.expiryDate === chosenExpiry && c.side === "CALL",
    );
    if (callsInExpiry.length === 0) return null;

    // Join with mark data and pick ATM call (delta closest to 0.5).
    const markBySymbol = new Map<string, BinanceMarkRow>(
      marks.map((m) => [m.symbol, m]),
    );
    type EnrichedRow = BinanceOptionContractInfo & {
      markIV: number;
      delta: number;
    };
    const enriched: EnrichedRow[] = [];
    for (const c of callsInExpiry) {
      const m = markBySymbol.get(c.symbol);
      if (!m) continue;
      const iv = Number(m.markIV);
      const delta = Number(m.delta);
      if (!Number.isFinite(iv) || !Number.isFinite(delta)) continue;
      if (iv <= 0) continue; // e.g. illiquid strikes
      enriched.push({ ...c, markIV: iv, delta });
    }
    if (enriched.length === 0) return null;

    enriched.sort(
      (a, b) => Math.abs(a.delta - 0.5) - Math.abs(b.delta - 0.5),
    );
    const best = enriched[0];
    return {
      markIV: best.markIV,
      symbol: best.symbol,
      deltaDistance: Math.abs(best.delta - 0.5),
      expiryTs: best.expiryDate,
      expiryMismatchDays:
        (best.expiryDate - targetMs) / (86_400 * 1_000),
      fetchedAt: new Date(),
    };
  } catch {
    return null;
  }
}

/**
 * Compute the IV/RV ratio, with explicit fallback semantics.
 *
 * @param ivAnnualized       Observed ATM implied vol (decimal). Pass null
 *                           to force fallback.
 * @param realizedAnnualized Realized vol (decimal, same units).
 * @param fallbackRatio      Value to return if IV is unavailable. Default
 *                           is 1.0 — below `markupFloor` so `effectiveMarkup`
 *                           binds on the floor rather than on stale data.
 */
export function computeIvRvRatio(
  ivAnnualized: number | null,
  realizedAnnualized: number,
  fallbackRatio: number = 1.0,
): { ratio: number; source: "measured" | "fallback" } {
  if (
    ivAnnualized === null ||
    !Number.isFinite(ivAnnualized) ||
    ivAnnualized <= 0 ||
    !Number.isFinite(realizedAnnualized) ||
    realizedAnnualized <= 0
  ) {
    return { ratio: fallbackRatio, source: "fallback" };
  }
  return {
    ratio: ivAnnualized / realizedAnnualized,
    source: "measured",
  };
}
