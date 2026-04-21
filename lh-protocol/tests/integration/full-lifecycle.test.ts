/**
 * Integration Test — Full Lifecycle
 *
 * End-to-end tests covering the complete protocol lifecycle:
 *   1. Pool initialization and RT deposits
 *   2. Template creation and regime update
 *   3. Position registration and certificate purchase
 *   4. Settlement (price drop, price up, price crash)
 *   5. Position release and RT withdrawal
 *   6. Audit log and state serialization verification
 */

import { expect } from "chai";
import {
  OffchainLhProtocol,
  CertificateStatus,
  PositionStatus,
} from "../../protocol-src/index";
import {
  DEFAULT_POOL_CONFIG,
  DEFAULT_TEMPLATE,
} from "../../protocol-src/config/templates";
import { setupTestProtocol } from "../helpers";

describe("Full Lifecycle Integration", () => {
  // -------------------------------------------------------------------
  // Helper: run a complete lifecycle and return all intermediate state
  // -------------------------------------------------------------------

  function fullSetupAndBuy(positionMint = "pos-mint-1") {
    const { protocol, pool, template, regime, position } = setupTestProtocol();
    const poolAfterDeposit = protocol.getPoolState()!;

    const buyResult = protocol.buyCertificate("lp-wallet-1", {
      positionMint,
      templateId: 1,
    });

    const poolAfterBuy = protocol.getPoolState()!;
    const cert = protocol.getCertificateState(positionMint)!;

    return {
      protocol,
      poolAfterDeposit,
      poolAfterBuy,
      buyResult,
      cert,
      position,
    };
  }

  // -------------------------------------------------------------------
  // 1. Price drop -> settled with payout
  // -------------------------------------------------------------------

  it("Full lifecycle: price drop -> settled with payout", () => {
    const { protocol, poolAfterDeposit, buyResult } = fullSetupAndBuy();

    // Record pool state after certificate purchase
    const poolAfterBuy = protocol.getPoolState()!;
    const reservesAfterBuy = poolAfterBuy.reservesUsdc;

    // Settle at $142 (between barrier $135 and entry $150 -> partial payout)
    const settlementPrice = 142_000_000;
    const feesAccrued = 2_000_000; // $2 LP fees accrued during tenor
    const settleResult = protocol.settleCertificate(
      "settler",
      "pos-mint-1",
      settlementPrice,
      feesAccrued,
      buyResult.expiryTs,
    );

    // Payout should be > 0 (price dropped below entry)
    expect(settleResult.payoutUsdc).to.be.greaterThan(0);
    expect(settleResult.state).to.equal(CertificateStatus.Settled);

    // Fee split: RT gets 10% of accrued fees
    expect(settleResult.rtFeeIncomeUsdc).to.equal(
      Math.floor(0.1 * feesAccrued),
    );

    // Position released after settlement
    const pos = protocol.getPositionState("pos-mint-1")!;
    expect(pos.protectedBy).to.be.null;

    // Release position
    protocol.releasePosition("lp-wallet-1", "pos-mint-1");
    expect(protocol.getPositionState("pos-mint-1")!.status).to.equal(
      PositionStatus.Released,
    );

    // Pool reserves balance:
    //   initial deposit ($100) + premiumToPool - payout + feeSplit
    const premiumToPool =
      buyResult.premiumUsdc - buyResult.protocolFeeUsdc;
    const expectedReserves =
      100_000_000 +
      premiumToPool -
      settleResult.payoutUsdc +
      settleResult.rtFeeIncomeUsdc;
    // Capture the numeric value before withdrawal mutates the pool object
    const reservesBeforeWithdraw = protocol.getPoolState()!.reservesUsdc;
    expect(reservesBeforeWithdraw).to.equal(expectedReserves);

    // RT withdraws all shares
    const rtShares = protocol.getStore().getShares("rt-wallet-1");
    const withdrawResult = protocol.withdrawUsdc("rt-wallet-1", rtShares);
  });

  // -------------------------------------------------------------------
  // 2. Price up -> settled with LP→RT upside give-up (swap semantics)
  // -------------------------------------------------------------------

  it("Full lifecycle: price up -> LP surrenders upside to pool", () => {
    const { protocol, buyResult } = fullSetupAndBuy();

    const poolAfterBuy = protocol.getPoolState()!;

    // Settle at $160 (above entry $150 -> payout is negative: LP → pool)
    const feesAccrued = 3_000_000; // $3 LP fees
    const settleResult = protocol.settleCertificate(
      "settler",
      "pos-mint-1",
      160_000_000,
      feesAccrued,
      buyResult.expiryTs,
    );

    expect(settleResult.payoutUsdc).to.be.lessThan(0);
    expect(settleResult.state).to.equal(CertificateStatus.Settled);
    expect(settleResult.rtFeeIncomeUsdc).to.equal(
      Math.floor(0.1 * feesAccrued),
    );

    // Pool reserves: initial + premiumToPool − payoutUsdc (negative ⇒ gain)
    //                + feeSplit
    const poolAfterSettle = protocol.getPoolState()!;
    const premiumToPool =
      buyResult.premiumUsdc - buyResult.protocolFeeUsdc;
    const expectedReserves =
      100_000_000 +
      premiumToPool -
      settleResult.payoutUsdc + // subtracting a negative = adding
      settleResult.rtFeeIncomeUsdc;
    expect(poolAfterSettle.reservesUsdc).to.equal(expectedReserves);

    // ActiveCap should be back to 0
    expect(poolAfterSettle.activeCapUsdc).to.equal(0);

    // RT can withdraw more than deposit (premium + upside + fee split)
    const rtShares = protocol.getStore().getShares("rt-wallet-1");
    const withdrawResult = protocol.withdrawUsdc("rt-wallet-1", rtShares);
    expect(withdrawResult.usdcReturned).to.be.greaterThan(100_000_000);
  });

  // -------------------------------------------------------------------
  // 3. Price crash -> max payout (full cap)
  // -------------------------------------------------------------------

  it("Full lifecycle: price crash -> max payout (full cap)", () => {
    const { protocol, buyResult } = fullSetupAndBuy();
    const cert = protocol.getCertificateState("pos-mint-1")!;

    // Settle at $100 (well below barrier $135 -> payout = cap)
    const settleResult = protocol.settleCertificate(
      "settler",
      "pos-mint-1",
      100_000_000,
      1_000_000,
      buyResult.expiryTs,
    );

    // Payout should equal or be very close to cap
    expect(settleResult.payoutUsdc).to.be.closeTo(
      cert.capUsdc,
      cert.capUsdc * 0.01 + 1,
    );
    expect(settleResult.state).to.equal(CertificateStatus.Settled);

    // Pool absorbed the payout
    const poolAfter = protocol.getPoolState()!;
    expect(poolAfter.activeCapUsdc).to.equal(0);
  });

  // -------------------------------------------------------------------
  // 4. Multiple RTs deposit, shares proportional
  // -------------------------------------------------------------------

  it("Multiple RTs deposit, shares proportional", () => {
    const protocol = new OffchainLhProtocol();
    protocol.initPool("admin", DEFAULT_POOL_CONFIG);

    // RT1 deposits $100, RT2 deposits $200
    protocol.depositUsdc("rt-1", 100_000_000);
    protocol.depositUsdc("rt-2", 200_000_000);

    const shares1 = protocol.getStore().getShares("rt-1");
    const shares2 = protocol.getStore().getShares("rt-2");

    // RT2 should have 2x the shares of RT1
    expect(shares2).to.equal(shares1 * 2);

    // Total reserves
    const pool = protocol.getPoolState()!;
    expect(pool.reservesUsdc).to.equal(300_000_000);
    expect(pool.totalShares).to.equal(shares1 + shares2);
  });

  // -------------------------------------------------------------------
  // 5. Pool state consistency after full lifecycle
  // -------------------------------------------------------------------

  it("Pool state consistency after full lifecycle", () => {
    const { protocol, buyResult } = fullSetupAndBuy();

    const poolAfterBuy = protocol.getPoolState()!;
    const cert = protocol.getCertificateState("pos-mint-1")!;

    // ActiveCap should equal cert cap after buy
    expect(poolAfterBuy.activeCapUsdc).to.equal(cert.capUsdc);

    // Settle (moderate drop)
    const settleResult = protocol.settleCertificate(
      "settler",
      "pos-mint-1",
      145_000_000,
      1_500_000,
      buyResult.expiryTs,
    );

    const poolAfterSettle = protocol.getPoolState()!;

    // ActiveCap should be 0 after settlement
    expect(poolAfterSettle.activeCapUsdc).to.equal(0);

    // Reserves = pre-buy + premiumToPool - payout + feeSplit
    const premiumToPool =
      buyResult.premiumUsdc - buyResult.protocolFeeUsdc;
    const expectedReserves =
      100_000_000 +
      premiumToPool -
      settleResult.payoutUsdc +
      settleResult.rtFeeIncomeUsdc;
    expect(poolAfterSettle.reservesUsdc).to.equal(expectedReserves);

    // Share price should reflect the change
    // shares stayed the same (no deposits/withdrawals), reserves changed
    expect(poolAfterSettle.totalShares).to.equal(100_000_000);
  });

  // -------------------------------------------------------------------
  // 6. Audit log records all operations
  // -------------------------------------------------------------------

  it("Audit log records all operations", () => {
    const { protocol, buyResult } = fullSetupAndBuy();

    // Settle
    protocol.settleCertificate(
      "settler",
      "pos-mint-1",
      160_000_000,
      500_000,
      buyResult.expiryTs,
    );

    // Release
    protocol.releasePosition("lp-wallet-1", "pos-mint-1");

    const entries = protocol.getLogger().getEntries();
    const operations = entries.map((e) => e.operation);

    // Should have at least: initPool, depositUsdc, createTemplate,
    // updateRegimeSnapshot, registerLockedPosition, buyCertificate,
    // settleCertificate, releasePosition
    expect(operations).to.include("initPool");
    expect(operations).to.include("depositUsdc");
    expect(operations).to.include("createTemplate");
    expect(operations).to.include("updateRegimeSnapshot");
    expect(operations).to.include("registerLockedPosition");
    expect(operations).to.include("buyCertificate");
    expect(operations).to.include("settleCertificate");
    expect(operations).to.include("releasePosition");

    // All entries should be successes
    entries.forEach((e) => {
      expect(e.result).to.equal("success");
    });
  });

  // -------------------------------------------------------------------
  // 7. State serialization roundtrip
  // -------------------------------------------------------------------

  it("State serialization roundtrip", () => {
    const { protocol, buyResult } = fullSetupAndBuy();

    // Get the full state snapshot
    const state = protocol.getStore().getFullState();

    // Verify it contains all expected data
    expect(state.pool).to.not.be.null;
    expect(state.regime).to.not.be.null;
    expect(state.templates).to.have.length.greaterThanOrEqual(1);
    expect(state.positions).to.have.length.greaterThanOrEqual(1);
    expect(state.certificates).to.have.length.greaterThanOrEqual(1);
    expect(state.version).to.equal(1);

    // Serialize to JSON and back (verify no bigint serialization issues)
    // Note: bigint in position.liquidity needs special handling
    const serializable = {
      ...state,
      positions: state.positions.map((p) => ({
        ...p,
        liquidity: p.liquidity.toString(),
      })),
    };
    const json = JSON.stringify(serializable);
    const parsed = JSON.parse(json);

    expect(parsed.pool.reservesUsdc).to.equal(state.pool!.reservesUsdc);
    expect(parsed.regime.sigmaPpm).to.equal(state.regime!.sigmaPpm);
    expect(parsed.templates[0].templateId).to.equal(
      state.templates[0].templateId,
    );
    expect(parsed.certificates[0].positionMint).to.equal("pos-mint-1");
    expect(parsed.positions[0].positionMint).to.equal("pos-mint-1");

    // Share ledger should have the RT's shares
    expect(parsed.shareLedger["rt-wallet-1"]).to.be.greaterThan(0);
  });
});
