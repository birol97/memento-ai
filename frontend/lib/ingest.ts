// Shared channel-ingestion core. Any provider adapter (generic /api/ingest,
// Twilio, email inbound-parse, Slack events) normalizes its payload into
// `IngestInput` and calls `ingestMessage`. The pipeline:
//   resolve customer → LLM split (generic vs specific) → bulk write to Walrus
//   (generic→generic namespace, specific+raw→per-conversation sub) → anchor on Sui.
import { searchClients, createSubspace } from "@/lib/api";
import { bulkRemember } from "@/app/actions/memory";
import { anchorMemory } from "@/app/actions/onchain";
import { classifyMemory } from "@/app/actions/ask";
import { clientNamespace, subNamespace } from "@/lib/clientNamespace";

export type IngestInput = {
  channel: string;
  text: string;
  from?: string;
  clientId?: number | null;
  threadId?: string;
};

export type IngestResult =
  | {
      ok: true;
      clientId: number;
      genericNs: string;
      subNs: string;
      subLabel: string;
      genericCount: number;
      specificCount: number;
      saved: number;
      anchorDigest?: string;
    }
  | { ok: false; error: string; status: number };

export async function resolveClientId(from: string): Promise<number | null> {
  if (!from) return null;
  try {
    const matches = await searchClients(from);
    const f = from.toLowerCase();
    const fp = from.replace(/\s/g, "");
    const m = matches.find(
      (c) =>
        (c.email || "").toLowerCase() === f ||
        (c.phone || "").replace(/\s/g, "") === fp,
    );
    return m ? m.id : null;
  } catch {
    return null;
  }
}

export async function ingestMessage(input: IngestInput): Promise<IngestResult> {
  const channel = (input.channel || "channel").trim();
  const from = (input.from || "").trim();
  const text = (input.text || "").trim();
  const threadId = (input.threadId || "").trim();

  if (!text) return { ok: false, error: "empty text", status: 400 };

  let clientId = typeof input.clientId === "number" ? input.clientId : null;
  if (clientId == null) {
    if (!from) return { ok: false, error: "need clientId or from", status: 400 };
    clientId = await resolveClientId(from);
  }
  if (clientId == null) {
    return { ok: false, error: `unresolved customer: ${from}`, status: 404 };
  }

  const stamp = new Date().toISOString().slice(0, 10);
  const genNs = clientNamespace(clientId);

  // Per-conversation sub-namespace for this message.
  const subLabel = (threadId || `${channel} · ${stamp}${from ? ` · ${from}` : ""}`).slice(0, 60);
  let subNs = genNs;
  try {
    const sub = await createSubspace(clientId, subLabel);
    subNs = subNamespace(clientId, sub.ns_key);
  } catch {
    /* registry down — fall back to generic */
  }

  // LLM splits durable profile facts vs this-message specifics.
  const { generic, specific } = await classifyMemory(text);

  const tagged = `[${channel} · ${stamp}${from ? ` · ${from}` : ""}] ${text}`;
  const items = [
    { text: tagged, namespace: subNs },
    ...specific.map((s) => ({ text: `[${channel} · ${stamp}] ${s}`, namespace: subNs })),
    ...generic.map((g) => ({ text: `[profile] ${g}`, namespace: genNs })),
  ];

  const b = await bulkRemember(items);
  if (!b.ok) return { ok: false, error: b.error, status: 502 };

  let anchorDigest: string | undefined;
  try {
    const a = await anchorMemory(genNs, tagged);
    if (a.ok) anchorDigest = a.digest;
  } catch {
    /* anchor is best-effort */
  }

  let print = {
    ok: true,
    clientId,
    genericNs: genNs,
    subNs,
    subLabel,
    genericCount: generic.length,
    specificCount: specific.length,
    saved: b.saved,
    anchorDigest,
  };
 console.log(print)
  return {
    ok: true,
    clientId,
    genericNs: genNs,
    subNs,
    subLabel,
    genericCount: generic.length,
    specificCount: specific.length,
    saved: b.saved,
    anchorDigest,
  };
}
