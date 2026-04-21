/**
 * Integration Test — Multi-Certificate Scenarios
 *
 * Tests interactions between multiple certificates sharing a single pool.
 * Verifies that utilization tracking, cap accounting, and settlement
 * behave correctly when multiple positions are hedged simultaneously.
 */

import { expect } from "chai";
import {
  OffchainLhProtocol,
  CertificateStatus,
} from "../../protocol-src/index";
import {
  DEFAULT_POOL_CONFIG,
  DEFAULT_TEMPLATE,
} from "../../protocol-src/config/templates";

describe("Multi-Certificate Integration", () => {
  // -------------------------------------------------------------------
  // Helper: set up a protocol with pool, template, regime, and
  // register N positions with unique mints.
  // -------------------------------------------------------------------

  function setupMultiPosition(positionCount: number) {
    const protocol = new OffchainLhProtocol();

    // Init pool with $100 reserves
    protocol.initPool("admin", DEFAULT_POOL_CONFIG);
    protocol.depositUsdc("rt-wallet-1", 100_000_000);

    // Create template
    protocol.createTemplate("admin", { ...DEFAULT_TEMPLATE });

    // Update regime (nowTs used later for freshness)
    const nowTs = Math.floor(Date.now() / 1000);
    protocol.updateRegimeSnapshot("risk-service", {
      sigmaPpm: 650_000,
      sigma7dPpm: 682_500,
      stressFlag: false,
      carryBpsPerDay: 5,
      ivRvRatio: 1.08,
    });

    // Register multiple positions
    for (let i = 1; i <= positionCount; i++) {
      protocol.registerLockedPosition(`lp-wallet-${i}`, {
        positionMint: `pos-mint-${i}`,
        entryPriceE6: 150_000_000,
        lowerTick: -1000,
        upperTick: 1000,
        liquidity: BigInt(50),
        entryValueE6: 6_000_000,
      });
    }

    return { protocol, nowTs };
  }

  // -------------------------------------------------------------------
  // 1. Two certificates: utilization = sum of caps
  // -------------------------------------------------------------------

  it("Two certificates: utilization = sum of caps", () => {
    const { protocol } = setupMultiPosition(2);

    // Buy cert for position 1
    const buy1 = protocol.buyCertificate("lp-wallet-1", {
      positionMint: "pos-mint-1",
      templateId: 1,
    });
    const poolAfterBuy1 = protocol.getPoolState()!;
    expect(poolAfterBuy1.activeCapUsdc).to.equal(buy1.capUsdc);

    // Buy cert for position 2
    const buy2 = protocol.buyCertificate("lp-wallet-2", {
      positionMint: "pos-mint-2",
      templateId: 1,
    });
    const poolAfterBuy2 = protocol.getPoolState()!;

    // ActiveCap should be the sum of both caps
    expect(poolAfterBuy2.activeCapUsdc).to.equal(
      buy1.capUsdc + buy2.capUsdc,
    );

    // Both caps should be identical (same position parameters)
    expect(buy1.capUsdc).to.equal(buy2.capUsdc);
  });

  // -------------------------------------------------------------------
  // 2. Third certificate rejected if exceeds u_max
  // -------------------------------------------------------------------

  it("Third certificate rejected if exceeds u_max", () => {
    // Use a small pool so that 3 certs would exceed 30% utilization
    const protocol = new OffchainLhProtocol();
    protocol.initPool("admin", DEFAULT_POOL_CONFIG);

    // Deposit only $20 — with u_max=30%, headroom is only $6
    protocol.depositUsdc("rt-wallet-1", 20_000_000);

    protocol.createTemplate("admin", { ...DEFAULT_TEMPLATE });
    protocol.updateRegimeSnapshot("risk-service", {
      sigmaPpm: 650_000,
      sigma7dPpm: 682_500,
      stressFlag: false,
      carryBpsPerDay: 5,
      ivRvRatio: 1.08,
    });

    // Register 3 positions
    for (let i = 1; i <= 3; i++) {
      protocol.registerLockedPosition(`lp-wallet-${i}`, {
        positionMint: `pos-mint-u-${i}`,
        entryPriceE6: 150_000_000,
        lowerTick: -1000,
        upperTick: 1000,
        liquidity: BigInt(50),
        entryValueE6: 6_000_000,
      });
    }

    // First cert should succeed (cap ~$4.4, within $6 headroom)
    const buy1 = protocol.buyCertificate("lp-wallet-1", {
      positionMint: "pos-mint-u-1",
      templateId: 1,
    });

    // Second cert should fail because headroom is exhausted
    // (cap ~$4.4 > remaining headroom ~$1.6 + premium added)
    expect(() =>
      protocol.buyCertificate("lp-wallet-2", {
        positionMint: "pos-mint-u-2",
        templateId: 1,
      }),
    ).to.throw();
  });

  // -------------------------------------------------------------------
  // 3. Settlement of one cert doesn't affect the other
  // -------------------------------------------------------------------

  it("Settlement of one cert doesn't affect the other", () => {
    const { protocol } = setupMultiPosition(2);

    // Buy both certs
    const buy1 = protocol.buyCertificate("lp-wallet-1", {
      positionMint: "pos-mint-1",
      templateId: 1,
    });
    const buy2 = protocol.buyCertificate("lp-wallet-2", {
      positionMint: "pos-mint-2",
      templateId: 1,
    });

    // Settle cert 1 at expiry with price drop
    const settle1 = protocol.settleCertificate(
      "settler",
      "pos-mint-1",
      140_000_000,
      1_000_000,
      buy1.expiryTs,
    );
    expect(settle1.state).to.equal(CertificateStatus.Settled);
    expect(settle1.payoutUsdc).to.be.greaterThan(0);

    // Cert 2 should still be Active
    const cert2 = protocol.getCertificateState("pos-mint-2")!;
    expect(cert2.state).to.equal(CertificateStatus.Active);

    // Pool activeCapUsdc should now reflect only cert 2's cap
    const pool = protocol.getPoolState()!;
    expect(pool.activeCapUsdc).to.equal(buy2.capUsdc);

    // Position 1 should be unprotected, position 2 still protected
    const pos1 = protocol.getPositionState("pos-mint-1")!;
    const pos2 = protocol.getPositionState("pos-mint-2")!;
    expect(pos1.protectedBy).to.be.null;
    expect(pos2.protectedBy).to.not.be.null;

    // Settle cert 2 at expiry with price up: LP surrenders upside (payout < 0)
    const settle2 = protocol.settleCertificate(
      "settler",
      "pos-mint-2",
      155_000_000,
      2_000_000,
      buy2.expiryTs,
    );
    expect(settle2.state).to.equal(CertificateStatus.Settled);
    expect(settle2.payoutUsdc).to.be.lessThan(0);

    // Pool activeCapUsdc should be 0 now
    const poolFinal = protocol.getPoolState()!;
    expect(poolFinal.activeCapUsdc).to.equal(0);
  });

  // -------------------------------------------------------------------
  // 4. Pool reserves correct after settling all certs
  // -------------------------------------------------------------------

  it("Pool reserves correct after settling all certs", () => {
    const { protocol } = setupMultiPosition(2);
    const initialReserves = protocol.getPoolState()!.reservesUsdc;

    // Buy both certs
    const buy1 = protocol.buyCertificate("lp-wallet-1", {
      positionMint: "pos-mint-1",
      templateId: 1,
    });
    const buy2 = protocol.buyCertificate("lp-wallet-2", {
      positionMint: "pos-mint-2",
      templateId: 1,
    });

    const premiumToPool1 = buy1.premiumUsdc - buy1.protocolFeeUsdc;
    const premiumToPool2 = buy2.premiumUsdc - buy2.protocolFeeUsdc;

    // Settle cert 1: price drop (payout > 0)
    const fees1 = 1_500_000;
    const settle1 = protocol.settleCertificate(
      "settler",
      "pos-mint-1",
      143_000_000,
      fees1,
      buy1.expiryTs,
    );

    // Settle cert 2: price up (payout < 0, LP surrenders upside to pool)
    const fees2 = 2_500_000;
    const settle2 = protocol.settleCertificate(
      "settler",
      "pos-mint-2",
      155_000_000,
      fees2,
      buy2.expiryTs,
    );

    const finalPool = protocol.getPoolState()!;

    // Expected reserves (signed: subtracting a negative settle2.payoutUsdc
    // correctly adds the upside give-up to the pool):
    //   initial
    //   + premiumToPool1 + premiumToPool2  (from cert purchases)
    //   - settle1.payoutUsdc               (RT pays LP: positive payout)
    //   + settle1.rtFeeIncomeUsdc          (fee split from cert 1)
    //   - settle2.payoutUsdc               (LP pays RT: negative payout → gain)
    //   + settle2.rtFeeIncomeUsdc          (fee split from cert 2)
    const expectedReserves =
      initialReserves +
      premiumToPool1 +
      premiumToPool2 -
      settle1.payoutUsdc +
      settle1.rtFeeIncomeUsdc -
      settle2.payoutUsdc +
      settle2.rtFeeIncomeUsdc;

    expect(finalPool.reservesUsdc).to.equal(expectedReserves);
    expect(finalPool.activeCapUsdc).to.equal(0);
  });
});
