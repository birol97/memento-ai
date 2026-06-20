"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { getSession } from "@/lib/api";
import type { SessionDetail } from "@/lib/types";

export default function SessionDetailPage({ params }: { params: { id: string } }) {
  const [data, setData] = useState<SessionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getSession(params.id)
      .then(setData)
      .catch((e) => setError(String(e)));
  }, [params.id]);

  if (error) return <main className="page"><div className="error">{error}</div></main>;
  if (!data) return <main className="page"><p>Loading…</p></main>;

  const { session, client, turns, suggestions } = data;
  const suggestionByTurn = new Map<number, typeof suggestions>();
  for (const s of suggestions) {
    if (s.turn_id === null) continue;
    const arr = suggestionByTurn.get(s.turn_id) ?? [];
    arr.push(s);
    suggestionByTurn.set(s.turn_id, arr);
  }

  return (
    <main className="page">
      <header className="header">
        <h1>{client?.name ?? "Unknown client"}</h1>
        <p className="subtitle">
          <Link href="/sessions">← All sessions</Link> · session {session.id}
          {" · "}
          {new Date(session.started_at).toLocaleString()}
        </p>
      </header>

      {session.summary && (
        <section className="session-summary">
          <h3>Summary</h3>
          <p>{session.summary}</p>
        </section>
      )}

      <section className="session-turns">
        {turns.length === 0 && <p>No turns recorded.</p>}
        {turns.map((t) => {
          const sugs = suggestionByTurn.get(t.id) ?? [];
          return (
            <div key={t.id} className="turn final">
              <div className="turn-meta">
                <span className="turn-index">#{t.id}</span>
                <span className="turn-speaker">{t.speaker}</span>
                {t.t_start !== null && t.t_end !== null && (
                  <span className="turn-duration">
                    {(t.t_end - t.t_start).toFixed(2)}s
                  </span>
                )}
              </div>
              <div className="turn-text">{t.text}</div>
              {sugs.map((s) => (
                <div key={s.id} className="suggestion done in-history">
                  <div className="suggestion-meta">copilot suggested:</div>
                  <div className="suggestion-text">{s.text}</div>
                </div>
              ))}
            </div>
          );
        })}
      </section>
    </main>
  );
}
