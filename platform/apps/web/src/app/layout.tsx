import type { Metadata } from "next";
import "./globals.css";

import { SolanaProviders } from "@/components/solana-providers";

// Nonce-based CSP (src/proxy.ts) requires per-request rendering: a static
// prerender would ship nonce-less scripts that the policy would block.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Liquidity Hedge — Monitor",
  description:
    "Read-only monitor for Liquidity Hedge certificates on Orca Whirlpools.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">
        <SolanaProviders>{children}</SolanaProviders>
      </body>
    </html>
  );
}
