// Slack Events API webhook → Memento memory.
// Create a Slack app, subscribe to `message.channels` / `message.im`, and point
// the Request URL here. Set SLACK_SIGNING_SECRET to verify requests.
//
// NOTE: Slack identifies senders by user id, not email — resolution to a customer
// needs a bound Slack identity (roadmap Phase 1/4). Until then these resolve only
// if a customer record's email/phone happens to match.
import { createHmac, timingSafeEqual } from "crypto";

import { NextResponse } from "next/server";

import { ingestMessage } from "@/lib/ingest";

export const dynamic = "force-dynamic";

function verifySlack(raw: string, ts: string | null, sig: string | null): boolean {
  const secret = process.env.SLACK_SIGNING_SECRET;
  if (!secret) return true; // verification disabled in dev
  if (!ts || !sig) return false;
  // Reject stale timestamps (>5 min) to prevent replay.
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const base = `v0:${ts}:${raw}`;
  const expected = `v0=${createHmac("sha256", secret).update(base).digest("hex")}`;
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
  } catch {
    return false;
  }
}

export async function POST(req: Request) {
  const raw = await req.text();
  if (
    !verifySlack(
      raw,
      req.headers.get("x-slack-request-timestamp"),
      req.headers.get("x-slack-signature"),
    )
  ) {
    return NextResponse.json({ ok: false, error: "bad signature" }, { status: 401 });
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(raw);
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 });
  }

  // URL verification handshake.
  if (payload.type === "url_verification") {
    return NextResponse.json({ challenge: payload.challenge });
  }

  if (payload.type === "event_callback") {
    const ev = payload.event as
      | { type?: string; subtype?: string; bot_id?: string; user?: string; text?: string; thread_ts?: string; channel?: string }
      | undefined;
    if (ev && ev.type === "message" && !ev.bot_id && !ev.subtype && ev.text) {
      void ingestMessage({
        channel: "slack",
        from: ev.user, // slack user id — bind to a customer to resolve
        text: ev.text,
        threadId: ev.thread_ts || ev.channel,
      }).catch(() => {});
    }
  }

  // Always 200 fast so Slack doesn't retry.
  return NextResponse.json({ ok: true });
}
