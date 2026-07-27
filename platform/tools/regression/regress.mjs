#!/usr/bin/env node
/**
 * /api/portfolio regression harness (remediation plan, Phase 1 preamble).
 *
 * Every Phase 1 step moves every number on every card. This harness makes
 * each movement DELIBERATE: capture a golden file before a change, diff
 * after, explain every moved field in REGRESSION_LOG.md before merging.
 *
 * Live prices move between captures, so a diff is never expected to be
 * empty — the point is attribution, not equality. The diff always prints
 * the spot-price movement first so mechanical movements can be told apart
 * from estimator changes.
 *
 *   node regress.mjs capture             # fetch → captures/<ts>.json + print reduced
 *   node regress.mjs diff <fileA> <fileB># compare two captures (raw or reduced)
 *   node regress.mjs diff <fileB>        # compare golden/portfolio.json vs fileB
 *   node regress.mjs accept <file>       # reduce <file> → golden/portfolio.json
 *
 * No dependencies; Node 22.
 */

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OWNER = process.env.REGRESSION_OWNER ?? "6A3JVW6LMuYE1eriipCPWchf1riGqem1cenpCyVMHAXj";
const URL_ = process.env.PORTFOLIO_URL ?? `http://localhost:8080/api/portfolio?owner=${OWNER}`;
const GOLDEN = path.join(HERE, "golden", "portfolio.json");
const CAPTURES = path.join(HERE, "captures");

/** Reduce a raw /api/portfolio response to the regression surface:
 *  every estimator output and its inputs, no charting payload. */
function reduce(raw) {
  const positions = {};
  for (const p of raw.positions ?? []) {
    positions[p.positionAddress] = {
      price: p.price,
      priceLower: p.priceLower,
      priceUpper: p.priceUpper,
      inRange: p.inRange,
      liquidity: p.liquidity,
      valueQuote: p.valueQuote,
      feeOwedA: p.feeOwedA,
      feeOwedB: p.feeOwedB,
      feesAreExact: p.feesAreExact,
      viability: p.viability, // full object — this IS the surface under repair
    };
  }
  return { asOf: raw.asOf, summary: raw.summary, positions };
}

const isRaw = (j) => Array.isArray(j.positions);
const load = (f) => {
  const j = JSON.parse(readFileSync(f, "utf8"));
  return isRaw(j) ? reduce(j) : j;
};

/** Flatten to dotted paths with scalar leaves. */
function flatten(obj, prefix = "", out = {}) {
  if (obj === null || typeof obj !== "object") {
    out[prefix] = obj;
    return out;
  }
  for (const [k, v] of Object.entries(obj)) {
    flatten(v, prefix ? `${prefix}.${k}` : k, out);
  }
  return out;
}

function fmt(v) {
  if (typeof v === "number") {
    if (Number.isInteger(v)) return String(v);
    return v.toPrecision(6);
  }
  return JSON.stringify(v);
}

function diff(goldenFile, newFile) {
  const a = load(goldenFile);
  const b = load(newFile);
  console.log(`golden: ${goldenFile} (asOf ${a.asOf})`);
  console.log(`new:    ${newFile} (asOf ${b.asOf})\n`);

  // Spot movement first — the mechanical explainer for most other moves.
  const addrs = [...new Set([...Object.keys(a.positions), ...Object.keys(b.positions)])];
  const spotA = a.positions[addrs[0]]?.price;
  const spotB = b.positions[addrs[0]]?.price;
  if (spotA && spotB) {
    const pct = ((spotB - spotA) / spotA) * 100;
    console.log(`SPOT: ${fmt(spotA)} -> ${fmt(spotB)}  (${pct >= 0 ? "+" : ""}${pct.toFixed(3)}%)\n`);
  }

  let moved = 0;
  for (const addr of addrs) {
    const fa = flatten(a.positions[addr] ?? {});
    const fb = flatten(b.positions[addr] ?? {});
    const keys = [...new Set([...Object.keys(fa), ...Object.keys(fb)])].sort();
    const lines = [];
    for (const k of keys) {
      const va = fa[k];
      const vb = fb[k];
      if (Object.is(va, vb)) continue;
      if (typeof va === "number" && typeof vb === "number") {
        const rel = va !== 0 ? ((vb - va) / Math.abs(va)) * 100 : Infinity;
        const relStr = Number.isFinite(rel) ? `${rel >= 0 ? "+" : ""}${rel.toFixed(2)}%` : "from 0";
        lines.push(`  ${k}: ${fmt(va)} -> ${fmt(vb)}  (${relStr})`);
      } else {
        lines.push(`  ${k}: ${fmt(va)} -> ${fmt(vb)}`);
      }
    }
    if (lines.length > 0) {
      console.log(`── ${addr.slice(0, 8)}… ──`);
      for (const l of lines) console.log(l);
      console.log();
      moved += lines.length;
    }
  }
  console.log(moved === 0 ? "no field moved." : `${moved} field(s) moved — every one must be explained in REGRESSION_LOG.md before merge.`);
}

async function capture() {
  const resp = await fetch(URL_);
  if (!resp.ok) throw new Error(`GET ${URL_} -> ${resp.status}`);
  const raw = await resp.json();
  if (!isRaw(raw)) throw new Error("response has no positions array");
  mkdirSync(CAPTURES, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(CAPTURES, `${ts}.json`);
  writeFileSync(file, JSON.stringify(raw, null, 1));
  console.log(file);
  return file;
}

function accept(file) {
  mkdirSync(path.dirname(GOLDEN), { recursive: true });
  writeFileSync(GOLDEN, JSON.stringify(load(file), null, 1));
  console.log(`golden updated from ${file}`);
}

const [cmd, x, y] = process.argv.slice(2);
if (cmd === "capture") {
  await capture();
} else if (cmd === "diff" && x && y) {
  diff(x, y);
} else if (cmd === "diff" && x) {
  diff(GOLDEN, x);
} else if (cmd === "accept" && x) {
  accept(x);
} else {
  console.error("usage: regress.mjs capture | diff [goldenFile] <newFile> | accept <file>");
  process.exit(2);
}
