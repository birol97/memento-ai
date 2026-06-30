import type { Metadata } from "next";
import "./globals.css";

import { Providers } from "@/app/providers";
import { AuthGate } from "@/components/AuthGate";

const TAGLINE =
  "Memento AI — on-chain institutional memory. Turn every customer conversation into intelligence your organization owns forever. People leave. Knowledge stays.";

export const metadata: Metadata = {
  title: "Memento AI — People leave. Knowledge stays.",
  description: TAGLINE,
  openGraph: {
    title: "Memento AI — People leave. Knowledge stays.",
    description: TAGLINE,
    siteName: "Memento AI",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Memento AI — People leave. Knowledge stays.",
    description: TAGLINE,
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>
          <AuthGate>{children}</AuthGate>
        </Providers>
      </body>
    </html>
  );
}
