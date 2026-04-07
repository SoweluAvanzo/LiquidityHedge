/**
 * Vault-managed Orca position operations (v2).
 * The vault opens/closes Orca positions on behalf of RT and LP users.
 */

import {
  Connection, Keypair, PublicKey, Transaction, LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  deriveOrcaPositionPda,
  deriveTickArrayPda,
  getTickArrayStartIndex,
  decodeWhirlpoolAccount,
  decodePositionAccount,
  alignTick,
  tickToSqrtPriceX64,
  sqrtPriceX64ToPrice,
  estimateLiquidity,
  buildOpenPositionIx,
  buildIncreaseLiquidityIx,
  deriveAta,
  WhirlpoolData,
} from "../../../clients/cli/whirlpool-ix";
import {
  getOrCreateAta,
  buildWrapSolIxs,
  buildUnwrapSolIx,
  sendTxWithRetry,
} from "../../../clients/cli/utils";
import { estimateTokenAmounts } from "../../../clients/cli/position-value";
import { closeOrcaPosition } from "../../../tests/integration/cleanup";
import { SOL_MINT, WHIRLPOOL_ADDRESS } from "../../../clients/cli/config";

export interface VaultPositionResult {
  positionMint: PublicKey;
  lowerTick: number;
  upperTick: number;
  liquidity: bigint;
  actualSolLamports: bigint;
  actualUsdcMicro: bigint;
  entryPrice: number;
}

/**
 * Open an Orca position with the vault as owner.
 * The vault keypair signs as both funder and position owner.
 */
export async function openVaultPosition(
  connection: Connection,
  vaultKeypair: Keypair,
  wp: WhirlpoolData,
  solLamports: bigint,
  usdcMicro: bigint,
  lowerTick: number,
  upperTick: number,
): Promise<VaultPositionResult> {
  const sqrtPriceLower = tickToSqrtPriceX64(lowerTick);
  const sqrtPriceUpper = tickToSqrtPriceX64(upperTick);
  const liquidity = estimateLiquidity(solLamports, usdcMicro, wp.sqrtPrice, sqrtPriceLower, sqrtPriceUpper);
  const tokenMaxA = (solLamports * BigInt(110)) / BigInt(100);
  const tokenMaxB = (usdcMicro * BigInt(110)) / BigInt(100);

  const positionMintKp = Keypair.generate();
  const positionMint = positionMintKp.publicKey;
  const [orcaPositionPda, positionBump] = deriveOrcaPositionPda(positionMint);
  const ownerPositionAta = deriveAta(vaultKeypair.publicKey, positionMint);

  const lowerStart = getTickArrayStartIndex(lowerTick, wp.tickSpacing);
  const upperStart = getTickArrayStartIndex(upperTick, wp.tickSpacing);
  const [tickArrayLower] = deriveTickArrayPda(WHIRLPOOL_ADDRESS, lowerStart);
  const [tickArrayUpper] = deriveTickArrayPda(WHIRLPOOL_ADDRESS, upperStart);

  const wsolAta = await getOrCreateAta(connection, vaultKeypair, SOL_MINT, vaultKeypair.publicKey);
  const usdcAta = await getOrCreateAta(connection, vaultKeypair, wp.tokenMintB, vaultKeypair.publicKey);

  const tx = new Transaction();
  tx.add(buildOpenPositionIx({
    funder: vaultKeypair.publicKey,
    owner: vaultKeypair.publicKey,
    positionPda: orcaPositionPda,
    positionBump,
    positionMint,
    positionTokenAccount: ownerPositionAta,
    whirlpool: WHIRLPOOL_ADDRESS,
    tickLowerIndex: lowerTick,
    tickUpperIndex: upperTick,
  }));
  tx.add(...buildWrapSolIxs(vaultKeypair.publicKey, wsolAta, Number(tokenMaxA)));
  tx.add(buildIncreaseLiquidityIx({
    whirlpool: WHIRLPOOL_ADDRESS,
    positionAuthority: vaultKeypair.publicKey,
    positionPda: orcaPositionPda,
    positionTokenAccount: ownerPositionAta,
    tokenOwnerAccountA: wsolAta,
    tokenOwnerAccountB: usdcAta,
    tokenVaultA: wp.tokenVaultA,
    tokenVaultB: wp.tokenVaultB,
    tickArrayLower,
    tickArrayUpper,
    liquidityAmount: liquidity,
    tokenMaxA,
    tokenMaxB,
  }));
  tx.add(buildUnwrapSolIx(wsolAta, vaultKeypair.publicKey));
  await sendTxWithRetry(connection, tx, [vaultKeypair, positionMintKp]);

  // Read actual on-chain position data
  const orcaPosInfo = await connection.getAccountInfo(orcaPositionPda);
  if (!orcaPosInfo) throw new Error("Position PDA not found after opening");
  const orcaPosData = decodePositionAccount(Buffer.from(orcaPosInfo.data));
  const actualLiquidity = orcaPosData.liquidity;

  // Read fresh whirlpool price for actual deposited amounts
  const wpInfo = await connection.getAccountInfo(WHIRLPOOL_ADDRESS);
  const wpFresh = decodeWhirlpoolAccount(Buffer.from(wpInfo!.data));
  const actualAmounts = estimateTokenAmounts(
    actualLiquidity, wpFresh.sqrtPrice, sqrtPriceLower, sqrtPriceUpper
  );
  const entryPrice = sqrtPriceX64ToPrice(wpFresh.sqrtPrice);

  return {
    positionMint,
    lowerTick,
    upperTick,
    liquidity: actualLiquidity,
    actualSolLamports: actualAmounts.amountA,
    actualUsdcMicro: actualAmounts.amountB,
    entryPrice,
  };
}

/**
 * Compute a wider tick range for an RT position.
 * Centers on the midpoint of the LP range with a configurable width multiplier.
 */
export function computeRtTickRange(
  lpLowerTick: number,
  lpUpperTick: number,
  tickSpacing: number,
  widthMultiplier: number = 2
): { lowerTick: number; upperTick: number } {
  const midTick = Math.floor((lpLowerTick + lpUpperTick) / 2);
  const lpWidth = lpUpperTick - lpLowerTick;
  const rtHalfWidth = Math.floor((lpWidth * widthMultiplier) / 2);
  return {
    lowerTick: alignTick(midTick - rtHalfWidth, tickSpacing, "down"),
    upperTick: alignTick(midTick + rtHalfWidth, tickSpacing, "up"),
  };
}

/**
 * Close a vault-owned Orca position. Recovers SOL + USDC + fees.
 */
export async function closeVaultPosition(
  connection: Connection,
  vaultKeypair: Keypair,
  positionMint: PublicKey,
  liquidity: bigint,
  lowerTick: number,
  upperTick: number,
): Promise<{ recoveredSol: number; recoveredUsdc: number }> {
  const wpInfo = await connection.getAccountInfo(WHIRLPOOL_ADDRESS);
  if (!wpInfo) throw new Error("Whirlpool not found");
  const wp = decodeWhirlpoolAccount(Buffer.from(wpInfo.data));

  const solBefore = await connection.getBalance(vaultKeypair.publicKey);
  await closeOrcaPosition(connection, vaultKeypair, positionMint, wp, liquidity, lowerTick, upperTick);
  const solAfter = await connection.getBalance(vaultKeypair.publicKey);

  return {
    recoveredSol: solAfter - solBefore,
    recoveredUsdc: 0, // USDC goes to vault ATA, tracked separately
  };
}

/**
 * LP deposits SOL + USDC → vault opens an Orca position AND buys a hedge certificate.
 * Compound operation wrapping openVaultPosition + registerLockedPosition + buyCertificate.
 */
export async function depositLpAndHedge(
  store: import("../state/store").StateStore,
  logger: import("../audit/logger").AuditLogger,
  connection: Connection,
  vaultKeypair: Keypair,
  lp: Keypair,
  solAmount: number,
  usdcAmount: number,
  templateId: number,
  capUsdc: number,
  barrierPct: number,
  premiumTxSignature: string,
): Promise<import("../../types").DepositLpAndHedgeResult> {
  const pool = store.getPool();
  if (!pool) throw new Error("Pool not initialized");

  const wpInfo = await connection.getAccountInfo(WHIRLPOOL_ADDRESS);
  if (!wpInfo) throw new Error("Whirlpool not found");
  const wp = decodeWhirlpoolAccount(Buffer.from(wpInfo.data));

  const tickWidth = 200;
  const lowerTick = alignTick(wp.tickCurrentIndex - tickWidth, wp.tickSpacing, "down");
  const upperTick = alignTick(wp.tickCurrentIndex + tickWidth, wp.tickSpacing, "up");

  const posResult = await openVaultPosition(
    connection, vaultKeypair, wp,
    BigInt(solAmount), BigInt(usdcAmount),
    lowerTick, upperTick,
  );

  // Register the locked position (vault already holds the NFT)
  const { registerLockedPosition } = await import("./escrow");
  await registerLockedPosition(
    store, logger, connection, vaultKeypair,
    lp,
    {
      positionMint: posResult.positionMint,
      whirlpool: WHIRLPOOL_ADDRESS,
      p0PriceE6: Math.floor(posResult.entryPrice * 1e6),
      depositedA: Number(posResult.actualSolLamports),
      depositedB: Number(posResult.actualUsdcMicro),
      lowerTick: posResult.lowerTick,
      upperTick: posResult.upperTick,
      pythFeed: WHIRLPOOL_ADDRESS,
    }
  );

  const barrierE6 = Math.floor(posResult.entryPrice * barrierPct * 1e6);
  const notionalUsdc = Math.floor(
    (Number(posResult.actualSolLamports) * posResult.entryPrice) / 1e9 * 1e6
    + Number(posResult.actualUsdcMicro)
  );

  const { buyCertificate } = await import("./certificates");
  const certResult = await buyCertificate(
    store, logger, connection,
    lp,
    {
      positionMint: posResult.positionMint,
      templateId,
      capUsdc,
      lowerBarrierE6: barrierE6,
      notionalUsdc,
    },
    premiumTxSignature,
  );

  logger.logOperation("depositLpAndHedge", {
    lp: lp.publicKey.toBase58(),
    positionMint: posResult.positionMint.toBase58(),
    certPremium: certResult.premiumUsdc,
  }, store.getVersion());

  return {
    positionMint: posResult.positionMint.toBase58(),
    certResult,
    lowerTick: posResult.lowerTick,
    upperTick: posResult.upperTick,
    liquidity: posResult.liquidity.toString(),
  };
}
