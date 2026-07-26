import { SolanaProviders } from "@/components/solana-providers";

/**
 * The checkout offers a wallet-signed payment path, so it needs the same
 * Solana context as the dashboard. It lives here rather than in the root
 * layout so `/` never pays for the wallet-adapter bundle.
 */
export default function DataLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return <SolanaProviders>{children}</SolanaProviders>;
}
