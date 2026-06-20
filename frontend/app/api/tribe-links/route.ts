// POST /api/tribe-links  { clients: [{id, name, profile?, notes?}] }
// Semantic connections for the Tribe Circle. For each customer we recall their
// MemWal memory, then ask the LLM to extract the key entities they're linked to
// (people, companies, places, topics). Two customers are connected when their
// memories reference the SAME entity — a "they know each other / share context"
// edge that exists in no structured field. Runs server-side because the MemWal
// relayer key lives here.
import { getMemWalForNamespace } from "@/lib/memwalClient";
import { clientNamespace, isAppNamespace } from "@/lib/clientNamespace";
import { llmGenerate } from "@/lib/llm";

export const dynamic = "force-dynamic";

type ClientIn = { id: number; name: string; profile?: string | null; notes?: string | null };

export async function POST(req: Request) {
  let clients: ClientIn[] = [];
  try {
    const b = await req.json();
    clients = Array.isArray(b.clients) ? b.clients.slice(0, 40) : [];
  } catch {
    return Response.json({ edges: [], entities: {} });
  }
  if (!clients.length) return Response.json({ edges: [], entities: {} });

  // 1) recall each customer's memory (best-effort) and build a per-customer corpus
  const corpus: { id: number; name: string; text: string }[] = [];
  await Promise.all(
    clients.map(async (c) => {
      let mem = "";
      try {
        const ns = clientNamespace(c.id);
        if (isAppNamespace(ns)) {
          const r = await (await getMemWalForNamespace(ns)).recall(
            "people, companies, places, products and topics this customer is connected to",
            8,
            ns,
          );
          mem = (r.results || []).map((m: { text: string }) => m.text).join(" | ");
        }
      } catch {
        /* recall optional */
      }
      const text = `${c.profile ?? ""} ${c.notes ?? ""} ${mem}`.trim();
      corpus.push({ id: c.id, name: c.name, text });
    }),
  );

  // 2) one LLM pass → key entities per customer (forced JSON for reliability)
  const prompt =
    "For each customer below, list up to 6 key ENTITIES they are linked to — named " +
    "people, companies, places, products, or strong topics/interests. Use short " +
    "canonical labels (e.g. \"Tesla\", \"Casablanca\", \"dividend ETFs\"). Ignore the " +
    "customer's own name. Return ONLY a JSON object mapping the numeric id to an " +
    "array of strings.\n\n" +
    corpus.map((c) => `#${c.id} ${c.name}: ${c.text.slice(0, 700) || "(no info yet)"}`).join("\n");

  const entities: Record<string, string[]> = {};
  try {
    const raw = await llmGenerate(prompt, { json: true, maxTokens: 1024 });
    const parsed = JSON.parse(raw || "{}");
    for (const k of Object.keys(parsed)) {
      const id = String(k).replace(/[^0-9]/g, "");
      if (id && Array.isArray(parsed[k])) entities[id] = parsed[k].map((x: unknown) => String(x));
    }
  } catch {
    /* LLM optional — return empty edges */
  }

  // 3) edges = customers that share at least one entity
  const norm = (s: string) => s.toLowerCase().trim();
  const ids = corpus.map((c) => c.id);
  const edges: { a: number; b: number; shared: string[] }[] = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const A = (entities[String(ids[i])] || []).map(norm).filter((x) => x.length >= 3);
      const Bset = new Set((entities[String(ids[j])] || []).map(norm));
      const shared = [...new Set(A.filter((x) => Bset.has(x)))];
      if (shared.length) edges.push({ a: ids[i], b: ids[j], shared });
    }
  }

  return Response.json({ edges, entities });
}
