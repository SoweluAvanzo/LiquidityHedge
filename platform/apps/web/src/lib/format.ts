/**
 * Display formatting for the whole app — dashboard, simulation, hedge
 * panel and data checkout all import from here, so the same quantity is
 * never rounded two ways on two screens.
 *
 * The rules:
 *  - money always carries an explicit "$"; a bare number is never money;
 *  - USD from a float (portfolio, simulation) → 2 decimals;
 *  - µUSDC integers (hedge, checkout) → 2 decimals at or above $1, 4 below
 *    it, 6 below a cent — the amount is exact on-chain, so precision is
 *    dropped only where it cannot matter;
 *  - an exact payable amount is ALWAYS shown at full 6-decimal precision;
 *  - percentages → 1 decimal, rates in %/day → 2 decimals (3 below 0.1),
 *    fractions of time → whole percent;
 *  - negatives use a real minus sign (−), gains an explicit plus.
 *
 * Pure functions — safe on both server and client.
 */

/** Well-known mainnet mints → ticker symbols. */
const KNOWN_MINTS: Record<string, string> = {
  So11111111111111111111111111111111111111112: "SOL",
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC",
  // Devnet USDC (used by the pilot's devnet pools).
  "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU": "USDC",
};

/** "So11111111111111111111111111111111111111112" → "So1111…1112" */
export function shortenAddress(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** Ticker for a known mint, else the shortened address. */
export function tokenLabel(mint: string): string {
  return KNOWN_MINTS[mint] ?? shortenAddress(mint);
}

/** True when the mint maps to a known ticker (affects pair display). */
export function isKnownMint(mint: string): boolean {
  return mint in KNOWN_MINTS;
}

/** "SOL/USDC" or "So1111…1112 / EPjFWd…t1v" */
export function pairLabel(mintA: string, mintB: string): string {
  const a = tokenLabel(mintA);
  const b = tokenLabel(mintB);
  const bothKnown = isKnownMint(mintA) && isKnownMint(mintB);
  return bothKnown ? `${a}/${b}` : `${a} / ${b}`;
}

const USD = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

/** USD float → "$1,234.56". */
export function formatUsd(value: number): string {
  return USD.format(value);
}

/** Signed USD with an explicit plus so gains and losses read instantly. */
export function formatUsdSigned(value: number): string {
  return value >= 0 ? `+${USD.format(value)}` : USD.format(value);
}

/** Adaptive decimal places: more precision for small magnitudes. */
export function formatNumber(value: number, maxDecimals?: number): string {
  const abs = Math.abs(value);
  const decimals =
    maxDecimals ?? (abs >= 1000 ? 2 : abs >= 1 ? 4 : abs > 0 ? 6 : 2);
  return value.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimals,
  });
}

/** Native (bigint-as-string) token amount → human units string. */
export function formatTokenAmount(raw: string, decimals: number): string {
  const human = Number(raw) / 10 ** decimals;
  return formatNumber(human);
}

// ── µUSDC (integer micro-USDC) ──────────────────────────────────────────

export const USDC_DECIMALS = 6;

/**
 * µUSDC → "$1.50". Adaptive precision: whole-dollar sums get 2 decimals,
 * sub-dollar 4, sub-cent 6.
 */
export function formatUsdc(micro: number): string {
  const usd = micro / 1e6;
  const abs = Math.abs(usd);
  const decimals = abs >= 1 || abs === 0 ? 2 : abs >= 0.01 ? 4 : 6;
  const magnitude = abs.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  return `${usd < 0 ? "−" : ""}$${magnitude}`;
}

/** µUSDC → "$12.345678" — full precision, for an exact payable amount. */
export function formatUsdcExact(micro: number): string {
  const usd = micro / 1e6;
  const magnitude = Math.abs(usd).toLocaleString("en-US", {
    minimumFractionDigits: USDC_DECIMALS,
    maximumFractionDigits: USDC_DECIMALS,
  });
  return `${usd < 0 ? "−" : ""}$${magnitude}`;
}

/** Signed variant with an explicit plus sign for gains. */
export function formatUsdcSigned(micro: number): string {
  return micro > 0 ? `+${formatUsdc(micro)}` : formatUsdc(micro);
}

/**
 * µUSDC → "1.000612" — the bare decimal a wallet's amount field wants,
 * with no currency symbol and no thousands separator.
 */
export function usdcAmountField(micro: number): string {
  return (micro / 1e6).toFixed(USDC_DECIMALS);
}

// ── rates, ratios, time ─────────────────────────────────────────────────

/** 0.0413 → "4.1%". */
export function formatPercent(value: number, decimals = 1): string {
  return `${(value * 100).toFixed(decimals)}%`;
}

/** 0.55 → "55%" — fractions of time (in-range occupancy). */
export function formatFraction(value: number): string {
  return `${(value * 100).toFixed(0)}%`;
}

/** Rate already expressed in %/day: "0.30", or "0.041" below 0.1. */
export function formatRatePct(pctPerDay: number): string {
  return pctPerDay.toFixed(Math.abs(pctPerDay) >= 0.1 ? 2 : 3);
}

/** Per-day fraction → "0.041%/day". */
export function formatDailyYield(fractionPerDay: number): string {
  return `${formatRatePct(fractionPerDay * 100)}%/day`;
}

/** Seconds → "4:03" or "1:02:11" — never negative. */
export function formatCountdown(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const rest = s % 60;
  const mm = hours > 0 ? String(minutes).padStart(2, "0") : String(minutes);
  return `${hours > 0 ? `${hours}:` : ""}${mm}:${String(rest).padStart(2, "0")}`;
}

/** Unix seconds → local date and time, e.g. "26 Jul 2026, 14:03". */
export function formatTimestamp(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
