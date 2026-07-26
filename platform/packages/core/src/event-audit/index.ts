/**
 * Event/Audit component — cross-cutting persistence + event bus.
 *
 * Composes:
 *  - `StateStore` (protocol state persistence to JSON)
 *  - `AuditLogger` (append-only JSONL of every state transition)
 *  - typed `ProtocolEvent` union (so test assertions and future
 *    consumers share a vocabulary with the eventual on-chain events)
 */

export * from "./store";
export * from "./logger";
export * from "./events";
