"use client";

// Employee workspace. Sign in with your own key → see ONLY the customers granted
// to you (your key is a delegate on their on-chain account) → use the full app
// (chat, copilot, research, calls…) for them. Access scoping is on-chain.
import { useState } from "react";

import { employeeSignIn, employeeCustomers } from "@/app/actions/employee";
import { ClientWorkspace } from "@/components/ClientWorkspace";
import { Avatar } from "@/components/Avatar";
import type { Client } from "@/lib/types";

export default function EmployeePage() {
  const [key, setKey] = useState("");
  const [me, setMe] = useState<{ pubHex: string; address: string } | null>(null);
  const [clients, setClients] = useState<Client[]>([]);
  const [sel, setSel] = useState<Client | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function signIn() {
    if (!key.trim() || busy) return;
    setBusy(true); setErr(null);
    const r = await employeeSignIn(key.trim());
    if (!r.ok) { setErr(r.error); setBusy(false); return; }
    const cs = await employeeCustomers(r.pubHex);
    setMe({ pubHex: r.pubHex, address: r.address });
    setClients(cs);
    setSel(cs[0] ?? null);
    setBusy(false);
  }

  function signOut() { setMe(null); setClients([]); setSel(null); setKey(""); }

  if (!me) {
    return (
      <main className="container">
        <header><h1>Employee sign-in</h1><p className="sub">Sign in with your own key to access the customers your org granted you.</p></header>
        <div className="emp-signin">
          <label className="tm-lbl">Your employee key (private key)</label>
          <input className="tm-in" placeholder="paste your key…" value={key} onChange={(e) => setKey(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void signIn(); }} />
          <button className="tm-btn primary" onClick={() => void signIn()} disabled={busy || !key.trim()}>{busy ? "Checking access…" : "Sign in"}</button>
          {err && <p className="tm-note err">{err}</p>}
          <p className="tm-hint">Demo: use the private key from a Team-access “Generate (demo)” grant.</p>
        </div>
      </main>
    );
  }

  return (
    <main className="container">
      <header className="emp-head">
        <div>
          <h1>Your workspace</h1>
          <p className="sub">Signed in as <code>{me.address.slice(0, 12)}…</code> · {clients.length} customer{clients.length === 1 ? "" : "s"} granted to you</p>
        </div>
        <button className="tm-btn" onClick={signOut}>Sign out</button>
      </header>

      {clients.length === 0 ? (
        <p className="empty">No customers granted to you yet — ask your org to grant access in Team access.</p>
      ) : (
        <div className="emp-layout">
          <aside className="emp-list">
            {clients.map((c) => (
              <button key={c.id} className={`emp-row${sel?.id === c.id ? " active" : ""}`} onClick={() => setSel(c)}>
                <Avatar name={c.name} size={30} />
                <span>{c.name}</span>
              </button>
            ))}
          </aside>
          <div className="emp-detail">
            {sel ? <ClientWorkspace key={sel.id} clientId={sel.id} embedded /> : <p className="empty">Pick a customer.</p>}
          </div>
        </div>
      )}
    </main>
  );
}
