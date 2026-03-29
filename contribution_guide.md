# Contribution Guide

## Team Roles

| Contributor | Role | Responsibilities |
|------------|------|-----------------|
| **Sowelu Avanzo** | Project Architect & Developer | Architecture design, core implementation, protocol specification |
| **Sunday** | Developer & Auditor | Development support, code auditing, security review |
| **Alex** | Reviewer & Tester | Build verification, test execution, code review |

New contributors joining as developers should coordinate with Sowelu for onboarding and area assignment.

## Development Workflow

The project uses a **lightweight trunk-based workflow** suited to a small team and a codebase that is still maturing. The goal is fast iteration with minimal merge overhead.

### Branch Strategy

```
main                          # stable, always builds
  └── feat/<short-name>       # feature or task branch (short-lived)
  └── fix/<short-name>        # bug fix branch
  └── audit/<short-name>      # audit finding or security fix
```

**Rules:**

- `main` is the single integration branch. Keep it green (builds + tests pass).
- Create a branch only when your change spans more than one commit or needs review before merging.
- Trivial fixes (typos, config tweaks) can go directly to `main` if you are confident they don't break anything.
- Branches should be **short-lived** — merge within a few days, not weeks. Avoid long-running parallel branches at this stage.
- Delete branches after merging.

### Branch Naming

```
feat/pool-nav-pricing
fix/certificate-settle-overflow
audit/escrow-release-check
```

Use lowercase, hyphens, and a prefix that matches the type of work.

### Commit Messages

Write clear, imperative commit messages. Focus on **why**, not just what.

```
Add utilization guard to withdraw_usdc

Prevents RT withdrawal when post-withdrawal reserves would fall below
the active cap threshold, enforcing the solvency invariant.
```

For small changes, a single line is fine:

```
Fix tick spacing constant in Orca integration
```

### Pull Request Process

1. Push your branch and open a PR against `main`.
2. Write a short summary of what the PR does and why.
3. Tag a reviewer:
   - **Code changes** — Sowelu or Sunday reviews.
   - **Audit findings** — Sowelu reviews the fix, Sunday verifies the finding.
   - **Build/test changes** — Alex verifies they run correctly.
4. The reviewer approves or requests changes.
5. The author merges (squash merge preferred to keep `main` history clean).

For the current team size, one approval is sufficient. No PR should sit unreviewed for more than 2 days.

## Development Cycle

### Build and Test

All commands run from `lh-protocol/`:

```bash
yarn install              # install JS dependencies
anchor build              # compile the on-chain program
anchor test               # build + localnet deploy + run Mocha tests
anchor deploy --provider.cluster devnet   # deploy to devnet
```

Before opening a PR, verify:

```bash
anchor build   # must compile without errors or warnings
anchor test    # all tests must pass
```

### Auditing Cycle

Sunday performs periodic audits of the on-chain program. The audit workflow is:

1. **Scope** — identify the modules or instructions to audit (e.g., `certificates/`, `pool/`).
2. **Review** — read the code against the specification in `liquidity_hedge_protocol_poc(1).md` and check for:
   - Arithmetic overflows or precision loss
   - Missing access control or signer checks
   - PDA seed collisions or incorrect derivation
   - Incorrect CPI (cross-program invocation) usage
   - State machine violations (position/certificate lifecycle)
   - Invariant violations (utilization cap, reserve solvency)
3. **Report** — open an issue or PR with the finding. Use the `audit/` branch prefix for fixes.
4. **Verify** — after the fix is merged, re-check that the finding is resolved.

### Review Cycle (Alex)

Alex validates that the project builds and runs correctly:

1. Pull latest `main`.
2. Run `anchor build` and `anchor test` — report any failures.
3. Review PRs for clarity, correctness, and test coverage.
4. Run devnet scripts when testing deployment changes.

## Code Conventions

### Rust (On-Chain Program)

- Follow standard Rust formatting (`cargo fmt`).
- Use `Box<Account<'info, T>>` for large account structs that exceed the SBF stack limit.
- Read immutable values before CPI calls, take `&mut` only after CPIs complete (borrow-before-CPI pattern).
- All amounts are `u64`. Prices use `_e6` suffix (6 decimal fixed-point). Ratios use PPM (parts per million) or BPS (basis points).
- PDA seeds are defined in `constants.rs` — always reference them from there, never hardcode seeds in instructions.

### TypeScript (Tests & Clients)

- Use `new anchor.BN(value)` for all `u64` arguments — never pass raw JS numbers.
- Tests live in `lh-protocol/tests/` and use Mocha + Chai.
- Format with Prettier (`yarn lint:fix`).

### General

- Do not modify anything in `test_deployment_v2/` — it is a read-only reference implementation.
- Keep the specification (`liquidity_hedge_protocol_poc(1).md`) in sync with implementation changes.

## Critical Invariants

These must never be broken. Audit and review should prioritize verifying them:

- The escrow vault holds exactly 1 position NFT before `register_locked_position` succeeds.
- `active_cap + new_cap <= u_max * reserves / 10_000` before certificate activation.
- Settlement uses conservative price: `price_e6 - conf_e6`.
- A position NFT cannot be released while `protected_by` is set.
- `post_withdrawal_reserves >= active_cap * 10_000 / u_max_bps` for RT withdrawals.

## Getting Started

1. Clone the repository:
   ```bash
   git clone https://github.com/SoweluAvanzo/LiquidityHedge.git
   cd LiquidityHedge
   ```

2. Install prerequisites:
   - [Rust](https://rustup.rs/) 1.94.1+
   - [Solana CLI](https://docs.solanalabs.com/cli/install) 3.1.12+ (Agave)
   - [Anchor CLI](https://www.anchor-lang.com/docs/installation) 0.31.1
   - Node.js 22+ and Yarn

3. Build and test:
   ```bash
   cd lh-protocol
   yarn install
   anchor build
   anchor test
   ```

4. Read the specification: [`liquidity_hedge_protocol_poc(1).md`](liquidity_hedge_protocol_poc(1).md)

5. Read this guide, then pick up a task or open an issue.
