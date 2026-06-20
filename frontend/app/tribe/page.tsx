"use client";

// Tribe Circle — a bubble map of every customer and how they connect. Bubbles are
// customers (sized by how much you've interacted); links are derived connections:
//  • shared tags  → they're part of the same "tribe"
//  • a name-mention in one customer's profile/notes → they know each other
// Hover a bubble to see its summary + who it's connected to. Pure SVG + a tiny
// force layout — no extra deps.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { searchClients, listMessages, type Message } from "@/lib/api";
import type { Client } from "@/lib/types";
import TribeMembers from "@/components/TribeMembers";
import TribeSearch from "@/components/TribeSearch";
import TribeCharacter from "@/components/TribeCharacter";

const W = 960;
const H = 620;
// theme-aligned bubble palette — blues/azure family + calm accents
const COLORS = ["#2f7bf6", "#6ea6ff", "#4f86f7", "#5bc0e8", "#8b9dff", "#3f6fe0", "#7aa2ff"];

type Node = { i: number; c: Client; x: number; y: number; vx: number; vy: number; r: number; count: number; color: string };
type Edge = { a: number; b: number; reason: string; kind: "structural" | "semantic" };
type SemEdge = { a: number; b: number; shared: string[] }; // by client id, from /api/tribe-links

function colorFor(c: Client, i: number): string {
  const key = (c.deal_stage || c.relationship || "").toLowerCase();
  if (key.includes("won")) return "#34d399";
  if (key.includes("lost")) return "#f87171";
  if (key.startsWith("customer")) return "#2f7bf6";
  return COLORS[i % COLORS.length];
}

function buildGraph(clients: Client[], msgs: Message[], semEdges: SemEdge[]) {
  const counts: Record<number, number> = {};
  for (const m of msgs) if (m.client_id != null) counts[m.client_id] = (counts[m.client_id] ?? 0) + 1;

  const nodes: Node[] = clients.map((c, i) => {
    const count = counts[c.id] ?? 0;
    const angle = (i / Math.max(1, clients.length)) * Math.PI * 2;
    return {
      i, c, count,
      x: W / 2 + Math.cos(angle) * 220,
      y: H / 2 + Math.sin(angle) * 220,
      vx: 0, vy: 0,
      r: 20 + Math.min(count, 12) * 2.2,
      color: colorFor(c, i),
    };
  });

  const idToIndex = new Map(clients.map((c, i) => [c.id, i]));
  const pairKey = (i: number, j: number) => (i < j ? `${i}-${j}` : `${j}-${i}`);
  const byPair = new Map<string, Edge>();
  const text = (c: Client) => `${c.profile ?? ""} ${c.notes ?? ""}`.toLowerCase();

  // structural edges: shared tags / name-mentions
  for (let i = 0; i < clients.length; i++) {
    for (let j = i + 1; j < clients.length; j++) {
      const a = clients[i], b = clients[j];
      const shared = (a.tags ?? []).filter((t) => (b.tags ?? []).includes(t));
      if (shared.length) { byPair.set(pairKey(i, j), { a: i, b: j, reason: `shared tag: ${shared.join(", ")}`, kind: "structural" }); continue; }
      if (b.name.length >= 3 && text(a).includes(b.name.toLowerCase())) { byPair.set(pairKey(i, j), { a: i, b: j, reason: `${a.name} mentions ${b.name}`, kind: "structural" }); continue; }
      if (a.name.length >= 3 && text(b).includes(a.name.toLowerCase())) { byPair.set(pairKey(i, j), { a: i, b: j, reason: `${b.name} mentions ${a.name}`, kind: "structural" }); }
    }
  }

  // semantic edges: customers whose MEMORY references the same entity/topic
  for (const se of semEdges) {
    const i = idToIndex.get(se.a), j = idToIndex.get(se.b);
    if (i == null || j == null) continue;
    const k = pairKey(i, j);
    const reason = `both linked to: ${se.shared.join(", ")}`;
    const ex = byPair.get(k);
    byPair.set(k, { a: i, b: j, kind: "semantic", reason: ex && ex.kind === "structural" ? `${reason}; ${ex.reason}` : reason });
  }

  const edges: Edge[] = [...byPair.values()];

  // settle with a tiny force simulation (deterministic — no rng)
  const cx = W / 2, cy = H / 2;
  for (let t = 0; t < 320; t++) {
    for (const n of nodes) { n.vx += (cx - n.x) * 0.004; n.vy += (cy - n.y) * 0.004; }
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        let dx = a.x - b.x, dy = a.y - b.y;
        let d2 = dx * dx + dy * dy || 1;
        const f = 9000 / d2;
        const d = Math.sqrt(d2);
        const ux = dx / d, uy = dy / d;
        a.vx += ux * f; a.vy += uy * f; b.vx -= ux * f; b.vy -= uy * f;
      }
    }
    for (const e of edges) {
      const a = nodes[e.a], b = nodes[e.b];
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const f = (d - 150) * 0.02;
      const ux = dx / d, uy = dy / d;
      a.vx += ux * f; a.vy += uy * f; b.vx -= ux * f; b.vy -= uy * f;
    }
    for (const n of nodes) {
      n.vx *= 0.82; n.vy *= 0.82;
      n.x += n.vx; n.y += n.vy;
      n.x = Math.max(n.r + 8, Math.min(W - n.r - 8, n.x));
      n.y = Math.max(n.r + 8, Math.min(H - n.r - 8, n.y));
    }
  }
  return { nodes, edges };
}

function initials(name: string): string {
  const p = name.trim().split(/\s+/).filter(Boolean);
  return ((p[0]?.[0] ?? "") + (p.length > 1 ? p[p.length - 1][0] : "")).toUpperCase() || "?";
}

export default function TribePage() {
  const [clients, setClients] = useState<Client[]>([]);
  const [msgs, setMsgs] = useState<Message[]>([]);
  const [semEdges, setSemEdges] = useState<SemEdge[]>([]);
  const [loading, setLoading] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  const [tab, setTab] = useState<"circle" | "search" | "members" | "character">("circle");
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    try {
      const [cs, ms] = await Promise.all([searchClients(), listMessages()]);
      setClients(cs); setMsgs(ms);
      // semantic connections from MemWal (best-effort, async — graph re-lays when it lands)
      if (cs.length) {
        setAnalyzing(true);
        fetch("/api/tribe-links", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ clients: cs.map((c) => ({ id: c.id, name: c.name, profile: c.profile, notes: c.notes })) }),
        })
          .then((r) => (r.ok ? r.json() : { edges: [] }))
          .then((d) => setSemEdges(Array.isArray(d.edges) ? d.edges : []))
          .catch(() => {})
          .finally(() => setAnalyzing(false));
      }
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const { nodes, edges } = useMemo(() => buildGraph(clients, msgs, semEdges), [clients, msgs, semEdges]);
  const byId = useMemo(() => Object.fromEntries(nodes.map((n) => [n.i, n])), [nodes]);

  const hovered = hover != null ? byId[hover] : null;
  const hoveredEdges = hovered ? edges.filter((e) => e.a === hover || e.b === hover) : [];

  return (
    <main className="container">
      <header>
        <h1>Tribe</h1>
        <p className="sub">Everyone you know and how they connect.</p>
      </header>

      <nav className="tribe-tabs">
        <button className={tab === "circle" ? "active" : ""} onClick={() => setTab("circle")}>Circle</button>
        <button className={tab === "search" ? "active" : ""} onClick={() => setTab("search")}>Search</button>
        <button className={tab === "members" ? "active" : ""} onClick={() => setTab("members")}>Members</button>
        <button className={tab === "character" ? "active" : ""} onClick={() => setTab("character")}>Character</button>
      </nav>

      {tab === "circle" && (
       <div className="tribe-pane">
      <div className="tribe-stats">
        <span><b>{clients.length}</b> people</span>
        <span><b>{edges.length}</b> connections</span>
        <span><b>{edges.filter((e) => e.kind === "semantic").length}</b> from memory</span>
        <span className="tribe-legend"><i className="dot sem" /> shared memory/topic</span>
        <span className="tribe-legend"><i className="dot str" /> tag / mention</span>
        {analyzing && <span className="tribe-analyzing">🧠 analyzing memory…</span>}
      </div>

      {loading ? (
        <p className="empty">loading…</p>
      ) : clients.length === 0 ? (
        <p className="empty">No members yet — add your first one in the Members tab.</p>
      ) : (
        <div className="tribe-wrap" ref={wrapRef}>
          <svg viewBox={`0 0 ${W} ${H}`} className="tribe-svg" preserveAspectRatio="xMidYMid meet">
            {edges.map((e, k) => {
              const a = byId[e.a], b = byId[e.b];
              const on = hover === e.a || hover === e.b;
              const stroke = on ? "var(--accent-soft)" : e.kind === "semantic" ? "var(--accent)" : "var(--border)";
              return <line key={k} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={stroke} strokeWidth={on ? 2.6 : e.kind === "semantic" ? 1.8 : 1.1} strokeDasharray={e.kind === "semantic" ? "0" : "4 3"} opacity={hover == null || on ? 0.9 : 0.14} />;
            })}
            {nodes.map((n) => {
              const dim = hover != null && hover !== n.i && !hoveredEdges.some((e) => e.a === n.i || e.b === n.i);
              return (
                <g key={n.i} transform={`translate(${n.x},${n.y})`} opacity={dim ? 0.25 : 1}
                   onMouseEnter={() => setHover(n.i)} onMouseLeave={() => setHover(null)} style={{ cursor: "pointer" }}>
                  <circle r={n.r} fill={n.color} stroke="#0a0e1a" strokeWidth={2} />
                  <text textAnchor="middle" dy="0.34em" fontSize={Math.max(11, n.r * 0.5)} fontWeight={700} fill="#0a0e1a">{initials(n.c.name)}</text>
                  <text textAnchor="middle" y={n.r + 14} fontSize="12" fill="#c4cdde">{n.c.name}</text>
                </g>
              );
            })}
          </svg>

          {hovered && (
            <div className="tribe-tip" style={{ left: Math.min(hovered.x + 18, W - 250), top: Math.max(hovered.y - 10, 8) }}>
              <div className="tribe-tip-name">{hovered.c.name}</div>
              <div className="tribe-tip-sub">
                {[hovered.c.relationship, hovered.c.deal_stage, `${hovered.count} interactions`].filter(Boolean).join(" · ")}
              </div>
              {hovered.c.profile && <p className="tribe-tip-profile">{hovered.c.profile.slice(0, 140)}</p>}
              {(hovered.c.tags ?? []).length > 0 && (
                <div className="tribe-tip-tags">{(hovered.c.tags ?? []).map((t) => <span key={t} className="tribe-tag">{t}</span>)}</div>
              )}
              <div className="tribe-tip-conns">
                {hoveredEdges.length === 0 ? (
                  <span className="cw-muted">No connections yet.</span>
                ) : (
                  hoveredEdges.map((e, k) => {
                    const other = byId[e.a === hover ? e.b : e.a];
                    return <div key={k} className="tribe-conn"><b>{other.c.name}</b> — {e.reason}</div>;
                  })
                )}
              </div>
            </div>
          )}
        </div>
      )}
       </div>
      )}

      {tab === "search" && (
       <div className="tribe-pane">
         {!loading && clients.length > 0
           ? <TribeSearch clients={clients} msgs={msgs} />
           : <p className="empty">Add members to your tribe to search them.</p>}
       </div>
      )}

      {tab === "members" && (
       <div className="tribe-pane tribe-members-pane">
         <TribeMembers clients={clients} msgs={msgs} onChanged={load} />
       </div>
      )}

      {tab === "character" && (
       <div className="tribe-pane tribe-character-pane">
         <TribeCharacter />
       </div>
      )}
    </main>
  );
}
