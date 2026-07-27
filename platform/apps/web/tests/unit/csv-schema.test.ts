/**
 * The delivered CSV header must equal the published field specification.
 *
 * AUDIT #6: `/data` publishes a 14-field spec and tells buyers to read it
 * before paying, while the production COPY emitted 12 snake_case columns —
 * two advertised fields missing entirely and six renamed. Nothing caught
 * it because nothing compared the two.
 *
 * This test parses the actual SQL in the route and diffs its column
 * aliases against CSV_FIELDS. It is deliberately source-level rather than
 * database-level so it runs without Postgres and fails at build time.
 */

import { expect } from "chai";
import { readFileSync } from "fs";
import { join } from "path";

import { CSV_FIELDS } from "../../src/lib/landing-content";

const ROUTE = join(__dirname, "../../src/app/api/data/download/route.ts");

/** Column aliases from the COPY statement, in emitted order. */
function copyAliases(source: string): string[] {
  const start = source.indexOf("const sql = `COPY (");
  expect(start, "COPY statement not found in download route").to.be.greaterThan(-1);
  const end = source.indexOf("TO STDOUT", start);
  const body = source.slice(start, end);
  // Aliases are written as: AS "name"
  return [...body.matchAll(/AS\s+"([A-Za-z0-9_]+)"/g)].map((m) => m[1]);
}

describe("dataset CSV schema", () => {
  const source = readFileSync(ROUTE, "utf8");

  it("emits exactly the advertised fields, in the advertised order", () => {
    const advertised = CSV_FIELDS.map((f) => f.name);
    expect(copyAliases(source)).to.deep.equal(advertised);
  });

  it("advertises the 14 fields the landing copy claims", () => {
    expect(CSV_FIELDS).to.have.length(14);
  });

  it("has no snake_case aliases left (buyers parse by header name)", () => {
    const snake = copyAliases(source).filter((a) => a.includes("_"));
    expect(snake, `snake_case aliases: ${snake.join(", ")}`).to.deep.equal([]);
  });

  it("computes tvlQuote and quoteIsUsd rather than omitting them", () => {
    const aliases = copyAliases(source);
    expect(aliases).to.include("tvlQuote");
    expect(aliases).to.include("quoteIsUsd");
  });

  it("only inlines base58 mints into the SQL", () => {
    // The mint list cannot be a bind parameter (COPY takes none), so the
    // route validates each entry. Pin that guard.
    expect(source).to.match(/\[1-9A-HJ-NP-Za-km-z\]\{32,44\}/);
    expect(source).to.contain("refusing to inline non-base58 mint");
  });
});
