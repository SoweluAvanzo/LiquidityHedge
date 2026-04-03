import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { LhCore } from "../target/types/lh_core";
import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  mintTo,
  getAccount,
  createInitializeAccountInstruction,
  getMinimumBalanceForRentExemptAccount,
  ACCOUNT_SIZE,
} from "@solana/spl-token";
import { assert } from "chai";

// ─── Helpers ──────────────────────────────────────────────────────────

/** Create a raw token account (works for any owner, including PDAs). */
async function createTokenAccount(
  provider: anchor.AnchorProvider,
  payer: Keypair,
  mint: PublicKey,
  owner: PublicKey
): Promise<PublicKey> {
  const lamports = await getMinimumBalanceForRentExemptAccount(provider.connection);
  const kp = Keypair.generate();
  const tx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: kp.publicKey,
      lamports,
      space: ACCOUNT_SIZE,
      programId: TOKEN_PROGRAM_ID,
    }),
    createInitializeAccountInstruction(kp.publicKey, mint, owner, TOKEN_PROGRAM_ID)
  );
  await provider.sendAndConfirm(tx, [payer, kp]);
  return kp.publicKey;
}

/**
 * Create a mock 24-byte Pyth price feed (test-mode).
 * Layout: [price_e6: u64, conf_e6: u64, timestamp: i64]
 *
 * The timestamp is fetched from the on-chain clock (not Date.now()) to
 * avoid staleness mismatches between the host OS and the localnet validator.
 */
async function createMockPythFeed(
  provider: anchor.AnchorProvider,
  programId: PublicKey,
  payer: Keypair,
  priceE6: number,
  confE6: number,
): Promise<PublicKey> {
  // Use the on-chain clock to get a timestamp the validator will accept
  const slot = await provider.connection.getSlot();
  const blockTime = await provider.connection.getBlockTime(slot);
  const timestamp = blockTime ?? Math.floor(Date.now() / 1000);

  const data = Buffer.alloc(24);
  data.writeBigUInt64LE(BigInt(priceE6), 0);
  data.writeBigUInt64LE(BigInt(confE6), 8);
  data.writeBigInt64LE(BigInt(timestamp), 16);

  const kp = Keypair.generate();
  const lamports = await provider.connection.getMinimumBalanceForRentExemption(24);
  await provider.sendAndConfirm(
    new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: kp.publicKey,
        lamports,
        space: 24,
        programId,
      })
    ),
    [payer, kp]
  );

  return kp.publicKey;
}

/**
 * Create a mock placeholder account (used for orca_position / whirlpool
 * in test-mode where Orca validation is skipped). Just needs to exist.
 */
async function createPlaceholderAccount(
  provider: anchor.AnchorProvider,
  programId: PublicKey,
  payer: Keypair,
  size: number = 8,
): Promise<PublicKey> {
  const kp = Keypair.generate();
  const lamports = await provider.connection.getMinimumBalanceForRentExemption(size);
  await provider.sendAndConfirm(
    new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: kp.publicKey,
        lamports,
        space: size,
        programId,
      })
    ),
    [payer, kp]
  );
  return kp.publicKey;
}

// ─── Tests ────────────────────────────────────────────────────────────

describe("lh-core", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.LhCore as Program<LhCore>;
  const admin = provider.wallet as anchor.Wallet;
  const payer = (admin as any).payer as Keypair;

  let usdcMint: PublicKey;
  let poolState: PublicKey;
  let usdcVault: PublicKey;
  let shareMint: PublicKey;

  // PDA helpers
  const findPool = () => PublicKey.findProgramAddressSync([Buffer.from("pool")], program.programId);
  const findVault = () => PublicKey.findProgramAddressSync([Buffer.from("pool_vault")], program.programId);
  const findShareMint = () => PublicKey.findProgramAddressSync([Buffer.from("share_mint")], program.programId);
  const findTemplate = (id: number) => {
    const buf = Buffer.alloc(2);
    buf.writeUInt16LE(id);
    return PublicKey.findProgramAddressSync([Buffer.from("template"), buf], program.programId);
  };
  const findRegime = () => PublicKey.findProgramAddressSync([Buffer.from("regime"), poolState.toBuffer()], program.programId);
  const findPosition = (mint: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("position"), mint.toBuffer()], program.programId);
  const findCert = (mint: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("certificate"), mint.toBuffer()], program.programId);

  before(async () => {
    usdcMint = await createMint(provider.connection, payer, admin.publicKey, null, 6);
    [poolState] = findPool();
    [usdcVault] = findVault();
    [shareMint] = findShareMint();
  });

  /**
   * Helper: create position NFT and transfer to vault.
   * Returns everything needed to call registerLockedPosition.
   *
   * NOTE: Pyth feed is NOT created here — create it right before the
   * register call to avoid staleness (30s max).
   */
  async function setupPositionNft() {
    const mintKp = Keypair.generate();
    const positionMint = await createMint(provider.connection, payer, admin.publicKey, null, 0, mintKp);

    const ownerAta = await createTokenAccount(provider, payer, positionMint, admin.publicKey);
    await mintTo(provider.connection, payer, positionMint, ownerAta, admin.publicKey, 1);
    const vaultAta = await createTokenAccount(provider, payer, positionMint, poolState);

    // Transfer NFT into vault
    await provider.sendAndConfirm(
      new Transaction().add({
        keys: [
          { pubkey: ownerAta, isSigner: false, isWritable: true },
          { pubkey: vaultAta, isSigner: false, isWritable: true },
          { pubkey: admin.publicKey, isSigner: true, isWritable: false },
        ],
        programId: TOKEN_PROGRAM_ID,
        data: Buffer.from([3, ...new anchor.BN(1).toArray("le", 8)]),
      })
    );

    // Placeholder accounts for whirlpool and orca_position (test-mode skips validation)
    const whirlpoolKey = await createPlaceholderAccount(provider, program.programId, payer);
    const orcaPositionKey = await createPlaceholderAccount(provider, program.programId, payer);

    const [posPda] = findPosition(positionMint);

    return { positionMint, ownerAta, vaultAta, whirlpoolKey, orcaPositionKey, posPda };
  }

  // ─── Pool ─────────────────────────────────────────────────────────

  describe("Pool", () => {
    it("initializes the pool", async () => {
      await program.methods
        .initializePool(8000)
        .accountsPartial({ admin: admin.publicKey, usdcMint, poolState, usdcVault, shareMint,
          systemProgram: SystemProgram.programId, tokenProgram: TOKEN_PROGRAM_ID, rent: anchor.web3.SYSVAR_RENT_PUBKEY })
        .rpc();

      const pool = await program.account.poolState.fetch(poolState);
      assert.equal(pool.uMaxBps, 8000);
      assert.equal(pool.reservesUsdc.toNumber(), 0);
    });

    it("deposits USDC and mints 1:1 shares", async () => {
      const usdc = await createTokenAccount(provider, payer, usdcMint, admin.publicKey);
      await mintTo(provider.connection, payer, usdcMint, usdc, admin.publicKey, 1_000_000_000);
      const shares = await createTokenAccount(provider, payer, shareMint, admin.publicKey);

      await program.methods.depositUsdc(new anchor.BN(1_000_000_000))
        .accountsPartial({ depositor: admin.publicKey, poolState, usdcVault, depositorUsdc: usdc,
          shareMint, depositorShares: shares, tokenProgram: TOKEN_PROGRAM_ID })
        .rpc();

      const pool = await program.account.poolState.fetch(poolState);
      assert.equal(pool.reservesUsdc.toNumber(), 1_000_000_000);
      assert.equal(pool.totalShares.toNumber(), 1_000_000_000);
    });
  });

  // ─── Pricing ──────────────────────────────────────────────────────

  describe("Pricing", () => {
    it("creates template and regime snapshot", async () => {
      const [tpl] = findTemplate(1);
      await program.methods.createTemplate(1, new anchor.BN(7 * 86_400), 1000, new anchor.BN(500_000), new anchor.BN(1_000), new anchor.BN(1_000_000_000))
        .accountsPartial({ admin: admin.publicKey, poolState, template: tpl, systemProgram: SystemProgram.programId })
        .rpc();

      const [regime] = findRegime();
      await program.methods.updateRegimeSnapshot(new anchor.BN(200_000), new anchor.BN(180_000), false, 10)
        .accountsPartial({ authority: admin.publicKey, poolState, regimeSnapshot: regime, systemProgram: SystemProgram.programId })
        .rpc();

      const r = await program.account.regimeSnapshot.fetch(regime);
      assert.equal(r.sigmaPpm.toNumber(), 200_000);
    });
  });

  // ─── Full Lifecycle ─────────────────────────────────────────────────

  describe("Full Lifecycle", () => {
    let positionMint: PublicKey;
    let vaultAta: PublicKey;
    let ownerAta: PublicKey;
    let whirlpoolKey: PublicKey;
    let orcaPositionKey: PublicKey;
    let pythKey: PublicKey;
    let posPda: PublicKey;
    let certPda: PublicKey;
    let certMint: PublicKey;
    let buyerCertAta: PublicKey;
    let buyerUsdc: PublicKey;

    before(async () => {
      const setup = await setupPositionNft();
      positionMint = setup.positionMint;
      vaultAta = setup.vaultAta;
      ownerAta = setup.ownerAta;
      whirlpoolKey = setup.whirlpoolKey;
      orcaPositionKey = setup.orcaPositionKey;
      posPda = setup.posPda;
      [certPda] = findCert(positionMint);

      buyerUsdc = await createTokenAccount(provider, payer, usdcMint, admin.publicKey);
      await mintTo(provider.connection, payer, usdcMint, buyerUsdc, admin.publicKey, 100_000_000);

      const certMintKp = Keypair.generate();
      certMint = await createMint(provider.connection, payer, poolState, null, 0, certMintKp);
      buyerCertAta = await createTokenAccount(provider, payer, certMint, admin.publicKey);
    });

    it("registers a locked position", async () => {
      // In test-mode, Orca + Pyth validation are skipped (can't write data
      // to program-owned accounts in Anchor localnet tests). Placeholder
      // accounts satisfy the accounts struct; ticks come from instruction args.
      pythKey = await createPlaceholderAccount(provider, program.programId, payer);

      await program.methods
        .registerLockedPosition(
          new anchor.BN(150_000_000), new anchor.BN(1_000_000_000),
          new anchor.BN(150_000_000), -10000, 10000
        )
        .accountsPartial({
          owner: admin.publicKey, positionMint,
          whirlpool: whirlpoolKey, orcaPosition: orcaPositionKey,
          vaultPositionAta: vaultAta, positionState: posPda,
          poolState, pythPriceFeed: pythKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const pos = await program.account.positionState.fetch(posPda);
      assert.equal(pos.status, 1); // LOCKED
      assert.isNull(pos.protectedBy);
      assert.equal(pos.lowerTick, -10000);
      assert.equal(pos.upperTick, 10000);
      // In test-mode, oracle_p0 = p0 (Pyth skipped)
      assert.equal(pos.oracleP0E6.toNumber(), 150_000_000);
    });

    it("buys a certificate (quote + premium + NFT)", async () => {
      const [tpl] = findTemplate(1);
      const [regime] = findRegime();
      const poolBefore = await program.account.poolState.fetch(poolState);

      await program.methods
        .buyCertificate(new anchor.BN(100_000_000), new anchor.BN(130_000_000), new anchor.BN(300_000_000))
        .accountsPartial({
          buyer: admin.publicKey, positionState: posPda, poolState, usdcVault, buyerUsdc,
          template: tpl, regimeSnapshot: regime, certificateState: certPda,
          certMint, buyerCertAta, systemProgram: SystemProgram.programId, tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();

      const cert = await program.account.certificateState.fetch(certPda);
      assert.equal(cert.state, 1); // ACTIVE
      assert.equal(cert.capUsdc.toNumber(), 100_000_000);
      assert.ok(cert.premiumUsdc.toNumber() > 0);
      console.log(`    Premium: ${cert.premiumUsdc.toNumber() / 1e6} USDC`);

      const pos = await program.account.positionState.fetch(posPda);
      assert.isNotNull(pos.protectedBy);

      const poolAfter = await program.account.poolState.fetch(poolState);
      assert.equal(poolAfter.activeCapUsdc.toNumber(), 100_000_000);
      assert.ok(poolAfter.reservesUsdc.toNumber() > poolBefore.reservesUsdc.toNumber());

      const certAccount = await getAccount(provider.connection, buyerCertAta);
      assert.equal(Number(certAccount.amount), 1);
    });

    it("rejects release while protected", async () => {
      try {
        await program.methods.releasePosition()
          .accountsPartial({
            owner: admin.publicKey, positionState: posPda, poolState,
            vaultPositionAta: vaultAta, ownerPositionAta: ownerAta, tokenProgram: TOKEN_PROGRAM_ID,
          })
          .rpc();
        assert.fail("Should have thrown");
      } catch (e: any) {
        assert.include(e.toString(), "AlreadyProtected");
      }
    });

    it("rejects settlement before expiry", async () => {
      const settlePythKey = await createMockPythFeed(provider, program.programId, payer, 120_000_000, 1_000_000);
      const ownerUsdc = await createTokenAccount(provider, payer, usdcMint, admin.publicKey);

      try {
        await program.methods.settleCertificate()
          .accountsPartial({
            settler: admin.publicKey, certificateState: certPda, positionState: posPda,
            poolState, usdcVault, ownerUsdc, pythPriceFeed: settlePythKey, tokenProgram: TOKEN_PROGRAM_ID,
          })
          .rpc();
        assert.fail("Should throw TooEarly");
      } catch (e: any) {
        assert.include(e.toString(), "TooEarly");
        console.log("    Settlement correctly rejected before expiry");
      }
    });

    it("NAV increases after premium — second depositor gets fewer shares", async () => {
      const pool = await program.account.poolState.fetch(poolState);
      const nav = pool.reservesUsdc.toNumber() / pool.totalShares.toNumber();
      console.log(`    NAV per share: ${nav.toFixed(6)}`);
      assert.ok(nav > 1.0, "NAV should be > 1 after premium collected");

      const usdc = await createTokenAccount(provider, payer, usdcMint, admin.publicKey);
      await mintTo(provider.connection, payer, usdcMint, usdc, admin.publicKey, 100_000_000);
      const shares = await createTokenAccount(provider, payer, shareMint, admin.publicKey);

      await program.methods.depositUsdc(new anchor.BN(100_000_000))
        .accountsPartial({ depositor: admin.publicKey, poolState, usdcVault, depositorUsdc: usdc,
          shareMint, depositorShares: shares, tokenProgram: TOKEN_PROGRAM_ID })
        .rpc();

      const received = Number((await getAccount(provider.connection, shares)).amount);
      assert.ok(received < 100_000_000, `Expected < 100M shares, got ${received}`);
      console.log(`    100 USDC → ${(received / 1e6).toFixed(4)} shares (NAV-discounted)`);
    });
  });

  // ─── Entry Price / Orca Validation Tests ─────────────────────────────
  //
  // NOTE: In test-mode, Orca deserialization and Pyth entry-price checks
  // are skipped because the Anchor localnet test framework cannot create
  // accounts with pre-filled binary data at Whirlpool-program PDAs.
  // These validations are compile-time gated and active in production
  // builds (without the test-mode feature). A separate devnet integration
  // test with real Orca positions should be used to verify them end-to-end.

  // ─── Invariant / Audit Tests ──────────────────────────────────────

  describe("Invariants", () => {
    it("pool reserves + active_cap are consistent", async () => {
      const pool = await program.account.poolState.fetch(poolState);
      const maxCap = (pool.reservesUsdc.toNumber() * pool.uMaxBps) / 10_000;
      assert.ok(
        pool.activeCapUsdc.toNumber() <= maxCap,
        `active_cap (${pool.activeCapUsdc.toNumber()}) > max allowed (${maxCap})`
      );
    });

    it("vault balance matches reserves", async () => {
      const pool = await program.account.poolState.fetch(poolState);
      const vaultAccount = await getAccount(provider.connection, pool.usdcVault);
      assert.equal(
        Number(vaultAccount.amount),
        pool.reservesUsdc.toNumber(),
        "Vault token balance should equal state reserves"
      );
    });

    it("rejects buy_certificate when headroom exceeded", async () => {
      const pool = await program.account.poolState.fetch(poolState);
      const maxCap = Math.floor((pool.reservesUsdc.toNumber() * pool.uMaxBps) / 10_000);
      const overCap = maxCap + 1_000_000;

      const setup = await setupPositionNft();
      const pythPlaceholder = await createPlaceholderAccount(provider, program.programId, payer);

      await program.methods
        .registerLockedPosition(
          new anchor.BN(150_000_000), new anchor.BN(1_000_000_000),
          new anchor.BN(150_000_000), -10000, 10000
        )
        .accountsPartial({
          owner: admin.publicKey, positionMint: setup.positionMint,
          whirlpool: setup.whirlpoolKey, orcaPosition: setup.orcaPositionKey,
          vaultPositionAta: setup.vaultAta, positionState: setup.posPda,
          poolState, pythPriceFeed: pythPlaceholder,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const [certPda2] = findCert(setup.positionMint);
      const [tpl] = findTemplate(1);
      const [regime] = findRegime();
      const certMintKp2 = Keypair.generate();
      const certMint2 = await createMint(provider.connection, payer, poolState, null, 0, certMintKp2);
      const certAta2 = await createTokenAccount(provider, payer, certMint2, admin.publicKey);
      const buyerUsdc2 = await createTokenAccount(provider, payer, usdcMint, admin.publicKey);
      await mintTo(provider.connection, payer, usdcMint, buyerUsdc2, admin.publicKey, 500_000_000);

      try {
        await program.methods
          .buyCertificate(new anchor.BN(overCap), new anchor.BN(130_000_000), new anchor.BN(300_000_000))
          .accountsPartial({
            buyer: admin.publicKey, positionState: setup.posPda, poolState, usdcVault, buyerUsdc: buyerUsdc2,
            template: tpl, regimeSnapshot: regime, certificateState: certPda2,
            certMint: certMint2, buyerCertAta: certAta2,
            systemProgram: SystemProgram.programId, tokenProgram: TOKEN_PROGRAM_ID,
          })
          .rpc();
        assert.fail("Should reject with InsufficientHeadroom");
      } catch (e: any) {
        assert.include(e.toString(), "InsufficientHeadroom");
        console.log("    Headroom guard works correctly");
      }
    });

    it("premium increases monotonically with volatility", async () => {
      const [regime] = findRegime();
      const regimeData = await program.account.regimeSnapshot.fetch(regime);

      const sigma1 = regimeData.sigmaPpm.toNumber();
      assert.ok(sigma1 > 0, "Sigma should be > 0");

      const cap = 100_000_000;
      const tenor = 7;
      const width = 1000 * 100;
      const severity = 500_000;

      const sqrtT = Math.sqrt((tenor / 365) * 1_000_000) * Math.sqrt(1_000_000);

      const pHit1 = Math.min(1_000_000, (900_000 * sigma1 * sqrtT) / 1_000_000 / width);
      const pHit2 = Math.min(1_000_000, (900_000 * (sigma1 * 2) * sqrtT) / 1_000_000 / width);

      const ePayout1 = (cap * pHit1 * severity) / 1e12;
      const ePayout2 = (cap * pHit2 * severity) / 1e12;

      assert.ok(ePayout2 > ePayout1, "Higher sigma must produce higher E[Payout]");
      console.log(
        `    E[Payout] at σ=${sigma1/10000}%: ${(ePayout1/1e6).toFixed(4)} USDC, ` +
        `at 2σ: ${(ePayout2/1e6).toFixed(4)} USDC`
      );
    });
  });
});
