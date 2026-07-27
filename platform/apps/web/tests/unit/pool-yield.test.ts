import { expect } from "chai";
import { readMeasuredPoolYield } from "../../src/lib/server/pool-yield";

/**
 * §1.1 fallback-labelling contract: when the measured path cannot serve,
 * the result must carry a human-readable reason — the wire label the UI
 * shows verbatim. A missing DB or a non-USD pool must degrade to the
 * labelled Birdeye fallback, never throw and never fake a measurement.
 */
describe("readMeasuredPoolYield failure labelling", () => {
  const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const JITOSOL = "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn";

  /** The db pool singleton caches on globalThis — reset between tests. */
  beforeEach(() => {
    delete (globalThis as Record<string, unknown>).__lhDbPool;
  });

  it("labels a non-USD-quoted pool rather than mixing units", async () => {
    const r = await readMeasuredPoolYield("SomePool", 9, 9, JITOSOL);
    expect(r.ok).to.equal(false);
    if (!r.ok) expect(r.reason).to.match(/not a USD stablecoin/);
  });

  it("labels a missing DATABASE_URL rather than throwing", async () => {
    const prev = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      const r = await readMeasuredPoolYield("SomePool", 9, 6, USDC);
      expect(r.ok).to.equal(false);
      if (!r.ok) expect(r.reason).to.match(/DATABASE_URL/);
    } finally {
      if (prev !== undefined) process.env.DATABASE_URL = prev;
    }
  });
});
