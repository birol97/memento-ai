// POST /api/client-extract  { text }  ->  { patch, summary }
// Turn a plain-language instruction ("client number is +99999", "her email is
// a@b.com", "he's a friend from college") into a structured CRM patch the Tribe
// "update member" box can apply via updateClient. LLM-first (Ollama, forced JSON)
// with a deterministic phone/email fallback so it still works if the model misses.
import { llmGenerate } from "@/lib/llm";

export const dynamic = "force-dynamic";

const FIELDS = ["name", "phone", "email", "notes", "role", "deal_stage", "profile", "objective", "relationship"] as const;
type Field = (typeof FIELDS)[number];

export async function POST(req: Request) {
  let text = "";
  try {
    const b = await req.json();
    text = typeof b.text === "string" ? b.text : "";
  } catch {
    return Response.json({ patch: {}, summary: "" });
  }
  if (!text.trim()) return Response.json({ patch: {}, summary: "" });

  const patch: Partial<Record<Field, string>> = {};

  // 1) LLM extraction (forced JSON)
  try {
    const prompt =
      "You update a CRM contact from one short instruction. Allowed fields: " +
      FIELDS.join(", ") +
      ".\nRules: include ONLY fields the instruction clearly sets. A phone/number → \"phone\". " +
      "An email address → \"email\". The person's name → \"name\". How they relate to me " +
      "(friend, colleague, customer, family, expert) → \"relationship\". A description of who " +
      "they are → \"profile\". What I want from them → \"objective\". Misc remarks → \"notes\". " +
      "Return ONLY a JSON object mapping field to a string value.\nInstruction: " +
      text;
    const raw = await llmGenerate(prompt, { json: true, maxTokens: 400 });
    const parsed = JSON.parse(raw || "{}");
    for (const k of FIELDS) {
      const v = parsed[k];
      if (typeof v === "string" && v.trim()) patch[k] = v.trim();
    }
  } catch {
    /* model optional — fall through to regex */
  }

  // 2) deterministic safety net for the two highest-value fields
  if (!patch.email) {
    const m = text.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
    if (m) patch.email = m[0];
  }
  if (!patch.phone && /(number|phone|tel|call|cell|mobile|num\b|whatsapp)/i.test(text)) {
    const m = text.match(/\+?\d[\d\s().-]{4,}\d/);
    if (m) patch.phone = m[0].replace(/[^\d+]/g, "");
  }

  const summary = Object.entries(patch)
    .map(([k, v]) => `${k} → ${v}`)
    .join(" · ");
  return Response.json({ patch, summary });
}
