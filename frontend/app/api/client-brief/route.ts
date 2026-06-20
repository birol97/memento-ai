// POST /api/client-brief  { name, fields, memory }  ->  { brief }
// Synthesizes the "Client research / full context" into a clean, de-duplicated
// brief instead of dumping raw recalled memory lines. Grounds only in the data
// provided; ignores boilerplate (raw channel/phone strings) and contradictions.
import { llmGenerate } from "@/lib/llm";

export const dynamic = "force-dynamic";

type Body = {
  name?: string;
  relationship?: string | null;
  role?: string | null;
  deal_stage?: string | null;
  profile?: string | null;
  objective?: string | null;
  notes?: string | null;
  phone?: string | null;
  email?: string | null;
  memory?: string[];
};

export async function POST(req: Request) {
  let b: Body = {};
  try {
    b = await req.json();
  } catch {
    return Response.json({ brief: "" });
  }
  const name = b.name || "this person";
  const facts = [
    b.relationship && `relationship: ${b.relationship}`,
    b.role && `role: ${b.role}`,
    b.deal_stage && `stage: ${b.deal_stage}`,
    b.profile && `profile: ${b.profile}`,
    b.objective && `objective: ${b.objective}`,
    b.notes && `notes: ${b.notes}`,
  ].filter(Boolean).join("\n");
  const memory = (b.memory || []).filter((m) => typeof m === "string" && m.trim()).slice(0, 30);

  if (!facts && memory.length === 0) {
    return Response.json({ brief: "" });
  }

  const prompt =
    `Write a concise relationship brief about ${name} for the person who knows them.\n` +
    "Cover, in this order: (1) who they are, (2) what they want / their goal, " +
    "(3) key constraints or cautions, (4) the best way to approach them next.\n" +
    "Rules: ground ONLY in the data below; do not invent facts, numbers, or names. " +
    "De-duplicate repeated points. IGNORE boilerplate lines that are just contact/channel " +
    "strings (e.g. \"Reachable on — Phone: ...\", \"Channels — Phone: ...\"). If two lines " +
    "conflict, note the conflict briefly. Keep it to 4–6 short sentences or tight bullets. " +
    "Be direct and useful; no preamble.\n\n" +
    `STRUCTURED FACTS:\n${facts || "(none)"}\n\n` +
    `MEMORY (recalled, may be noisy/partial):\n${memory.length ? memory.map((m) => `- ${m}`).join("\n") : "(none)"}`;

  try {
    const brief = await llmGenerate(prompt, { maxTokens: 600 });
    return Response.json({ brief: brief.trim() });
  } catch (e) {
    return Response.json({ brief: "", error: e instanceof Error ? e.message : "brief failed" }, { status: 502 });
  }
}
