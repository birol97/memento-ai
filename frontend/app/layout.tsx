import type { Metadata } from "next";
import "./globals.css";

import { Providers } from "@/app/providers";
import { AuthGate } from "@/components/AuthGate";

export const metadata: Metadata = {
  title: "Memento AI",
  description:
    "Memento AI — enterprise AI memory. Turn every conversation into institutional intelligence. People leave. Knowledge stays.",
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
