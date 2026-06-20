"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { createClient, searchClients } from "@/lib/api";
import type { Client } from "@/lib/types";

const DEBOUNCE_MS = 200;
const MIN_PHONE_DIGITS = 6;

function looksLikePhone(s: string): boolean {
  return s.replace(/[^0-9]/g, "").length >= MIN_PHONE_DIGITS;
}

export function PhoneSearch() {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Client[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      return;
    }
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
    }, DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [query]);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  const goToClient = (id: number) => {
    router.push(`/clients/${id}`);
  };

  const createAndGo = async () => {
    const trimmed = query.trim();
    if (!trimmed) return;
    setCreating(true);
    setError(null);
    try {
      const isPhone = looksLikePhone(trimmed);
      const client = await createClient({
        name: isPhone ? `Unknown (${trimmed})` : trimmed,
        phone: isPhone ? trimmed : undefined,
      });
      goToClient(client.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    if (results.length > 0) {
      goToClient(results[0].id);
    } else if (query.trim()) {
      createAndGo();
    }
  };

  return (
    <div className="phone-search" ref={containerRef}>
      <div className="phone-search-icon" aria-hidden="true">
        ☎
      </div>
      <input
        ref={inputRef}
        type="text"
        className="phone-search-input"
        placeholder="Phone number or name — Enter to open"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        autoComplete="off"
      />
      {open && query.trim() && (
        <div className="phone-search-dropdown">
          {loading && <div className="phone-search-status">Searching…</div>}
          {!loading && results.length === 0 && (
            <button
              type="button"
              className="phone-search-create"
              onClick={createAndGo}
              disabled={creating}
            >
              {creating ? "Creating…" : looksLikePhone(query)
                ? `+ Create new client with phone ${query.trim()}`
                : `+ Create new client "${query.trim()}"`}
            </button>
          )}
          {results.map((c) => (
            <button
              key={c.id}
              type="button"
              className="phone-search-item"
              onClick={() => goToClient(c.id)}
            >
              <span className="phone-search-name">{c.name}</span>
              {c.phone && <span className="phone-search-meta">{c.phone}</span>}
              {c.email && <span className="phone-search-meta">{c.email}</span>}
              {c.deal_stage && (
                <span className="phone-search-stage">{c.deal_stage}</span>
              )}
            </button>
          ))}
          {error && <div className="phone-search-error">{error}</div>}
        </div>
      )}
    </div>
  );
}
