"use client";

import { useMemo, type ReactNode } from "react";
import {
  ConnectionProvider,
  WalletProvider,
} from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import type { Adapter } from "@solana/wallet-adapter-base";

// Vendored copy without the upstream fonts.googleapis.com @import (NFR-SEC4).
import "@/styles/wallet-adapter.css";

const DEFAULT_RPC_URL = "https://api.mainnet-beta.solana.com";

/**
 * Client-side Solana context providers.
 *
 * The wallets array is intentionally empty: wallets implementing the
 * Wallet Standard (Phantom, Solflare, Backpack, ...) auto-register with
 * the WalletProvider, so no per-wallet adapter packages are needed.
 */
export function SolanaProviders({ children }: { children: ReactNode }) {
  const endpoint = process.env.NEXT_PUBLIC_RPC_URL ?? DEFAULT_RPC_URL;
  const wallets = useMemo<Adapter[]>(() => [], []);

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
