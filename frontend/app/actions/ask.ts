"use server";

// Q&A + pre-call brief over a MemWal namespace (generic client space or a
// per-conversation sub-namespace): recall the most relevant memories, then
// synthesize with the local LLM (Ollama). Returns answer + source memories.
import { getMemWalForNamespace } from "@/lib/memwalClient";
import { clientNamespace, subNamespace, isAppNamespace } from "@/lib/clientNamespace";

const OLLAMA = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
const MODEL = process.env.OLLAMA_MODEL ?? "qwen2.5:7b";

async function ollama(system: string, user: string): Promise<string> {
  try {
    const res = await fetch(`${OLLAMA}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        stream: false,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    if (res.ok) {
      const j = (await res.json()) as { message?: { content?: string } };
      return (j.message?.content || "").trim();
    }
  } catch {
    /* optional */
  }
  return "";
}

export type AskAnswer =
  | { ok: true; answer: string; sources: string[] }
  | { ok: false; error: string };

export async function askNamespace(namespace: string, question: string): Promise<AskAnswer> {
  if (!isAppNamespace(namespace)) return { ok: false, error: "invalid namespace" };
  if (!question.trim()) return { ok: false, error: "empty question" };
  try {
    const memwal = await getMemWalForNamespace(namespace);
    const r = await memwal.recall(question, 8, namespace);
    const sources = (r.results || []).map((m: { text: string }) => m.text);
    if (sources.length === 0) {
      return { ok: true, answer: "No memory in this namespace yet.", sources: [] };
    }
    const system =
      "You answer questions about a sales customer using ONLY the provided memory bullets. "
      + "Be concise and specific. If the memory doesn't cover the question, say so plainly.";
    const user =
      `Customer memory:\n${sources.map((s) => `- ${s}`).join("\n")}\n\nQuestion: ${question}\nAnswer:`;
    const answer = (await ollama(system, user)) || "(LLM unavailable — here's the raw recalled memory.)";
    return { ok: true, answer, sources };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "ask failed" };
  }
}

export async function askCustomer(clientId: number, question: string): Promise<AskAnswer> {
  return askNamespace(clientNamespace(clientId), question);
}

export type BriefResult =
  | { ok: true; brief: string; count: number }
  | { ok: false; error: string };

export async function briefNamespace(namespace: string): Promise<BriefResult> {
  if (!isAppNamespace(namespace)) return { ok: false, error: "invalid namespace" };
  try {
    const memwal = await getMemWalForNamespace(namespace);
    const r = await memwal.recall(
      "background, role, priorities, open commitments, recent signals",
      10,
      namespace,
    );
    const mems = (r.results || []).map((m: { text: string }) => m.text);
    if (mems.length === 0) {
      return { ok: true, brief: "No prior memory — this looks like a first call.", count: 0 };
    }
    const system =
      "You write a tight pre-call brief for a sales rep. 2–3 sentences: what matters about "
      + "this customer, any open commitments, and the single best next move. No preamble.";
    const user = `Customer memory:\n${mems.map((s) => `- ${s}`).join("\n")}\n\nWrite the brief:`;
    const brief = (await ollama(system, user)) || mems.slice(0, 5).map((s) => `• ${s}`).join("\n");
    return { ok: true, brief, count: mems.length };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "brief failed" };
  }
}

export async function getPrecallBrief(clientId: number): Promise<BriefResult> {
  return briefNamespace(clientNamespace(clientId));
}

// Split an incoming message into durable profile facts (who the customer IS) vs
// message-specific notes (this conversation's asks / commitments / signals), so
// the caller can route generic → the client's generic namespace and specific →
// the per-conversation sub-namespace.
export type Classified = { generic: string[]; specific: string[] };

export async function classifyMemory(text: string): Promise<Classified> {
  const system =
    'You split a customer communication into two buckets and return STRICT JSON '
    + '{"generic":[],"specific":[]}. '
    + "GENERIC = durable facts about WHO the customer is (company, industry, size, role, "
    + "location, tech stack, stable preferences) — true across conversations. "
    + "SPECIFIC = tied to THIS message: requests, commitments, deadlines/dates, mood, "
    + "objections, next steps. Each item is one concise sentence. Drop greetings/filler. "
    + "JSON only.";
  const user = `Message:\n${text}\n\nReturn {"generic":[...],"specific":[...]}`;
  const out = await ollama(system, user);
  try {
    const s = out.indexOf("{");
    const e = out.lastIndexOf("}");
    if (s < 0 || e < 0) return { generic: [], specific: [] };
    const o = JSON.parse(out.slice(s, e + 1)) as { generic?: unknown; specific?: unknown };
    const arr = (v: unknown) =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0) : [];
    return { generic: arr(o.generic), specific: arr(o.specific) };
  } catch {
    return { generic: [], specific: [] };
  }
}

// Full context: fan-out recall across the customer's generic namespace AND every
// per-conversation sub-namespace, returning all stored memories grouped.
export type ContextGroup = { label: string; namespace: string; entries: string[] };
export type FullContextResult =
  | { ok: true; groups: ContextGroup[]; total: number }
  | { ok: false; error: string };

const FULL_QUERY =
  "all facts, preferences, commitments, signals, history and sentiment about this customer";

export async function getFullContext(
  clientId: number,
  subs: { key: string; label: string }[],
): Promise<FullContextResult> {
  try {
    const memwal = await getMemWalForNamespace(clientNamespace(clientId));
    const targets = [
      { label: "Generic profile", namespace: clientNamespace(clientId) },
      ...subs.map((s) => ({ label: s.label, namespace: subNamespace(clientId, s.key) })),
    ];
    const groups: ContextGroup[] = [];
    let total = 0;
    for (const t of targets) {
      if (!isAppNamespace(t.namespace)) continue;
      try {
        const r = await memwal.recall(FULL_QUERY, 50, t.namespace);
        const entries = (r.results || []).map((m: { text: string }) => m.text);
        groups.push({ label: t.label, namespace: t.namespace, entries });
        total += entries.length;
      } catch {
        groups.push({ label: t.label, namespace: t.namespace, entries: [] });
      }
    }
    return { ok: true, groups, total };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "context failed" };
  }
}
