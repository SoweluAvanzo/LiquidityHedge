/**
 * Operator action list — the only mechanism that surfaces refunds due and
 * paid pre-orders awaiting manual delivery.
 *
 * It shipped inert: the reader matched event names the ledger never emits
 * ("Fulfilled" vs "OrderFulfilled"), and read the order's fields from the
 * top level of an event that nests them under `order`. Every entry read
 * `0.000000 USDC` with an empty product, and fulfilled orders never
 * cleared — so a 200 USDC pre-order and a $1.03 refund were
 * indistinguishable and permanent.
 *
 * These tests replay a synthetic ledger, so they fail if the event
 * vocabulary ever drifts again.
 */

import { expect } from "chai";
import { mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { summariseOrdersNeedingAttention } from "../../src/data-report";

function ledgerDir(events: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), "lh-orders-"));
  writeFileSync(
    join(dir, "order-events.jsonl"),
    events.map((e) => JSON.stringify(e)).join("\n") + "\n",
  );
  return dir;
}

const order = (orderId: string, amountUsdc: number, productId: string) => ({
  kind: "OrderCreated",
  ts: 1,
  order: { orderId, amountUsdc, productId },
});

describe("@lh/ops-jobs operator action list", () => {
  it("reports a refund with its REAL amount, not 0.000000", () => {
    const dir = ledgerDir([
      order("aaa", 1_030_000, "dataset-2026-forward"),
      { kind: "RefundDue", ts: 2, orderId: "aaa", reason: "wrong amount" },
    ]);
    const out = summariseOrdersNeedingAttention(dir);
    expect(out).to.have.length(1);
    expect(out[0]).to.contain("REFUND DUE");
    expect(out[0]).to.contain("1.030000");
    expect(out[0]).to.contain("dataset-2026-forward");
    expect(out[0]).to.not.contain("0.000000");
  });

  it("reports a paid pre-order awaiting manual delivery", () => {
    const dir = ledgerDir([
      order("bbb", 200_000_000, "dataset-archive-preorder"),
      { kind: "PaymentObserved", ts: 2, orderId: "bbb", payment: {} },
    ]);
    const out = summariseOrdersNeedingAttention(dir);
    expect(out).to.have.length(1);
    expect(out[0]).to.contain("DELIVER");
    expect(out[0]).to.contain("200.000000");
  });

  it("CLEARS a fulfilled order — the bug that made the list permanent", () => {
    const dir = ledgerDir([
      order("ccc", 1_000_000, "dataset-2026-forward"),
      { kind: "PaymentObserved", ts: 2, orderId: "ccc", payment: {} },
      { kind: "OrderFulfilled", ts: 3, orderId: "ccc", downloadToken: "h", expiresAtTs: 9 },
    ]);
    expect(summariseOrdersNeedingAttention(dir)).to.deep.equal([]);
  });

  it("clears an expired unpaid order", () => {
    const dir = ledgerDir([
      order("ddd", 1_000_000, "dataset-2026-forward"),
      { kind: "OrderExpired", ts: 2, orderId: "ddd" },
    ]);
    expect(summariseOrdersNeedingAttention(dir)).to.deep.equal([]);
  });

  it("keeps an awaiting-payment order off the list", () => {
    const dir = ledgerDir([order("eee", 1_000_000, "dataset-2026-forward")]);
    expect(summariseOrdersNeedingAttention(dir)).to.deep.equal([]);
  });

  it("returns nothing when there is no ledger", () => {
    expect(summariseOrdersNeedingAttention(undefined)).to.deep.equal([]);
    expect(summariseOrdersNeedingAttention(mkdtempSync(join(tmpdir(), "empty-")))).to.deep.equal([]);
  });
});
