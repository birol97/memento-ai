// POST/GET /api/agent/run?days=7 — trigger one full monitor pipeline tick.
// The external entry point for the long-running agent: call it from cron, a
// scheduler, or the Monitor UI. Runs Scanner → Drafter, persisting findings,
// drafts and resumable state to Walrus. (Draft-only: the Actioner needs UI.)
import { runMonitorPipeline } from "@/lib/agents/pipeline";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function run(req: Request) {
  const days = Number(new URL(req.url).searchParams.get("days")) || 7;
  try {
    const result = await runMonitorPipeline(days);
    return Response.json({ ok: true, ...result });
  } catch (e) {
    return Response.json({ ok: false, error: e instanceof Error ? e.message : "pipeline failed" }, { status: 500 });
  }
}

export const POST = run;
export const GET = run;
