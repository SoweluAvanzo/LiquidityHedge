"use client";

import dynamic from "next/dynamic";
import { useWallet } from "@solana/wallet-adapter-react";

import { PortfolioDashboard } from "@/components/portfolio-dashboard";

// The wallet button reads browser-injected wallet state, so it must never be
// server-rendered (SSR markup would not match and cause hydration errors).
const WalletMultiButton = dynamic(
  () =>
    import("@solana/wallet-adapter-react-ui").then(
      (mod) => mod.WalletMultiButton,
    ),
  { ssr: false },
);

export default function Home() {
  const { publicKey } = useWallet();

  return (
    <div className="flex flex-1 flex-col">
      <header className="border-b border-zinc-200 dark:border-zinc-800">
        <nav className="mx-auto flex w-full max-w-5xl items-center justify-between gap-4 px-6 py-4">
          <span className="text-sm font-semibold tracking-tight sm:text-base">
            Liquidity Hedge — Monitor
          </span>
          <WalletMultiButton />
        </nav>
      </header>

      <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-8">
        <PortfolioDashboard walletAddress={publicKey?.toBase58() ?? null} />
      </main>
    </div>
  );
}
