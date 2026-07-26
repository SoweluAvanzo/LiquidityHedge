/**
 * Hero figure — the one drawing that explains both halves of the product.
 *
 * Top panel: 24 hours of pool price sampled every 15 minutes, against an
 * explicit range [p_l, p_u]. Bottom panel: the fee accumulator, which is a
 * staircase, not a curve — it steps once per snapshot and only while the
 * price sits inside the range. The shaded columns mark the excursions
 * where accrual stops.
 *
 * The geometry is a fixed schematic (a seeded random walk, rendered once
 * and inlined) — not live data, and the caption says so. Inline SVG only:
 * the CSP forbids any external asset.
 */

const PRICE_PATH =
  "8,91.53 14.57,106.86 21.14,90.8 27.71,89.54 34.27,110.68 40.84,92.81 47.41,92.17 53.98,78.84 60.55,78.38 67.12,85.17 73.68,92.56 80.25,86.41 86.82,118.85 93.39,114.88 99.96,106.93 106.53,74.36 113.09,101.13 119.66,82.61 126.23,62.08 132.8,78.39 139.37,41.51 145.94,46.48 152.51,39.35 159.07,53.75 165.64,47.05 172.21,47.58 178.78,58.1 185.35,57.29 191.92,56.64 198.48,63.88 205.05,89.54 211.62,79.02 218.19,81.93 224.76,76.34 231.33,92.29 237.89,108.33 244.46,109.51 251.03,98.06 257.6,71.72 264.17,96.04 270.74,91.82 277.31,91.09 283.87,114.8 290.44,104.55 297.01,118.75 303.58,130.94 310.15,150.37 316.72,167.15 323.28,148.03 329.85,169.12 336.42,161.38 342.99,138.63 349.56,122.84 356.13,126.68 362.69,154.29 369.26,148.66 375.83,156.83 382.4,186.65 388.97,183.1 395.54,158.2 402.11,153.48 408.67,151.92 415.24,181.14 421.81,171.3 428.38,160.26 434.95,135.16 441.52,134.17 448.08,117.64 454.65,92.47 461.22,88.64 467.79,96.71 474.36,121.51 480.93,110.44 487.49,124.21 494.06,109.88 500.63,91.88 507.2,89.54 513.77,101.53 520.34,67.04 526.91,65.37 533.47,82.94 540.04,88.42 546.61,106.74 553.18,89.36 559.75,80.45 566.32,83.59 572.88,77.68 579.45,111.8 586.02,98.99 592.59,89.57 599.16,72.49 605.73,89.7 612.29,84.9 618.86,80.85 625.43,88.96 632,107.17";

const ACCUMULATOR_PATH =
  "M 8 352 H 14.57 V 350.78 H 21.14 V 349.58 H 27.71 V 347.73 H 34.27 V 346.38 H 40.84 V 344.81 H 47.41 V 343.43 H 53.98 V 341.54 H 60.55 V 340.19 H 67.12 V 338.58 H 73.68 V 337.26 H 80.25 V 335.42 H 86.82 V 334.19 H 93.39 V 332.63 H 99.96 V 331.08 H 106.53 V 329.81 H 113.09 V 328.53 H 119.66 V 327.32 H 126.23 V 325.49 H 132.8 V 323.93 H 139.37 V 323.93 H 145.94 V 323.93 H 152.51 V 323.93 H 159.07 V 323.93 H 165.64 V 323.93 H 172.21 V 323.93 H 178.78 V 322.72 H 185.35 V 320.94 H 191.92 V 319.42 H 198.48 V 317.8 H 205.05 V 316.35 H 211.62 V 314.59 H 218.19 V 312.92 H 224.76 V 311.28 H 231.33 V 309.67 H 237.89 V 308.04 H 244.46 V 306.89 H 251.03 V 305.7 H 257.6 V 304.42 H 264.17 V 302.74 H 270.74 V 301.26 H 277.31 V 299.61 H 283.87 V 298.22 H 290.44 V 296.94 H 297.01 V 295.64 H 303.58 V 295.64 H 310.15 V 295.64 H 316.72 V 295.64 H 323.28 V 295.64 H 329.85 V 295.64 H 336.42 V 295.64 H 342.99 V 295.64 H 349.56 V 294.14 H 356.13 V 292.75 H 362.69 V 292.75 H 369.26 V 292.75 H 375.83 V 292.75 H 382.4 V 292.75 H 388.97 V 292.75 H 395.54 V 292.75 H 402.11 V 292.75 H 408.67 V 292.75 H 415.24 V 292.75 H 421.81 V 292.75 H 428.38 V 292.75 H 434.95 V 292.75 H 441.52 V 292.75 H 448.08 V 291.22 H 454.65 V 289.87 H 461.22 V 288.27 H 467.79 V 286.74 H 474.36 V 285.44 H 480.93 V 284.06 H 487.49 V 282.83 H 494.06 V 281.37 H 500.63 V 279.85 H 507.2 V 278.01 H 513.77 V 276.56 H 520.34 V 275.19 H 526.91 V 273.85 H 533.47 V 272.07 H 540.04 V 270.53 H 546.61 V 269.04 H 553.18 V 267.91 H 559.75 V 266.77 H 566.32 V 264.97 H 572.88 V 263.18 H 579.45 V 261.51 H 586.02 V 260.28 H 592.59 V 258.68 H 599.16 V 257.14 H 605.73 V 255.64 H 612.29 V 253.78 H 618.86 V 252.63 H 625.43 V 251.17 H 632 V 250";

/**
 * Windows where the price left the range and accrual stopped. Each spans
 * from the last in-range sample to the last out-of-range one, so it lines
 * up with the flat run in the accumulator below.
 */
const EXCURSIONS = [
  { x: 132.8, w: 39.41 },
  { x: 297.01, w: 45.98 },
  { x: 356.13, w: 85.39 },
];

const MINOR_TICKS =
  "M 14.57 356 V 361 M 21.14 356 V 361 M 27.71 356 V 361 M 34.27 356 V 361 M 40.84 356 V 361 M 47.41 356 V 361 M 53.98 356 V 361 M 67.12 356 V 361 M 73.68 356 V 361 M 80.25 356 V 361 M 86.82 356 V 361 M 93.39 356 V 361 M 99.96 356 V 361 M 106.53 356 V 361 M 119.66 356 V 361 M 126.23 356 V 361 M 132.8 356 V 361 M 139.37 356 V 361 M 145.94 356 V 361 M 152.51 356 V 361 M 159.07 356 V 361 M 172.21 356 V 361 M 178.78 356 V 361 M 185.35 356 V 361 M 191.92 356 V 361 M 198.48 356 V 361 M 205.05 356 V 361 M 211.62 356 V 361 M 224.76 356 V 361 M 231.33 356 V 361 M 237.89 356 V 361 M 244.46 356 V 361 M 251.03 356 V 361 M 257.6 356 V 361 M 264.17 356 V 361 M 277.31 356 V 361 M 283.87 356 V 361 M 290.44 356 V 361 M 297.01 356 V 361 M 303.58 356 V 361 M 310.15 356 V 361 M 316.72 356 V 361 M 329.85 356 V 361 M 336.42 356 V 361 M 342.99 356 V 361 M 349.56 356 V 361 M 356.13 356 V 361 M 362.69 356 V 361 M 369.26 356 V 361 M 382.4 356 V 361 M 388.97 356 V 361 M 395.54 356 V 361 M 402.11 356 V 361 M 408.67 356 V 361 M 415.24 356 V 361 M 421.81 356 V 361 M 434.95 356 V 361 M 441.52 356 V 361 M 448.08 356 V 361 M 454.65 356 V 361 M 461.22 356 V 361 M 467.79 356 V 361 M 474.36 356 V 361 M 487.49 356 V 361 M 494.06 356 V 361 M 500.63 356 V 361 M 507.2 356 V 361 M 513.77 356 V 361 M 520.34 356 V 361 M 526.91 356 V 361 M 540.04 356 V 361 M 546.61 356 V 361 M 553.18 356 V 361 M 559.75 356 V 361 M 566.32 356 V 361 M 572.88 356 V 361 M 579.45 356 V 361 M 592.59 356 V 361 M 599.16 356 V 361 M 605.73 356 V 361 M 612.29 356 V 361 M 618.86 356 V 361 M 625.43 356 V 361 M 632 356 V 361";

const MAJOR_TICKS =
  "M 8 356 V 364 M 60.55 356 V 364 M 113.09 356 V 364 M 165.64 356 V 364 M 218.19 356 V 364 M 270.74 356 V 364 M 323.28 356 V 364 M 375.83 356 V 364 M 428.38 356 V 364 M 480.93 356 V 364 M 533.47 356 V 364 M 586.02 356 V 364";

const BAND_TOP = 54.13;
const BAND_HEIGHT = 74.8;
const BAND_BOTTOM = BAND_TOP + BAND_HEIGHT;

export function CorridorFigure() {
  return (
    <figure className="lp-figure">
      <div className="lp-figure-head">
        <span className="lp-figure-title">
          Fee accrual inside a range — schematic
        </span>
        <span className="lp-key">
          <span>
            <span
              className="lp-swatch"
              style={{ background: "var(--lp-range-graphic)" }}
              aria-hidden="true"
            />
            price
          </span>
          <span>
            <span
              className="lp-swatch"
              style={{ background: "var(--lp-accrue-graphic)" }}
              aria-hidden="true"
            />
            fee growth
          </span>
        </span>
      </div>

      <svg
        viewBox="0 0 640 372"
        role="img"
        aria-labelledby="lp-fig-title lp-fig-desc"
        preserveAspectRatio="xMidYMid meet"
      >
        <title id="lp-fig-title">
          Pool price against a liquidity range, and the fee accumulator beneath it
        </title>
        <desc id="lp-fig-desc">
          A schematic of one day of pool price sampled every fifteen minutes,
          drawn against a shaded range with bounds labelled p sub u and p sub l.
          Below it, the cumulative fee-growth accumulator rises in discrete steps
          while the price is inside the range and stays flat during the four
          shaded excursions where the price leaves it.
        </desc>

        <defs>
          <clipPath id="lp-corridor-clip">
            <rect x="8" y={BAND_TOP} width="624" height={BAND_HEIGHT} />
          </clipPath>
        </defs>

        {/* Excursion columns — where the price is out of range, nothing accrues. */}
        {EXCURSIONS.map((e) => (
          <rect
            key={e.x}
            x={e.x}
            y="28"
            width={e.w}
            height="324"
            fill="var(--lp-ink-3)"
            opacity="0.08"
          />
        ))}

        {/* ── price panel ── */}
        <text x="8" y="16" className="lp-fig-label">
          Pool price · 15-min samples
        </text>

        <rect
          x="8"
          y={BAND_TOP}
          width="624"
          height={BAND_HEIGHT}
          fill="var(--lp-range-wash)"
        />
        <line
          x1="8"
          y1={BAND_TOP}
          x2="632"
          y2={BAND_TOP}
          stroke="var(--lp-range-graphic)"
          strokeWidth="1"
          strokeDasharray="4 3"
        />
        <line
          x1="8"
          y1={BAND_BOTTOM}
          x2="632"
          y2={BAND_BOTTOM}
          stroke="var(--lp-range-graphic)"
          strokeWidth="1"
          strokeDasharray="4 3"
        />
        <text x="10" y={BAND_TOP - 5} className="lp-fig-tag">
          p_u
        </text>
        <text x="10" y={BAND_BOTTOM + 12} className="lp-fig-tag">
          p_l
        </text>

        <polyline
          points={PRICE_PATH}
          fill="none"
          stroke="var(--lp-ink-3)"
          strokeWidth="1.1"
          strokeLinejoin="round"
          opacity="0.5"
        />
        <polyline
          points={PRICE_PATH}
          fill="none"
          stroke="var(--lp-range-graphic)"
          strokeWidth="1.7"
          strokeLinejoin="round"
          clipPath="url(#lp-corridor-clip)"
        />

        <text x="398.8" y="44" textAnchor="middle" className="lp-fig-note">
          out of range → nothing accrues
        </text>

        {/* ── accumulator panel ── */}
        <line
          x1="8"
          y1="216"
          x2="632"
          y2="216"
          stroke="var(--lp-rule)"
          strokeWidth="1"
        />
        <text x="8" y="238" className="lp-fig-label">
          feeGrowthGlobal · cumulative fees per unit of liquidity
        </text>

        <path
          d={`${ACCUMULATOR_PATH} V 352 H 8 Z`}
          fill="var(--lp-accrue-wash)"
          stroke="none"
        />
        <path
          className="lp-acc-line"
          d={ACCUMULATOR_PATH}
          fill="none"
          stroke="var(--lp-accrue-graphic)"
          strokeWidth="1.7"
          strokeLinejoin="miter"
        />

        {/* ── sampling ruler ── */}
        <line
          x1="8"
          y1="356"
          x2="632"
          y2="356"
          stroke="var(--lp-rule-strong)"
          strokeWidth="1"
        />
        <path d={MINOR_TICKS} stroke="var(--lp-rule)" strokeWidth="1" />
        <path d={MAJOR_TICKS} stroke="var(--lp-rule-strong)" strokeWidth="1" />
      </svg>

      <figcaption className="lp-figcaption">
        Schematic, not live data. Fee growth is a step function: it advances only
        while the price sits inside a range, and by an amount that already
        accounts for the competing liquidity active at that tick. That is why a
        record of the accumulator is enough to price any range — one you held,
        or one you are only considering.
      </figcaption>
    </figure>
  );
}
