"use client";

// First-run setup wizard. A fresh org can't use the app until it has (1) a
// company on-chain and (3) at least one customer; (2) adding teammates is
// optional. Enforced + sequential so the app is never an empty, confusing shell.
import { useEffect, useState } from "react";
import { FiCheck, FiAlertTriangle, FiPlus, FiUserPlus, FiUsers, FiArrowRight } from "react-icons/fi";

import { useCurrentAccount } from "@mysten/dapp-kit";

import { createOrgAction, addMemberAction, myOrgsAction } from "@/app/actions/orgDirectory";
import { provisionClientAccount } from "@/app/actions/orgMemory";
import { linkOrgAndSwitch } from "@/app/actions/session";
import { createClient } from "@/lib/api";
import { getSessionToken, setSession } from "@/lib/session";
import { ROLES, type Role } from "@/lib/orgChain";

type Note = { ok: boolean; text: string } | null;

export function Onboarding({
  hasOrg,
  hasCustomer,
  onComplete,
}: {
  hasOrg: boolean;
  hasCustomer: boolean;
  onComplete: () => void;
}) {
  const account = useCurrentAccount();
  // start at the first incomplete step
  const [step, setStep] = useState<1 | 2 | 3>(!hasOrg ? 1 : 2);
  const [orgDone, setOrgDone] = useState(hasOrg);
  const [orgId, setOrgId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>(null);

  // If we arrive at step 2 with an org already created (revisiting onboarding),
  // resolve this user's org id so "add teammate" targets the right company.
  useEffect(() => {
    if (orgId || !hasOrg || !account?.address) return;
    myOrgsAction(account.address).then((o) => { if (o[0]) setOrgId(o[0].orgId); }).catch(() => {});
  }, [orgId, hasOrg, account?.address]);

  // step 1
  const [company, setCompany] = useState("");
  // step 2
  const [mAddr, setMAddr] = useState("");
  const [mLabel, setMLabel] = useState("");
  const [mRole, setMRole] = useState<Role>("rep");
  const [team, setTeam] = useState<{ label: string; role: Role }[]>([]);
  // step 3
  const [cName, setCName] = useState("");
  const [cEmail, setCEmail] = useState("");
  const [cPhone, setCPhone] = useState("");

  async function createCompany() {
    if (!company.trim() || busy) return;
    setBusy(true); setNote(null);
    try {
      // 1. Mint the on-chain org — but only once. `orgId` persists across retries
      // of the linking step below so we never create a duplicate company on-chain.
      let onChainId = orgId;
      if (!onChainId) {
        const r = await createOrgAction(company.trim(), account?.address);
        if (!r.ok) { setNote({ ok: false, text: r.error }); return; }
        onChainId = r.orgId;
        setOrgId(onChainId); setOrgDone(true);
      }
      // 2. Mirror it to the backend (POST /orgs) and re-scope the session to it, so
      // the first customer in step 3 is created under THIS company — not the default
      // org. Retryable: POST /orgs is idempotent on the on-chain object id.
      const token = getSessionToken();
      if (token && account?.address) {
        const linked = await linkOrgAndSwitch(token, company.trim(), onChainId, account.address);
        if (!linked.ok) { setNote({ ok: false, text: `created on-chain — tap again to finish linking (${linked.error})` }); return; }
        setSession({ token: linked.token, address: linked.address, orgId: linked.orgId, role: linked.role, orgs: linked.orgs });
      }
      setNote({ ok: true, text: `“${company}” created on-chain` });
      setStep(2);
    } finally {
      setBusy(false);
    }
  }

  async function addTeammate() {
    if (!mAddr.trim() || busy) return;
    setBusy(true); setNote(null);
    // adds to the company this user just created (scoped to their login)
    if (!orgId) { setNote({ ok: false, text: "create the company first" }); setBusy(false); return; }
    const r = await addMemberAction(orgId, mAddr.trim(), mRole, mLabel.trim() || "Member");
    if (r.ok) { setTeam((t) => [...t, { label: mLabel.trim() || mAddr.slice(0, 8), role: mRole }]); setMAddr(""); setMLabel(""); setNote({ ok: true, text: "Teammate added" }); }
    else setNote({ ok: false, text: r.error });
    setBusy(false);
  }

  async function createFirstCustomer() {
    if (!cName.trim() || busy) return;
    setBusy(true); setNote(null);
    try {
      const c = await createClient({ name: cName.trim(), relationship: "customer", email: cEmail.trim() || undefined, phone: cPhone.trim() || undefined });
      // Await provisioning so the customer's own MemWal account exists BEFORE any
      // notes are added — eliminates the race where early notes route to the
      // shared account and then can't be recalled from the per-customer account.
      setNote({ ok: true, text: `${c.name} added — setting up secure memory…` });
      await provisionClientAccount(c.id, getSessionToken()).catch(() => {});
      setNote({ ok: true, text: `${c.name} is ready — you're all set!` });
      setTimeout(onComplete, 600);
    } catch (e) {
      setNote({ ok: false, text: e instanceof Error ? e.message : "failed" });
    }
    setBusy(false);
  }

  const steps = [
    { n: 1, icon: <FiPlus />, label: "Company" },
    { n: 2, icon: <FiUsers />, label: "Team" },
    { n: 3, icon: <FiUserPlus />, label: "First customer" },
  ];

  return (
    <main className="ob">
      <div className="ob-card">
        <div className="ob-head">
          <h1>Set up Memento AI</h1>
          <p>A couple of steps and your organization's memory is live on-chain.</p>
        </div>

        <div className="ob-steps">
          {steps.map((s) => (
            <div key={s.n} className={`ob-step${step === s.n ? " active" : ""}${(s.n === 1 && orgDone) || (s.n < step) ? " done" : ""}`}>
              <span className="ob-step-dot">{((s.n === 1 && orgDone) || s.n < step) ? <FiCheck /> : s.icon}</span>
              <span className="ob-step-label">{s.label}</span>
            </div>
          ))}
        </div>

        {/* STEP 1 — company (required) */}
        {step === 1 && (
          <div className="ob-body">
            <h2>Create your company</h2>
            <p className="ob-hint">This becomes an on-chain organization your company owns. It holds your team and your customers.</p>
            <input className="ob-in" placeholder="Company name (e.g. Acme Wealth)" value={company} onChange={(e) => setCompany(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void createCompany(); }} autoFocus />
            <button className="ob-btn primary" onClick={createCompany} disabled={busy || !company.trim()}>{busy ? "Creating on-chain…" : <>Create company <FiArrowRight /></>}</button>
          </div>
        )}

        {/* STEP 2 — team (optional) */}
        {step === 2 && (
          <div className="ob-body">
            <h2>Add your team <span className="ob-opt">optional</span></h2>
            <p className="ob-hint">Invite advisors by their Sui wallet address. You can always do this later in the Org tab.</p>
            {team.length > 0 && (
              <div className="ob-team">{team.map((t, i) => <span key={i} className="ob-chip"><FiCheck /> {t.label} · {t.role}</span>)}</div>
            )}
            <input className="ob-in" placeholder="0x… teammate wallet address" value={mAddr} onChange={(e) => setMAddr(e.target.value)} />
            <div className="ob-row2">
              <input className="ob-in" placeholder="name / label" value={mLabel} onChange={(e) => setMLabel(e.target.value)} />
              <select className="ob-in" value={mRole} onChange={(e) => setMRole(e.target.value as Role)}>{ROLES.map((r) => <option key={r} value={r}>{r}</option>)}</select>
            </div>
            <button className="ob-btn" onClick={addTeammate} disabled={busy || !mAddr.trim()}>{busy ? "Adding…" : "Add teammate"}</button>
            <button className="ob-btn primary" onClick={() => { setNote(null); setStep(3); }}>{team.length ? "Continue" : "Skip for now"} <FiArrowRight /></button>
          </div>
        )}

        {/* STEP 3 — first customer (required) */}
        {step === 3 && (
          <div className="ob-body">
            <h2>Add your first customer</h2>
            <p className="ob-hint">Each customer gets their own on-chain memory account the company owns. Add one to start building memory.</p>
            <input className="ob-in" placeholder="Customer name" value={cName} onChange={(e) => setCName(e.target.value)} autoFocus />
            <div className="ob-row2">
              <input className="ob-in" placeholder="email (optional)" value={cEmail} onChange={(e) => setCEmail(e.target.value)} />
              <input className="ob-in" placeholder="phone (optional)" value={cPhone} onChange={(e) => setCPhone(e.target.value)} />
            </div>
            <button className="ob-btn primary" onClick={createFirstCustomer} disabled={busy || !cName.trim()}>{busy ? "Setting up…" : <>Finish setup <FiArrowRight /></>}</button>
          </div>
        )}

        {note && <p className={`ob-note ${note.ok ? "ok" : "err"}`}>{note.ok ? <FiCheck /> : <FiAlertTriangle />} {note.text}</p>}
      </div>
    </main>
  );
}
