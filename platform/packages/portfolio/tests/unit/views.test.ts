import { expect } from "chai";
import { PublicKey } from "@solana/web3.js";
import { tickToSqrtPriceX64, sqrtPriceX64ToPrice } from "@lh/core/src/market-data/decoder";
import {
  buildPositionView,
  buildValueCurve,
  aggregatePortfolio,
  priceToSqrtPriceX64,
} from "../../src/views";
import { PortfolioPositionView } from "../../src/types";

// SOL/USDC-like fixture: decimals 9/6, human price ≈ 150 (raw 0.15).
const TICK_CURRENT = -18972; // ≈ $150.0
const TICK_LOWER = -20000; //   ≈ $135.3
const TICK_UPPER = -18000; //   ≈ $165.3
const L = 1_000_000_000_000n; // 10^12

const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const WSOL = new PublicKey("So11111111111111111111111111111111111111112");

function makeFixture(tickCurrent = TICK_CURRENT) {
  const whirlpool = {
    tickSpacing: 64,
    sqrtPrice: tickToSqrtPriceX64(tickCurrent),
    tickCurrentIndex: tickCurrent,
    tokenMintA: WSOL,
    tokenMintB: USDC,
    tokenVaultA: PublicKey.default,
    tokenVaultB: PublicKey.default,
    feeRate: 400,
    liquidity: 10n * L,
    feeGrowthGlobalA: 0n,
    feeGrowthGlobalB: 0n,
  };
  const position = {
    whirlpool: PublicKey.default,
    positionMint: PublicKey.default,
    liquidity: L,
    tickLowerIndex: TICK_LOWER,
    tickUpperIndex: TICK_UPPER,
    feeGrowthCheckpointA: 0n,
    feeOwedA: 7n,
    feeGrowthCheckpointB: 0n,
    feeOwedB: 11n,
  };
  return { whirlpool, position };
}

function view(tickCurrent = TICK_CURRENT): PortfolioPositionView {
  const { whirlpool, position } = makeFixture(tickCurrent);
  return buildPositionView({
    positionAddress: "posAddr",
    position,
    whirlpool,
    whirlpoolAddress: "poolAddr",
    decimalsA: 9,
    decimalsB: 6,
  });
}

describe("@lh/portfolio views", () => {
  it("in-range view: price ≈ 150, both legs held, USDC-quoted, positive value", () => {
    const v = view();
    expect(v.price).to.be.closeTo(150, 1); // tick granularity
    expect(v.priceLower).to.be.closeTo(135.3, 0.5);
    expect(v.priceUpper).to.be.closeTo(165.3, 0.5);
    expect(v.inRange).to.equal(true);
    expect(v.amountA > 0n).to.equal(true);
    expect(v.amountB > 0n).to.equal(true);
    expect(v.isUsdcQuoted).to.equal(true);
    expect(v.valueQuote).to.be.greaterThan(0);
    expect(v.feeOwedA).to.equal(7n);
    expect(v.feeOwedB).to.equal(11n);
  });

  it("token amounts match the closed-form CL formulas (independent float check)", () => {
    const v = view();
    const sf = (t: number) => Math.pow(1.0001, t / 2); // float sqrt(1.0001^t)
    const Lf = Number(L);
    const expectedA = Lf * (1 / sf(TICK_CURRENT) - 1 / sf(TICK_UPPER));
    const expectedB = Lf * (sf(TICK_CURRENT) - sf(TICK_LOWER));
    expect(Number(v.amountA)).to.be.closeTo(expectedA, expectedA * 1e-6);
    expect(Number(v.amountB)).to.be.closeTo(expectedB, expectedB * 1e-6);
  });

  it("below range: all token A; above range: all token B; in-range flags correct", () => {
    const below = view(TICK_LOWER - 500);
    expect(below.inRange).to.equal(false);
    expect(below.amountB).to.equal(0n);
    expect(below.amountA > 0n).to.equal(true);

    const above = view(TICK_UPPER + 500);
    expect(above.inRange).to.equal(false);
    expect(above.amountA).to.equal(0n);
    expect(above.amountB > 0n).to.equal(true);
  });

  it("priceToSqrtPriceX64 roundtrips through sqrtPriceX64ToPrice", () => {
    for (const p of [0.5, 3.7, 150, 4200]) {
      const rt = sqrtPriceX64ToPrice(priceToSqrtPriceX64(p, 9, 6), 9, 6);
      expect(rt).to.be.closeTo(p, p * 1e-9);
    }
  });

  it("value curve: linear below range, flat above range, concave in range", () => {
    const v = view();
    const curve = buildValueCurve(v, { points: 201 });

    // Below range V(S) = amountA_at_lower * S → value/price constant.
    const lows = curve.filter((c) => c.price < v.priceLower * 0.95);
    expect(lows.length).to.be.greaterThan(5);
    const ratios = lows.map((c) => c.value / c.price);
    expect(Math.max(...ratios) - Math.min(...ratios)).to.be.lessThan(
      ratios[0] * 1e-6,
    );

    // Above range V(S) constant.
    const highs = curve.filter((c) => c.price > v.priceUpper * 1.05);
    expect(highs.length).to.be.greaterThan(5);
    const vals = highs.map((c) => c.value);
    expect(Math.max(...vals) - Math.min(...vals)).to.be.lessThan(vals[0] * 1e-6);

    // In range: concave — midpoint above the chord.
    const ins = curve.filter(
      (c) => c.price > v.priceLower * 1.02 && c.price < v.priceUpper * 0.98,
    );
    const a = ins[0];
    const b = ins[ins.length - 1];
    const mid = ins[Math.floor(ins.length / 2)];
    const chordAtMid =
      a.value + ((b.value - a.value) * (mid.price - a.price)) / (b.price - a.price);
    expect(mid.value).to.be.greaterThan(chordAtMid);

    // Current-price point on the curve matches the view's valueQuote.
    const nearest = curve.reduce((best, c) =>
      Math.abs(c.price - v.price) < Math.abs(best.price - v.price) ? c : best,
    );
    expect(nearest.value).to.be.closeTo(v.valueQuote, v.valueQuote * 0.01);
  });

  it("aggregatePortfolio sums USD only over USDC-quoted views", () => {
    const usdc = view();
    const exotic = { ...view(TICK_LOWER - 500), isUsdcQuoted: false };
    const s = aggregatePortfolio([usdc, exotic]);
    expect(s.positionsCount).to.equal(2);
    expect(s.inRangeCount).to.equal(1);
    expect(s.unpricedCount).to.equal(1);
    expect(s.totalValueUsd).to.be.closeTo(usdc.valueQuote, 1e-9);
  });
});
