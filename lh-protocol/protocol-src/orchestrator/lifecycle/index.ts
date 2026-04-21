/**
 * Certificate Lifecycle Manager (CLM) — sub-component of the
 * Protocol Orchestrator. Owns all time-driven flows across a
 * certificate's lifetime: monitoring, fee refresh, settlement
 * (with automatic Theorem 2.2 assertion), and auto-close of the
 * on-chain position.
 *
 * At deployment this can run in-process (as in `live-orca-test.ts`)
 * or as a standalone daemon (matching the `operator-service` pattern
 * on the `offchain-emulator` branch).
 */

export * from "./monitor";
export * from "./fee-refresher";
export * from "./settle";
export * from "./autoclose";
