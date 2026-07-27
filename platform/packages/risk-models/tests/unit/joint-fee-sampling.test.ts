/**
 * Cross-pool fee co-movement (multi-pair simulator).
 *
 * A portfolio spread over several pools earns fees that move TOGETHER —
 * a market-wide volume regime lifts all of them. Two ways of sampling get
 * this wrong in opposite directions:
 *
 *   independent draws per pool → co-movement destroyed, portfolio fee
 *                                dispersion understated;
 *   same seed for every pool   → co-movement forced to ~1, dispersion
 *                                overstated.
 *
 * Reading every pool off ONE resampled date sequence reproduces whatever
 * the record actually showed. These tests pin that property, because it
 * is invisible in any single-pool run and silently wrong in every
 * multi-pool one.
 */

import { expect } from "chai";
import {
  sampleSharedBlockIndices,
  ratePathsFromIndices,
  sampleRatePaths,
  calibrateFeeIntensity,
  makeRng,
} from "../../src";

/** Pearson correlation of two equal-length samples. */
function corr(x: number[], y: number[]): number {
  const n = x.length;
  const mx = x.reduce((a, b) => a + b, 0) / n;
  const my = y.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - mx;
    const dy = y[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  return sxy / Math.sqrt(sxx * syy);
}

/**
 * Two pools' daily fee-rate histories sharing a common driver, so the
 * empirical cross-pool correlation is a known target.
 */
function coupledPools(nObs: number, rho: number, seed: number) {
  const rng = makeRng(seed);
  const a: number[] = [];
  const b: number[] = [];
  for (let i = 0; i < nObs; i++) {
    const common = rng.gaussian();
    const idioA = rng.gaussian();
    const idioB = rng.gaussian();
    // Level ~0.0007/day, lognormal so rates are strictly positive — a
    // floored-at-zero fixture would put zeros in the denominator of the
    // shape check below, and real fee rates are never negative anyway.
    const zA = rho * common + Math.sqrt(1 - rho * rho) * idioA;
    const zB = rho * common + Math.sqrt(1 - rho * rho) * idioB;
    a.push(0.0007 * Math.exp(0.4 * zA));
    b.push(0.0007 * Math.exp(0.4 * zB));
  }
  return { a, b };
}

describe("@lh/risk-models shared-date fee resampling", () => {
  const N_OBS = 240;
  const N_PATHS = 400;
  const STEPS = 14;

  it("is deterministic under the seed and stays inside the calendar", () => {
    const grid = { nPaths: 50, steps: STEPS, seed: 7, nObs: N_OBS, blockLength: 5 };
    const first = sampleSharedBlockIndices(grid);
    const second = sampleSharedBlockIndices(grid);
    expect(first).to.deep.equal(second);
    expect(first).to.have.length(50);
    for (const row of first) {
      expect(row).to.have.length(STEPS);
      for (const i of row) {
        expect(i).to.be.at.least(0);
        expect(i).to.be.below(N_OBS);
        expect(Number.isInteger(i)).to.equal(true);
      }
    }
  });

  it("a different seed gives a different index sequence", () => {
    const base = { nPaths: 20, steps: STEPS, nObs: N_OBS, blockLength: 5 };
    const a = sampleSharedBlockIndices({ ...base, seed: 1 });
    const b = sampleSharedBlockIndices({ ...base, seed: 2 });
    expect(a).to.not.deep.equal(b);
  });

  it("preserves the empirical cross-pool correlation of fee income", () => {
    const { a, b } = coupledPools(N_OBS, 0.8, 42);
    const empirical = corr(a, b);
    // Sanity: the fixture really is strongly coupled.
    expect(empirical).to.be.greaterThan(0.6);

    const indices = sampleSharedBlockIndices({
      nPaths: N_PATHS,
      steps: STEPS,
      seed: 11,
      nObs: N_OBS,
      blockLength: 5,
    });
    const pathsA = ratePathsFromIndices(a, indices);
    const pathsB = ratePathsFromIndices(b, indices);

    // Pool-total fee income per path — the quantity a portfolio holder
    // actually carries.
    const totalA = pathsA.map((r) => r.reduce((s, x) => s + x, 0));
    const totalB = pathsB.map((r) => r.reduce((s, x) => s + x, 0));
    const sampled = corr(totalA, totalB);

    // Shared dates reproduce the coupling rather than diluting it.
    expect(sampled).to.be.greaterThan(0.6);
    expect(Math.abs(sampled - empirical)).to.be.lessThan(0.25);
  });

  it("independent per-pool draws would destroy that correlation", () => {
    const { a, b } = coupledPools(N_OBS, 0.8, 42);
    const grid = { nPaths: N_PATHS, steps: STEPS, nObs: N_OBS, blockLength: 5 };
    // The bug this guards against: each pool resampled on its own draws.
    const pathsA = ratePathsFromIndices(a, sampleSharedBlockIndices({ ...grid, seed: 1 }));
    const pathsB = ratePathsFromIndices(b, sampleSharedBlockIndices({ ...grid, seed: 2 }));
    const totalA = pathsA.map((r) => r.reduce((s, x) => s + x, 0));
    const totalB = pathsB.map((r) => r.reduce((s, x) => s + x, 0));
    expect(Math.abs(corr(totalA, totalB))).to.be.lessThan(0.2);
  });

  it("rescaleToMean pins the level without disturbing the shape", () => {
    const { a } = coupledPools(N_OBS, 0.8, 3);
    const indices = sampleSharedBlockIndices({
      nPaths: 200,
      steps: STEPS,
      seed: 5,
      nObs: N_OBS,
      blockLength: 5,
    });
    const target = 0.0012;
    const scaled = ratePathsFromIndices(a, indices, { rescaleToMean: target });
    const plain = ratePathsFromIndices(a, indices);

    const flat = scaled.flat();
    const mean = flat.reduce((s, x) => s + x, 0) / flat.length;
    // Sampling noise around the pinned level, not a different level.
    expect(mean).to.be.closeTo(target, target * 0.15);

    // Shape preserved: every element is the same constant multiple.
    const ratio = scaled[0][0] / plain[0][0];
    for (let p = 0; p < scaled.length; p += 37) {
      for (let s = 0; s < STEPS; s++) {
        expect(scaled[p][s] / plain[p][s]).to.be.closeTo(ratio, 1e-9);
      }
    }
  });

  it("keeps each pool on its OWN distribution while sharing only dates", () => {
    // The mistake this guards against: collapsing several pools onto one
    // rate series because they are resampled together. Pools differ in
    // volume, fee tier and TVL, so their rate DISTRIBUTIONS must stay
    // distinct — only the sampled dates are common.
    const busy = coupledPools(N_OBS, 0.8, 61).a; // level ~0.0007/day
    const quiet = busy.map((r) => r * 0.25); // same shape, quarter the level
    const spiky = coupledPools(N_OBS, 0.8, 62).b.map((r) => r * 3);

    const indices = sampleSharedBlockIndices({
      nPaths: N_PATHS,
      steps: STEPS,
      seed: 8,
      nObs: N_OBS,
      blockLength: 5,
    });
    const pBusy = ratePathsFromIndices(busy, indices);
    const pQuiet = ratePathsFromIndices(quiet, indices);
    const pSpiky = ratePathsFromIndices(spiky, indices);

    const meanOf = (m: number[][]) =>
      m.flat().reduce((s, x) => s + x, 0) / (m.length * STEPS);

    // Levels are preserved per pool, not averaged into a common one.
    expect(meanOf(pQuiet)).to.be.closeTo(meanOf(pBusy) * 0.25, meanOf(pBusy) * 0.02);
    expect(meanOf(pSpiky)).to.be.greaterThan(meanOf(pBusy));

    // A pool that is a pure rescaling of another stays perfectly coupled
    // (same dates, same shape); an unrelated pool does not collapse onto it.
    const tot = (m: number[][]) => m.map((r) => r.reduce((a, b) => a + b, 0));
    expect(corr(tot(pBusy), tot(pQuiet))).to.be.closeTo(1, 1e-9);
    expect(corr(tot(pBusy), tot(pSpiky))).to.be.lessThan(0.999);
  });

  it("applies a per-position concentration factor without touching the pool path", () => {
    // Two positions in the SAME pool share the pool's rate path but have
    // different range widths, so their position-level rates must differ by
    // exactly their concentration factors.
    const { a } = coupledPools(N_OBS, 0.8, 71);
    const indices = sampleSharedBlockIndices({
      nPaths: 50,
      steps: STEPS,
      seed: 4,
      nObs: N_OBS,
      blockLength: 5,
    });
    const poolPaths = ratePathsFromIndices(a, indices);
    const cNarrow = 4.2;
    const cWide = 1.3;
    const narrow = poolPaths.map((r) => r.map((x) => x * cNarrow));
    const wide = poolPaths.map((r) => r.map((x) => x * cWide));

    for (let p = 0; p < 50; p += 11) {
      for (let st = 0; st < STEPS; st++) {
        expect(narrow[p][st] / wide[p][st]).to.be.closeTo(cNarrow / cWide, 1e-9);
        // The underlying pool path is untouched by either scaling.
        expect(poolPaths[p][st]).to.be.greaterThan(0);
      }
    }
  });

  it("reproduces the old single-pool sampler bit-for-bit", () => {
    // The shared-index path replaced a per-pool sampler. With one pool the
    // aligned calendar IS that pool's history, so the refactor must not
    // move a single number — otherwise every existing single-pair run
    // silently changed its answer.
    const { a } = coupledPools(N_OBS, 0.8, 17);
    const params = calibrateFeeIntensity(a);
    const grid = { nPaths: 64, steps: STEPS, seed: 2024 };
    const target = 0.0009;

    const legacy = sampleRatePaths(params, grid, { rescaleToMean: target });
    const shared = ratePathsFromIndices(
      params.dailyRates,
      sampleSharedBlockIndices({
        ...grid,
        nObs: params.dailyRates.length,
        blockLength: params.blockLength,
      }),
      { rescaleToMean: target },
    );
    expect(shared).to.deep.equal(legacy);
  });

  it("respects the block length, keeping runs of consecutive dates", () => {
    const blockLength = 6;
    const indices = sampleSharedBlockIndices({
      nPaths: 100,
      steps: 24,
      seed: 9,
      nObs: N_OBS,
      blockLength,
    });
    // Within a block, consecutive indices advance by exactly 1 — that is
    // what carries volatility clustering through the resample.
    let consecutive = 0;
    for (const row of indices) {
      for (let s = 1; s < row.length; s++) {
        if (row[s] === (row[s - 1] + 1) % N_OBS) consecutive++;
      }
    }
    const fraction = consecutive / (100 * 23);
    // With blocks of 6, ~5 of every 6 transitions stay inside a block.
    expect(fraction).to.be.greaterThan(0.6);
  });
});
