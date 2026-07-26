import { expect } from "chai";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  fetchOhlcvPaged,
  computeCoverage,
  computeRealizedVol,
  computeRealizedVolGuarded,
  FileCandleStore,
  Candle,
  OhlcvFetcher,
  TIMEFRAME_SECONDS,
} from "../../src";

/** Fake provider: serves a fixed candle series in pages of `pageSize`,
 *  earliest-first — exactly Birdeye's observed behavior. */
function makeFakeProvider(series: Candle[], pageSize = 1000) {
  let calls = 0;
  const fetcher: OhlcvFetcher = async ({ timeFrom, timeTo }) => {
    calls++;
    const inWindow = series.filter((c) => c.t >= timeFrom && c.t <= timeTo);
    return { items: inWindow.slice(0, pageSize) };
  };
  return { fetcher, callCount: () => calls };
}

function synthSeries(
  start: number,
  count: number,
  step: number,
  priceAt: (i: number) => number,
): Candle[] {
  return Array.from({ length: count }, (_, i) => {
    const p = priceAt(i);
    return { t: start + i * step, o: p, h: p * 1.001, l: p * 0.999, c: p, v: 1000 };
  });
}

describe("@lh/market-data ingestion", () => {
  const STEP = TIMEFRAME_SECONDS["15m"];
  const START = 1_750_000_000;

  it("pages through the 1000-candle cap and covers the full window", async () => {
    // 2880 candles = 30 days of 15m — the exact case the prototype got wrong.
    const series = synthSeries(START, 2880, STEP, (i) => 150 + Math.sin(i / 50));
    const { fetcher, callCount } = makeFakeProvider(series, 1000);

    const res = await fetchOhlcvPaged(
      fetcher,
      "SOLMINT",
      "15m",
      START,
      START + 2880 * STEP,
    );

    expect(res.candles.length).to.equal(2880);
    expect(callCount()).to.be.greaterThan(2); // really paginated
    expect(res.coverage.complete).to.equal(true);
    expect(res.coverage.gaps).to.equal(0);
    // strictly ascending, no duplicates
    for (let i = 1; i < res.candles.length; i++) {
      expect(res.candles[i].t).to.be.greaterThan(res.candles[i - 1].t);
    }
  });

  it("reports incomplete coverage and gaps instead of silently truncating", async () => {
    // Provider is missing a 500-candle chunk in the middle.
    const full = synthSeries(START, 2000, STEP, () => 100);
    const gappy = [...full.slice(0, 700), ...full.slice(1200)];
    const { fetcher } = makeFakeProvider(gappy, 1000);

    const res = await fetchOhlcvPaged(
      fetcher,
      "SOLMINT",
      "15m",
      START,
      START + 2000 * STEP,
    );

    expect(res.candles.length).to.equal(1500);
    expect(res.coverage.complete).to.equal(false);
    expect(res.coverage.gaps).to.equal(500);
    expect(res.coverage.coverageRatio).to.be.closeTo(0.75, 0.01);
  });

  it("computeCoverage flags an empty result as incomplete", () => {
    const cov = computeCoverage([], "1D", START, START + 30 * 86_400);
    expect(cov.complete).to.equal(false);
    expect(cov.received).to.equal(0);
  });

  it("realized vol recovers the generating sigma of a synthetic GBM series", () => {
    // Daily GBM with sigma = 60% annualized, deterministic seed.
    let state = 42;
    const rng = () => {
      state |= 0; state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const sigma = 0.6;
    const dt = 1 / 365;
    let price = 150;
    const series: Candle[] = [];
    for (let i = 0; i < 3000; i++) {
      const u1 = Math.max(rng(), 1e-12);
      const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * rng());
      price *= Math.exp(-0.5 * sigma * sigma * dt + sigma * Math.sqrt(dt) * z);
      series.push({ t: START + i * 86_400, o: price, h: price, l: price, c: price, v: 0 });
    }
    const rv = computeRealizedVol(series, "1D")!;
    expect(rv.sigma).to.be.closeTo(sigma, 0.05); // statistical tolerance
    expect(rv.nReturns).to.equal(2999);
  });

  it("guarded vol REFUSES degraded coverage (the §E7 contract)", () => {
    const series = synthSeries(START, 100, 86_400, () => 100);
    const badCoverage = computeCoverage(series, "1D", START, START + 365 * 86_400);
    expect(() => computeRealizedVolGuarded(series, "1D", badCoverage)).to.throw(
      /refused: coverage/,
    );
  });

  it("FileCandleStore roundtrips, dedups, and reports latest", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-candles-"));
    try {
      const store = new FileCandleStore(dir);
      const a = synthSeries(START, 100, 86_400, (i) => 100 + i);
      const added1 = await store.upsert("MINT", "1D", a);
      const added2 = await store.upsert("MINT", "1D", a.slice(50)); // overlap
      expect(added1).to.equal(100);
      expect(added2).to.equal(0);
      const mid = await store.read("MINT", "1D", START + 10 * 86_400, START + 19 * 86_400);
      expect(mid.length).to.equal(10);
      expect(await store.latest("MINT", "1D")).to.equal(START + 99 * 86_400);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
