import { expect } from "chai";
import { commerceConfig } from "../../src/lib/server/order-ledger";

/**
 * Audit 0.1 empty-string class, third instance: compose passes
 * `USDC_MINT: ${USDC_MINT:-}` → "" which is NOT nullish, so
 * `process.env.USDC_MINT ?? default` let it through and
 * `new PublicKey("")` failed every payment chain check with
 * "Invalid public key input" (found live during the first real
 * self-purchase, 2026-07-29). Empty must mean unset.
 */
describe("commerceConfig (audit 0.1 empty-string class)", () => {
  const CANONICAL = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

  function withEnv(mint: string | undefined, fn: () => void) {
    const prevW = process.env.DATA_REVENUE_WALLET;
    const prevM = process.env.USDC_MINT;
    process.env.DATA_REVENUE_WALLET = "HwumKFctiiPFSWDbTuVCemCm8ZUJNrAwxB12Jg2H9HmS";
    if (mint === undefined) delete process.env.USDC_MINT;
    else process.env.USDC_MINT = mint;
    try {
      fn();
    } finally {
      if (prevW === undefined) delete process.env.DATA_REVENUE_WALLET;
      else process.env.DATA_REVENUE_WALLET = prevW;
      if (prevM === undefined) delete process.env.USDC_MINT;
      else process.env.USDC_MINT = prevM;
    }
  }

  it('treats USDC_MINT="" as unset — canonical mint served', () => {
    withEnv("", () => {
      expect(commerceConfig().usdcMint).to.equal(CANONICAL);
    });
  });

  it("treats whitespace as unset", () => {
    withEnv("  ", () => {
      expect(commerceConfig().usdcMint).to.equal(CANONICAL);
    });
  });

  it("honours an explicit override", () => {
    withEnv("SomeOtherMint1111111111111111111111111111111", () => {
      expect(commerceConfig().usdcMint).to.equal(
        "SomeOtherMint1111111111111111111111111111111",
      );
    });
  });
});
