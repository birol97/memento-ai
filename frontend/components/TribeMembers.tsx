"use client";

// Tribe member manager — sits beside the bubble map.
//  • Add to tribe   → create a new customer/friend (then it appears as a bubble)
//  • Update member  → plain-language edits ("client number is +99999") via the
//                     /api/client-extract route → updateClient
//  • Research       → full context + recalled MemWal memory for one member
import { useEffect, useState } from "react";
import { FiUserPlus, FiEdit3, FiSearch, FiCheck, FiAlertTriangle } from "react-icons/fi";

import { createClient, updateClient, listSubspaces, fetchManifest, type ClientWriteInput, type Message } from "@/lib/api";
import type { Client } from "@/lib/types";
import { getFullContext } from "@/app/actions/ask";
import { getCustomerCap, syncMemoryMap, type SyncReceipt } from "@/app/actions/onchain";
import { provisionClientAccount, grantEmployeeAccess, revokeEmployeeAccess, listAccountDelegates, generateEmployeeKey } from "@/app/actions/orgMemory";
import type { Delegate } from "@/lib/orgMemory";
import { clientNamespace } from "@/lib/clientNamespace";
import { getSessionToken } from "@/lib/session";

const RELATIONSHIPS = ["friend", "colleague", "customer", "family", "expert", "other"];

type Note = { ok: boolean; text: string } | null;
type Ev = { at: string; label: string; text: string; blob_id?: string | null };
type Commit = { source_index: number; what: string; due: string; due_iso: string | null };

const WALRUS_AGG =
  process.env.NEXT_PUBLIC_WALRUS_AGGREGATOR ?? "https://aggregator.walrus-testnet.walrus.space";

// how a memory line was captured → human label
function sourceLabel(kind?: string | null, dir?: string | null): string {
  if (kind === "note") return "Note";
  if (kind === "call") return "Phone call";
  if (kind === "email") return dir === "out" ? "Email sent" : "Email";
  if (kind === "sms" || kind === "twilio") return dir === "out" ? "SMS sent" : "SMS";
  return "Message";
}
const fmtDate = (s: string) => {
  try {
    return new Date(s).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  } catch {
    return "";
  }
};

export default function TribeMembers({ clients, msgs, onChanged }: { clients: Client[]; msgs: Message[]; onChanged: () => void }) {
  // selected member drives both Update + Research
  const [selId, setSelId] = useState<number | "">(clients[0]?.id ?? "");

  // add
  const [name, setName] = useState("");
  const [rel, setRel] = useState("friend");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [adding, setAdding] = useState(false);
  const [addNote, setAddNote] = useState<Note>(null);
  const [receipt, setReceipt] = useState<SyncReceipt | null>(null);

  // update-by-sentence
  const [instr, setInstr] = useState("");
  const [updating, setUpdating] = useState(false);
  const [updNote, setUpdNote] = useState<Note>(null);

  // research
  const [ctx, setCtx] = useState<{
    client: Client;
    brief: string;
    timeline: Ev[];
    commitments: Commit[];
    groups: { label: string; entries: string[] }[];
    factCount: number;
    timelineSource: "walrus" | "local";
  } | null>(null);
  const [researching, setResearching] = useState(false);

  // team access (employee grant/revoke)
  const [delegates, setDelegates] = useState<Delegate[]>([]);
  const [empPub, setEmpPub] = useState("");
  const [empLabel, setEmpLabel] = useState("");
  const [empPriv, setEmpPriv] = useState<string | null>(null);
  const [teamBusy, setTeamBusy] = useState(false);
  const [teamNote, setTeamNote] = useState<Note>(null);

  const selected = clients.find((c) => c.id === selId) || null;
  const accountId = selected?.memwal_account_id || null;

  async function loadDelegates(acc: string) {
    const r = await listAccountDelegates(acc);
    setDelegates(r.ok ? r.delegates : []);
  }
  useEffect(() => {
    setDelegates([]); setTeamNote(null); setEmpPriv(null);
    if (accountId) void loadDelegates(accountId);
  }, [accountId]);

  async function grant() {
    if (!accountId || !empPub.trim() || teamBusy) return;
    setTeamBusy(true); setTeamNote(null);
    const r = await grantEmployeeAccess(Number(selId), accountId, empPub.trim(), empLabel.trim() || "Employee");
    setTeamNote(r.ok ? { ok: true, text: `Granted · tx ${r.digest.slice(0, 8)}…` } : { ok: false, text: r.error });
    if (r.ok) { setEmpPub(""); setEmpLabel(""); await loadDelegates(accountId); }
    setTeamBusy(false);
  }
  async function revoke(pubHex: string) {
    if (!accountId || teamBusy) return;
    setTeamBusy(true); setTeamNote(null);
    const r = await revokeEmployeeAccess(Number(selId), accountId, pubHex);
    setTeamNote(r.ok ? { ok: true, text: `Revoked · tx ${r.digest.slice(0, 8)}…` } : { ok: false, text: r.error });
    if (r.ok) await loadDelegates(accountId);
    setTeamBusy(false);
  }
  async function genKey() {
    const k = await generateEmployeeKey();
    setEmpPub(k.publicKeyHex);
    setEmpPriv(k.privateKey);
    setEmpLabel((l) => l || "Demo employee");
  }

  // Provision (or recover) this customer's org-owned MemWal account, then refresh
  // so the panel picks up the new account id. recover-or-create on chain → safe to
  // click for a customer whose pointer was lost (e.g. after a cache wipe).
  async function provision() {
    if (selId === "" || teamBusy) return;
    setTeamBusy(true); setTeamNote(null);
    const r = await provisionClientAccount(Number(selId), getSessionToken());
    setTeamNote(r.ok ? { ok: true, text: `Account ready · ${r.accountId.slice(0, 12)}…` } : { ok: false, text: r.error });
    if (r.ok) onChanged();
    setTeamBusy(false);
  }

  async function add() {
    if (!name.trim() || adding) return;
    setAdding(true);
    setAddNote(null);
    try {
      const input: ClientWriteInput & { name: string } = { name: name.trim(), relationship: rel };
      if (phone.trim()) input.phone = phone.trim();
      if (email.trim()) input.email = email.trim();
      const c = await createClient(input);
      setName(""); setPhone(""); setEmail("");
      setSelId(c.id);
      onChanged();
      // single path: push identity to Walrus + anchor on the Sui cap, with a receipt
      setAddNote({ ok: true, text: `Added ${c.name} — publishing to Walrus + Sui…` });
      const r = await syncMemoryMap(c.id, undefined, getSessionToken());
      if (r.ok) {
        setReceipt(r.receipt);
        setAddNote({ ok: true, text: `${c.name} pushed to Walrus + anchored on Sui ✓` });
      } else {
        setAddNote({ ok: false, text: `Added, but publish failed: ${r.error}` });
      }
      // background: provision this customer's OWN org-owned MemWal account (~15s).
      // Forward the session token so the backend caches the account id on the RIGHT
      // org's client row (else 404 → "No org account yet" forever), then refresh so
      // the Team-access panel picks it up.
      provisionClientAccount(c.id, getSessionToken())
        .then((p) => {
          console.log("[provision]", c.name, p.ok ? "account " + p.accountId : "failed: " + p.error);
          if (p.ok) { onChanged(); setAddNote({ ok: true, text: `${c.name} ready — org account provisioned ✓` }); }
          else setAddNote({ ok: false, text: `${c.name}: account provisioning failed — ${p.error}` });
        })
        .catch(() => {});
    } catch (e) {
      setAddNote({ ok: false, text: e instanceof Error ? e.message : "add failed" });
    }
    setAdding(false);
  }

  async function applyUpdate() {
    if (!instr.trim() || selId === "" || updating) return;
    setUpdating(true);
    setUpdNote(null);
    try {
      const r = await fetch("/api/client-extract", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: instr }),
      });
      const { patch, summary } = (await r.json()) as { patch: ClientWriteInput; summary: string };
      if (!patch || Object.keys(patch).length === 0) {
        setUpdNote({ ok: false, text: "Couldn't tell what to update — try e.g. \"phone is +1 555 0100\"." });
      } else {
        await updateClient(Number(selId), patch);
        setUpdNote({ ok: true, text: `Updated — ${summary}` });
        setInstr("");
        syncMemoryMap(Number(selId), undefined, getSessionToken()).catch(() => {}); // refresh identity on Walrus
        onChanged();
        if (ctx && ctx.client.id === selId) void research(); // refresh open research
      }
    } catch (e) {
      setUpdNote({ ok: false, text: e instanceof Error ? e.message : "update failed" });
    }
    setUpdating(false);
  }

  async function research() {
    if (selId === "" || researching) return;
    setResearching(true);
    try {
      const fresh = clients.find((c) => c.id === selId)!;
      // deep recall: fan out across the parent namespace AND every conversation
      // sub-namespace (session), k=50 each — the most complete memory read.
      const subs = await listSubspaces(Number(selId)).catch(() => []);
      const fc = await getFullContext(Number(selId), subs.map((s) => ({ key: s.ns_key, label: s.label })));
      const groups = fc.ok ? fc.groups.filter((g) => g.entries.length > 0) : [];
      const memory = groups.flatMap((g) => g.entries);
      // captured-info timeline — prefer the decentralized path:
      //   Sui cap → manifest blob (Walrus) → conversation blobs.
      // No SQLite needed. Falls back to the local cache only if the cap/manifest
      // isn't synced yet (run "Sync memory map on-chain" to populate it).
      let timeline: Ev[] = [];
      let timelineSource: "walrus" | "local" = "local";
      try {
        const capRes = await getCustomerCap(clientNamespace(Number(selId)));
        const blobId = capRes.ok ? capRes.cap?.memoryBlobId : null;
        if (blobId) {
          const manifest = await fetchManifest(blobId);
          if (Array.isArray(manifest.conversations) && manifest.conversations.length) {
            timeline = manifest.conversations
              .map((cv) => ({ at: cv.at || "", label: sourceLabel(cv.kind, cv.direction), text: (cv.label || "").trim(), blob_id: cv.blob_id }))
              .filter((e) => e.text)
              .sort((a, b) => (a.at < b.at ? 1 : -1));
            timelineSource = "walrus";
          }
        }
      } catch {
        /* manifest not synced / blob is a fingerprint → fall back below */
      }
      if (timeline.length === 0) {
        timeline = msgs
          .filter((m) => m.client_id === selId)
          .map((m) => ({ at: m.created_at, label: sourceLabel(m.kind, m.direction), text: (m.body || m.subject || "").trim(), blob_id: m.blob_id }))
          .filter((e) => e.text)
          .sort((a, b) => (a.at < b.at ? 1 : -1));
      }
      // synthesized full context
      let brief = "";
      try {
        const r = await fetch("/api/client-brief", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: fresh.name, relationship: fresh.relationship, role: fresh.role,
            deal_stage: fresh.deal_stage, profile: fresh.profile, objective: fresh.objective,
            notes: fresh.notes, phone: fresh.phone, email: fresh.email, memory,
          }),
        });
        const d = await r.json();
        brief = d.brief || "";
      } catch {
        /* brief optional */
      }
      // dated commitments ("I'll pay 30 January") — each tied to its captured record
      let commitments: Commit[] = [];
      try {
        const r = await fetch("/api/client-commitments", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ events: timeline.map((e) => ({ at: e.at, text: e.text })) }),
        });
        const d = await r.json();
        commitments = (Array.isArray(d.commitments) ? d.commitments : []).filter(
          (c: Commit) => Number.isInteger(c.source_index) && c.source_index >= 0 && c.source_index < timeline.length,
        );
      } catch {
        /* commitments optional */
      }
      setCtx({
        client: fresh, brief, timeline, commitments,
        groups: groups.map((g) => ({ label: g.label, entries: g.entries })),
        factCount: memory.length,
        timelineSource,
      });
    } catch {
      setCtx(null);
    }
    setResearching(false);
  }

  const field = (label: string, value?: string | null) =>
    value ? (
      <div className="tm-ctx-row">
        <span className="tm-ctx-k">{label}</span>
        <span className="tm-ctx-v">{value}</span>
      </div>
    ) : null;

  return (
    <aside className="tm">
      {/* ── Add ── */}
      <section className="tm-block">
        <h3 className="tm-h"><FiUserPlus /> Add to tribe</h3>
        <input className="tm-in" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
        <div className="tm-row2">
          <select className="tm-in" value={rel} onChange={(e) => setRel(e.target.value)}>
            {RELATIONSHIPS.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
          <input className="tm-in" placeholder="Phone (opt.)" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </div>
        <input className="tm-in" placeholder="Email (opt.)" value={email} onChange={(e) => setEmail(e.target.value)} />
        <button className="tm-btn primary" onClick={add} disabled={adding || !name.trim()}>
          {adding ? "Adding…" : "Add member"}
        </button>
        {addNote && <p className={`tm-note ${addNote.ok ? "ok" : "err"}`}>{addNote.ok ? <FiCheck /> : <FiAlertTriangle />} {addNote.text}</p>}
        {receipt && (
          <div className="tm-receipt">
            <div className="tm-rc-h">Push receipt</div>
            <div className="tm-rc-row"><span>Namespace</span><code>{receipt.customerId}</code></div>
            <div className="tm-rc-sec">⬡ Walrus</div>
            {receipt.walrus.profileBlobId && (
              <div className="tm-rc-row"><span>Profile (identity)</span>
                <a href={receipt.walrus.profileUrl!} target="_blank" rel="noreferrer"><code>{receipt.walrus.profileBlobId.slice(0, 14)}…</code></a>
              </div>
            )}
            <div className="tm-rc-row"><span>Manifest (index)</span>
              <a href={receipt.walrus.manifestUrl} target="_blank" rel="noreferrer"><code>{receipt.walrus.manifestBlobId.slice(0, 14)}…</code></a>
            </div>
            <div className="tm-rc-row"><span>Conversations</span><code>{receipt.walrus.conversationCount}</code></div>
            <div className="tm-rc-sec">🔗 Sui · {receipt.network}</div>
            <div className="tm-rc-row"><span>Package</span><code>{receipt.sui.packageId.slice(0, 12)}…</code></div>
            <div className="tm-rc-row"><span>Function</span><code>customer_memory::{receipt.sui.function}</code></div>
            <div className="tm-rc-row"><span>Cap object</span><code>{receipt.sui.capId ? receipt.sui.capId.slice(0, 12) + "…" : "—"}</code></div>
            <div className="tm-rc-row"><span>Tx</span>
              <a href={receipt.sui.explorer} target="_blank" rel="noreferrer"><code>{receipt.sui.txDigest.slice(0, 12)}…</code></a>
            </div>
          </div>
        )}
      </section>

      {/* ── Member picker (shared) ── */}
      <div className="tm-pick">
        <label className="tm-lbl">Member</label>
        <select className="tm-in" value={selId} onChange={(e) => { setSelId(e.target.value ? Number(e.target.value) : ""); setCtx(null); }}>
          <option value="">— pick a member —</option>
          {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </div>

      {/* ── Update by sentence ── */}
      <section className="tm-block">
        <h3 className="tm-h"><FiEdit3 /> Update member</h3>
        <p className="tm-hint">Plain language — e.g. <em>“client number is +99999”</em>, <em>“email is sam@acme.com”</em>, <em>“he&apos;s a friend from college”</em>.</p>
        <textarea className="tm-in" rows={2} placeholder="Say what to change…" value={instr} onChange={(e) => setInstr(e.target.value)} disabled={selId === ""} />
        <button className="tm-btn primary" onClick={applyUpdate} disabled={updating || selId === "" || !instr.trim()}>
          {updating ? "Applying…" : "Apply update"}
        </button>
        {updNote && <p className={`tm-note ${updNote.ok ? "ok" : "err"}`}>{updNote.ok ? <FiCheck /> : <FiAlertTriangle />} {updNote.text}</p>}
      </section>

      {/* ── Research / recall ── */}
      <section className="tm-block">
        <h3 className="tm-h"><FiSearch /> Client research</h3>
        <button className="tm-btn" onClick={research} disabled={selId === "" || researching}>
          {researching ? "Recalling…" : "Get full context"}
        </button>
        {ctx && (
          <div className="tm-ctx">
            <div className="tm-ctx-name">{ctx.client.name}</div>
            {field("Relationship", ctx.client.relationship)}
            {field("Phone", ctx.client.phone)}
            {field("Email", ctx.client.email)}
            {field("Role", ctx.client.role)}
            {field("Stage", ctx.client.deal_stage)}

            {ctx.brief && (
              <div className="tm-brief">
                <span className="tm-ctx-k">Full context</span>
                <p className="tm-brief-body">{ctx.brief}</p>
                {ctx.factCount > 0 && (
                  <span className="tm-brief-src">
                    synthesized from {ctx.factCount} memorie{ctx.factCount === 1 ? "" : "s"} across {ctx.groups.length} namespace{ctx.groups.length === 1 ? "" : "s"}
                  </span>
                )}
              </div>
            )}

            {ctx.commitments.length > 0 && (
              <div className="tm-commits">
                <span className="tm-ctx-k">Commitments &amp; dates</span>
                {ctx.commitments.map((c, i) => {
                  const src = ctx.timeline[c.source_index];
                  return (
                    <div key={i} className="tm-commit">
                      <div className="tm-commit-top">
                        <span className="tm-commit-what">{c.what}</span>
                        <span className="tm-commit-due">due {c.due_iso ? fmtDate(c.due_iso) : c.due}</span>
                      </div>
                      <div className="tm-commit-proof">
                        <span>stated {src ? `${src.label.toLowerCase()} · ${fmtDate(src.at)}` : "—"}</span>
                        {src?.blob_id ? (
                          <a className="tm-verify ok" href={`${WALRUS_AGG}/v1/blobs/${src.blob_id}`} target="_blank" rel="noreferrer">
                            <FiCheck /> verifiable on Walrus
                          </a>
                        ) : (
                          <span className="tm-verify pending">capture on record</span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            <div className="tm-ctx-mem">
              <span className="tm-ctx-k">
                Captured info
                <span className={`tm-src-badge ${ctx.timelineSource}`}>
                  {ctx.timelineSource === "walrus" ? "⬡ from Walrus" : "local cache"}
                </span>
              </span>
              {ctx.timeline.length === 0 ? (
                <span className="tm-muted">nothing captured yet</span>
              ) : (
                <ul className="tm-timeline">
                  {ctx.timeline.map((e, i) => (
                    <li key={i} className="tm-ev">
                      <div className="tm-ev-meta">
                        <span className="tm-ev-src">{e.label}</span>
                        <span className="tm-ev-date">
                          {fmtDate(e.at)}
                          {e.blob_id && (
                            <a className="tm-ev-verify" href={`${WALRUS_AGG}/v1/blobs/${e.blob_id}`} target="_blank" rel="noreferrer" title="Content-addressed on Walrus — tamper-evident proof of this record">
                              <FiCheck />
                            </a>
                          )}
                        </span>
                      </div>
                      <div className="tm-ev-text">{e.text}</div>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {ctx.groups.length > 0 && (
              <details className="tm-facts">
                <summary>Memory facts by namespace ({ctx.factCount})</summary>
                {ctx.groups.map((g, gi) => (
                  <div key={gi} className="tm-facts-group">
                    <div className="tm-facts-label">{g.label} <span className="tm-muted">· {g.entries.length}</span></div>
                    <ul>{g.entries.map((t, ti) => <li key={ti}>{t}</li>)}</ul>
                  </div>
                ))}
              </details>
            )}
          </div>
        )}
      </section>

      {/* ── Team access (employee grant/revoke, on-chain) ── */}
      <section className="tm-block">
        <h3 className="tm-h"><FiUserPlus /> Team access</h3>
        {!selected ? (
          <p className="tm-hint">Pick a member above.</p>
        ) : !accountId ? (
          <>
            <p className="tm-hint">No org account yet for {selected.name}. It may still be provisioning — or click below to provision / link one now.</p>
            <button className="tm-btn primary" onClick={provision} disabled={teamBusy}>
              {teamBusy ? "On-chain…" : "Provision / link account"}
            </button>
            {teamNote && <p className={`tm-note ${teamNote.ok ? "ok" : "err"}`}>{teamNote.ok ? <FiCheck /> : <FiAlertTriangle />} {teamNote.text}</p>}
          </>
        ) : (
          <>
            <div className="tm-pick"><label className="tm-lbl">Account</label><code className="tm-acct">{accountId.slice(0, 14)}…</code></div>
            <div className="tm-deleg-list">
              {delegates.length === 0 ? (
                <span className="tm-muted">no access keys on chain yet</span>
              ) : delegates.map((d) => (
                <div key={d.publicKeyHex} className="tm-deleg">
                  <span className="tm-deleg-info"><b>{d.label || "key"}</b> · <code>{d.suiAddress.slice(0, 10)}…</code></span>
                  {d.label === "Org App"
                    ? <span className="tm-muted">org app</span>
                    : <button className="tm-deleg-revoke" onClick={() => revoke(d.publicKeyHex)} disabled={teamBusy}>Revoke</button>}
                </div>
              ))}
            </div>
            <label className="tm-lbl">Grant an employee (their wallet public key)</label>
            <input className="tm-in" placeholder="public key (hex)" value={empPub} onChange={(e) => setEmpPub(e.target.value)} />
            <div className="tm-row2">
              <input className="tm-in" placeholder="label (e.g. Alice)" value={empLabel} onChange={(e) => setEmpLabel(e.target.value)} />
              <button className="tm-btn" onClick={genKey} type="button">Generate (demo)</button>
            </div>
            {empPriv && <p className="tm-hint">Demo key — give this to the employee once: <code>{empPriv.slice(0, 16)}…</code></p>}
            <button className="tm-btn primary" onClick={grant} disabled={teamBusy || !empPub.trim()}>
              {teamBusy ? "On-chain…" : "Grant access"}
            </button>
            {teamNote && <p className={`tm-note ${teamNote.ok ? "ok" : "err"}`}>{teamNote.ok ? <FiCheck /> : <FiAlertTriangle />} {teamNote.text}</p>}
          </>
        )}
      </section>
    </aside>
  );
}
