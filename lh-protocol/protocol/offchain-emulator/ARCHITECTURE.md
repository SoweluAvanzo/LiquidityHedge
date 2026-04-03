# Off-Chain Protocol Emulator — Architecture & Design Rationale

## Why Off-Chain?

Deploying the custom Solana program `lh_core` (498 KB binary) requires ~3.47 SOL (~$520) in rent-exempt balance. For a PoC validating protocol feasibility with small amounts ($25 in capital), this cost is disproportionate. The off-chain emulator replicates the protocol logic exactly while avoiding program deployment — reducing total cost from ~$550 to ~$25.

The emulator is **not a simulation**. It executes real Solana transactions:
- Real Orca Whirlpool positions are opened on mainnet
- Real USDC transfers flow between wallets
- Real Pyth oracle prices are read from on-chain feeds
- Real position NFTs are held in custody by the vault wallet

Only the protocol state management and business logic run off-chain.

## Correspondence: On-Chain ↔ Off-Chain

Every on-chain instruction maps 1:1 to an emulator method with identical logic:

| On-Chain Instruction | Off-Chain Method | Logic | Execution |
|---|---|---|---|
| `initialize_pool` | `initPool()` | Identical fields, validation | Creates vault ATA (real tx) |
| `deposit_usdc` | `depositUsdc()` | Identical NAV formula | Verifies real USDC transfer |
| `withdraw_usdc` | `withdrawUsdc()` | Identical utilization guard | Sends real USDC from vault |
| `register_locked_position` | `registerLockedPosition()` | Identical Orca + Pyth validation | Reads real Orca/Pyth accounts |
| `release_position` | `releasePosition()` | Identical auth + status checks | Sends real NFT from vault |
| `create_template` | `createTemplate()` | Identical validation bounds | Local state only |
| `update_regime_snapshot` | `updateRegimeSnapshot()` | Identical param bounds | Local state only |
| `buy_certificate` | `buyCertificate()` | Identical quote formula | Verifies real USDC premium |
| `settle_certificate` | `settleCertificate()` | Identical payout formula | Reads real Pyth, sends real USDC |

### What Is Identical

- **Pricing formula** (`computeQuote`): exact port of `pricing/instructions.rs:149-239`
  - `E[Payout] = Cap * p_hit(sigma, T, width) * severity / PPM^2`
  - `C_cap = Cap * (U_after/PPM)^2 / 5`
  - `C_adv = Cap/10 if stress, else 0`
  - `C_rep = Cap * carry * tenor_seconds / BPS / (100 * 86400)`
  - Premium clamped to `[floor, ceiling]`
- **Payout formula** (`settleCertificate`): exact port of `certificates/instructions.rs:258-272`
  - Conservative price: `price_e6 - conf_e6`
  - Proportional: `min(cap, (barrier - price) * notional / barrier)`
- **NAV-based share pricing**: `shares = amount * totalShares / reserves`
- **Utilization guard**: `postReserves >= activeCapUsdc * BPS / uMaxBps`
- **Orca account parsing**: same byte offsets as `orca.rs`
  - Position: discriminator@0, whirlpool@8, position_mint@40, liquidity@72, ticks@88-96
  - Whirlpool: discriminator@0, tick_spacing@41, sqrt_price@65, tick_current@81, mints@101/181
- **Pyth V2 parsing**: same byte offsets as `pyth.rs`
  - Magic@0, status@172, price@208, conf@216, expo@224, timestamp@232
- **Validation checks**: staleness (30s), confidence (5%), entry price tolerance (5%), regime freshness (900s)
- **State types**: every field in `state.rs` is mirrored in `types.ts`
- **State machines**: `LOCKED→RELEASED`, `ACTIVE→SETTLED/EXPIRED`
- **Integer math**: `integerSqrt` (Newton's method), all operations use integer arithmetic

### What Is Different

| Aspect | On-Chain | Off-Chain Emulator |
|---|---|---|
| **Trust model** | Trustless (program logic enforced by validators) | Trusted operator (service controls vault keypair) |
| **Atomicity** | Single transaction: validate + transfer + state update | Multi-step: verify transfer → update state → audit log |
| **Pool shares** | Real SPL token mint/burn | Ledger entries in JSON file |
| **Certificate NFT** | Real SPL token minted by program PDA | Tracked in local state (no real NFT) |
| **Position NFT custody** | PDA-controlled vault (only program can release) | Wallet-controlled vault (operator keypair can release) |
| **State storage** | On-chain accounts (Solana validators replicate) | Local JSON file (single machine) |
| **Upgrade authority** | Program upgrade via multisig | Code change + restart |

## Upgrade Path: Off-Chain → On-Chain

To switch from the emulator to the deployed smart contract:

1. **Deploy the program**: `anchor build && anchor deploy --provider.cluster mainnet`
2. **Implement `OnchainLhProtocol`**: fill in the stub at `protocol/onchain/index.ts` to wrap `program.methods.*` calls
3. **Set environment**: `PROTOCOL_MODE=onchain`
4. **No changes to**:
   - `scripts/live-demo.ts` (uses `ILhProtocol` interface)
   - `clients/cli/*` (Orca tools, position value, wallet snapshots)
   - `clients/risk-service/` and `clients/operator-service/`

The `ILhProtocol` interface in `protocol/interface.ts` is the single swap point. All consumers depend only on this interface.

## Security Measures

1. **Vault keypair isolation**: stored in a dedicated file (`vault-wallet.json`) with `chmod 600`. Not the admin's personal wallet.
2. **Transfer verification**: every incoming USDC transfer is verified on-chain before state is updated (tx signature checked, amount matched)
3. **Anti-replay**: processed tx signatures are stored and rejected if resubmitted
4. **Audit trail**: every operation logged to `data/audit.jsonl` with timestamps, parameters, results, and tx signatures
5. **State integrity**: atomic writes (temp file + rename) prevent corruption; version counter tracks mutations
6. **Validation parity**: all on-chain validation checks (utilization, staleness, confidence, auth) are replicated identically

## File Structure

```
protocol/
  interface.ts                  # ILhProtocol — the swap point
  types.ts                      # Shared types (used by both implementations)
  factory.ts                    # createProtocol() — selects implementation
  onchain/
    index.ts                    # OnchainLhProtocol (stub, implements ILhProtocol)
  offchain-emulator/
    index.ts                    # OffchainLhProtocol (implements ILhProtocol)
    ARCHITECTURE.md             # This document
    state/
      store.ts                  # JSON persistence with atomic writes
    operations/
      pool.ts                   # Pool: init, deposit, withdraw
      escrow.ts                 # Escrow: register, release
      certificates.ts           # Certificates: buy, settle
      pricing.ts                # Pricing: computeQuote, templates, regime
    chain/
      pyth-reader.ts            # Pyth V2 on-chain feed reader
      orca-reader.ts            # Orca account reader (wraps whirlpool-ix.ts)
      token-ops.ts              # SPL token transfers + verification
    audit/
      logger.ts                 # JSON-lines audit logger
    data/                       # Runtime data (gitignored)
      protocol-state.json       # Protocol state
      audit.jsonl               # Audit trail
```
