import { expect } from "chai";
import { OffchainLhProtocol, CertificateStatus, PositionStatus } from "../../protocol-src/index";
import { DEFAULT_POOL_CONFIG, DEFAULT_TEMPLATE } from "../../protocol-src/config/templates";
import { setupTestProtocol } from "../helpers";

describe("Certificate Lifecycle", () => {
  // ── Buy certificate ───────────────────────────────────────

  describe("buyCertificate", () => {
    it("barrier = S_0 * (1 - widthBps/BPS)", () => {
      const { protocol } = setupTestProtocol();
      const result = protocol.buyCertificate("lp-wallet-1", {
        positionMint: "pos-mint-1",
        templateId: 1,
      });
      // Entry = 150_000_000, width = 1000 → barrier = 150M * 0.90 = 135M
      expect(result.barrierE6).to.equal(135_000_000);
    });

    it("cap > 0 (natural cap computed from CL value function)", () => {
      const { protocol } = setupTestProtocol();
      const result = protocol.buyCertificate("lp-wallet-1", {
        positionMint: "pos-mint-1",
        templateId: 1,
      });
      expect(result.capUsdc).to.be.greaterThan(0);
    });

    it("premium >= P_floor", () => {
      const { protocol } = setupTestProtocol();
      const result = protocol.buyCertificate("lp-wallet-1", {
        positionMint: "pos-mint-1",
        templateId: 1,
      });
      expect(result.premiumUsdc).to.be.greaterThanOrEqual(50_000);
    });

    it("protocol fee = premium * protocolFeeBps / BPS", () => {
      const { protocol } = setupTestProtocol();
      const result = protocol.buyCertificate("lp-wallet-1", {
        positionMint: "pos-mint-1",
        templateId: 1,
      });
      const expectedFee = Math.floor((result.premiumUsdc * 150) / 10_000);
      expect(result.protocolFeeUsdc).to.equal(expectedFee);
    });

    it("pool reserves increase by (premium - protocolFee)", () => {
      const { protocol } = setupTestProtocol();
      const poolBefore = protocol.getPoolState()!;
      const reservesBefore = poolBefore.reservesUsdc;

      const result = protocol.buyCertificate("lp-wallet-1", {
        positionMint: "pos-mint-1",
        templateId: 1,
      });

      const poolAfter = protocol.getPoolState()!;
      const expectedIncrease = result.premiumUsdc - result.protocolFeeUsdc;
      expect(poolAfter.reservesUsdc - reservesBefore).to.equal(expectedIncrease);
    });

    it("activeCapUsdc increases by cap", () => {
      const { protocol } = setupTestProtocol();
      const capBefore = protocol.getPoolState()!.activeCapUsdc;

      const result = protocol.buyCertificate("lp-wallet-1", {
        positionMint: "pos-mint-1",
        templateId: 1,
      });

      const capAfter = protocol.getPoolState()!.activeCapUsdc;
      expect(capAfter - capBefore).to.equal(result.capUsdc);
    });

    it("position.protectedBy is set", () => {
      const { protocol } = setupTestProtocol();
      protocol.buyCertificate("lp-wallet-1", {
        positionMint: "pos-mint-1",
        templateId: 1,
      });

      const pos = protocol.getPositionState("pos-mint-1")!;
      expect(pos.protectedBy).to.not.be.null;
    });

    it("rejects if position already protected", () => {
      const { protocol } = setupTestProtocol();
      protocol.buyCertificate("lp-wallet-1", {
        positionMint: "pos-mint-1",
        templateId: 1,
      });

      expect(() =>
        protocol.buyCertificate("lp-wallet-1", {
          positionMint: "pos-mint-1",
          templateId: 1,
        }),
      ).to.throw("already protected");
    });

    it("rejects if utilization would exceed uMaxBps", () => {
      const { protocol } = setupTestProtocol({ rtDeposit: 1_000_000 }); // Only $1
      expect(() =>
        protocol.buyCertificate("lp-wallet-1", {
          positionMint: "pos-mint-1",
          templateId: 1,
        }),
      ).to.throw(); // Cap likely exceeds 30% of $1
    });
  });

  // ── Settle certificate ────────────────────────────────────

  describe("settleCertificate", () => {
    function buyAndExpire(): { protocol: OffchainLhProtocol; expiryTs: number } {
      const { protocol } = setupTestProtocol();
      const result = protocol.buyCertificate("lp-wallet-1", {
        positionMint: "pos-mint-1",
        templateId: 1,
      });
      return { protocol, expiryTs: result.expiryTs };
    }

    it("price > entry → payout < 0 (LP surrenders upside), state = SETTLED", () => {
      const { protocol, expiryTs } = buyAndExpire();
      const result = protocol.settleCertificate(
        "settler", "pos-mint-1", 160_000_000, 1_000_000, expiryTs,
      );
      expect(result.payoutUsdc).to.be.lessThan(0);
      expect(result.state).to.equal(CertificateStatus.Settled);
    });

    it("price = entry → payout = 0, state = EXPIRED", () => {
      const { protocol, expiryTs } = buyAndExpire();
      const result = protocol.settleCertificate(
        "settler", "pos-mint-1", 150_000_000, 1_000_000, expiryTs,
      );
      expect(result.payoutUsdc).to.equal(0);
      expect(result.state).to.equal(CertificateStatus.Expired);
    });

    it("barrier < price < entry → 0 < payout < cap, state = SETTLED", () => {
      const { protocol, expiryTs } = buyAndExpire();
      const cert = protocol.getCertificateState("pos-mint-1")!;
      const result = protocol.settleCertificate(
        "settler", "pos-mint-1", 142_000_000, 1_000_000, expiryTs,
      );
      expect(result.payoutUsdc).to.be.greaterThan(0);
      expect(result.payoutUsdc).to.be.lessThanOrEqual(cert.capUsdc);
      expect(result.state).to.equal(CertificateStatus.Settled);
    });

    it("price <= barrier → payout = cap, state = SETTLED", () => {
      const { protocol, expiryTs } = buyAndExpire();
      const cert = protocol.getCertificateState("pos-mint-1")!;
      const result = protocol.settleCertificate(
        "settler", "pos-mint-1", 120_000_000, 1_000_000, expiryTs,
      );
      // Payout should be at or near cap
      expect(result.payoutUsdc).to.be.closeTo(cert.capUsdc, cert.capUsdc * 0.01 + 1);
      expect(result.state).to.equal(CertificateStatus.Settled);
    });

    it("fee split = feeSplitRate * feesAccrued", () => {
      const { protocol, expiryTs } = buyAndExpire();
      const feesAccrued = 2_000_000; // $2 fees
      const result = protocol.settleCertificate(
        "settler", "pos-mint-1", 160_000_000, feesAccrued, expiryTs,
      );
      // feeSplitRate = 0.10
      expect(result.rtFeeIncomeUsdc).to.equal(200_000);
    });

    it("pool reserves update correctly: -payout + feeSplit", () => {
      const { protocol, expiryTs } = buyAndExpire();
      const reservesBefore = protocol.getPoolState()!.reservesUsdc;

      const result = protocol.settleCertificate(
        "settler", "pos-mint-1", 142_000_000, 1_000_000, expiryTs,
      );

      const reservesAfter = protocol.getPoolState()!.reservesUsdc;
      const expectedChange = -result.payoutUsdc + result.rtFeeIncomeUsdc;
      expect(reservesAfter - reservesBefore).to.equal(expectedChange);
    });

    it("activeCapUsdc decreases by cap", () => {
      const { protocol, expiryTs } = buyAndExpire();
      const cert = protocol.getCertificateState("pos-mint-1")!;
      const capBefore = protocol.getPoolState()!.activeCapUsdc;

      protocol.settleCertificate(
        "settler", "pos-mint-1", 160_000_000, 1_000_000, expiryTs,
      );

      const capAfter = protocol.getPoolState()!.activeCapUsdc;
      expect(capBefore - capAfter).to.equal(cert.capUsdc);
    });

    it("position.protectedBy cleared after settlement", () => {
      const { protocol, expiryTs } = buyAndExpire();
      protocol.settleCertificate(
        "settler", "pos-mint-1", 160_000_000, 1_000_000, expiryTs,
      );
      const pos = protocol.getPositionState("pos-mint-1")!;
      expect(pos.protectedBy).to.be.null;
    });

    it("rejects settlement before expiry", () => {
      const { protocol } = buyAndExpire();
      const nowTs = Math.floor(Date.now() / 1000); // Before expiry
      expect(() =>
        protocol.settleCertificate("settler", "pos-mint-1", 150_000_000, 0, nowTs),
      ).to.throw("not yet expired");
    });

    it("rejects settlement of already settled certificate", () => {
      const { protocol, expiryTs } = buyAndExpire();
      protocol.settleCertificate("settler", "pos-mint-1", 160_000_000, 0, expiryTs);
      expect(() =>
        protocol.settleCertificate("settler", "pos-mint-1", 160_000_000, 0, expiryTs + 1),
      ).to.throw("not active");
    });
  });
});
