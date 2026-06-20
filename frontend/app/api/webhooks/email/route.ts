// Inbound email webhook → Memento memory.
// Works with SendGrid Inbound Parse / Mailgun routes (POST multipart/form-data
// with fields: from, subject, text). Point your inbound-parse hook here.
import { NextResponse } from "next/server";

import { ingestMessage } from "@/lib/ingest";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ ok: false, error: "expected form data" }, { status: 400 });
  }

  const fromRaw = String(form.get("from") || "");
  // "Mehmet <mehmet@acme.com>" → mehmet@acme.com
  const from = (fromRaw.match(/<([^>]+)>/)?.[1] || fromRaw).trim().toLowerCase();
  const subject = String(form.get("subject") || "").trim();
  const text = String(form.get("text") || form.get("email") || "").trim();

  if (text) {
    void ingestMessage({
      channel: "email",
      from,
      text,
      threadId: subject || undefined,
    }).catch(() => {});
  }

  return NextResponse.json({ ok: true });
}
