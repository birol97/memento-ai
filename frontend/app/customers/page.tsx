"use client";

// The whole app on one screen: a chat-style master/detail. Left = customer list
// (latest interaction on top, like a messaging app). Right = the selected
// customer's unified thread across every channel + compose + their info — the
// ClientWorkspace component. Pick a customer, talk to them, add notes, all here.
import { useCallback, useEffect, useMemo, useState } from "react";
import { SiTwilio } from "react-icons/si";
import { FiMail, FiPhoneCall, FiEdit3, FiSearch } from "react-icons/fi";

import { searchClients, listMessages, type Message } from "@/lib/api";
import type { Client } from "@/lib/types";
import { ClientWorkspace } from "@/components/ClientWorkspace";
import { CreateCharacterButton } from "@/components/CreateCharacterButton";
import { Avatar } from "@/components/Avatar";

const TWILIO_RED = "#F22F46";

function MiniIcon({ kind }: { kind: string }) {
  if (kind === "email") return <FiMail size={12} color="#7aa2f7" />;
  if (kind === "call") return <FiPhoneCall size={12} color={TWILIO_RED} />;
  if (kind === "note") return <FiEdit3 size={12} color="#a3e635" />;
  return <SiTwilio size={12} color={TWILIO_RED} />;
}

type Last = { kind: string; preview: string; at: string };

function previewOf(m: Message): string {
  if (m.kind === "call") return "Phone call";
  if (m.kind === "email") return m.subject || m.body || "(email)";
  return m.body || "(message)";
}

export default function CustomersPage() {
  const [clients, setClients] = useState<Client[]>([]);
  const [lastByClient, setLastByClient] = useState<Record<number, Last>>({});
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [cs, ms] = await Promise.all([searchClients(query.trim() || undefined), listMessages()]);
      // newest interaction per client → for ordering + preview
      const last: Record<number, Last> = {};
      for (const m of ms) {
        if (m.client_id == null) continue;
        const cur = last[m.client_id];
        if (!cur || m.created_at > cur.at) {
          last[m.client_id] = { kind: m.kind, preview: previewOf(m), at: m.created_at };
        }
      }
      const sorted = cs.slice().sort((a, b) => {
        const ta = last[a.id]?.at ?? a.created_at;
        const tb = last[b.id]?.at ?? b.created_at;
        return tb.localeCompare(ta); // latest on top
      });
      setClients(sorted);
      setLastByClient(last);
      setSelectedId((cur) => (cur != null && sorted.some((c) => c.id === cur) ? cur : sorted[0]?.id ?? null));
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    const h = setTimeout(() => void load(), 200); // debounce search
    return () => clearTimeout(h);
  }, [load]);

  const selected = useMemo(() => clients.find((c) => c.id === selectedId) ?? null, [clients, selectedId]);

  return (
    <div className="cx">
      {/* Inbox: a thin avatar rail that expands on hover (no button) */}
      <aside className="cx-list">
        <div className="cx-list-head">
          <div className="cx-search">
            <FiSearch size={14} />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search customers…" />
          </div>
          <CreateCharacterButton
            onCreated={(c) => {
              void load();
              setSelectedId(c.id);
            }}
          />
        </div>
        <div className="cx-rows">
          {loading && clients.length === 0 ? (
            <p className="cw-muted cx-pad cx-fade">Loading…</p>
          ) : clients.length === 0 ? (
            <p className="cw-muted cx-pad cx-fade">No customers yet. Create one above.</p>
          ) : (
            clients.map((c) => {
              const last = lastByClient[c.id];
              return (
                <button
                  key={c.id}
                  className={`cx-row${c.id === selectedId ? " active" : ""}`}
                  onClick={() => setSelectedId(c.id)}
                  title={c.name}
                >
                  <Avatar name={c.name} size={42} />
                  <div className="cx-row-main cx-fade">
                    <div className="cx-row-top">
                      <span className="cx-row-name">{c.name}</span>
                      {last && <span className="cx-row-time">{new Date(last.at).toLocaleDateString()}</span>}
                    </div>
                    <div className="cx-row-sub">
                      {last ? (
                        <>
                          <MiniIcon kind={last.kind} />
                          <span className="cx-row-preview">{last.preview}</span>
                        </>
                      ) : (
                        <span className="cx-row-preview muted">{c.relationship || "No interactions yet"}</span>
                      )}
                    </div>
                  </div>
                </button>
              );
            })
          )}
        </div>
      </aside>

      <section className="cx-detail">
        {selected ? (
          <ClientWorkspace
            key={selected.id}
            clientId={selected.id}
            embedded
            onDeleted={() => {
              setSelectedId(null);
              void load();
            }}
          />
        ) : (
          <div className="cx-empty">
            <p>Select a customer to see the conversation, or create a new one.</p>
          </div>
        )}
      </section>
    </div>
  );
}
