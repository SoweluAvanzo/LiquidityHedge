#!/usr/bin/env ts-node
/**
 * Recovery script — release stuck NFTs from vault and close Orca positions.
 */
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, createTransferInstruction, getAccount } from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
dotenv.config({ path: path.resolve(__dirname, "../.env") });

import { closeOrcaPosition } from "../tests/integration/cleanup";
import { decodeWhirlpoolAccount } from "../clients/cli/whirlpool-ix";
import { WHIRLPOOL_ADDRESS } from "../clients/cli/config";

function loadKp(p: string): Keypair {
  const raw = JSON.parse(fs.readFileSync(p.replace("~", process.env.HOME || ""), "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

async function main() {
  const conn = new Connection(process.env.ANCHOR_PROVIDER_URL!, "confirmed");
  const vault = loadKp(process.env.VAULT_KEYPAIR_PATH!);
  const lp = loadKp(process.env.WALLET_LP || process.env.ANCHOR_WALLET || "~/.config/solana/id.json");

  // Find all cleanup states
  const dataBase = path.resolve(__dirname, "../protocol/offchain-emulator/data");
  const dirs = fs.readdirSync(dataBase).filter(d => d.startsWith("integration-"));

  for (const dir of dirs) {
    const stateFile = path.join(dataBase, dir, "cleanup-state.json");
    if (!fs.existsSync(stateFile)) continue;
    const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
    if (!state.positionMint) continue;

    const mint = new PublicKey(state.positionMint);
    console.log(`\n=== ${state.positionMint.slice(0, 12)}... (${dir}) ===`);

    // Step 1: Release NFT from vault if still there
    if (state.nftInVault) {
      try {
        const vaultAta = getAssociatedTokenAddressSync(mint, vault.publicKey, true);
        const acc = await getAccount(conn, vaultAta);
        if (Number(acc.amount) > 0) {
          const lpAta = getAssociatedTokenAddressSync(mint, lp.publicKey);
          const tx = new Transaction().add(
            createTransferInstruction(vaultAta, lpAta, vault.publicKey, 1)
          );
          const sig = await conn.sendTransaction(tx, [vault]);
          await conn.confirmTransaction(sig, "confirmed");
          console.log("  NFT released to LP:", sig.slice(0, 20));
          state.nftInVault = false;
        } else {
          console.log("  NFT already released (vault balance = 0)");
          state.nftInVault = false;
        }
      } catch (e: any) {
        console.log("  NFT release skipped:", e.message);
      }
    }

    // Step 2: Close Orca position if still open
    if (state.positionOpen && state.liquidity && state.tickLower != null) {
      try {
        const wpInfo = await conn.getAccountInfo(WHIRLPOOL_ADDRESS);
        const wp = decodeWhirlpoolAccount(Buffer.from(wpInfo!.data));
        await closeOrcaPosition(
          conn, lp, mint, wp,
          BigInt(state.liquidity), state.tickLower, state.tickUpper
        );
        console.log("  Position closed, funds recovered.");
        state.positionOpen = false;
      } catch (e: any) {
        console.log("  Position close failed:", e.message);
      }
    }

    // Save updated state
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  }

  console.log("\nRecovery complete.");
}

main().catch(console.error);
