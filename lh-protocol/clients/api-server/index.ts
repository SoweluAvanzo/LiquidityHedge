/**
 * HTTP API Server — wraps the OffchainLhProtocol with REST endpoints.
 *
 * Endpoints:
 *   GET  /api/health               — service health + regime freshness
 *   GET  /api/pool/state           — pool reserves, utilization, NAV
 *   GET  /api/regime               — current RegimeSnapshot
 *   GET  /api/templates            — list available templates
 *   GET  /api/templates/:id        — single template details
 *   GET  /api/quote                — compute premium for given params
 *   GET  /api/positions/:mint      — position details
 *   GET  /api/certificates/:mint   — certificate details
 *   POST /api/pool/deposit         — RT deposits USDC (requires txSignature)
 *   POST /api/pool/withdraw        — RT withdraws (requires shares count)
 *   POST /api/certificate/buy      — LP buys corridor certificate
 *   POST /api/certificate/settle   — settle expired certificate
 *
 * Usage: npx ts-node clients/api-server/index.ts
 *
 * Env vars:
 *   ANCHOR_PROVIDER_URL    — Solana RPC
 *   VAULT_KEYPAIR_PATH     — vault wallet JSON
 *   API_PORT               — listen port (default 3001)
 *   DATA_DIR               — state directory (default protocol/offchain-emulator/data/api)
 */

import * as express from "express";
import { Request, Response, NextFunction } from "express";
import * as cors from "cors";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

import { OffchainLhProtocol } from "../../protocol/offchain-emulator/index";
import { computeQuote } from "../../protocol/offchain-emulator/operations/pricing";
import { OPTIMIZED_TEMPLATES, OPTIMIZED_POOL } from "../../protocol/offchain-emulator/config/templates";

// ─── Setup ──────────────────────────────────────────────────────────

const PORT = parseInt(process.env.API_PORT || "3001", 10);
const RPC_URL = process.env.ANCHOR_PROVIDER_URL;
if (!RPC_URL) throw new Error("ANCHOR_PROVIDER_URL not set");

const vaultPath = process.env.VAULT_KEYPAIR_PATH ?? "./wallet-vault.json";
const vaultKeypair = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(vaultPath, "utf-8")))
);

const dataDir = process.env.DATA_DIR ??
  path.resolve(__dirname, "../../protocol/offchain-emulator/data/api");
fs.mkdirSync(dataDir, { recursive: true });

const connection = new Connection(RPC_URL, "confirmed");
const protocol = new OffchainLhProtocol(connection, vaultKeypair, dataDir);

// ─── Express App ────────────────────────────────────────────────────

const app = express();
app.use(cors());
app.use(express.json());

// Request logging
app.use((req: Request, _res: Response, next: NextFunction) => {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${req.method} ${req.path}`);
  next();
});

// Error wrapper
function asyncHandler(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch((err: Error) => {
      console.error(`[ERROR] ${req.method} ${req.path}: ${err.message}`);
      res.status(400).json({ error: err.message });
    });
  };
}

// ─── READ Endpoints ─────────────────────────────────────────────────

app.get("/api/health", asyncHandler(async (_req, res) => {
  let regimeAge = -1;
  let regimeOk = false;
  try {
    const regime = await protocol.getRegimeSnapshot();
    regimeAge = Math.floor(Date.now() / 1000) - regime.updatedTs;
    regimeOk = regimeAge <= 900;
  } catch { /* regime not initialized */ }

  let poolOk = false;
  try {
    await protocol.getPoolState();
    poolOk = true;
  } catch { /* pool not initialized */ }

  const templateCount = OPTIMIZED_TEMPLATES.length;
  const healthy = poolOk && regimeOk;

  res.json({
    status: healthy ? "healthy" : "degraded",
    pool: poolOk ? "initialized" : "not_initialized",
    regime: regimeOk ? "fresh" : regimeAge === -1 ? "not_initialized" : "stale",
    regimeAgeSec: regimeAge,
    templates: templateCount,
    vault: vaultKeypair.publicKey.toBase58(),
    timestamp: new Date().toISOString(),
  });
}));

app.get("/api/pool/state", asyncHandler(async (_req, res) => {
  const pool = await protocol.getPoolState();
  const utilization = pool.reservesUsdc > 0
    ? (pool.activeCapUsdc / pool.reservesUsdc * 100).toFixed(2)
    : "0.00";
  const navPerShare = pool.totalShares > 0
    ? (pool.reservesUsdc / pool.totalShares).toFixed(6)
    : "1.000000";

  res.json({
    reservesUsdc: pool.reservesUsdc,
    reservesUsdcFormatted: `$${(pool.reservesUsdc / 1e6).toFixed(2)}`,
    activeCapUsdc: pool.activeCapUsdc,
    totalShares: pool.totalShares,
    uMaxBps: pool.uMaxBps,
    utilizationPct: utilization,
    navPerShare,
    protocolFeeBps: pool.protocolFeeBps ?? 150,
    protocolFeesCollected: pool.protocolFeesCollected ?? 0,
    feeShareMinBps: pool.feeShareMinBps ?? 0,
    feeShareMaxBps: pool.feeShareMaxBps ?? 0,
    earlyExitPenaltyBps: pool.earlyExitPenaltyBps ?? 0,
  });
}));

app.get("/api/regime", asyncHandler(async (_req, res) => {
  const regime = await protocol.getRegimeSnapshot();
  const ageSec = Math.floor(Date.now() / 1000) - regime.updatedTs;
  res.json({
    sigmaPpm: regime.sigmaPpm,
    sigmaAnnualizedPct: (regime.sigmaPpm / 10_000).toFixed(2),
    sigmaMaPpm: regime.sigmaMaPpm,
    stressFlag: regime.stressFlag,
    carryBpsPerDay: regime.carryBpsPerDay,
    updatedTs: regime.updatedTs,
    ageSec,
    fresh: ageSec <= 900,
  });
}));

app.get("/api/templates", asyncHandler(async (_req, res) => {
  const templates = OPTIMIZED_TEMPLATES.map(t => ({
    ...t,
    tenorDays: t.tenorSeconds / 86400,
    widthPct: t.widthBps / 100,
  }));
  res.json({ templates });
}));

app.get("/api/templates/:id", asyncHandler(async (req, res) => {
  const id = parseInt(String(req.params.id), 10);
  const template = await protocol.getTemplate(id);
  res.json(template);
}));

app.get("/api/quote", asyncHandler(async (req, res) => {
  const templateId = parseInt(String(req.query.templateId || "1"), 10);
  const capUsdc = parseInt(String(req.query.capUsdc || "0"), 10);

  const pool = await protocol.getPoolState();
  const regime = await protocol.getRegimeSnapshot();
  const template = await protocol.getTemplate(templateId);

  const quote = computeQuote(capUsdc || 1_000_000, template, pool, regime);

  res.json({
    premiumUsdc: quote.premiumUsdc,
    premiumUsdFormatted: `$${(quote.premiumUsdc / 1e6).toFixed(4)}`,
    capUsdc: quote.capUsdc,
    expectedPayoutUsdc: quote.expectedPayoutUsdc,
    capitalChargeUsdc: quote.capitalChargeUsdc,
    adverseSelectionUsdc: quote.adverseSelectionUsdc,
    replicationCostUsdc: quote.replicationCostUsdc,
    premiumMultiplier: capUsdc > 0
      ? (quote.premiumUsdc / quote.expectedPayoutUsdc).toFixed(3)
      : "n/a",
    templateId,
    sigmaPpm: regime.sigmaPpm,
  });
}));

app.get("/api/positions/:mint", asyncHandler(async (req, res) => {
  const pos = await protocol.getPositionState(new PublicKey(req.params.mint));
  res.json(pos);
}));

app.get("/api/certificates/:mint", asyncHandler(async (req, res) => {
  const cert = await protocol.getCertificateState(new PublicKey(req.params.mint));
  res.json(cert);
}));

// ─── WRITE Endpoints ────────────────────────────────────────────────

app.post("/api/pool/deposit", asyncHandler(async (req, res) => {
  const { depositorSecretKey, amount, txSignature } = req.body;
  if (!depositorSecretKey || !amount || !txSignature) {
    throw new Error("Required: depositorSecretKey, amount, txSignature");
  }
  const depositor = Keypair.fromSecretKey(Uint8Array.from(depositorSecretKey));
  const result = await protocol.depositUsdc(depositor, amount, txSignature);
  res.json({ success: true, shares: result.shares });
}));

app.post("/api/pool/withdraw", asyncHandler(async (req, res) => {
  const { withdrawerSecretKey, shares } = req.body;
  if (!withdrawerSecretKey || !shares) {
    throw new Error("Required: withdrawerSecretKey, shares");
  }
  const withdrawer = Keypair.fromSecretKey(Uint8Array.from(withdrawerSecretKey));
  const result = await protocol.withdrawUsdc(withdrawer, shares);
  res.json({ success: true, usdcReturned: result.usdcReturned });
}));

app.post("/api/certificate/buy", asyncHandler(async (req, res) => {
  const {
    buyerSecretKey, positionMint, templateId,
    capUsdc, lowerBarrierE6, notionalUsdc, premiumTxSignature,
  } = req.body;
  if (!buyerSecretKey || !positionMint || !templateId || !premiumTxSignature) {
    throw new Error("Required: buyerSecretKey, positionMint, templateId, premiumTxSignature");
  }
  const buyer = Keypair.fromSecretKey(Uint8Array.from(buyerSecretKey));
  const result = await protocol.buyCertificate(buyer, {
    positionMint: new PublicKey(positionMint),
    templateId,
    capUsdc: capUsdc || 0,             // 0 = auto-compute natural cap
    lowerBarrierE6: lowerBarrierE6 || 0, // 0 = auto 90% of entry
    notionalUsdc: notionalUsdc || 0,
  }, premiumTxSignature);
  res.json({ success: true, ...result });
}));

app.post("/api/certificate/settle", asyncHandler(async (req, res) => {
  const { settlerSecretKey, positionMint } = req.body;
  if (!settlerSecretKey || !positionMint) {
    throw new Error("Required: settlerSecretKey, positionMint");
  }
  const settler = Keypair.fromSecretKey(Uint8Array.from(settlerSecretKey));
  const result = await protocol.settleCertificate(settler, new PublicKey(positionMint));
  res.json({ success: true, ...result });
}));

// ─── Start ──────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log("═".repeat(60));
  console.log(`Liquidity Hedge Protocol API Server`);
  console.log("═".repeat(60));
  console.log(`  Port:     ${PORT}`);
  console.log(`  RPC:      ${RPC_URL}`);
  console.log(`  Vault:    ${vaultKeypair.publicKey.toBase58()}`);
  console.log(`  Data:     ${dataDir}`);
  console.log(`  Templates: ${OPTIMIZED_TEMPLATES.length} (optimized)`);
  console.log();
  console.log("Endpoints:");
  console.log("  GET  /api/health");
  console.log("  GET  /api/pool/state");
  console.log("  GET  /api/regime");
  console.log("  GET  /api/templates");
  console.log("  GET  /api/quote?templateId=2&capUsdc=745000");
  console.log("  POST /api/pool/deposit");
  console.log("  POST /api/certificate/buy");
  console.log("  POST /api/certificate/settle");
  console.log();
  console.log("Ready.");
});
