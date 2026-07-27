/**
 * The standard normal CDF — ONE implementation, for the whole workspace.
 *
 * There were previously two. `risk-models/stats/correlation.ts` had a
 * correct one; `market-data/orca-volume-adapter.ts` had a second copy that
 * conflated two different approximations and returned Φ(0) = 0.601 instead
 * of 0.5, overstating the GBM in-range fraction by 40–77% wherever the
 * empirical estimator was unavailable. That is the entire reason this
 * lives in one place now: a duplicated numerical primitive is a primitive
 * that will drift.
 *
 * Method: Abramowitz & Stegun 7.1.26 approximates **erf**, so Φ must be
 * assembled as Φ(x) = ½·(1 + erf(x/√2)). Both the √2 scaling of the
 * argument AND the ½(1+·) wrapper are required — dropping either is what
 * produced the earlier defect. |error| < 1.5e-7 over the whole real line.
 */

/** Gauss error function, A&S 7.1.26. |error| < 1.5e-7. */
export function erf(x: number): number {
  // A&S 7.1.26 leaves a ~1e-9 residual at 0 (its coefficients sum to
  // 0.999999999); pinning the origin makes Phi(0) exactly 0.5 and keeps
  // the symmetry identity Phi(-x) = 1 - Phi(x) exact there.
  if (x === 0) return 0;
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * z);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) *
      t +
      0.254829592) *
      t *
      Math.exp(-z * z);
  return sign * y;
}

/** Standard normal CDF. Φ(0) = 0.5 exactly, by construction. */
export function normalCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}
