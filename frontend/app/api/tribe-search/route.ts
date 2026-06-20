// POST /api/tribe-search  { question, members, recall }  ->  { answer, used }
// Google-like Q&A over the user's tribe. The client sends the members in scope
// (all, or one) as compact rows; if `recall` is on we also pull each member's
// MemWal memory (server-side key) for deeper "full context" answers. The LLM
// answers ONLY from this data and admits when a fact isn't recorded.
import { getMemWalForNamespace } from "@/lib/memwalClient";
import { clientNamespace, isAppNamespace } from "@/lib/clientNamespace";
import { llmGenerate } from "@/lib/llm";

export const dynamic = "force-dynamic";

const RECALL_CAP = 25; // bound MemWal recalls so "all tribe + recall" stays responsive

type Member = {
  id: number; name: string;
  relationship?: string | null; role?: string | null; deal_stage?: string | null;
  phone?: string | null; email?: string | null;
  profile?: string | null; objective?: string | null; notes?: string | null;
  created_at?: string | null; tags?: string[]; interactions?: number; last_contact?: string | null;
};

const clip = (s: string | null | undefined, n: number) => (s ? String(s).slice(0, n) : "");

export async function POST(req: Request) {
  let question = "";
  let members: Member[] = [];
  let recall = false;
  try {
    const b = await req.json();
    question = typeof b.question === "string" ? b.question : "";
    members = Array.isArray(b.members) ? b.members.slice(0, 200) : [];
    recall = !!b.recall;
  } catch {
    return Response.json({ answer: "", used: 0, error: "bad request" }, { status: 400 });
  }
  if (!question.trim()) return Response.json({ answer: "", used: 0 });
  if (!members.length) return Response.json({ answer: "Your tribe is empty — add a member first.", used: 0 });

  // optional: enrich with recalled MemWal memory
  const memById = new Map<number, string>();
  if (recall) {
    await Promise.all(
      members.slice(0, RECALL_CAP).map(async (m) => {
        try {
          const ns = clientNamespace(m.id);
          if (!isAppNamespace(ns)) return;
          const r = await (await getMemWalForNamespace(ns)).recall(question, 5, ns);
          const txt = (r.results || []).map((x: { text: string }) => x.text).join(" | ");
          if (txt) memById.set(m.id, txt);
        } catch {
          /* recall optional */
        }
      }),
    );
  }

  // Deterministic ordering the LLM can't get wrong: sort oldest-added first and
  // hand each member an explicit rank (1 = oldest) so date questions are exact.
  const ranked = [...members].sort((a, b) => String(a.created_at || "~").localeCompare(String(b.created_at || "~")));
  const rankById = new Map(ranked.map((m, i) => [m.id, i + 1]));

  const rows = ranked.map((m) => {
    const bits = [
      `#${m.id} ${m.name}`,
      `oldest-rank:${rankById.get(m.id)}`,
      m.relationship && `relationship:${m.relationship}`,
      m.role && `role:${m.role}`,
      m.deal_stage && `stage:${m.deal_stage}`,
      m.phone && `phone:${m.phone}`,
      m.email && `email:${m.email}`,
      m.created_at && `added:${String(m.created_at).slice(0, 10)}`,
      typeof m.interactions === "number" && `interactions:${m.interactions}`,
      m.last_contact && `lastContact:${String(m.last_contact).slice(0, 10)}`,
      m.tags?.length && `tags:${m.tags.join(",")}`,
    ].filter(Boolean).join(", ");
    const free = [
      m.profile && `profile: ${clip(m.profile, 280)}`,
      m.objective && `objective: ${clip(m.objective, 160)}`,
      m.notes && `notes: ${clip(m.notes, 200)}`,
      memById.get(m.id) && `memory: ${clip(memById.get(m.id), 360)}`,
    ].filter(Boolean).join(" ");
    return `- ${bits}.${free ? " " + free : ""}`;
  }).join("\n");

  const prompt =
    "You are a research assistant over the user's personal CRM, called their \"tribe\". " +
    "Answer the QUESTION using ONLY the MEMBER DATA below.\n" +
    "Rules:\n" +
    "- Be concise and direct; reference members by name.\n" +
    "- For rankings/lists return a short ordered list.\n" +
    "- The members are listed oldest-added first and each has 'oldest-rank' (1 = oldest in the tribe). " +
    "For \"oldest\" questions use oldest-rank directly (rank 1, 2, 3…); for \"newest\" use the highest ranks. " +
    "Only use age instead if an explicit age is stated.\n" +
    "- \"scheduled call/email\" or commitments: look in objective/notes/memory for any planned/agreed follow-up.\n" +
    "- If the data needed isn't recorded (e.g. nobody's net worth or age), say so plainly instead of inventing it — " +
    "but you MAY infer when profile/notes/memory clearly imply it (say it's an inference).\n\n" +
    "MEMBER DATA (" + members.length + " member" + (members.length === 1 ? "" : "s") + "):\n" +
    rows +
    "\n\nQUESTION: " + question + "\nANSWER:";

  try {
    const answer = await llmGenerate(prompt, { maxTokens: 1024 });
    return Response.json({ answer, used: members.length, recalled: memById.size });
  } catch (e) {
    return Response.json({ answer: "", used: members.length, error: e instanceof Error ? e.message : "model error" }, { status: 502 });
  }
}
