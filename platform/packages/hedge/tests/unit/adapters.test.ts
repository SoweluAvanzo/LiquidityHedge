import { expect } from "chai";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { extractUsdcPayment } from "../../src/adapters/payment-parse";
import { buildPayoutInstructions, USDC_DECIMALS } from "../../src/adapters/payout";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const TREASURY_ATA = "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9";
const SENDER = "6A3JVW6LMuYE1eriipCPWchf1riGqem1cenpCyVMHAXj";

/** Minimal ParsedTransactionWithMeta-shaped fixture. */
function makeParsedTx(opts: {
  preAmount: string;
  postAmount: string;
  memo?: string;
  err?: unknown;
  mint?: string;
}) {
  return {
    slot: 1234,
    blockTime: 1_780_000_000,
    transaction: {
      signatures: ["SIGx1111"],
      message: {
        accountKeys: [
          { pubkey: new PublicKey(SENDER), signer: true, writable: true },
          { pubkey: new PublicKey(TREASURY_ATA), signer: false, writable: true },
        ],
        instructions: [
          ...(opts.memo !== undefined
            ? [{ program: "spl-memo", programId: new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"), parsed: opts.memo }]
            : []),
          { program: "spl-token", programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"), parsed: { type: "transferChecked" } },
        ],
      },
    },
    meta: {
      err: opts.err ?? null,
      preTokenBalances: [
        {
          accountIndex: 1,
          mint: opts.mint ?? USDC,
          owner: "treasuryOwner",
          uiTokenAmount: { amount: opts.preAmount, decimals: 6, uiAmount: 0, uiAmountString: "0" },
        },
      ],
      postTokenBalances: [
        {
          accountIndex: 1,
          mint: opts.mint ?? USDC,
          owner: "treasuryOwner",
          uiTokenAmount: { amount: opts.postAmount, decimals: 6, uiAmount: 0, uiAmountString: "0" },
        },
      ],
    },
  } as any;
}

describe("@lh/hedge Solana adapters", () => {
  const params = { treasuryAta: TREASURY_ATA, usdcMint: USDC };

  it("extracts an inbound USDC payment: delta + memo reference + sender", () => {
    const tx = makeParsedTx({ preAmount: "1000000", postAmount: "8500000", memo: "  REF42 " });
    const t = extractUsdcPayment(tx, params)!;
    expect(t).to.deep.equal({
      txSignature: "SIGx1111",
      referenceKey: "REF42",
      senderWallet: SENDER,
      amountUsdc: 7_500_000,
    });
  });

  it("rejects: failed tx, outbound/zero delta, missing memo, wrong mint", () => {
    expect(
      extractUsdcPayment(makeParsedTx({ preAmount: "1", postAmount: "10", memo: "R", err: { code: 1 } }), params),
    ).to.equal(null);
    expect(
      extractUsdcPayment(makeParsedTx({ preAmount: "10", postAmount: "5", memo: "R" }), params),
    ).to.equal(null);
    expect(
      extractUsdcPayment(makeParsedTx({ preAmount: "5", postAmount: "5", memo: "R" }), params),
    ).to.equal(null);
    expect(
      extractUsdcPayment(makeParsedTx({ preAmount: "1", postAmount: "10" }), params),
    ).to.equal(null); // unreferenced deposit is not a payment
    expect(
      extractUsdcPayment(
        makeParsedTx({ preAmount: "1", postAmount: "10", memo: "R", mint: "So11111111111111111111111111111111111111112" }),
        params,
      ),
    ).to.equal(null);
  });

  it("payout instructions: idempotent ATA create + transferChecked + memo", () => {
    const from = new PublicKey(SENDER);
    const to = new PublicKey("8Yv9Jz4z7BGN2yz9MYuFHt8W8vNumqavNRSHVCPCbqFN");
    const mint = new PublicKey(USDC);
    const ixs = buildPayoutInstructions({
      fromWallet: from,
      toWallet: to,
      usdcMint: mint,
      amountUsdc: 3_141_592,
      memo: "settle:Q1",
    });
    expect(ixs.length).to.equal(3);
    // ix0: ATA idempotent create for the recipient
    expect(ixs[0].programId.toBase58()).to.equal(
      "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
    );
    // ix1: transferChecked from the hot wallet's ATA to the recipient's ATA
    const fromAta = getAssociatedTokenAddressSync(mint, from);
    const toAta = getAssociatedTokenAddressSync(mint, to);
    expect(ixs[1].keys[0].pubkey.equals(fromAta)).to.equal(true);
    expect(ixs[1].keys[2].pubkey.equals(toAta)).to.equal(true);
    // transferChecked data: [12, amount u64 LE, decimals]
    expect(ixs[1].data[0]).to.equal(12);
    expect(ixs[1].data.readBigUInt64LE(1)).to.equal(3_141_592n);
    expect(ixs[1].data[9]).to.equal(USDC_DECIMALS);
    // ix2: memo carries the settlement reference
    expect(ixs[2].data.toString("utf8")).to.equal("settle:Q1");
    // Guards
    expect(() =>
      buildPayoutInstructions({ fromWallet: from, toWallet: to, usdcMint: mint, amountUsdc: 0, memo: "x" }),
    ).to.throw(/zero-amount/);
    expect(() =>
      buildPayoutInstructions({ fromWallet: from, toWallet: to, usdcMint: mint, amountUsdc: 1.5, memo: "x" }),
    ).to.throw(/safe integer/);
  });
});
