import type { Metadata } from "next";
import "./globals.css";

import { SITE_NAME, SITE_URL } from "@/lib/site";

// Nonce-based CSP (src/proxy.ts) requires per-request rendering: a static
// prerender would ship nonce-less scripts that the policy would block.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  applicationName: SITE_NAME,
  title: {
    default:
      "Liquidity Hedge — Orca Whirlpool fee-growth data and range hedging",
    template: `%s — ${SITE_NAME}`,
  },
  description:
    "Fee-growth datasets, portfolio analytics and range hedging for Orca Whirlpool concentrated-liquidity positions on Solana.",
  authors: [{ name: "Blocksventures Ltd" }],
  creator: "Blocksventures Ltd",
  publisher: "Blocksventures Ltd",
  formatDetection: { email: false, address: false, telephone: false },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
