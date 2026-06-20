"use client";

import { useEffect, useRef } from "react";
import type { Turn } from "@/lib/types";

interface Props {
  turns: Turn[];
  isSpeaking: boolean;
}

function formatClock(iso: string): string {
  const d = new Date(iso);
  return (
    d.toLocaleTimeString(undefined, { hour12: false }) +
    "." +
    String(d.getMilliseconds()).padStart(3, "0")
  );
}

function formatOffset(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${String(m).padStart(2, "0")}:${s.toFixed(2).padStart(5, "0")}`;
}

function formatDuration(seconds: number): string {
  if (seconds < 1) return `${Math.round(seconds * 1000)}ms`;
  return `${seconds.toFixed(2)}s`;
}

export function TranscriptView({ turns, isSpeaking }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll on any change to the turn count or the last turn's text.
  const lastText = turns.length ? turns[turns.length - 1].text : "";
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [turns.length, lastText]);

  const empty = turns.length === 0;

  return (
    <div className="transcript" ref={scrollRef}>
      {empty && (
        <div className="placeholder">
          Press <strong>Start recording</strong> or <strong>Load audio file</strong> to begin.
        </div>
      )}

      {turns.map((turn, i) => {
        const duration =
          turn.endSec !== undefined && turn.startSec !== undefined
            ? turn.endSec - turn.startSec
            : undefined;
        const isLive = turn.status === "live";
        const speakerLabel =
          turn.speaker === "rep" ? "YOU"
          : turn.speaker === "client" ? "PROSPECT"
          : null;

        return (
          <div
            key={turn.id}
            className={`turn ${isLive ? "live" : "final"} ${turn.speaker ? `speaker-${turn.speaker}` : ""}`}
          >
            <div className="turn-meta">
              <span className="turn-index">#{i + 1}</span>
              {speakerLabel && (
                <span className={`turn-speaker turn-speaker-${turn.speaker}`}>
                  {speakerLabel}
                </span>
              )}
              {turn.startSec !== undefined && (
                <span className="turn-offset">{formatOffset(turn.startSec)}</span>
              )}
              {duration !== undefined && (
                <span className="turn-duration">{formatDuration(duration)}</span>
              )}
              {turn.inferenceMs !== undefined && (
                <span className="turn-inf">whisper {Math.round(turn.inferenceMs)}ms</span>
              )}
              {turn.finalizedAtIso && (
                <span className="turn-clock">{formatClock(turn.finalizedAtIso)}</span>
              )}
              {isLive && isSpeaking && <span className="turn-live-tag">● live</span>}
              {isLive && !isSpeaking && <span className="turn-live-tag pending">finalizing…</span>}
            </div>
            <div className="turn-text">
              {turn.text || <span className="turn-text-empty">listening…</span>}
              {isLive && <span className="cursor" />}
            </div>
          </div>
        );
      })}
    </div>
  );
}
