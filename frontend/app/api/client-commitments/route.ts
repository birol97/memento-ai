// POST /api/client-commitments  { events:[{at,text}] }  ->  { commitments:[...] }
// Pulls dated commitments out of captured info — "I'll pay on 30 January", etc.
// Extraction logic is shared with the Scanner agent (lib/commitments.ts).
import { extractCommitments, type CommitEvent } from "@/lib/commitments";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let events: CommitEvent[] = [];
  try {
    const b = await req.json();
    events = Array.isArray(b.events) ? b.events.slice(0, 60) : [];
  } catch {
    return Response.json({ commitments: [] });
  }
  try {
    const commitments = await extractCommitments(events);
    return Response.json({ commitments });
  } catch (e) {
    return Response.json({ commitments: [], error: e instanceof Error ? e.message : "extract failed" });
  }
}
