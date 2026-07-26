import { expect } from "chai";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { buildDataReport, rowsToCsv } from "../../src/data-report";
import { sendReportViaResend } from "../../src/email-transport";

const Q64 = 1n << 64n;

describe("@lh/ops-jobs data export", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-report-"));
    fs.mkdirSync(path.join(dir, "snaps"));
    fs.mkdirSync(path.join(dir, "web"));
    const snaps = [
      { t: 1785000000, price: 75, liquidity: "1000000", feeGrowthGlobalA: "0", feeGrowthGlobalB: "0", vaultA: "200000000000", vaultB: "11000000000" },
      { t: 1785000900, price: 76, liquidity: "1000000", feeGrowthGlobalA: (5n * Q64).toString(), feeGrowthGlobalB: (7n * Q64).toString(), vaultA: "201000000000", vaultB: "11050000000" },
    ];
    fs.writeFileSync(path.join(dir, "snaps", "POOL1.snapshots.jsonl"),
      snaps.map((s) => JSON.stringify(s)).join("\n") + "\n");
    // A second, non-USD-quoted pool: proves the pool column and the
    // quote-unit flag (its TVL must never be summed into the USD total).
    fs.writeFileSync(path.join(dir, "snaps", "POOL2.snapshots.jsonl"),
      JSON.stringify({ t: 1785000000, price: 0.77, liquidity: "5", feeGrowthGlobalA: "0", feeGrowthGlobalB: "0", vaultA: "1000000000", vaultB: "1000000000" }) + "\n");
    fs.writeFileSync(path.join(dir, "snaps", "tracked-pools.json"), JSON.stringify({
      refreshedAt: 1785000000,
      pools: [
        { address: "POOL1", symbolA: "SOL", symbolB: "USDC", decimalsA: 9, decimalsB: 6, quoteMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" },
        { address: "POOL2", symbolA: "SOL", symbolB: "JitoSOL", decimalsA: 9, decimalsB: 9, quoteMint: "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn" },
      ],
    }));
    fs.writeFileSync(path.join(dir, "web", "pool-overview.jsonl"),
      JSON.stringify({ ts: "2026-07-26T14:00:00Z", whirlpool: "POOL1", volume24h: 1e6, tvl: 2.6e7, feeTier: 0.0004, poolDailyYield: 0.00038 }) + "\n");
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("rowsToCsv: union header, RFC-4180 quoting, empty for no rows", () => {
    const csv = rowsToCsv([{ a: 1, b: 'x,y' }, { a: 2, c: 'say "hi"' }]);
    const lines = csv.split("\n");
    expect(lines[0]).to.equal("a,b,c");
    expect(lines[1]).to.equal('1,"x,y",');
    expect(lines[2]).to.equal('2,,"say ""hi"""');
    expect(rowsToCsv([])).to.equal("");
  });

  it("builds CSV attachments with an on-chain TVL column and exact-yield notes", () => {
    const r = buildDataReport(
      { snapshotDir: path.join(dir, "snaps"), webDataDir: path.join(dir, "web") },
      "2026-07-26T15:00:00.000Z",
    );
    // ONE consolidated snapshots CSV (pool column), not one file per pool.
    expect(r.attachments.map((a) => a.filename)).to.deep.equal([
      "pool-snapshots.csv",
      "pool-overview.csv",
    ]);
    expect(r.datasets[0].name).to.match(/^Pool snapshots — 2 pools consolidated/);
    const csv = Buffer.from(r.attachments[0].content, "base64").toString("utf8");
    const header = csv.split("\n")[0].split(",");
    expect(header).to.include.members([
      "pool", "pair", "t", "iso", "price", "vaultA", "vaultB",
      "decimalsA", "decimalsB", "tvlQuote", "quoteIsUsd",
    ]);
    // Rows from BOTH pools, grouped by pool then time.
    const body = csv.split("\n").slice(1);
    expect(body.length).to.equal(3);
    expect(new Set(body.map((l) => l.split(",")[0])).size).to.equal(2);
    // POOL1 is USD-quoted: TVL = 200 SOL × $75 + $11,000 = $26,000.
    const p1 = body.find((l) => l.startsWith("POOL1"))!.split(",");
    expect(Number(p1[header.indexOf("tvlQuote")])).to.be.closeTo(200 * 75 + 11000, 1);
    expect(p1[header.indexOf("quoteIsUsd")]).to.equal("true");
    expect(p1[header.indexOf("pair")]).to.equal("SOL/USDC");
    // POOL2 quotes in a non-USD token → flagged, never summed as USD.
    const p2 = body.find((l) => l.startsWith("POOL2"))!.split(",");
    expect(p2[header.indexOf("quoteIsUsd")]).to.equal("false");
    // Cross-pool notes
    const notes = r.datasets[0].notes.join(" | ");
    expect(notes).to.match(/2 pools · 3 snapshots/);
    // Latest snapshot: 201 SOL × $76 + $11,050 = $26,326.
    expect(notes).to.match(/1 USD-quoted pools: \$26,326/);
    expect(notes).to.match(/top fee generators/);
    expect(r.text).to.match(/Data is attached as CSV/);
  });

  it("empty inputs produce an empty, well-formed report", () => {
    const r = buildDataReport({ snapshotDir: path.join(dir, "nope") }, "2026-07-26T15:00:00.000Z");
    expect(r.datasets).to.have.length(0);
    expect(r.attachments).to.have.length(0);
  });

  it("Resend transport posts the expected payload and surfaces API errors", async () => {
    const report = buildDataReport(
      { snapshotDir: path.join(dir, "snaps") },
      "2026-07-26T15:00:00.000Z",
    );
    let captured: any = null;
    const okFetch = (async (_url: string, init: any) => {
      captured = { url: _url, headers: init.headers, body: JSON.parse(init.body) };
      return { ok: true, status: 200, json: async () => ({ id: "email_123" }) };
    }) as unknown as typeof fetch;

    const res = await sendReportViaResend(report, {
      apiKey: "re_test", from: "LH <reports@example.com>",
      to: ["a@example.com", "b@example.com"], fetchImpl: okFetch,
    });
    expect(res.id).to.equal("email_123");
    expect(captured.url).to.equal("https://api.resend.com/emails");
    expect(captured.headers.Authorization).to.equal("Bearer re_test");
    expect(captured.body.to).to.deep.equal(["a@example.com", "b@example.com"]);
    expect(captured.body.attachments[0].filename).to.equal("pool-snapshots.csv");
    expect(captured.body.subject).to.match(/LH data export/);

    const errFetch = (async () => ({
      ok: false, status: 422, json: async () => ({ message: "domain not verified" }),
    })) as unknown as typeof fetch;
    let threw = "";
    await sendReportViaResend(report, {
      apiKey: "re_test", from: "x@y.z", to: ["a@b.c"], fetchImpl: errFetch,
    }).catch((e) => (threw = e.message));
    expect(threw).to.match(/Resend 422: domain not verified/);

    // Guards
    let g = "";
    await sendReportViaResend(report, { apiKey: "", from: "x", to: ["a"] }).catch((e) => (g = e.message));
    expect(g).to.match(/RESEND_API_KEY is required/);
  });
});
