import Link from "next/link";
import { Suspense } from "react";

import { CaptureWizard } from "@/components/CaptureWizard";

export default function Page() {
  return (
    <main className="page">
      <header className="header">
        <h1>Capture</h1>
        <p className="subtitle">
          Add a customer interaction to memory — from any channel ·{" "}
          <Link href="/clients">clients</Link> · <Link href="/sessions">sessions</Link>
        </p>
      </header>
      <Suspense fallback={null}>
        <CaptureWizard />
      </Suspense>
    </main>
  );
}
