/**
 * Liquidity Hedge Protocol — Public entry point (facade).
 *
 * After the component-oriented refactor (Phase A), the implementation
 * is split across:
 *
 *   external-interface/  - ILhProtocol
 *   orchestrator/        - OffchainLhProtocol class + flow composers
 *   orchestrator/lifecycle/ - Certificate Lifecycle Manager
 *   risk-analyser/       - regime snapshot, severity, IV/RV
 *   pricing-engine/      - FV, premium, heuristic, utilization, position-value math
 *   position-escrow/     - Orca NFT custody (currently: ix builders)
 *   pool-manager/        - RT deposits, shares, claims, fee-split
 *   market-data/         - external data adapters (Birdeye, Pyth, Deribit, ...)
 *   event-audit/         - StateStore, AuditLogger, typed events
 *
 * This file re-exports the public surface area so existing
 * imports `from "protocol-src"` keep working without churn.
 */

export * from "./orchestrator";
