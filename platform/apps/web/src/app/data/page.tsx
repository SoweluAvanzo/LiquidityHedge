import type { Metadata } from "next";
import Link from "next/link";

import { DataCheckout } from "@/components/data/checkout";
import { SiteFooter } from "@/components/chrome/site-footer";
import { SiteHeader } from "@/components/chrome/site-header";
import { WalletButton } from "@/components/chrome/wallet-button";
import { CONTACT_EMAIL, LEGAL_ENTITY, SITE_NAME } from "@/lib/site";

const DESCRIPTION =
  "Buy the Orca Whirlpool fee-growth dataset with USDC on Solana. Pay from a connected wallet or manually; the payment is verified on-chain before anything is delivered.";

export const metadata: Metadata = {
  title: "Buy data",
  description: DESCRIPTION,
  alternates: { canonical: "/data" },
  openGraph: {
    title: `Buy the Orca fee-growth dataset — ${SITE_NAME}`,
    description: DESCRIPTION,
    url: "/data",
    siteName: SITE_NAME,
    locale: "en_US",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: `Buy the Orca fee-growth dataset — ${SITE_NAME}`,
    description: DESCRIPTION,
  },
  robots: { index: true, follow: true },
};

export default function DataPage() {
  return (
    <div className="lh">
      <SiteHeader active="data" actions={<WalletButton />} />

      <main id="main" className="lh-main">
        <div className="lh-wrap">
          <div className="lh-page-head">
            <div>
              <p className="lh-eyebrow">Data · USDC on Solana</p>
              <h1 className="lh-h1">Buy the fee-growth data.</h1>
              <p className="lh-lead">
                One long-format CSV of the on-chain fee accumulators, active
                liquidity, price and vault balances of every tracked Orca
                Whirlpool, sampled every fifteen minutes. The{" "}
                <Link className="lh-inline-link" href="/#data">
                  field specification
                </Link>{" "}
                is on the landing page — read it before you pay.
              </p>
            </div>
          </div>

          <DataCheckout />

          <section
            className="lh-card"
            style={{ marginTop: "2rem" }}
            aria-labelledby="trust-h"
          >
            <h2 className="lh-h2" id="trust-h">
              What happens to your money, exactly
            </h2>
            <div className="lh-facts lh-facts-4" style={{ marginTop: "1rem" }}>
              <div className="lh-fact">
                <span className="lh-fact-label">Custody</span>
                <p className="lh-fact-value" style={{ fontSize: "0.8125rem" }}>
                  None
                </p>
                <p className="lh-fact-sub">
                  The recipient address is externally managed. This site holds
                  no key for it, cannot move funds out of it, and never takes
                  custody of yours at any point.
                </p>
              </div>
              <div className="lh-fact">
                <span className="lh-fact-label">Verification</span>
                <p className="lh-fact-value" style={{ fontSize: "0.8125rem" }}>
                  On-chain, finalized
                </p>
                <p className="lh-fact-sub">
                  The server looks up your payment itself, at finalized
                  commitment, and checks the mint, the recipient account and the
                  exact amount before an order moves.
                </p>
              </div>
              <div className="lh-fact">
                <span className="lh-fact-label">Delivery</span>
                <p className="lh-fact-value" style={{ fontSize: "0.8125rem" }}>
                  Never on request
                </p>
                <p className="lh-fact-sub">
                  Nothing is released because the browser says a payment
                  happened. This page can only ask the server to look at the
                  chain again.
                </p>
              </div>
              <div className="lh-fact">
                <span className="lh-fact-label">Signing</span>
                <p className="lh-fact-value" style={{ fontSize: "0.8125rem" }}>
                  Yours only
                </p>
                <p className="lh-fact-sub">
                  The wallet path proposes a transaction; your wallet&rsquo;s
                  own dialog approves it. We never ask for a seed phrase or a
                  private key — any request for one is fraud and is not from us.
                </p>
              </div>
            </div>

            <div className="lh-callout" data-tone="quiet" style={{ marginTop: "1.25rem" }}>
              <p className="lh-callout-h">Licence and refunds</p>
              <p>
                Datasets are sold by {LEGAL_ENTITY} (British Virgin Islands) and
                licensed for internal use by the purchasing organisation; you
                may not redistribute or resell them. A delivered file is not
                refundable. A payment that cannot be matched to a live order is
                refunded to the sending address — write to{" "}
                <a className="lh-inline-link" href={`mailto:${CONTACT_EMAIL}`}>
                  {CONTACT_EMAIL}
                </a>{" "}
                with the order id and the transaction signature.
              </p>
            </div>
          </section>
        </div>
      </main>

      <SiteFooter />
    </div>
  );
}
