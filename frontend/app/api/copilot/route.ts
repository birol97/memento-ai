// POST /api/copilot  { clientId, prompt }
// Streams an AI suggestion (token by token) for a rep's draft/instruction,
// grounded in the customer's recalled MemWal memory. Recall happens server-side
// (shared relayer key), then Ollama is proxied with stream:true and its NDJSON
// is re-emitted as plain text chunks the browser reads incrementally.
import { getMemWalForNamespace } from "@/lib/memwalClient";
import { clientNamespace, isAppNamespace } from "@/lib/clientNamespace";
import { llmStream } from "@/lib/llm";

export const dynamic = "force-dynamic";

type Turn = { role: "user" | "assistant"; content: string };

export async function POST(req: Request) {
  let clientId: number;
  let messages: Turn[];
  let context = ""; // authoritative profile text for THIS customer
  let persona = ""; // the AI character + tool policy chosen by the user
  let knowledge = ""; // the rep's own knowledge base / playbook
  try {
    const b = await req.json();
    clientId = Number(b.clientId);
    context = typeof b.context === "string" ? b.context.slice(0, 6000) : "";
    persona = typeof b.persona === "string" ? b.persona.slice(0, 2000) : "";
    knowledge = typeof b.knowledge === "string" ? b.knowledge.slice(0, 4000) : "";
    messages = Array.isArray(b.messages)
      ? b.messages
          .filter((m: Turn) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
          .slice(-20) // cap history sent to the model
      : [];
  } catch {
    return new Response("bad json", { status: 400 });
  }
  const namespace = clientNamespace(clientId);
  const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content?.trim() ?? "";
  if (!isAppNamespace(namespace) || !lastUser) return new Response("bad request", { status: 400 });

  // 1. recall grounding memory for the latest question (best-effort)
  let sources: string[] = [];
  try {
    const r = await (await getMemWalForNamespace(namespace)).recall(lastUser, 8, namespace);
    sources = (r.results || []).map((m: { text: string }) => m.text);
  } catch {
    /* recall optional */
  }

  const system =
    (persona ? persona + "\n\n" : "")
    + "You are a copilot helping a rep talk to ONE specific customer. This is an ongoing "
    + "conversation with the rep — use the prior turns for context.\n\n"
    + "RULES:\n"
    + "- Stay within the tools you may use (above). Don't offer to do things via disabled tools.\n"
    + "- Anchor everything to THIS customer using the PROFILE and MEMORY below. Use their real name "
    + "and their actual numbers, goals, holdings, and preferences. Never address a different person.\n"
    + "- Recommendations must be grounded: for each one, briefly cite the profile fact it's based on "
    + "(e.g. \"because you prefer dividend stocks\"). Respect what they avoid.\n"
    + "- Prefer naming an asset CATEGORY (e.g. \"a low-cost dividend ETF\", \"a broad index fund\") "
    + "rather than a specific ticker. Only name a specific security/price if it appears in the "
    + "PROFILE/MEMORY; if you name one from your own knowledge, append \"(verify)\". Never invent "
    + "current prices, yields, or fees — say they should be checked.\n"
    + "- NEVER output bracketed placeholders like [Name], [topic], [stock], [link]. Fill them in from "
    + "the profile, or ask for the missing fact. Do not invent facts or promises.\n"
    + "- Be concise and ready-to-send.\n\n"
    + `CUSTOMER PROFILE (authoritative — includes the objective of this relationship):\n${context || "(none provided — ask the rep for details)"}\n\n`
    + (knowledge ? `YOUR KNOWLEDGE BASE (the rep's own playbook — prefer this for product facts, pitches, policies):\n${knowledge}\n\n` : "")
    + `CUSTOMER MEMORY (recalled, may be partial):\n${sources.length ? sources.map((s) => `- ${s}`).join("\n") : "(none yet)"}`;

  // 2. stream the answer from Claude (if keyed) or local Ollama
  const stream = llmStream(system, messages, { maxTokens: 1500 });

  return new Response(stream, {
    headers: { "Content-Type": "text/plain; charset=utf-8", "X-Sources-Count": String(sources.length) },
  });
}
