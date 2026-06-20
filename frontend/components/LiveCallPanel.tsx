"use client";

// Assisted phone call via the Voice Relay. Starts an outbound call (the relay
// owns the Twilio media stream + Whisper), watches the live transcript over the
// app's SSE (/calls/stream — fed by the relay → /relay/ingest bridge), and lets
// the rep prompt the AI mid-call ("what was the donut price?"). The AI answer is
// grounded in the running transcript + the customer's memory + your knowledge
// base + the call objective. When the call ends, the captured transcript is
// handed up so it can be saved into the customer's memory in one click.
import { useCallback, useEffect, useRef, useState } from "react";

import { API_BASE, placeAssistedCall, streamCopilot, type Channel } from "@/lib/api";
import type { Client } from "@/lib/types";
import { loadCharacter, characterPrompt } from "@/lib/character";
import { loadKnowledge } from "@/lib/knowledge";

type Status = "idle" | "calling" | "live" | "ended" | "error";
type Line = { id: string; who: "me" | "them"; text: string };
let _ln = 0;

function clientContext(c: Client): string {
  return [
    `Name: ${c.name}`,
    c.relationship ? `Relationship: ${c.relationship}` : "",
    c.objective ? `Objective of this call: ${c.objective}` : "",
    c.profile ? `Profile:\n${c.profile}` : "",
  ].filter(Boolean).join("\n");
}

export function LiveCallPanel({
  client,
  channels,
  onTranscript,
  autoStart,
}: {
  client: Client;
  channels: Channel[];
  onTranscript: (text: string) => void; // hand the full transcript up when the call ends
  autoStart?: number; // bump from the parent to auto-start an assisted call
}) {
  const [status, setStatus] = useState<Status>("idle");
  const [lines, setLines] = useState<Line[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [ask, setAsk] = useState("");
  const [answer, setAnswer] = useState("");
  const [thinking, setThinking] = useState(false);

  const esRef = useRef<EventSource | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const lastAutoRef = useRef(0);

  const twilio = channels.find((c) => c.kind === "twilio");
  const to = client.phone ?? "";

  useEffect(() => {
    logRef.current?.scrollTo(0, logRef.current.scrollHeight);
  }, [lines, answer]);

  const closeStream = useCallback(() => {
    esRef.current?.close();
    esRef.current = null;
  }, []);

  useEffect(() => () => { closeStream(); abortRef.current?.abort(); }, [closeStream]);

  // build the full transcript text from the captured lines
  const transcriptText = () =>
    lines.map((l) => `${l.who === "me" ? "Me" : client.name}: ${l.text}`).join("\n");

  const start = async () => {
    if (!twilio) { setErr("Connect a Twilio channel first (Settings → Channels)."); return; }
    if (!to) { setErr(`${client.name} has no phone number — add one in the profile.`); return; }
    setErr(null); setLines([]); setAnswer(""); setStatus("calling");

    // 1) subscribe to the live event stream first so we don't miss early turns
    const es = new EventSource(`${API_BASE}/calls/stream`);
    esRef.current = es;
    es.onmessage = (e) => {
      let ev: Record<string, unknown>;
      try { ev = JSON.parse(e.data); } catch { return; }
      // optional correlation: relay sends session_id ending in -<clientId>;
      // the backend-native path sends none → those pass through.
      const sid = String(ev.session_id ?? "");
      if (sid && !sid.endsWith(`-${client.id}`)) return;
      const t = String(ev.type ?? "");
      if (t === "call.started" || t === "start") {
        setStatus("live");
      } else if ((t === "transcript" || t === "turn") && typeof ev.text === "string") {
        // backend-native turns have no speaker → it's the person on the line ("them")
        const who: Line["who"] = ev.speaker === "caller" || ev.speaker === "rep" ? "me" : "them";
        setLines((prev) => [...prev, { id: `l${++_ln}`, who, text: ev.text as string }]);
        setStatus("live");
      } else if (t === "call.ended" || t === "stop") {
        setStatus("ended");
        closeStream();
        setLines((cur) => { onTranscript(cur.map((l) => `${l.who === "me" ? "Me" : client.name}: ${l.text}`).join("\n")); return cur; });
      }
    };
    es.onerror = () => { /* keepalive/ping hiccups are normal; ignore */ };

    // 2) place the assisted call via the backend's native Twilio media path
    //    (uses the backend's own tunnel — no separate relay tunnel needed).
    try {
      const r = await placeAssistedCall(to);
      if (!r.ok) { setErr(r.error || "call failed to start"); setStatus("error"); closeStream(); }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "call failed"); setStatus("error"); closeStream();
    }
  };

  const endLocal = () => { setStatus("ended"); closeStream(); onTranscript(transcriptText()); };

  const askAI = async () => {
    const q = ask.trim();
    if (!q || thinking) return;
    setThinking(true); setAnswer(""); setAsk("");
    abortRef.current?.abort();
    const ac = new AbortController(); abortRef.current = ac;
    const ctx = clientContext(client) + (lines.length ? `\n\nLIVE CALL TRANSCRIPT SO FAR:\n${transcriptText()}` : "");
    let acc = "";
    try {
      await streamCopilot(
        client.id,
        [{ role: "user", content: q }],
        (t) => { acc += t; setAnswer(acc); },
        ac.signal,
        ctx,
        characterPrompt(loadCharacter()),
        loadKnowledge(),
      );
    } catch (e) {
      if (!ac.signal.aborted) setAnswer(`⚠ ${e instanceof Error ? e.message : "advisor unavailable"}`);
    } finally {
      if (abortRef.current === ac) setThinking(false);
    }
  };

  // parent bumped autoStart (user chose "Call with AI assistant") → start the call
  useEffect(() => {
    if (autoStart && autoStart !== lastAutoRef.current && status === "idle") {
      lastAutoRef.current = autoStart;
      void start();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStart, status]);

  const live = status === "live" || status === "calling";

  return (
    <div className="cw-brief lcp">
      <div className="cw-brief-head">
        <span className="cw-brief-title">📞 Assisted call (AI listening)</span>
        {!live ? (
          <button className="cw-mini-btn" onClick={() => void start()} disabled={!twilio || !to}>
            {status === "ended" ? "Call again" : "Call with AI assistant"}
          </button>
        ) : (
          <button className="cw-mini-btn" onClick={endLocal}>End</button>
        )}
      </div>
      <p className="cw-muted">
        {status === "idle" && `Calls ${to || client.name} through the relay; the AI listens live and you can ask it anything mid-call.`}
        {status === "calling" && "Connecting the call…"}
        {status === "live" && "● Live — transcript streaming below."}
        {status === "ended" && "Call ended. Transcript captured — save it to memory below."}
        {status === "error" && "Couldn't start the call."}
      </p>
      {err && <p className="cw-err">{err}</p>}

      <div className="lcp-grid">
        <div className="lcp-col">
          <div className="lcp-col-h">Live transcript</div>
          <div className="lcp-log" ref={logRef}>
            {lines.length === 0 ? (
              <p className="cw-muted">{live ? "Listening…" : "Transcript will appear here once the call connects."}</p>
            ) : (
              lines.map((l) => (
                <div key={l.id} className={`lcp-line ${l.who}`}>
                  <b>{l.who === "me" ? "Me" : client.name}:</b> {l.text}
                </div>
              ))
            )}
          </div>
        </div>
        <div className="lcp-col">
          <div className="lcp-col-h">Ask the AI (about the live call)</div>
          <div className="lcp-answer">{answer || <span className="cw-muted">e.g. “what price did they mention?”, “how old did they say they are?”</span>}{thinking && <span className="cw-cursor">▍</span>}</div>
          <div className="kb-actions" style={{ marginTop: 8 }}>
            <input
              className="cw-to"
              style={{ flex: 1 }}
              value={ask}
              onChange={(e) => setAsk(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void askAI(); }}
              placeholder="Ask the advisor…"
            />
            <button className="cw-mini-btn" onClick={() => void askAI()} disabled={thinking || !ask.trim()}>Ask</button>
          </div>
        </div>
      </div>
    </div>
  );
}
