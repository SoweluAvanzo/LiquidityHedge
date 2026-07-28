/**
 * Landing-page content, in one place.
 *
 * The visible page and the JSON-LD structured data are both generated from
 * these objects, so what a crawler reads and what a human reads can never
 * drift apart. Everything here must be true of what actually exists —
 * no projected numbers, no aspirational coverage.
 */

export interface SpecField {
  name: string;
  type: string;
  description: string;
}

/**
 * Column order of the long-format CSV, matching the writer in
 * `services/ops-jobs/src/data-report.ts`.
 */
export const CSV_FIELDS: SpecField[] = [
  {
    name: "pool",
    type: "string · base58",
    description:
      "Whirlpool account address. The join key of the long-format file — one file holds every covered pool.",
  },
  {
    name: "pair",
    type: "string",
    description:
      "Token symbols as A/B, e.g. SOL/USDC. Token A is the base, token B the quote. Where a token publishes no symbol in the Orca token list, the first characters of its mint address stand in (e.g. A7bd/EPjF) — currently the case for a minority of long-tail pools; the pool column is always the authoritative key, and empty when the pool's metadata could not be resolved at all.",
  },
  {
    name: "t",
    type: "integer · seconds",
    description: "Snapshot instant, Unix epoch seconds, UTC.",
  },
  {
    name: "iso",
    type: "string · ISO-8601",
    description: "The same instant in ISO-8601, so the file is readable without conversion.",
  },
  {
    name: "price",
    type: "float",
    description:
      "Pool price of token A in token B at the snapshot, adjusted for both mints' decimals.",
  },
  {
    name: "liquidity",
    type: "u128 · string",
    description:
      "Liquidity active at the current tick. Needed to convert fee growth into a token amount, and to dilute the counterfactual for a large hypothetical position.",
  },
  {
    name: "feeGrowthGlobalA",
    type: "u128 · Q64.64 · string",
    description:
      "Cumulative token-A fees earned per unit of liquidity since pool genesis, as the pool itself accounts for them. Monotone, wraps modulo 2^128.",
  },
  {
    name: "feeGrowthGlobalB",
    type: "u128 · Q64.64 · string",
    description: "The same accumulator for token B.",
  },
  {
    name: "vaultA",
    type: "u64 · string",
    description: "Pool token-A vault balance in native units at the snapshot.",
  },
  {
    name: "vaultB",
    type: "u64 · string",
    description: "Pool token-B vault balance in native units at the snapshot.",
  },
  {
    name: "decimalsA",
    type: "integer",
    description: "Token A mint decimals, so native units convert without a second data source.",
  },
  {
    name: "decimalsB",
    type: "integer",
    description: "Token B mint decimals.",
  },
  {
    name: "tvlQuote",
    type: "float",
    description:
      "Exact on-chain TVL in quote-token units: vaultB + vaultA × price. Read from the vaults, not modelled or vendor-supplied.",
  },
  {
    name: "quoteIsUsd",
    type: "boolean",
    description:
      "True when token B is a USD stablecoin (USDC, USDT, USDS, USDG) — the only case in which tvlQuote is denominated in dollars.",
  },
];

export interface FaqItem {
  q: string;
  a: string;
}

export const FAQ: FaqItem[] = [
  {
    q: "What problem do these two products solve?",
    a: "A concentrated-liquidity position earns fees only while the market price sits inside the range its owner chose, and loses value relative to holding the tokens outright as the price moves across that range. Both exposures are properties of the range. The data product establishes what any range would in fact have earned, measured rather than modelled, so a range can be evaluated before capital is committed to it. The hedge product covers what a position loses in mark-to-market terms while the price moves inside its range, for a fixed seven-day term.",
  },
  {
    q: "Is this specific to one chain or one exchange?",
    a: "No. Concentrated liquidity is constructed identically wherever it is offered: a position is a range, fees accrue per unit of liquidity active within that range, and value varies with price along the same curve. Neither the data schema nor the hedge contract assumes a particular venue. Coverage is the only venue-specific element: both products currently cover Orca Whirlpools on Solana, that being where collection operates and where the pilot settles. Additional venues are added as demand justifies the collection cost, and are delivered in the same file format, requiring no change on the purchaser's side.",
  },
  {
    q: "Can I get this data somewhere else?",
    a: "The obstacle is structural rather than competitive. A pool stores only its current cumulative totals and never the series, so there is no archive to query and no explorer or analytics vendor that exposes it. A fee-growth history can exist only if somebody was sampling the pools at the time, so any interval that was not sampled cannot be recovered. Volume, TVL and APR products are widely available and are not the same thing — none of them is denominated per unit of liquidity, which is the property that makes a specific range computable. Our forward collection has run continuously since 26 July 2026, and we are not aware of another archive of it.",
  },
  {
    q: "Why can a volume, TVL or APR feed not tell me the same thing?",
    a: "Because those describe a pool in aggregate, and a range is not a pool. To know what a specific price range earned you need to know how much liquidity was competing inside that range at each moment, which an aggregate feed does not carry. What we record is denominated per unit of liquidity — it has already divided by the competing liquidity — so the income of any range, including a range that was never held, is a summation over the snapshots in which the price lay within it rather than an estimate. That is the distinction between describing past performance and testing a strategy against it.",
  },
  {
    q: "How are the covered pools chosen?",
    a: "By traded volume over 24 hours, not by TVL: fee accrual is volume-driven, so a large but inactive pool yields little information. Every covered pool clears a 10,000 USDC 24-hour volume threshold; the live pool count is quoted on the order before payment (the tracked set is refreshed daily, so pools that rise above the threshold are added and pools that fall below it are removed; rows already collected for a pool are retained in either case).",
  },
  {
    q: "What is delivered, and in what format?",
    a: "One long-format CSV containing every covered pool, keyed by a pool column and sorted by pool then by time, one row per pool per 15-minute snapshot. RFC-4180 quoting, UTF-8. The full field specification is published at the checkout before payment; the covered period and exact row count are quoted on the order itself, before you pay. Delivery is a signed, single-use download link issued the moment payment is verified on-chain.",
  },
  {
    q: "How do I buy the data?",
    a: "Order it at the checkout. You choose the dataset, receive an exact USDC amount and a payment address, and pay either from a connected wallet or manually from any wallet or exchange. The payment is then verified on-chain — the correct mint, the correct recipient account and the exact amount, at finalized commitment — and only then is a single-use download link issued. The forward dataset is 1 USDC per delivery; the figure is nominal because the collection cost is already incurred, and the intent is to establish who the data is useful to.",
  },
  {
    q: "What does the hedge actually cover, and what is my worst case?",
    a: "It covers the mark-to-market variability of a single position within its own range, in cash, for a term of seven days. If the price settles below the range you receive the full capped amount; within the range you receive the signed change in position value; above the range you pay a smaller capped amount, which is why it costs less than downside-only protection. Both legs are prefunded: you pay the premium plus collateral equal to your own capped maximum obligation, so the worst case is fixed at purchase and you can never owe more than you have already paid. It does not cover fee income, a pool exploit, a stablecoin depeg, or anything after expiry. It is an invite-only pilot with an unlicensed BVI company as your direct counterparty, and capital is at risk.",
  },
  {
    q: "What is not included in the data?",
    a: "No per-position data, no wallet-level attribution, no order flow, no individual swap records, and no price feed other than the pool's own price at the snapshot instant. Fee growth between two snapshots is attributed to the interval, so a range boundary crossed inside a 15-minute gap is resolved at that resolution and no finer. The counterfactual is exact for a marginal position; for a large hypothetical position, dilute it by L_active / (L_active + L) using the liquidity recorded in the same row.",
  },
  {
    q: "Is the 2023–2026 historical archive available now?",
    a: "No. It is a pre-order. The forward dataset is being collected live from 26 July 2026 onward; the historical archive does not exist yet and would be reconstructed on demand by replaying archived Solana swap transactions to rebuild the fee accumulators, producing the same schema. Indicative delivery is 4–6 weeks after an order, and the reconstruction is only funded once demand is confirmed. A pre-order can be placed at the checkout and requires an email address, because delivery is by hand. Nothing is downloadable today.",
  },
];

export interface PricingRow {
  product: string;
  price: string;
  priceValue: string;
  currency: string;
  availability: "InStock" | "PreOrder" | "LimitedAvailability";
  availabilityLabel: string;
  note: string;
}

export const PRICING: PricingRow[] = [
  {
    product: "Portfolio analytics",
    price: "Free",
    priceValue: "0",
    currency: "USD",
    availability: "InStock",
    availabilityLabel: "Live",
    note: "Includes Monte-Carlo simulation of portfolio valuation under three independent models. No account, signature or wallet connection required.",
  },
  {
    product: "Fee-growth dataset · 2026 forward",
    price: "1 USDC",
    priceValue: "1",
    currency: "USDC",
    availability: "InStock",
    availabilityLabel: "Collecting since 26 Jul 2026",
    note: "Per delivery. Covered period and row count quoted before payment.",
  },
  {
    product: "Historical archive · 2023–2026",
    price: "200 USDC",
    priceValue: "200",
    currency: "USDC",
    availability: "PreOrder",
    availabilityLabel: "Pre-order — not yet collected",
    note: "Reconstructed on demand. Indicative delivery 4–6 weeks after order.",
  },
  {
    product: "Liquidity Hedge certificate",
    price: "Quoted per position",
    priceValue: "0",
    currency: "USDC",
    availability: "LimitedAvailability",
    availabilityLabel: "Invite-only pilot",
    note: "Premium = max(P_floor, FV · m_vol − y · E[F]), broken down in full before purchase.",
  },
];
