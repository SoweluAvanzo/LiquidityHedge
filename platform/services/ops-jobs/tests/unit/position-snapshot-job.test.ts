import { expect } from "chai";
import type { Connection } from "@solana/web3.js";
import { capturePositionSnapshots } from "../../src/position-snapshot-job";

/**
 * §1.2 failure policy: an unreadable position yields NO snapshot (a
 * visible gap), never a guessed value. Full happy-path coverage lives in
 * the live verification script — synthetic account buffers would test
 * the decoder, not this job.
 */
describe("@lh/ops-jobs position snapshot job", () => {
  const TRACKED = [
    {
      position: "7Zt2ZaYkNyKidNBXvAsGRhpP66hSjnv67SBWCS9c2Bpu",
      positionMint: "MintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      whirlpool: "Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE",
      decimalsA: 9,
      decimalsB: 6,
    },
  ];

  it("reports unreadable positions as missing, never guessing", async () => {
    const connection = {
      getMultipleAccountsInfo: async (keys: unknown[]) => keys.map(() => null),
    } as unknown as Connection;
    const r = await capturePositionSnapshots(connection, TRACKED, 1_000);
    expect(r.captured).to.deep.equal([]);
    expect(r.missing).to.deep.equal([TRACKED[0].position]);
  });

  it("does nothing quietly when no positions are tracked", async () => {
    let called = 0;
    const connection = {
      getMultipleAccountsInfo: async () => {
        called++;
        return [];
      },
    } as unknown as Connection;
    const r = await capturePositionSnapshots(connection, [], 1_000);
    expect(r.captured).to.deep.equal([]);
    expect(r.missing).to.deep.equal([]);
    expect(called).to.equal(0);
  });
});
