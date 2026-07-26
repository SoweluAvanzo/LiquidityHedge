/**
 * Live discovery test — mainnet RPC, read-only.
 * Skipped automatically unless an RPC endpoint is available
 * (PORTFOLIO_RPC_URL env, or ANCHOR_PROVIDER_URL in lh-protocol/.env).
 * Wallet under test: PORTFOLIO_TEST_WALLET env, else the local LP dev
 * wallet's public key (lh-protocol-archive/wallet-lp.json) if present.
 */

import { expect } from "chai";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { fetchPortfolio, aggregatePortfolio } from "../../src";

const REPO_ROOT = resolve(__dirname, "../../../../..");

function rpcUrl(): string | null {
  if (process.env.PORTFOLIO_RPC_URL) return process.env.PORTFOLIO_RPC_URL;
  const envPath = resolve(REPO_ROOT, "lh-protocol/.env");
  if (!existsSync(envPath)) return null;
  const m = readFileSync(envPath, "utf8").match(/^ANCHOR_PROVIDER_URL=(.+)$/m);
  return m?.[1]?.trim() ?? null;
}

function testWallet(): PublicKey | null {
  if (process.env.PORTFOLIO_TEST_WALLET) {
    return new PublicKey(process.env.PORTFOLIO_TEST_WALLET);
  }
  const walletPath = resolve(REPO_ROOT, "lh-protocol-archive/wallet-lp.json");
  if (!existsSync(walletPath)) return null;
  const secret = Uint8Array.from(JSON.parse(readFileSync(walletPath, "utf8")));
  return Keypair.fromSecretKey(secret).publicKey; // public key only — never log the secret
}

describe("@lh/portfolio live discovery (mainnet, read-only)", function () {
  it("fetchPortfolio completes against mainnet for the dev wallet", async function () {
    const url = rpcUrl();
    const owner = testWallet();
    if (!url || !owner) return this.skip();
    this.timeout(60_000);

    const connection = new Connection(url, "confirmed");
    const views = await fetchPortfolio(connection, owner);

    expect(views).to.be.an("array");
    const summary = aggregatePortfolio(views);
    // eslint-disable-next-line no-console
    console.log(
      `      wallet ${owner.toBase58().slice(0, 8)}…: ` +
        `${summary.positionsCount} position(s), ${summary.inRangeCount} in range, ` +
        `≈$${summary.totalValueUsd.toFixed(2)} USDC-quoted`,
    );
    for (const v of views) {
      expect(v.priceUpper).to.be.greaterThan(v.priceLower);
      expect(v.valueQuote).to.be.at.least(0);
    }
  });
});
