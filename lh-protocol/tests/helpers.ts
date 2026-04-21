/**
 * Test Helpers — Factory functions for creating test fixtures.
 *
 * All factories return valid default objects that can be overridden
 * with partial objects for specific test scenarios.
 */

import {
  PoolState,
  PositionState,
  PositionStatus,
  CertificateState,
  CertificateStatus,
  RegimeSnapshot,
  TemplateConfig,
  DEFAULT_MARKUP_FLOOR,
  DEFAULT_FEE_SPLIT_RATE,
  DEFAULT_EXPECTED_DAILY_FEE,
  DEFAULT_PREMIUM_FLOOR_USDC,
  DEFAULT_PROTOCOL_FEE_BPS,
  DEFAULT_U_MAX_BPS,
  DEFAULT_SEVERITY_PPM,
} from "../protocol-src/types";
import { StateStore } from "../protocol-src/event-audit/store";
import { OffchainLhProtocol } from "../protocol-src/index";
import { DEFAULT_TEMPLATE, DEFAULT_POOL_CONFIG } from "../protocol-src/config/templates";

// ---------------------------------------------------------------------------
// Pool factory
// ---------------------------------------------------------------------------

export function makePool(overrides?: Partial<PoolState>): PoolState {
  return {
    reservesUsdc: 100_000_000, // $100
    totalShares: 100_000_000,
    activeCapUsdc: 0,
    uMaxBps: DEFAULT_U_MAX_BPS,
    markupFloor: DEFAULT_MARKUP_FLOOR,
    feeSplitRate: DEFAULT_FEE_SPLIT_RATE,
    expectedDailyFee: DEFAULT_EXPECTED_DAILY_FEE,
    premiumFloorUsdc: DEFAULT_PREMIUM_FLOOR_USDC,
    protocolFeeBps: DEFAULT_PROTOCOL_FEE_BPS,
    bump: 255,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Template factory
// ---------------------------------------------------------------------------

export function makeTemplate(overrides?: Partial<TemplateConfig>): TemplateConfig {
  return {
    ...DEFAULT_TEMPLATE,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Regime factory
// ---------------------------------------------------------------------------

export function makeRegime(overrides?: Partial<RegimeSnapshot>): RegimeSnapshot {
  return {
    pool: "pool",
    sigmaPpm: 650_000,   // 65% annualized vol
    sigma7dPpm: 700_000, // 70% 7-day vol
    stressFlag: false,
    carryBpsPerDay: 5,
    severityPpm: DEFAULT_SEVERITY_PPM,
    ivRvRatio: 1.08,
    effectiveMarkup: Math.max(DEFAULT_MARKUP_FLOOR, 1.08),
    updatedAt: Math.floor(Date.now() / 1000),
    bump: 255,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Position factory
// ---------------------------------------------------------------------------

/**
 * Default liquidity L=50 produces:
 *   V(S_0=150) ≈ $6.00, Cap ≈ $4.40
 * which fits within a $100 pool at 30% utilization (headroom=$30).
 */
export function makePosition(overrides?: Partial<PositionState>): PositionState {
  return {
    positionMint: "pos-mint-1",
    owner: "lp-wallet-1",
    entryPriceE6: 150_000_000,  // $150.00
    lowerTick: -1000,
    upperTick: 1000,
    liquidity: BigInt(50),
    entryValueE6: 6_000_000,    // ~$6.00 position value (consistent with L=50)
    status: PositionStatus.Locked,
    protectedBy: null,
    bump: 255,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Certificate factory
// ---------------------------------------------------------------------------

export function makeCertificate(
  overrides?: Partial<CertificateState>,
): CertificateState {
  const nowTs = Math.floor(Date.now() / 1000);
  return {
    positionMint: "pos-mint-1",
    buyer: "lp-wallet-1",
    pool: "pool",
    templateId: 1,
    entryPriceE6: 150_000_000,
    lowerBarrierE6: 135_000_000,  // 150 * 0.90
    notionalUsdc: 30_000_000,
    capUsdc: 5_000_000,           // ~$5 cap
    premiumUsdc: 500_000,         // $0.50
    protocolFeeUsdc: 7_500,       // 1.5%
    feeSplitRate: 0.10,
    expectedWeeklyFeesUsdc: 1_050_000,
    purchaseTs: nowTs,
    expiryTs: nowTs + 604_800,
    state: CertificateStatus.Active,
    bump: 255,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Initialized protocol (full setup for integration tests)
// ---------------------------------------------------------------------------

export interface TestProtocolSetup {
  protocol: OffchainLhProtocol;
  pool: PoolState;
  template: TemplateConfig;
  regime: RegimeSnapshot;
  position: PositionState;
}

/**
 * Create a fully initialized protocol with pool, template, regime,
 * RT deposit, and LP position registered — ready for buyCertificate.
 */
export function setupTestProtocol(opts?: {
  rtDeposit?: number;
  entryPriceE6?: number;
  liquidity?: bigint;
  sigmaPpm?: number;
}): TestProtocolSetup {
  const protocol = new OffchainLhProtocol();

  // Init pool
  const pool = protocol.initPool("admin", DEFAULT_POOL_CONFIG);

  // RT deposits USDC
  const rtDeposit = opts?.rtDeposit ?? 100_000_000; // $100
  protocol.depositUsdc("rt-wallet-1", rtDeposit);

  // Create template
  const template = { ...DEFAULT_TEMPLATE };
  protocol.createTemplate("admin", template);

  // Update regime
  const sigmaPpm = opts?.sigmaPpm ?? 650_000;
  const regime = protocol.updateRegimeSnapshot("risk-service", {
    sigmaPpm,
    sigma7dPpm: Math.floor(sigmaPpm * 1.05),
    stressFlag: false,
    carryBpsPerDay: 5,
    ivRvRatio: 1.08,
  });

  // Register LP position
  const entryPriceE6 = opts?.entryPriceE6 ?? 150_000_000;
  const liquidity = opts?.liquidity ?? BigInt(50);

  protocol.registerLockedPosition("lp-wallet-1", {
    positionMint: "pos-mint-1",
    entryPriceE6,
    lowerTick: -1000,
    upperTick: 1000,
    liquidity,
    entryValueE6: 6_000_000,
  });

  const position = protocol.getPositionState("pos-mint-1")!;

  return {
    protocol,
    pool: protocol.getPoolState()!,
    template,
    regime,
    position,
  };
}

// ---------------------------------------------------------------------------
// Price simulation helpers
// ---------------------------------------------------------------------------

/**
 * Simple seeded pseudo-random number generator (Mulberry32).
 * Deterministic: same seed produces same sequence.
 */
export function createRng(seed: number): () => number {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Generate a GBM price path for simulation.
 *
 * S_{t+1} = S_t * exp(-σ²/2 * dt + σ * √dt * Z)
 *
 * @param S0     - Initial price
 * @param sigma  - Annualized volatility
 * @param weeks  - Number of weeks
 * @param seed   - RNG seed for reproducibility
 * @returns Array of weekly prices [S0, S1, ..., S_weeks]
 */
export function generateGbmPath(
  S0: number,
  sigma: number,
  weeks: number,
  seed: number = 42,
): number[] {
  const rng = createRng(seed);
  const dt = 7 / 365; // weekly
  const prices = [S0];

  for (let i = 0; i < weeks; i++) {
    // Box-Muller transform for normal distribution
    const u1 = rng();
    const u2 = rng();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);

    const drift = -0.5 * sigma * sigma * dt;
    const diffusion = sigma * Math.sqrt(dt) * z;
    const newPrice = prices[prices.length - 1] * Math.exp(drift + diffusion);
    prices.push(newPrice);
  }

  return prices;
}

/**
 * Simulate LP fees for a week given a position value and daily fee rate.
 */
export function simulateWeeklyFees(
  positionValueUsd: number,
  dailyFeeRate: number,
  seed: number,
): number {
  const rng = createRng(seed);
  // Fees fluctuate: clip(normal(dailyRate, 0.0018), 0.0005, 0.012) * 7 * value
  const u1 = rng();
  const u2 = rng();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  const rate = Math.max(0.0005, Math.min(0.012, dailyFeeRate + 0.0018 * z));
  return Math.floor(positionValueUsd * rate * 7 * 1_000_000);
}
