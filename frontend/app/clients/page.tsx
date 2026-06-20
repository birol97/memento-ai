"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { createClient, searchClients } from "@/lib/api";
import type { Client } from "@/lib/types";

export default function ClientsDirectoryPage() {
  const [clients, setClients] = useState<Client[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const refresh = async () => {
    setLoading(true);
    try {
      setClients(await searchClients(query));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const handle = setTimeout(refresh, 200);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const filterChips = useMemo(() => {
    const all = new Set<string>();
    for (const c of clients) for (const t of c.tags ?? []) all.add(t);
    return Array.from(all).sort();
  }, [clients]);

  return (
    <main className="page">
      <header className="header">
        <h1>Clients</h1>
        <p className="subtitle">
          <Link href="/">← Recorder</Link>
          {" · "}
          <Link href="/sessions">All sessions</Link>
        </p>
      </header>

      <div className="clients-toolbar">
        <input
          type="text"
          className="client-search"
          placeholder="Search by name, phone, or email"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button className="btn start" onClick={() => setCreating(true)}>
          + New client
        </button>
      </div>

      {creating && (
        <NewClientForm
          onCancel={() => setCreating(false)}
          onCreated={async () => {
            setCreating(false);
            await refresh();
          }}
        />
      )}

      {error && <div className="error">{error}</div>}
      {loading && clients.length === 0 && <p>Loading…</p>}
      {!loading && clients.length === 0 && (
        <p className="placeholder">No clients yet. Create one above.</p>
      )}

      {filterChips.length > 0 && (
        <div className="filter-chips">
          {filterChips.map((t) => (
            <span key={t} className="chip">{t}</span>
          ))}
        </div>
      )}

      <div className="client-grid">
        {clients.map((c) => (
          <Link key={c.id} href={`/clients/${c.id}`} className="client-card">
            <div className="client-card-name">{c.name}</div>
            <div className="client-card-meta">
              {c.role && <span>{c.role}</span>}
              {c.deal_stage && <span className="stage">{c.deal_stage}</span>}
            </div>
            <div className="client-card-contact">
              {c.phone && <span>{c.phone}</span>}
              {c.email && <span>{c.email}</span>}
            </div>
            {(c.tags?.length ?? 0) > 0 && (
              <div className="client-card-tags">
                {c.tags!.map((t) => (
                  <span key={t} className="tag">{t}</span>
                ))}
              </div>
            )}
          </Link>
        ))}
      </div>
    </main>
  );
}

function NewClientForm({
  onCancel,
  onCreated,
}: {
  onCancel: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("");
  const [dealStage, setDealStage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      await createClient({
        name: name.trim(),
        phone: phone.trim() || undefined,
        email: email.trim() || undefined,
        role: role.trim() || undefined,
        deal_stage: dealStage.trim() || undefined,
      });
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form className="client-form" onSubmit={submit}>
      <div className="grid-2">
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
        </label>
        <label>
          Role / title
          <input value={role} onChange={(e) => setRole(e.target.value)} placeholder="e.g. VP Sales" />
        </label>
        <label>
          Phone
          <input value={phone} onChange={(e) => setPhone(e.target.value)} type="tel" />
        </label>
        <label>
          Email
          <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" />
        </label>
        <label>
          Deal stage
          <select value={dealStage} onChange={(e) => setDealStage(e.target.value)}>
            <option value="">(none)</option>
            <option value="prospect">prospect</option>
            <option value="discovery">discovery</option>
            <option value="demo">demo</option>
            <option value="negotiation">negotiation</option>
            <option value="closed-won">closed-won</option>
            <option value="closed-lost">closed-lost</option>
          </select>
        </label>
      </div>
      {error && <div className="error">{error}</div>}
      <div className="form-actions">
        <button type="button" onClick={onCancel} disabled={submitting}>Cancel</button>
        <button type="submit" className="btn start" disabled={submitting || !name.trim()}>
          {submitting ? "Creating…" : "Create"}
        </button>
      </div>
    </form>
  );
}
