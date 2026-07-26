import { expect } from "chai";
import {
  AssetSeries,
  GbmModel,
  EmpiricalBootstrapModel,
  simulatePortfolio,
  listModels,
  getModel,
  makeRng,
  SECONDS_PER_YEAR,
  SimPosition,
} from "../../src";

const DAY = 86_400;
const WEEK = 7 * DAY;

/** Synthetic daily GBM history with target sigma (annualized) and optional
 *  cross-correlation to a driver series. */
function synthHistory(
  assetId: string,
  sigma: number,
  n: number,
  seed: number,
  driver?: number[],
  rho = 0,
): { series: AssetSeries; shocks: number[] } {
  const rng = makeRng(seed);
  const dt = 1 / 365;
  const closes = [100];
  const shocks: number[] = [];
  for (let i = 0; i < n; i++) {
    const own = rng.gaussian();
    const z = driver ? rho * driver[i] + Math.sqrt(1 - rho * rho) * own : own;
    shocks.push(z);
    closes.push(
      closes[closes.length - 1] *
        Math.exp(-0.5 * sigma * sigma * dt + sigma * Math.sqrt(dt) * z),
    );
  }
  return { series: { assetId, closes, stepSeconds: DAY }, shocks };
}

function corr(xs: number[], ys: number[]): number {
  const n = xs.length;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let sxy = 0,
    sxx = 0,
    syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  return sxy / Math.sqrt(sxx * syy);
}

describe("@lh/risk-models", () => {
  describe("RiskModel port", () => {
    it("registry lists all models with JSON-Schema configs", () => {
      const models = listModels();
      const ids = models.map((m) => m.id).sort();
      expect(ids).to.deep.equal(["empirical-bootstrap", "gbm", "historical-replay"]);
      for (const m of models) {
        expect(m.version).to.match(/^\d+\.\d+\.\d+$/);
        expect(m.configSchema).to.have.property("type", "object");
      }
      expect(() => getModel("nope")).to.throw(/unknown risk model/);
    });

    it("same seed ⇒ bit-identical paths; different seed ⇒ different paths", () => {
      const { series } = synthHistory("SOL", 0.6, 400, 1);
      const model = new GbmModel();
      const params = model.calibrate([series], { driftMode: "zero" });
      const grid = { horizonSteps: 20, stepSeconds: WEEK, nPaths: 50, seed: 7 };
      const a = model.simulatePaths(params, grid);
      const b = model.simulatePaths(params, grid);
      expect(a).to.deep.equal(b);
      const c = model.simulatePaths(params, { ...grid, seed: 8 });
      expect(c.prices[0][0][20]).to.not.equal(a.prices[0][0][20]);
    });
  });

  describe("GBM model", () => {
    it("terminal log-price moments match theory (zero drift)", () => {
      const sigma = 0.6;
      const { series } = synthHistory("SOL", sigma, 500, 2);
      const model = new GbmModel();
      const params = model.calibrate([series], {
        driftMode: "zero",
        sigmaOverride: [sigma],
      });
      // One 1-year step, many paths → sharp statistical test.
      const paths = model.simulatePaths(params, {
        horizonSteps: 1,
        stepSeconds: SECONDS_PER_YEAR,
        nPaths: 50_000,
        seed: 3,
      });
      const s0 = params.s0[0];
      const logs = paths.prices[0].map((path) => Math.log(path[1] / s0));
      const mean = logs.reduce((s, v) => s + v, 0) / logs.length;
      const std = Math.sqrt(
        logs.reduce((s, v) => s + (v - mean) ** 2, 0) / (logs.length - 1),
      );
      const se = sigma / Math.sqrt(logs.length);
      expect(mean).to.be.closeTo(-0.5 * sigma * sigma, 4 * se); // −σ²/2
      expect(std).to.be.closeTo(sigma, sigma * 0.02);
    });

    it("calibration recovers sigma from history within tolerance", () => {
      const sigma = 0.8;
      const { series } = synthHistory("SOL", sigma, 3000, 4);
      const params = new GbmModel().calibrate([series], { driftMode: "zero" });
      expect(params.sigma[0]).to.be.closeTo(sigma, 0.06);
    });

    it("preserves cross-asset correlation (ρ≈0.7 fixture)", () => {
      const a = synthHistory("SOL", 0.6, 1500, 5);
      const b = synthHistory("ETH", 0.5, 1500, 6, a.shocks, 0.7);
      const model = new GbmModel();
      const params = model.calibrate([a.series, b.series], { driftMode: "zero" });
      const paths = model.simulatePaths(params, {
        horizonSteps: 10,
        stepSeconds: DAY,
        nPaths: 3000,
        seed: 9,
      });
      // Pool step returns across paths/steps.
      const ra: number[] = [];
      const rb: number[] = [];
      for (let p = 0; p < paths.nPaths; p++) {
        for (let s = 1; s < paths.steps; s++) {
          ra.push(Math.log(paths.prices[0][p][s] / paths.prices[0][p][s - 1]));
          rb.push(Math.log(paths.prices[1][p][s] / paths.prices[1][p][s - 1]));
        }
      }
      const histCorr = 0.7;
      expect(corr(ra, rb)).to.be.closeTo(histCorr, 0.06);
    });
  });

  describe("Empirical bootstrap model", () => {
    it("iid mode preserves marginal std and joint correlation of history", () => {
      const a = synthHistory("SOL", 0.7, 800, 11);
      const b = synthHistory("ETH", 0.5, 800, 12, a.shocks, 0.6);
      const model = new EmpiricalBootstrapModel();
      const params = model.calibrate([a.series, b.series], { mode: "iid" });
      const paths = model.simulatePaths(params, {
        horizonSteps: 30,
        stepSeconds: DAY,
        nPaths: 1500,
        seed: 13,
      });

      const histA = params.returns.map((v) => v[0]);
      const histB = params.returns.map((v) => v[1]);
      const simA: number[] = [];
      const simB: number[] = [];
      for (let p = 0; p < paths.nPaths; p++) {
        for (let s = 1; s < paths.steps; s++) {
          simA.push(Math.log(paths.prices[0][p][s] / paths.prices[0][p][s - 1]));
          simB.push(Math.log(paths.prices[1][p][s] / paths.prices[1][p][s - 1]));
        }
      }
      const std = (xs: number[]) => {
        const m = xs.reduce((s, v) => s + v, 0) / xs.length;
        return Math.sqrt(xs.reduce((s, v) => s + (v - m) ** 2, 0) / (xs.length - 1));
      };
      expect(std(simA)).to.be.closeTo(std(histA), std(histA) * 0.1);
      expect(std(simB)).to.be.closeTo(std(histB), std(histB) * 0.1);
      expect(corr(simA, simB)).to.be.closeTo(corr(histA, histB), 0.1);
    });

    it("block mode is deterministic and refuses a mismatched grid step", () => {
      const { series } = synthHistory("SOL", 0.6, 200, 14);
      const model = new EmpiricalBootstrapModel();
      const params = model.calibrate([series], { mode: "block", blockLength: 5 });
      const grid = { horizonSteps: 26, stepSeconds: DAY, nPaths: 100, seed: 15 };
      expect(model.simulatePaths(params, grid)).to.deep.equal(
        model.simulatePaths(params, grid),
      );
      expect(() =>
        model.simulatePaths(params, { ...grid, stepSeconds: WEEK }),
      ).to.throw(/must equal the historical/);
    });
  });

  describe("Portfolio Monte-Carlo engine", () => {
    // SOL/USDC-like position (same fixture as @lh/portfolio tests).
    const POSITION: SimPosition = {
      assetId: "SOL",
      liquidity: 1_000_000_000_000n,
      tickLower: -20000,
      tickUpper: -18000,
      decimalsA: 9,
      decimalsB: 6,
    };

    function runPaths(sigma: number, seed: number, nPaths = 2000) {
      const { series } = synthHistory("SOL", sigma, 400, seed);
      // Rebase history so S0 ≈ 150 (inside the position's range).
      const scale = 150 / series.closes[series.closes.length - 1];
      series.closes = series.closes.map((c) => c * scale);
      const model = new GbmModel();
      const params = model.calibrate([series], {
        driftMode: "zero",
        sigmaOverride: [sigma],
      });
      return model.simulatePaths(params, {
        horizonSteps: 1,
        stepSeconds: 7 * DAY,
        nPaths,
        seed,
      });
    }

    it("fan quantiles are ordered and start at the initial value", () => {
      const report = simulatePortfolio(runPaths(0.65, 21), [POSITION]);
      for (let s = 0; s < report.fan.p50.length; s++) {
        expect(report.fan.p05[s]).to.be.at.most(report.fan.p25[s]);
        expect(report.fan.p25[s]).to.be.at.most(report.fan.p50[s]);
        expect(report.fan.p50[s]).to.be.at.most(report.fan.p75[s]);
        expect(report.fan.p75[s]).to.be.at.most(report.fan.p95[s]);
      }
      expect(report.fan.p50[0]).to.be.closeTo(report.initialValue, 1e-9);
      expect(report.terminal.cvar5).to.be.at.most(report.terminal.var5);
      expect(report.maxDrawdown.p95).to.be.at.least(0);
      expect(report.pExitRange).to.be.within(0, 1);
    });

    it("near-zero vol ⇒ flat value, no losses, no range exits", () => {
      const report = simulatePortfolio(runPaths(0.0001, 22, 500), [POSITION]);
      expect(report.terminal.std).to.be.lessThan(report.initialValue * 1e-3);
      expect(report.pExitRange).to.equal(0);
      expect(report.terminal.pLoss).to.be.lessThan(0.6); // concavity drag only
      expect(Math.abs(report.terminal.mean)).to.be.lessThan(
        report.initialValue * 1e-4,
      );
    });

    it("hedge overlay: exact IL replication in-corridor ⇒ hedged variance collapses", () => {
      const paths = runPaths(0.65, 23);
      const hedged = simulatePortfolio(paths, [
        { ...POSITION, hedge: { premiumUsd: 0 } },
      ]);
      const unhedged = simulatePortfolio(paths, [POSITION]);
      expect(hedged.hedgedTerminal).to.not.equal(null);
      expect(unhedged.hedgedTerminal).to.equal(null);
      // Within the corridor the payoff cancels value moves exactly; outside
      // it is capped — so hedged std must be far below unhedged std.
      expect(hedged.hedgedTerminal!.std).to.be.lessThan(unhedged.terminal.std * 0.5);
      // With zero premium the hedged terminal can never sit below −Cap_up
      // relative to entry (bounded loss).
      expect(hedged.hedgedTerminal!.var5).to.be.greaterThan(unhedged.terminal.var5);
    });

    it("premium shifts the hedged distribution down by exactly the premium", () => {
      const paths = runPaths(0.65, 24, 500);
      const free = simulatePortfolio(paths, [{ ...POSITION, hedge: { premiumUsd: 0 } }]);
      const paid = simulatePortfolio(paths, [{ ...POSITION, hedge: { premiumUsd: 25 } }]);
      expect(paid.hedgedTerminal!.mean).to.be.closeTo(
        free.hedgedTerminal!.mean - 25,
        1e-9,
      );
    });
  });
});

describe("Historical replay model (backtest mode)", () => {
  const DAY2 = 86_400;
  function series(closes: number[]): AssetSeries {
    return { assetId: "SOL", closes, stepSeconds: DAY2 };
  }
  const model = new (require("../../src/models/historical-replay").HistoricalReplayModel)();

  it("rolling: one rebased path per historical window, deterministic, seed-independent", () => {
    const closes = [100, 110, 99, 104, 114.4, 108, 118.8]; // 6 returns
    const params = model.calibrate([series(closes)], { mode: "rolling" });
    const grid = { horizonSteps: 3, stepSeconds: DAY2, nPaths: 100, seed: 1 };
    const paths = model.simulatePaths(params, grid);
    expect(paths.nPaths).to.equal(4); // 6 − 3 + 1 windows
    // Every path starts at the LAST close (rebased to today).
    for (const p of paths.prices[0]) expect(p[0]).to.equal(118.8);
    // First window replays returns of steps 0..2: ×1.1, ×0.9, ×(104/99).
    const w0 = paths.prices[0][0];
    expect(w0[1]).to.be.closeTo(118.8 * 1.1, 1e-9);
    expect(w0[2]).to.be.closeTo(118.8 * 1.1 * 0.9, 1e-9);
    expect(w0[3]).to.be.closeTo(118.8 * 1.1 * 0.9 * (104 / 99), 1e-9);
    // Seed must not matter (deterministic).
    expect(model.simulatePaths(params, { ...grid, seed: 999 })).to.deep.equal(paths);
  });

  it("latest: exactly one path replaying the most recent horizon", () => {
    const closes = [100, 110, 99, 104, 114.4];
    const params = model.calibrate([series(closes)], { mode: "latest" });
    const paths = model.simulatePaths(params, {
      horizonSteps: 2, stepSeconds: DAY2, nPaths: 50, seed: 1,
    });
    expect(paths.nPaths).to.equal(1);
    const p = paths.prices[0][0];
    expect(p[0]).to.equal(114.4);
    expect(p[1]).to.be.closeTo(114.4 * (104 / 99), 1e-9);
    expect(p[2]).to.be.closeTo(114.4 * (104 / 99) * (114.4 / 104), 1e-9);
  });

  it("refuses horizon longer than history and mismatched grid step", () => {
    const params = model.calibrate([series([100, 101, 102])], { mode: "rolling" });
    expect(() =>
      model.simulatePaths(params, { horizonSteps: 5, stepSeconds: DAY2, nPaths: 10, seed: 1 }),
    ).to.throw(/window too short/);
    expect(() =>
      model.simulatePaths(params, { horizonSteps: 1, stepSeconds: 604_800, nPaths: 10, seed: 1 }),
    ).to.throw(/must equal/);
  });

  it("thins evenly when windows exceed the path budget", () => {
    const closes = Array.from({ length: 201 }, (_, i) => 100 * Math.exp(0.001 * i));
    const params = model.calibrate([series(closes)], { mode: "rolling" });
    const paths = model.simulatePaths(params, {
      horizonSteps: 10, stepSeconds: DAY2, nPaths: 50, seed: 1,
    });
    expect(paths.nPaths).to.equal(50);
  });

  it("appears in the registry with a JSON-Schema config (UI auto-renders it)", () => {
    const ids = listModels().map((m) => m.id);
    expect(ids).to.include("historical-replay");
    expect(() => getModel("historical-replay")).to.not.throw();
  });
});

describe("Composable yield (value / value+yield / yield-only)", () => {
  const DAY3 = 86_400;
  const POS = {
    assetId: "SOL",
    liquidity: 1_000_000_000_000n,
    tickLower: -20000,
    tickUpper: -18000,
    decimalsA: 9,
    decimalsB: 6,
  };
  // Flat constant-price paths: analytic yield check.
  function flatPaths(nDays: number, price = 150, nPaths = 3) {
    return {
      assetIds: ["SOL"],
      nPaths,
      steps: nDays + 1,
      prices: [Array.from({ length: nPaths }, () => Array(nDays + 1).fill(price))],
    };
  }

  it("flat in-range path: accrued yield = rate × V0 × days exactly; compositions relate correctly", () => {
    const rate = 0.002; // 0.2%/day in range
    const paths = flatPaths(10);
    const base = simulatePortfolio(paths, [POS]);
    const withY = simulatePortfolio(paths, [{ ...POS, yield: { inRangeDailyRate: rate } }],
      { composition: "value+yield", stepSeconds: DAY3 });
    const onlyY = simulatePortfolio(paths, [{ ...POS, yield: { inRangeDailyRate: rate } }],
      { composition: "yield", stepSeconds: DAY3 });

    const expected = rate * base.initialValue * 10;
    expect(onlyY.meanAccruedYieldUsd).to.be.closeTo(expected, expected * 1e-9);
    expect(onlyY.terminal.mean).to.be.closeTo(expected, expected * 1e-9); // baseline 0
    expect(onlyY.terminal.pLoss).to.equal(0);
    expect(withY.terminal.mean).to.be.closeTo(base.terminal.mean + expected, 1e-9);
    expect(base.composition).to.equal("value");
    expect(base.meanAccruedYieldUsd).to.equal(0);
  });

  it("out-of-range path accrues nothing", () => {
    const paths = flatPaths(10, 200); // above the range → all USDC, no fees
    const r = simulatePortfolio(paths, [{ ...POS, yield: { inRangeDailyRate: 0.002 } }],
      { composition: "yield", stepSeconds: DAY3 });
    expect(r.meanAccruedYieldUsd).to.equal(0);
    expect(r.terminal.mean).to.equal(0);
  });

  it("hedged value+yield: fee split shaves yield, premium is a cash cost", () => {
    const rate = 0.002;
    const paths = flatPaths(10);
    const r = simulatePortfolio(
      paths,
      [{ ...POS, yield: { inRangeDailyRate: rate }, hedge: { premiumUsd: 1, feeSplitRate: 0.1 } }],
      { composition: "value+yield", stepSeconds: DAY3 },
    );
    const grossYield = rate * r.initialValue * 10;
    // Flat path: payoff = 0, so hedged = unhedged − 0.1×yield − premium.
    expect(r.hedgedTerminal!.mean).to.be.closeTo(
      r.terminal.mean - 0.1 * grossYield - 1,
      1e-9,
    );
  });

  it("guards: yield composition without yield config, and missing stepSeconds, throw", () => {
    const paths = flatPaths(5);
    expect(() => simulatePortfolio(paths, [POS], { composition: "yield" })).to.throw(
      /requires at least one position/,
    );
    expect(() =>
      simulatePortfolio(paths, [{ ...POS, yield: { inRangeDailyRate: 0.001 } }]),
    ).to.throw(/stepSeconds required/);
  });
});

describe("Stochastic fee intensity (block bootstrap of r_pool)", () => {
  const { calibrateFeeIntensity, sampleRatePaths } = require("../../src/models/fee-intensity");
  // 120 days: calm regime ~0.05%/day, turbulent regime ~0.20%/day, alternating 10-day spells.
  // i·1e-9 makes every value unique so the contiguity check can recover
  // indices unambiguously (regime spells would otherwise repeat values).
  const HISTORY: number[] = Array.from({ length: 120 }, (_, i) =>
    (Math.floor(i / 10) % 2 === 0 ? 0.0005 + 0.00001 * (i % 10) : 0.002 + 0.00002 * (i % 10)) +
    i * 1e-9,
  );

  it("calibration computes the mean and refuses short history", () => {
    const params = calibrateFeeIntensity(HISTORY);
    expect(params.meanRate).to.be.closeTo(
      HISTORY.reduce((s: number, r: number) => s + r, 0) / HISTORY.length, 1e-12);
    expect(() => calibrateFeeIntensity(HISTORY.slice(0, 30))).to.throw(/needs ≥60/);
  });

  it("sampled paths preserve the historical mean, are seed-deterministic, and use contiguous blocks", () => {
    const params = calibrateFeeIntensity(HISTORY, { blockLength: 7 });
    const grid = { nPaths: 400, steps: 56, seed: 9 };
    const a = sampleRatePaths(params, grid);
    expect(sampleRatePaths(params, grid)).to.deep.equal(a); // deterministic
    const all: number[] = a.flat();
    const mean = all.reduce((s, r) => s + r, 0) / all.length;
    expect(mean).to.be.closeTo(params.meanRate, params.meanRate * 0.05);
    // Block persistence: within a block, consecutive sampled values must be
    // consecutive in history (regime spells survive, unlike IID sampling).
    const idx = (v: number) => HISTORY.findIndex((h) => Math.abs(h - v) < 1e-15);
    let contiguous = 0, checked = 0;
    for (let s = 0; s + 1 < 14; s++) {
      const i1 = idx(a[0][s]), i2 = idx(a[0][s + 1]);
      if (i1 >= 0 && i2 >= 0) { checked++; if (i2 === (i1 + 1) % HISTORY.length || s % 7 === 6) contiguous++; }
    }
    expect(checked).to.be.greaterThan(8);
    expect(contiguous).to.equal(checked);
  });

  it("rescaleToMean pins the level while keeping fluctuations", () => {
    const params = calibrateFeeIntensity(HISTORY);
    const target = 0.003;
    const a = sampleRatePaths(params, { nPaths: 200, steps: 30, seed: 4 }, { rescaleToMean: target });
    const all: number[] = a.flat();
    const mean = all.reduce((s, r) => s + r, 0) / all.length;
    expect(mean).to.be.closeTo(target, target * 0.05);
    expect(Math.max(...all)).to.be.greaterThan(Math.min(...all)); // still stochastic
  });

  it("engine consumes ratePaths: constant-valued paths ≡ constant rate; dims are validated", () => {
    const POS2 = {
      assetId: "SOL", liquidity: 1_000_000_000_000n,
      tickLower: -20000, tickUpper: -18000, decimalsA: 9, decimalsB: 6,
    };
    const flat = {
      assetIds: ["SOL"], nPaths: 3, steps: 11,
      prices: [Array.from({ length: 3 }, () => Array(11).fill(150))],
    };
    const rate = 0.002;
    const constPaths = Array.from({ length: 3 }, () => Array(10).fill(rate));
    const viaPaths = simulatePortfolio(flat, [{ ...POS2, yield: { inRangeDailyRate: 0, ratePaths: constPaths } }],
      { composition: "yield", stepSeconds: 86_400 });
    const viaConst = simulatePortfolio(flat, [{ ...POS2, yield: { inRangeDailyRate: rate } }],
      { composition: "yield", stepSeconds: 86_400 });
    expect(viaPaths.terminal.mean).to.be.closeTo(viaConst.terminal.mean, 1e-9);
    expect(() =>
      simulatePortfolio(flat, [{ ...POS2, yield: { inRangeDailyRate: 0, ratePaths: [Array(10).fill(rate)] } }],
        { composition: "yield", stepSeconds: 86_400 }),
    ).to.throw(/ratePaths must be/);
  });
});
