"use client";

// Organization directory — fully on-chain (salescall::org). Create a company,
// add/revoke employees with roles. The company owns the Org object; this screen
// just drives it. "Who works here" is read straight from Sui, not a local DB.
import { useEffect, useState } from "react";
import { FiPlus, FiUserPlus, FiCheck, FiAlertTriangle, FiRefreshCw } from "react-icons/fi";

import { createOrgAction, addMemberAction, revokeMemberAction, listOrgsAction, getOrgAction } from "@/app/actions/orgDirectory";
import { ROLES, type Role, type OrgView } from "@/lib/orgChain";

type Note = { ok: boolean; text: string } | null;
const short = (s: string, h = 8, t = 6) => (s.length > h + t + 1 ? `${s.slice(0, h)}…${s.slice(-t)}` : s);

export default function OrgPage() {
  const [orgs, setOrgs] = useState<OrgView[]>([]);
  const [sel, setSel] = useState<OrgView | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>(null);

  const [newName, setNewName] = useState("");
  const [mAddr, setMAddr] = useState("");
  const [mRole, setMRole] = useState<Role>("rep");
  const [mLabel, setMLabel] = useState("");

  async function load(selectId?: string) {
    setLoading(true);
    const list = await listOrgsAction();
    setOrgs(list);
    setSel(list.find((o) => o.orgId === selectId) ?? list[0] ?? null);
    setLoading(false);
  }
  useEffect(() => { void load(); }, []);

  async function refreshSel() {
    if (!sel) return;
    const o = await getOrgAction(sel.orgId);
    if (o) { setSel(o); setOrgs((p) => p.map((x) => (x.orgId === o.orgId ? o : x))); }
  }

  async function createOrg() {
    if (!newName.trim() || busy) return;
    setBusy(true); setNote(null);
    const r = await createOrgAction(newName.trim());
    if (r.ok) { setNote({ ok: true, text: `Created · tx ${short(r.digest, 6, 6)}` }); setNewName(""); await load(r.orgId); }
    else setNote({ ok: false, text: r.error });
    setBusy(false);
  }
  async function addMember() {
    if (!sel || !mAddr.trim() || busy) return;
    setBusy(true); setNote(null);
    const r = await addMemberAction(sel.orgId, mAddr.trim(), mRole, mLabel.trim());
    if (r.ok) { setNote({ ok: true, text: `Added ${mLabel || mAddr.slice(0, 8)} as ${mRole}` }); setMAddr(""); setMLabel(""); await refreshSel(); }
    else setNote({ ok: false, text: r.error });
    setBusy(false);
  }
  async function revoke(addr: string) {
    if (!sel || busy) return;
    setBusy(true); setNote(null);
    const r = await revokeMemberAction(sel.orgId, addr);
    setNote(r.ok ? { ok: true, text: "Revoked" } : { ok: false, text: r.error });
    if (r.ok) await refreshSel();
    setBusy(false);
  }

  return (
    <main className="container">
      <header>
        <h1>Organization</h1>
        <p className="sub">Your team — owned by the company, on-chain. Add or revoke employees with roles; the directory lives on Sui, not a local database.</p>
      </header>

      {/* create */}
      <section className="tm-block" style={{ maxWidth: 560 }}>
        <h3 className="tm-h"><FiPlus /> Create a company</h3>
        <div className="tm-row2">
          <input className="tm-in" placeholder="Company name (e.g. Acme Wealth)" value={newName} onChange={(e) => setNewName(e.target.value)} />
          <button className="tm-btn primary" onClick={createOrg} disabled={busy || !newName.trim()}>{busy ? "On-chain…" : "Create"}</button>
        </div>
      </section>

      {/* picker */}
      {orgs.length > 0 && (
        <div className="tm-pick" style={{ maxWidth: 560, marginTop: 14 }}>
          <label className="tm-lbl">Company</label>
          <div className="tm-row2">
            <select className="tm-in" value={sel?.orgId ?? ""} onChange={(e) => setSel(orgs.find((o) => o.orgId === e.target.value) ?? null)}>
              {orgs.map((o) => <option key={o.orgId} value={o.orgId}>{o.name} · {o.members.length} members</option>)}
            </select>
            <button className="tm-btn" onClick={refreshSel} title="Refresh from chain"><FiRefreshCw /></button>
          </div>
        </div>
      )}

      {note && <p className={`tm-note ${note.ok ? "ok" : "err"}`} style={{ maxWidth: 560 }}>{note.ok ? <FiCheck /> : <FiAlertTriangle />} {note.text}</p>}

      {loading ? <p className="empty">loading from chain…</p> : !sel ? (
        <p className="empty">No company yet — create one above.</p>
      ) : (
        <section className="tm-block" style={{ maxWidth: 700, marginTop: 14 }}>
          <h3 className="tm-h"><FiUserPlus /> {sel.name} — team</h3>
          <div className="tm-rc-row"><span>Org object</span><code>{short(sel.orgId, 10, 8)}</code></div>
          <div className="tm-rc-row"><span>Owner</span><code>{short(sel.owner, 10, 8)}</code></div>

          <div className="org-members">
            {sel.members.length === 0 ? <span className="tm-muted">no employees yet</span> : sel.members.map((m) => (
              <div key={m.addr} className="org-member">
                <span className="org-m-info"><b>{m.label || "member"}</b> <span className="org-role">{m.role}</span> · <code>{short(m.addr, 8, 6)}</code></span>
                <button className="tm-deleg-revoke" onClick={() => revoke(m.addr)} disabled={busy}>Revoke</button>
              </div>
            ))}
          </div>

          <label className="tm-lbl" style={{ marginTop: 10 }}>Add an employee (their Sui wallet address)</label>
          <input className="tm-in" placeholder="0x… employee address" value={mAddr} onChange={(e) => setMAddr(e.target.value)} />
          <div className="tm-row2">
            <input className="tm-in" placeholder="name / label" value={mLabel} onChange={(e) => setMLabel(e.target.value)} />
            <select className="tm-in" value={mRole} onChange={(e) => setMRole(e.target.value as Role)}>
              {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
          <button className="tm-btn primary" onClick={addMember} disabled={busy || !mAddr.trim()}>{busy ? "On-chain…" : "Add employee"}</button>
        </section>
      )}
    </main>
  );
}
