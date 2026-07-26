/**
 * Display formatting helpers for the portfolio dashboard.
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

export function formatUsd(value: number): string {
  return USD.format(value);
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
