/**
 * Auto-close coordinator — closes an Orca Whirlpool CL position that
 * was opened by the protocol, in one atomic transaction:
 *
 *   1. wrap WSOL ATA idempotently (ensures destination ATA exists)
 *   2. decrease_liquidity (full amount, with slippage guard)
 *   3. collect_fees (sweeps fee_owed_{a,b} — required for close_position)
 *   4. close_position (burns the NFT, reclaims rent)
 *   5. unwrap SOL (closes the WSOL ATA, returns lamports to owner)
 *
 * Keeps repeat runs of the live demo from leaking capital into
 * orphan Orca positions.
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { getAccount } from "@solana/spl-token";
import {
  buildDecreaseLiquidityIx,
  buildCollectFeesIx,
  buildClosePositionIx,
  buildWrapSolIxs,
  buildUnwrapSolIx,
} from "../../position-escrow/orca-adapter";
import {
  decodePositionAccount,
  decodeWhirlpoolAccount,
} from "../../market-data/decoder";
import { estimateTokenAmounts } from "../../pricing-engine/position-value";

export interface AutoCloseContext {
  connection: Connection;
  lpWallet: Keypair;
  whirlpoolAddress: PublicKey;
  positionPda: PublicKey;
  positionMint: PublicKey;
  ownerPositionAta: PublicKey;
  wsolAta: PublicKey;
  lpUsdcAta: PublicKey;
  tickArrayLower: PublicKey;
  tickArrayUpper: PublicKey;
  sqrtPriceLower: bigint;
  sqrtPriceUpper: bigint;
  /** Slippage tolerance on decrease (BPS, e.g. 50 = 0.5%). */
  slippageBps: number;
}

export interface AutoCloseResult {
  skipped: boolean;
  txSignature?: string;
  postCloseLpSolLamports?: number;
  postCloseLpUsdcMicro?: number;
}

/** Send a tx with blockhash-retry (up to 3 attempts). */
async function sendTxWithRetry(
  connection: Connection,
  tx: Transaction,
  signers: Keypair[],
  maxRetries = 3,
): Promise<string> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await sendAndConfirmTransaction(connection, tx, signers, {
        commitment: "confirmed",
      });
    } catch (err: any) {
      const msg = err?.message || String(err);
      const isBlockhash =
        msg.includes("blockhash") && msg.includes("not found");
      if (isBlockhash && attempt < maxRetries) {
        const { blockhash, lastValidBlockHeight } =
          await connection.getLatestBlockhash("confirmed");
        tx.recentBlockhash = blockhash;
        tx.lastValidBlockHeight = lastValidBlockHeight;
        continue;
      }
      throw err;
    }
  }
  throw new Error("sendTxWithRetry: max retries exceeded");
}

/**
 * Close the position on-chain. If `liquidity == 0` already, returns
 * `{ skipped: true }` without emitting a tx. Returns the closing tx
 * signature + post-close LP balances on success.
 */
export async function autoClosePosition(
  ctx: AutoCloseContext,
): Promise<AutoCloseResult> {
  const posAcctNow = await ctx.connection.getAccountInfo(ctx.positionPda);
  if (!posAcctNow) {
    return { skipped: true };
  }
  const posNow = decodePositionAccount(Buffer.from(posAcctNow.data));
  if (posNow.liquidity === 0n) {
    return { skipped: true };
  }
  const wpAcct = await ctx.connection.getAccountInfo(ctx.whirlpoolAddress);
  if (!wpAcct) {
    throw new Error("Whirlpool account missing at auto-close");
  }
  const wpNow = decodeWhirlpoolAccount(Buffer.from(wpAcct.data));
  const { amountA: estA, amountB: estB } = estimateTokenAmounts(
    posNow.liquidity,
    wpNow.sqrtPrice,
    ctx.sqrtPriceLower,
    ctx.sqrtPriceUpper,
  );
  const minA =
    (estA * BigInt(10_000 - ctx.slippageBps)) / 10_000n;
  const minB =
    (estB * BigInt(10_000 - ctx.slippageBps)) / 10_000n;

  const closeTx = new Transaction();
  closeTx.add(
    ...buildWrapSolIxs(ctx.lpWallet.publicKey, ctx.wsolAta, 0n),
  );
  closeTx.add(
    buildDecreaseLiquidityIx({
      whirlpool: ctx.whirlpoolAddress,
      positionAuthority: ctx.lpWallet.publicKey,
      positionPda: ctx.positionPda,
      positionTokenAccount: ctx.ownerPositionAta,
      tokenOwnerAccountA: ctx.wsolAta,
      tokenOwnerAccountB: ctx.lpUsdcAta,
      tokenVaultA: wpNow.tokenVaultA,
      tokenVaultB: wpNow.tokenVaultB,
      tickArrayLower: ctx.tickArrayLower,
      tickArrayUpper: ctx.tickArrayUpper,
      liquidityAmount: posNow.liquidity,
      tokenMinA: minA,
      tokenMinB: minB,
    }),
  );
  closeTx.add(
    buildCollectFeesIx({
      whirlpool: ctx.whirlpoolAddress,
      positionAuthority: ctx.lpWallet.publicKey,
      positionPda: ctx.positionPda,
      positionTokenAccount: ctx.ownerPositionAta,
      tokenOwnerAccountA: ctx.wsolAta,
      tokenVaultA: wpNow.tokenVaultA,
      tokenOwnerAccountB: ctx.lpUsdcAta,
      tokenVaultB: wpNow.tokenVaultB,
    }),
  );
  closeTx.add(
    buildClosePositionIx({
      positionAuthority: ctx.lpWallet.publicKey,
      receiver: ctx.lpWallet.publicKey,
      positionPda: ctx.positionPda,
      positionMint: ctx.positionMint,
      positionTokenAccount: ctx.ownerPositionAta,
    }),
  );
  closeTx.add(buildUnwrapSolIx(ctx.wsolAta, ctx.lpWallet.publicKey));

  const txSignature = await sendTxWithRetry(ctx.connection, closeTx, [
    ctx.lpWallet,
  ]);

  const postSolLamports = await ctx.connection.getBalance(
    ctx.lpWallet.publicKey,
  );
  let postUsdcMicro = 0;
  try {
    postUsdcMicro = Number(
      (await getAccount(ctx.connection, ctx.lpUsdcAta)).amount,
    );
  } catch {
    /* ignore */
  }

  return {
    skipped: false,
    txSignature,
    postCloseLpSolLamports: postSolLamports,
    postCloseLpUsdcMicro: postUsdcMicro,
  };
}
