import { expect } from "chai";
import { PublicKey } from "@solana/web3.js";
import { integerSqrt, tickToSqrtPriceX64, sqrtPriceX64ToPrice } from "../../protocol-src/utils/math";
import {
  clPositionValue,
  estimateTokenAmounts,
  naturalCap,
  naturalCapUp,
  lhPayoff,
} from "../../protocol-src/pricing-engine/position-value";
import { decodePositionAccount } from "../../protocol-src/market-data/decoder";
import { Q64 } from "../../protocol-src/types";

describe("CL Math Utilities", () => {
  // ── Integer square root ───────────────────────────────────

  describe("integerSqrt", () => {
    it("sqrt(0) = 0", () => {
      expect(integerSqrt(0n)).to.equal(0n);
    });

    it("sqrt(1) = 1", () => {
      expect(integerSqrt(1n)).to.equal(1n);
    });

    it("sqrt(4) = 2", () => {
      expect(integerSqrt(4n)).to.equal(2n);
    });

    it("sqrt(100) = 10", () => {
      expect(integerSqrt(100n)).to.equal(10n);
    });

    it("floor(sqrt(2)) = 1", () => {
      expect(integerSqrt(2n)).to.equal(1n);
    });

    it("floor(sqrt(1000000)) = 1000", () => {
      expect(integerSqrt(1_000_000n)).to.equal(1_000n);
    });

    it("handles large values (10^18)", () => {
      const n = 1_000_000_000_000_000_000n;
      expect(integerSqrt(n)).to.equal(1_000_000_000n);
    });
  });

  // ── CL value function V(S) ────────────────────────────────

  describe("clPositionValue", () => {
    const L = 10_000;
    const pL = 135; // S0 * 0.90
    const pU = 165; // S0 * 1.10
    const S0 = 150;

    it("V(S0) > 0 for in-range position", () => {
      const v = clPositionValue(S0, L, pL, pU);
      expect(v).to.be.greaterThan(0);
    });

    it("V(S) is constant above range (all token B)", () => {
      const v1 = clPositionValue(200, L, pL, pU);
      const v2 = clPositionValue(300, L, pL, pU);
      expect(Math.abs(v1 - v2)).to.be.lessThan(0.001);
    });

    it("V(S) is linear below range (all token A)", () => {
      const v1 = clPositionValue(100, L, pL, pU);
      const v2 = clPositionValue(50, L, pL, pU);
      // v(100) / v(50) should ≈ 100/50 = 2
      expect(v1 / v2).to.be.closeTo(2, 0.01);
    });

    it("V(S) is continuous at lower boundary p_l", () => {
      const vBelow = clPositionValue(pL - 0.001, L, pL, pU);
      const vAt = clPositionValue(pL, L, pL, pU);
      const vAbove = clPositionValue(pL + 0.001, L, pL, pU);
      expect(Math.abs(vBelow - vAt)).to.be.lessThan(0.5);
      expect(Math.abs(vAt - vAbove)).to.be.lessThan(0.5);
    });

    it("V(S) is continuous at upper boundary p_u", () => {
      const vBelow = clPositionValue(pU - 0.001, L, pL, pU);
      const vAt = clPositionValue(pU, L, pL, pU);
      const vAbove = clPositionValue(pU + 0.001, L, pL, pU);
      expect(Math.abs(vBelow - vAt)).to.be.lessThan(0.5);
      expect(Math.abs(vAt - vAbove)).to.be.lessThan(0.5);
    });

    it("V(S) is concave in range (midpoint above chord)", () => {
      const S1 = 140;
      const S2 = 160;
      const Smid = (S1 + S2) / 2;
      const vMid = clPositionValue(Smid, L, pL, pU);
      const vChord = (clPositionValue(S1, L, pL, pU) + clPositionValue(S2, L, pL, pU)) / 2;
      expect(vMid).to.be.greaterThanOrEqual(vChord);
    });

    it("V(S0) > V(pL) (entry value exceeds barrier value)", () => {
      const v0 = clPositionValue(S0, L, pL, pU);
      const vB = clPositionValue(pL, L, pL, pU);
      expect(v0).to.be.greaterThan(vB);
    });
  });

  // ── Natural cap ───────────────────────────────────────────

  describe("naturalCap", () => {
    it("cap > 0 when S0 > pL", () => {
      const cap = naturalCap(150, 10_000, 135, 165);
      expect(cap).to.be.greaterThan(0);
    });

    it("cap = 0 when L = 0", () => {
      const cap = naturalCap(150, 0, 135, 165);
      expect(cap).to.equal(0);
    });

    it("cap increases with liquidity", () => {
      const cap1 = naturalCap(150, 5_000, 135, 165);
      const cap2 = naturalCap(150, 10_000, 135, 165);
      expect(cap2).to.be.greaterThan(cap1);
    });
  });

  // ── Liquidity Hedge (signed swap) payoff ──────────────────

  describe("lhPayoff (signed swap on V(·))", () => {
    const L = 10_000;
    const pL = 135;
    const pU = 165;
    const S0 = 150;
    const capDown = naturalCap(S0, L, pL, pU);
    const capUp = naturalCapUp(S0, L, pL, pU);

    it("payoff = 0 exactly at entry", () => {
      expect(lhPayoff(S0, S0, L, pL, pU)).to.be.closeTo(0, 1e-9);
    });

    it("payoff > 0 below entry (RT owes LP)", () => {
      expect(lhPayoff(142, S0, L, pL, pU)).to.be.greaterThan(0);
      expect(lhPayoff(140, S0, L, pL, pU)).to.be.greaterThan(0);
    });

    it("payoff < 0 above entry (LP owes RT)", () => {
      expect(lhPayoff(158, S0, L, pL, pU)).to.be.lessThan(0);
      expect(lhPayoff(160, S0, L, pL, pU)).to.be.lessThan(0);
    });

    it("payoff = +Cap_down at and below lower bound", () => {
      expect(lhPayoff(pL, S0, L, pL, pU)).to.be.closeTo(capDown, 0.01);
      expect(lhPayoff(100, S0, L, pL, pU)).to.be.closeTo(capDown, 0.01);
      expect(lhPayoff(50, S0, L, pL, pU)).to.be.closeTo(capDown, 0.01);
    });

    it("payoff = -Cap_up at and above upper bound", () => {
      expect(lhPayoff(pU, S0, L, pL, pU)).to.be.closeTo(-capUp, 0.01);
      expect(lhPayoff(200, S0, L, pL, pU)).to.be.closeTo(-capUp, 0.01);
      expect(lhPayoff(500, S0, L, pL, pU)).to.be.closeTo(-capUp, 0.01);
    });

    it("payoff is monotonically non-increasing in S_T", () => {
      const prices = [100, 120, 135, 140, 145, 150, 155, 160, 165, 180];
      let prev = Infinity;
      for (const p of prices) {
        const payout = lhPayoff(p, S0, L, pL, pU);
        expect(payout).to.be.lessThanOrEqual(prev + 1e-9);
        prev = payout;
      }
    });

    it("Cap_up < Cap_down by concavity of V (symmetric width)", () => {
      expect(capUp).to.be.greaterThan(0);
      expect(capDown).to.be.greaterThan(capUp);
    });

    it("exact IL replication within [p_l, p_u]: Π = V(S_0) − V(S_T)", () => {
      for (const s of [136, 140, 148, 150, 155, 162]) {
        const expected =
          clPositionValue(S0, L, pL, pU) - clPositionValue(s, L, pL, pU);
        expect(lhPayoff(s, S0, L, pL, pU)).to.be.closeTo(expected, 1e-9);
      }
    });
  });

  // ── Position account decoding (fee_owed_a/b offsets) ──────

  describe("decodePositionAccount", () => {
    // Synthetic 216-byte position buffer built to verify offsets exactly
    // match Orca's on-chain layout:
    //   0-7    discriminator
    //   8-39   whirlpool (Pubkey)
    //   40-71  position_mint (Pubkey)
    //   72-87  liquidity (u128 LE)
    //   88-91  tick_lower i32
    //   92-95  tick_upper i32
    //   96-111 fee_growth_checkpoint_a (u128, ignored)
    //   112-119 fee_owed_a (u64 LE)
    //   120-135 fee_growth_checkpoint_b (u128, ignored)
    //   136-143 fee_owed_b (u64 LE)
    //   144-215 reward_infos
    function buildPositionBuf(args: {
      liquidity: bigint;
      tickLower: number;
      tickUpper: number;
      feeOwedA: bigint;
      feeOwedB: bigint;
    }): Buffer {
      const buf = Buffer.alloc(216);
      // Orca's Position discriminator
      Buffer.from([170, 188, 143, 228, 122, 64, 247, 208]).copy(buf, 0);
      // whirlpool + position_mint: placeholder zeroed pubkeys
      PublicKey.default.toBuffer().copy(buf, 8);
      PublicKey.default.toBuffer().copy(buf, 40);
      // liquidity u128 LE
      let liq = args.liquidity;
      for (let i = 0; i < 16; i++) {
        buf[72 + i] = Number(liq & 0xffn);
        liq >>= 8n;
      }
      buf.writeInt32LE(args.tickLower, 88);
      buf.writeInt32LE(args.tickUpper, 92);
      buf.writeBigUInt64LE(args.feeOwedA, 112);
      buf.writeBigUInt64LE(args.feeOwedB, 136);
      return buf;
    }

    it("round-trips liquidity / ticks / fees through decode", () => {
      const buf = buildPositionBuf({
        liquidity: 123_456_789_012n,
        tickLower: -25688,
        tickUpper: -23680,
        feeOwedA: 42_000_000n, // 0.042 SOL in lamports
        feeOwedB: 17_500_000n, // $17.50 in micro-USDC
      });
      const decoded = decodePositionAccount(buf);
      expect(decoded.liquidity).to.equal(123_456_789_012n);
      expect(decoded.tickLowerIndex).to.equal(-25688);
      expect(decoded.tickUpperIndex).to.equal(-23680);
      expect(decoded.feeOwedA).to.equal(42_000_000n);
      expect(decoded.feeOwedB).to.equal(17_500_000n);
    });

    it("handles zero fees (fresh position, before any update_fees_and_rewards)", () => {
      const buf = buildPositionBuf({
        liquidity: 1n,
        tickLower: 0,
        tickUpper: 4,
        feeOwedA: 0n,
        feeOwedB: 0n,
      });
      const decoded = decodePositionAccount(buf);
      expect(decoded.feeOwedA).to.equal(0n);
      expect(decoded.feeOwedB).to.equal(0n);
    });

    it("rejects a truncated position buffer (< 144 bytes)", () => {
      const short = Buffer.alloc(96);
      Buffer.from([170, 188, 143, 228, 122, 64, 247, 208]).copy(short, 0);
      expect(() => decodePositionAccount(short)).to.throw(/too short/);
    });
  });

  // ── Token amounts ─────────────────────────────────────────

  describe("estimateTokenAmounts", () => {
    const L = BigInt(10_000_000);
    // Use approximate sqrt prices for a ±10% range around $150
    const sqrtLower = BigInt(Math.floor(Math.sqrt(135 / 1000) * Number(Q64)));
    const sqrtUpper = BigInt(Math.floor(Math.sqrt(165 / 1000) * Number(Q64)));
    const sqrtMid = BigInt(Math.floor(Math.sqrt(150 / 1000) * Number(Q64)));

    it("below range: amountB = 0", () => {
      const belowSqrt = sqrtLower - 1n;
      const { amountB } = estimateTokenAmounts(L, belowSqrt, sqrtLower, sqrtUpper);
      expect(amountB).to.equal(0n);
    });

    it("above range: amountA = 0", () => {
      const aboveSqrt = sqrtUpper + 1n;
      const { amountA } = estimateTokenAmounts(L, aboveSqrt, sqrtLower, sqrtUpper);
      expect(amountA).to.equal(0n);
    });

    it("in range: both amounts > 0", () => {
      const { amountA, amountB } = estimateTokenAmounts(L, sqrtMid, sqrtLower, sqrtUpper);
      expect(Number(amountA)).to.be.greaterThan(0);
      expect(Number(amountB)).to.be.greaterThan(0);
    });
  });
});
