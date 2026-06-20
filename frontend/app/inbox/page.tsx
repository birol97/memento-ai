"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  searchClients,
  listSessionsForClient,
  listSubspaces,
  type Subspace,
} from "@/lib/api";
import { recallNamespace } from "@/app/actions/memory";
import { clientNamespace, subNamespace } from "@/lib/clientNamespace";
import type { Client, SessionRow } from "@/lib/types";

// One node on a character's timeline — either a live call (session) or a
// captured conversation (sub-namespace).
type Interaction =
  | { kind: "call"; id: string; at: string; dur: string | null; summary: string | null }
  | { kind: "conversation"; id: string; at: string; nsKey: string; label: string };

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function fmtDur(start: string, end: string | null): string | null {
  if (!end) return null;
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const mins = Math.round(ms / 60000);
  if (mins < 1) return `${Math.max(1, Math.round(ms / 1000))}s`;
  return `${mins} min`;
}

function relativeDay(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const days = Math.floor((now.getTime() - d.getTime()) / 86400000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  return fmtWhen(iso);
}

export default function InboxPage() {
  const [clients, setClients] = useState<Client[]>([]);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<Client | null>(null);

  const [timeline, setTimeline] = useState<Interaction[] | null>(null);
  const [loading, setLoading] = useState(false);

  // lazily-recalled insights per conversation node (nsKey -> entries)
  const [insights, setInsights] = useState<Record<string, string[] | "loading">>({});

  useEffect(() => {
    searchClients("").then(setClients).catch(() => setClients([]));
  }, []);

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const list = q ? clients.filter((c) => c.name.toLowerCase().includes(q)) : clients;
    return list;
  }, [clients, filter]);

  const select = useCallback(async (c: Client) => {
    setSelected(c);
    setTimeline(null);
    setInsights({});
    setLoading(true);
    try {
      const [sessions, subs] = await Promise.all([
        listSessionsForClient(c.id).catch((): SessionRow[] => []),
        listSubspaces(c.id).catch((): Subspace[] => []),
      ]);
      const items: Interaction[] = [
        ...sessions.map((s) => ({
          kind: "call" as const,
          id: `sess-${s.id}`,
          at: s.started_at,
          dur: fmtDur(s.started_at, s.ended_at),
          summary: s.summary,
        })),
        ...subs.map((s) => ({
          kind: "conversation" as const,
          id: `sub-${s.ns_key}`,
          at: s.created_at,
          nsKey: s.ns_key,
          label: s.label,
        })),
      ].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
      setTimeline(items);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadInsight = useCallback(
    async (nsKey: string) => {
      if (!selected || insights[nsKey]) return;
      setInsights((p) => ({ ...p, [nsKey]: "loading" }));
      const r = await recallNamespace(subNamespace(selected.id, nsKey));
      setInsights((p) => ({ ...p, [nsKey]: r.ok ? r.entries : [] }));
    },
    [selected, insights],
  );

  return (
    <main className="inbox">
      {/* DM list */}
      <aside className="dm-list">
        <div className="dm-list-head">
          <h2>Characters</h2>
          <input
            className="dm-search"
            placeholder="Search…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
        <div className="dm-items">
          {visible.length === 0 && <p className="empty">No characters yet.</p>}
          {visible.map((c) => (
            <button
              key={c.id}
              className={`dm-item${selected?.id === c.id ? " active" : ""}`}
              onClick={() => select(c)}
            >
              <span className="dm-avatar">{c.name.slice(0, 1).toUpperCase()}</span>
              <span className="dm-meta">
                <span className="dm-name">{c.name}</span>
                <span className="dm-preview">
                  {c.relationship || c.email || c.phone || "Tap to view timeline"}
                </span>
              </span>
            </button>
          ))}
        </div>
      </aside>

      {/* thread / timeline */}
      <section className="dm-thread">
        {!selected ? (
          <div className="dm-empty">
            <p>Select a character to see your conversation timeline.</p>
          </div>
        ) : (
          <>
            <header className="dm-thread-head">
              <span className="dm-avatar big">{selected.name.slice(0, 1).toUpperCase()}</span>
              <div>
                <h2>{selected.name}</h2>
                <p className="dm-sub">
                  {selected.relationship && <span className="dm-rel">{selected.relationship}</span>}
                  <span className="dm-ns">🗂 {clientNamespace(selected.id)}</span>
                </p>
              </div>
            </header>

            <div className="timeline">
              {loading && <p className="empty">Loading timeline…</p>}
              {!loading && timeline && timeline.length === 0 && (
                <p className="empty">No interactions yet — capture a conversation or run the advisor.</p>
              )}
              {!loading &&
                timeline?.map((it) => (
                  <div key={it.id} className={`tl-node ${it.kind}`}>
                    <span className="tl-dot" />
                    <div className="tl-card">
                      <div className="tl-top">
                        <span className="tl-kind">
                          {it.kind === "call" ? "📞 Live conversation" : "💬 Conversation"}
                        </span>
                        <span className="tl-when" title={fmtWhen(it.at)}>
                          {relativeDay(it.at)} · {fmtWhen(it.at)}
                          {it.kind === "call" && it.dur ? ` · ${it.dur}` : ""}
                        </span>
                      </div>

                      {it.kind === "call" ? (
                        <p className="tl-insight">
                          {it.summary?.trim() || "Live conversation (no summary saved)."}
                        </p>
                      ) : (
                        <>
                          <p className="tl-title">{it.label}</p>
                          {insights[it.nsKey] === "loading" ? (
                            <p className="tl-insight muted">recalling insights from Walrus…</p>
                          ) : insights[it.nsKey] ? (
                            <ul className="tl-insights">
                              {(insights[it.nsKey] as string[]).length === 0 ? (
                                <li className="muted">no stored insights</li>
                              ) : (
                                (insights[it.nsKey] as string[]).map((e, i) => <li key={i}>{e}</li>)
                              )}
                            </ul>
                          ) : (
                            <button className="tl-reveal" onClick={() => loadInsight(it.nsKey)}>
                              Show insights →
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                ))}
            </div>
          </>
        )}
      </section>
    </main>
  );
}
