"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";

import { AudioCapture } from "@/lib/audioCapture";
import { TranscribeClient } from "@/lib/websocketClient";
import { decodeTo16kMono, streamPcmAtPace } from "@/lib/fileStream";
import { getClient } from "@/lib/api";
import { recallClientMemory, writeNamespace, recordMood } from "@/app/actions/memory";
import { getPrecallBrief } from "@/app/actions/ask";
import { anchorMemory } from "@/app/actions/onchain";
import { createSubspace } from "@/lib/api";
import { clientNamespace, subNamespace } from "@/lib/clientNamespace";

const SUI_EXPLORER = process.env.NEXT_PUBLIC_SUI_EXPLORER ?? "https://suiscan.xyz/testnet";
import type {
  AskState,
  AutoIntervalSeconds,
  Client,
  ConnectionStatus,
  PartialMessage,
  ServerMessage,
  SuggestionMode,
  SuggestionSkill,
  SuggestionState,
  Turn,
} from "@/lib/types";
import { ClientKnowledge } from "./ClientKnowledge";
import { ClientPicker } from "./ClientPicker";
import { CreateCharacterButton } from "./CreateCharacterButton";
import { StatusIndicator } from "./StatusIndicator";
import { SuggestionPanel } from "./SuggestionPanel";
import { TranscriptView } from "./TranscriptView";

let turnIdCounter = 0;
function nextTurnId(): string {
  return `t${++turnIdCounter}`;
}

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:8000/ws/transcribe";
const SAMPLE_RATE = 16000;

const MODE_STORAGE_KEY = "cc:suggestion_mode";
const INTERVAL_STORAGE_KEY = "cc:suggestion_interval_s";
const SKILL_STORAGE_KEY = "cc:suggestion_skill";

function loadStoredMode(): SuggestionMode {
  if (typeof window === "undefined") return "auto";
  const raw = window.localStorage.getItem(MODE_STORAGE_KEY);
  return raw === "manual" || raw === "auto" ? raw : "auto";
}

function loadStoredInterval(): AutoIntervalSeconds {
  if (typeof window === "undefined") return 0;
  const raw = Number(window.localStorage.getItem(INTERVAL_STORAGE_KEY));
  return raw === 60 || raw === 120 || raw === 300 ? raw : 0;
}

function loadStoredSkill(): SuggestionSkill {
  if (typeof window === "undefined") return "sales";
  const raw = window.localStorage.getItem(SKILL_STORAGE_KEY);
  return raw === "sales" || raw === "marketing" || raw === "casual" ? raw : "sales";
}

interface LatencySample {
  inferenceMs: number;
  e2eMs: number;
  bufferSeconds: number;
  ts: number;
}

type Source = "mic" | "file";

export function Recorder({ presetClient }: { presetClient?: Client | null } = {}) {
  const [status, setStatus] = useState<ConnectionStatus>("idle");
  const [source, setSource] = useState<Source>("mic");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [isSpeaking, setIsSpeaking] = useState<boolean>(false);
  const [latency, setLatency] = useState<LatencySample | null>(null);
  const [level, setLevel] = useState<number>(0);
  const [fileInfo, setFileInfo] = useState<{ name: string; durationSec: number } | null>(null);
  const [fileProgress, setFileProgress] = useState<number>(0);
  const [fileSpeed, setFileSpeed] = useState<number>(1);

  const [client, setClient] = useState<Client | null>(presetClient ?? null);
  const [hasHistory, setHasHistory] = useState<boolean | null>(null);
  // MemWal memory loop (per-client namespace): entries recalled at call-start,
  // and how many facts got extracted+stored on call-end.
  const [memoryRecalled, setMemoryRecalled] = useState<number | null>(null);
  const [memoryWritten, setMemoryWritten] = useState<{
    saved: number;
    failed: number;
    total: number;
  } | null>(null);
  const [memoryWriting, setMemoryWriting] = useState<boolean>(false);
  const [anchorTx, setAnchorTx] = useState<{ digest: string; kind: string } | null>(null);
  const [brief, setBrief] = useState<{ text: string; count: number } | null>(null);
  const [briefLoading, setBriefLoading] = useState<boolean>(false);
  // Where this upload goes: the generic client profile, or a new per-conversation sub-namespace.
  const [uploadScope, setUploadScope] = useState<"conversation" | "generic">("conversation");
  const [convLabel, setConvLabel] = useState<string>("");
  const [lastUploadedNs, setLastUploadedNs] = useState<string | null>(null);
  // Post-conversation mood ratings (1–5).
  const [mood, setMood] = useState<{ agreeability: number; mood: number; positivity: number; buyingIntent: number }>(
    { agreeability: 3, mood: 3, positivity: 3, buyingIntent: 3 },
  );
  const [moodSaving, setMoodSaving] = useState(false);
  const [moodSaved, setMoodSaved] = useState(false);
  const [suggestions, setSuggestions] = useState<SuggestionState[]>([]);
  const [asks, setAsks] = useState<AskState[]>([]);
  const [suggestionMode, setSuggestionMode] = useState<SuggestionMode>("auto");
  const [autoIntervalSeconds, setAutoIntervalSeconds] = useState<AutoIntervalSeconds>(0);
  const [suggestionSkill, setSuggestionSkill] = useState<SuggestionSkill>("sales");

  // Hydrate from localStorage after mount (avoids SSR/CSR mismatch).
  useEffect(() => {
    setSuggestionMode(loadStoredMode());
    setAutoIntervalSeconds(loadStoredInterval());
    setSuggestionSkill(loadStoredSkill());
  }, []);

  // Pre-select a client when the page is opened with ?client=<id>
  // (the Briefing tab's "Start call" button uses this).
  // Keep in sync when the wizard supplies/changes the customer.
  useEffect(() => {
    if (presetClient) setClient(presetClient);
  }, [presetClient?.id]);

  const searchParams = useSearchParams();
  const clientIdFromUrl = searchParams?.get("client");
  useEffect(() => {
    if (!clientIdFromUrl) return;
    const id = Number(clientIdFromUrl);
    if (!Number.isFinite(id) || id <= 0) return;
    let cancelled = false;
    getClient(id)
      .then((c) => {
        if (!cancelled) setClient(c);
      })
      .catch(() => {
        // silently ignore — picker still lets the user choose manually
      });
    return () => {
      cancelled = true;
    };
  }, [clientIdFromUrl]);

  const captureRef = useRef<AudioCapture | null>(null);
  const clientRef = useRef<TranscribeClient | null>(null);
  const fileAbortRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const handleServerMessage = useCallback((msg: ServerMessage) => {
    switch (msg.type) {
      case "ready":
        setStatus("recording");
        break;

      case "client_attached":
        setHasHistory(msg.has_history);
        break;

      case "speech_start": {
        setIsSpeaking(true);
        setTurns((prev) => {
          const last = prev[prev.length - 1];
          if (last && last.status === "live") {
            return prev.map((t, i) =>
              i === prev.length - 1 ? { ...t, startSec: msg.turn_start } : t,
            );
          }
          return [
            ...prev,
            { id: nextTurnId(), status: "live", startSec: msg.turn_start, text: "" },
          ];
        });
        break;
      }

      case "turn_end": {
        setIsSpeaking(false);
        setTurns((prev) => {
          const last = prev[prev.length - 1];
          if (!last || last.status !== "live") return prev;
          return prev.map((t, i) =>
            i === prev.length - 1
              ? { ...t, startSec: msg.turn_start, endSec: msg.turn_end }
              : t,
          );
        });
        break;
      }

      case "partial":
      case "final": {
        const m = msg as PartialMessage;
        setLatency({
          inferenceMs: m.inference_ms,
          e2eMs: m.end_to_end_ms,
          bufferSeconds: m.buffer_seconds,
          ts: Date.now(),
        });

        if (m.type === "partial") {
          setTurns((prev) => {
            const last = prev[prev.length - 1];
            if (last && last.status === "live") {
              return prev.map((t, i) =>
                i === prev.length - 1 ? { ...t, text: m.text } : t,
              );
            }
            const startSec = m.segments[0]?.start;
            return [
              ...prev,
              { id: nextTurnId(), status: "live", text: m.text, startSec },
            ];
          });
        } else {
          setTurns((prev) => {
            const last = prev[prev.length - 1];
            const finalText = m.text;
            if (!finalText.trim()) {
              if (last && last.status === "live") {
                return prev.slice(0, -1);
              }
              return prev;
            }
            const finalSegStart = m.segments[0]?.start;
            const finalSegEnd = m.segments[m.segments.length - 1]?.end;
            const closed: Turn = {
              id: last && last.status === "live" ? last.id : nextTurnId(),
              dbTurnId: m.turn_id,
              status: "final",
              text: finalText,
              startSec: last?.startSec ?? finalSegStart,
              endSec: last?.endSec ?? finalSegEnd,
              finalizedAtIso: m.server_ts,
              inferenceMs: m.inference_ms,
              speaker: m.speaker,
            };
            if (last && last.status === "live") {
              return [...prev.slice(0, -1), closed];
            }
            return [...prev, closed];
          });
          setIsSpeaking(false);
        }
        break;
      }

      case "suggestion_start":
        setSuggestions((prev) => [
          ...prev,
          { turnId: msg.turn_id, text: "", status: "streaming" },
        ]);
        break;

      case "suggestion_token":
        setSuggestions((prev) => {
          if (prev.length === 0) return prev;
          const last = prev[prev.length - 1];
          if (last.status !== "streaming") return prev;
          return prev.map((s, i) =>
            i === prev.length - 1 ? { ...s, text: s.text + msg.text } : s,
          );
        });
        break;

      case "suggestion_end":
        setSuggestions((prev) =>
          prev.map((s) =>
            s.turnId === msg.turn_id
              ? { ...s, text: msg.full_text || s.text, status: "done" }
              : s,
          ),
        );
        break;

      case "ask_start":
        setAsks((prev) =>
          prev.map((a) =>
            a.askId === msg.ask_id ? { ...a, status: "streaming" } : a,
          ),
        );
        break;

      case "ask_token":
        setAsks((prev) =>
          prev.map((a) =>
            a.askId === msg.ask_id ? { ...a, text: a.text + msg.text } : a,
          ),
        );
        break;

      case "ask_end":
        setAsks((prev) =>
          prev.map((a) =>
            a.askId === msg.ask_id
              ? {
                  ...a,
                  text: msg.full_text || a.text,
                  status: msg.error ? "error" : "done",
                }
              : a,
          ),
        );
        break;

      case "stopped":
        setStatus("stopped");
        setIsSpeaking(false);
        setTurns((prev) => {
          const last = prev[prev.length - 1];
          if (!last || last.status !== "live") return prev;
          if (!last.text.trim()) return prev.slice(0, -1);
          return prev.map((t, i) =>
            i === prev.length - 1 ? { ...t, status: "final" } : t,
          );
        });
        break;

      case "error":
        setErrorMsg(msg.message);
        setStatus("error");
        break;

      case "pong":
        break;
    }
  }, []);

  const openSession = useCallback(async (): Promise<TranscribeClient | null> => {
    const wsClient = new TranscribeClient(WS_URL, {
      onMessage: handleServerMessage,
      onClose: () => {
        setStatus((prev) => (prev === "stopped" || prev === "error" ? prev : "idle"));
      },
      onError: () => {
        setErrorMsg("WebSocket connection failed.");
        setStatus("error");
      },
    });
    clientRef.current = wsClient;
    try {
      await wsClient.connect();
    } catch {
      return null;
    }
    // Bind this call to the picked customer and recall their memory from MemWal
    // (per-client namespace) before the copilot starts, so suggestions are
    // grounded in prior calls from turn one.
    let memoryBlock: string | null = null;
    if (client) {
      try {
        const r = await recallClientMemory(client.id);
        if (r.ok) {
          memoryBlock = r.block;
          setMemoryRecalled(r.entries.length);
        }
      } catch {
        /* non-fatal — start the call without recalled memory */
      }
    }
    wsClient.sendStart(
      SAMPLE_RATE,
      client ? { id: client.id } : null,
      { mode: suggestionMode, autoIntervalSeconds, skill: suggestionSkill },
      memoryBlock,
    );
    return wsClient;
  }, [handleServerMessage, client, suggestionMode, autoIntervalSeconds, suggestionSkill]);

  const handleModeChange = useCallback(
    (
      mode: SuggestionMode,
      intervalSeconds: AutoIntervalSeconds,
      skill: SuggestionSkill,
    ) => {
      setSuggestionMode(mode);
      setAutoIntervalSeconds(intervalSeconds);
      setSuggestionSkill(skill);
      if (typeof window !== "undefined") {
        window.localStorage.setItem(MODE_STORAGE_KEY, mode);
        window.localStorage.setItem(INTERVAL_STORAGE_KEY, String(intervalSeconds));
        window.localStorage.setItem(SKILL_STORAGE_KEY, skill);
      }
      if (clientRef.current?.readyState === WebSocket.OPEN) {
        clientRef.current.sendMode(mode, intervalSeconds, skill);
      }
    },
    [],
  );

  const resetUiState = () => {
    setErrorMsg(null);
    setTurns([]);
    setIsSpeaking(false);
    setLevel(0);
    setFileProgress(0);
    setLatency(null);
    setSuggestions([]);
    setAsks([]);
    setHasHistory(null);
    setMemoryRecalled(null);
    setMemoryWritten(null);
  };

  // Explicit "upload this conversation to the selected namespace" — the user
  // clicks it during or after a call (no need to stop). Sends the current
  // transcript to the customer's MemWal namespace via analyze().
  const uploadMemory = useCallback(async () => {
    if (!client) return;
    const finalTurns = turns.filter((t) => t.text.trim());
    if (finalTurns.length === 0) return;
    const transcript = finalTurns
      .map((t) => `${t.speaker === "rep" ? "YOU" : "PROSPECT"}: ${t.text}`)
      .join("\n");
    setMemoryWritten(null);
    setAnchorTx(null);
    setMoodSaved(false);
    setLastUploadedNs(null);
    setMemoryWriting(true);
    try {
      // Resolve the target namespace: generic profile, or a new per-conversation sub.
      let ns = clientNamespace(client.id);
      if (uploadScope === "conversation") {
        const label = convLabel.trim() || `Call ${new Date().toLocaleString()}`;
        try {
          const sub = await createSubspace(client.id, label);
          ns = subNamespace(client.id, sub.ns_key);
        } catch {
          /* registry failed — fall back to the generic namespace */
        }
      }
      const r = await writeNamespace(ns, transcript);
      if (r.ok) {
        setMemoryWritten({ saved: r.saved, failed: r.failed, total: r.total });
        setLastUploadedNs(ns);
        setConvLabel("");
        // Anchor-on-upload: commit the transcript hash on Sui (always the parent cap).
        try {
          const a = await anchorMemory(clientNamespace(client.id), transcript);
          if (a.ok) setAnchorTx({ digest: a.digest, kind: a.kind });
        } catch {
          /* anchor is best-effort — memory write already succeeded */
        }
      }
    } finally {
      setMemoryWriting(false);
    }
  }, [client, turns, uploadScope, convLabel]);

  // Save the post-conversation mood ratings into the just-uploaded namespace.
  const saveMood = useCallback(async () => {
    if (!lastUploadedNs) return;
    setMoodSaving(true);
    try {
      const r = await recordMood(lastUploadedNs, mood);
      if (r.ok) setMoodSaved(true);
    } finally {
      setMoodSaving(false);
    }
  }, [lastUploadedNs, mood]);

  // Pre-call brief: synthesize a prep note from the customer's memory on select.
  useEffect(() => {
    if (!client) {
      setBrief(null);
      return;
    }
    let cancelled = false;
    setBrief(null);
    setBriefLoading(true);
    (async () => {
      const r = await getPrecallBrief(client.id);
      if (cancelled) return;
      setBrief(r.ok ? { text: r.brief, count: r.count } : null);
      setBriefLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [client?.id]);

  const handleAsk = useCallback((prompt: string) => {
    const trimmed = prompt.trim();
    if (!trimmed) return;
    if (clientRef.current?.readyState !== WebSocket.OPEN) {
      setErrorMsg("Start a session first — the copilot listens through the live WebSocket.");
      return;
    }
    const askId =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID().slice(0, 8)
        : `a${Date.now().toString(36)}`;
    setAsks((prev) => [
      ...prev,
      { askId, prompt: trimmed, text: "", status: "pending" },
    ]);
    clientRef.current.sendAsk(trimmed, askId);
  }, []);

  const startMic = useCallback(async () => {
    resetUiState();
    setSource("mic");
    setStatus("connecting");

    const wsClient = await openSession();
    if (!wsClient) return;

    let smoothed = 0;
    const capture = new AudioCapture({
      sampleRate: SAMPLE_RATE,
      onChunk: (samples) => {
        wsClient.sendAudio(samples);
        let sumSq = 0;
        for (let i = 0; i < samples.length; i++) sumSq += samples[i] * samples[i];
        const rms = Math.sqrt(sumSq / samples.length);
        smoothed = smoothed * 0.6 + rms * 0.4;
        setLevel(smoothed);
      },
      onError: (err) => {
        setErrorMsg(err.message);
        setStatus("error");
      },
    });
    captureRef.current = capture;

    try {
      await capture.start();
      setStatus("recording");
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setStatus("error");
      wsClient.close();
    }
  }, [openSession]);

  const handleFileSelected = useCallback(
    async (file: File) => {
      resetUiState();
      setSource("file");
      setStatus("connecting");

      let samples: Float32Array;
      try {
        samples = await decodeTo16kMono(file);
      } catch (err) {
        setErrorMsg(
          `Could not decode audio file: ${err instanceof Error ? err.message : String(err)}`,
        );
        setStatus("error");
        return;
      }
      const durationSec = samples.length / SAMPLE_RATE;
      setFileInfo({ name: file.name, durationSec });

      const wsClient = await openSession();
      if (!wsClient) return;

      const abort = new AbortController();
      fileAbortRef.current = abort;

      setStatus("recording");
      let smoothed = 0;

      try {
        await streamPcmAtPace(samples, {
          chunkSamples: 4000,
          speed: fileSpeed,
          signal: abort.signal,
          onChunk: (chunk, indexInFile) => {
            wsClient.sendAudio(chunk);
            let sumSq = 0;
            for (let i = 0; i < chunk.length; i++) sumSq += chunk[i] * chunk[i];
            const rms = Math.sqrt(sumSq / chunk.length);
            smoothed = smoothed * 0.6 + rms * 0.4;
            setLevel(smoothed);
            setFileProgress(Math.min(1, (indexInFile + chunk.length) / samples.length));
          },
        });
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : String(err));
        setStatus("error");
        return;
      } finally {
        fileAbortRef.current = null;
      }

      wsClient.sendStop();
      setTimeout(() => {
        wsClient.close();
        clientRef.current = null;
      }, 1500);
    },
    [openSession, fileSpeed],
  );

  const stop = useCallback(async () => {
    fileAbortRef.current?.abort();
    fileAbortRef.current = null;
    await captureRef.current?.stop();
    captureRef.current = null;
    clientRef.current?.sendStop();
    setTimeout(() => {
      clientRef.current?.close();
      clientRef.current = null;
    }, 800);
  }, []);

  useEffect(() => {
    return () => {
      fileAbortRef.current?.abort();
      captureRef.current?.stop();
      clientRef.current?.close();
    };
  }, []);

  const isRunning = status === "recording" || status === "connecting";

  return (
    <div className="recorder">
      {!presetClient && (
        <div className="recorder-top">
          <ClientPicker value={client} onChange={setClient} disabled={isRunning || memoryWriting} />
          <CreateCharacterButton onCreated={setClient} disabled={isRunning} />
        </div>
      )}

      {client && !isRunning && (
        <ClientKnowledge client={client} onClientUpdated={setClient} />
      )}
      {client && isRunning && (
        <ClientKnowledge client={client} compact />
      )}

      {client && (briefLoading || brief) && (
        <div className="brief-card">
          <div className="brief-head">
            <span className="brief-title">Pre-call brief</span>
            {brief && brief.count > 0 && (
              <span className="brief-count">{brief.count} memories</span>
            )}
          </div>
          <p className="brief-body">
            {briefLoading ? "Preparing brief from Walrus Memory…" : brief?.text}
          </p>
        </div>
      )}

      <div className="controls">
        <button
          onClick={isRunning ? stop : startMic}
          className={isRunning ? "btn stop" : "btn start"}
          disabled={status === "connecting"}
        >
          {isRunning
            ? source === "file"
              ? "Stop playback"
              : "Stop recording"
            : "Start recording"}
        </button>

        <button
          className="btn file"
          onClick={() => fileInputRef.current?.click()}
          disabled={isRunning}
        >
          Load audio file
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="audio/*,.wav,.mp3,.m4a,.flac,.ogg,.webm"
          style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) handleFileSelected(f);
          }}
        />

        <label className="speed">
          speed{" "}
          <select
            value={fileSpeed}
            onChange={(e) => setFileSpeed(Number(e.target.value))}
            disabled={isRunning && source === "file"}
          >
            <option value={1}>1×</option>
            <option value={2}>2×</option>
            <option value={4}>4×</option>
            <option value={8}>8×</option>
          </select>
        </label>

        <StatusIndicator status={status} speaking={isSpeaking} />
      </div>

      {client && (
        <div className="upload-mem-box">
          <div className="upload-scope">
            <label className="scope-pick">
              save to
              <select value={uploadScope} disabled={memoryWriting} onChange={(e) => setUploadScope(e.target.value as "conversation" | "generic")}>
                <option value="conversation">New conversation (sub-namespace)</option>
                <option value="generic">Generic profile (who they are)</option>
              </select>
            </label>
            {uploadScope === "conversation" && (
              <input
                className="conv-label"
                type="text"
                placeholder="conversation label (optional)"
                value={convLabel}
                disabled={memoryWriting}
                onChange={(e) => setConvLabel(e.target.value)}
              />
            )}
          </div>
          <div className="upload-mem-row">
            <button
              className="btn upload-mem"
              onClick={uploadMemory}
              disabled={memoryWriting || turns.every((t) => !t.text.trim())}
            >
              {memoryWriting
                ? "Uploading to memory…"
                : uploadScope === "conversation"
                  ? "⬆ Upload as new conversation"
                  : `⬆ Upload to ${clientNamespace(client.id)}`}
            </button>
            <span className="upload-mem-hint">
              writes to Walrus Memory + anchors on Sui — then ask about it on the Customers tab
            </span>
          </div>

          {lastUploadedNs && (
            <div className="mood-panel">
              <div className="mood-title">Rate this conversation</div>
              {([
                ["agreeability", "Agreeability"],
                ["mood", "Mood"],
                ["positivity", "Positivity"],
                ["buyingIntent", "Buying intent"],
              ] as const).map(([key, label]) => (
                <label key={key} className="mood-row">
                  <span className="mood-label">{label}</span>
                  <input
                    type="range"
                    min={1}
                    max={5}
                    step={1}
                    value={mood[key]}
                    disabled={moodSaving}
                    onChange={(e) => {
                      setMood((m) => ({ ...m, [key]: Number(e.target.value) }));
                      setMoodSaved(false);
                    }}
                  />
                  <span className="mood-val">{mood[key]}/5</span>
                </label>
              ))}
              <div className="mood-actions">
                <button className="btn upload-mem" onClick={saveMood} disabled={moodSaving || moodSaved}>
                  {moodSaved ? "✅ saved" : moodSaving ? "Saving…" : "Save ratings to memory"}
                </button>
                <span className="upload-mem-hint">stored in the conversation&apos;s namespace</span>
              </div>
            </div>
          )}
        </div>
      )}
      {!client && (status === "recording" || turns.length > 0) && (
        <p className="upload-mem-hint" style={{ marginTop: 8 }}>
          Pick a customer above to enable “upload conversation to memory”.
        </p>
      )}

      {errorMsg && <div className="error">{errorMsg}</div>}

      {fileInfo && (
        <div className="file-info">
          <span>{fileInfo.name}</span>
          <span>{fileInfo.durationSec.toFixed(1)}s</span>
          {source === "file" && isRunning && (
            <span>· {Math.round(fileProgress * 100)}%</span>
          )}
        </div>
      )}

      {isRunning && (
        <div className="meter" aria-label="audio input level">
          <div
            className="meter-fill"
            style={{ width: `${Math.min(100, level * 600)}%` }}
          />
          <span className="meter-label">
            {source === "file"
              ? `playback ${Math.round(fileProgress * 100)}%`
              : level < 0.005
                ? "mic silent — check input device"
                : "mic live"}
          </span>
        </div>
      )}

      {latency && (
        <div className="latency">
          <span>buffer {latency.bufferSeconds.toFixed(2)}s</span>
          <span>inference {latency.inferenceMs.toFixed(0)}ms</span>
          <span>e2e {latency.e2eMs.toFixed(0)}ms</span>
        </div>
      )}

      {(memoryRecalled !== null || memoryWriting || memoryWritten || anchorTx) && (
        <div className="memory-strip">
          {memoryRecalled !== null && (
            <span className="mem-pill">
              🧠 {memoryRecalled > 0
                ? `recalled ${memoryRecalled} ${memoryRecalled === 1 ? "memory" : "memories"} from Walrus Memory`
                : "first call — no memory yet"}
            </span>
          )}
          {memoryWriting && (
            <span className="mem-pill">✍ storing call memory on Walrus…</span>
          )}
          {memoryWritten && (
            <span className="mem-pill mem-pill--write">
              ✅ stored {memoryWritten.saved} fact{memoryWritten.saved === 1 ? "" : "s"} on Walrus
              {memoryWritten.failed > 0 ? ` · ${memoryWritten.failed} failed` : ""}
            </span>
          )}
          {anchorTx && (
            <span className="mem-pill mem-pill--write">
              ⛓ anchored on Sui ·{" "}
              <a href={`${SUI_EXPLORER}/tx/${anchorTx.digest}`} target="_blank" rel="noreferrer">
                {anchorTx.digest.slice(0, 10)}… ↗
              </a>
            </span>
          )}
        </div>
      )}

      <div className="split">
        <TranscriptView turns={turns} isSpeaking={isSpeaking} />
        <SuggestionPanel
          suggestions={suggestions}
          asks={asks}
          hasHistory={hasHistory}
          canAsk={isRunning}
          onAsk={handleAsk}
          mode={suggestionMode}
          autoIntervalSeconds={autoIntervalSeconds}
          skill={suggestionSkill}
          onModeChange={handleModeChange}
        />
      </div>
    </div>
  );
}
