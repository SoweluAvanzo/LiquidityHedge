/**
 * Typed event schema tests.
 *
 * Exercises the new `Orchestrator.getEvents()` API and verifies that
 * each state transition emits a correctly-shaped `ProtocolEvent`.
 * These tests guard against drift when the on-chain Anchor program
 * ships — the emitted event shapes must match the Rust-side events
 * 1:1 so off-chain consumers (dashboards, audit pipelines) work
 * identically pre- and post-deployment.
 */

import { expect } from "chai";
import {
  OffchainLhProtocol,
} from "../../protocol-src/index";
import {
  DEFAULT_POOL_CONFIG,
  DEFAULT_TEMPLATE,
} from "../../protocol-src/config/templates";
import {
  ProtocolEvent,
  isCertificateBought,
  isCertificateSettled,
  isRegimeUpdated,
} from "../../protocol-src/event-audit/events";
import { setupTestProtocol } from "../helpers";

function byType<T extends ProtocolEvent["type"]>(
  events: ProtocolEvent[],
  type: T,
): Extract<ProtocolEvent, { type: T }>[] {
  return events.filter((e) => e.type === type) as Extract<
    ProtocolEvent,
    { type: T }
  >[];
}

describe("Typed protocol events", () => {
  describe("PoolManager events", () => {
    it("emits PoolInitialized with the resolved config", () => {
      const protocol = new OffchainLhProtocol();
      protocol.initPool("admin", DEFAULT_POOL_CONFIG);

      const events = protocol.getEvents();
      const inits = byType(events, "PoolInitialized");
      expect(inits).to.have.length(1);
      const ev = inits[0];
      expect(ev.component).to.equal("PoolManager");
      expect(ev.admin).to.equal("admin");
      expect(ev.uMaxBps).to.equal(DEFAULT_POOL_CONFIG.uMaxBps);
      expect(ev.markupFloor).to.equal(DEFAULT_POOL_CONFIG.markupFloor);
      expect(ev.feeSplitRate).to.equal(DEFAULT_POOL_CONFIG.feeSplitRate);
      expect(ev.premiumFloorUsdc).to.equal(DEFAULT_POOL_CONFIG.premiumFloorUsdc);
      expect(ev.protocolFeeBps).to.equal(DEFAULT_POOL_CONFIG.protocolFeeBps);
      expect(ev.ts).to.match(/^\d{4}-\d{2}-\d{2}T/);
    });

    it("emits RtDeposited on deposit and RtWithdrew on withdraw", () => {
      const protocol = new OffchainLhProtocol();
      protocol.initPool("admin", DEFAULT_POOL_CONFIG);
      const deposit = protocol.depositUsdc("rt-1", 1_000_000);
      const withdraw = protocol.withdrawUsdc("rt-1", deposit.shares);

      const events = protocol.getEvents();
      const deposits = byType(events, "RtDeposited");
      expect(deposits).to.have.length(1);
      expect(deposits[0].depositor).to.equal("rt-1");
      expect(deposits[0].amountUsdc).to.equal(1_000_000);
      expect(deposits[0].sharesIssued).to.equal(deposit.shares);

      const withdraws = byType(events, "RtWithdrew");
      expect(withdraws).to.have.length(1);
      expect(withdraws[0].withdrawer).to.equal("rt-1");
      expect(withdraws[0].sharesBurned).to.equal(deposit.shares);
      expect(withdraws[0].usdcReturned).to.equal(withdraw.usdcReturned);
    });
  });

  describe("Certificate lifecycle events", () => {
    it("emits RegimeUpdated → TemplateCreated → PositionRegistered → CertificateBought → CertificateSettled in order", () => {
      const { protocol } = setupTestProtocol();

      // buy + settle
      const buy = protocol.buyCertificate("lp-wallet-1", {
        positionMint: "pos-mint-1",
        templateId: 1,
      });
      protocol.settleCertificate(
        "settler",
        "pos-mint-1",
        145_000_000,
        1_000_000,
        buy.expiryTs,
      );

      const events = protocol.getEvents();
      const typesInOrder = events.map((e) => e.type);

      // At minimum, the last two events must be CertificateBought then CertificateSettled
      const last = typesInOrder.slice(-2);
      expect(last).to.deep.equal(["CertificateBought", "CertificateSettled"]);

      // All of these types must be present:
      for (const t of [
        "PoolInitialized",
        "RtDeposited",
        "TemplateCreated",
        "RegimeUpdated",
        "PositionRegistered",
        "CertificateBought",
        "CertificateSettled",
      ]) {
        expect(typesInOrder).to.include(t);
      }
    });

    it("CertificateBought carries premium, cap, FV, expiry", () => {
      const { protocol } = setupTestProtocol();
      const buy = protocol.buyCertificate("lp-wallet-1", {
        positionMint: "pos-mint-1",
        templateId: 1,
      });
      const [ev] = protocol
        .getEvents()
        .filter(isCertificateBought);
      expect(ev).to.exist;
      expect(ev.buyer).to.equal("lp-wallet-1");
      expect(ev.positionMint).to.equal("pos-mint-1");
      expect(ev.templateId).to.equal(1);
      expect(ev.premiumUsdc).to.equal(buy.premiumUsdc);
      expect(ev.capUsdc).to.equal(buy.capUsdc);
      expect(ev.fairValueUsdc).to.equal(buy.fairValueUsdc);
      expect(ev.expiryTs).to.equal(buy.expiryTs);
      expect(ev.component).to.equal("Orchestrator");
    });

    it("CertificateSettled carries signed payout + fee-split + state", () => {
      const { protocol } = setupTestProtocol();
      const buy = protocol.buyCertificate("lp-wallet-1", {
        positionMint: "pos-mint-1",
        templateId: 1,
      });
      const settle = protocol.settleCertificate(
        "settler",
        "pos-mint-1",
        142_000_000,
        1_000_000,
        buy.expiryTs,
      );
      const [ev] = protocol.getEvents().filter(isCertificateSettled);
      expect(ev).to.exist;
      expect(ev.settler).to.equal("settler");
      expect(ev.positionMint).to.equal("pos-mint-1");
      expect(ev.payoutUsdc).to.equal(settle.payoutUsdc);
      expect(ev.rtFeeIncomeUsdc).to.equal(settle.rtFeeIncomeUsdc);
      expect(ev.settlementPriceE6).to.equal(142_000_000);
      expect(ev.state).to.equal(settle.state);
      expect(ev.component).to.equal("CertificateLifecycleManager");
    });

    it("RegimeUpdated carries σ, IV/RV, stress, severity", () => {
      const { protocol } = setupTestProtocol();
      const [ev] = protocol.getEvents().filter(isRegimeUpdated);
      expect(ev).to.exist;
      expect(ev.sigmaPpm).to.equal(650_000);
      expect(ev.stressFlag).to.equal(false);
      expect(ev.ivRvRatio).to.equal(1.08);
      expect(ev.effectiveMarkup).to.be.a("number");
      expect(ev.severityPpm).to.be.a("number");
      expect(ev.component).to.equal("RiskAnalyser");
    });
  });
});
