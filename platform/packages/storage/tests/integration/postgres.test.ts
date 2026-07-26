/**
 * Integration tests against a REAL PostgreSQL (Docker). Skipped when
 * TEST_DATABASE_URL is unset so the suite stays runnable offline.
 *
 * These prove the security posture, not just the happy path:
 * append-only grants must physically block UPDATE/DELETE for the writer.
 */
import { expect } from "chai";
import { Pool } from "pg";
import { createPool, migrate, safeDsn } from "../../src/pool";
import { PgPoolSnapshotStore, PgCandleStore, PgEventStore } from "../../src/stores";

const ADMIN = process.env.TEST_DATABASE_URL;          // migrator/owner
const WRITER = process.env.TEST_DATABASE_URL_WRITER;  // least-privilege

(ADMIN ? describe : describe.skip)("@lh/storage — PostgreSQL", function () {
  this.timeout(60_000);
  let admin: Pool;
  let writer: Pool | null = null;

  before(async () => {
    admin = createPool({ connectionString: ADMIN!, maxConnections: 3 });
    await migrate(admin);
    if (WRITER) writer = createPool({ connectionString: WRITER, maxConnections: 3 });
  });
  after(async () => {
    await admin?.end();
    await writer?.end();
  });

  it("pool snapshots: batch insert, read window, latest, idempotent re-ingest", async () => {
    const store = new PgPoolSnapshotStore(admin);
    const rows = [0, 1, 2].map((i) => ({
      pool: "POOLX",
      snapshot: {
        t: 1_785_000_000 + i * 900,
        price: 75 + i,
        liquidity: "1000000000000000",
        feeGrowthGlobalA: String(10n ** 20n + BigInt(i)),
        feeGrowthGlobalB: "5",
        vaultA: "200000000000",
        vaultB: "11000000000",
      },
    }));
    expect(await store.appendMany(rows)).to.equal(3);
    // Re-ingesting the same cycle is a no-op (PK conflict → DO NOTHING).
    expect(await store.appendMany(rows)).to.equal(0);

    const read = await store.read("POOLX", 1_785_000_000, 1_785_000_900);
    expect(read.map((r) => r.t)).to.deep.equal([1_785_000_000, 1_785_000_900]);
    // u128 values survive the round-trip exactly (numeric, not float).
    expect(read[0].feeGrowthGlobalA).to.equal(String(10n ** 20n));
    expect((await store.latest("POOLX"))!.t).to.equal(1_785_001_800);
    expect(await store.pools()).to.include("POOLX");
  });

  it("candles: upsert + read + latest", async () => {
    const store = new PgCandleStore(admin);
    const candles = [0, 1].map((i) => ({
      t: 1_785_000_000 + i * 86_400, o: 1, h: 2, l: 0.5, c: 1.5, v: 1000 + i,
    }));
    expect(await store.upsert("MINTX", "1D", candles)).to.equal(2);
    expect(await store.upsert("MINTX", "1D", candles)).to.equal(0);
    expect((await store.read("MINTX", "1D", 0, 2e12)).length).to.equal(2);
    expect(await store.latest("MINTX", "1D")).to.equal(1_785_086_400);
    expect(await store.latest("NOPE", "1D")).to.equal(null);
  });

  it("events: append-only stream with ordered reads", async () => {
    const store = new PgEventStore(admin);
    const id1 = await store.append("orders", { kind: "OrderCreated", orderId: "o1" });
    const id2 = await store.append("orders", { kind: "PaymentObserved", orderId: "o1" });
    expect(id2).to.be.greaterThan(id1);
    const all = await store.read("orders");
    expect(all.map((e) => (e.payload as { kind: string }).kind)).to.include.members([
      "OrderCreated", "PaymentObserved",
    ]);
    expect((await store.read("orders", { afterId: id1 }))[0].id).to.equal(id2);
    expect(await store.read("other-stream")).to.have.length(0);
  });

  (WRITER ? it : it.skip)("writer role is INSERT-only: UPDATE and DELETE are REFUSED", async () => {
    const store = new PgEventStore(writer!);
    await store.append("hedge", { kind: "test" }); // insert works

    let updateErr = "";
    await writer!.query(`UPDATE lh.events SET payload = '{}'::jsonb WHERE stream = 'hedge'`)
      .catch((e) => (updateErr = e.message));
    expect(updateErr).to.match(/permission denied/i);

    let deleteErr = "";
    await writer!.query(`DELETE FROM lh.events WHERE stream = 'hedge'`)
      .catch((e) => (deleteErr = e.message));
    expect(deleteErr).to.match(/permission denied/i);

    // Same for the snapshot history.
    let snapErr = "";
    await writer!.query(`DELETE FROM lh.pool_snapshots`).catch((e) => (snapErr = e.message));
    expect(snapErr).to.match(/permission denied/i);
  });

  (WRITER ? it : it.skip)("writer cannot escalate: no superuser, no schema DDL", async () => {
    let ddlErr = "";
    await writer!.query(`CREATE TABLE lh.evil (x int)`).catch((e) => (ddlErr = e.message));
    expect(ddlErr).to.match(/permission denied/i);
    const { rows } = await writer!.query(`SELECT usesuper FROM pg_user WHERE usename = current_user`);
    expect(rows[0]?.usesuper).to.equal(false);
  });

  it("safeDsn never leaks the password", () => {
    expect(safeDsn("postgres://u:supersecret@host:5432/db")).to.not.include("supersecret");
    expect(safeDsn("postgres://u:supersecret@host:5432/db")).to.include("***");
  });
});
