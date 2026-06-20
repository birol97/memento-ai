// Twilio inbound SMS / WhatsApp webhook → Memento memory.
// Point your Twilio number's "A message comes in" webhook here (POST).
// Twilio sends application/x-www-form-urlencoded with From, Body, etc.
import { NextResponse } from "next/server";

import { ingestMessage } from "@/lib/ingest";

export const dynamic = "force-dynamic";

const TWIML_OK =
  '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

export async function POST(req: Request) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return new NextResponse(TWIML_OK, { headers: { "Content-Type": "text/xml" } });
  }

  const fromRaw = String(form.get("From") || "");
  const channel = fromRaw.startsWith("whatsapp:") ? "whatsapp" : "sms";
  const from = fromRaw.replace(/^whatsapp:/, "").trim(); // E.164 phone
  const text = String(form.get("Body") || "").trim();

  // Fire-and-forget: ingestion (LLM split + Walrus + Sui anchor) is slower than
  // Twilio's webhook timeout, so respond immediately. (A queue makes this durable
  // in production — see AUTOMATION_ROADMAP.)
  if (text) {
    void ingestMessage({ channel, from, text, threadId: from }).catch(() => {});
  }

  return new NextResponse(TWIML_OK, { headers: { "Content-Type": "text/xml" } });
}
