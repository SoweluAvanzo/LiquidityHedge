/**
 * Wallet challenge–response (AUDIT #11).
 *
 * These pin the properties that make the quote endpoint safe: a signature
 * is bound to one owner, one position and one nonce, and a nonce is spent
 * on first use whatever the outcome. Getting any of these wrong reopens
 * the denial-of-service the auth was added to close.
 */

import { expect } from "chai";
import { generateKeyPairSync, sign as edSign } from "crypto";
import { PublicKey } from "@solana/web3.js";

import {
  issueChallenge,
  challengeMessage,
  verifyWalletProof,
} from "../../src/lib/server/wallet-auth";

/** A throwaway ed25519 identity, exposed as a Solana base58 address. */
function wallet() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  return {
    address: new PublicKey(raw).toBase58(),
    sign: (msg: string) =>
      edSign(null, Buffer.from(msg, "utf8"), privateKey).toString("base64"),
  };
}

const POSITION = "PosMint1111111111111111111111111111111111111";

describe("wallet challenge-response", () => {
  it("accepts a correct signature", () => {
    const w = wallet();
    const { nonce } = issueChallenge(w.address);
    const sig = w.sign(
      challengeMessage({ owner: w.address, positionMint: POSITION, nonce }),
    );
    expect(
      verifyWalletProof({
        owner: w.address,
        positionMint: POSITION,
        nonce,
        signature: sig,
      }),
    ).to.deep.equal({ ok: true });
  });

  it("burns the nonce — a valid proof cannot be replayed", () => {
    const w = wallet();
    const { nonce } = issueChallenge(w.address);
    const sig = w.sign(
      challengeMessage({ owner: w.address, positionMint: POSITION, nonce }),
    );
    const args = {
      owner: w.address,
      positionMint: POSITION,
      nonce,
      signature: sig,
    };
    expect(verifyWalletProof(args).ok).to.equal(true);
    const second = verifyWalletProof(args);
    expect(second.ok).to.equal(false);
    if (!second.ok) expect(second.reason).to.contain("already-used");
  });

  it("burns the nonce even when the signature is wrong", () => {
    // Otherwise a captured challenge could be brute-forced.
    const w = wallet();
    const { nonce } = issueChallenge(w.address);
    const bad = Buffer.alloc(64, 7).toString("base64");
    expect(
      verifyWalletProof({ owner: w.address, positionMint: POSITION, nonce, signature: bad }).ok,
    ).to.equal(false);
    const good = w.sign(
      challengeMessage({ owner: w.address, positionMint: POSITION, nonce }),
    );
    const retry = verifyWalletProof({
      owner: w.address,
      positionMint: POSITION,
      nonce,
      signature: good,
    });
    expect(retry.ok).to.equal(false);
  });

  it("rejects a signature from a different wallet — the DoS vector", () => {
    // The attack: quote a stranger's position to lock them out of it.
    const victim = wallet();
    const attacker = wallet();
    const { nonce } = issueChallenge(victim.address);
    // Attacker signs the victim's challenge with their own key.
    const sig = attacker.sign(
      challengeMessage({ owner: victim.address, positionMint: POSITION, nonce }),
    );
    const res = verifyWalletProof({
      owner: victim.address,
      positionMint: POSITION,
      nonce,
      signature: sig,
    });
    expect(res.ok).to.equal(false);
    if (!res.ok) expect(res.status).to.equal(401);
  });

  it("rejects a nonce issued for a different owner", () => {
    const a = wallet();
    const b = wallet();
    const { nonce } = issueChallenge(a.address);
    const sig = b.sign(
      challengeMessage({ owner: b.address, positionMint: POSITION, nonce }),
    );
    const res = verifyWalletProof({
      owner: b.address,
      positionMint: POSITION,
      nonce,
      signature: sig,
    });
    expect(res.ok).to.equal(false);
    if (!res.ok) expect(res.reason).to.contain("different owner");
  });

  it("rejects a signature bound to another position", () => {
    // A signature for position A must not authorise position B.
    const w = wallet();
    const { nonce } = issueChallenge(w.address);
    const sig = w.sign(
      challengeMessage({ owner: w.address, positionMint: "OTHER", nonce }),
    );
    expect(
      verifyWalletProof({
        owner: w.address,
        positionMint: POSITION,
        nonce,
        signature: sig,
      }).ok,
    ).to.equal(false);
  });

  it("rejects unknown nonces and malformed input", () => {
    const w = wallet();
    for (const bad of [
      { nonce: "never-issued", signature: Buffer.alloc(64).toString("base64") },
      { nonce: undefined, signature: "x" },
      { nonce: "n", signature: undefined },
      { nonce: "n", signature: Buffer.alloc(10).toString("base64") }, // wrong length
    ]) {
      const res = verifyWalletProof({
        owner: w.address,
        positionMint: POSITION,
        ...bad,
      });
      expect(res.ok, JSON.stringify(bad)).to.equal(false);
    }
  });

  it("names the position and nonce in the signed message", () => {
    // The prompt a user sees must say what it authorises.
    const msg = challengeMessage({
      owner: "OWNER",
      positionMint: "POSITION",
      nonce: "NONCE",
    });
    expect(msg).to.contain("OWNER");
    expect(msg).to.contain("POSITION");
    expect(msg).to.contain("NONCE");
    expect(msg.toLowerCase()).to.contain("moves no funds");
  });
});
