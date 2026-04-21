#!/usr/bin/env ts-node
/**
 * phantom-to-keypair.ts
 *
 * Converts a Phantom-exported private key (base58 string) into the
 * solana-keygen JSON format (array of 64 bytes) that live-orca-test.ts
 * and the Solana CLI expect.
 *
 * The key is read from stdin with echo disabled; it is never logged,
 * never echoed, never passed via argv (so it won't appear in shell
 * history or process listings). The output file is written with
 * mode 0600 (owner read/write only).
 *
 * Usage:
 *   npx ts-node scripts/phantom-to-keypair.ts <output-path>
 *
 * Example:
 *   npx ts-node scripts/phantom-to-keypair.ts ../lh-protocol-archive/wallet-lp.json
 *
 * Then paste the Phantom key at the prompt and press Enter.
 */

import * as fs from "fs";
import * as path from "path";
import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";

function readHidden(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    stdin.resume();
    stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    let input = "";
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") {
          stdin.setRawMode(wasRaw);
          stdin.pause();
          stdin.off("data", onData);
          process.stdout.write("\n");
          resolve(input);
          return;
        } else if (ch === "\u0003") {
          stdin.setRawMode(wasRaw);
          process.exit(130);
        } else if (ch === "\u007f") {
          if (input.length > 0) {
            input = input.slice(0, -1);
            process.stdout.write("\b \b");
          }
        } else {
          input += ch;
          process.stdout.write("*");
        }
      }
    };
    stdin.on("data", onData);
  });
}

async function main(): Promise<void> {
  const outFileArg = process.argv[2];
  if (!outFileArg) {
    console.error(
      "Usage: npx ts-node scripts/phantom-to-keypair.ts <output-path>",
    );
    console.error("");
    console.error(
      "Example: npx ts-node scripts/phantom-to-keypair.ts ../lh-protocol-archive/wallet-lp.json",
    );
    process.exit(1);
  }
  const outFile = path.resolve(outFileArg);
  if (fs.existsSync(outFile)) {
    console.error(`Refusing to overwrite existing file: ${outFile}`);
    console.error("Move it aside first if you really want to replace it.");
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(outFile), { recursive: true });

  console.log();
  console.log(
    "Paste the base58 private key from Phantom (Settings → Show Private Key).",
  );
  console.log(
    "Characters will appear as '*'. The key is never logged or written to history.",
  );
  console.log();
  const pk = (await readHidden("Private key: ")).trim();

  if (pk.length === 0) {
    console.error("Empty input. Aborting.");
    process.exit(1);
  }

  let bytes: Uint8Array;
  try {
    bytes = bs58.decode(pk);
  } catch (e: unknown) {
    console.error(
      "Base58 decode failed. Did you paste the full key from Phantom?",
    );
    process.exit(1);
    throw e;
  }

  if (bytes.length !== 64) {
    console.error(
      `Expected a 64-byte secret key; got ${bytes.length} bytes.`,
    );
    console.error("Phantom's export should decode to exactly 64 bytes.");
    process.exit(1);
  }

  let kp: Keypair;
  try {
    kp = Keypair.fromSecretKey(bytes);
  } catch (e: unknown) {
    console.error("Failed to construct Solana Keypair from the bytes.");
    process.exit(1);
    throw e;
  }

  fs.writeFileSync(outFile, JSON.stringify(Array.from(bytes)), {
    mode: 0o600,
  });
  fs.chmodSync(outFile, 0o600);

  console.log();
  console.log(`✓ Wrote ${outFile} (mode 0600)`);
  console.log(`  Public key: ${kp.publicKey.toBase58()}`);
  console.log();
  console.log(
    "Tip: if you pasted the key into a shell that records history, clear it now:",
  );
  console.log("     history -c   (bash)   or   fc -p    (zsh)");
}

main().catch((err) => {
  console.error("FATAL:", err instanceof Error ? err.message : err);
  process.exit(1);
});
