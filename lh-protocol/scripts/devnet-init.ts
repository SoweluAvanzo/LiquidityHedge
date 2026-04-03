/**
 * devnet-init.ts — Initialize the Liquidity Hedge Protocol on devnet.
 *
 * Creates: pool, template, regime snapshot.
 * Usage: npx ts-node scripts/devnet-init.ts
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { LhCore } from "../target/types/lh_core";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.LhCore as Program<LhCore>;
  const admin = provider.wallet.publicKey;

  // Known devnet USDC mint (Circle)
  // Devnet USDC mint (NOT mainnet). Mainnet USDC: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
  const USDC_MINT = new PublicKey(
    "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" // devnet USDC
  );

  const [poolState] = PublicKey.findProgramAddressSync([Buffer.from("pool")], program.programId);
  const [usdcVault] = PublicKey.findProgramAddressSync([Buffer.from("pool_vault")], program.programId);
  const [shareMint] = PublicKey.findProgramAddressSync([Buffer.from("share_mint")], program.programId);

  console.log("Program ID:", program.programId.toBase58());
  console.log("Admin:", admin.toBase58());
  console.log("Pool PDA:", poolState.toBase58());

  // 1. Initialize Pool
  try {
    await program.methods
      .initializePool(8000) // 80% max utilization
      .accountsPartial({
        admin,
        usdcMint: USDC_MINT,
        poolState,
        usdcVault,
        shareMint,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();
    console.log("✓ Pool initialized (U_max = 80%)");
  } catch (e: any) {
    if (e.toString().includes("already in use")) {
      console.log("- Pool already initialized, skipping");
    } else {
      throw e;
    }
  }

  // 2. Create Template (7-day, 10% width, 50% severity)
  const templateId = 1;
  const buf = Buffer.alloc(2);
  buf.writeUInt16LE(templateId);
  const [templatePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("template"), buf],
    program.programId
  );

  try {
    await program.methods
      .createTemplate(
        templateId,
        new anchor.BN(7 * 86_400),   // 7 days in seconds
        1000,  // 10% width (1000 bps)
        new anchor.BN(500_000),       // 50% severity
        new anchor.BN(1_000),         // floor: 0.001 USDC
        new anchor.BN(1_000_000_000)  // ceiling: 1000 USDC
      )
      .accountsPartial({
        admin,
        poolState,
        template: templatePda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log("✓ Template 1 created (7d=604800s / 10% width / 50% severity)");
  } catch (e: any) {
    if (e.toString().includes("already in use")) {
      console.log("- Template 1 already exists, skipping");
    } else {
      throw e;
    }
  }

  // 3. Update Regime Snapshot
  const [regimePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("regime"), poolState.toBuffer()],
    program.programId
  );

  await program.methods
    .updateRegimeSnapshot(
      new anchor.BN(200_000),  // sigma: 20% annualized
      new anchor.BN(180_000),  // sigma_ma: 18%
      false,                   // no stress
      10                       // carry: 10 bps/day
    )
    .accountsPartial({
      authority: admin,
      poolState,
      regimeSnapshot: regimePda,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  console.log("✓ Regime snapshot updated (σ=20%, no stress)");

  console.log("\nDevnet initialization complete.");
}

main().catch(console.error);
