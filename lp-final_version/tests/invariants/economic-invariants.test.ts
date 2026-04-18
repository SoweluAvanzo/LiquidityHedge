/**
 * Economic Invariants Tests
 *
 * Verifies that fundamental protocol invariants hold across random
 * scenarios. These are properties that MUST always be true regardless
 * of market conditions, parameter choices, or operation ordering.
 *
 * Position parameters: L=50, S_0=$150, p_l=$135, p_u=$165, cap~$4.46
 */

import { expect } from "chai";
import {
  OffchainLhProtocol,
  CertificateStatus,
  PositionStatus,
  BPS,
  DEFAULT_PREMIUM_FLOOR_USDC,
  DEFAULT_U_MAX_BPS,
  clPositionValue,
  naturalCap,
  corridorPayoff,
} from "../../protocol-src/index";
import {
  DEFAULT_POOL_CONFIG,
  DEFAULT_TEMPLATE,
  computeBarrierFromWidth,
} from "../../protocol-src/config/templates";
import {
  setupTestProtocol,
  createRng,
} from "../helpers";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const S0 = 150;
const L = 50;
const PL = 135;
const PU = 165;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Economic Invariants", () => {

  // ── Invariant 1: Payout in [0, cap] ────────────────────────
  it("Payout in [0, cap] for any settlement price", () => {
    const rng = createRng(99);

    for (let i = 0; i < 50; i++) {
      const protocol = new OffchainLhProtocol();
      protocol.initPool("admin", DEFAULT_POOL_CONFIG);
      protocol.depositUsdc("rt-wallet-1", 100_000_000);
      protocol.createTemplate("admin", { ...DEFAULT_TEMPLATE });
      protocol.updateRegimeSnapshot("risk-service", {
        sigmaPpm: 650_000,
        sigma7dPpm: 682_500,
        stressFlag: false,
        carryBpsPerDay: 5,
        ivRvRatio: 1.08,
      });

      const mint = `pos-inv1-${i}`;
      protocol.registerLockedPosition("lp-wallet-1", {
        positionMint: mint,
        entryPriceE6: 150_000_000,
        lowerTick: -1000,
        upperTick: 1000,
        liquidity: BigInt(50),
        entryValueE6: 6_000_000,
      });

      const cert = protocol.buyCertificate("lp-wallet-1", {
        positionMint: mint,
        templateId: 1,
      });

      // Random settlement price in [$50, $300]
      const ST = 50 + rng() * 250;
      const settlePriceE6 = Math.floor(ST * 1_000_000);
      const fees = Math.floor(rng() * 3_000_000); // $0-$3

      const result = protocol.settleCertificate(
        "settler",
        mint,
        settlePriceE6,
        fees,
        cert.expiryTs,
      );

      expect(result.payoutUsdc).to.be.greaterThanOrEqual(
        0,
        `Price=$${ST.toFixed(2)}: payout must be >= 0`,
      );
      expect(result.payoutUsdc).to.be.lessThanOrEqual(
        cert.capUsdc + 1, // +1 for rounding tolerance
        `Price=$${ST.toFixed(2)}: payout must be <= cap`,
      );
    }
  });

  // ── Invariant 2: Premium >= P_floor ────────────────────────
  it("Premium >= P_floor for any valid inputs", () => {
    const rng = createRng(201);

    for (let i = 0; i < 20; i++) {
      const protocol = new OffchainLhProtocol();
      protocol.initPool("admin", DEFAULT_POOL_CONFIG);
      // Vary the deposit size
      const deposit = Math.floor(50_000_000 + rng() * 200_000_000);
      protocol.depositUsdc("rt-wallet-1", deposit);
      protocol.createTemplate("admin", { ...DEFAULT_TEMPLATE });

      // Vary volatility from 20% to 120%
      const sigmaFrac = 0.20 + rng() * 1.00;
      const sigmaPpm = Math.floor(sigmaFrac * 1_000_000);
      protocol.updateRegimeSnapshot("risk-service", {
        sigmaPpm,
        sigma7dPpm: Math.floor(sigmaPpm * 1.05),
        stressFlag: rng() > 0.8,
        carryBpsPerDay: Math.floor(rng() * 20),
        ivRvRatio: 0.90 + rng() * 0.40,
      });

      const mint = `pos-inv2-${i}`;
      protocol.registerLockedPosition("lp-wallet-1", {
        positionMint: mint,
        entryPriceE6: 150_000_000,
        lowerTick: -1000,
        upperTick: 1000,
        liquidity: BigInt(50),
        entryValueE6: 6_000_000,
      });

      const cert = protocol.buyCertificate("lp-wallet-1", {
        positionMint: mint,
        templateId: 1,
      });

      expect(cert.premiumUsdc).to.be.greaterThanOrEqual(
        DEFAULT_PREMIUM_FLOOR_USDC,
        `Config ${i} (sigma=${sigmaFrac.toFixed(2)}): premium must be >= P_floor`,
      );
    }
  });

  // ── Invariant 3: Pool solvency after operations ────────────
  it("Pool reserves >= activeCap * BPS / uMaxBps after any operation", () => {
    const protocol = new OffchainLhProtocol();
    protocol.initPool("admin", DEFAULT_POOL_CONFIG);
    protocol.depositUsdc("rt-wallet-1", 200_000_000); // $200
    protocol.createTemplate("admin", { ...DEFAULT_TEMPLATE });
    protocol.updateRegimeSnapshot("risk-service", {
      sigmaPpm: 650_000,
      sigma7dPpm: 682_500,
      stressFlag: false,
      carryBpsPerDay: 5,
      ivRvRatio: 1.08,
    });

    function assertSolvency(label: string) {
      const pool = protocol.getPoolState()!;
      if (pool.activeCapUsdc > 0) {
        const minReserves = Math.ceil(
          (pool.activeCapUsdc * BPS) / pool.uMaxBps,
        );
        expect(pool.reservesUsdc).to.be.greaterThanOrEqual(
          minReserves,
          `Solvency violation after ${label}: reserves=${pool.reservesUsdc}, minRequired=${minReserves}`,
        );
      }
    }

    // Register and buy a certificate
    protocol.registerLockedPosition("lp-wallet-1", {
      positionMint: "pos-solv-1",
      entryPriceE6: 150_000_000,
      lowerTick: -1000,
      upperTick: 1000,
      liquidity: BigInt(50),
      entryValueE6: 6_000_000,
    });
    const cert1 = protocol.buyCertificate("lp-wallet-1", {
      positionMint: "pos-solv-1",
      templateId: 1,
    });
    assertSolvency("buyCertificate #1");

    // Deposit more
    protocol.depositUsdc("rt-wallet-2", 50_000_000);
    assertSolvency("depositUsdc #2");

    // Settle with a payout (price drop)
    protocol.settleCertificate(
      "settler",
      "pos-solv-1",
      130_000_000,
      1_000_000,
      cert1.expiryTs,
    );
    assertSolvency("settleCertificate with payout");

    // Register second position and buy another cert
    protocol.registerLockedPosition("lp-wallet-1", {
      positionMint: "pos-solv-2",
      entryPriceE6: 150_000_000,
      lowerTick: -1000,
      upperTick: 1000,
      liquidity: BigInt(50),
      entryValueE6: 6_000_000,
    });
    const cert2 = protocol.buyCertificate("lp-wallet-1", {
      positionMint: "pos-solv-2",
      templateId: 1,
    });
    assertSolvency("buyCertificate #2");

    // Settle with no payout (price up)
    protocol.settleCertificate(
      "settler",
      "pos-solv-2",
      160_000_000,
      2_000_000,
      cert2.expiryTs,
    );
    assertSolvency("settleCertificate expired");
  });

  // ── Invariant 4: NAV consistency ──────────────────────────
  it("NAV consistency: share values sum to reserves", () => {
    const protocol = new OffchainLhProtocol();
    protocol.initPool("admin", DEFAULT_POOL_CONFIG);

    // Multiple RT deposits
    protocol.depositUsdc("rt-1", 50_000_000);
    protocol.depositUsdc("rt-2", 30_000_000);
    protocol.depositUsdc("rt-3", 20_000_000);

    // Register position and buy cert (adds premium to reserves)
    protocol.createTemplate("admin", { ...DEFAULT_TEMPLATE });
    protocol.updateRegimeSnapshot("risk-service", {
      sigmaPpm: 650_000,
      sigma7dPpm: 682_500,
      stressFlag: false,
      carryBpsPerDay: 5,
      ivRvRatio: 1.08,
    });
    protocol.registerLockedPosition("lp-wallet-1", {
      positionMint: "pos-nav",
      entryPriceE6: 150_000_000,
      lowerTick: -1000,
      upperTick: 1000,
      liquidity: BigInt(50),
      entryValueE6: 6_000_000,
    });
    protocol.buyCertificate("lp-wallet-1", {
      positionMint: "pos-nav",
      templateId: 1,
    });

    const pool = protocol.getPoolState()!;
    const store = protocol.getStore();
    const shareholders = store.getAllShareholders();
    const totalShares = Object.values(shareholders).reduce((s, v) => s + v, 0);

    // Total shares in ledger should match pool.totalShares
    expect(totalShares).to.equal(pool.totalShares);

    // Each shareholder's USDC value = shares * reserves / totalShares
    // Sum of all should equal reserves (within rounding)
    let sumValues = 0;
    for (const [owner, shares] of Object.entries(shareholders)) {
      const value = Math.floor((shares * pool.reservesUsdc) / pool.totalShares);
      sumValues += value;
    }

    // Rounding can cause off-by-a-few, but never more than #shareholders
    const roundingTolerance = Object.keys(shareholders).length;
    expect(Math.abs(pool.reservesUsdc - sumValues)).to.be.lessThanOrEqual(
      roundingTolerance,
      "Sum of share values should equal reserves (within rounding)",
    );
  });

  // ── Invariant 5: Certificate state machine ────────────────
  it("Certificate state machine: only valid transitions", () => {
    const protocol = new OffchainLhProtocol();
    protocol.initPool("admin", DEFAULT_POOL_CONFIG);
    protocol.depositUsdc("rt-wallet-1", 100_000_000);
    protocol.createTemplate("admin", { ...DEFAULT_TEMPLATE });
    protocol.updateRegimeSnapshot("risk-service", {
      sigmaPpm: 650_000,
      sigma7dPpm: 682_500,
      stressFlag: false,
      carryBpsPerDay: 5,
      ivRvRatio: 1.08,
    });

    protocol.registerLockedPosition("lp-wallet-1", {
      positionMint: "pos-sm",
      entryPriceE6: 150_000_000,
      lowerTick: -1000,
      upperTick: 1000,
      liquidity: BigInt(50),
      entryValueE6: 6_000_000,
    });

    // After buy: Active
    const cert = protocol.buyCertificate("lp-wallet-1", {
      positionMint: "pos-sm",
      templateId: 1,
    });
    const certState1 = protocol.getCertificateState("pos-sm")!;
    expect(certState1.state).to.equal(CertificateStatus.Active);

    // Cannot settle before expiry
    const tooEarly = cert.expiryTs - 100;
    expect(() =>
      protocol.settleCertificate("settler", "pos-sm", 150_000_000, 0, tooEarly),
    ).to.throw("not yet expired");

    // Settle: transitions to Settled or Expired
    const result = protocol.settleCertificate(
      "settler",
      "pos-sm",
      145_000_000,
      500_000,
      cert.expiryTs,
    );
    const certState2 = protocol.getCertificateState("pos-sm")!;
    expect([CertificateStatus.Settled, CertificateStatus.Expired]).to.include(
      certState2.state,
    );

    // Cannot settle again
    expect(() =>
      protocol.settleCertificate("settler", "pos-sm", 150_000_000, 0, cert.expiryTs + 1),
    ).to.throw("not active");
  });

  // ── Invariant 6: Position cannot be released while protected ─
  it("Position cannot be released while protected", () => {
    const protocol = new OffchainLhProtocol();
    protocol.initPool("admin", DEFAULT_POOL_CONFIG);
    protocol.depositUsdc("rt-wallet-1", 100_000_000);
    protocol.createTemplate("admin", { ...DEFAULT_TEMPLATE });
    protocol.updateRegimeSnapshot("risk-service", {
      sigmaPpm: 650_000,
      sigma7dPpm: 682_500,
      stressFlag: false,
      carryBpsPerDay: 5,
      ivRvRatio: 1.08,
    });

    protocol.registerLockedPosition("lp-wallet-1", {
      positionMint: "pos-protect",
      entryPriceE6: 150_000_000,
      lowerTick: -1000,
      upperTick: 1000,
      liquidity: BigInt(50),
      entryValueE6: 6_000_000,
    });

    const cert = protocol.buyCertificate("lp-wallet-1", {
      positionMint: "pos-protect",
      templateId: 1,
    });

    // Position has protectedBy set
    const pos = protocol.getPositionState("pos-protect")!;
    expect(pos.protectedBy).to.not.be.null;

    // Cannot release while protected
    expect(() =>
      protocol.releasePosition("lp-wallet-1", "pos-protect"),
    ).to.throw("protected");

    // After settlement, position can be released
    protocol.settleCertificate(
      "settler",
      "pos-protect",
      160_000_000,
      1_000_000,
      cert.expiryTs,
    );

    const posAfter = protocol.getPositionState("pos-protect")!;
    expect(posAfter.protectedBy).to.be.null;

    // Now release succeeds
    protocol.releasePosition("lp-wallet-1", "pos-protect");
    const posReleased = protocol.getPositionState("pos-protect")!;
    expect(posReleased.status).to.equal(PositionStatus.Released);
  });

  // ── Invariant 7: Fee split in [0, feesAccrued * feeSplitRate] ─
  it("Fee split in [0, feesAccrued * feeSplitRate]", () => {
    const rng = createRng(303);

    for (let i = 0; i < 30; i++) {
      const protocol = new OffchainLhProtocol();
      protocol.initPool("admin", DEFAULT_POOL_CONFIG);
      protocol.depositUsdc("rt-wallet-1", 100_000_000);
      protocol.createTemplate("admin", { ...DEFAULT_TEMPLATE });
      protocol.updateRegimeSnapshot("risk-service", {
        sigmaPpm: 650_000,
        sigma7dPpm: 682_500,
        stressFlag: false,
        carryBpsPerDay: 5,
        ivRvRatio: 1.08,
      });

      const mint = `pos-fee-${i}`;
      protocol.registerLockedPosition("lp-wallet-1", {
        positionMint: mint,
        entryPriceE6: 150_000_000,
        lowerTick: -1000,
        upperTick: 1000,
        liquidity: BigInt(50),
        entryValueE6: 6_000_000,
      });

      const cert = protocol.buyCertificate("lp-wallet-1", {
        positionMint: mint,
        templateId: 1,
      });

      // Random fees and settlement price
      const feesAccrued = Math.floor(rng() * 5_000_000); // $0-$5
      const ST = 100 + rng() * 100; // $100-$200
      const settlePriceE6 = Math.floor(ST * 1_000_000);

      const result = protocol.settleCertificate(
        "settler",
        mint,
        settlePriceE6,
        feesAccrued,
        cert.expiryTs,
      );

      // Fee split should be non-negative
      expect(result.rtFeeIncomeUsdc).to.be.greaterThanOrEqual(
        0,
        `Iteration ${i}: fee split must be >= 0`,
      );

      // Fee split should not exceed feeSplitRate * feesAccrued
      const certState = protocol.getCertificateState(mint)!;
      const maxFeeSplit = Math.floor(certState.feeSplitRate * feesAccrued);
      expect(result.rtFeeIncomeUsdc).to.be.lessThanOrEqual(
        maxFeeSplit,
        `Iteration ${i}: fee split ${result.rtFeeIncomeUsdc} must be <= ${maxFeeSplit}`,
      );

      // Exact value check: should equal floor(feeSplitRate * feesAccrued)
      expect(result.rtFeeIncomeUsdc).to.equal(maxFeeSplit);
    }
  });

  // ── Invariant 8: Barrier = S_0 * (1 - widthBps/BPS) ───────
  it("Barrier always equals S_0 * (1 - widthBps/BPS)", () => {
    const rng = createRng(404);

    // Test with various entry prices
    const testPrices = [50, 100, 150, 200, 300, 500, 1000];

    for (const price of testPrices) {
      const protocol = new OffchainLhProtocol();
      protocol.initPool("admin", DEFAULT_POOL_CONFIG);
      // Larger deposit for bigger positions
      protocol.depositUsdc("rt-wallet-1", 500_000_000);
      protocol.createTemplate("admin", { ...DEFAULT_TEMPLATE });
      protocol.updateRegimeSnapshot("risk-service", {
        sigmaPpm: 650_000,
        sigma7dPpm: 682_500,
        stressFlag: false,
        carryBpsPerDay: 5,
        ivRvRatio: 1.08,
      });

      const entryPriceE6 = Math.floor(price * 1_000_000);
      const mint = `pos-barrier-${price}`;

      protocol.registerLockedPosition("lp-wallet-1", {
        positionMint: mint,
        entryPriceE6,
        lowerTick: -1000,
        upperTick: 1000,
        liquidity: BigInt(50),
        entryValueE6: 6_000_000,
      });

      const cert = protocol.buyCertificate("lp-wallet-1", {
        positionMint: mint,
        templateId: 1,
      });

      const expectedBarrier = computeBarrierFromWidth(
        entryPriceE6,
        DEFAULT_TEMPLATE.widthBps,
      );
      const expectedFormula = Math.floor(
        entryPriceE6 * (1 - DEFAULT_TEMPLATE.widthBps / BPS),
      );

      expect(cert.barrierE6).to.equal(
        expectedBarrier,
        `Price=$${price}: barrier should match computeBarrierFromWidth`,
      );
      expect(cert.barrierE6).to.equal(
        expectedFormula,
        `Price=$${price}: barrier should equal S_0*(1-width/BPS)`,
      );
    }
  });
});
