/**
 * v3 Protocol Smoke Test
 * Run with: npx ts-node test-v3.ts
 */
import {
  DEFAULT_COVER_RATIO, DEFAULT_BARRIER_DEPTH_BPS, DEFAULT_MARKUP_FLOOR,
  DEFAULT_FEE_SPLIT_RATE, DEFAULT_EXPECTED_DAILY_FEE
} from './types';
import { resolveEffectiveMarkup, computeV3Premium, computeV3Payout, computeRtFeeIncome } from './operations/pricing';
import { computeIvRvFromDualSource } from './operations/regime';

// Test 1: Constants
console.log('=== v3 Protocol Smoke Test ===');
console.log(`  Width: +/-7.5% (750 bps)`);
console.log(`  Barrier: ${DEFAULT_BARRIER_DEPTH_BPS} bps (= lower tick)`);
console.log(`  Cover ratio: ${DEFAULT_COVER_RATIO}`);
console.log(`  Markup floor: ${DEFAULT_MARKUP_FLOOR}`);
console.log(`  Fee split: ${DEFAULT_FEE_SPLIT_RATE}`);
console.log(`  Expected daily fee: ${DEFAULT_EXPECTED_DAILY_FEE}`);

// Test 2: Markup resolution
const tests = [
  { ivRv: 1.25, floor: 1.05, expected: 1.25 },
  { ivRv: 0.94, floor: 1.05, expected: 1.05 },
  { ivRv: 1.50, floor: 1.05, expected: 1.50 },
  { ivRv: 1.03, floor: 1.05, expected: 1.05 },
];
console.log('\n=== Markup Resolution ===');
for (const t of tests) {
  const result = resolveEffectiveMarkup(t.ivRv, t.floor);
  const pass = Math.abs(result - t.expected) < 0.001;
  console.log(`  IV/RV=${t.ivRv}, floor=${t.floor} → markup=${result.toFixed(3)} ${pass ? 'PASS' : 'FAIL'}`);
}

// Test 3: Premium calculation
console.log('\n=== Premium Calculation ===');
const fv = 135.0; // fair value in USDC
for (const cover of [0.25, 0.50, 0.75, 1.00]) {
  const prem = computeV3Premium(fv, 1.25, cover);
  console.log(`  FV=$${fv}, markup=1.25, cover=${cover} → premium=$${prem.toFixed(2)}`);
}

// Test 4: Payout scaling
console.log('\n=== Payout Scaling ===');
const fullPayout = 200.0;
for (const cover of [0.25, 0.50, 0.75, 1.00]) {
  const scaled = computeV3Payout(fullPayout, cover);
  console.log(`  Full payout=$${fullPayout}, cover=${cover} → payout=$${scaled.toFixed(2)}`);
}

// Test 5: RT Fee Income (fee split)
console.log('\n=== RT Fee Income (Fee Split) ===');
const scenarios = [
  { fees: 300, rate: 0.10 },  // 10% of $300
  { fees: 100, rate: 0.10 },  // 10% of $100
  { fees: 0,   rate: 0.10 },  // no fees
];
for (const s of scenarios) {
  const income = computeRtFeeIncome(s.fees, s.rate);
  console.log(`  fees=$${s.fees}, rate=${s.rate} → rtFeeIncome=$${income.toFixed(2)}`);
}

// Test 6: Dual-source IV
console.log('\n=== Dual-Source IV ===');
const ivTests = [
  { binance: 0.60, bybit: 0.55, rv: 0.58 },  // bybit lower
  { binance: 0.55, bybit: 0.60, rv: 0.58 },  // binance lower
  { binance: null, bybit: 0.55, rv: 0.58 },   // binance unavailable
];
for (const t of ivTests) {
  const result = computeIvRvFromDualSource(t.binance as any, t.bybit as any, t.rv);
  if (result) {
    console.log(`  BN=${t.binance ?? 'null'}, BB=${t.bybit ?? 'null'}, RV=${t.rv} → IV=${result.iv.toFixed(3)}, IV/RV=${result.ivRvRatio.toFixed(3)}, source=${result.source}`);
  } else {
    console.log(`  BN=${t.binance ?? 'null'}, BB=${t.bybit ?? 'null'} → null (both unavailable)`);
  }
}

console.log('\n=== All tests complete ===');
