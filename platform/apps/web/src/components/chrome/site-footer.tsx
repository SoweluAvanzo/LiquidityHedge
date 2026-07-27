/**
 * The one footer, used by `/`, `/app` and `/data`.
 *
 * The legal line is written once here so the disclosure a reader sees on
 * the dashboard is word-for-word the one on the landing page.
 */

import Link from "next/link";

import { CONTACT_EMAIL, LEGAL_ENTITY, SITE_NAME } from "@/lib/site";

const FOOTER_LINKS = [
  { label: "Dashboard", href: "/app" },
  { label: "Buy data", href: "/data" },
  // The field spec moved to the checkout, next to the purchase decision.
  { label: "Dataset specification", href: "/data#spec" },
  { label: "Hedging", href: "/#hedge" },
  { label: "Pricing", href: "/#pricing" },
  { label: "Legal summary", href: "/#legal" },
];

export function SiteFooter() {
  return (
    <footer className="lh-footer">
      <div className="lh-wrap">
        <div className="lh-footer-top">
          <span className="lh-brand">
            <span className="lh-brand-tick" aria-hidden="true">
              ▚
            </span>
            {SITE_NAME}
          </span>
          <nav className="lh-footer-links" aria-label="Footer">
            {FOOTER_LINKS.map((link) => (
              <Link key={link.href} href={link.href}>
                {link.label}
              </Link>
            ))}
            <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
          </nav>
        </div>
        <p className="lh-footer-fine">
          {LEGAL_ENTITY}, a British Virgin Islands business company. Not licensed
          or supervised by any financial regulator. Nothing on this site is an
          offer, solicitation or recommendation, and nothing here is investment
          advice. Figures produced by a model are hypothetical and are labelled
          as such. Hedging certificates are an invite-only pilot and are not
          offered to persons in the United States, the EU/EEA, the United Kingdom
          or the British Virgin Islands. Full Terms of Use, Master Hedging Terms
          and the Risk Disclosure Statement are provided before any purchase —
          write to{" "}
          <a className="lh-inline-link" href={`mailto:${CONTACT_EMAIL}`}>
            {CONTACT_EMAIL}
          </a>{" "}
          for a copy.
        </p>
      </div>
    </footer>
  );
}
