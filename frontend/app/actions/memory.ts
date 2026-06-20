"use server";

// MemWal-backed memory, namespace-addressed. A client's generic namespace is
// salescall-client-<id>; per-conversation sub-namespaces are
// salescall-client-<id>__<key>. recall() grounds the copilot; analyzeAndWait()
// extracts + stores facts; recordMood() stores a sentiment line. Key stays server-side.
import { getMemWalForNamespace } from "@/lib/memwalClient";
import { clientNamespace, isAppNamespace } from "@/lib/clientNamespace";

export type RecallResult =
  | { ok: true; entries: string[]; block: string | null }
  | { ok: false; error: string };

const RECALL_PROMPT =
  "key facts, preferences, open commitments, and recent signals about this customer";

export async function recallNamespace(namespace: string, query?: string): Promise<RecallResult> {
  if (!isAppNamespace(namespace)) return { ok: false, error: "invalid namespace" };
  try {
    const memwal = await getMemWalForNamespace(namespace);
    const res = await memwal.recall(query?.trim() || RECALL_PROMPT, 10, namespace);
    const entries = (res.results || []).map((r: { text: string }) => r.text);
    const block = entries.length
      ? "# Customer memory (recalled from Walrus Memory)\n"
        + entries.map((t) => `- ${t}`).join("\n")
      : null;
    return { ok: true, entries, block };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "recall failed" };
  }
}

export async function recallClientMemory(clientId: number, query?: string): Promise<RecallResult> {
  return recallNamespace(clientNamespace(clientId), query);
}

export type WriteResult =
  | { ok: true; saved: number; failed: number; total: number }
  | { ok: false; error: string };

export async function writeNamespace(namespace: string, transcript: string): Promise<WriteResult> {
  if (!isAppNamespace(namespace)) return { ok: false, error: "invalid namespace" };
  if (!transcript.trim()) return { ok: false, error: "empty transcript" };
  try {
    const memwal = await getMemWalForNamespace(namespace);
    const res = await memwal.analyzeAndWait(transcript, namespace);
    return { ok: true, saved: res.succeeded, failed: res.failed, total: res.total };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "write failed" };
  }
}

export async function writeClientMemory(clientId: number, transcript: string): Promise<WriteResult> {
  return writeNamespace(clientNamespace(clientId), transcript);
}

// Store text verbatim (remember, not analyze) so channel content is never lost
// even when fact-extraction yields nothing.
export type RawResult = { ok: true } | { ok: false; error: string };
export async function rememberRaw(namespace: string, text: string): Promise<RawResult> {
  if (!isAppNamespace(namespace)) return { ok: false, error: "invalid namespace" };
  if (!text.trim()) return { ok: false, error: "empty text" };
  // retry transient relayer errors (401/5xx) so a note reliably lands in memory
  let lastErr = "remember failed";
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const memwal = await getMemWalForNamespace(namespace);
      await memwal.rememberAndWait(text, namespace);
      return { ok: true };
    } catch (e) {
      lastErr = e instanceof Error ? e.message : "remember failed";
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  return { ok: false, error: lastErr };
}

// Store many memories in ONE call, each routed to its own namespace (generic vs
// per-conversation sub). Reliable `remember` path (not analyze).
export type BulkItem = { text: string; namespace: string };
export type BulkResult = { ok: true; saved: number; failed: number } | { ok: false; error: string };

export async function bulkRemember(items: BulkItem[]): Promise<BulkResult> {
  const valid = items
    .filter((i) => i.text.trim() && isAppNamespace(i.namespace))
    .slice(0, 20); // MemWal rememberBulk caps at 20 per call
  if (valid.length === 0) return { ok: false, error: "no valid items" };
  try {
    const memwal = await getMemWalForNamespace(valid[0].namespace);
    const res = await memwal.rememberBulkAndWait(
      valid.map((i) => ({ text: i.text, namespace: i.namespace })),
    );
    return { ok: true, saved: res.succeeded, failed: res.failed };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "bulk remember failed" };
  }
}

// ── post-conversation mood/sentiment ratings (1–5) ──
export type MoodRatings = {
  agreeability?: number;
  mood?: number;
  positivity?: number;
  buyingIntent?: number;
};

export type MoodResult = { ok: true; text: string } | { ok: false; error: string };

export async function recordMood(
  namespace: string,
  ratings: MoodRatings,
  note?: string,
): Promise<MoodResult> {
  if (!isAppNamespace(namespace)) return { ok: false, error: "invalid namespace" };
  const dims: [string, number | undefined][] = [
    ["Agreeability", ratings.agreeability],
    ["Mood", ratings.mood],
    ["Positivity", ratings.positivity],
    ["Buying intent", ratings.buyingIntent],
  ];
  const parts = dims
    .filter(([, v]) => typeof v === "number")
    .map(([k, v]) => `${k} ${v}/5`);
  if (parts.length === 0) return { ok: false, error: "no ratings selected" };
  const text =
    `Call sentiment — ${parts.join("; ")}`
    + (note?.trim() ? `. Note: ${note.trim()}` : "")
    + ".";
  try {
    const memwal = await getMemWalForNamespace(namespace);
    // remember (not analyze) — store the exact sentiment line verbatim.
    await memwal.rememberAndWait(text, namespace);
    return { ok: true, text };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "mood save failed" };
  }
}
