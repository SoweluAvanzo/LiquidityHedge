/**
 * Hero figure — one idea, no decoding required.
 *
 * A concentrated-liquidity position is a band. The price wanders through
 * it, sometimes leaves it, sometimes comes back. That is the whole subject
 * of both products, and it is the whole content of this drawing: the band,
 * the path, and the regular sampling marks that say we are watching it on
 * a clock.
 *
 * It replaced a two-panel teaching schematic (price + fee accumulator,
 * with shaded excursion columns) that was accurate and unreadable at a
 * glance — a figure for a paper, not a hero. Anything that needs a legend
 * to parse belongs further down the page, not above the fold.
 *
 * The geometry is a fixed, composed shape — a sum of sinusoids evaluated
 * once and inlined, not random and not live data. Inline SVG only: the CSP
 * forbids any external asset.
 */

const BAND_TOP = 110;
const BAND_BOTTOM = 250;
const X0 = 16;
const X1 = 624;

const PATH =
  "16,190.6 28.67,189.42 41.33,192.31 54,195.62 66.67,192.74 79.33,180.98 92,165.63 104.67,156.32 117.33,158.65 130,168.92 142.67,177.04 155.33,174.89 168,162.24 180.67,145.13 193.33,129.12 206,114.63 218.67,99.13 231.33,83.03 244,72.4 256.67,74.85 269.33,92.13 282,117.11 294.67,138.76 307.33,150.85 320,156.39 332.67,163.79 345.33,178.72 358,199.58 370.67,220.34 383.33,237.22 396,251.71 408.67,266.98 421.33,281.89 434,289.48 446.67,282.52 459.33,260.96 472,233.72 484.67,212.6 497.33,203.49 510,203.11 522.67,203.64 535.33,200.45 548,195.25 560.67,192.15 573.33,191.68 586,189.38 598.67,180.91 611.33,167.93 624,158.26";

/** Every third sample — enough to read as a cadence without crowding. */
const SAMPLES: Array<[number, number]> = [
  [16, 190.6],
  [54, 195.62],
  [92, 165.63],
  [130, 168.92],
  [168, 162.24],
  [206, 114.63],
  [244, 72.4],
  [282, 117.11],
  [320, 156.39],
  [358, 199.58],
  [396, 251.71],
  [434, 289.48],
  [472, 233.72],
  [510, 203.11],
  [548, 195.25],
  [586, 189.38],
  [624, 158.26],
];

const inBand = (y: number) => y >= BAND_TOP && y <= BAND_BOTTOM;

export function RangeFigure() {
  return (
    <figure className="lp-figure">
      <svg
        viewBox="0 0 640 360"
        role="img"
        aria-labelledby="lp-fig-title lp-fig-desc"
        preserveAspectRatio="xMidYMid meet"
      >
        <title id="lp-fig-title">
          A concentrated-liquidity range, and a price path moving through it
        </title>
        <desc id="lp-fig-desc">
          A horizontal shaded band represents the price range a
          concentrated-liquidity position is committed to. A line traces the
          market price across the band from left to right, drawn boldly while
          it sits inside the range and faintly during the two stretches where
          it leaves — once above the band and once below. Evenly spaced marks
          along the line indicate that the price is sampled at a regular
          interval.
        </desc>

        <defs>
          <clipPath id="lp-band-clip">
            <rect
              x={X0}
              y={BAND_TOP}
              width={X1 - X0}
              height={BAND_BOTTOM - BAND_TOP}
            />
          </clipPath>
        </defs>

        {/* The range itself. */}
        <rect
          x={X0}
          y={BAND_TOP}
          width={X1 - X0}
          height={BAND_BOTTOM - BAND_TOP}
          fill="var(--lp-range-wash)"
          rx="2"
        />
        <line
          x1={X0}
          y1={BAND_TOP}
          x2={X1}
          y2={BAND_TOP}
          stroke="var(--lp-range-graphic)"
          strokeWidth="1"
          strokeDasharray="5 4"
          opacity="0.75"
        />
        <line
          x1={X0}
          y1={BAND_BOTTOM}
          x2={X1}
          y2={BAND_BOTTOM}
          stroke="var(--lp-range-graphic)"
          strokeWidth="1"
          strokeDasharray="5 4"
          opacity="0.75"
        />

        {/* The path: ghosted throughout, solid only where it is in range. */}
        <polyline
          points={PATH}
          fill="none"
          stroke="var(--lp-ink-3)"
          strokeWidth="1.4"
          strokeLinejoin="round"
          strokeLinecap="round"
          opacity="0.28"
        />
        <polyline
          className="lp-band-line"
          points={PATH}
          fill="none"
          stroke="var(--lp-range-graphic)"
          strokeWidth="2.2"
          strokeLinejoin="round"
          strokeLinecap="round"
          clipPath="url(#lp-band-clip)"
        />

        {/* Sampling marks — the cadence, stated visually rather than in prose. */}
        {SAMPLES.map(([x, y]) => (
          <circle
            key={x}
            cx={x}
            cy={y}
            r={inBand(y) ? 2.6 : 2}
            fill={inBand(y) ? "var(--lp-range-graphic)" : "var(--lp-ink-3)"}
            opacity={inBand(y) ? 1 : 0.35}
          />
        ))}

        <text x={X0 + 4} y={BAND_TOP - 9} className="lp-fig-tag">
          position range
        </text>
      </svg>
    </figure>
  );
}
