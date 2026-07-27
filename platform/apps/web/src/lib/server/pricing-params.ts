/**
 * §1.8 — THE single read-only source for premium parameters.
 *
 * Before this module, the dashboard hardcoded `EFFECTIVE_MARKUP = 1.08`
 * and its own fee split while the quote path used live
 * `max(markupFloor, IV/RV)` — so the dashboard priced a certificate
 * nobody would be quoted (audit A7/D-5), and the premium floor existed
 * as TWO live constants 30× apart (decision D1: \$0.05 is the value;
 * the \$1.50 protocol constant is renamed LEGACY_ in @lh/core).
 *
 * Both consumers import from HERE:
 *  - hedge-ledger's buildConfig()  (the quote path)
 *  - viability.ts                  (the dashboard)
 *
 * Static params are env-derived governance values; the effective markup
 * additionally needs the live IV/RV regime and is async + cached (the
 * same 10-minute cache the quote path uses — one fetch, one number).
 */

import { numericEnv } from "@lh/storage";

export interface StaticPricingParams {
  /** Governance floor, µUSDC (D1: \$0.05; env-overridable). */
  premiumFloorUsdc: number;
  markupFloor: number;
  feeSplitRate: number;
  protocolFeeBps: number;
  tenorSeconds: number;
  /** Governance E[F] input for QUOTING. The dashboard uses its measured
   *  yield instead — reconciling these two is tracked in the plan. */
  expectedDailyFee: number;
  uMaxBps: number;
}

export function getStaticPricingParams(): StaticPricingParams {
  return {
    premiumFloorUsdc: numericEnv("HEDGE_PREMIUM_FLOOR_USDC", 50_000),
    markupFloor: 1.05,
    feeSplitRate: numericEnv("HEDGE_FEE_SPLIT_RATE", 0.1),
    protocolFeeBps: 150,
    tenorSeconds: numericEnv("HEDGE_TENOR_SECONDS", 604_800),
    expectedDailyFee: numericEnv("HEDGE_EXPECTED_DAILY_FEE", 0.0005),
    uMaxBps: 3000,
  };
}

export interface EffectiveMarkupResult {
  /** max(markupFloor, ivRvRatio) — the m_vol the quote path applies. */
  effectiveMarkup: number;
  ivRvRatio: number;
  /** Verbatim source label (C5 groundwork): e.g. "binance:SOL-…", or
   *  the logged fallback text when the options feed is unavailable. */
  ivSource: string;
  ivFallbackUsed: boolean;
}

/**
 * Live effective markup from the same market cache the quote path uses.
 * On ANY failure returns the markup floor with the reason labelled —
 * the floor is the conservative bound (m_vol ≥ markupFloor always), and
 * a dashboard must degrade visibly, not die.
 */
export async function getEffectiveMarkup(): Promise<EffectiveMarkupResult> {
  const params = getStaticPricingParams();
  try {
    // Call-time import: hedge-market imports from hedge-ledger, which
    // imports THIS module for its static params — a top-level import
    // here would close that cycle at module-init time.
    const { getMarketInputs } = await import("./hedge-market");
    const regime = await getMarketInputs(params.tenorSeconds);
    return {
      effectiveMarkup: Math.max(params.markupFloor, regime.inputs.ivRvRatio),
      ivRvRatio: regime.inputs.ivRvRatio,
      ivSource: regime.detail.ivSource,
      ivFallbackUsed: regime.detail.fallbackUsed,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(`[pricing-params] IV/RV unavailable (${msg}) — markup floor binds`);
    return {
      effectiveMarkup: params.markupFloor,
      ivRvRatio: 1.0,
      ivSource: `unavailable (${msg.slice(0, 80)}) → markup floor binds`,
      ivFallbackUsed: true,
    };
  }
}
