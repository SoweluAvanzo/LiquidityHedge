"use client";

import dynamic from "next/dynamic";

/**
 * The wallet-adapter button reads browser-injected wallet state, so it must
 * never be server-rendered (SSR markup would not match and would cause a
 * hydration error). Wrapped here so both `/app` and `/data` mount the same
 * control in the same header slot.
 */
const WalletMultiButton = dynamic(
  () =>
    import("@solana/wallet-adapter-react-ui").then(
      (mod) => mod.WalletMultiButton,
    ),
  { ssr: false },
);

export function WalletButton() {
  return <WalletMultiButton />;
}
