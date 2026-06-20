"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { AudioCapture } from "@/lib/audioCapture";
import { decodeTo16kMono } from "@/lib/fileStream";
import {
  EnrollmentStatus,
  deleteEnrollment,
  getEnrollment,
  postEnrollment,
} from "@/lib/api";

const TARGET_SECONDS = 12;
const MIN_SECONDS = 4;
const SAMPLE_RATE = 16000;

type Phase = "idle" | "recording" | "uploading" | "error";

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
    " · " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

export function VoiceEnrollment() {
  const [status, setStatus] = useState<EnrollmentStatus | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const captureRef = useRef<AudioCapture | null>(null);
  const samplesRef = useRef<Float32Array[]>([]);
  const sampleCountRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    getEnrollment()
      .then((s) => { if (!cancelled) setStatus(s); })
      .catch(() => { /* backend not up yet — silent */ });
    return () => { cancelled = true; };
  }, []);

  const stopCapture = useCallback(async () => {
    await captureRef.current?.stop();
    captureRef.current = null;
  }, []);

  const uploadSamples = useCallback(async (buf: Float32Array) => {
    setPhase("uploading");
    try {
      const next = await postEnrollment(buf);
      setStatus(next);
      setPhase("idle");
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  }, []);

  const uploadFromBuffer = useCallback(async () => {
    const total = sampleCountRef.current;
    const buf = new Float32Array(total);
    let off = 0;
    for (const chunk of samplesRef.current) {
      buf.set(chunk, off);
      off += chunk.length;
    }
    samplesRef.current = [];
    sampleCountRef.current = 0;
    await uploadSamples(buf);
  }, [uploadSamples]);

  const handleFileSelected = useCallback(
    async (file: File) => {
      setError(null);
      setPhase("uploading");
      let samples: Float32Array;
      try {
        samples = await decodeTo16kMono(file);
      } catch (e) {
        setError(
          `Could not decode audio: ${e instanceof Error ? e.message : String(e)}`,
        );
        setPhase("error");
        return;
      }
      const seconds = samples.length / SAMPLE_RATE;
      if (seconds < MIN_SECONDS) {
        setError(
          `Audio too short for enrollment (${seconds.toFixed(1)}s, need ≥ ${MIN_SECONDS}s).`,
        );
        setPhase("error");
        return;
      }
      // Backend caps at 60s; trim from the middle to skip a leading
      // silence intro and a trailing tail, which often happens with
      // recordings of meetings or dictation apps.
      const MAX_SAMPLES = 60 * SAMPLE_RATE;
      const clipped =
        samples.length > MAX_SAMPLES
          ? samples.subarray(
              Math.floor((samples.length - MAX_SAMPLES) / 2),
              Math.floor((samples.length - MAX_SAMPLES) / 2) + MAX_SAMPLES,
            )
          : samples;
      await uploadSamples(clipped);
    },
    [uploadSamples],
  );

  const startRecording = useCallback(async () => {
    setError(null);
    setSeconds(0);
    samplesRef.current = [];
    sampleCountRef.current = 0;

    const capture = new AudioCapture({
      sampleRate: SAMPLE_RATE,
      onChunk: (chunk) => {
        samplesRef.current.push(chunk.slice());
        sampleCountRef.current += chunk.length;
        const elapsed = sampleCountRef.current / SAMPLE_RATE;
        setSeconds(elapsed);
        if (elapsed >= TARGET_SECONDS) {
          // Auto-stop and upload.
          stopCapture().then(uploadFromBuffer);
        }
      },
      onError: (err) => {
        setError(err.message);
        setPhase("error");
      },
    });
    captureRef.current = capture;
    try {
      await capture.start();
      setPhase("recording");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  }, [stopCapture, uploadFromBuffer]);

  const finishEarly = useCallback(async () => {
    await stopCapture();
    if (sampleCountRef.current / SAMPLE_RATE < MIN_SECONDS) {
      setError(`Need at least ${MIN_SECONDS}s of audio (got ${(sampleCountRef.current / SAMPLE_RATE).toFixed(1)}s).`);
      setPhase("error");
      return;
    }
    await uploadFromBuffer();
  }, [stopCapture, uploadFromBuffer]);

  const cancelRecording = useCallback(async () => {
    await stopCapture();
    samplesRef.current = [];
    sampleCountRef.current = 0;
    setSeconds(0);
    setPhase("idle");
  }, [stopCapture]);

  const clearEnrollment = useCallback(async () => {
    if (!confirm("Delete your enrolled voice sample? You'll need to re-record.")) return;
    try {
      const next = await deleteEnrollment();
      setStatus(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    return () => {
      captureRef.current?.stop();
    };
  }, []);

  const isEnrolled = status?.enrolled === true;

  // Compact header strip when not expanded.
  if (!open) {
    return (
      <div className="enroll-strip">
        <span className="enroll-strip-icon" aria-hidden="true">●</span>
        <strong>Your voice:</strong>
        {isEnrolled ? (
          <span className="enroll-strip-meta">
            enrolled · {status?.duration_s?.toFixed(1)}s ·{" "}
            {status?.created_at ? fmtDate(status.created_at) : ""}
          </span>
        ) : (
          <span className="enroll-strip-meta muted">
            not enrolled — the AI can&apos;t tell you apart from the prospect
          </span>
        )}
        <button type="button" className="ck-link-btn" onClick={() => setOpen(true)}>
          {isEnrolled ? "Re-record" : "Set up"}
        </button>
        {isEnrolled && (
          <button type="button" className="ck-link-btn danger" onClick={clearEnrollment}>
            Clear
          </button>
        )}
      </div>
    );
  }

  // Expanded panel.
  const progressFrac = Math.min(1, seconds / TARGET_SECONDS);

  return (
    <div className="enroll-panel">
      <div className="enroll-head">
        <div>
          <h3>Enroll your voice</h3>
          <p className="enroll-help">
            Record ~{TARGET_SECONDS}s of yourself talking, or upload an audio
            file (≥ {MIN_SECONDS}s, any format your browser can play). For
            recording, use the same mic you&apos;ll use for calls.
          </p>
        </div>
        {phase === "idle" && (
          <button type="button" className="ck-link-btn" onClick={() => setOpen(false)}>
            Close
          </button>
        )}
      </div>

      {phase === "idle" && (
        <div className="enroll-actions">
          <button type="button" className="btn start" onClick={startRecording}>
            {isEnrolled ? "Re-record" : "Start recording"}
          </button>
          <button
            type="button"
            className="btn file"
            onClick={() => fileInputRef.current?.click()}
          >
            Upload audio file
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
          {isEnrolled && (
            <button type="button" className="btn-ghost" onClick={clearEnrollment}>
              Clear current
            </button>
          )}
        </div>
      )}

      {phase === "recording" && (
        <div className="enroll-recording">
          <div className="enroll-progress">
            <div className="enroll-progress-fill" style={{ width: `${progressFrac * 100}%` }} />
          </div>
          <p className="enroll-time">
            {seconds.toFixed(1)}s / {TARGET_SECONDS}s — keep talking
          </p>
          <div className="enroll-actions">
            <button
              type="button"
              className="btn-primary"
              onClick={finishEarly}
              disabled={seconds < MIN_SECONDS}
              title={
                seconds < MIN_SECONDS
                  ? `Need ${MIN_SECONDS}s minimum`
                  : "Stop and upload now"
              }
            >
              Done
            </button>
            <button type="button" className="btn-ghost" onClick={cancelRecording}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {phase === "uploading" && <p className="enroll-help">Uploading and computing your voice print…</p>}

      {error && (
        <div className="error">
          {error}
          <button
            type="button"
            className="ck-link-btn"
            onClick={() => { setError(null); setPhase("idle"); }}
          >
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}
