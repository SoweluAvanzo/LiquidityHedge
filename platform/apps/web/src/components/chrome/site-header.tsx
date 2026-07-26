/**
 * The one header, used by `/`, `/app` and `/data`.
 *
 * No "use client": the landing page renders it on the server, the
 * dashboard imports it from a client component (which makes it client
 * code there). It reads nothing but its props, so both are fine.
 */

import Link from "next/link";
import type { ReactNode } from "react";

import { NAV_LINKS, type NavId } from "@/lib/nav";
import { SITE_NAME } from "@/lib/site";

export function SiteHeader({
  active,
  actions,
}: {
  /** Marks the current section in the nav. */
  active?: NavId;
  /** Right-hand slot: the wallet button on `/app`, a CTA elsewhere. */
  actions?: ReactNode;
}) {
  return (
    <>
      <a className="lh-skip" href="#main">
        Skip to content
      </a>
      <header className="lh-header">
        <div className="lh-wrap lh-header-inner">
          <Link href="/" className="lh-brand">
            <span className="lh-brand-tick" aria-hidden="true">
              ▚
            </span>
            {SITE_NAME}
          </Link>
          <nav className="lh-nav" aria-label="Product">
            {NAV_LINKS.map((link) => (
              <Link
                key={link.id}
                href={link.href}
                aria-current={link.id === active ? "page" : undefined}
              >
                {link.label}
              </Link>
            ))}
          </nav>
          {actions ? <div className="lh-header-actions">{actions}</div> : null}
        </div>
      </header>
    </>
  );
}
