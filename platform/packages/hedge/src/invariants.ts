/**
 * Runtime invariant monitors — the SAME properties proved on the formal
 * model (platform/formal/lh_ledger.qnt I1–I4), re-checked after every
 * ledger transition in production (FR-A5). A violation here means the
 * implementation has diverged from the verified design: the ledger throws
 * and the operator alert fires; quoting pauses, settlement never does.
 */

import { InvariantViolation, LedgerState } from "./types";

export function unmatchedFloat(state: LedgerState): number {
  let sum = 0;
  for (const p of state.paymentsByTx.values()) if (!p.matched) sum += p.amountUsdc;
  return sum;
}

export function activeCollateral(state: LedgerState): number {
  let sum = 0;
  for (const c of state.certs.values()) if (c.status === "active") sum += c.capUpUsdc;
  return sum;
}

export function activeCapDown(state: LedgerState): number {
  let sum = 0;
  for (const c of state.certs.values()) if (c.status === "active") sum += c.capDownUsdc;
  return sum;
}

export function worstObligations(state: LedgerState): number {
  let sum = 0;
  for (const c of state.certs.values()) {
    if (c.status === "active") sum += c.capDownUsdc + c.capUpUsdc;
  }
  return sum;
}

/** E12: reserves available to back NEW exposure — never counts other
 *  people's money (unprocessed payments, held collateral). */
export function netReserves(state: LedgerState): number {
  return state.treasuryUsdc - unmatchedFloat(state) - activeCollateral(state);
}

export interface InvariantReport {
  ok: boolean;
  failures: string[];
}

export function checkInvariants(state: LedgerState): InvariantReport {
  const failures: string[] = [];
  const float = unmatchedFloat(state);
  const collateral = activeCollateral(state);
  const worst = worstObligations(state);

  // I1 — solvency
  if (state.treasuryUsdc < float + collateral) {
    failures.push(
      `I1a: treasury ${state.treasuryUsdc} < float ${float} + collateral ${collateral}`,
    );
  }
  if (state.treasuryUsdc < float + worst) {
    failures.push(
      `I1b: treasury ${state.treasuryUsdc} < float ${float} + worst-case obligations ${worst}`,
    );
  }

  // I2 — exactly-once activation with exact-amount matched payment
  for (const [quoteId, cert] of state.certs) {
    const q = state.quotes.get(quoteId);
    if (!q) {
      failures.push(`I2: certificate ${quoteId} has no quote`);
      continue;
    }
    if (q.status !== "consumed") {
      failures.push(`I2: certificate ${quoteId} but quote status ${q.status}`);
    }
    let matchedExact = false;
    for (const p of state.paymentsByTx.values()) {
      if (
        p.referenceKey === q.referenceKey &&
        p.matched &&
        p.amountUsdc === q.premiumUsdc + q.capUpUsdc
      ) {
        matchedExact = true;
        break;
      }
    }
    if (!matchedExact) {
      failures.push(`I2: certificate ${quoteId} lacks a matched exact-amount payment`);
    }
    void cert;
  }

  // I3 — conservation (E13: inflows ledgered at observation time)
  const expected =
    state.initialReservesUsdc +
    state.totalInUsdc -
    state.totalSettledUsdc -
    state.totalRefundedUsdc;
  if (state.treasuryUsdc !== expected) {
    failures.push(
      `I3: treasury ${state.treasuryUsdc} != initial ${state.initialReservesUsdc} ` +
        `+ in ${state.totalInUsdc} − settled ${state.totalSettledUsdc} ` +
        `− refunded ${state.totalRefundedUsdc} (= ${expected})`,
    );
  }

  // I4 — bounds
  if (state.treasuryUsdc < 0) failures.push(`I4: treasury negative`);
  for (const [quoteId, cert] of state.certs) {
    const s = cert.settlement;
    if (!s) continue;
    if (s.settlementAmountUsdc < 0 || s.settlementAmountUsdc > cert.capDownUsdc + cert.capUpUsdc) {
      failures.push(
        `I4: settlement ${s.settlementAmountUsdc} out of [0, ${cert.capDownUsdc + cert.capUpUsdc}] for ${quoteId}`,
      );
    }
    if (s.payoffUsdc < -cert.capUpUsdc || s.payoffUsdc > cert.capDownUsdc) {
      failures.push(`I4: payoff ${s.payoffUsdc} outside caps for ${quoteId}`);
    }
    // Master Terms §7.2 identity: settlement = max(0, payoff − feeSplit + collateral)
    const expectedAmount = Math.max(0, s.payoffUsdc - s.feeSplitUsdc + cert.capUpUsdc);
    if (s.settlementAmountUsdc !== expectedAmount) {
      failures.push(
        `I4: §7.2 identity broken for ${quoteId}: ${s.settlementAmountUsdc} != ${expectedAmount}`,
      );
    }
  }

  return { ok: failures.length === 0, failures };
}

export function assertInvariants(state: LedgerState): void {
  const report = checkInvariants(state);
  if (!report.ok) {
    throw new InvariantViolation(report.failures.join("; "));
  }
}
