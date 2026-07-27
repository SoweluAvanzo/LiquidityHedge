/**
 * schema.org JSON-LD for the landing page.
 *
 * Dataset markup is the part that matters most here: data-seeking crawlers
 * and agents read `variableMeasured`, `temporalCoverage` and `distribution`
 * to decide whether a dataset answers a query, so those fields mirror the
 * real CSV schema in `landing-content.ts` rather than restating prose.
 *
 * Emitted as separate <script type="application/ld+json"> blocks, cross
 * referenced by @id.
 */

import {
  CONTACT_EMAIL,
  COVERAGE_START,
  LEGAL_ENTITY,
  SITE_NAME,
  SITE_URL,
  mailto,
} from "@/lib/site";
import { CSV_FIELDS, FAQ, type SpecField } from "@/lib/landing-content";

const ORG_ID = `${SITE_URL}/#organization`;
const SITE_ID = `${SITE_URL}/#website`;

type JsonObject = Record<string, unknown>;

function variableMeasured(fields: SpecField[]): JsonObject[] {
  return fields.map((f) => ({
    "@type": "PropertyValue",
    name: f.name,
    description: f.description,
    unitText: f.type,
  }));
}

const LICENSE_NOTE =
  "Commercial licence for internal use by the purchasing organisation. Redistribution or resale is not permitted. Full terms are provided before purchase.";

const organization: JsonObject = {
  "@context": "https://schema.org",
  "@type": "Organization",
  "@id": ORG_ID,
  name: LEGAL_ENTITY,
  legalName: `${LEGAL_ENTITY}.`,
  alternateName: SITE_NAME,
  url: `${SITE_URL}/`,
  email: CONTACT_EMAIL,
  description:
    "Blocksventures Ltd builds measurement and hedging infrastructure for concentrated-liquidity positions: fee-growth datasets sampled from the pools' own on-chain fee accumulators, cash-settled bilateral hedging certificates offered as an invite-only pilot, and free portfolio analytics. Neither the data schema nor the hedge contract is specific to one venue; coverage today is Orca Whirlpools on Solana.",
  disambiguatingDescription:
    "Blocksventures Ltd is a British Virgin Islands business company. It is not licensed, registered or supervised by any financial regulator, and it is the direct counterparty to any hedging certificate it issues. Its products are not insurance, not deposits and not investment advice.",
  address: {
    "@type": "PostalAddress",
    addressCountry: "VG",
  },
  knowsAbout: [
    "concentrated liquidity",
    "Orca Whirlpools",
    "Solana concentrated liquidity",
    "feeGrowthGlobal accumulators",
    "impermanent loss",
    "liquidity provider fee yield",
  ],
};

const website: JsonObject = {
  "@context": "https://schema.org",
  "@type": "WebSite",
  "@id": SITE_ID,
  name: SITE_NAME,
  alternateName: "Liquidity Hedge Protocol",
  url: `${SITE_URL}/`,
  inLanguage: "en",
  publisher: { "@id": ORG_ID },
  description:
    "Fee-growth datasets, range-risk hedging and free portfolio analytics for concentrated-liquidity positions. Coverage today: Orca Whirlpools on Solana.",
};

const forwardDataset: JsonObject = {
  "@context": "https://schema.org",
  "@type": "Dataset",
  "@id": `${SITE_URL}/#dataset-orca-fee-growth-forward`,
  name: "Orca Whirlpool fee-growth snapshots — 2026 forward",
  alternateName: "Orca concentrated-liquidity fee accrual dataset",
  description:
    "Fifteen-minute snapshots of every Orca Whirlpool on Solana clearing a 10,000 USDC 24-hour volume threshold (approximately 107 pools; the tracked set is refreshed daily). Each row records the pool's own fee accumulators feeGrowthGlobalA and feeGrowthGlobalB (cumulative swap fees per unit of liquidity, Q64.64 fixed point), the liquidity active at the current tick, the decimal-adjusted pool price, and both token vault balances, which give exact on-chain TVL. Because fee growth is denominated per unit of liquidity, the dataset supports computing the exact counterfactual fee income of any price range in any covered pool — including ranges that were never held — which volume, TVL or APR feeds cannot do. No other source of this series is known to exist: a Whirlpool account stores only its current cumulative fee totals and never the history, so the series can exist only where somebody sampled it at the time, and any uncovered interval is unrecoverable. Continuous forward collection has run since 26 July 2026.",
  url: `${SITE_URL}/#data`,
  keywords: [
    "Orca Whirlpool fee growth data",
    "concentrated liquidity fee accrual dataset",
    "feeGrowthGlobal historical snapshots Solana",
    "LP range backtesting data",
    "Solana DeFi market microstructure",
    "liquidity provider yield dataset",
  ],
  temporalCoverage: `${COVERAGE_START}/..`,
  datePublished: COVERAGE_START,
  measurementTechnique:
    "Direct reads of Orca Whirlpool program accounts and token vault accounts from a Solana RPC node, decoded and appended at a fifteen-minute cadence.",
  variableMeasured: variableMeasured(CSV_FIELDS),
  distribution: [
    {
      "@type": "DataDownload",
      name: "pool-snapshots.csv",
      encodingFormat: "text/csv",
      description:
        "One long-format CSV covering every tracked pool, with a `pool` column as the join key, sorted by pool then timestamp, RFC-4180 quoted, UTF-8.",
    },
  ],
  creator: { "@id": ORG_ID },
  publisher: { "@id": ORG_ID },
  license: LICENSE_NOTE,
  isAccessibleForFree: false,
  offers: {
    "@type": "Offer",
    price: "1",
    priceCurrency: "USDC",
    availability: "https://schema.org/InStock",
    url: mailto("Orca fee-growth dataset — 2026 forward"),
    seller: { "@id": ORG_ID },
    description:
      "1 USDC per delivery. Covered period, pool list and row count are quoted before payment.",
  },
};

const historicalDataset: JsonObject = {
  "@context": "https://schema.org",
  "@type": "Dataset",
  "@id": `${SITE_URL}/#dataset-orca-fee-growth-historical`,
  name: "Orca Whirlpool fee-growth archive — 2023–2026 (pre-order)",
  alternateName: "Historical Solana concentrated-liquidity fee accrual archive",
  description:
    "A reconstruction of Orca Whirlpool fee accumulators from 2023 to July 2026, rebuilt on demand by replaying archived Solana swap transactions to recompute feeGrowthGlobalA and feeGrowthGlobalB, delivered in the same long-format CSV schema as the forward dataset. This archive has NOT yet been collected: it is offered as a pre-order, reconstruction is funded once demand is confirmed, and indicative delivery is four to six weeks after order. Nothing is available for immediate download.",
  url: `${SITE_URL}/#archive`,
  keywords: [
    "historical Orca Whirlpool fee data",
    "Solana swap transaction replay",
    "concentrated liquidity backtest dataset 2023 2024 2025",
    "reconstructed feeGrowthGlobal history",
  ],
  temporalCoverage: `2023-01-01/${COVERAGE_START}`,
  measurementTechnique:
    "Replay of archived Solana swap transactions against the Orca Whirlpool fee-accounting rules to rebuild the per-unit-of-liquidity fee accumulators at a fixed cadence.",
  variableMeasured: variableMeasured(CSV_FIELDS),
  distribution: [
    {
      "@type": "DataDownload",
      name: "pool-snapshots-historical.csv",
      encodingFormat: "text/csv",
      description:
        "Same schema and column order as the forward dataset, so the two files concatenate directly.",
    },
  ],
  creator: { "@id": ORG_ID },
  publisher: { "@id": ORG_ID },
  license: LICENSE_NOTE,
  isAccessibleForFree: false,
  creativeWorkStatus: "Not yet collected — available to pre-order",
  offers: {
    "@type": "Offer",
    price: "200",
    priceCurrency: "USDC",
    availability: "https://schema.org/PreOrder",
    availabilityStarts: COVERAGE_START,
    deliveryLeadTime: {
      "@type": "QuantitativeValue",
      minValue: 28,
      maxValue: 42,
      unitCode: "DAY",
    },
    url: mailto("Historical archive 2023–2026 — express interest"),
    seller: { "@id": ORG_ID },
    description:
      "200 USDC pre-order. Reconstruction begins once demand is confirmed; indicative delivery is 4–6 weeks after order.",
  },
};

const analyticsService: JsonObject = {
  "@context": "https://schema.org",
  "@type": "Service",
  "@id": `${SITE_URL}/#service-portfolio-analytics`,
  name: "Orca concentrated-liquidity portfolio analytics",
  serviceType: "Read-only DeFi portfolio analytics",
  description:
    "A free, read-only dashboard for Orca Whirlpool concentrated-liquidity positions: live position value, token amounts, range and in-range status, uncollected fees, V(S) payoff curves, portfolio aggregation, and a Viability Index comparing measured fee yield against the range breakeven with its uncertainty band stated. Includes Monte-Carlo simulation under three independent models — geometric Brownian motion, empirical bootstrap of historical returns, and historical replay — composable over value-only, value-plus-yield and yield-only, with optional stochastic fee intensity. Non-custodial: it never requests a transaction signature and never asks for a seed phrase.",
  url: `${SITE_URL}/app`,
  provider: { "@id": ORG_ID },
  areaServed: "Solana",
  isRelatedTo: { "@id": `${SITE_URL}/#dataset-orca-fee-growth-forward` },
  offers: {
    "@type": "Offer",
    price: "0",
    priceCurrency: "USD",
    availability: "https://schema.org/InStock",
    url: `${SITE_URL}/app`,
    seller: { "@id": ORG_ID },
    description: "Free. No account and no wallet connection required to read a public address.",
  },
};

const hedgeProduct: JsonObject = {
  "@context": "https://schema.org",
  "@type": "FinancialProduct",
  "@id": `${SITE_URL}/#product-liquidity-hedge-certificate`,
  name: "Liquidity Hedge certificate",
  category: "Bilateral cash-settled hedging contract (invite-only pilot)",
  description:
    "A seven-day, cash-settled bilateral contract that replicates the mark-to-market variability of a concentrated-liquidity position inside its own range. The payoff is Π = V(S₀) − V(clamp(S_T, p_l, p_u)): the counterparty pays when the price falls through the range, the buyer pays a capped amount when it rises through the top. Both sides are fully prefunded — the buyer posts premium plus collateral equal to their capped maximum obligation and can never owe more than they have already paid. The premium is Premium = max(P_floor, FV · m_vol − y · E[F]), with fair value computed by quadrature under risk-neutral geometric Brownian motion, and is broken down in full before purchase alongside a hash-committed term sheet, published treasury and exposure figures, and a deterministic settlement policy.",
  url: `${SITE_URL}/#hedge`,
  provider: { "@id": ORG_ID },
  termsOfService: `${SITE_URL}/#legal`,
  disambiguatingDescription:
    "Invite-only pilot. Blocksventures Ltd is the direct counterparty and is not licensed or supervised by any financial regulator. Not available to persons in the United States, the EU/EEA, the United Kingdom or the British Virgin Islands. Not insurance, not a deposit and not investment advice. Capital is at risk and the entire premium can be lost.",
  offers: {
    "@type": "Offer",
    priceCurrency: "USDC",
    availability: "https://schema.org/LimitedAvailability",
    url: mailto("Liquidity Hedge pilot — request access"),
    seller: { "@id": ORG_ID },
    eligibleCustomerType: "https://schema.org/BusinessEntity",
    description:
      "Quoted per position. Access is by request only and is refused to persons in restricted jurisdictions.",
  },
};

const faqPage: JsonObject = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "@id": `${SITE_URL}/#faq`,
  isPartOf: { "@id": SITE_ID },
  mainEntity: FAQ.map((item) => ({
    "@type": "Question",
    name: item.q,
    acceptedAnswer: { "@type": "Answer", text: item.a },
  })),
};

/** Ordered list of the blocks rendered into the page, one <script> each. */
export const STRUCTURED_DATA: JsonObject[] = [
  organization,
  website,
  forwardDataset,
  historicalDataset,
  analyticsService,
  hedgeProduct,
  faqPage,
];

/**
 * Serialise for embedding. `<` is escaped so a stray string can never open
 * a tag and break out of the script element (the pattern Next's own JSON-LD
 * guide prescribes).
 */
export function serializeJsonLd(data: unknown): string {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}
