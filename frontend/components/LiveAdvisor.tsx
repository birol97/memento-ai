"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { AudioCapture } from "@/lib/audioCapture";
import { TranscribeClient } from "@/lib/websocketClient";
import { getEnrollment, postEnrollment, type EnrollmentStatus } from "@/lib/api";
import { recallClientMemory } from "@/app/actions/memory";
import type { Client, ServerMessage, SuggestionSkill } from "@/lib/types";

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:8000/ws/transcribe";
const SAMPLE_RATE = 16000;
const ENROLL_SECONDS = 8;

// How the relationship shapes the advice persona. A customer → sell; everyone
// else (colleague / friend / expert / mentor) → a natural, non-selling copilot.
// The relationship text itself is also injected into the prompt server-side.
function skillFor(relationship?: string | null): SuggestionSkill {
  return (relationship || "").toLowerCase().startsWith("customer") ? "sales" : "casual";
}

type Status = "idle" | "connecting" | "live" | "ended" | "error";
type Line = { id: string; who: "me" | "them"; text: string; live?: boolean };
type Advice = { id: string; text: string; status: "streaming" | "done"; kind: "auto" | "ask" };

let _id = 0;
const nextId = () => `x${++_id}`;

export function LiveAdvisor({ client }: { client: Client }) {
  const [status, setStatus] = useState<Status>("idle");
  const [lines, setLines] = useState<Line[]>([]);
  const [advice, setAdvice] = useState<Advice[]>([]);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [memoryRecalled, setMemoryRecalled] = useState<number | null>(null);
  const [ask, setAsk] = useState("");

  const [enroll, setEnroll] = useState<EnrollmentStatus | null>(null);
  const [enrolling, setEnrolling] = useState<number | null>(null); // seconds left

  const captureRef = useRef<AudioCapture | null>(null);
  const wsRef = useRef<TranscribeClient | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const adviceRef = useRef<HTMLDivElement>(null);

  const themName = client.name;

  useEffect(() => {
    getEnrollment().then(setEnroll).catch(() => setEnroll(null));
  }, []);

  useEffect(() => {
    logRef.current?.scrollTo(0, logRef.current.scrollHeight);
    adviceRef.current?.scrollTo(0, adviceRef.current.scrollHeight);
  }, [lines, advice]);

  // tear down on unmount / customer switch
  useEffect(() => {
    return () => {
      captureRef.current?.stop().catch(() => {});
      wsRef.current?.close();
    };
  }, []);

  const handleMessage = useCallback(
    (msg: ServerMessage) => {
      switch (msg.type) {
        case "ready":
          setStatus("live");
          break;
        case "partial": {
          const text = msg.text?.trim();
          if (!text) break;
          const who: Line["who"] = msg.speaker === "rep" ? "me" : "them";
          setLines((prev) => {
            const last = prev[prev.length - 1];
            if (last?.live) {
              return prev.map((l, i) =>
                i === prev.length - 1 ? { ...l, who, text } : l,
              );
            }
            return [...prev, { id: nextId(), who, text, live: true }];
          });
          break;
        }
        case "final": {
          const text = msg.text?.trim();
          const who: Line["who"] = msg.speaker === "rep" ? "me" : "them";
          setLines((prev) => {
            const rest = prev[prev.length - 1]?.live ? prev.slice(0, -1) : prev;
            if (!text) return rest;
            return [...rest, { id: nextId(), who, text }];
          });
          break;
        }
        case "suggestion_start":
          setAdvice((prev) => [
            ...prev,
            { id: `s${msg.turn_id}`, text: "", status: "streaming", kind: "auto" },
          ]);
          break;
        case "suggestion_token":
          setAdvice((prev) => {
            const last = prev[prev.length - 1];
            if (!last || last.status !== "streaming") return prev;
            return prev.map((a, i) =>
              i === prev.length - 1 ? { ...a, text: a.text + msg.text } : a,
            );
          });
          break;
        case "suggestion_end":
          setAdvice((prev) =>
            prev.map((a) =>
              a.id === `s${msg.turn_id}` ? { ...a, text: msg.full_text || a.text, status: "done" } : a,
            ),
          );
          break;
        case "ask_start":
          setAdvice((prev) => [
            ...prev,
            { id: msg.ask_id, text: "", status: "streaming", kind: "ask" },
          ]);
          break;
        case "ask_token":
          setAdvice((prev) =>
            prev.map((a) => (a.id === msg.ask_id ? { ...a, text: a.text + msg.text } : a)),
          );
          break;
        case "ask_end":
          setAdvice((prev) =>
            prev.map((a) =>
              a.id === msg.ask_id ? { ...a, text: msg.full_text || a.text, status: "done" } : a,
            ),
          );
          break;
        case "error":
          setErrorMsg(msg.message);
          setStatus("error");
          break;
      }
    },
    [],
  );

  const start = useCallback(async () => {
    setErrorMsg(null);
    setLines([]);
    setAdvice([]);
    setMemoryRecalled(null);
    setStatus("connecting");

    const ws = new TranscribeClient(WS_URL, {
      onMessage: handleMessage,
      onError: () => {
        setErrorMsg("Couldn't connect to the live engine.");
        setStatus("error");
      },
      onClose: () => {
        setStatus((s) => (s === "live" ? "ended" : s));
      },
    });
    wsRef.current = ws;
    try {
      await ws.connect();
    } catch {
      setErrorMsg("WebSocket failed to open.");
      setStatus("error");
      return;
    }

    // Recall this character's Walrus memory so advice is grounded from turn one.
    let memory: string | null = null;
    try {
      const r = await recallClientMemory(client.id);
      if (r.ok) {
        memory = r.block;
        setMemoryRecalled(r.entries.length);
      }
    } catch {
      /* non-fatal */
    }

    ws.sendStart(
      SAMPLE_RATE,
      { id: client.id },
      { mode: "auto", autoIntervalSeconds: 0, skill: skillFor(client.relationship) },
      memory,
    );

    const capture = new AudioCapture({
      sampleRate: SAMPLE_RATE,
      onChunk: (samples) => ws.sendAudio(samples),
      onError: (err) => {
        setErrorMsg(err.message);
        setStatus("error");
      },
    });
    captureRef.current = capture;
    try {
      await capture.start();
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "microphone unavailable");
      setStatus("error");
    }
  }, [client.id, client.relationship, handleMessage]);

  const stop = useCallback(async () => {
    await captureRef.current?.stop().catch(() => {});
    captureRef.current = null;
    wsRef.current?.sendStop();
    wsRef.current?.close();
    wsRef.current = null;
    setStatus("ended");
  }, []);

  const sendAsk = useCallback(() => {
    const q = ask.trim();
    if (!q || status !== "live") return;
    wsRef.current?.sendAsk(q, nextId());
    setAsk("");
  }, [ask, status]);

  // Quick voice enrollment so the engine can tell "Me" from the customer.
  const doEnroll = useCallback(async () => {
    if (enrolling !== null) return;
    setErrorMsg(null);
    const chunks: Float32Array[] = [];
    const cap = new AudioCapture({
      sampleRate: SAMPLE_RATE,
      onChunk: (s) => chunks.push(s.slice()),
      onError: (err) => setErrorMsg(err.message),
    });
    try {
      await cap.start();
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "microphone unavailable");
      return;
    }
    for (let left = ENROLL_SECONDS; left > 0; left--) {
      setEnrolling(left);
      await new Promise((r) => setTimeout(r, 1000));
    }
    await cap.stop().catch(() => {});
    setEnrolling(null);
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const merged = new Float32Array(total);
    let off = 0;
    for (const c of chunks) {
      merged.set(c, off);
      off += c.length;
    }
    try {
      const res = await postEnrollment(merged);
      setEnroll(res);
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "enrollment failed");
    }
  }, [enrolling]);

  const live = status === "live";
  const skill = skillFor(client.relationship);

  return (
    <div className="advisor">
      {/* voice identity banner */}
      <div className={`adv-enroll${enroll?.enrolled ? " ok" : ""}`}>
        {enroll?.enrolled ? (
          <span>🎙 Your voice is enrolled — I can tell <b>Me</b> from <b>{themName}</b>.</span>
        ) : enrolling !== null ? (
          <span>🎙 Listening… keep talking for {enrolling}s</span>
        ) : (
          <>
            <span>🎙 Enroll your voice once so I can label who’s speaking.</span>
            <button className="adv-mini" onClick={doEnroll} disabled={live}>
              Enroll my voice ({ENROLL_SECONDS}s)
            </button>
          </>
        )}
      </div>

      <div className="adv-grid">
        {/* conversation */}
        <section className="card adv-col">
          <div className="chat-head">
            <h2 className="card-title">Conversation</h2>
            <span className={`call-status call-${live ? "live" : status === "ended" ? "ended" : "idle"}`}>
              {live ? "● listening" : status === "connecting" ? "connecting…" : status === "ended" ? "ended" : "idle"}
            </span>
          </div>
          <div className="call-log" ref={logRef}>
            {lines.length === 0 ? (
              <p className="empty">
                {live ? "Listening — start talking." : "Press Start, put the call on speaker, and I’ll follow along."}
              </p>
            ) : (
              lines.map((l) => (
                <div key={l.id} className={`adv-line ${l.who}${l.live ? " partial" : ""}`}>
                  <span className="adv-who">{l.who === "me" ? "Me" : themName}</span>
                  <span>{l.text}</span>
                </div>
              ))
            )}
          </div>
        </section>

        {/* advice */}
        <section className="card adv-col">
          <div className="chat-head">
            <h2 className="card-title">Advisor</h2>
            <span className="adv-skill">{skill === "sales" ? "sales mode" : "conversation mode"}</span>
          </div>
          <div className="call-log" ref={adviceRef}>
            {advice.length === 0 ? (
              <p className="empty">Advice appears here as the conversation unfolds.</p>
            ) : (
              advice.map((a) => (
                <div key={a.id} className={`adv-tip${a.kind === "ask" ? " ask" : ""}`}>
                  {a.kind === "ask" && <span className="adv-tip-tag">your question</span>}
                  <span>{a.text || (a.status === "streaming" ? "…" : "")}</span>
                </div>
              ))
            )}
          </div>
          <div className="adv-ask">
            <input
              className="tc-input"
              placeholder={live ? "Ask the advisor…" : "Start to ask questions"}
              value={ask}
              disabled={!live}
              onChange={(e) => setAsk(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") sendAsk();
              }}
            />
            <button className="adv-mini" onClick={sendAsk} disabled={!live || !ask.trim()}>
              Ask
            </button>
          </div>
        </section>
      </div>

      <div className="adv-controls">
        {!live ? (
          <button className="wiz-next" onClick={start} disabled={status === "connecting"}>
            {status === "connecting" ? "Connecting…" : "▶ Start listening"}
          </button>
        ) : (
          <button className="adv-stop" onClick={stop}>
            ■ Stop
          </button>
        )}
        {memoryRecalled !== null && (
          <span className="adv-note">recalled {memoryRecalled} memories about {themName}</span>
        )}
        {errorMsg && <span className="adv-err">⚠ {errorMsg}</span>}
      </div>
    </div>
  );
}
