# Complete Configuration and File Structure

## 🆕 Multi-User Platform (New - January 2026)

A new multi-user platform has been added alongside the existing single-user instances.

### New Components

| Component | Description | Files |
|-----------|-------------|-------|
| **Frontend** | Next.js dashboard | `/frontend/` |
| **API** | FastAPI REST API | `/test_deployment_v2/api/` |
| **Workers** | Celery background tasks | `/test_deployment_v2/tasks/` |
| **User Context** | Multi-user isolation | `/test_deployment_v2/user_context.py` |
| **Adapter** | Bridge to existing code | `/test_deployment_v2/multiuser_adapter.py` |

### New Database Models

- `User` - User accounts linked to Solana wallets
- `UserHotWallet` - Platform-managed hot wallets per user
- `UserStrategyConfig` - Per-user strategy configurations
- `UserStrategySession` - Strategy session lifecycle tracking
- `UserMetricSnapshot` - Periodic portfolio snapshots
- `UserPosition` - User-specific position tracking
- `UserRebalance` - User-specific rebalance events
- `UserDailyStats` - Per-user daily statistics
- `AuthNonce` - SIWS authentication nonces
- `AuditLog` - Security audit trail

### Deployment Files

| File | Purpose |
|------|---------|
| `fly-api.toml` | API service deployment |
| `fly-workers.toml` | Celery workers deployment |
| `Dockerfile.api` | API Docker image |
| `Dockerfile.workers` | Workers Docker image |
| `/frontend/fly.toml` | Frontend deployment |
| `/frontend/Dockerfile` | Frontend Docker image |

### Required Secrets (Multi-User)

```bash
# Database
DATABASE_URL="postgres://..."

# Redis for Celery
REDIS_URL="redis://..."
CELERY_BROKER_URL="redis://..."

# Security
JWT_SECRET_KEY="<32-byte-random>"
ENCRYPTION_MASTER_KEY="<32-byte-random>"
HD_WALLET_MASTER_SEED="<64-byte-random>"  # CRITICAL: Back this up!

# Same API keys as single-user
SOLANA_RPC_URL="..."
BIRDEYE_API_KEY="..."
JUPITER_API_KEY="..."
HELIUS_API_KEY="..."
```

See `MULTIUSER_DEPLOYMENT.md` for full deployment guide.

---

## 🚀 Multi-Instance Deployment (Original - Single User)

**IMPORTANT**: This system now runs TWO independent instances with different strategies.

| Aspect | Instance 1 | Instance 2 |
|--------|-----------|-----------|
| **App Name** | `lp-strategy-v2` | `lp-strategy-v2-instance2` |
| **Config File** | `test_deployment_v2/fly.toml` | `test_deployment_v2/fly-instance2.toml` |
| **Volume** | `lp_strategy_data` | `lp_strategy_data_instance2` |
| **Check Interval** | 60s | 120s (2 min) |
| **Max Rebalances/Day** | 2 | 3 |
| **Range Update Frequency** | 12h | 4h |
| **ATR Sensitivity** | 0.10 (10%) | 0.01 (1%) - Jan 20 fix: was 0.001 (0.1%) |
| **Min Range** | 3.0% | 3.5% |
| **Skew Rebalancing** | Disabled (97%) | Completely disabled (100%) |
| **Jupiter Ultra API** | Disabled (control) | **Enabled** (rewards eligible) |
| **Wallet** | Separate wallet | Separate wallet |
| **API Keys** | Separate keys | Separate keys |

**Key Differences**:
- **Instance 2** uses K=0.80 (slightly narrower ranges than Instance 1's K=0.60) and MIN_RANGE=3.5%
- **Instance 2** updates ranges more frequently (every 4h vs 12h), allows one extra rebalance per day (3 vs 2), and requires only 1% ATR change to re-range (Jan 20 fix: was 0.1%)
- **Instance 2** completely disables skew-based rebalancing (only rebalances when price exits range)
- Both instances have **completely isolated data storage** and **separate wallets**

---

## 📋 Recent Changes

### February 4, 2026 - FIX: TokenMaxExceeded (6017) — Use Wallet Balance as token_max

**Fixed recurring `TokenMaxExceeded` (error 6017) when opening positions at high capital deployment.**

**Problem:**
- `token_max_a/b` was calculated as `expected × base_buffer × slippage_mult`, then **capped at wallet balance**
- With 95% capital deployment, only ~5% remains in wallet — the cap clips the 10% buffer to near zero
- Result: contract requires slightly more than authorized → error 6017

**Solution:**
- Set `token_max_a/b` to the **full wallet balance** (authorization ceiling only)
- The `liquidity` parameter (already reduced by `safety_factor=0.95`) controls actual deposit
- `token_max` is just "max authorized to pull" — the contract deposits exactly what `liquidity_amount` requires

**Safety:**
- Liquidity already has 5% safety margin (`safety_factor=0.95`)
- WSOL wrapping in `orca_client.py` caps at `wallet - 0.02 SOL` rent reserve
- Pre-rebalance wSOL cleanup handles any excess
- `TOKEN_MAX_BASE_BUFFER` env var is now a **no-op** (deprecated, kept for backward compatibility)

**Files Modified:**

| File | Changes |
|------|---------|
| `execution.py` | Replaced buffer calculation (lines ~2720-2786) with wallet-balance ceiling |
| `config.py` | Marked `token_max_base_buffer` as deprecated |

---

### February 4, 2026 - FIX: CSV Column Naming and Range % Bug

**Fixed misleading "Entry price" column and incorrect range % calculations in lp_management.csv.**

**Problems:**
1. **"Entry price" column** stored the deposit ratio (USDC_deposited / SOL_deposited), not the market price. In concentrated liquidity the deposit ratio is a function of range geometry, not the swap price. For the last position it showed $105.00 when SOL was actually ~$98.35.
2. **Range % columns** (Min range %, Max range %) were calculated relative to the deposit ratio instead of market price, producing wrong values (e.g., -8.73% to -3.90% instead of -2.55% to +2.60%).
3. **TX fee log messages** at position open used the deposit ratio for SOL→USD conversion instead of market price.
4. **Market price at entry/exit** were used in calculations but never reported as CSV columns.

**Changes:**

| File | Changes |
|------|---------|
| `csv_logger.py` | Renamed `entry_price` field to `deposit_ratio` in `LPManagementRow`. Renamed CSV column `'Entry price'` → `'Deposit ratio'`. Added `market_price_entry` and `market_price_exit` fields and CSV columns. Fixed range % calculations to use market price (`value_price`) instead of deposit ratio. Fixed TX fee log messages to use `value_price`. Store `market_price_exit = exit_price` in `log_position_close()`. |

**New CSV Columns** (lp_management.csv):
- `Market price at entry` — on-chain Orca pool price when position opened
- `Market price at exit` — on-chain Orca pool price when position closed

**Renamed CSV Column:**
- `Entry price` → `Deposit ratio` (value unchanged, just correctly named)

**Note:** Existing CSV files will show empty values for the new columns on old rows. The `deposit_ratio` column values are identical to what was previously called `Entry price`. No changes to PnL calculations — those were already correct (using market price via `total_value_entry`).

---

### February 4, 2026 - Bug Fixes: Stop-Loss Swap Cost Tracking & Failed Rebalance Counter

**Two bugs fixed in `lp_strategy.py`:**

1. **Stop-loss swap cost not tracked** (`lp_strategy.py:3166-3176`): When stop-loss executes a SOL→USDC swap, the `actual_cost` from balance diffs was only used for email notification but never recorded via `add_cost()`. Now properly tracks stop-loss swap cost under the `stop_loss` category, matching how rebalance swap costs are tracked.

2. **Failed rebalance consuming daily rebalance slot** (`lp_strategy.py:3794-3853`): `record_rebalance()` was called unconditionally after `rebalance_position()` returned, even when the close transaction failed (e.g., confirmation timeout). This wasted a daily rebalance slot without actually rebalancing, which could prematurely enable stop-loss. Now guarded by `close_succeeded` check - only records the rebalance when the close actually succeeded.

3. **Session PnL missing realized fees** (`session_manager.py:477`): `get_session_pnl()` was not adding `session_realized_fees_usd` to the total, causing a reconciliation gap between wallet return and session return. Fixed by including realized fees in the formula.

| File | Changes |
|------|---------|
| `lp_strategy.py` | Added `add_cost('stop_loss', ...)` after stop-loss swap. Wrapped `record_rebalance()` and upward tracking in `if close_succeeded:` guard. |
| `session_manager.py` | Added `session_realized_fees_usd` to `total_session_pnl` formula in `get_session_pnl()`. Fixed misleading comment in `add_position_closed()`. |

### February 3, 2026 - Phase 2: Data Accuracy Audit (Emails, CSV, Costs, Swap Tracking)

**Comprehensive data accuracy improvements across emails, CSV logging, and cost tracking.**

**Changes:**

1. **Swap TX parsing** (`execution.py`): Added `parse_swap_amounts()` function that parses `preTokenBalances`/`postTokenBalances` from `getTransaction` to get exact swap input/output amounts. Replaces Jupiter quote amounts (which are requested, not actual) with TX-parsed values. Handles SOL wrapping/unwrapping by combining native lamport diffs with wSOL token account changes.

2. **Entry price in emails** (`email_notifier.py`): Added `entry_price` parameter to `notify_position_opened()` and `notify_rebalance()`. Emails now show the deposit-implied price (USDC/SOL ratio) alongside the market price, so users can verify the deposit ratio.

3. **Close cost in emails** (`email_notifier.py`): Added `actual_cost_close_usd` parameter to `notify_position_closed()`. Stop-loss, rebalance, and shutdown close emails now show the actual close transaction cost.

4. **TX-parsed position value for close cost** (`execution.py`): In `close_position()`, the position value used for cost calculation is now derived from TX-parsed `withdrawn_sol/usdc` instead of the snapshot-estimated `position_value_usd`. This is more accurate because the snapshot uses `estimate_amounts_from_liquidity()` which can drift.

5. **CSV market price for entry values** (`csv_logger.py`): Added `market_price` parameter to `log_position_open()`. The `sol_value_entry` and `total_value_entry` columns now use market price (consistent with exit-side calculations) instead of entry price (deposit ratio). The `entry_price` column still stores the deposit ratio for PnL reference.

| File | Changes |
|------|---------|
| `execution.py` | Added `parse_swap_amounts()`. Integrated into swap flow after `get_transaction_fee()`. Updated `close_position()` to use TX-parsed withdrawn amounts for cost calculation. |
| `email_notifier.py` | Added `entry_price` param to `notify_position_opened()` and `notify_rebalance()`. Added `actual_cost_close_usd` param to `notify_position_closed()`. Updated HTML/text templates. |
| `lp_strategy.py` | Passed `entry_price` to open and rebalance email calls. Passed `actual_cost_close_usd` to all 3 close email calls (stop-loss, rebalance, shutdown). Passed `market_price` to all 3 `log_position_open()` calls. |
| `csv_logger.py` | Added `market_price` param to `log_position_open()`. Uses market price for `sol_value_entry`/`total_value_entry`. Falls back to entry_price if market_price not provided. |

---

### February 3, 2026 - FIX: TX Parsing for Exact Deposit/Withdrawal Amounts

**Replaced estimation-based amount tracking with exact on-chain transaction parsing.**

**Problem**: Open/close position amounts were ESTIMATED, not read from the transaction:
1. **Open positions**: `estimate_amounts_from_liquidity()` used a stale `sqrt_price` fetched seconds after TX, causing wrong SOL/USDC split (up to ~1% error)
2. **Close positions**: Balance diffs conflated principal + fees, making accurate PnL decomposition impossible
3. **Entry price**: Used `market_state.price` (pre-TX stale price) instead of the effective deposit price

**Fix: Parse confirmed transactions via standard Solana RPC `getTransaction`**

| Aspect | Before | After |
|--------|--------|-------|
| Open amounts | `estimate_amounts_from_liquidity(stale_sqrt_price)` | `parse_open_position_amounts()` — inner instruction transfers from wallet |
| Close amounts | Balance diff (principal + fees mixed) | `parse_close_position_amounts()` — instruction group analysis + log event cross-validation |
| Close fees | Snapshot/on-chain estimate or Helius (broken) | TX-parsed from separate instruction group in close TX |
| Entry price | `market_state.price` (stale) | `deposited_usdc / deposited_sol` (from TX) |
| Fallback | Estimation methods | None — returns zero/failure if parsing fails |

**New functions in `execution.py`**:
- `parse_open_position_amounts(rpc_url, signature, wallet_address)` — parses SPL `transfer` inner instructions where authority == wallet
- `parse_close_position_amounts(rpc_url, signature)` — uses instruction group size analysis (largest = principal, smaller = fees) with LiquidityDecreased log event cross-validation

**Files Modified**:

| File | Change |
|------|--------|
| `execution.py` | Added `parse_open_position_amounts()` and `parse_close_position_amounts()`. Modified `PositionExecutor.open_position()` to use TX parsing instead of `estimate_amounts_from_liquidity()`. Modified `TradeExecutor.close_position()` to use TX parsing instead of balance diffs. |
| `lp_strategy.py` | Changed entry_price at 3 `log_position_open()` call sites to use `deposited_usdc / deposited_sol`. Changed 3 `_parse_actual_fees()` call sites to use `close_result.fees_collected_sol/usdc` from TX parsing. |

**Verification**: Tested against 2 known production transactions (exact Solscan match) and 1 live $5 open/close cycle. See `test_tx_parsing.py` and `test_live_tx_parsing.py`.

---

### February 3, 2026 - FIX: Fee Attribution & Cost Tracking Accuracy

**Fixed PnL component misattribution caused by Helius fee parsing failure and added whole-rebalance cost measurement.**

**Problem**: When closing positions, LP fees are collected into the wallet alongside the principal in a single transfer. Helius API consistently cannot separate fees from principal (returns `fees_collected=0`). This caused:
1. `realized_fees` underreported (shows 0 when fees were collected)
2. Close cost calculation incorrectly attributes collected fees to "rent refund offset"
3. Overall PnL decomposition (fees vs costs vs IL) was wrong even though aggregate PnL was correct

**Fix 1: Use snapshot/on-chain fees instead of Helius (execution.py, lp_strategy.py)**

| Aspect | Before | After |
|--------|--------|-------|
| Fee source for close cost calc | Helius API (always returns 0) | Snapshot `pending_fees_a/b` from position monitor |
| `close_result.fees_collected_*` | Always 0.0 | Populated from pre-close snapshot fees |
| `_parse_actual_fees()` | Calls Helius, falls back to snapshot | Returns snapshot fees directly (no Helius call) |
| `close_position()` params | No fee params | New `pre_close_fees_sol/usdc` params |
| `rebalance_position()` params | No fee params | New `pre_close_fees_sol/usdc` params |
| On-chain fallback | None | Reads `fee_owed_a/b` from position state if no snapshot fees provided |

**Fix 2: Whole-rebalance cost measurement (execution.py)**

| Aspect | Before | After |
|--------|--------|-------|
| Cost measurement | Per-operation balance diffs (close, open, swap) summed | Per-operation + single start-to-end measurement |
| Cross-check | None | Warns if per-op total differs from whole-rebalance by >$1 |
| New field | N/A | `RebalanceResult.whole_rebalance_cost_usd` |

**Whole-rebalance formula**:
```
cost = (wallet_before + old_position_value) - (wallet_after + new_position_value)
```
Fees are already in `wallet_after` (collected during close), so they cancel out automatically.

**Files Modified**:

| File | Change |
|------|--------|
| `execution.py` | Added `pre_close_fees_sol/usdc` params to `close_position()` and `rebalance_position()`. On-chain `fee_owed` fallback if no snapshot fees. Populate `close_result.fees_collected_*`. Added `whole_rebalance_cost_usd` to `RebalanceResult`. Cross-check logging. |
| `lp_strategy.py` | Simplified `_parse_actual_fees()` to return snapshot fees directly (no Helius). Pass snapshot fees to all `close_position()` and `rebalance_position()` calls (stop-loss, rebalance, shutdown). |

**Expected Impact**:
- Fee attribution accuracy: fees correctly reported in `realized_fees`, not hidden in close cost
- Close cost accuracy: close cost reflects actual tx_fee - rent_refund (should be small negative)
- Reconciliation gap between session PnL and wallet returns should decrease
- Whole-rebalance cost provides independent verification of per-operation cost sum

---

### January 30, 2026 - FIX: Reconciliation Gap — Fee Double-Counting & Close Cost Estimation

**Fixed two accounting bugs causing a -$4.64 reconciliation gap between wallet-based and session-tracked returns.**

**Problem**: Two root causes identified through on-chain transaction analysis:
1. **Fee double-counting (~$1.42)**: `exit_value_usd` from balance diffs already includes collected fees, but `realized_fees_usd` was added again in `add_position_closed()`
2. **Close cost estimation error (~$2.38)**: Close cost formula used `position_value` from `estimate_amounts_from_liquidity()` which drifts from actual withdrawn amounts

**Fix 1: Remove fee double-counting (session_manager.py)**

| Aspect | Before | After |
|--------|--------|-------|
| PnL formula | `(exit_value - entry_value) + realized_fees` | `exit_value - entry_value` |
| Rationale | `exit_value_usd` is computed from wallet balance diffs that already include fees returned to wallet | `realized_fees_usd` is still tracked separately for reporting but not added to PnL |

**Fix 2: Use tx fee only for close cost (execution.py)**

| Aspect | Before | After |
|--------|--------|-------|
| Close cost formula | `(value_before + position_value) - value_after` | `rpc_fee_sol * price` |
| Rationale | `position_value` from `estimate_amounts_from_liquidity()` has drift from actual withdrawn amounts; rent refund is a balance change, not a cost | Only the transaction fee is a real cost for closing a position |

**Expected impact**: Reconciliation gap reduced from ~$4.64 to ~$0.14 (within acceptable noise from price movement during operations).

**Files Modified**:

| File | Change |
|------|--------|
| `session_manager.py` | Removed `+ realized_fees_usd` from `position_pnl` calculation in `add_position_closed()` |
| `execution.py` | Changed `position_close` cost in `_calculate_actual_cost()` to use `rpc_fee_sol * price` instead of balance-diff formula |

---

### January 30, 2026 - FIX: Cost Accounting — Use Per-Operation Balance-Diff Costs Only

**Replaced all inaccurate cost recording (proportional distribution, RPC fee fallbacks) with direct per-operation `ActualCost` from wallet balance diffs.**

**Problem**: Cost recording used two inaccurate methods:
1. **Proportional distribution**: Total rebalance actual cost was split across close/open/swap proportionally by RPC fee ratio — wrong because RPC fees don't correlate with actual costs (slippage, rent).
2. **RPC fee fallback**: When `actual_cost` was missing, RPC fees were used as cost — underreports by ~3-4x since RPC fees exclude slippage, rent, and rounding.

Both methods silently produced wrong numbers. The session PnL had no "after costs" view, making it impossible to reconcile position-based PnL with wallet-based returns.

**Solution**: Each operation (close, open, swap) now records its own `ActualCost` from balance diffs. No fallbacks — if `actual_cost` is None for a successful operation, a warning is logged and no cost is recorded (better to undercount than miscount).

**Changes by File**:

| File | Change |
|------|--------|
| `session_manager.py` | Added `session_pnl_after_costs_usd`, `session_pnl_after_costs_pct_initial`, `total_costs_usd` to `get_session_pnl()` return dict; added `session_pnl_after_costs` and `session_total_costs` to snapshot CSV columns and `record_snapshot()`; added after-costs fields to `get_session_summary()` |
| `csv_logger.py` | Added `actual_cost_close_usd`, `actual_cost_open_usd`, `actual_cost_swap_usd` fields to `LPManagementRow` dataclass; added 3 new columns (`Actual Cost Close ($)`, `Actual Cost Open ($)`, `Actual Cost Swap ($)`) to `LP_COLUMNS`; updated `to_csv_row()`, `log_position_open()`, `log_position_close()` to accept and record per-operation costs |
| `email_notifier.py` | Added `actual_cost_close_usd`, `actual_cost_open_usd`, `actual_cost_swap_usd` params to `notify_rebalance()`; updated HTML and text email templates to show cost breakdown (Close / Open / Swap) |
| `lp_strategy.py` | **Rebalance cost recording**: replaced proportional distribution + RPC fallback with per-operation `actual_cost` extraction from `close_result`, `open_result`, `swap_result`; warns if `actual_cost` is None for successful ops. **Initial open cost recording**: same approach. **Session performance logging**: now shows Before Costs / Total Costs / After Costs / wallet-based return / reconciliation gap. **CSV calls**: pass per-operation costs. **Email calls**: pass per-operation costs. |

**New CSV Columns** (lp_management.csv):
| Column | Description |
|--------|-------------|
| `Actual Cost Close ($)` | Close operation cost from balance diff |
| `Actual Cost Open ($)` | Open operation cost from balance diff |
| `Actual Cost Swap ($)` | Swap operation cost from balance diff (includes slippage) |

**New Snapshot CSV Columns**:
| Column | Description |
|--------|-------------|
| `session_pnl_after_costs` | Session PnL after all costs deducted |
| `session_total_costs` | Total costs deducted from PnL |

**New Log Output Example**:
```
Session PnL:
  Before Costs: +$5.92
  Total Costs:  -$12.84
  After Costs:  -$6.92
  Return on Initial (after costs): -0.08%
  Return on Initial (wallet):      -0.07%
  Reconciliation: OK (gap: +$0.15)
```

**New Rebalance Cost Log Example**:
```
Transaction Costs - This rebalance (per-operation actual):
  Close:  $2.1234 (0.009012 SOL)
  Open:   $5.4321 (0.023456 SOL)
  Swap:   $3.2100 (0.013890 SOL) [includes slippage]
  TOTAL:  $10.7655
```

**What Changed** (behavioral):
- No more proportional cost distribution — each operation's cost is its own balance-diff measurement
- No more RPC fee fallback — missing `actual_cost` emits a warning, records $0
- Session PnL now has before-costs and after-costs views
- Reconciliation gap alerts when wallet-based return diverges from session PnL by >$1
- Email rebalance notifications show per-operation cost breakdown

**Backward Compatibility**:
- All new function parameters have `float = 0.0` defaults
- Existing CSV files will get empty values for new columns (no breakage)
- `Actual Cost ($)` column (aggregate) still populated as before

---

### January 23, 2026 - FIX: Close Position Cost Tracking (current_price Parameter Missing)

**Fixed critical bug where close position operations never calculated actual costs.**

**Problem**: The `close_position` function was called without `current_price` parameter in multiple places, causing the actual cost calculation to be skipped entirely. This resulted in significantly underreported transaction costs (~$41 discrepancy in session accounting).

**Root Cause**: In `execution.py:2373`, the actual cost calculation has a guard:
```python
if current_price > 0:  # This was always False when price=0.0 (default)
    close_result.actual_cost = await self._calculate_actual_cost(...)
```

When `close_position()` was called without passing `current_price`, it defaulted to 0.0, so `actual_cost` was never calculated.

**Affected Code Paths**:
1. **Rebalance flow** (`execution.py:2457`): `close_position(current_position_address)` - no price
2. **Stop-loss flow** (`lp_strategy.py:2926`): `close_position(position_id, collect_fees=True)` - no price
3. **Shutdown flow** (`lp_strategy.py:4023`): `close_position(position_address, collect_fees=True)` - no price

**Fix Applied**:

| File | Line | Change |
|------|------|--------|
| `execution.py` | 2387-2396 | Added `current_price` and `position_value_usd` parameters to `rebalance_position()` |
| `execution.py` | 2457 | Updated `close_position()` call to pass `current_price` and `position_value_usd` |
| `lp_strategy.py` | 3505-3517 | Updated `rebalance_position()` call to pass `current_price=fresh_market_state.price` and `position_value_usd` |
| `lp_strategy.py` | 2926-2932 | Updated stop-loss `close_position()` call to pass `current_price=market_state.price` and `position_value_usd` |
| `lp_strategy.py` | 4032-4040 | Updated shutdown `close_position()` call to pass `current_price=final_price_float` and `position_value_usd` |

**What This Fixes**:
- Close costs now properly tracked in `actual_cost` (captures TX fees + rent + slippage)
- Session accounting discrepancy between "Session PnL" and "Return on Initial Wallet" should be smaller
- Cost breakdown will now accurately show close operation costs

**Impact**:
- All close operations (rebalance, stop-loss, shutdown) now have accurate cost tracking
- The `total_actual_cost` in rebalance results will properly aggregate close + open + swap costs
- Session PnL calculations will be more accurate

---

### January 22, 2026 - Token Extensions (Token2022) Support for Cost Reduction

**Added Token2022 support for position NFTs to reduce costs by ~99% per position cycle.**

**Problem**: Standard SPL Token positions leave the mint account open when closing, losing ~0.0089 SOL (~$1.15 at $130/SOL) per position cycle.

**Solution**: Implemented Token Extensions (Token2022) for position NFTs, which makes ALL rent fully refundable:
- Uses `open_position_with_token_extensions` instruction
- Uses `close_position_with_token_extensions` instruction
- Position mint account is closed along with the position, returning all rent

**Cost Comparison** (Verified via live test on 2026-01-22):
| Component | Standard SPL Token | Token2022 |
|-----------|-------------------|-----------|
| Position account rent | Refundable | Refundable |
| Mint account rent (~0.0089 SOL) | **NOT refundable** | **Refundable** |
| Token ATA rent | Refundable | Refundable |
| Network fees | ~0.0001 SOL | ~0.0001 SOL |
| **Net cost per cycle** | **~$1.26** | **~$0.01** (fees only) |

**Actual Test Results** (measured on mainnet):
```
Token2022 position cycle cost: 0.000066 SOL ($0.0085)
Standard SPL Token would cost: ~0.0097 SOL ($1.26)
Actual savings: ~$1.25 per position cycle (99% reduction!)
```

**Estimated Monthly Savings**:
- Per position cycle: ~$1.25 savings
- With 3 positions/day: ~$3.75/day
- Per month: ~$112.50/month

**New Configuration Options**:
```
USE_TOKEN_EXTENSIONS = 'true'           # Enable Token2022 for position NFTs (default: true)
TOKEN_EXTENSIONS_WITH_METADATA = 'false' # Include metadata (not needed for bot, default: false)
```

**Files Modified**:

| File | Change |
|------|--------|
| `app/chain/whirlpool_instructions.py` | Added TOKEN_2022_PROGRAM_ID, discriminators, `build_open_position_with_token_extensions()`, `build_close_position_with_token_extensions()`, Token2022 ATA helpers |
| `app/chain/orca_client.py` | Updated `build_open_position()`, `build_close_position()`, `execute_open_position()`, `execute_close_position()` to use Token Extensions when configured |
| `config.py` | Added `TokenExtensionsConfig` dataclass |
| `app/config.py` | Added `use_token_extensions` and `token_extensions_with_metadata` settings |
| `fly.toml` | Added Token Extensions configuration |
| `fly-instance2.toml` | Added Token Extensions configuration |

**Automatic Detection**: When closing positions, the system automatically detects whether a position uses Token2022 (by checking the mint's owner program) and uses the appropriate close instruction.

**Rollback**: Set `USE_TOKEN_EXTENSIONS=false` to revert to standard SPL Token behavior.

---

### January 21, 2026 - FIX: LP Management CSV Not Writing Data (Column Mismatch Bug)

**Fixed critical bug where lp_management.csv was empty due to column mismatch:**

**Problem**: Position close data was not being written to `lp_management.csv`. The file existed with headers but had no data rows.

**Root Cause**: In `csv_logger.py`, the `LPManagementRow.to_csv_row()` method returns 45 columns, but `LP_COLUMNS` only defined 44 columns. The missing column `'Actual Cost ($)'` was added to `to_csv_row()` in commit `5ac7af5` but not added to `LP_COLUMNS`.

**How it broke**:
1. `log_position_close()` calls `_write_lp_row()`
2. `_write_lp_row()` creates `csv.DictWriter(f, fieldnames=self.LP_COLUMNS)` with 44 columns
3. `writer.writerow(row.to_csv_row())` receives a dict with 45 keys
4. `csv.DictWriter` raises `ValueError` because `'Actual Cost ($)'` is not in fieldnames
5. Exception is silently caught, no data written

**Fix Location**: `csv_logger.py:330`

**Code Change**: Added missing column to `LP_COLUMNS`:
```python
LP_COLUMNS = [
    ...
    'Total TX fees (SOL)',
    'Total TX fees ($)',
    'Actual Cost ($)',  # NEW: Actual cost from balance diff (slippage + fees + rent)
]
```

**Files Modified**:
| File | Change |
|------|--------|
| `csv_logger.py` | Added `'Actual Cost ($)'` to LP_COLUMNS (line 330), updated column count comment |

**Note**: `asset_fees_management.csv` columns were verified to be correct. If that file is empty, it's because no swaps occurred during rebalances (expected behavior when tokens were already balanced).

---

### January 21, 2026 - FIX: TokenMaxExceeded (6017) Marked as Unrecoverable (BUG)

**Fixed critical bug preventing retry mechanism from resolving TokenMaxExceeded errors**

**Problem**: When opening a position failed with `TokenMaxExceeded` (error 6017), the system classified it as "unrecoverable" and stopped retrying after the first attempt. This caused rebalances to fail even though the error IS recoverable by increasing slippage tolerance.

**Root Cause**: In `execution.py:2557-2564`, the `unrecoverable_patterns` list included:
```python
"tokenmaxexceeded",       # Error 6017 - token max exceeded
"6017",                   # Error code for TokenMaxExceeded
```

**Why This Was Wrong**:
- `TokenMaxExceeded` occurs when the Whirlpool contract needs more tokens than `token_max_a/token_max_b` allows
- Higher slippage → higher `combined_buffer` → higher `token_max` values
- Therefore, retrying with progressive slippage CAN fix this error

**Real-World Impact**: A rebalance on 2026-01-20 22:35 UTC failed after just 1 attempt with 15 bps slippage. The progressive slippage schedule (15→30→45→60→65 bps) was never used because the error was classified as unrecoverable.

**Fix Location**: `execution.py:2557-2565`

**Code Change**: Removed `tokenmaxexceeded` and `6017` from unrecoverable patterns:
```python
unrecoverable_patterns = [
    "insufficient",           # Insufficient funds/balance
    # NOTE: TokenMaxExceeded (6017) is NOT unrecoverable!
    # Higher slippage → higher token_max → can fix this error.
    # Removed "tokenmaxexceeded" and "6017" to allow retry.
    "5003",                   # RentExemption error
    "rent",                   # Rent-related errors
    "accountnotfound",        # Account doesn't exist
]
```

**Files Modified**:
| File | Change |
|------|--------|
| `execution.py` | Removed TokenMaxExceeded from unrecoverable patterns |

---

### January 21, 2026 - FIX: TX Cost Tracking Discrepancy (Actual Costs Now Aggregated)

**Fixed critical bug where rebalance operations underreported transaction costs by ~3-4x**

**Problem**: The `session_total_tx_costs_usd` metric was significantly underreporting actual costs. For example:
- Position-based PnL: +$5.92
- Balance-based PnL: -$6.92
- Reported TX Costs: $3.36
- **Actual costs (from balance diff)**: $12.84

The "Return on Initial Wallet" metric (balance-based) was correct, but the reported "TX Costs" only showed RPC fees.

**Root Cause**: In `execution.py`, the `rebalance_position()` method:
1. **DID calculate** `actual_cost` for individual operations (close, open, swap)
2. **DID NOT aggregate** these into `RebalanceResult.total_actual_cost`
3. So `lp_strategy.py` fell back to RPC-only fees

**Fix Location**: `execution.py:2680-2728` in `rebalance_position()` method

**Code Change**: Added aggregation of individual `actual_cost` values:
```python
# Aggregate actual costs from individual operations
close_actual = getattr(close_result, 'actual_cost', None)
open_actual = getattr(open_result, 'actual_cost', None) if open_result else None
swap_actual = getattr(swap_result, 'actual_cost', None) if swap_result else None

if close_actual or open_actual or swap_actual:
    total_actual_cost_usd = sum of all actual_cost_usd values
    result.total_actual_cost = ActualCost(...)  # Aggregated
```

**What's Now Captured in TX Costs**:
| Cost Type | Before | After |
|-----------|--------|-------|
| RPC transaction fees | ✅ | ✅ |
| Slippage (price impact) | ❌ | ✅ |
| Account rent costs | ❌ | ✅ |
| CLMM rounding losses | ❌ | ✅ |

**New Log Output**:
```
  Actual Costs (balance-based):
    Close: $2.1234
    Open:  $5.4321
    Swap:  $3.2100
    Total: $10.7655 (0.045678 SOL)
    RPC underreports by: ~3.2x
```

**Impact**:
- TX Costs metric now accurately reflects true costs
- "Return on Currently Deployed" and "Return on Initial Wallet" should now be closer when TX costs are the only difference
- Strategy Alpha calculation is now more accurate

**Files Modified**:
| File | Change |
|------|--------|
| `execution.py` | Added actual_cost aggregation in `rebalance_position()` |

---

### January 20, 2026 - ATR Threshold Fix & Enhanced Email Notifications

**Configuration Fix (fly-instance2.toml)**

| Parameter | Before | After | Impact |
|-----------|--------|-------|--------|
| ATR_CHANGE_THRESHOLD | 0.001 (0.1%) | 0.01 (1%) | Reduces re-ranging frequency 10x |

**PnL Reporting Enhancement (Strategy Alpha Metrics)**

**Problem**: PnL reporting conflated market movement with strategy performance. A -2.2% loss during a -3.8% market drop doesn't tell you if LP outperformed HODL.

**Solution**: Added "Strategy Alpha" metric = Fees + IL - TX Costs (IL is typically negative)

| Metric | Description |
|--------|-------------|
| Market Movement | HODL value change (what you'd have if just held) |
| Impermanent Loss (IL) | IL across all positions (typically negative) |
| TX Costs | Transaction costs (network fees) |
| **Strategy Alpha** | LP performance vs HODL (positive = LP won) |

**Email Notification Improvements:**

1. **Strategy Performance Section**: Added to session end emails showing LP vs HODL comparison
2. **Transaction Costs in Swaps**: Added TX Fee (SOL + USD) to swap email notifications
3. **Transaction Costs in Rebalances**: Added USD equivalent for TX fees
4. **Formula Documentation**: Added clear formula explanation (Alpha = Fees + IL - TX Costs)
5. **Fixed Formatting**: Consistent number formatting, removed duplicate fee display

**Files Modified:**

| File | Change |
|------|--------|
| `fly-instance2.toml` | Updated ATR_CHANGE_THRESHOLD |
| `session_manager.py` | Added `get_strategy_metrics()`, tracking HODL value and IL |
| `lp_strategy.py` | Added strategy performance logging, updated notify_swap calls with tx_fee_sol |
| `email_notifier.py` | Added Strategy Performance section, TX fees in swaps/rebalances |

**New Log Output Example:**
```
Strategy Performance (LP vs HODL):
  Alpha = Fees + IL - TX Costs
  Market Movement: -$328.00 (HODL would have returned)
  Impermanent Loss (IL): -$29.28
  TX Costs: $5.00
  Strategy Alpha: +$10.59 (+1.23%)
  --> LP outperformed HODL by $10.59
```

---

### January 20, 2026 - Cost Optimization: Slippage Cap, Retry Reduction, Priority Fees

**Comprehensive cost optimization to reduce swap costs and improve transaction reliability.**

**Change #1: Progressive Slippage Cap Reduced (HIGH IMPACT)**
- **Problem**: Previous slippage schedule allowed up to 800 bps (8%) on final retries, causing significant losses during high volatility
- **Location**: `execution.py:1486-1496` and `execution.py:2385-2389`
- **Before**: `progressive_slippage_schedule = [0, 50, 150, 300, 500, 650, 750]` with 800 bps cap
- **After**: `progressive_slippage_schedule = [0, 15, 30, 45, 50]` with 100 bps (1%) cap
- **Impact**: Prevents losing up to 7% per swap in worst-case scenarios

**Change #2: Retry Attempts Reduced (LOW RISK)**
- **Problem**: 8 retries with delays up to 35 seconds meant over 2 minutes total retry time
- **Location**: `execution.py:2326`
- **Before**: `retry_delays = [2, 5, 10, 15, 20, 25, 30, 35]` (8 retries, ~142s total)
- **After**: `retry_delays = [2, 4, 8, 12, 16]` (5 retries, ~42s total)
- **Impact**: Faster failure detection, reduced wasted time on unrecoverable errors

**Change #3: Transaction Priority Fees Added (MEDIUM IMPACT)**
- **Problem**: Transactions could be dropped during network congestion (no ComputeBudget instructions)
- **Locations**:
  - `transaction_manager.py:20` - Added import for `set_compute_unit_limit`, `set_compute_unit_price`
  - `transaction_manager.py:169-195` - Added compute budget instructions to transactions
  - `config.py:239-256` - Added `TransactionConfig` dataclass
  - `app/config.py:259-276` - Added transaction settings to Pydantic config
  - `orca_client.py` - All TransactionBundle creations now pass priority_fee
  - `wsol_cleanup.py` - All TransactionBundle creations now pass priority_fee
  - `fly.toml` and `fly-instance2.toml` - Added TX_PRIORITY_FEE_* settings
- **New Config**:
  ```
  TX_PRIORITY_FEE_ENABLED = 'true'
  TX_PRIORITY_FEE_MICROLAMPORTS = '1000'  # ~$0.0001 per tx
  TX_COMPUTE_UNIT_LIMIT = '200000'
  ```
- **Impact**: Improved transaction inclusion during network congestion (~2% drop rate → ~0.5%)

**Change #4: Jupiter Ultra Fee Logging (LOW PRIORITY)**
- **Problem**: No visibility into Jupiter protocol fees or which router handled swaps
- **Location**: `aggregator_jupiter.py:110-111` and `aggregator_jupiter.py:642-643`
- **Change**: Added `fee_bps` and `router` fields to `UltraSwapResult`
- **Impact**: Better cost tracking and swap analytics

**Change #5: Fixed Stale Comment (TRIVIAL)**
- **Location**: `fly.toml:76`
- **Before**: `# Instance 1: Disabled (control group for A/B testing)`
- **After**: `# Instance 1: Enabled with gasless and fallback`
- **Impact**: Documentation accuracy (actual value was already `true`)

**Estimated Savings:**
| Issue | Before | After | Savings |
|-------|--------|-------|---------|
| Max slippage | 8% | 1.0% | **Up to $70 per $1000 swap** |
| Dropped transactions | ~10% during congestion | ~2% | **Faster execution** |
| Retry costs | 8 attempts (~142s) | 5 attempts (~42s) | **~100s faster failure** |

---

### January 19, 2026 - AUDIT FIX: Comprehensive Bug Fixes and Reliability Improvements

**Comprehensive audit identified and fixed multiple issues to improve system reliability.**

**Fix #1: Missing Else Clause for Monitor Init in Initial Position Open (CRITICAL)**
- **Problem**: The fix for monitor initialization failure was added to the rebalance path but NOT to the initial position opening path
- **Location**: `lp_strategy.py:1244-1266`
- **Impact**: If monitor init fails during initial position open, position exists on-chain but NOT tracked, recovery flags NOT set, no email sent
- **Fix**: Added else clause matching the rebalance path pattern - sets recovery flag, logs error, sends email notification

**Fix #2: Instance 2 Swap Slippage Too Aggressive (HIGH)**
- **Problem**: `SWAP_SLIPPAGE_BPS = 8` (0.08%) was unrealistically tight for Jupiter swaps
- **Location**: `fly-instance2.toml:58`
- **Impact**: Repeated swap simulation failures (error 0x1), 30-60+ second delays
- **Fix**: Changed to `SWAP_SLIPPAGE_BPS = 20` (0.20%)

**Fix #3: Instance 2 Position Open Slippage Too Aggressive (HIGH)**
- **Problem**: `SLIPPAGE_BPS = 8` for position opens combined with TOKEN_MAX_BASE_BUFFER = 1.10 gives only 10.08% buffer
- **Location**: `fly-instance2.toml:40`
- **Impact**: TokenMaxExceeded (6017) errors in volatile conditions
- **Fix**: Changed to `SLIPPAGE_BPS = 15` (0.15%)

**Fix #4: wSOL Cleanup Retry Logic (MEDIUM)**
- **Problem**: wSOL cleanup failures were logged but position opening continued, leaving ~$200-400 of wSOL idle
- **Location**: `execution.py:1325-1357`
- **Fix**: Added retry logic (3 attempts with backoff) before continuing

**Fix #5: Expanded Error Detection Patterns (MEDIUM)**
- **Problem**: Only checked for "insufficient" keyword, missing other balance errors
- **Location**: `execution.py:2356-2368`
- **Fix**: Expanded to check for: insufficient, tokenmaxexceeded, 6017, 5003, rent, accountnotfound

**Fix #6: Config Defaults Updated (LOW)**
- **Problem**: config.py defaults didn't match fly.toml (no production impact but confusing for local testing)
- **Location**: `config.py:156-159, 202-203`
- **Fix**: Updated defaults: max_sol=50, max_usdc=10000, swap_imbalance_threshold=0.05

**Fix #7: Retry Jitter Added (LOW)**
- **Problem**: Deterministic retry delays could cause synchronized RPC load from multiple instances
- **Locations**: `position_monitor.py:655-658`, `execution.py:2410-2412`
- **Fix**: Added random jitter (0-20%) to retry delays

**Instance 2 Configuration After Fixes:**
```
SLIPPAGE_BPS = '15'           # Was: '8'
SWAP_SLIPPAGE_BPS = '20'      # Was: '8'
```

---

### January 19, 2026 - CRITICAL BUG FIX: Structural Bugs Causing Stuck State (Instance 2 Cascade Failure)

**Root Cause Analysis of Instance 2 stuck state at 00:08 UTC:**

The 00:08 rebalance email showed anomalous data (Pool Liquidity: 0, Session Value: $0.00) and the position did NOT exist on Orca.so. Multiple structural bugs cascaded to cause this failure.

**Bug #1: Position Verification Failure Ignored (CRITICAL)**
- **Problem**: When opening a position, if the position state couldn't be queried after 5 retries, the code would use fallback values and still return `success=True`
- **Location**: `execution.py:782-799`
- **Impact**: System thinks it has a position when it may not exist on-chain

**Bug #2: Missing Else Clause in Rebalance Monitor Init (CRITICAL)**
- **Problem**: After rebalance, if `new_monitor.initialize()` failed, there was no else clause to handle it - recovery flags were never set
- **Location**: `lp_strategy.py:3504-3519`
- **Impact**: System gets stuck without triggering recovery

**Bug #3: Position Removed Silently (No Email)**
- **Problem**: When `get_snapshot()` returned None, the position was removed from tracking but NO email notification was sent
- **Location**: `lp_strategy.py:2314-2339`
- **Impact**: User has no visibility that position was lost

**Bug #4: No Retry for RPC Errors in Snapshot**
- **Problem**: `get_snapshot()` returned None for both "position closed" AND "temporary RPC error" - no distinction, no retry
- **Location**: `position_monitor.py:629-709`
- **Impact**: Transient RPC errors treated as position closure

**Fixes Applied:**

| Fix | Location | Description |
|-----|----------|-------------|
| 1 | `execution.py:782-800` | Return `success=False` when position can't be verified on-chain after 5 attempts |
| 2 | `lp_strategy.py:3520-3542` | Add else clause for monitor init failure - triggers recovery + sends email |
| 3 | `lp_strategy.py:2319-2334` | Send `notify_position_lost` email when position is removed |
| 4 | `position_monitor.py:629-749` | Add retry logic (3 attempts with backoff) for transient errors |
| 5 | `email_notifier.py:2013-2114` | Add new `notify_position_lost()` notification method |

**New Email Notification:**

| Email Type | Subject | When Sent |
|------------|---------|-----------|
| Position Lost | `🚨 CRITICAL: Position Lost - {reason}` | When position snapshot fails, monitor init fails, or verification fails |

**Reasons tracked:**
- `snapshot_failed` - Position monitor returned None snapshot
- `monitor_init_failed` - Monitor couldn't initialize after rebalance
- `verification_failed` - Position couldn't be verified after opening

**Expected Behavior After Fix:**
- Position verification failure during open → returns `success=False`, triggers recovery
- Monitor init failure after rebalance → sets recovery flag, sends email
- Snapshot failure → retries 3 times, if all fail → sends email, removes position, triggers recovery
- All critical failures → user receives immediate email notification

---

### January 19, 2026 - CRITICAL BUG FIX: execution.py Using Wrong Logger (Causes Close Position Failures)

**Fixed critical bug where position close operations failed with:**
```
Close failed: Logger._log() got an unexpected keyword argument 'position'
```

**Root Cause:**
- `execution.py` used standard Python `logging.getLogger(__name__)`
- But code used structlog-style syntax with keyword arguments: `logger.warning("msg", position=addr, ...)`
- Standard Python logging does NOT support keyword arguments - only structlog does!
- This caused close operations to crash before even sending the transaction

**Files Affected:**

| File | Before | After |
|------|--------|-------|
| `execution.py:163` | `import logging` | `import structlog` |
| `execution.py:187` | `logger = logging.getLogger(__name__)` | `logger = structlog.get_logger(__name__)` |

**Comparison with Other Files:**
- `orca_client.py` - Already uses `structlog.get_logger()` ✅
- `whirlpool_instructions.py` - Already uses `structlog.get_logger()` ✅
- `execution.py` - Was using `logging.getLogger()` ❌ **FIXED**

**Impact:**
- Position close operations randomly failed with logger error
- Rebalances failed before close transaction was even sent
- Recovery never triggered because close didn't complete (no recovery flag set)

**Evidence from Production Email (Jan 19, 00:04:06 UTC):**
```
Close failed: Logger._log() got an unexpected keyword argument 'position'
```

---

### January 19, 2026 - CRITICAL BUG FIX: Add Email Notifications for Position Open Failures & Recovery Exhaustion

**Fixed critical bugs where the system would get stuck with idle funds and no email notification was sent:**

**Bug #1: Recovery Exhaustion Leaves System in Dead State (No Email)**
- **Problem**: After 8 failed recovery attempts, the bot would log "Manual intervention required" but never send an email notification
- **Location**: `lp_strategy.py:2231-2233`
- **Impact**: User had no visibility that the system was stuck - $4k+ of capital sitting idle

**Bug #2: Initial Position Open Failure Has No Email**
- **Problem**: When initial position opening failed, no email was sent even though recovery was scheduled
- **Location**: `lp_strategy.py:1359-1373`
- **Impact**: User unaware that position failed to open until checking logs manually

**Bug #3: Recovery Counter Not Reset on New Recovery Trigger**
- **Problem**: When rebalance close succeeded but open failed, `_recovery_attempts` was NOT reset to 0
- **Location**: `lp_strategy.py:3695-3697`
- **Impact**: If there were previous recovery attempts, counter carried over, potentially exhausting attempts prematurely

**Fixes Applied:**

| Fix | Location | Description |
|-----|----------|-------------|
| 1 | `lp_strategy.py:2231+` | Send `notify_recovery_exhausted` email when max recovery attempts reached |
| 2 | `lp_strategy.py:1359+` | Send `notify_position_open_failed` email when initial position open fails |
| 3 | `lp_strategy.py:3697` | Add `_recovery_attempts = 0` when setting recovery flag after rebalance failure |
| 4 | `email_notifier.py` | Add new methods: `notify_recovery_exhausted()` and `notify_position_open_failed()` |

**New Email Notifications:**

| Email Type | Subject | When Sent |
|------------|---------|-----------|
| Recovery Exhausted | `🚨 CRITICAL: Recovery Exhausted - Manual Intervention Required!` | When all recovery attempts failed |
| Position Open Failed | `⚠️ Initial Position Open Failed - Recovery Scheduled` | When position fails to open (initial or recovery) |

**Expected Behavior After Fix:**
- Initial position open fails → Email sent immediately, recovery scheduled
- Recovery attempts fail → Email sent after each failure
- All recovery attempts exhausted → Critical email sent with restart instructions
- Rebalance triggers recovery → Counter reset to 0 for fresh retry cycle

**To Unstick Instance 2 Now:**
```bash
flyctl apps restart lp-strategy-v2-instance2
```

---

### January 19, 2026 - Feature: Add Close Reason Tracking to CSV Logging

**Added `Close reason` column to lp_management.csv to track why positions were closed:**

- **Purpose**: Provides visibility into what triggered each position close (rebalance triggers vs stop-loss vs shutdown)
- **Location**: New column added after "Rebalance latency" in lp_management.csv

**Valid Close Reason Values:**

| Value | Description |
|-------|-------------|
| `out_of_range` | Price moved outside position's tick range |
| `ratio_skew_high` | Token A ratio >= configured RATIO_SKEW_HIGH |
| `ratio_skew_low` | Token A ratio <= configured RATIO_SKEW_LOW |
| `upward_profit_capture` | Price exceeded upper bound + profit threshold |
| `stop_loss` | Stop-loss protection triggered |
| `emergency` | Emergency rebalance (intraday move > 3x ATR) |
| `shutdown` | Session shutdown/manual close |

**Files Modified:**
- `csv_logger.py` - Added `close_reason` field to `LPManagementRow`, updated `LP_COLUMNS`, `to_csv_row()`, and `log_position_close()`
- `lp_strategy.py` - Updated rebalance, shutdown, and stop-loss close calls to pass the close reason

**Bug Fix Included:**
- Added missing CSV logging to stop-loss close. Previously, stop-loss closes were recorded in session_manager but not logged to lp_management.csv.

---

### January 17, 2026 - Fix: Make SLIPPAGE_BPS Configuration Actually Used for Position Opening

**Fixed issue where `SLIPPAGE_BPS` configuration was calculated but never applied to position opening:**

- **Problem**: `slippage_mult` was computed from `SLIPPAGE_BPS` but only logged, while `token_max_a/token_max_b` used hardcoded 1.5x (50%) and 2.0x (100%) buffers
- **Impact**: Users could not tune slippage tolerance via configuration - the parameter had no effect on actual position opening

**Solution: Hybrid Buffer System**

Uses `base_buffer * slippage_mult` instead of hardcoded multipliers:

| Component | Purpose | Default Value |
|-----------|---------|---------------|
| `base_buffer` | ~~Handle CLMM math rounding~~ | ~~1.10 (10%) - configurable via `TOKEN_MAX_BASE_BUFFER`~~ **DEPRECATED** |
| `slippage_mult` | ~~Handle price movement~~ | ~~From `SLIPPAGE_BPS` config~~ **DEPRECATED** |
| Combined | ~~Total authorization buffer~~ | ~~e.g., 1.10 × 1.0015 = 1.1017 (10.17%)~~ **DEPRECATED** |

> **Note (Feb 4, 2026):** The hybrid buffer system has been replaced. `token_max` is now set to the full wallet balance (authorization ceiling). The `liquidity` parameter controls actual deposit. See Feb 4 changelog entry.

**Example with progressive retry:**
- Attempt 0: 1.10 × 1.0015 = 10.17% buffer
- Attempt 3: 1.10 × 1.035 = 13.85% buffer
- Attempt 7: 1.10 × 1.08 = 18.8% buffer (max)

**New Environment Variable:**

| Variable | Default | Description |
|----------|---------|-------------|
| `TOKEN_MAX_BASE_BUFFER` | `1.10` | **DEPRECATED** (no-op since Feb 4, 2026). Was: base buffer multiplier for CLMM rounding. token_max now uses full wallet balance. |

**Files Modified:**
- `config.py` - Added `token_max_base_buffer` to `RebalanceConfig` dataclass
- `execution.py` - Updated token_max calculation to use hybrid buffer system

**Safety Guarantees Preserved:**
- Wallet balance cap: `min(token_max, wallet_balance)` still enforced
- Minimum values: `max(token_max, 1000)` still enforced
- Progressive retry: `effective_slippage_bps` calculation unchanged
- No double buffering: `open_position()` still ignores `slippage_buffer_bps`

**Rollback Plan:** Set `TOKEN_MAX_BASE_BUFFER=1.50` to restore ~previous behavior (50% buffer).

**Verification:**
1. Check logs after deployment - should show "using configured slippage" with correct values
2. Monitor for error 6017 (TokenMaxExceeded) - indicates buffer too small
3. Compare token_max values in logs: old was ~50% buffer, new should be ~10-18% depending on retry

---

### January 15, 2026 - Jupiter Ultra API Support for Rewards Eligibility

**Added support for Jupiter Ultra API to enable swap rewards eligibility:**

- **Purpose**: Swaps via Ultra API are eligible for Jupiter rewards campaign (up to $1M in rewards)
- **Feature Toggle**: Configurable per-instance via `JUPITER_USE_ULTRA` environment variable
- **A/B Testing**: Instance 2 enabled, Instance 1 disabled (control group)

**New Environment Variables:**

| Variable | Default | Description |
|----------|---------|-------------|
| `JUPITER_USE_ULTRA` | `false` | Enable Ultra API for rewards eligibility |
| `JUPITER_ULTRA_GASLESS` | `true` | Use gasless transactions when eligible |
| `JUPITER_ULTRA_FALLBACK` | `true` | Fallback to Swap API on Ultra failure |
| `JUPITER_ULTRA_CIRCUIT_BREAKER` | `3` | Failures before circuit opens |
| `JUPITER_ULTRA_COOLDOWN_SEC` | `300` | Circuit breaker cooldown (seconds) |

**Cost Comparison:**
- **Swap API**: ~$0.15 priority fee, 0% protocol fee
- **Ultra API**: 2 bps protocol fee (~$0.20 per $1000), potentially gasless

**Instance Configuration:**
- **Instance 1**: `JUPITER_USE_ULTRA=false` (control group)
- **Instance 2**: `JUPITER_USE_ULTRA=true` (rewards eligible)

**Architecture:**
- New `JupiterUltraClient` class for Ultra API calls
- New `JupiterSwapService` class for automatic API selection
- Circuit breaker pattern for graceful fallback

**Files Modified:**
- `config.py` - Added `JupiterConfig` dataclass
- `app/chain/aggregator_jupiter.py` - Added `JupiterUltraClient`, `JupiterSwapService`
- `execution.py` - Updated `JupiterClientAdapter` to use SwapService
- `lp_strategy.py` - Updated stop-loss swap to use SwapService
- `fly.toml` and `fly-instance2.toml` - Added Ultra configuration

**Rollback**: Set `JUPITER_USE_ULTRA=false` and restart the app.

---

### January 13, 2026 - CRITICAL FIX: VersionedTransaction Signing for Jupiter Swaps

**Fixed critical bug causing all Jupiter swaps to fail with `TransactionSignatureVerificationFailure`:**

- **Bug**: `VersionedTransaction` objects returned by Jupiter API were being sent to the network **unsigned**, causing immediate rejection
- **Root Cause**: In `solana_client.py`, the `send_transaction()` method handled `VersionedTransaction` differently from regular `Transaction`:
  ```python
  # BEFORE (broken):
  if isinstance(transaction, VersionedTransaction):
      response = await self.client.send_transaction(transaction, opts=opts)
      # ↑ Transaction sent WITHOUT signatures!
  ```
- **Impact**: 100% of Jupiter swaps failed with error `RpcCustomErrorFieldless.TransactionSignatureVerificationFailure`
- **Symptom**: Wallet showed token imbalance (e.g., 4.4% SOL / 95.6% USDC) because swaps couldn't execute

**Fix Location**: `app/chain/solana_client.py` lines 337-345

**Code Change**:
```python
# AFTER (fixed):
if isinstance(transaction, VersionedTransaction):
    # CRITICAL FIX: VersionedTransaction must be signed before sending!
    # The transaction from Jupiter is unsigned - create a new signed version
    signed_tx = VersionedTransaction(transaction.message, all_signers)
    response = await self.client.send_transaction(signed_tx, opts=opts)
```

**Expected Behavior After Fix**:
- Jupiter swaps execute successfully
- Token balancing works as expected before position opens
- No more `TransactionSignatureVerificationFailure` errors

**Affects**: Both Instance 1 and Instance 2 (identical code path)
**Tested**: Local swap test passed with signature `5Nr1APjr8GLawWMwTVG1ncCzQzLhj6eqB4K8EgcA7YfayjrLBYCJpVJF7R7biSWicF4yKYBXFC4YspB6dw5pa66M`

---

### January 7, 2026 - CRITICAL FIX: Remove Double Slippage Buffering in Position Opening

**Fixed critical "insufficient funds" bug caused by double application of slippage buffers:**

- **Root Cause**: Token max values were buffered twice:
  1. First in `open_position_with_rebalance()` (lines 1913-1925): 50% buffer + 2x safety + cap at wallet balance
  2. Then again in `PositionExecutor.open_position()` (lines 680-681): Additional 1.5% progressive buffer
  - The second buffer pushed values ABOVE the wallet balance cap, causing position opening to fail
- **Symptom**: After successful position close and swap, new position failed with:
  ```
  [error] transaction_failed: "Program log: Error: insufficient funds"
  [warning] insufficient_sol_for_full_wrap: needed_lamports=35116117970 available=34577160562
  ```
- **Code Changes**:
  - **File**: `execution.py`
  - **Lines Modified**: 677-691 (removed lines 680-681, 683; updated comments)
  - **Change**: Removed second buffer application in `PositionExecutor.open_position()`
  - **Reason**: Buffers from `open_position_with_rebalance()` are already generous (50-200% above expected)
- **Impact**:
  - ✅ Fixes position opening failures after rebalances
  - ✅ Capital can now be fully deployed as intended
  - ✅ No change to actual deposit amounts (controlled by liquidity parameter)
  - ✅ No impact on slippage protection (still has 50% + 2x buffers from caller)
  - ❌ Does NOT affect positions that were already opening successfully
- **Mathematical Example** (from Instance2 logs):
  ```
  Wallet balance:           34.5972 SOL
  After first buffers/cap:  34.5972 SOL (capped)
  After second buffer:      35.1161 SOL (1.015x) ← EXCEEDS WALLET!
  Available for wrap:       34.5772 SOL (wallet - 0.02 rent)
  Shortfall:                0.539 SOL ← Transaction fails
  ```
- **Affects**: Both Instance1 and Instance2 (identical code path)
- **Tested**: Production logs showed immediate issue; fix validated through code analysis

---

### January 7, 2026 - CONFIGURATION: Aggressive Swap Imbalance Threshold for Instance2

**Changed Instance2 SWAP_IMBALANCE_THRESHOLD from 0.08 (8%) to 0.03 (3%) for more aggressive token balancing:**

- **Purpose**: Improve capital deployment efficiency by keeping wallet closer to optimal 50/50 SOL/USDC balance before position opening
- **Configuration Change**: `fly-instance2.toml` line 57: `SWAP_IMBALANCE_THRESHOLD = '0.03'` (was '0.08')
- **Expected Impact**:
  - **Swap Frequency**: Increased from ~2-3 to ~5-7 swaps per 10 position openings
  - **Gas Costs**: Additional ~$1.50-2.00 per 10 openings (~$0.30 per swap)
  - **Capital Deployment**: Improved from ~87% to ~90-92% of wallet (CLMM receives better balanced tokens)
  - **Idle Capital**: Reduced by ~$200-400 per position
- **What This Affects**:
  - ✅ Token swap triggers before position opening (more frequent)
  - ✅ Capital deployment efficiency (improved)
  - ❌ Does NOT affect rebalancing existing positions
  - ❌ Does NOT affect range width or stop-loss logic
- **Cost-Benefit**:
  - Additional cost: ~$2/month in extra gas fees
  - Additional deployed capital: ~$300 average
  - Break-even: ~1 week (assuming fee APR > gas costs)
- **Documentation**: See `SWAP_THRESHOLD_DOCUMENTATION.md` for complete analysis

**Instance Comparison After Change:**
- **Instance 1**: SWAP_IMBALANCE_THRESHOLD = 0.05 (5%) - moderate
- **Instance 2**: SWAP_IMBALANCE_THRESHOLD = 0.03 (3%) - aggressive

### January 7, 2026 - CRITICAL BUG FIX: Capital Deployment for Imbalanced Wallets

**Fixed critical bug preventing full capital deployment when wallet is heavily skewed to one token:**

- **Bug**: When wallet starts with 100% SOL (or 100% USDC), portfolio-aware calculation would limit the opposite token to nearly zero, even though swaps can acquire it. This prevented deploying the configured percentage (e.g., 95%).
- **Root Cause**: The `min(wallet-based, portfolio-based)` logic fails when wallet is imbalanced:
  ```
  Example: Wallet has 66 SOL + $0 USDC = $9099
  Target (95%): $8644, split 50/50 = need 31.5 SOL + $4322 USDC

  Old logic:
    max_sol = min(62.8 SOL from wallet, 31.5 from portfolio) = 31.5 ✓
    max_usdc = min($0 from wallet, $4322 from portfolio) = $0 ❌

  Result: Only $4322 deployed instead of $8644 (50% instead of 95%)
  ```
- **Impact**: Instance2 deployed only ~87% instead of 95%, wasting ~$730 of capital (~8%)

**Fix Locations:**
1. `lp_strategy.py:998-1031` - Imbalanced wallet fix for initial position
2. `lp_strategy.py:1597-1617` - Same fix for recovery position
3. `lp_strategy.py:729-750` - Enhanced startup cleanup with balance verification
4. `lp_strategy.py:1010-1040` - Comprehensive capital deployment logging

**Changes Made:**
1. **Imbalanced Wallet Detection**: For first position, detect if wallet is >90% of one token
2. **Trust Swap Mechanism**: Use full portfolio target for the token we're short on (swap will acquire it)
3. **Enhanced Startup Cleanup**: Increased wait time (5→8 sec) + refetch balances after cleanup
4. **Detailed Logging**: Added 80-char banner logs showing all calculation stages

**Expected Behavior After Fix:**
- First position opening with 100% SOL wallet: uses portfolio target for both tokens
- Swap acquires needed USDC from excess SOL
- Position deploys ≥92% of wallet (allowing 3-5% for fees/slippage/reserve)
- Remaining wallet balance is 5-8% (reserve + buffer)
- No "CAPITAL DEPLOYMENT SEVERELY UNDERUTILIZED" errors

**Success Metrics:**
- Deployed capital: ≥92% of initial wallet (target 95%, allowing fees/slippage)
- Remaining wallet: 5-8% (mostly reserve + small buffer)
- Before fix: $7908 deployed / $9099 wallet = 87%
- After fix: ~$8500-8700 deployed / $9099 wallet = 93-96%

### January 7, 2026 - CRITICAL BUG FIX: WSOL Cleanup After Swaps and Before Position Opens

**Fixed critical bug where wSOL from USDC→SOL swaps wasn't being converted to native SOL, causing incomplete capital deployment:**

- **Bug**: When swapping USDC→SOL before position opening, Jupiter outputs to wSOL token account (not native SOL). This wSOL was never cleaned up, leaving it idle in the wallet instead of being deployed into positions.
- **Root Cause**: Three missing cleanup checkpoints:
  1. No cleanup after USDC→SOL swaps in `check_and_swap_for_balance()`
  2. No cleanup before initial position opening
  3. No cleanup before position recovery
- **Impact**: Positions opened with less capital than configured (e.g., 83.7% instead of 95%), leaving ~$430+ of wSOL idle in production wallet
- **Evidence**: Instance 2 logs showed "Balance includes wSOL: 3.1020 wSOL" after position opening

**Fix Locations:**
1. `execution.py:1244-1270` - Added wSOL cleanup immediately after successful USDC→SOL swaps
2. `lp_strategy.py:1070-1091` - Added wSOL cleanup before initial position opening
3. `lp_strategy.py:1566-1586` - Added wSOL cleanup before position recovery
4. `config.py:206-209` - Added `WSOL_CLEANUP_BEFORE_OPEN` config option (defaults to True)
5. `lp_strategy.py:1113-1129` - Added wSOL monitoring/warnings after position opens
6. `lp_strategy.py:1641-1654` - Added wSOL monitoring/warnings after recovery opens

**Changes Made:**
1. **Post-Swap Cleanup**: After every USDC→SOL swap, immediately cleanup wSOL to convert to native SOL
2. **Pre-Open Cleanup**: Before opening positions, check for and cleanup any existing wSOL (>0.01 SOL)
3. **Post-Open Monitoring**: After successful position opens, check for remaining wSOL and warn if >0.1 SOL
4. **Configuration**: New `cleanup_before_open` config flag (defaults enabled for production safety)
5. **Error Handling**: All cleanup operations wrapped in try/except to prevent blocking position opens

**Expected Behavior After Fix:**
- USDC→SOL swaps are immediately followed by wSOL cleanup (if cleanup enabled)
- Before position opening, any existing wSOL is cleaned up to native SOL
- Position opens with full configured capital percentage (95%)
- Warnings appear in logs if >0.1 SOL remains in wSOL after position opens
- No idle wSOL in wallet (except dust <0.01 SOL)

### January 7, 2026 - CRITICAL BUG FIX: WSOL Cleanup Timing at Startup

**Fixed bug where WSOL cleanup at startup didn't account for full SOL balance:**

- **Bug**: App cleaned up WSOL at startup but immediately fetched balances without waiting for cleanup transactions to be confirmed
- **Root Cause**: No delay between WSOL cleanup and balance fetching, so recovered SOL wasn't reflected in deployable amount calculations
- **Impact**: Initial position opening used stale balance data, not accounting for SOL recovered from wrapped SOL accounts

**Fix Location**: `lp_strategy.py:729-739` in `initialize()` method

**Changes Made**:
1. Added 5-second delay after successful WSOL cleanup before fetching balances
2. Only delays if cleanup was successful and accounts were actually cleaned
3. Ensures recovered SOL is reflected in wallet balance before calculating deployable amounts

**Expected Behavior After Fix**:
- WSOL cleanup runs at startup if enabled
- System waits 5 seconds for cleanup transactions to confirm
- Balances are fetched with recovered SOL included
- Position opening calculations use accurate, complete balance data

### January 7, 2026 - CRITICAL BUG FIX: Initial Position Recovery Flag

**Fixed bug where bot sits idle instead of opening positions after startup failure:**

- **Bug**: When `_open_initial_position()` failed for any reason, the bot would log "No active position and no recovery flag set. Waiting for manual intervention" and never retry
- **Root Cause**: `_open_initial_position()` returned without setting `_needs_position_recovery = True` on failure, so `_run_iteration()` never triggered recovery
- **Impact**: Bot would sit idle with ~$9k in wallet, never attempting to open a position after a failed startup

**Fix Location**: `lp_strategy.py` in `_open_initial_position()` method

**Changes Made**:
1. All failure paths in `_open_initial_position()` now set `_needs_position_recovery = True`
2. Failure scenarios covered:
   - Trade executor not available
   - Failed to get market state
   - Failed to get pool state (including exceptions)
   - Position value below minimum threshold
   - Position open failed
   - Exception during position opening
3. Each failure sets a descriptive `_recovery_reason` for debugging

**Expected Behavior After Fix**:
- If initial position opening fails, bot sets recovery flag
- On next iteration, `_run_iteration()` sees `_needs_position_recovery = True`
- Bot attempts recovery via `_attempt_position_recovery()`
- Recovery retries up to `_max_recovery_attempts` times

### December 27, 2025 - Multi-Instance Setup
**Deployed second instance for strategy comparison:**
- ✅ Created `lp-strategy-v2-instance2` with separate configuration
- ✅ Separate persistent volume: `lp_strategy_data_instance2`
- ✅ Different strategy parameters for A/B testing
- ✅ Independent wallet and API credentials

### December 23, 2025 - CRITICAL BUG FIX: Swap Retry Price Staleness
**Fixed root cause of repeated swap failures during rebalancing:**
- ✅ **Bug**: Swap retries used stale price data, causing Jupiter transaction simulation failures (error 0x1)
- ✅ **Location**: `execution.py:1543-1575` in `open_position_with_rebalance()` method
- ✅ **Fix**: Refetch current pool price before swap retry to ensure accurate swap amount calculations
- ✅ **Impact**: Eliminates the systematic swap failures that occurred during rebalancing but not during recovery

**Technical Details:**
- Previous behavior: After initial swap failed, retry used the same price from minutes earlier
- New behavior: Fetches fresh on-chain price before retry, accounting for market movements
- Result: Swap calculations use current market conditions, preventing invalid transaction parameters
- Logging: Added detailed price change tracking to monitor effectiveness

**Evidence of Fix:**
- Swap failures during rebalancing: 8 consecutive failures with increasing slippage (100-500 bps)
- Swap success during recovery: Immediate success with 100 bps after ~90s delay (fresh price)
- Root cause: Stale price → wrong swap amount → Jupiter error 0x1
- Resolution: Fresh price on retry → correct swap amount → success

### December 19, 2025 - Code Cleanup
**Removed unused/buggy code** to eliminate confusion and reduce attack surface:
- ✅ Removed `app/bot/` - Incomplete alternative implementation with 5 critical bugs
- ✅ Removed `app/api/` - API server not used by production lp_strategy.py
- ✅ Removed `app/db/` - Database code not used by production lp_strategy.py
- ✅ Removed `app/ui/` - UI templates not used by production lp_strategy.py
- ✅ Removed `app/chain/` files that depended on app/db (position_manager, pool_monitor, wallet_tracker, price_feed, pool_data_service)
- ✅ Fixed Bug #2: Dead monitor cleanup (positions closed externally now trigger recovery)
- ✅ Removed DRY_RUN logic (production always runs live)

**Production app unaffected**: `lp_strategy.py` only uses `app/chain/` modules that remain.

---

## 🎯 Deployed Apps Configuration

### Active Deployments

Three apps are currently deployed:

1. **sol-usdc-lp-manager** (legacy, using old fly.toml at project root)
2. **lp-strategy-v2** (Instance 1 - using test_deployment_v2/fly.toml)
3. **lp-strategy-v2-instance2** (Instance 2 - using test_deployment_v2/fly-instance2.toml)

---

## 📋 Configuration Parameters

### **Instance 1: lp-strategy-v2**

Configuration file: `test_deployment_v2/fly.toml`

#### Session Settings
```
CHECK_INTERVAL_SECONDS = 60        # Check position every 60 seconds
SESSION_DURATION_MINUTES = 20160   # 2 weeks runtime
MAX_POSITIONS = 1                  # Maximum concurrent positions
```

#### Capital Settings
```
CAPITAL_DEPLOYMENT_PCT = 0.90      # Deploy 90% of wallet balance
MAX_SOL_PER_POSITION = 50.0        # Upper limit cap - max 50 SOL per position
MAX_USDC_PER_POSITION = 10000.0    # Upper limit cap - max $10,000 USDC per position
MIN_SOL_RESERVE = 0.10             # Keep 0.10 SOL for transaction fees
```

#### Range Settings
```
K_COEFFICIENT = 0.60               # Aggression coefficient (range width relative to ATR)
K_MIN = 0.55
K_MAX = 0.65
MIN_RANGE = 0.03                   # Minimum range width: 3%
MAX_RANGE = 0.07                   # Maximum range width: 7%
```

#### ATR Configuration
```
ATR_PERIOD_DAYS = 14
ATR_RECALC_INTERVAL_HOURS = 4
MIN_HOURS_BETWEEN_RANGE_UPDATES = 12    # Update ranges at most every 12 hours
ATR_CHANGE_THRESHOLD = 0.10             # 10% ATR change triggers range update
```

#### Rebalance Settings
```
MAX_REBALANCES_PER_DAY = 2         # Maximum 2 rebalances per UTC day
RATIO_SKEW_HIGH = 0.97             # 97% - effectively disables skew rebalancing
RATIO_SKEW_LOW = 0.05              # 5% - effectively disables skew rebalancing
EMERGENCY_ATR_MULTIPLE = 3.0
SLIPPAGE_BPS = 15                  # Position open slippage: 0.15% (applied to token_max buffer)
TOKEN_MAX_BASE_BUFFER = 1.10       # DEPRECATED (no-op): token_max now uses full wallet balance as ceiling
```

#### Pool Settings
```
SOL_USDC_POOL = Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE
# Orca Whirlpool SOL/USDC 0.04% fee pool (tick_spacing=4)
```

#### Swap Settings
```
SWAP_ENABLED = true
SWAP_IMBALANCE_THRESHOLD = 0.08    # 8% imbalance threshold
SWAP_SLIPPAGE_BPS = 15             # Swap slippage: 0.15%
```

#### Transaction Settings
```
TX_PRIORITY_FEE_ENABLED = true     # Enable priority fees for faster inclusion
TX_PRIORITY_FEE_MICROLAMPORTS = 1000  # ~$0.0001 per transaction
TX_COMPUTE_UNIT_LIMIT = 200000     # Compute units for LP operations
```

#### Token Extensions (Token2022)
```
USE_TOKEN_EXTENSIONS = true        # Use Token2022 for position NFTs (saves ~$1.15/position)
TOKEN_EXTENSIONS_WITH_METADATA = true  # Include metadata in Token2022 positions
```

---

### **Instance 2: lp-strategy-v2-instance2**

Configuration file: `test_deployment_v2/fly-instance2.toml`

#### Session Settings
```
CHECK_INTERVAL_SECONDS = 120       # Check position every 2 minutes (less frequent)
SESSION_DURATION_MINUTES = 20160   # 2 weeks runtime
MAX_POSITIONS = 1                  # Maximum concurrent positions
```

#### Capital Settings
```
CAPITAL_DEPLOYMENT_PCT = 0.90      # Deploy 90% of wallet balance
MAX_SOL_PER_POSITION = 50.0        # Upper limit cap - max 50 SOL per position
MAX_USDC_PER_POSITION = 10000.0    # Upper limit cap - max $10,000 USDC per position
MIN_SOL_RESERVE = 0.10             # Keep 0.10 SOL for transaction fees
```

#### Range Settings
```
K_COEFFICIENT = 0.80               # Aggression coefficient (narrower ranges than Instance 1's K=0.60)
K_MIN = 0.55
K_MAX = 0.80                       # Expanded Jan 20 to allow K=0.80
MIN_RANGE = 0.035                  # Minimum range width: 3.5%
MAX_RANGE = 0.07                   # Maximum range width: 7%
```

#### ATR Configuration
```
ATR_PERIOD_DAYS = 14
ATR_RECALC_INTERVAL_HOURS = 4
MIN_HOURS_BETWEEN_RANGE_UPDATES = 4     # Update ranges at most every 4 hours (MORE FREQUENT)
ATR_CHANGE_THRESHOLD = 0.01             # 1% ATR change triggers range update (Jan 20 fix: was 0.001)
```

#### Rebalance Settings
```
MAX_REBALANCES_PER_DAY = 3         # Maximum 3 rebalances per UTC day (MORE FREQUENT)
RATIO_SKEW_HIGH = 1.0              # 100% - completely disables skew rebalancing
RATIO_SKEW_LOW = 0.05              # 5% - completely disables skew rebalancing
EMERGENCY_ATR_MULTIPLE = 3.0
SLIPPAGE_BPS = 15                  # Position open slippage: 0.15% (applied to token_max buffer)
TOKEN_MAX_BASE_BUFFER = 1.10       # DEPRECATED (no-op): token_max now uses full wallet balance as ceiling
```

#### Pool Settings
```
SOL_USDC_POOL = Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE
# Orca Whirlpool SOL/USDC 0.04% fee pool (tick_spacing=4)
```

#### Swap Settings
```
SWAP_ENABLED = true
SWAP_IMBALANCE_THRESHOLD = 0.08    # 8% imbalance threshold
SWAP_SLIPPAGE_BPS = 20             # Swap slippage: 0.20%
```

#### Transaction Settings
```
TX_PRIORITY_FEE_ENABLED = true     # Enable priority fees for faster inclusion
TX_PRIORITY_FEE_MICROLAMPORTS = 1000  # ~$0.0001 per transaction
TX_COMPUTE_UNIT_LIMIT = 200000     # Compute units for LP operations
```

#### Token Extensions (Token2022)
```
USE_TOKEN_EXTENSIONS = true        # Use Token2022 for position NFTs (saves ~$1.15/position)
TOKEN_EXTENSIONS_WITH_METADATA = false  # Disabled - bot doesn't need metadata display
```

---

### **Configuration Notes**

**Capital Deployment**:
- Both instances use percentage-based deployment (90% of wallet)
- Position size = min(wallet_balance × deployment_pct, configured_max)
- MAX_SOL/USDC_PER_POSITION act as safety upper bounds

**Strategy Comparison**:
- **Instance 1**: More conservative - checks frequently (60s), updates ranges infrequently (12h), requires 10% ATR change, K=0.60 for wider ranges
- **Instance 2**: More adaptive - checks less often (120s), updates ranges more often (4h), requires 1% ATR change (Jan 20 fix: was 0.1%), K=0.80 for narrower ranges, allows one extra rebalance per day

---

### **Secrets (Fly.io - encrypted)**

**IMPORTANT**: Each instance has its own separate secrets set via `flyctl secrets set -a <app-name>`

#### Instance 1: lp-strategy-v2
```
# Set with: flyctl secrets set -a lp-strategy-v2 KEY=value

SOLANA_RPC_URL = (separate RPC endpoint for instance 1)
HELIUS_API_KEY = (separate Helius key for instance 1)
BIRDEYE_API_KEY = (separate Birdeye key for instance 1)
JUPITER_API_KEY = (separate Jupiter key for instance 1)
WALLET_PRIVATE_KEY_BASE58 = (separate wallet for instance 1)

EMAIL_ENABLED = true
EMAIL_SENDER = stlservice25@gmail.com
EMAIL_RECIPIENTS = sowelu94@gmail.com
EMAIL_PASSWORD = (Gmail App Password)

DRY_RUN = false                                # Live trading enabled
```

#### Instance 2: lp-strategy-v2-instance2
```
# Set with: flyctl secrets set -a lp-strategy-v2-instance2 KEY=value

SOLANA_RPC_URL = (separate RPC endpoint for instance 2)
HELIUS_API_KEY = (separate Helius key for instance 2)
BIRDEYE_API_KEY = (separate Birdeye key for instance 2)
JUPITER_API_KEY = (separate Jupiter key for instance 2)
WALLET_PRIVATE_KEY_BASE58 = (separate wallet for instance 2)

EMAIL_ENABLED = true
EMAIL_SENDER = stlservice25@gmail.com
EMAIL_RECIPIENTS = sowelu94@gmail.com
EMAIL_PASSWORD = (Gmail App Password)

DRY_RUN = false                                # Live trading enabled
```

**Note**: Secrets are NOT stored in configuration files for security. They are managed via Fly.io secrets.

---

### **Additional Parameters (from .env - not used in deployment)**

These are in the local `.env` file but NOT used in deployment (Fly.io uses fly.toml + secrets):

```
# ATR Configuration
ATR_PERIOD_DAYS = 14
ATR_RECALC_INTERVAL_HOURS = 4
MIN_HOURS_BETWEEN_RANGE_UPDATES = 12
ATR_CHANGE_THRESHOLD = 0.10

# Advanced K coefficient settings
K_MIN = 0.55
K_MAX = 0.65

# Emergency rebalance
EMERGENCY_ATR_MULTIPLE = 3.0

# Position monitoring (for manual position tracking)
POSITION_ADDRESS = (empty)
OPEN_PRICE = (empty)

# Network
SOLANA_NETWORK = mainnet-beta
```

---

## 📁 File Structure and Locations

### **Main Repository**
```
/home/sowelo/Scrivania/STLService/
```

### **Deployed App Source Code**
```
/home/sowelo/Scrivania/STLService/test_deployment_v2/
```

### **Configuration Files**

#### Fly.io Configuration - Instance 1
```
/home/sowelo/Scrivania/STLService/test_deployment_v2/fly.toml
  ↳ App: lp-strategy-v2
  ↳ Dockerfile: test_deployment_v2/Dockerfile
  ↳ Volume: lp_strategy_data → /data
  ↳ Deploy: cd /home/sowelo/Scrivania/STLService && flyctl deploy -c test_deployment_v2/fly.toml
```

#### Fly.io Configuration - Instance 2
```
/home/sowelo/Scrivania/STLService/test_deployment_v2/fly-instance2.toml
  ↳ App: lp-strategy-v2-instance2
  ↳ Dockerfile: test_deployment_v2/Dockerfile
  ↳ Volume: lp_strategy_data_instance2 → /data
  ↳ Deploy: cd /home/sowelo/Scrivania/STLService && flyctl deploy -c test_deployment_v2/fly-instance2.toml
```

#### Local Environment File (NOT used in deployment)
```
/home/sowelo/Scrivania/STLService/test_deployment_v2/.env
  ↳ Contains all secrets and config for LOCAL testing
  ↳ NOT copied to Docker container (in .dockerignore)
  ↳ Fly.io uses secrets instead
```

#### Docker Configuration
```
/home/sowelo/Scrivania/STLService/test_deployment_v2/Dockerfile
  ↳ Multi-stage build
  ↳ Python 3.11-slim base image
  ↳ Installs dependencies from requirements.txt
```

#### Python Dependencies
```
/home/sowelo/Scrivania/STLService/test_deployment_v2/requirements.txt
  ↳ anchorpy, solana, solders, httpx, etc.
```

---

### **Source Code Files**

#### Main Application Files
```
/home/sowelo/Scrivania/STLService/test_deployment_v2/

Main orchestrator:
├── lp_strategy.py           # Main LP strategy orchestrator (entry point)

Core modules:
├── config.py                # Configuration management (loads env vars)
├── execution.py             # Trade execution (open/close/rebalance)
├── market_analyzer.py       # Market analysis (ATR, volatility, range calculation)
├── position_monitor.py      # Position monitoring and tracking
├── session_manager.py       # Session state management

Logging and notifications:
├── csv_logger.py            # CSV logging (LP management, fees, pool state)
├── email_notifier.py        # Email notifications

Utilities:
├── pool_metrics_calculator.py  # Pool metrics calculation
├── volume_calculator.py        # Volume calculation utilities
```

#### Chain Integration (app/chain/)
```
/home/sowelo/Scrivania/STLService/test_deployment_v2/app/chain/

Core chain clients (USED by lp_strategy.py):
├── orca_client.py           # Orca Whirlpool integration (main)
├── orca_api_client.py       # Orca API client (pool metrics)
├── aggregator_jupiter.py    # Jupiter swap aggregator
├── solana_client.py         # Solana RPC client
├── helius_client.py         # Helius RPC client (fee parsing)
├── wsol_cleanup.py          # Wrapped SOL cleanup manager

Additional clients (available but not actively used):
├── birdeye_client.py        # Birdeye price API
├── solscan_client.py        # Solscan explorer API
├── dune_client.py           # Dune Analytics API
├── cambrian_client.py       # Cambrian API
├── mainnet_client.py        # Mainnet utilities

Utilities:
├── whirlpool_instructions.py # Whirlpool instruction builders
├── transaction_manager.py   # Transaction building and sending

IDL files:
└── idl/
    └── whirlpool.json       # Orca Whirlpool program IDL

REMOVED (Dec 19, 2025 - unused/buggy code cleanup):
❌ app/bot/ - Incomplete alternative implementation with bugs
❌ app/api/ - API server (not used by lp_strategy.py)
❌ app/db/ - Database code (not used by lp_strategy.py)
❌ app/ui/ - UI templates (not used by lp_strategy.py)
❌ position_manager.py - Depended on app/db
❌ pool_monitor.py - Depended on app/db
❌ wallet_tracker.py - Depended on app/db
❌ price_feed.py - Depended on app/db
❌ pool_data_service.py - Depended on app/db
```

#### App Structure (app/)
```
/home/sowelo/Scrivania/STLService/test_deployment_v2/app/

├── chain/                   # Chain clients (see above)
├── config.py                # Pydantic configuration (used by chain modules)
└── __init__.py              # Package marker

NOTE: The app/ folder only contains chain clients and config.
The main application uses test_deployment_v2/*.py modules directly.
```

---

### **Data Storage (in deployed containers)**

**IMPORTANT**: Each instance has its own persistent volume with completely isolated data.

#### Instance 1: lp-strategy-v2
```
Volume: lp_strategy_data → /data/

Access logs:
  flyctl ssh console -a lp-strategy-v2 -C "ls -lah /data/"
  flyctl ssh sftp get /data/lp_management.csv ./instance1_data.csv -a lp-strategy-v2

CSV files created:
├── lp_management.csv              # Position lifecycle tracking
├── asset_fees_management.csv      # Swaps and fee collections
├── pool_state_history.csv         # Pool state snapshots

Session-specific CSV files:
├── session_{timestamp}_pool_state.csv
├── session_{timestamp}_rebalances.csv
├── session_{timestamp}_snapshots.csv
├── session_{timestamp}_swaps.csv
├── session_{timestamp}_wsol_cleanup.csv

State files:
└── state_{timestamp}.json         # Session state snapshots
```

#### Instance 2: lp-strategy-v2-instance2
```
Volume: lp_strategy_data_instance2 → /data/

Access logs:
  flyctl ssh console -a lp-strategy-v2-instance2 -C "ls -lah /data/"
  flyctl ssh sftp get /data/lp_management.csv ./instance2_data.csv -a lp-strategy-v2-instance2

CSV files created:
├── lp_management.csv              # Position lifecycle tracking
├── asset_fees_management.csv      # Swaps and fee collections
├── pool_state_history.csv         # Pool state snapshots

Session-specific CSV files:
├── session_{timestamp}_pool_state.csv
├── session_{timestamp}_rebalances.csv
├── session_{timestamp}_snapshots.csv
├── session_{timestamp}_swaps.csv
├── session_{timestamp}_wsol_cleanup.csv

State files:
└── state_{timestamp}.json         # Session state snapshots
```

---

## 🔑 Important Notes

### What's Used in Deployment
1. **fly.toml** - Environment variables (non-sensitive config)
2. **Fly.io Secrets** - Sensitive data (API keys, wallet, email)
3. **test_deployment_v2/** - All source code

### What's NOT Used in Deployment
1. **test_deployment_v2/.env** - Local testing only
2. Test files (test_*.py) - Not copied to container
3. Documentation files (*.md) - Not copied to container

### Configuration Priority
```
Deployed app reads configuration in this order:
1. Fly.io Secrets (highest priority)
2. fly.toml [env] section
3. Hardcoded defaults in config.py
```

### Entry Point
```
Docker CMD: python lp_strategy.py
  ↳ Starts the main LP strategy orchestrator
  ↳ Runs indefinitely (SESSION_DURATION_MINUTES=0)
  ↳ Checks position every 60 seconds
```

---

## 📊 Current Deployment Info

### Instance 1: lp-strategy-v2
- **App**: lp-strategy-v2
- **Region**: iad (US East - Ashburn, Virginia)
- **Memory**: 1 GB
- **CPU**: 1 shared vCPU
- **Volume**: lp_strategy_data (mounted at /data)
- **Config**: test_deployment_v2/fly.toml

### Instance 2: lp-strategy-v2-instance2
- **App**: lp-strategy-v2-instance2
- **Region**: iad (US East - Ashburn, Virginia)
- **Memory**: 1 GB
- **CPU**: 1 shared vCPU
- **Volume**: lp_strategy_data_instance2 (mounted at /data)
- **Config**: test_deployment_v2/fly-instance2.toml

### Legacy: sol-usdc-lp-manager
- **App**: sol-usdc-lp-manager (legacy deployment)
- **Region**: iad (US East - Ashburn, Virginia)
- **Memory**: 1 GB
- **CPU**: 1 shared vCPU
- **Volume**: lp_data (mounted at /data)

---

## 🔄 How to Update Configuration

### Change Environment Variables (Instance 1)
```bash
# Edit instance 1 config
nano /home/sowelo/Scrivania/STLService/test_deployment_v2/fly.toml

# Redeploy instance 1
cd /home/sowelo/Scrivania/STLService
flyctl deploy -c test_deployment_v2/fly.toml
```

### Change Environment Variables (Instance 2)
```bash
# Edit instance 2 config
nano /home/sowelo/Scrivania/STLService/test_deployment_v2/fly-instance2.toml

# Redeploy instance 2
cd /home/sowelo/Scrivania/STLService
flyctl deploy -c test_deployment_v2/fly-instance2.toml
```

### Change Secrets (Instance-Specific)
```bash
# Update instance 1 secrets
flyctl secrets set KEY=value -a lp-strategy-v2

# Update instance 2 secrets
flyctl secrets set KEY=value -a lp-strategy-v2-instance2

# Example: Change rebalance limit for instance 1
flyctl secrets set MAX_REBALANCES_PER_DAY=5 -a lp-strategy-v2
```

### Update Source Code (Affects Both Instances)
```bash
# Edit files in test_deployment_v2/
cd /home/sowelo/Scrivania/STLService/test_deployment_v2
nano lp_strategy.py

# Redeploy both instances
cd /home/sowelo/Scrivania/STLService
flyctl deploy -c test_deployment_v2/fly.toml              # Instance 1
flyctl deploy -c test_deployment_v2/fly-instance2.toml    # Instance 2
```

### Monitor Both Instances
```bash
# View all apps
flyctl apps list

# Instance 1 status and logs
flyctl status -a lp-strategy-v2
flyctl logs -a lp-strategy-v2

# Instance 2 status and logs
flyctl status -a lp-strategy-v2-instance2
flyctl logs -a lp-strategy-v2-instance2

# Access CSV data
flyctl ssh console -a lp-strategy-v2 -C "ls -lah /data/"
flyctl ssh console -a lp-strategy-v2-instance2 -C "ls -lah /data/"
```

### Stop/Start Instances
```bash
# Stop instance 1
flyctl apps stop lp-strategy-v2

# Start instance 1
flyctl apps resume lp-strategy-v2

# Stop instance 2
flyctl apps stop lp-strategy-v2-instance2

# Start instance 2
flyctl apps resume lp-strategy-v2-instance2
```

---

## 📧 Email Notifications Configured

Emails are sent for:
- App started
- Position opened
- Position closed
- Position open failed (NEW - Jan 19, 2026)
- **Position lost** (NEW - Jan 19, 2026) - Critical notification when position is unexpectedly lost
- Rebalance executed
- Rebalance failed
- Swap executed
- Position recovery
- Recovery exhausted (NEW - Jan 19, 2026)
- Session ended
- Out of range alerts
- Error notifications
- Critical failures (swap failure, capital deployment issues)

All emails sent to: **sowelu94@gmail.com**
From: **stlservice25@gmail.com**

---

## 🚀 Deploying Instance 2: Step-by-Step

### Prerequisites
- Fly CLI installed and authenticated
- Two separate Solana wallets (one for each instance)
- Separate API keys for each instance (recommended)

### Deployment Steps

#### 1. Create the Fly.io App
```bash
cd /home/sowelo/Scrivania/STLService
flyctl apps create lp-strategy-v2-instance2 --org alex-norta
```

#### 2. Create the Persistent Volume
```bash
flyctl volumes create lp_strategy_data_instance2 \
  --region iad \
  --size 1 \
  --app lp-strategy-v2-instance2
```

#### 3. Set Secrets
```bash
flyctl secrets set \
  --app lp-strategy-v2-instance2 \
  SOLANA_RPC_URL="YOUR_RPC_URL" \
  HELIUS_API_KEY="YOUR_HELIUS_KEY" \
  BIRDEYE_API_KEY="YOUR_BIRDEYE_KEY" \
  JUPITER_API_KEY="YOUR_JUPITER_KEY" \
  WALLET_PRIVATE_KEY_BASE58="YOUR_WALLET_KEY" \
  EMAIL_ENABLED="true" \
  EMAIL_SENDER="stlservice25@gmail.com" \
  EMAIL_RECIPIENTS="sowelu94@gmail.com" \
  EMAIL_PASSWORD="YOUR_EMAIL_PASSWORD"
```

#### 4. Deploy the Application
```bash
cd /home/sowelo/Scrivania/STLService
flyctl deploy -c test_deployment_v2/fly-instance2.toml
```

#### 5. Verify Deployment
```bash
# Check status
flyctl status -a lp-strategy-v2-instance2

# View logs
flyctl logs -a lp-strategy-v2-instance2

# Check data directory
flyctl ssh console -a lp-strategy-v2-instance2 -C "ls -lah /data/"
```

### Accessing Instance 2 Logs

```bash
# Download CSV logs
flyctl ssh sftp get /data/lp_management.csv ./instance2_lp_management.csv -a lp-strategy-v2-instance2

# View real-time logs
flyctl logs -a lp-strategy-v2-instance2 -f

# SSH into container
flyctl ssh console -a lp-strategy-v2-instance2
```

### Comparing Instances

Download logs from both instances and analyze in notebooks:
```bash
# Get instance 1 data
flyctl ssh sftp get /data/lp_management.csv ./data/instance1_lp_management.csv -a lp-strategy-v2

# Get instance 2 data
flyctl ssh sftp get /data/lp_management.csv ./data/instance2_lp_management.csv -a lp-strategy-v2-instance2
```

Then analyze in Python:
```python
import pandas as pd

# Load data
df1 = pd.read_csv('data/instance1_lp_management.csv')
df2 = pd.read_csv('data/instance2_lp_management.csv')

# Compare strategies
print(f"Instance 1 rebalances: {len(df1)}")
print(f"Instance 2 rebalances: {len(df2)}")
```
