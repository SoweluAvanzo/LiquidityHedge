# Liquidity Hedge — Pricing contract (canonical)

**Status:** Draft for review. This file is the single intended **pricing contract**: one definition of fair value (FV), one premium formula, and explicit **profiles** for existing codebases. It does not, by itself, change on-chain programs or notebooks until adopted.

**Purpose:** Align research notebooks, TypeScript protocol emulators, and future on-chain logic around the same objects and symbols, so “premium,” “fair value,” and “markup” are not overloaded across versions.

---

## 1. Scope

- **In scope:** Upfront **premium** charged to the LP for a corridor hedge certificate over a tenor, before protocol treasury fee on premium (that fee is a separate transfer rule, not part of the premium definition below).
- **Out of scope here:** Settlement mechanics, payout functions, pool accounting, and utilization guards (they remain as in each program version).

---

## 2. Single definition of fair value (FV)

**Fair value** \(FV\) is the **risk-neutral expected present value of the corridor protection payoff** over the certificate tenor, for a **fully specified** corridor (range, barrier, notional scaling), under **one** stated measure and model:

- **Model:** Geometric Brownian motion for the underlying spot through tenor \(T\).
- **Valuation:** \(FV = \mathbb{E}^{\mathbb{Q}}[\Pi_T]\) where \(\Pi_T\) is the **cash corridor payoff** in USDC at settlement (after any product-specific caps/floors in the payoff definition), and discounting is omitted if premiums are already in “present USDC” units at trade time (PoC convention).

**Operational note:** In production, \(FV\) may be computed by **Gauss–Hermite quadrature** (or equivalent stable numerical integration) on the chosen grid; Monte Carlo is for validation, not the definition.

**Scaling:** \(FV\) must refer to a **single unambiguous notional convention** (e.g. natural cap before cover, or cap after cover). The contract requires that all profiles state which convention they use (see §4).

---

## 3. Single canonical premium formula

Let:

- \(FV\) — fair value from §2 (USDC, same notional convention as the certificate).
- \(m_{\mathrm{vol}} \ge 0\) — **volatility / risk loading** (e.g. \(\max(m_{\min}, \mathrm{IV}/\mathrm{RV})\) or governance-floored IV/RV).
- \(m_{\mathrm{amm}} \ge 0\) — **optional** demand/supply or pool-imbalance multiplier (set to **1** when unused).
- \(y \in [0,1]\) — **yield split**: share of LP trading fees allocated to RT at settlement (same economic meaning as `feeSplitRate` / `yield_share` in code).
- \(\mathbb{E}[F]\) — **expected LP trading fees** (USDC) over the hedge horizon used for premium (convention must match tenor: e.g. weekly expectation × weeks, or annualized fee rate × duration).

**Canonical upfront premium:**

\[
\boxed{
\mathrm{Premium}
=
\max\!\left(0,\;
FV \cdot m_{\mathrm{vol}} \cdot m_{\mathrm{amm}}
\;-\;
y \,\mathbb{E}[F]
\right)
}
\]

**Rationale:**  
- The first term prices **protection** off a proper **no-arbitrage-style** \(FV\), scaled by market-linked loadings.  
- The second term is an **economic discount**: the RT is compensated by a share of future fees, so the LP’s **cash** upfront can be reduced without changing the payoff definition.

**Protocol fee on premium** (treasury): applied **after** this premium object unless explicitly folded into a profile (state separately in each implementation).

---

## 4. Profiles (mapping existing artifacts to this contract)

Profiles are **specializations** of §2–3. They are not separate “truths”; they differ by **how** \(FV\) is approximated and which factors are fixed.

| Profile | Artifact | \(FV\) in practice | \(m_{\mathrm{vol}}\) | \(m_{\mathrm{amm}}\) | Fee term \(y\mathbb{E}[F]\) |
|--------|----------|-------------------|----------------------|----------------------|-----------------------------|
| **P1 — v1 on-chain** | `lh-protocol/programs/lh-core/src/pricing/instructions.rs` | **Heuristic**: \(\mathbb{E}[\text{Payout}] + C_{\mathrm{cap}} + C_{\mathrm{adv}} + C_{\mathrm{rep}}\) with clamp to template floor/ceiling — **not** §2 GBM integral | Absorbed inside heuristic (no separate \(m_{\mathrm{vol}}\)) | **1** (implicit) | **0** |
| **P2 — v3 TS emulator** | `lh-protocol-v3/protocol-src/operations/pricing.ts`, `certificates.ts` | **Heuristic proxy** for “fair value” from same component family as P1 (clamped), then multiplied by effective markup; **not** necessarily §2 GH \(FV\) | `effectiveMarkup` (e.g. \(\max(\text{floor}, \mathrm{IV}/\mathrm{RV})\) + optional add-ons) | **1** | **Yes** — `feeSplitRate × E[weekly fees]` |
| **P3 — v4 research notebook** | `lh-protocol-v4/notebooks/v4_research_synthesis.ipynb` (and docs) | **Intended** as §2-style \(FV\) (simulation / quadrature in notebook) | \(m_{\mathrm{vol}}( \mathrm{rv}, \mathrm{ivrv} )\) | **\(m_{\mathrm{amm}}\)** (demand/supply stress) | **Yes** — aligns with §3 |

**Contract statement:** **§3 is the target contract.** P1 is a **conservative, auditable on-chain heuristic** (different \(FV\) object). P2 aligns **structurally** with §3 (fee discount + multiplicative loading) but must converge **FV** and **cover scaling** to §2 for full compliance. P3 aligns **symbolically** with §3; implementation is research-grade until ported.

---

## 5. Differences vs other protocol versions (not separate “profiles” in §4)

- **v2 (`lh-protocol-v2`)**  
  - Base quote is still the **P1-style heuristic sum + clamp**.  
  - Adds **two-part premium** (upfront vs fee-linked deferred) and **vol indicator** scaling — a **cashflow timing** variant, not a different §3 identity unless mapped explicitly into \(\mathbb{E}[F]\) and upfront \(\mathrm{Premium}\).

- **`analysis/` research**  
  - Strong §2 **GH / GBM** formalization and comparison to the **on-chain heuristic**; does not correspond to a deployed profile unless results are wired into P2/P3 parameters.

- **v3 docs vs v3 code**  
  - Documentation often describes **GH fair value**; the TS path may still use the **heuristic clamped sum** as `fairValueUsdc`. Under this contract, that object should be labeled **heuristic value** until it matches §2.

- **v4 vs deployable stack**  
  - v4 introduces **\(m_{\mathrm{amm}}\)** explicitly; v1 has no such term; v3 TS sets \(m_{\mathrm{amm}} \equiv 1\) in the canonical §3 sense.

---

## 6. Adoption checklist (when this contract is approved)

1. Rename overloaded symbols in code/comments (`fairValue` vs heuristic).  
2. Fix **cover / notional scaling** so \(FV\) and `coverRatio` are not applied twice.  
3. Decide whether **P1** remains the on-chain bound with **P2/P3** as off-chain “true” premium — or migrate on-chain toward a **bounded** §2 implementation.  
4. Keep **one** copy of this file as normative; link version-specific docs to it instead of duplicating formulas.

---

## 7. Revision

| Version | Date | Notes |
|---------|------|--------|
| 0.1 | 2026-04-17 | Initial draft contract |
