"use client";

// dApp providers: react-query → Sui client → wallet, plus Enoki zkLogin wallet
// registration. Wraps the whole app (see layout.tsx).
import { useEffect } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SuiClientProvider, WalletProvider, useSuiClient } from "@mysten/dapp-kit";
import { registerEnokiWallets } from "@mysten/enoki";

import "@mysten/dapp-kit/dist/index.css";

const NETWORK = (process.env.NEXT_PUBLIC_SUI_NETWORK ?? "testnet") as "testnet" | "mainnet";

// @mysten/sui 2.x dropped getFullnodeUrl — pass explicit fullnode URL + network.
const networks = {
  testnet: { url: "https://fullnode.testnet.sui.io:443", network: "testnet" as const },
  mainnet: { url: "https://fullnode.mainnet.sui.io:443", network: "mainnet" as const },
};

const queryClient = new QueryClient();

/** Registers the Enoki zkLogin wallets (Google) with the wallet standard so
 * dapp-kit's wallet hooks can connect them. Runs once the Sui client exists. */
function RegisterEnoki() {
  const client = useSuiClient();
  useEffect(() => {
    const apiKey = process.env.NEXT_PUBLIC_ENOKI_API_KEY;
    const clientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
    if (!apiKey || !clientId) {
      // Not configured yet — the app still runs (default-org/anonymous mode).
      return;
    }
    // Pin the OAuth redirect to the app ORIGIN (no path) so it deterministically
    // matches the Authorized redirect URI in Google Cloud (e.g. http://localhost:3000).
    // In prod this becomes https://yourdomain — whitelist that too.
    const redirectUrl = typeof window !== "undefined" ? window.location.originddddddddddd : undefined;
    const { unregister } = registerEnokiWallets({
      apiKey,
      providers: { google: { clientId, redirectUrl } },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any,
      network: NETWORK,
    });
    return unregister;
  }, [client]);
  return null;
}

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <SuiClientProvider networks={networks} defaultNetwork={NETWORK}>
        <WalletProvider autoConnect>
          <RegisterEnoki />
          {children}
        </WalletProvider>
      </SuiClientProvider>
    </QueryClientProvider>
  );
}
