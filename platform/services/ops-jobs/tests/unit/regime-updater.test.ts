import { expect } from "chai";
import { OhlcvFetcher, Candle, TIMEFRAME_SECONDS } from "@lh/market-data";
import { computeMarketInputs } from "../../src/regime-updater";

const STEP = TIMEFRAME_SECONDS["15m"];
const NOW = 1_780_000_000;

function gbmCandles(sigma: number, days: number, seed = 7): Candle[] {
  let state = seed;
  const rng = () => {
    state |= 0; state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const n = (days * 86_400) / STEP;
  const dt = STEP / (365 * 86_400);
  let price = 150;
  const out: Candle[] = [];
  const start = NOW - days * 86_400;
  for (let i = 0; i < n; i++) {
    const z = Math.sqrt(-2 * Math.log(Math.max(rng(), 1e-12))) * Math.cos(2 * Math.PI * rng());
    price *= Math.exp(-0.5 * sigma * sigma * dt + sigma * Math.sqrt(dt) * z);
    out.push({ t: start + i * STEP, o: price, h: price, l: price, c: price, v: 1 });
  }
  return out;
}

function pagedFetcher(series: Candle[], pageSize = 1000): OhlcvFetcher {
  return async ({ timeFrom, timeTo }) => ({
    items: series.filter((c) => c.t >= timeFrom && c.t <= timeTo).slice(0, pageSize),
  });
}

describe("@lh/ops-jobs regime updater (FR-A2)", () => {
  it("composes MarketInputs: guarded RV from paginated candles + IV/RV", async () => {
    const result = await computeMarketInputs({
      candleFetcher: pagedFetcher(gbmCandles(0.6, 30)),
      ivSource: { fetchIv: async () => ({ iv: 0.66, label: "test" }) },
      nowTs: NOW,
    });
    expect(result.inputs.sigmaAnnual).to.be.closeTo(0.6, 0.06);
    expect(result.inputs.ivRvRatio).to.be.closeTo(0.66 / result.inputs.sigmaAnnual, 1e-9);
    expect(result.inputs.regimeUpdatedAtTs).to.equal(NOW);
    expect(result.detail.rvCandles).to.be.greaterThan(2800); // full 30d, not 10d
    expect(result.detail.fallbackUsed).to.equal(false);
  });

  it("IV unavailable → ivRv = 1.0 and the fallback is flagged, never silent", async () => {
    const result = await computeMarketInputs({
      candleFetcher: pagedFetcher(gbmCandles(0.6, 30)),
      ivSource: { fetchIv: async () => null },
      nowTs: NOW,
    });
    expect(result.inputs.ivRvRatio).to.equal(1.0);
    expect(result.detail.fallbackUsed).to.equal(true);
    expect(result.detail.ivSource).to.match(/unavailable/);
  });

  it("REFUSES to update on degraded candle coverage (§E7)", async () => {
    // Only 12 of 30 days available — the exact prototype failure mode.
    const short = gbmCandles(0.6, 30).slice(0, (12 * 86_400) / STEP);
    try {
      await computeMarketInputs({
        candleFetcher: pagedFetcher(short),
        ivSource: { fetchIv: async () => ({ iv: 0.66, label: "test" }) },
        nowTs: NOW,
      });
      expect.fail("should have refused");
    } catch (e: any) {
      expect(e.message).to.match(/refused: coverage/);
    }
  });
});
