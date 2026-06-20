"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import { listSessionsForClient, updateClient } from "@/lib/api";
import type { Client, SessionRow } from "@/lib/types";

interface Props {
  client: Client;
  /** When true, the panel collapses to a thin one-line context strip (used while live). */
  compact?: boolean;
  /** Bubble client-edit changes up so the parent can keep its picker in sync. */
  onClientUpdated?: (client: Client) => void;
}

interface Stats {
  totalCalls: number;
  endedCalls: number;
  totalMinutes: number;
  lastCallAt: Date | null;
}

function computeStats(sessions: SessionRow[]): Stats {
  let endedCalls = 0;
  let totalMinutes = 0;
  let lastCallAt: Date | null = null;
  for (const s of sessions) {
    if (lastCallAt === null || new Date(s.started_at) > lastCallAt) {
      lastCallAt = new Date(s.started_at);
    }
    if (s.ended_at) {
      endedCalls += 1;
      const dur = (new Date(s.ended_at).getTime() - new Date(s.started_at).getTime()) / 60000;
      if (dur > 0) totalMinutes += dur;
    }
  }
  return { totalCalls: sessions.length, endedCalls, totalMinutes, lastCallAt };
}

function relTimeFrom(date: Date): string {
  const sec = (Date.now() - date.getTime()) / 1000;
  if (sec < 60) return "just now";
  const min = sec / 60;
  if (min < 60) return `${Math.round(min)}m ago`;
  const hr = min / 60;
  if (hr < 24) return `${Math.round(hr)}h ago`;
  const day = hr / 24;
  if (day < 7) return `${Math.round(day)}d ago`;
  if (day < 30) return `${Math.round(day / 7)}w ago`;
  if (day < 365) return `${Math.round(day / 30)}mo ago`;
  return `${Math.round(day / 365)}y ago`;
}

function fmtAbs(date: Date): string {
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
    " · " + date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

export function ClientKnowledge({ client, compact = false, onClientUpdated }: Props) {
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingNotes, setEditingNotes] = useState(false);
  const [notesDraft, setNotesDraft] = useState(client.notes ?? "");
  const [savingNotes, setSavingNotes] = useState(false);

  const [editingBrief, setEditingBrief] = useState(false);
  const [profileDraft, setProfileDraft] = useState(client.profile ?? "");
  const [objectiveDraft, setObjectiveDraft] = useState(client.objective ?? "");
  const [savingBrief, setSavingBrief] = useState(false);

  useEffect(() => {
    setNotesDraft(client.notes ?? "");
    setProfileDraft(client.profile ?? "");
    setObjectiveDraft(client.objective ?? "");
  }, [client.id, client.notes, client.profile, client.objective]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    listSessionsForClient(client.id)
      .then((rows) => {
        if (!cancelled) setSessions(rows);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client.id]);

  const stats = useMemo(() => computeStats(sessions), [sessions]);
  const recent = sessions.slice(0, 3);

  const saveNotes = useCallback(async () => {
    setSavingNotes(true);
    setError(null);
    try {
      const updated = await updateClient(client.id, { notes: notesDraft });
      onClientUpdated?.(updated);
      setEditingNotes(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingNotes(false);
    }
  }, [client.id, notesDraft, onClientUpdated]);

  const saveBrief = useCallback(async () => {
    setSavingBrief(true);
    setError(null);
    try {
      const updated = await updateClient(client.id, {
        profile: profileDraft,
        objective: objectiveDraft,
      });
      onClientUpdated?.(updated);
      setEditingBrief(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingBrief(false);
    }
  }, [client.id, profileDraft, objectiveDraft, onClientUpdated]);

  // ─── Compact mode (live recording) ──────────────────────────────────────
  if (compact) {
    const callsPart =
      stats.totalCalls === 0
        ? "first call"
        : `${stats.totalCalls} prior call${stats.totalCalls === 1 ? "" : "s"} in context`;
    const lastPart = stats.lastCallAt ? ` · last ${relTimeFrom(stats.lastCallAt)}` : "";
    return (
      <div className="ck-strip">
        <span className="ck-strip-icon" aria-hidden="true">●</span>
        <strong>{client.name}</strong>
        <span className="ck-strip-meta">{callsPart}{lastPart}</span>
      </div>
    );
  }

  // ─── Full panel ─────────────────────────────────────────────────────────
  return (
    <div className="ck-panel">
      <div className="ck-header">
        <div className="ck-title">
          <h2>{client.name}</h2>
          <div className="ck-contact">
            {client.phone && <span>{client.phone}</span>}
            {client.email && <span>{client.email}</span>}
          </div>
        </div>
        <Link href={`/sessions`} className="ck-link">All clients →</Link>
      </div>

      <div className="ck-stats">
        <div className="ck-stat">
          <div className="ck-stat-label">Calls</div>
          <div className="ck-stat-value">{stats.totalCalls}</div>
        </div>
        <div className="ck-stat">
          <div className="ck-stat-label">Total time</div>
          <div className="ck-stat-value">
            {stats.totalMinutes >= 1
              ? `${stats.totalMinutes.toFixed(0)}m`
              : "—"}
          </div>
        </div>
        <div className="ck-stat">
          <div className="ck-stat-label">Last call</div>
          <div className="ck-stat-value">
            {stats.lastCallAt ? relTimeFrom(stats.lastCallAt) : "never"}
          </div>
        </div>
      </div>

      <div className="ck-notes">
        <div className="ck-notes-head">
          <span className="ck-notes-title">Briefing for the AI</span>
          {!editingBrief && (
            <button
              type="button"
              className="ck-link-btn"
              onClick={() => setEditingBrief(true)}
            >
              {client.profile || client.objective ? "Edit" : "Add"}
            </button>
          )}
        </div>
        {editingBrief ? (
          <div className="ck-notes-edit">
            <label className="ck-field-label">
              Who they are
              <textarea
                value={profileDraft}
                onChange={(e) => setProfileDraft(e.target.value)}
                placeholder="Industry, role context, what they do, what they care about…"
                rows={3}
              />
            </label>
            <label className="ck-field-label">
              Our objective
              <textarea
                value={objectiveDraft}
                onChange={(e) => setObjectiveDraft(e.target.value)}
                placeholder="What we want out of conversations with them — qualify, close, support, gather feedback…"
                rows={2}
              />
            </label>
            <div className="ck-notes-actions">
              <button
                type="button"
                className="btn-ghost"
                onClick={() => {
                  setEditingBrief(false);
                  setProfileDraft(client.profile ?? "");
                  setObjectiveDraft(client.objective ?? "");
                }}
                disabled={savingBrief}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn-primary"
                onClick={saveBrief}
                disabled={savingBrief}
              >
                {savingBrief ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        ) : client.profile || client.objective ? (
          <div className="ck-brief-readonly">
            {client.profile && (
              <p>
                <strong>Who:</strong> {client.profile}
              </p>
            )}
            {client.objective && (
              <p>
                <strong>Aim:</strong> {client.objective}
              </p>
            )}
          </div>
        ) : (
          <p className="ck-notes-empty">
            No briefing yet — add who they are and what we want out of the call,
            and the AI will use it.
          </p>
        )}
      </div>

      <div className="ck-notes">
        <div className="ck-notes-head">
          <span className="ck-notes-title">Notes</span>
          {!editingNotes && (
            <button
              type="button"
              className="ck-link-btn"
              onClick={() => setEditingNotes(true)}
            >
              {client.notes ? "Edit" : "Add"}
            </button>
          )}
        </div>
        {editingNotes ? (
          <div className="ck-notes-edit">
            <textarea
              value={notesDraft}
              onChange={(e) => setNotesDraft(e.target.value)}
              placeholder="Anything worth remembering for next time…"
              rows={3}
            />
            <div className="ck-notes-actions">
              <button
                type="button"
                className="btn-ghost"
                onClick={() => {
                  setEditingNotes(false);
                  setNotesDraft(client.notes ?? "");
                }}
                disabled={savingNotes}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn-primary"
                onClick={saveNotes}
                disabled={savingNotes}
              >
                {savingNotes ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        ) : client.notes ? (
          <p className="ck-notes-body">{client.notes}</p>
        ) : (
          <p className="ck-notes-empty">No notes yet.</p>
        )}
      </div>

      <div className="ck-history">
        <div className="ck-history-head">
          <span className="ck-history-title">Recent calls</span>
          {sessions.length > 3 && (
            <Link href="/sessions" className="ck-link">
              See all {sessions.length} →
            </Link>
          )}
        </div>
        {loading && <p className="ck-empty">Loading…</p>}
        {!loading && sessions.length === 0 && (
          <p className="ck-empty">
            No calls yet — this will be your first conversation with {client.name}.
          </p>
        )}
        {error && <div className="error">{error}</div>}

        <ul className="ck-session-list">
          {recent.map((s) => {
            const started = new Date(s.started_at);
            const dur = s.ended_at
              ? (new Date(s.ended_at).getTime() - started.getTime()) / 60000
              : null;
            return (
              <li key={s.id}>
                <Link href={`/sessions/${s.id}`} className="ck-session">
                  <div className="ck-session-head">
                    <span className="ck-session-when">{fmtAbs(started)}</span>
                    {dur !== null && (
                      <span className="ck-session-dur">{dur.toFixed(0)}m</span>
                    )}
                    {!s.ended_at && (
                      <span className="ck-session-tag">in progress</span>
                    )}
                  </div>
                  <div className="ck-session-summary">
                    {s.summary
                      ? s.summary
                      : s.ended_at
                        ? <em>(no summary)</em>
                        : <em>(call did not end cleanly)</em>}
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
