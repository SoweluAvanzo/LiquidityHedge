/**
 * Protocol factory — creates the appropriate ILhProtocol implementation.
 *
 * Switch between off-chain emulator and on-chain contracts with a single
 * environment variable: PROTOCOL_MODE=offchain|onchain
 *
 * All consumers (demo scripts, services) use this factory, ensuring they
 * are decoupled from the implementation.
 */

import { Connection, Keypair } from "@solana/web3.js";
import { ILhProtocol } from "./interface";
import { OffchainLhProtocol } from "./offchain-emulator/index";

export type ProtocolMode = "offchain" | "onchain";

export interface ProtocolOptions {
  /** Required for offchain mode: vault wallet keypair */
  vaultKeypair?: Keypair;
  /** Required for offchain mode: directory for state + audit files */
  dataDir?: string;
  /** Required for onchain mode: Anchor program instance */
  program?: any; // anchor.Program<LhCore> — typed loosely to avoid hard dep
}

/**
 * Create a protocol implementation.
 *
 * @param mode - 'offchain' (emulator) or 'onchain' (Solana program)
 * @param connection - Solana RPC connection
 * @param opts - mode-specific options
 */
export function createProtocol(
  mode: ProtocolMode,
  connection: Connection,
  opts: ProtocolOptions
): ILhProtocol {
  if (mode === "onchain") {
    // Lazy import to avoid requiring Anchor when using offchain mode
    const { OnchainLhProtocol } = require("./onchain/index");
    if (!opts.program) {
      throw new Error("onchain mode requires opts.program (Anchor program)");
    }
    return new OnchainLhProtocol(connection, opts.program);
  }

  if (!opts.vaultKeypair) {
    throw new Error("offchain mode requires opts.vaultKeypair");
  }
  const dataDir = opts.dataDir || "./protocol-data";
  return new OffchainLhProtocol(connection, opts.vaultKeypair, dataDir);
}

/**
 * Get the protocol mode from environment.
 * Defaults to 'offchain' if not set.
 */
export function getProtocolMode(): ProtocolMode {
  const mode = process.env.PROTOCOL_MODE || "offchain";
  if (mode !== "offchain" && mode !== "onchain") {
    throw new Error(`Invalid PROTOCOL_MODE: ${mode}. Use 'offchain' or 'onchain'.`);
  }
  return mode;
}
