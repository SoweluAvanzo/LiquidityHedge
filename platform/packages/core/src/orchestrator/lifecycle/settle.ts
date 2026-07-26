/**
 * Settlement helper — wraps `OffchainLhProtocol.settleCertificate` with
 * the automatic Theorem 2.2 value-neutrality assertion so every
 * settlement path (live demo, test suite, future bot) verifies the
 * identity on every call.
 *
 * The identity:
 *
 *   LP_hedged + RT  ≡  Unhedged_LP − φ · premium
 *
 * is the empirical confirmation of §2.4 Theorem 2.2. A drift >
 * `tolerance` indicates a bookkeeping bug that must break the caller.
 */

import type { OffchainLhProtocol } from "../index";

export interface SettleWithAssertionParams {
  protocol: OffchainLhProtocol;
  settler: string;
  positionMint: string;
  settlementPriceE6: number;
  feesAccruedUsdc: number;
  /**
   * LP's realized position PnL (V(S_T) − V(S_0)) in human-readable USD.
   * Required to construct the three PnL values the assertion compares.
   */
  positionPnlUsd: number;
  /** Pool's protocol fee in BPS (e.g. 150 for 1.5%). */
  protocolFeeBps: number;
  /** Fee-split rate y in [0, 1]. */
  feeSplitRate: number;
  /** Tolerance in USD (defaults to $0.0001). */
  tolerance?: number;
}

export interface SettleWithAssertionResult {
  payoutUsdc: number;
  rtFeeIncomeUsdc: number;
  state: number;
  settlementPriceE6: number;
  feesAccruedUsdc: number;
  /** LP + RT = Unhedged − φ·premium should hold to `tolerance`. */
  theorem22Residual: number;
  theorem22Pass: boolean;
}

/**
 * Settle a certificate and assert Theorem 2.2.
 *
 * Throws if the residual exceeds the tolerance — callers can catch and
 * convert to a process-exit-code signal for CI / audit pipelines.
 */
export function settleAndAssert(
  params: SettleWithAssertionParams,
): SettleWithAssertionResult {
  const {
    protocol,
    settler,
    positionMint,
    settlementPriceE6,
    feesAccruedUsdc,
    positionPnlUsd,
    protocolFeeBps,
    feeSplitRate,
    tolerance = 1e-4,
  } = params;

  const settleResult = protocol.settleCertificate(
    settler,
    positionMint,
    settlementPriceE6,
    feesAccruedUsdc,
  );
  const cert = protocol.getCertificateState(positionMint);
  if (!cert) {
    throw new Error(`Certificate ${positionMint} not found post-settle`);
  }

  const feesUsd = feesAccruedUsdc / 1_000_000;
  const payoutUsd = settleResult.payoutUsdc / 1_000_000;
  const premiumUsd = cert.premiumUsdc / 1_000_000;
  const feeSplitUsd = settleResult.rtFeeIncomeUsdc / 1_000_000;

  const phi = protocolFeeBps / 10_000;

  const lpHedgedPnl =
    positionPnlUsd + feesUsd * (1 - feeSplitRate) - premiumUsd + payoutUsd;
  const lpUnhedgedPnl = positionPnlUsd + feesUsd;
  const rtPnl = premiumUsd * (1 - phi) + feeSplitUsd - payoutUsd;

  const expectedLeakage = phi * premiumUsd;
  const observedLeakage = lpUnhedgedPnl - (lpHedgedPnl + rtPnl);
  const residual = observedLeakage - expectedLeakage;
  const pass = Math.abs(residual) <= tolerance;

  if (!pass) {
    throw new Error(
      `Theorem 2.2 FAIL: residual $${residual.toFixed(9)} > tolerance $${tolerance}`,
    );
  }

  return {
    payoutUsdc: settleResult.payoutUsdc,
    rtFeeIncomeUsdc: settleResult.rtFeeIncomeUsdc,
    state: settleResult.state,
    settlementPriceE6: settleResult.settlementPriceE6,
    feesAccruedUsdc: settleResult.feesAccruedUsdc,
    theorem22Residual: residual,
    theorem22Pass: pass,
  };
}
