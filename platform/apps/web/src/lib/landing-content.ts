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
      "Token symbols as A/B, e.g. SOL/USDC. Token A is the base, token B the quote.",
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
    q: "What is feeGrowthGlobal?",
    a: "Every Orca Whirlpool keeps two running counters — feeGrowthGlobalA and feeGrowthGlobalB — that record the total swap fees earned per unit of liquidity since the pool was created, in Q64.64 fixed point. It is the pool's own ledger: the number the program itself uses to decide what any position is owed when its owner collects. It is not a derived statistic and not an estimate, and because it only exists on-chain at the moment you read it, a pool's fee history is unrecoverable unless someone was sampling it.",
  },
  {
    q: "Why does per-unit-of-liquidity accounting matter?",
    a: "Because it makes the counterfactual computable. Volume, TVL and APR feeds tell you what a pool did in aggregate; they cannot tell you what a specific price range would have earned, because they do not know how much competing liquidity sat in that range. Fee growth already divides by the liquidity that was active, so the fee income of any range — including one nobody ever held — is a summation over the snapshots where the price sat inside it: fees(range, L) = Σ ΔfeeGrowthGlobal × L / 2^64. That is the difference between describing the past and backtesting against it.",
  },
  {
    q: "How are the covered pools chosen?",
    a: "By 24-hour traded volume, not TVL: fee accrual is volume-driven, and a large idle pool teaches you nothing. Every Orca Whirlpool clearing a 10,000 USDC 24-hour volume threshold is tracked — roughly 107 pools at the time of writing. The tracked set is refreshed daily, so pools that grow into the threshold are picked up and pools that go quiet drop out; the historical rows already collected for a pool are kept either way.",
  },
  {
    q: "What is delivered, and in what format?",
    a: "One long-format CSV containing every covered pool, with a pool column as the join key and the 14 fields listed in the specification above, sorted by pool then by time. RFC-4180 quoting, UTF-8, one row per pool per 15-minute snapshot. Delivery is by email attachment or a signed download link, with the covered period and row count stated in the message.",
  },
  {
    q: "How do I buy the forward dataset?",
    a: "Order it at the checkout. You choose the dataset, receive an exact USDC amount and a payment address, and pay either from a connected wallet or manually from any wallet or exchange. The payment is then verified on-chain — the correct mint, the correct recipient account and the exact amount, at finalized commitment — and only then is a single-use download link issued. The price is 1 USDC per delivery of the forward dataset; the figure is nominal because the collection cost is already sunk and the point is to see who the data is useful to.",
  },
  {
    q: "What is not included?",
    a: "No per-position data, no wallet-level attribution, no order flow, no individual swap records, and no price feed other than the pool's own price at the snapshot instant. Fee growth between two snapshots is attributed to the interval, so a range boundary crossed inside a 15-minute gap is resolved at that resolution and no finer. The counterfactual is exact for a marginal position; for a large hypothetical position, dilute it by L_active / (L_active + L) using the recorded liquidity.",
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
    note: "No account, no signature, no wallet connection required — paste an address and read.",
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
