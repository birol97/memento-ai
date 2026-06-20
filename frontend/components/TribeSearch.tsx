"use client";

// Google-like Q&A over the tribe. Ask a question, scope it to the whole tribe or
// one member, and optionally include MemWal recall ("full context") for deeper
// answers. Grounded server-side in /api/tribe-search.
import { useMemo, useState } from "react";
import { FiSearch } from "react-icons/fi";

import type { Message } from "@/lib/api";
import type { Client } from "@/lib/types";

const EXAMPLES = [
  "Top 3 oldest people in my tribe",
  "Who likely has the most money?",
  "Do I have any scheduled calls or emails?",
  "Who haven't I contacted in a while?",
];

export default function TribeSearch({ clients, msgs }: { clients: Client[]; msgs: Message[] }) {
  const [q, setQ] = useState("");
  const [scope, setScope] = useState<"all" | number>("all");
  const [recall, setRecall] = useState(true); // default ON so search uses MemWal memory (finds commitments etc.)
  const [loading, setLoading] = useState(false);
  const [answer, setAnswer] = useState<string | null>(null);
  const [meta, setMeta] = useState<string>("");
  const [err, setErr] = useState<string | null>(null);

  // interactions + last-contact per member, from the message thread
  const stats = useMemo(() => {
    const m = new Map<number, { count: number; last: string }>();
    for (const msg of msgs) {
      if (msg.client_id == null) continue;
      const cur = m.get(msg.client_id) || { count: 0, last: "" };
      cur.count += 1;
      if (!cur.last || msg.created_at > cur.last) cur.last = msg.created_at;
      m.set(msg.client_id, cur);
    }
    return m;
  }, [msgs]);

  async function ask(question?: string) {
    const text = (question ?? q).trim();
    if (!text || loading) return;
    if (question) setQ(question);
    setLoading(true);
    setErr(null);
    setAnswer(null);
    try {
      const inScope = scope === "all" ? clients : clients.filter((c) => c.id === scope);
      const members = inScope.map((c) => ({
        id: c.id, name: c.name, relationship: c.relationship, role: c.role,
        deal_stage: c.deal_stage, phone: c.phone, email: c.email,
        profile: c.profile, objective: c.objective, notes: c.notes,
        created_at: c.created_at, tags: c.tags,
        interactions: stats.get(c.id)?.count ?? 0, last_contact: stats.get(c.id)?.last ?? null,
      }));
      const r = await fetch("/api/tribe-search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: text, members, recall }),
      });
      const d = await r.json();
      if (d.error) setErr(d.error);
      else {
        setAnswer(d.answer || "No answer.");
        setMeta(`searched ${d.used} member${d.used === 1 ? "" : "s"}${recall ? ` · recalled ${d.recalled ?? 0} from Walrus` : ""}`);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "search failed");
    }
    setLoading(false);
  }

  return (
    <div className="ts">
      <div className="ts-bar">
        <FiSearch className="ts-icon" />
        <input
          className="ts-input"
          placeholder="Ask your tribe…  e.g. “who haven’t I called in a month?”"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void ask(); }}
        />
        <button className="ts-go" onClick={() => void ask()} disabled={loading || !q.trim()}>
          {loading ? "Thinking…" : "Ask"}
        </button>
      </div>

      <div className="ts-controls">
        <label className="ts-ctl">
          <span>Scope</span>
          <select value={scope} onChange={(e) => setScope(e.target.value === "all" ? "all" : Number(e.target.value))}>
            <option value="all">All tribe ({clients.length})</option>
            {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <label className="ts-check">
          <input type="checkbox" checked={recall} onChange={(e) => setRecall(e.target.checked)} />
          <span>Include full memory recall (Walrus)</span>
        </label>
      </div>

      <div className="ts-examples">
        {EXAMPLES.map((ex) => (
          <button key={ex} className="ts-chip" onClick={() => void ask(ex)} disabled={loading}>{ex}</button>
        ))}
      </div>

      {err && <p className="ts-err">{err}</p>}
      {answer && (
        <div className="ts-answer">
          <div className="ts-answer-body">{answer}</div>
          {meta && <div className="ts-answer-meta">{meta}</div>}
        </div>
      )}
    </div>
  );
}
