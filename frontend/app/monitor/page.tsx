"use client";

// Commitments Monitor — the multi-agent pipeline UI.
// Run pipeline → Scanner finds due commitments, Drafter drafts reminders (both
// hand off via Walrus blobs), then you (the Actioner) approve sends. State lives
// on Walrus, so re-running dedupes and it survives restarts.
import { useState } from "react";
import { FiSearch, FiEdit3, FiSend, FiDatabase, FiCheck, FiX } from "react-icons/fi";

import { runMonitor, actionDraft } from "@/app/actions/agents";
import type { PipelineResult, Draft } from "@/lib/agents/pipeline";

const WALRUS_AGG = process.env.NEXT_PUBLIC_WALRUS_AGGREGATOR ?? "https://aggregator.walrus-testnet.walrus.space";
const blobUrl = (id: string) => `${WALRUS_AGG}/v1/blobs/${id}`;
const fmt = (iso: string) => { try { return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }); } catch { return iso; } };

export default function MonitorPage() {
  const [days, setDays] = useState(7);
  const [running, setRunning] = useState(false);
  const [res, setRes] = useState<PipelineResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [done, setDone] = useState<Record<string, string>>({}); // key → "sent via X" | "dismissed"
  const [busyKey, setBusyKey] = useState<string | null>(null);

  async function run() {
    setRunning(true); setErr(null);
    const r = await runMonitor(days);
    if (r.ok) { setRes(r.result); setDrafts(r.result.drafts); setDone({}); }
    else setErr(r.error);
    setRunning(false);
  }
  async function approve(d: Draft) {
    setBusyKey(d.key);
    const r = await actionDraft(d);
    setDone((p) => ({ ...p, [d.key]: r.ok ? `sent via ${r.channel}` : `failed: ${r.error}` }));
    setBusyKey(null);
  }
  function dismiss(d: Draft) { setDone((p) => ({ ...p, [d.key]: "dismissed" })); }

  return (
    <main className="container">
      <header>
        <h1>Commitments Monitor</h1>
        <p className="sub">A long-running, multi-agent pipeline. Scanner → Drafter coordinate through Walrus; you approve the sends. State persists on Walrus, so it resumes after any restart.</p>
      </header>

      <div className="mon-bar">
        <label className="mon-days">Due within
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            <option value={3}>3 days</option><option value={7}>7 days</option><option value={14}>14 days</option><option value={365}>1 year</option>
          </select>
        </label>
        <button className="tm-btn primary" onClick={run} disabled={running}>{running ? "Running pipeline…" : "Run pipeline"}</button>
      </div>
      {err && <p className="tm-note err"><FiX /> {err}</p>}

      {res && (
        <>
          {/* the cross-agent Walrus handoff trail */}
          <div className="mon-trail">
            <div className="mon-stage"><span className="mon-ag"><FiSearch /> Scanner</span><span>scanned {res.scanned} customers · {res.findings.length} due</span><a href={blobUrl(res.findingsBlobId)} target="_blank" rel="noreferrer">findings ⬡</a></div>
            <div className="mon-arrow">→ Walrus →</div>
            <div className="mon-stage"><span className="mon-ag"><FiEdit3 /> Drafter</span><span>{res.drafts.length} reminders drafted</span><a href={blobUrl(res.draftsBlobId)} target="_blank" rel="noreferrer">drafts ⬡</a></div>
            <div className="mon-arrow">→ Walrus →</div>
            <div className="mon-stage"><span className="mon-ag"><FiDatabase /> State</span><span>resumable</span><a href={blobUrl(res.stateBlobId)} target="_blank" rel="noreferrer">state ⬡</a></div>
          </div>

          {/* Actioner review queue */}
          <h2 className="mon-h">Drafts to approve <span className="mon-count">{drafts.length}</span></h2>
          {drafts.length === 0 ? (
            <p className="empty">Nothing due in this window — or all due commitments already handled (state deduped them). Try a wider window.</p>
          ) : drafts.map((d) => (
            <div key={d.key} className="mon-draft">
              <div className="mon-draft-top">
                <span className="mon-draft-who">{d.clientName}</span>
                <span className="mon-draft-meta">{d.channel}{d.to ? ` · ${d.to}` : ""}</span>
              </div>
              <div className="mon-draft-why">{d.rationale}</div>
              {d.subject && <div className="mon-draft-subj">{d.subject}</div>}
              <div className="mon-draft-body">{d.body}</div>
              {done[d.key] ? (
                <div className={`mon-draft-done ${done[d.key].startsWith("failed") ? "err" : "ok"}`}>
                  {done[d.key].startsWith("failed") ? <FiX /> : <FiCheck />} {done[d.key]}
                </div>
              ) : (
                <div className="mon-draft-actions">
                  <button className="tm-btn primary" disabled={busyKey === d.key} onClick={() => approve(d)}><FiSend /> {busyKey === d.key ? "Sending…" : "Approve & send"}</button>
                  <button className="tm-btn" onClick={() => dismiss(d)}>Dismiss</button>
                </div>
              )}
            </div>
          ))}
        </>
      )}
    </main>
  );
}
