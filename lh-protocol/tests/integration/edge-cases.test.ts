/**
 * Integration Test — Edge Cases
 *
 * Tests boundary conditions and defensive behaviors:
 *   - Premium floor enforcement
 *   - Settlement at exact expiry timestamp
 *   - Zero-fee scenarios
 *   - Position release guard while protected
 */

import { expect } from "chai";
import {
  OffchainLhProtocol,
  CertificateStatus,
  PositionStatus,
  DEFAULT_PREMIUM_FLOOR_USDC,
} from "../../protocol-src/index";
import {
  DEFAULT_POOL_CONFIG,
  DEFAULT_TEMPLATE,
} from "../../protocol-src/config/templates";
import { setupTestProtocol } from "../helpers";

describe("Edge Cases Integration", () => {
  // -------------------------------------------------------------------
  // 1. Minimum premium enforced at P_floor
  // -------------------------------------------------------------------

  it("Minimum premium enforced at P_floor", () => {
    // Use very low volatility to drive the raw premium below the floor.
    // Premium = max(P_floor, FV * m_vol - y * E[F])
    // With sigma ~1% annualized, FV should be near zero.
    const { protocol } = setupTestProtocol({ sigmaPpm: 10_000 }); // 1% vol

    const result = protocol.buyCertificate("lp-wallet-1", {
      positionMint: "pos-mint-1",
      templateId: 1,
    });

    // Premium must be at least P_floor ($0.05 = 50_000 micro-USDC)
    expect(result.premiumUsdc).to.be.greaterThanOrEqual(
      DEFAULT_PREMIUM_FLOOR_USDC,
    );
    expect(result.premiumUsdc).to.equal(DEFAULT_PREMIUM_FLOOR_USDC);
  });

  // -------------------------------------------------------------------
  // 2. Settlement at exact expiry timestamp
  // -------------------------------------------------------------------

  it("Settlement at exact expiry timestamp", () => {
    const { protocol } = setupTestProtocol();

    const buyResult = protocol.buyCertificate("lp-wallet-1", {
      positionMint: "pos-mint-1",
      templateId: 1,
    });

    // Settle exactly at expiryTs (not one second after)
    const settleResult = protocol.settleCertificate(
      "settler",
      "pos-mint-1",
      145_000_000, // Slight price drop
      1_000_000,
      buyResult.expiryTs, // Exact expiry
    );

    // Settlement should succeed at exact expiry
    expect(
      settleResult.state === CertificateStatus.Settled ||
        settleResult.state === CertificateStatus.Expired,
    ).to.be.true;

    // With price below entry, should be Settled with payout > 0
    expect(settleResult.payoutUsdc).to.be.greaterThan(0);
    expect(settleResult.state).to.equal(CertificateStatus.Settled);

    // Verify cert and position state updated
    const cert = protocol.getCertificateState("pos-mint-1")!;
    expect(cert.state).to.equal(CertificateStatus.Settled);
    expect(cert.settlementPriceE6).to.equal(145_000_000);

    const pos = protocol.getPositionState("pos-mint-1")!;
    expect(pos.protectedBy).to.be.null;
  });

  // -------------------------------------------------------------------
  // 3. Zero fees accrued -> fee split = 0
  // -------------------------------------------------------------------

  it("Zero fees accrued -> fee split = 0", () => {
    const { protocol } = setupTestProtocol();

    const buyResult = protocol.buyCertificate("lp-wallet-1", {
      positionMint: "pos-mint-1",
      templateId: 1,
    });

    const reservesBeforeSettle = protocol.getPoolState()!.reservesUsdc;

    // Settle with zero fees accrued
    const settleResult = protocol.settleCertificate(
      "settler",
      "pos-mint-1",
      160_000_000, // Price up -> expired, no payout
      0, // Zero fees
      buyResult.expiryTs,
    );

    expect(settleResult.rtFeeIncomeUsdc).to.equal(0);
    expect(settleResult.payoutUsdc).to.equal(0);
    expect(settleResult.state).to.equal(CertificateStatus.Expired);

    // Pool reserves should not change at all (no payout, no fee income)
    const reservesAfterSettle = protocol.getPoolState()!.reservesUsdc;
    expect(reservesAfterSettle).to.equal(reservesBeforeSettle);
  });

  // -------------------------------------------------------------------
  // 4. Cannot release position while protected
  // -------------------------------------------------------------------

  it("Cannot release position while protected", () => {
    const { protocol } = setupTestProtocol();

    // Buy certificate — position is now protected
    protocol.buyCertificate("lp-wallet-1", {
      positionMint: "pos-mint-1",
      templateId: 1,
    });

    const pos = protocol.getPositionState("pos-mint-1")!;
    expect(pos.protectedBy).to.not.be.null;
    expect(pos.status).to.equal(PositionStatus.Locked);

    // Attempting to release should fail
    expect(() =>
      protocol.releasePosition("lp-wallet-1", "pos-mint-1"),
    ).to.throw("position is protected");
  });
});
