import Link from "next/link";
import { Suspense } from "react";

import { Recorder } from "@/components/Recorder";

export default function AssistantPage() {
  return (
    <main className="page">
      <header className="header">
        <h1>Live Assistant</h1>
        <p className="subtitle">
          Real-time transcription + AI copilot, grounded in customer memory ·{" "}
          <Link href="/clients">clients</Link> · <Link href="/sessions">sessions</Link>
        </p>
      </header>
      <Suspense fallback={null}>
        <Recorder />
      </Suspense>
    </main>
  );
}
