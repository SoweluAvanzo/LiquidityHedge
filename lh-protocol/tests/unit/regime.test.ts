import { expect } from "chai";
import {
  resolveEffectiveMarkup,
  applySeverityFeedback,
  computeIvRvFromDualSource,
  isRegimeFresh,
  updateRegime,
} from "../../protocol-src/operations/regime";
import { PPM } from "../../protocol-src/types";
import { StateStore } from "../../protocol-src/state/store";
import { initPool } from "../../protocol-src/operations/pool";
import { DEFAULT_POOL_CONFIG, DEFAULT_TEMPLATE } from "../../protocol-src/config/templates";
import { makeRegime } from "../helpers";

describe("Regime & Severity", () => {
  // ── Effective markup ──────────────────────────────────────

  describe("resolveEffectiveMarkup", () => {
    it("floor binds when IV/RV < floor", () => {
      expect(resolveEffectiveMarkup(1.02, 1.05)).to.equal(1.05);
    });

    it("IV/RV binds when IV/RV > floor", () => {
      expect(resolveEffectiveMarkup(1.15, 1.05)).to.equal(1.15);
    });
  });

  // ── Severity feedback correction ──────────────────────────

  describe("applySeverityFeedback", () => {
    it("no change when expected = realized", () => {
      const result = applySeverityFeedback(380_000, 380_000, 380_000);
      expect(result).to.equal(380_000);
    });

    it("increases severity when realized > expected", () => {
      const result = applySeverityFeedback(380_000, 300_000, 400_000);
      expect(result).to.be.greaterThan(380_000);
    });

    it("decreases severity when realized < expected", () => {
      const result = applySeverityFeedback(380_000, 400_000, 300_000);
      expect(result).to.be.lessThan(380_000);
    });

    it("bounded by maxStep", () => {
      const maxStep = 25_000;
      const result = applySeverityFeedback(380_000, 100, 1_000_000, 200_000, maxStep);
      // Even with extreme error, step should be <= 25,000
      expect(Math.abs(result - 380_000)).to.be.lessThanOrEqual(maxStep);
    });

    it("result clamped to [1, PPM]", () => {
      const low = applySeverityFeedback(1, 1_000_000, 0);
      expect(low).to.be.greaterThanOrEqual(1);

      const high = applySeverityFeedback(PPM, 0, 1_000_000);
      expect(high).to.be.lessThanOrEqual(PPM);
    });
  });

  // ── IV/RV dual source ────────────────────────────────────

  describe("computeIvRvFromDualSource", () => {
    it("picks lower IV from two exchanges", () => {
      const result = computeIvRvFromDualSource(0.70, 0.65, 0.60);
      expect(result).to.not.be.null;
      expect(result!.iv).to.equal(0.65);
      expect(result!.source).to.equal("bybit");
    });

    it("uses single source when only one available", () => {
      const result = computeIvRvFromDualSource(0.70, null, 0.60);
      expect(result).to.not.be.null;
      expect(result!.iv).to.equal(0.70);
      expect(result!.source).to.equal("binance");
    });

    it("returns null when no IV data", () => {
      const result = computeIvRvFromDualSource(null, null, 0.60);
      expect(result).to.be.null;
    });

    it("computes correct IV/RV ratio", () => {
      const result = computeIvRvFromDualSource(0.70, 0.65, 0.60);
      expect(result!.ivRvRatio).to.be.closeTo(0.65 / 0.60, 0.001);
    });
  });

  // ── Regime freshness ──────────────────────────────────────

  describe("isRegimeFresh", () => {
    it("fresh when within 900 seconds", () => {
      const now = 1_000_000;
      const regime = makeRegime({ updatedAt: now - 500 });
      expect(isRegimeFresh(regime, now)).to.be.true;
    });

    it("stale when beyond 900 seconds", () => {
      const now = 1_000_000;
      const regime = makeRegime({ updatedAt: now - 1000 });
      expect(isRegimeFresh(regime, now)).to.be.false;
    });
  });

  // ── Full regime update ────────────────────────────────────

  describe("updateRegime", () => {
    it("creates regime with correct effective markup", () => {
      const store = new StateStore();
      initPool(store, { admin: "admin", ...DEFAULT_POOL_CONFIG });
      store.addTemplate(DEFAULT_TEMPLATE);

      const regime = updateRegime(store, {
        sigmaPpm: 650_000,
        sigma7dPpm: 700_000,
        stressFlag: false,
        carryBpsPerDay: 5,
        ivRvRatio: 1.12,
      }, "signer");

      expect(regime.effectiveMarkup).to.equal(1.12);
      expect(regime.sigmaPpm).to.equal(650_000);
    });

    it("clamps sigma to valid range", () => {
      const store = new StateStore();
      initPool(store, { admin: "admin", ...DEFAULT_POOL_CONFIG });
      store.addTemplate(DEFAULT_TEMPLATE);

      const regime = updateRegime(store, {
        sigmaPpm: 100, // Below min
        sigma7dPpm: 10_000_000, // Above max
        stressFlag: false,
        carryBpsPerDay: 5,
        ivRvRatio: 1.05,
      }, "signer");

      expect(regime.sigmaPpm).to.equal(1_000);
      expect(regime.sigma7dPpm).to.equal(5_000_000);
    });
  });
});
