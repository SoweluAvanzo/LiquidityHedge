import type { Metadata } from "next";

import { SolanaProviders } from "@/components/solana-providers";

// The Solana wallet context lives here rather than in the root layout so the
// landing page at `/` never pays for the wallet-adapter bundle.
export const metadata: Metadata = {
  title: "Dashboard",
  description:
    "Read-only dashboard for concentrated-liquidity positions: live position value, range status, uncollected fees, payoff curves, Monte-Carlo simulation and Liquidity Hedge certificates.",
  alternates: { canonical: "/app" },
  openGraph: {
    title: "Liquidity Hedge — Dashboard",
    description:
      "Read-only dashboard for concentrated-liquidity positions. Coverage today: Orca Whirlpools on Solana.",
    url: "/app",
    siteName: "Liquidity Hedge",
    locale: "en_US",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Liquidity Hedge — Dashboard",
    description:
      "Read-only dashboard for concentrated-liquidity positions. Coverage today: Orca Whirlpools on Solana.",
  },
};

export default function AppLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return <SolanaProviders>{children}</SolanaProviders>;
}
