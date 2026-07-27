import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";

import "@/styles/landing.css";
import { RangeFigure } from "@/components/landing/range-figure";
import { SiteFooter } from "@/components/chrome/site-footer";
import { SiteHeader } from "@/components/chrome/site-header";
import { FAQ, PRICING } from "@/lib/landing-content";
import { STRUCTURED_DATA, serializeJsonLd } from "@/lib/structured-data";
import { LEGAL_ENTITY, SITE_NAME, SITE_URL, mailto } from "@/lib/site";

const DESCRIPTION =
  "Two products for concentrated liquidity on Solana. A fifteen-minute record of what the liquid pools actually paid, per unit of liquidity, so any price range can be tested before you commit to it — and a seven-day contract that hedges the range risk on a position. Free portfolio analytics included.";

const OG = {
  title: "Liquidity Hedge — concentrated-liquidity data and range hedging",
  description: DESCRIPTION,
  url: `${SITE_URL}/`,
  siteName: SITE_NAME,
  locale: "en_US",
  type: "website" as const,
};

export const metadata: Metadata = {
  title: {
    absolute:
      "Concentrated-liquidity data and range hedging on Solana — Liquidity Hedge",
  },
  description: DESCRIPTION,
  keywords: [
    "concentrated liquidity data",
    "concentrated liquidity fee accrual dataset",
    "LP range backtesting data",
    "impermanent loss hedging Solana",
    "Solana liquidity provider yield dataset",
    "Orca Whirlpool fee growth data",
    "feeGrowthGlobal historical snapshots Solana",
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
  "Concentrated-liquidity data — 2026 forward",
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
            Open Liquidity Studio
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
                  Concentrated liquidity · measurement and hedging
                </p>
                <h1 className="lp-h1">
                  Measure the risk exposure of your concentrated-liquidity
                  positions. Then <em>hedge</em> it.
                </h1>
                <p className="lp-lead">
                  A liquidity position can pay a yield no bond will offer. It
                  also carries <b>impermanent loss</b>: as the price moves
                  through your range the payoff stops being linear, and the
                  value given up against simply holding the tokens can exceed
                  the fees earned.
                </p>
                <p className="lp-lead">
                  We address both halves. Our free dashboard measures the
                  exposure, with Monte-Carlo simulation and backtesting against
                  what the pools actually paid. Our hedge covers the downside,
                  so a position behaves more like a yield instrument and less
                  like a directional bet.
                </p>
                <p className="lp-note">
                  The method is not specific to a single exchange or chain:
                  concentrated liquidity is accounted for the same way wherever
                  it is offered. Coverage currently comprises{" "}
                  <b>Orca Whirlpools on Solana</b>; further venues are added in
                  response to demand.
                </p>
                <div className="lp-btn-row">
                  <a href="#data" className="lp-btn">
                    The data
                  </a>
                  <a href="#hedge" className="lp-btn lp-btn-ghost">
                    The hedge
                  </a>
                </div>

                <dl className="lp-facts">
                  <div className="lp-fact">
                    <dt>Dashboard</dt>
                    <dd>Free</dd>
                  </div>
                  <div className="lp-fact">
                    <dt>Data from</dt>
                    <dd>1 USDC</dd>
                  </div>
                  <div className="lp-fact">
                    <dt>Hedge tenor</dt>
                    <dd>7 days</dd>
                  </div>
                  <div className="lp-fact">
                    <dt>Custody</dt>
                    <dd>None</dd>
                  </div>
                </dl>
              </div>

              <RangeFigure />
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

        {/* ── free entry point ─────────────────────────────────── */}
        <section className="lp-section lp-section-tight">
          <div className="lp-wrap">
            <div className="lp-freebar">
              <div>
                <p className="lp-freebar-h">
                  Liquidity Studio — simulate the valuation trajectory of your
                  position portfolio, at no charge
                </p>
                <p className="lp-freebar-p">
                  Enter a Solana address or connect a wallet. Liquidity Studio
                  reads your concentrated-liquidity positions directly from the
                  chain — current value, range status, uncollected fees and
                  payoff curves — and projects the portfolio&rsquo;s valuation
                  trajectory by Monte-Carlo simulation under three independent
                  models: geometric Brownian motion, an empirical bootstrap of
                  historical returns, and replay of the realised historical
                  path. Each may be run over value alone, value plus fee income,
                  or fee income alone. Positions across several pools are drawn
                  jointly, so the reported spread carries the assets&rsquo;
                  measured co-movement rather than assuming it away — the
                  correlation matrix and its confidence intervals are shown
                  with the result. Read-only: no account is required and no
                  signature is ever requested.
                </p>
              </div>
              <Link href="/app" className="lp-btn">
                Open Liquidity Studio
              </Link>
            </div>
          </div>
        </section>

        {/* ── the two products ─────────────────────────────────── */}
        <section className="lp-section" id="products">
          <div className="lp-wrap">
            <div className="lp-section-head">
              <p className="lp-eyebrow">What we sell</p>
              <h2 className="lp-h2">Two products. Priced separately.</h2>
              <p className="lp-lead">
                Neither is bundled with the other and neither is a
                subscription. One is a measurement service, the other a
                risk-transfer service; they are priced and described
                independently.
              </p>
            </div>

            <ul className="lp-services">
              {/* 1 — data */}
              <li className="lp-service lp-service-featured" id="data">
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
                    Concentrated-liquidity data — what a range actually earned
                  </h3>
                  <p className="lp-claim">
                    <b>A fee history cannot be reconstructed retrospectively.</b>{" "}
                    A pool reports only its current cumulative totals; the
                    series itself is not stored, on-chain or off. It exists only
                    where it was sampled at the time, so any interval that was
                    not sampled cannot be recovered. We have sampled the Orca
                    Whirlpools continuously since 26 July 2026, and are not
                    aware of another archive of this series.
                  </p>
                  <p className="lp-p">
                    Every liquid pool we cover is sampled on a fifteen-minute
                    clock and written down: what it paid, how much liquidity was
                    competing for it, the price, and the money actually sitting
                    in the pool.
                  </p>
                  <p className="lp-note">
                    <b>Coverage today:</b> Orca Whirlpools on Solana — every
                    pool clearing a $10,000 daily volume threshold, with the
                    tracked set refreshed daily. The schema is venue-agnostic,
                    so pools added from other AMMs or chains land in the same
                    file with no change on your side.
                  </p>
                  <p className="lp-p">
                    The commercial value follows from the unit of measurement.
                    Volume, TVL and APR feeds describe a pool{" "}
                    <em>in aggregate</em>. They cannot establish what a{" "}
                    <b>specific price range</b> would have earned, because they
                    do not record how much liquidity was competing within it.
                    Our measurement already accounts for that, so the fee income
                    of any range — including ranges that were never held — can
                    be computed rather than estimated.
                  </p>
                  <p className="lp-p">
                    It arrives as one CSV: every covered pool in the same file,
                    one row per pool per snapshot, ready to load. The full field
                    specification is at the checkout, and the covered period and
                    row count are quoted before you pay anything.
                  </p>
                  <ul className="lp-list lp-list-2">
                    <li>
                      <b>Range-strategy backtesting.</b> Replay any range width,
                      rebalance rule or tick spacing against what the pool
                      actually paid out.
                    </li>
                    <li>
                      <b>Product pricing.</b> The fee leg of a structured LP
                      product, or an impermanent-loss cover, measured instead of
                      assumed.
                    </li>
                    <li>
                      <b>Research.</b> Liquidity, price and fee accrual on a
                      single clock, across the full set of covered pools.
                    </li>
                    <li>
                      <b>Model calibration.</b> Fit and validate against realised
                      accrual rather than a vendor&rsquo;s APR column.
                    </li>
                  </ul>

                  <div className="lp-callout" id="archive">
                    <p className="lp-callout-h">
                      Going backwards — 2023 to 2026, pre-order · 200 USDC
                    </p>
                    <p>
                      This history <b>has not been collected</b>, by us or, so
                      far as we are aware, by anyone else. It can be
                      reconstructed by replaying archived on-chain trades and
                      recomputing the accumulators, and would be delivered in
                      the same format as the forward file. Indicative delivery
                      is four to six weeks from order, and the work is funded
                      once demand is confirmed. Nothing is available for
                      download at present.
                    </p>
                  </div>

                  <div className="lp-btn-row">
                    <Link href="/data" className="lp-btn">
                      Buy the data — 1 USDC
                    </Link>
                    <Link href="/data" className="lp-btn lp-btn-ghost">
                      Pre-order the archive
                    </Link>
                    <a href={DATASET_MAILTO} className="lp-btn lp-btn-ghost">
                      Ask about coverage
                    </a>
                  </div>
                </div>
              </li>

              {/* 2 — hedge */}
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
                    Liquidity Hedge — cover the range risk on a position
                  </h3>
                  <p className="lp-p">
                    A seven-day, cash-settled contract on one
                    concentrated-liquidity position. If the price settles below
                    the lower bound of your range, you receive the full capped
                    amount, equal to the value the position lost across the
                    range. If it settles above the upper bound, you pay a{" "}
                    <em>smaller</em> capped amount — which is why this costs
                    less than protection on the downside alone.
                  </p>
                  <div className="lp-formula">
                    <p className="lp-formula-expr">
                      Π(S_T) = V(S₀) − V(clamp(S_T, p_l, p_u))
                    </p>
                    <p className="lp-formula-note">
                      There is no separate barrier and no cover ratio: your
                      range <code>[p_l, p_u]</code> <em>is</em> the contract.
                      Inside it you receive exactly the signed change in position
                      value.
                    </p>
                  </div>
                  <p className="lp-p">
                    Both legs are prefunded. You pay the premium plus collateral
                    equal to your own capped maximum obligation, so your worst
                    case is fixed at the moment you buy and you can never owe
                    more than you have already paid. The premium is quoted from a
                    published formula, and every input that went into it is shown
                    on the quote.
                  </p>
                  <p className="lp-note">
                    <b>Covered today:</b> positions on Orca Whirlpools, settled
                    in USDC on Solana. The contract is written against a range,
                    not against a venue, so it extends to any AMM with the same
                    position shape.
                  </p>
                  <ul className="lp-list lp-list-2">
                    <li>
                      <b>Full premium breakdown before purchase.</b> Every term,
                      with the inputs it was computed from, on the quote you see.
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
                    <p className="lp-callout-h">
                      Eligibility and risk — please read before requesting
                      access
                    </p>
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
                  Open Liquidity Studio — free
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
              <h2 className="lp-h2">Frequently asked questions.</h2>
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
                  <p className="lp-legal-h">The dashboard and the data</p>
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
