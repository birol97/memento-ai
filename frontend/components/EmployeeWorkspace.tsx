"use client";

// The employee's scoped app: shows ONLY the customers granted to them (their key
// is a delegate on the customer's on-chain account), with the full workspace
// (chat, copilot, research, calls…) for each.
import { useEffect, useState } from "react";

import { employeeCustomers, employeeOrgs } from "@/app/actions/employee";
import { ClientWorkspace } from "@/components/ClientWorkspace";
import { Avatar } from "@/components/Avatar";
import type { Client } from "@/lib/types";

export function EmployeeWorkspace({
  identity,
  onSignOut,
}: {
  identity: { pubHex: string; address: string };
  onSignOut: () => void;
}) {
  const [clients, setClients] = useState<Client[]>([]);
  const [sel, setSel] = useState<Client | null>(null);
  const [loading, setLoading] = useState(true);
  const [orgs, setOrgs] = useState<{ name: string; role: string }[]>([]);

  useEffect(() => {
    let live = true;
    (async () => {
      const [cs, os] = await Promise.all([
        employeeCustomers(identity.pubHex),
        employeeOrgs(identity.address),
      ]);
      if (!live) return;
      setClients(cs);
      setOrgs(os.map((o) => ({ name: o.name, role: o.role })));
      setSel(cs[0] ?? null);
      setLoading(false);
    })();
    return () => { live = false; };
  }, [identity.pubHex, identity.address]);

  return (
    <main className="container">
      <header className="emp-head">
        <div>
          <h1>Your workspace</h1>
          <p className="sub">
            Signed in as <code>{identity.address.slice(0, 12)}…</code>
            {orgs.length > 0 && <> · <b>{orgs[0].role}</b> at {orgs.map((o) => o.name).join(", ")}</>}
            {" · "}
            {loading ? "checking access…" : `${clients.length} customer${clients.length === 1 ? "" : "s"} granted to you`}
          </p>
        </div>
        <button className="tm-btn" onClick={onSignOut}>Sign out</button>
      </header>

      {loading ? (
        <p className="empty">loading…</p>
      ) : clients.length === 0 ? (
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
