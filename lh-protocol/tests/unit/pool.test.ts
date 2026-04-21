import { expect } from "chai";
import {
  initPool,
  depositUsdc,
  withdrawUsdc,
  sharePrice,
  utilization,
  availableHeadroom,
} from "../../protocol-src/pool-manager/pool";
import { StateStore } from "../../protocol-src/event-audit/store";
import { DEFAULT_POOL_CONFIG } from "../../protocol-src/config/templates";
import { makePool } from "../helpers";

function freshStore(pool?: ReturnType<typeof makePool>): StateStore {
  const store = new StateStore();
  if (pool) {
    store.setPool(pool);
  }
  return store;
}

describe("Pool Operations", () => {
  // ── Initialization ────────────────────────────────────────

  describe("initPool", () => {
    it("initializes with zero reserves and shares", () => {
      const store = new StateStore();
      const pool = initPool(store, { admin: "admin", ...DEFAULT_POOL_CONFIG });
      expect(pool.reservesUsdc).to.equal(0);
      expect(pool.totalShares).to.equal(0);
    });

    it("rejects double initialization", () => {
      const store = new StateStore();
      initPool(store, { admin: "admin", ...DEFAULT_POOL_CONFIG });
      expect(() => initPool(store, { admin: "admin", ...DEFAULT_POOL_CONFIG })).to.throw("already initialized");
    });
  });

  // ── Deposit ───────────────────────────────────────────────

  describe("depositUsdc", () => {
    it("first deposit: shares = amount (1:1)", () => {
      const store = new StateStore();
      initPool(store, { admin: "admin", ...DEFAULT_POOL_CONFIG });
      const result = depositUsdc(store, "rt-1", 10_000_000);
      expect(result.shares).to.equal(10_000_000);
      expect(store.getShares("rt-1")).to.equal(10_000_000);
    });

    it("second deposit: shares proportional to NAV", () => {
      const store = new StateStore();
      initPool(store, { admin: "admin", ...DEFAULT_POOL_CONFIG });
      depositUsdc(store, "rt-1", 10_000_000);

      // Simulate premium income: increase reserves
      store.updatePool((p) => { p.reservesUsdc += 2_000_000; });
      // Pool: 12M reserves, 10M shares → share price = 1.2

      const result = depositUsdc(store, "rt-2", 6_000_000);
      // 6M * 10M / 12M = 5M shares
      expect(result.shares).to.equal(5_000_000);
    });

    it("share price = $1.00 for empty pool", () => {
      const pool = makePool({ reservesUsdc: 0, totalShares: 0 });
      expect(sharePrice(pool)).to.equal(1_000_000);
    });

    it("share price increases after premium income", () => {
      const pool1 = makePool({ reservesUsdc: 10_000_000, totalShares: 10_000_000 });
      const price1 = sharePrice(pool1);

      const pool2 = makePool({ reservesUsdc: 12_000_000, totalShares: 10_000_000 });
      const price2 = sharePrice(pool2);

      expect(price2).to.be.greaterThan(price1);
    });

    it("share price decreases after payout", () => {
      const pool1 = makePool({ reservesUsdc: 10_000_000, totalShares: 10_000_000 });
      const pool2 = makePool({ reservesUsdc: 8_000_000, totalShares: 10_000_000 });

      expect(sharePrice(pool2)).to.be.lessThan(sharePrice(pool1));
    });

    it("rejects zero or negative amount", () => {
      const store = new StateStore();
      initPool(store, { admin: "admin", ...DEFAULT_POOL_CONFIG });
      expect(() => depositUsdc(store, "rt-1", 0)).to.throw("positive");
      expect(() => depositUsdc(store, "rt-1", -100)).to.throw("positive");
    });
  });

  // ── Withdrawal ────────────────────────────────────────────

  describe("withdrawUsdc", () => {
    it("returns proportional USDC", () => {
      const store = new StateStore();
      initPool(store, { admin: "admin", ...DEFAULT_POOL_CONFIG });
      depositUsdc(store, "rt-1", 10_000_000);

      const result = withdrawUsdc(store, "rt-1", 5_000_000);
      expect(result.usdcReturned).to.equal(5_000_000);
    });

    it("deposit + full withdraw = no loss (conservation)", () => {
      const store = new StateStore();
      initPool(store, { admin: "admin", ...DEFAULT_POOL_CONFIG });
      const dep = depositUsdc(store, "rt-1", 10_000_000);
      const wd = withdrawUsdc(store, "rt-1", dep.shares);
      expect(wd.usdcReturned).to.equal(10_000_000);
    });

    it("utilization guard blocks dangerous withdrawal", () => {
      const store = new StateStore();
      initPool(store, { admin: "admin", ...DEFAULT_POOL_CONFIG });
      depositUsdc(store, "rt-1", 10_000_000);

      // Simulate active certificates
      store.updatePool((p) => { p.activeCapUsdc = 2_000_000; });
      // Min reserves = 2M * 10000 / 3000 = 6_666_667
      // If we withdraw 5M, post = 5M < 6.67M → should fail

      expect(() => withdrawUsdc(store, "rt-1", 5_000_000)).to.throw("utilization");
    });

    it("allows withdrawal when headroom sufficient", () => {
      const store = new StateStore();
      initPool(store, { admin: "admin", ...DEFAULT_POOL_CONFIG });
      depositUsdc(store, "rt-1", 10_000_000);
      store.updatePool((p) => { p.activeCapUsdc = 1_000_000; });
      // Min reserves = 1M * 10000 / 3000 ≈ 3.33M
      // Withdraw 3M → post = 7M > 3.33M → OK
      expect(() => withdrawUsdc(store, "rt-1", 3_000_000)).to.not.throw();
    });

    it("rejects withdrawal of more shares than owned", () => {
      const store = new StateStore();
      initPool(store, { admin: "admin", ...DEFAULT_POOL_CONFIG });
      depositUsdc(store, "rt-1", 10_000_000);
      expect(() => withdrawUsdc(store, "rt-1", 20_000_000)).to.throw("Insufficient");
    });
  });

  // ── Pool queries ──────────────────────────────────────────

  describe("utilization and headroom", () => {
    it("utilization = activeCap / reserves", () => {
      const pool = makePool({ reservesUsdc: 10_000_000, activeCapUsdc: 2_000_000 });
      expect(utilization(pool)).to.be.closeTo(0.2, 0.001);
    });

    it("utilization = 0 for empty pool", () => {
      const pool = makePool({ reservesUsdc: 0, activeCapUsdc: 0 });
      expect(utilization(pool)).to.equal(0);
    });

    it("headroom = maxCap - activeCap", () => {
      const pool = makePool({
        reservesUsdc: 10_000_000,
        activeCapUsdc: 1_000_000,
        uMaxBps: 3_000,
      });
      // maxCap = 10M * 3000 / 10000 = 3M
      // headroom = 3M - 1M = 2M
      expect(availableHeadroom(pool)).to.equal(2_000_000);
    });

    it("headroom = 0 when fully utilized", () => {
      const pool = makePool({
        reservesUsdc: 10_000_000,
        activeCapUsdc: 3_000_000,
        uMaxBps: 3_000,
      });
      expect(availableHeadroom(pool)).to.equal(0);
    });
  });
});
