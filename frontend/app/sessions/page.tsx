"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { listSessionsForClient, searchClients } from "@/lib/api";
import type { Client, SessionRow } from "@/lib/types";

export default function SessionsPage() {
  const [clients, setClients] = useState<Client[]>([]);
  const [selected, setSelected] = useState<Client | null>(null);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    searchClients().then(setClients).catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    if (!selected) {
      setSessions([]);
      return;
    }
    listSessionsForClient(selected.id)
      .then(setSessions)
      .catch((e) => setError(String(e)));
  }, [selected]);

  return (
    <main className="page">
      <header className="header">
        <h1>Sessions</h1>
        <p className="subtitle">
          <Link href="/">← Recorder</Link> · <Link href="/clients">All clients</Link>
        </p>
      </header>

      {error && <div className="error">{error}</div>}

      <div className="sessions-layout">
        <aside className="sessions-clients">
          <h2>Clients</h2>
          {clients.length === 0 && <p>No clients yet.</p>}
          <ul>
            {clients.map((c) => (
              <li key={c.id}>
                <button
                  className={selected?.id === c.id ? "selected" : ""}
                  onClick={() => setSelected(c)}
                >
                  <strong>{c.name}</strong>
                  {c.phone && <span>{c.phone}</span>}
                </button>
              </li>
            ))}
          </ul>
        </aside>

        <section className="sessions-list">
          <h2>{selected ? `${selected.name}'s calls` : "Pick a client"}</h2>
          {selected && sessions.length === 0 && <p>No sessions yet.</p>}
          <ul>
            {sessions.map((s) => (
              <li key={s.id}>
                <Link href={`/sessions/${s.id}`}>
                  <span className="sess-time">
                    {new Date(s.started_at).toLocaleString()}
                  </span>
                  <span className="sess-summary">
                    {s.summary ?? (s.ended_at ? "(no summary)" : "(in progress)")}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </main>
  );
}
