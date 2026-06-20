// Multi-agent commitments pipeline — agents coordinate THROUGH Walrus:
//
//   SCANNER ──findings blob──▶ DRAFTER ──drafts blob──▶ (Actioner = UI review)
//        │                                                      │
//        └──────────── shared monitor-state on Walrus ◀────────┘
//
// Each stage reads the previous stage's content-addressed blob (cross-agent
// memory sharing), and the run is resumable via the state pointer (long-running
// state over time). Draft-only: the Actioner (UI) sends with human approval.
import { searchClients, listMessages } from "@/lib/api";
import { clientNamespace } from "@/lib/clientNamespace";
import { getMemWalForNamespace } from "@/lib/memwalClient";
import { llmGenerate } from "@/lib/llm";
import { extractCommitments } from "@/lib/commitments";
import { putBlob, getBlob, loadState, saveState, type MonitorState } from "@/lib/agents/store";

export const MONITOR = "commitments-monitor";
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
const daysFromToday = (iso: string) => Math.round((Date.parse(iso + "T00:00:00Z") - Date.now()) / 86_400_000);

export type Finding = {
  key: string; clientId: number; clientName: string;
  what: string; due: string; due_iso: string; dueInDays: number;
  sourceBlobId: string | null; statedAt: string | null; statedVia: string | null;
};
export type Draft = {
  key: string; clientId: number; clientName: string;
  channel: "email" | "note"; to: string | null; subject: string | null; body: string; rationale: string;
};
export type PipelineResult = {
  scanned: number; dueWithinDays: number;
  findings: Finding[]; drafts: Draft[];
  findingsBlobId: string; draftsBlobId: string; stateBlobId: string;
  ranAt: string;
};

// ── SCANNER agent: find due, unhandled commitments across all customers ──
async function scan(dueWithinDays: number, state: MonitorState): Promise<{ findings: Finding[]; scanned: number }> {
  const clients = await searchClients();
  const handled = new Set(state.handled);
  const findings: Finding[] = [];

  for (const c of clients) {
    const msgs = await listMessages(c.id).catch(() => []);
    const events = msgs
      .map((m) => ({ at: m.created_at, text: (m.body || m.subject || "").trim(), kind: m.kind, blob: m.blob_id }))
      .filter((e) => e.text);
    if (!events.length) continue;
    const commitments = await extractCommitments(events.map((e) => ({ at: e.at, text: e.text })));
    for (const cm of commitments) {
      if (!cm.due_iso) continue;
      const key = `${c.id}|${norm(cm.what)}|${cm.due_iso}`;
      if (handled.has(key)) continue;
      const dueInDays = daysFromToday(cm.due_iso);
      if (dueInDays > dueWithinDays) continue; // not due yet (negative = overdue, still surfaced)
      const src = events[cm.source_index];
      findings.push({
        key, clientId: c.id, clientName: c.name,
        what: cm.what, due: cm.due, due_iso: cm.due_iso, dueInDays,
        sourceBlobId: src?.blob ?? null, statedAt: src?.at ?? null, statedVia: src?.kind ?? null,
      });
    }
  }
  return { findings, scanned: clients.length };
}

// ── DRAFTER agent: read findings, draft a grounded reminder per item ──
async function draftAll(findings: Finding[]): Promise<Draft[]> {
  const clients = await searchClients();
  const byId = new Map(clients.map((c) => [c.id, c]));
  const drafts: Draft[] = [];

  for (const f of findings) {
    const c = byId.get(f.clientId);
    if (!c) continue;
    let memory = "";
    try {
      const mem = await getMemWalForNamespace(clientNamespace(c.id));
      const r = await mem.recall(`${f.what} ${f.due}; background and preferences`, 6, clientNamespace(c.id));
      memory = (r.results || []).map((m: { text: string }) => m.text).join(" | ");
    } catch { /* recall optional */ }

    const channel: Draft["channel"] = c.email ? "email" : "note";
    const prompt =
      `Write a short, warm reminder ${channel === "email" ? "email" : "note"} to ${c.name} about an upcoming commitment.\n` +
      `Commitment: "${f.what}" due ${f.due_iso}.\n` +
      `Ground it in what we know (don't invent facts, no [placeholders]). Be concise and ready to send.\n\n` +
      `What we know about ${c.name}: ${memory || "(limited)"}\n\n` +
      (channel === "email" ? "Return just the email body." : "Return just the note text.");
    let body = "";
    try { body = await llmGenerate(prompt, { maxTokens: 350 }); } catch { /* fall back below */ }
    if (!body) body = `Hi ${c.name}, a quick reminder about "${f.what}" due ${f.due_iso}.`;

    drafts.push({
      key: f.key, clientId: c.id, clientName: c.name, channel,
      to: channel === "email" ? c.email ?? null : null,
      subject: channel === "email" ? `Reminder: ${f.what}` : null,
      body, rationale: `${f.what} due ${f.due_iso} (stated ${f.statedVia ?? "?"} ${f.statedAt?.slice(0, 10) ?? ""})`,
    });
  }
  return drafts;
}

// Write each detected commitment back into the customer's MemWal as a clean,
// searchable fact — so "who has a payment due?" works in recall/Tribe Search,
// not just the Monitor. Best-effort per item; awaited so it actually lands.
async function writeCommitmentFacts(findings: Finding[]): Promise<void> {
  for (const f of findings) {
    const ns = clientNamespace(f.clientId);
    const fact = `Commitment: ${f.what} — due ${f.due_iso}${f.statedAt ? ` (agreed ${f.statedAt.slice(0, 10)})` : ""}.`;
    // retry transient relayer errors (401/5xx) so the commitment reliably lands
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const mem = await getMemWalForNamespace(ns);
        await mem.rememberAndWait(fact, ns);
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      }
    }
  }
}

/** Run one full pipeline tick: scan → draft → persist artifacts + state to Walrus. */
export async function runMonitorPipeline(dueWithinDays = 7): Promise<PipelineResult> {
  const state = await loadState(MONITOR);
  const { findings, scanned } = await scan(dueWithinDays, state);
  await writeCommitmentFacts(findings); // make commitments searchable in MemWal
  const drafts = await draftAll(findings);
  const ranAt = new Date().toISOString();

  // each agent's output is a content-addressed Walrus blob (the handoff trail)
  const findingsBlobId = await putBlob({ kind: "agent-findings", agent: "scanner", ranAt, dueWithinDays, findings });
  const draftsBlobId = await putBlob({ kind: "agent-drafts", agent: "drafter", ranAt, findingsBlobId, drafts });

  // mark drafted keys handled so re-runs dedupe (resumable across restarts)
  const handled = Array.from(new Set([...state.handled, ...findings.map((f) => f.key)]));
  const stateBlobId = await saveState(MONITOR, { last_run: ranAt, handled });

  return { scanned, dueWithinDays, findings, drafts, findingsBlobId, draftsBlobId, stateBlobId, ranAt };
}

/** Read back the latest drafts artifact (for the Actioner UI). */
export async function getDraftsBlob(blobId: string) {
  return getBlob<{ drafts: Draft[] }>(blobId);
}
