"use client";

// In-browser softphone (Twilio Voice SDK). Mints a voice token for the chosen
// Twilio channel, places a WebRTC call (browser mic ↔ the callee), and exposes
// mute + hang up. Two-way audio, native echo cancellation.
import { useEffect, useRef, useState } from "react";
import { Device } from "@twilio/voice-sdk";
import type { Call } from "@twilio/voice-sdk";

import { API_BASE, getVoiceToken, streamCopilot } from "@/lib/api";
import { loadCharacter, characterPrompt } from "@/lib/character";
import { loadKnowledge } from "@/lib/knowledge";

type Status = "connecting" | "ringing" | "in-call" | "ended" | "error";
let _t = 0;

export function Dialer({
  channelId,
  to,
  onClose,
  onEnded,
  assisted = false,
  sessionId,
  clientId,
  clientName,
  context,
  onTranscript,
}: {
  channelId: number;
  to: string;
  onClose: () => void;
  onEnded?: (info: { seconds: number; status: "completed" | "failed"; transcript: string }) => void;
  // Assisted call: fork the audio to live transcription (tagged with sessionId) and
  // show the transcript + an "ask the AI" box right in the call modal.
  assisted?: boolean;
  sessionId?: string;
  clientId?: number;
  clientName?: string;
  context?: string; // grounding for the in-call AI (profile + objective)
  onTranscript?: (text: string) => void; // captured transcript when the call ends
}) {
  const [status, setStatus] = useState<Status>("connecting");
  const [muted, setMuted] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [secs, setSecs] = useState(0);
  const [lines, setLines] = useState<{ id: string; who: "me" | "them"; text: string }[]>([]);
  const [ask, setAsk] = useState("");
  const [answer, setAnswer] = useState("");
  const [thinking, setThinking] = useState(false);
  const deviceRef = useRef<Device | null>(null);
  const callRef = useRef<Call | null>(null);
  const linesRef = useRef<{ id: string; who: "me" | "them"; text: string }[]>([]);
  const askAbortRef = useRef<AbortController | null>(null);
  const startRef = useRef<number | null>(null); // ms timestamp when the call connected
  const endedRef = useRef(false); // report the call outcome exactly once

  // Report the finished call back to the parent (which logs it in the thread).
  const reportEnded = (status: "completed" | "failed") => {
    if (endedRef.current) return;
    endedRef.current = true;
    const seconds = startRef.current ? Math.round((Date.now() - startRef.current) / 1000) : 0;
    const transcript = linesRef.current.map((l) => `${l.who === "me" ? "Me" : clientName ?? "Them"}: ${l.text}`).join("\n");
    // a call that never connected counts as failed (nothing to log as a real call)
    onEnded?.({ seconds, status: startRef.current ? status : "failed", transcript });
  };

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    let cancelled = false;

    (async () => {
      try {
        const { token, from } = await getVoiceToken(channelId);
        if (cancelled) return;
        const device = new Device(token);
        deviceRef.current = device;
        const call = await device.connect({ params: { To: to, From: from ?? "", session_id: sessionId ?? "" } });
        callRef.current = call;
        call.on("ringing", () => setStatus("ringing"));
        call.on("accept", () => {
          setStatus("in-call");
          startRef.current = Date.now();
          timer = setInterval(() => setSecs((s) => s + 1), 1000);
        });
        call.on("disconnect", () => {
          setStatus("ended");
          if (timer) clearInterval(timer);
          reportEnded("completed");
        });
        call.on("error", (e: { message?: string }) => {
          setErr(e?.message ?? "call error");
          setStatus("error");
          reportEnded("failed");
        });
        setStatus("ringing");
      } catch (e) {
        if (!cancelled) {
          setErr(e instanceof Error ? e.message : "could not start the call");
          setStatus("error");
        }
      }
    })();

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      // if the call had connected and no disconnect/error fired yet, log it now
      if (startRef.current) reportEnded("completed");
      try {
        callRef.current?.disconnect();
      } catch {
        /* ignore */
      }
      try {
        deviceRef.current?.destroy();
      } catch {
        /* ignore */
      }
    };
  }, [channelId, to]);

  const toggleMute = () => {
    const c = callRef.current;
    if (!c) return;
    const next = !muted;
    c.mute(next);
    setMuted(next);
  };
  const hangup = () => {
    try {
      callRef.current?.disconnect();
    } catch {
      /* ignore */
    }
  };
  const fmt = (n: number) =>
    `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;

  // Assisted: watch ONLY this call's transcript (filtered by sessionId, so many
  // concurrent calls/conferences never cross), and hand it up when the modal closes.
  useEffect(() => {
    if (!assisted || !sessionId) return;
    const es = new EventSource(`${API_BASE}/calls/stream`);
    es.onmessage = (e) => {
      let ev: Record<string, unknown>;
      try { ev = JSON.parse(e.data); } catch { return; }
      if (String(ev.session_id ?? "") !== sessionId) return;
      if ((ev.type === "turn" || ev.type === "transcript") && typeof ev.text === "string") {
        const who: "me" | "them" = ev.speaker === "rep" || ev.speaker === "caller" ? "me" : "them";
        setLines((prev) => { const next = [...prev, { id: `t${++_t}`, who, text: ev.text as string }]; linesRef.current = next; return next; });
      }
    };
    es.onerror = () => { /* ping hiccups are normal */ };
    return () => {
      es.close();
      if (linesRef.current.length) onTranscript?.(linesRef.current.map((l) => `${l.who === "me" ? "Me" : clientName ?? "Them"}: ${l.text}`).join("\n"));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assisted, sessionId]);

  const askAI = async () => {
    const q = ask.trim();
    if (!q || thinking) return;
    setThinking(true); setAnswer(""); setAsk("");
    askAbortRef.current?.abort();
    const ac = new AbortController(); askAbortRef.current = ac;
    const transcript = linesRef.current.map((l) => l.text).join("\n");
    const ctx = (context ?? "") + (transcript ? `\n\nLIVE CALL TRANSCRIPT SO FAR:\n${transcript}` : "");
    let acc = "";
    try {
      await streamCopilot(
        clientId ?? 0,
        [{ role: "user", content: q }],
        (tok) => { acc += tok; setAnswer(acc); },
        ac.signal,
        ctx,
        characterPrompt(loadCharacter()),
        loadKnowledge(),
      );
    } catch (e) {
      if (!ac.signal.aborted) setAnswer(`⚠ ${e instanceof Error ? e.message : "advisor unavailable"}`);
    } finally {
      if (askAbortRef.current === ac) setThinking(false);
    }
  };

  const active = status === "in-call" || status === "ringing";

  return (
    <div className="dialer-overlay" onClick={onClose}>
      <div className={`dialer${assisted ? " dialer-assisted" : ""}`} onClick={(e) => e.stopPropagation()}>
        <div className="dialer-avatar">📞</div>
        <div className="dialer-to">{to}{assisted && <span className="dialer-ai-badge">🤖 AI listening</span>}</div>
        <div className="dialer-status">
          {status === "connecting" && "Connecting…"}
          {status === "ringing" && "Ringing…"}
          {status === "in-call" && <span className="ok">In call · {fmt(secs)}</span>}
          {status === "ended" && "Call ended"}
          {status === "error" && <span className="bad">⚠ {err}</span>}
        </div>
        <div className="dialer-actions">
          {active && (
            <button className={`dialer-btn${muted ? " active" : ""}`} onClick={toggleMute}>
              {muted ? "🔇 Unmute" : "🎙 Mute"}
            </button>
          )}
          {active ? (
            <button className="dialer-btn hangup" onClick={hangup}>
              ☎ Hang up
            </button>
          ) : (
            <button className="dialer-btn" onClick={onClose}>
              Close
            </button>
          )}
        </div>

        {assisted && (
          <div className="dialer-assist">
            <div className="dialer-assist-col">
              <div className="lcp-col-h">Live transcript{clientName ? ` · ${clientName}` : ""}</div>
              <div className="dialer-log">
                {lines.length === 0
                  ? <p className="cw-muted">{active ? "Listening…" : "Transcript appears once the call connects."}</p>
                  : lines.map((l) => <div key={l.id} className={`dialer-tline ${l.who}`}><b>{l.who === "me" ? "Me" : clientName ?? "Them"}:</b> {l.text}</div>)}
              </div>
            </div>
            <div className="dialer-assist-col">
              <div className="lcp-col-h">Ask the AI (about this call)</div>
              <div className="dialer-answer">{answer || <span className="cw-muted">e.g. “what price did they mention?”</span>}{thinking && <span className="cw-cursor">▍</span>}</div>
              <div className="dialer-ask">
                <input
                  value={ask}
                  onChange={(e) => setAsk(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") void askAI(); }}
                  placeholder="Ask the advisor…"
                />
                <button className="dialer-btn" onClick={() => void askAI()} disabled={thinking || !ask.trim()}>Ask</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
