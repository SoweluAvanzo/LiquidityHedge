import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";

import "@/styles/landing.css";
import { CorridorFigure } from "@/components/landing/corridor-figure";
import { SiteFooter } from "@/components/chrome/site-footer";
import { SiteHeader } from "@/components/chrome/site-header";
import { CSV_FIELDS, FAQ, PRICING } from "@/lib/landing-content";
import { STRUCTURED_DATA, serializeJsonLd } from "@/lib/structured-data";
import { LEGAL_ENTITY, SITE_NAME, SITE_URL, mailto } from "@/lib/site";

const DESCRIPTION =
  "Fifteen-minute snapshots of the fee accumulators of every Orca Whirlpool trading over $10k a day on Solana — feeGrowthGlobalA/B, active liquidity, price and vault balances — plus free concentrated-liquidity portfolio analytics and a seven-day hedge on range risk.";

const OG = {
  title: "Liquidity Hedge — Orca Whirlpool fee-growth data and range hedging",
  description: DESCRIPTION,
  url: `${SITE_URL}/`,
  siteName: SITE_NAME,
  locale: "en_US",
  type: "website" as const,
};

export const metadata: Metadata = {
  title: {
    absolute:
      "Orca Whirlpool fee-growth data, CL portfolio analytics and range hedging — Liquidity Hedge",
  },
  description: DESCRIPTION,
  keywords: [
    "Orca Whirlpool fee growth data",
    "concentrated liquidity fee accrual dataset",
    "feeGrowthGlobal historical snapshots Solana",
    "LP range backtesting data",
    "impermanent loss hedging Solana",
    "Solana liquidity provider yield dataset",
  ],
  alternates: { canonical: "/" },
  openGraph: OG,
  twitter: {
    card: "summary_large_image",
    title: OG.title,
    description: DESCRIPTION,
  },
  robots: { index: true, follow: true },
};

const DATASET_MAILTO = mailto(
  "Orca fee-growth dataset — 2026 forward",
  "Pools of interest:\nDate range:\nIntended use:",
);
const ARCHIVE_MAILTO = mailto(
  "Historical archive 2023–2026 — express interest",
  "Pools of interest:\nDate range:\nIntended use:\nTimeline you need it by:",
);
const PILOT_MAILTO = mailto(
  "Liquidity Hedge pilot — request access",
  "Position (pool + range):\nJurisdiction of residence:\nWhat you want hedged:",
);

export default async function LandingPage() {
  // The CSP is nonce-based (src/proxy.ts). JSON-LD is a data block rather
  // than executable script, but carrying the nonce keeps it valid under a
  // stricter policy too.
  const nonce = (await headers()).get("x-nonce") ?? undefined;

  return (
    <div className="lp">
      <SiteHeader
        active="home"
        actions={
          <Link href="/app" className="lh-btn">
            Open the dashboard
          </Link>
        }
      />

      <main id="main">
        {/* ── hero ─────────────────────────────────────────────── */}
        <section className="lp-hero">
          <div className="lp-wrap">
            <div className="lp-hero-grid">
              <div>
                <p className="lp-eyebrow">
                  Orca Whirlpools · Solana · concentrated liquidity
                </p>
                <h1 className="lp-h1">
                  The fee ledger of every liquid Orca pool, <em>every 15 minutes</em>.
                </h1>
                <p className="lp-lead">
                  We read the on-chain fee accumulators, active liquidity and
                  vault balances of every Orca Whirlpool trading over $10,000 a
                  day, and write them down. On that record sit three things:
                  free analytics for your own positions, a dataset that lets you
                  compute the fee income of <em>any</em> price range, and a
                  seven-day hedge on the range risk itself.
                </p>
                <div className="lp-btn-row">
                  <a href="#data" className="lp-btn">
                    See what&rsquo;s in the data
                  </a>
                  <Link href="/app" className="lp-btn lp-btn-ghost">
                    Open the dashboard — free
                  </Link>
                </div>

                <dl className="lp-facts">
                  <div className="lp-fact">
                    <dt>Cadence</dt>
                    <dd>15 min</dd>
                  </div>
                  <div className="lp-fact">
                    <dt>Pools tracked</dt>
                    <dd>~107</dd>
                  </div>
                  <div className="lp-fact">
                    <dt>Coverage from</dt>
                    <dd>26 Jul 2026</dd>
                  </div>
                  <div className="lp-fact">
                    <dt>Fields / row</dt>
                    <dd>14</dd>
                  </div>
                </dl>
              </div>

              <CorridorFigure />
            </div>
          </div>
        </section>

        <div className="lp-wrap">
          <div className="lp-ruler">
            <span className="lp-ruler-label">one tick = one snapshot</span>
            <span className="lp-ruler-ticks" aria-hidden="true" />
            <span className="lp-ruler-label">24 h</span>
          </div>
        </div>

        {/* ── services ─────────────────────────────────────────── */}
        <section className="lp-section" id="services">
          <div className="lp-wrap">
            <div className="lp-section-head">
              <p className="lp-eyebrow">What we run</p>
              <h2 className="lp-h2">Four services, priced separately.</h2>
              <p className="lp-lead">
                Nothing is bundled and nothing is a subscription. The analytics
                are free because they cost almost nothing to serve. The data is
                priced to find out who needs it. The hedge is a pilot and is
                described as one.
              </p>
            </div>

            <ul className="lp-services">
              {/* 1 — analytics */}
              <li className="lp-service">
                <div className="lp-service-rail">
                  <div className="lp-rail-inner">
                    <span className="lp-price">Free</span>
                    <span className="lp-tag lp-tag-live">Live</span>
                    <p className="lp-rail-note">
                      No account. No wallet connection needed to read a public
                      address.
                    </p>
                  </div>
                </div>
                <div className="lp-service-body">
                  <h3 className="lp-h3">
                    Portfolio analytics for concentrated-liquidity positions
                  </h3>
                  <p className="lp-p">
                    Paste a Solana address, or connect a wallet, and the
                    dashboard reads every Orca Whirlpool position it owns
                    directly from the chain. For each position it shows the live
                    value and its token split, the range and whether the price
                    is inside it right now, uncollected fees, and the V(S)
                    payoff curve that describes how the position&rsquo;s value
                    moves with price. Positions roll up into a portfolio view.
                  </p>
                  <p className="lp-p">
                    Each position also carries a <b>Viability Index</b>: the fee
                    yield actually measured for it, set against the breakeven
                    yield its range needs to cover expected divergence loss.
                    The estimator and its uncertainty band are printed next to
                    the number — a viability score without an error bar is a
                    guess with a decimal point.
                  </p>
                  <ul className="lp-list lp-list-2">
                    <li>
                      <b>Three independent simulators.</b> Geometric Brownian
                      motion, an empirical bootstrap of historical returns, and
                      historical replay of the path the market actually took.
                    </li>
                    <li>
                      <b>Composable objectives.</b> Run any model over value
                      only, value plus fee yield, or yield only — with fee
                      intensity held constant or made stochastic.
                    </li>
                    <li>
                      <b>Read-only by construction.</b> It never requests a
                      transaction signature and never asks for a seed phrase.
                      Anything that does is not us.
                    </li>
                    <li>
                      <b>Server-side RPC.</b>{" "}
                      Chain access runs through the
                      app&rsquo;s own API, so no provider key or endpoint
                      reaches your browser.
                    </li>
                  </ul>
                  <div className="lp-btn-row">
                    <Link href="/app" className="lp-btn">
                      Open the dashboard
                    </Link>
                  </div>
                </div>
              </li>

              {/* 2 — forward dataset */}
              <li className="lp-service lp-service-featured">
                <div className="lp-service-rail">
                  <div className="lp-rail-inner">
                    <span className="lp-price">
                      1<span className="lp-price-unit">USDC</span>
                    </span>
                    <span className="lp-tag lp-tag-live">Collecting now</span>
                    <p className="lp-rail-note">
                      Per delivery. Covered period and exact row count are quoted
                      before you pay.
                    </p>
                  </div>
                </div>
                <div className="lp-service-body">
                  <h3 className="lp-h3">
                    Orca Whirlpool fee-growth dataset — 2026 forward
                  </h3>
                  <p className="lp-p">
                    Every fifteen minutes, for every Orca Whirlpool clearing
                    $10,000 of 24-hour volume — around 107 pools, with the
                    tracked set refreshed daily — we record the pool&rsquo;s own
                    fee ledger: <code>feeGrowthGlobalA</code> and{" "}
                    <code>feeGrowthGlobalB</code>, the cumulative swap fees
                    earned <b>per unit of liquidity</b> since genesis, in Q64.64
                    fixed point. Alongside them go the liquidity active at the
                    current tick, the decimal-adjusted price, and both token
                    vault balances — which give exact on-chain TVL with no
                    vendor in the loop.
                  </p>
                  <p className="lp-p">
                    Here is the part no other feed gives you. Volume, TVL and APR
                    series describe what a pool did in aggregate; they cannot
                    tell you what a <em>specific range</em> would have earned,
                    because they do not know how much liquidity was competing
                    inside it. Fee growth has already divided by that liquidity.
                    So the fee income of any range in any covered pool —
                    including ranges nobody ever held — is a summation, not a
                    model:
                  </p>
                  <div className="lp-formula">
                    <p className="lp-formula-expr">
                      {"fees(range, L) =   Σ   ΔfeeGrowthGlobal × L / 2⁶⁴\n             price ∈ range"}
                    </p>
                    <p className="lp-formula-note">
                      Exact for a marginal position. For a large hypothetical L,
                      dilute by <code>L_active / (L_active + L)</code> using the
                      liquidity recorded in the same row. Range boundaries
                      crossed between two snapshots are resolved at the
                      15-minute cadence and no finer.
                    </p>
                  </div>
                  <ul className="lp-list lp-list-2">
                    <li>
                      <b>LP range-strategy backtesting.</b> Replay any range
                      width, rebalance rule or tick spacing against what the
                      pool actually paid out.
                    </li>
                    <li>
                      <b>Impermanent-loss and LP-yield product pricing.</b> The
                      fee leg of a structured LP product, measured instead of
                      assumed.
                    </li>
                    <li>
                      <b>CL microstructure research.</b> Liquidity, price and fee
                      accrual on one clock, across the whole liquid tail of
                      Orca.
                    </li>
                    <li>
                      <b>Fee-APR model calibration.</b>{" "}
                      Fit and validate against
                      realised per-unit accrual rather than a vendor&rsquo;s APR
                      column.
                    </li>
                  </ul>
                  <div className="lp-btn-row">
                    <Link href="/data" className="lp-btn">
                      Buy the dataset — 1 USDC
                    </Link>
                    <a href="#data" className="lp-btn lp-btn-ghost">
                      Full field list
                    </a>
                    <a href={DATASET_MAILTO} className="lp-btn lp-btn-ghost">
                      Ask about coverage
                    </a>
                  </div>
                </div>
              </li>

              {/* 3 — historical archive */}
              <li className="lp-service" id="archive">
                <div className="lp-service-rail">
                  <div className="lp-rail-inner">
                    <span className="lp-price">
                      200<span className="lp-price-unit">USDC</span>
                    </span>
                    <span className="lp-tag lp-tag-preorder">Pre-order</span>
                    <p className="lp-rail-note">
                      Not yet collected. Reconstruction is funded once demand is
                      confirmed.
                    </p>
                  </div>
                </div>
                <div className="lp-service-body">
                  <h3 className="lp-h3">
                    Historical archive — 2023 to July 2026
                  </h3>
                  <div className="lp-callout">
                    <p className="lp-callout-h">
                      Available on request — nothing to download today
                    </p>
                    <p>
                      This dataset does not exist yet. Forward collection starts
                      on 26 July 2026, so no snapshot before that date has been
                      taken. Do not order it expecting a file back the same
                      week.
                    </p>
                  </div>
                  <p className="lp-p">
                    On order, the archive would be reconstructed by replaying
                    archived Solana swap transactions through Orca&rsquo;s
                    fee-accounting rules to rebuild the accumulators, then
                    emitted in the same 14-field schema as the forward dataset
                    so the two files concatenate directly. Indicative delivery is
                    four to six weeks after an order is placed, and the
                    reconstruction is funded once there is confirmed demand for
                    it.
                  </p>
                  <p className="lp-p">
                    If this is the dataset you actually need, say so — expressed
                    interest is what decides whether it gets built, which pools
                    it starts with, and roughly when.
                  </p>
                  <div className="lp-btn-row">
                    <Link href="/data" className="lp-btn">
                      Pre-order the archive — 200 USDC
                    </Link>
                    <a href={ARCHIVE_MAILTO} className="lp-btn lp-btn-ghost">
                      Ask before ordering
                    </a>
                  </div>
                </div>
              </li>

              {/* 4 — hedge */}
              <li className="lp-service" id="hedge">
                <div className="lp-service-rail">
                  <div className="lp-rail-inner">
                    <span className="lp-price">Quoted</span>
                    <span className="lp-tag lp-tag-pilot">Invite-only pilot</span>
                    <p className="lp-rail-note">
                      {LEGAL_ENTITY} (BVI) is the direct counterparty. Not
                      licensed or supervised by any financial regulator.
                    </p>
                  </div>
                </div>
                <div className="lp-service-body">
                  <h3 className="lp-h3">
                    Liquidity Hedge certificates — ad hoc range hedging
                  </h3>
                  <p className="lp-p">
                    A seven-day, cash-settled bilateral contract that replicates
                    the mark-to-market variability of one concentrated-liquidity
                    position inside its own range. There is no separate barrier
                    and no cover ratio: the position&rsquo;s range{" "}
                    <code>[p_l, p_u]</code> <em>is</em> the contract.
                  </p>
                  <div className="lp-formula">
                    <p className="lp-formula-expr">
                      Π(S_T) = V(S₀) − V(clamp(S_T, p_l, p_u))
                    </p>
                    <p className="lp-formula-note">
                      Below <code>p_l</code> the counterparty pays you the full
                      capped amount. Inside the range you receive exactly the
                      signed change in position value. Above <code>p_u</code> you
                      pay a smaller capped amount — which is why this costs less
                      than one-sided protection.
                    </p>
                  </div>
                  <p className="lp-p">
                    Both legs are prefunded. You post the premium plus collateral
                    equal to your capped maximum obligation, so your worst case
                    is fixed at purchase and you can never owe more than you have
                    already paid.
                  </p>
                  <div className="lp-formula">
                    <p className="lp-formula-expr">
                      Premium = max(P_floor, FV · m_vol − y · E[F])
                    </p>
                    <p className="lp-formula-note">
                      Fair value by numerical quadrature under risk-neutral
                      geometric Brownian motion; <code>m_vol</code> is the
                      volatility markup <code>max(markup floor, IV/RV)</code>;{" "}
                      <code>y · E[F]</code> discounts the premium by the share of
                      your trading fees the counterparty takes at settlement;{" "}
                      <code>P_floor</code> is a published governance minimum.
                    </p>
                  </div>
                  <ul className="lp-list lp-list-2">
                    <li>
                      <b>Full premium breakdown before purchase.</b> Every term
                      above, with the inputs it was computed from, on the quote
                      you see.
                    </li>
                    <li>
                      <b>Hash-committed term sheet.</b> The terms you accepted
                      are fixed at purchase and verifiable afterwards.
                    </li>
                    <li>
                      <b>Published treasury and exposure.</b> Reserves, active
                      exposure and invariant status are shown on the dashboard.
                    </li>
                    <li>
                      <b>Deterministic settlement.</b> The settlement price is
                      read from the chain by a published policy, not quoted by
                      us.
                    </li>
                  </ul>

                  <div className="lp-callout">
                    <p className="lp-callout-h">Read this before asking</p>
                    <p>
                      Invite-only pilot. {LEGAL_ENTITY} (British Virgin Islands)
                      is your direct counterparty and is{" "}
                      <b>
                        not licensed, registered or supervised by any financial
                        regulator
                      </b>
                      . Not offered to persons in the United States, the EU/EEA,
                      the United Kingdom or the British Virgin Islands. This is
                      not insurance, not a deposit and not investment advice.
                      Capital is at risk: the entire premium can be lost, and any
                      amount owed to you is an unsecured claim against a small,
                      unlicensed company. There is no secondary market and a
                      certificate cannot be cancelled before expiry.
                    </p>
                  </div>

                  <div className="lp-btn-row">
                    <a href={PILOT_MAILTO} className="lp-btn lp-btn-ghost">
                      Request pilot access
                    </a>
                  </div>
                </div>
              </li>
            </ul>
          </div>
        </section>

        {/* ── data spec ────────────────────────────────────────── */}
        <section className="lp-section" id="data">
          <div className="lp-wrap">
            <div className="lp-section-head">
              <p className="lp-eyebrow">What&rsquo;s in the data</p>
              <h2 className="lp-h2">
                One long-format CSV. Fourteen columns. One row per pool per
                snapshot.
              </h2>
              <p className="lp-lead">
                Every covered pool lives in the same file, keyed by{" "}
                <code>pool</code> and sorted by pool then time — RFC-4180
                quoted, UTF-8. Delivery is an email attachment or a signed
                download link, with the covered period and the exact row count
                stated up front.
              </p>
            </div>

            <div
              className="lp-table-scroll"
              role="region"
              aria-label="Dataset field specification"
              tabIndex={0}
            >
              <table className="lp-table">
                <caption>
                  pool-snapshots.csv — field specification, in column order
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Field</th>
                    <th scope="col">Type</th>
                    <th scope="col">Meaning</th>
                  </tr>
                </thead>
                <tbody>
                  {CSV_FIELDS.map((field) => (
                    <tr key={field.name}>
                      <th scope="row">{field.name}</th>
                      <td className="lp-cell-type">{field.type}</td>
                      <td>{field.description}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <p className="lp-p">
              The accumulators are what make the file useful. A pool&rsquo;s fee
              history exists on-chain only at the instant you read it — Orca
              keeps the current value, not the series — so a{" "}
              <code>feeGrowthGlobal</code> history cannot be recovered later
              unless somebody was sampling it. That is the whole reason this
              collection runs.
            </p>
          </div>
        </section>

        {/* ── pricing ──────────────────────────────────────────── */}
        <section className="lp-section" id="pricing">
          <div className="lp-wrap">
            <div className="lp-section-head">
              <p className="lp-eyebrow">Pricing</p>
              <h2 className="lp-h2">Four prices, no tiers, no subscription.</h2>
              <p className="lp-lead">
                Data is paid for in USDC on Solana. Ordering quotes you an exact
                amount and a payment address before anything is sent, and the
                payment is verified on-chain before anything is delivered.
              </p>
              <div className="lp-btn-row">
                <Link href="/data" className="lp-btn">
                  Go to checkout
                </Link>
                <Link href="/app" className="lp-btn lp-btn-ghost">
                  Open the dashboard — free
                </Link>
              </div>
            </div>

            <div
              className="lp-table-scroll"
              role="region"
              aria-label="Price list"
              tabIndex={0}
            >
              <table className="lp-table">
                <caption>Current prices — {SITE_NAME}</caption>
                <thead>
                  <tr>
                    <th scope="col">Service</th>
                    <th scope="col">Price</th>
                    <th scope="col">Status</th>
                    <th scope="col">Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {PRICING.map((row) => (
                    <tr key={row.product}>
                      <th scope="row">{row.product}</th>
                      <td className="lp-cell-price">{row.price}</td>
                      <td className="lp-cell-type">{row.availabilityLabel}</td>
                      <td>{row.note}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        {/* ── faq ──────────────────────────────────────────────── */}
        <section className="lp-section" id="faq">
          <div className="lp-wrap">
            <div className="lp-section-head">
              <p className="lp-eyebrow">Questions</p>
              <h2 className="lp-h2">
                What the accumulators are, and what they are not.
              </h2>
            </div>

            <div className="lp-faq">
              {FAQ.map((item) => (
                <div className="lp-faq-item" key={item.q}>
                  <h3 className="lp-faq-q">{item.q}</h3>
                  <p className="lp-faq-a">{item.a}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ── legal ────────────────────────────────────────────── */}
        <section className="lp-section" id="legal">
          <div className="lp-wrap">
            <div className="lp-section-head">
              <p className="lp-eyebrow">Legal</p>
              <h2 className="lp-h2">Who you are dealing with.</h2>
            </div>

            <div className="lp-legal">
              <p className="lp-legal-p">
                All services on this site are operated by <b>{LEGAL_ENTITY}</b>,
                a British Virgin Islands business company. The summary below is
                not the contract; the full Website Terms of Use, Master Hedging
                Terms, Risk Disclosure Statement and Privacy Notice are provided
                in full before any purchase, and each is versioned and
                hash-committed so the version you accepted stays identifiable.
              </p>

              <div className="lp-legal-grid">
                <div>
                  <p className="lp-legal-h">The monitor and the data</p>
                  <p className="lp-legal-p">
                    The dashboard is read-only and non-custodial. We never
                    receive, hold or control your funds, tokens or keys.
                    Connecting a wallet shares only your public address.{" "}
                    <b>
                      We will never ask for your seed phrase or private key — any
                      request for them is fraud and is not from us.
                    </b>
                  </p>
                  <p className="lp-legal-p">
                    Nothing here is investment, financial, legal or tax advice.
                    Simulations, viability indicators and projections are
                    hypothetical model output from historical data and stated
                    assumptions; actual outcomes will differ, possibly
                    materially. Market data comes from public chains and third
                    parties and may be delayed, incomplete or wrong. Datasets are
                    licensed for internal use by the purchasing organisation; you
                    may not redistribute or resell them.
                  </p>
                </div>

                <div>
                  <p className="lp-legal-h">The hedging pilot</p>
                  <p className="lp-legal-p">
                    {LEGAL_ENTITY} is the <b>direct counterparty</b> to every
                    certificate and is <b>not licensed, registered or supervised
                    by any financial regulator</b>. There is no deposit
                    insurance, no investor-compensation scheme and no regulator
                    to complain to about the product&rsquo;s economics. Any
                    amount owed to you is an unsecured claim against the company.
                  </p>
                  <p className="lp-legal-p">
                    Certificates are <b>not offered</b> to persons in the United
                    States, the EU/EEA, the United Kingdom or the British Virgin
                    Islands. They are not insurance, not a deposit and not
                    investment advice. <b>Capital is at risk</b>: the premium is
                    never returned, the entire premium can be lost, and a rise
                    through <code>p_u</code> costs you the capped upside amount
                    posted as collateral. The hedge covers range-bounded
                    mark-to-market variability against USDC over seven days and
                    nothing else — not fee income, not a pool exploit, not a
                    depeg, not anything after expiry.
                  </p>
                </div>
              </div>

              <div className="lp-callout">
                <p className="lp-callout-h">Structural conflict of interest</p>
                <p>
                  {LEGAL_ENTITY} is your counterparty, sets the pricing model and
                  its parameters, operates the settlement infrastructure and
                  controls the disruption procedures. Published formulas,
                  deterministic settlement, on-chain verifiable records and
                  published reserves reduce this conflict; they do not remove it.
                </p>
              </div>
            </div>
          </div>
        </section>
      </main>

      <SiteFooter />

      {STRUCTURED_DATA.map((block, i) => (
        <script
          key={i}
          type="application/ld+json"
          nonce={nonce}
          dangerouslySetInnerHTML={{ __html: serializeJsonLd(block) }}
        />
      ))}
    </div>
  );
}
