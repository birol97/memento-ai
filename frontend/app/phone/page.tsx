"use client";

import { useState } from "react";

import { ClientPicker } from "@/components/ClientPicker";
import { LiveAdvisor } from "@/components/LiveAdvisor";
import type { Client } from "@/lib/types";

export default function PhonePage() {
  const [client, setClient] = useState<Client | null>(null);

  return (
    <main className="page">
      <header className="header">
        <h1>Phone</h1>
        <p className="subtitle">
          Put your call on speaker and pick who you’re talking to. The advisor listens,
          tells <b>you</b> apart from <b>them</b>, and suggests what to say — tuned to your
          relationship with that person.
        </p>
      </header>

      <section className="card">
        <h2 className="card-title">Who are you talking to?</h2>
        <div className="phone-pick">
          <ClientPicker value={client} onChange={setClient} />
        </div>
        {client?.relationship && (
          <p className="hint">
            Relationship: <b>{client.relationship}</b> — advice is framed accordingly.
          </p>
        )}
      </section>

      {client ? (
        <LiveAdvisor key={client.id} client={client} />
      ) : (
        <p className="empty">Pick a character above to start the live advisor.</p>
      )}
    </main>
  );
}
