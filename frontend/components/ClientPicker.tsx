"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { createClient, searchClients } from "@/lib/api";
import { clientNamespace } from "@/lib/clientNamespace";
import type { Client } from "@/lib/types";

interface Props {
  value: Client | null;
  onChange: (client: Client | null) => void;
  disabled?: boolean;
}

export function ClientPicker({ value, onChange, disabled }: Props) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Client[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Debounced search.
  useEffect(() => {
    if (value) return; // already picked — don't search
    const handle = setTimeout(async () => {
      setLoading(true);
      try {
        const list = await searchClients(query);
        setResults(list);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    }, 200);
    return () => clearTimeout(handle);
  }, [query, value]);

  // Click-outside to close.
  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  const pick = (c: Client) => {
    onChange(c);
    setOpen(false);
    setQuery("");
    setCreating(false);
  };

  const clear = () => {
    onChange(null);
    setQuery("");
  };

  const handleCreate = useCallback(async () => {
    if (!query.trim()) return;
    setError(null);
    try {
      const c = await createClient({
        name: query.trim(),
        phone: phone.trim() || undefined,
        email: email.trim() || undefined,
      });
      pick(c);
      setPhone("");
      setEmail("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    // pick() called above resets state via setOpen(false)
  }, [query, phone, email]);

  if (value) {
    return (
      <div className="client-picker selected">
        <div className="client-pill">
          <span className="client-pill-label">Client:</span>
          <strong>{value.name}</strong>
          {value.phone && <span className="client-pill-meta">{value.phone}</span>}
          {value.email && <span className="client-pill-meta">{value.email}</span>}
          <span className="client-pill-meta ns" title="Walrus Memory namespace">
            🗂 {clientNamespace(value.id)}
          </span>
          <button
            type="button"
            className="client-pill-clear"
            onClick={clear}
            disabled={disabled}
            aria-label="Clear client"
          >
            ×
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="client-picker" ref={containerRef}>
      <input
        type="text"
        className="client-search"
        placeholder="Who's this call with?"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        disabled={disabled}
      />
      {open && (
        <div className="client-dropdown">
          {loading && <div className="client-dropdown-loading">Searching…</div>}
          {!loading && results.length === 0 && !query.trim() && (
            <div className="client-dropdown-empty">
              Type a name to search past clients, or to add a new one.
            </div>
          )}
          {!loading && results.length === 0 && query.trim() && !creating && (
            <button
              type="button"
              className="client-dropdown-create"
              onClick={() => setCreating(true)}
            >
              + Create new client “{query.trim()}”
            </button>
          )}
          {results.map((c) => (
            <button
              type="button"
              key={c.id}
              className="client-dropdown-item"
              onClick={() => pick(c)}
            >
              <span className="client-name">{c.name}</span>
              {c.phone && <span className="client-meta">{c.phone}</span>}
              {c.email && <span className="client-meta">{c.email}</span>}
            </button>
          ))}
          {!loading && results.length > 0 && query.trim() && !creating && (
            <button
              type="button"
              className="client-dropdown-create subtle"
              onClick={() => setCreating(true)}
            >
              + Or create new “{query.trim()}”
            </button>
          )}
          {creating && (
            <div className="client-dropdown-create-form">
              <div className="client-create-row">
                <span className="client-create-name">{query.trim()}</span>
              </div>
              <input
                type="tel"
                placeholder="phone (optional)"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
              />
              <input
                type="email"
                placeholder="email (optional)"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              <div className="client-create-actions">
                <button type="button" onClick={() => setCreating(false)}>
                  Cancel
                </button>
                <button type="button" className="primary" onClick={handleCreate}>
                  Create
                </button>
              </div>
            </div>
          )}
          {error && <div className="client-dropdown-error">{error}</div>}
        </div>
      )}
    </div>
  );
}
