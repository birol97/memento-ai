// Generic channel ingestion → MemWal. Provider adapters (Twilio, email, Slack)
// normalize their payloads and call the same core (see lib/ingest + the
// /api/webhooks/* routes). This endpoint takes an already-normalized event.
//
// POST /api/ingest
//   headers: x-ingest-secret: <INGEST_SECRET>   (required only if INGEST_SECRET is set)
//   body: { channel, from?, clientId?, text, threadId? }
import { NextResponse } from "next/server";

import { ingestMessage } from "@/lib/ingest";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const secret = process.env.INGEST_SECRET;
  if (secret && req.headers.get("x-ingest-secret") !== secret) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 });
  }

  const r = await ingestMessage({
    channel: String(body.channel || "channel"),
    from: body.from ? String(body.from) : undefined,
    clientId: typeof body.clientId === "number" ? body.clientId : null,
    text: String(body.text || ""),
    threadId: body.threadId ? String(body.threadId) : undefined,
  });

  if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: r.status });
  return NextResponse.json(r);
}
