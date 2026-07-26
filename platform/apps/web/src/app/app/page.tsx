"use client";

import { useWallet } from "@solana/wallet-adapter-react";

import { PortfolioDashboard } from "@/components/portfolio-dashboard";
import { SiteFooter } from "@/components/chrome/site-footer";
import { SiteHeader } from "@/components/chrome/site-header";
import { WalletButton } from "@/components/chrome/wallet-button";

export default function DashboardPage() {
  const { publicKey } = useWallet();

  return (
    <div className="lh">
      <SiteHeader active="app" actions={<WalletButton />} />

      <main id="main" className="lh-main">
        <div className="lh-wrap">
          <PortfolioDashboard walletAddress={publicKey?.toBase58() ?? null} />
        </div>
      </main>

      <SiteFooter />
    </div>
  );
}
