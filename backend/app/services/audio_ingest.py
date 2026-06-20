"""Batch ingestion of a recorded audio file into a client's session history.

The flow:
  1.  Decode the uploaded file → 16 kHz Float32 mono using PyAV (already
      a dep — pulled in by faster-whisper).
  2.  Run ``TranscriptionService.transcribe`` on the full buffer. faster-
      whisper's built-in VAD gives us speech segments with timestamps.
  3.  Group consecutive segments into turns by silence gaps. For each
      turn, slice the original PCM and (if the rep is enrolled) run
      ``speaker_id.classify_turn`` to label rep vs client.
  4.  Persist as a session linked to the client. Each turn is one row in
      the ``turns`` table.
  5.  If the suggestions service is enabled, generate a 2–4 sentence
      summary the same way live calls do. Store on the session row.
  6.  Mark the upload_jobs row done (or error) and link the session.

Designed to run as a background task scheduled by the REST endpoint.
Progress is written back to the upload_jobs row so the frontend can
poll it.
"""
from __future__ import annotations

import asyncio
import sqlite3
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

import av
import numpy as np

from app.core.config import get_settings
from app.core.logger import get_logger
from app.db import repository as repo
from app.services import speaker_id
from app.services.suggestions import SuggestionService
from app.services.transcription import Segment, TranscriptionService

log = get_logger(__name__)


# Turn-grouping: consecutive whisper segments with a gap below this are
# considered the same speaker turn. Above this we close the turn so
# diarization gets a clean chunk to score.
TURN_GAP_SECONDS = 0.7
# Skip whisper segments where the model thinks "no speech" probability is
# above this. Same heuristic used in the live websocket pipeline.
SEGMENT_NO_SPEECH_REJECT = 0.6


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def _new_session_id() -> str:
    """8-char hex, same shape as the live websocket sessions."""
    return _now_iso().split(".")[1][:8]  # microseconds digits — unique enough


def decode_to_16k_mono(file_path: str) -> np.ndarray:
    """Decode an arbitrary audio file to 16 kHz Float32 mono via PyAV.

    Raises whatever PyAV raises on bad input — caller wraps that into a
    job error.
    """
    chunks: List[np.ndarray] = []
    container = av.open(file_path)
    try:
        stream = next((s for s in container.streams if s.type == "audio"), None)
        if stream is None:
            raise ValueError("file has no audio stream")
        resampler = av.AudioResampler(format="flt", layout="mono", rate=16000)
        for frame in container.decode(stream):
            for resampled in resampler.resample(frame):
                arr = resampled.to_ndarray()
                chunks.append(arr.flatten().astype(np.float32, copy=False))
        # Flush the resampler.
        for resampled in resampler.resample(None):
            arr = resampled.to_ndarray()
            chunks.append(arr.flatten().astype(np.float32, copy=False))
    finally:
        container.close()
    return np.concatenate(chunks) if chunks else np.zeros(0, dtype=np.float32)


def _group_segments_into_turns(
    segments: List[Segment],
    gap_seconds: float = TURN_GAP_SECONDS,
) -> List[Dict[str, Any]]:
    """Collapse whisper segments into turns separated by silences.

    Each returned turn is a dict with start, end, text, and segments.
    """
    turns: List[Dict[str, Any]] = []
    cur: Optional[Dict[str, Any]] = None
    for s in segments:
        if not s.text.strip():
            continue
        if s.no_speech_prob > SEGMENT_NO_SPEECH_REJECT:
            continue
        if cur is None or (s.start - cur["end"]) > gap_seconds:
            if cur is not None:
                turns.append(cur)
            cur = {
                "start": s.start,
                "end": s.end,
                "text": s.text.strip(),
                "segments": [s],
            }
        else:
            cur["end"] = s.end
            cur["text"] = (cur["text"] + " " + s.text.strip()).strip()
            cur["segments"].append(s)
    if cur is not None:
        turns.append(cur)
    return turns


def _load_rep_embedding() -> Optional[np.ndarray]:
    row = repo.get_rep_voice_print()
    if row is None:
        return None
    try:
        emb = np.frombuffer(row["embedding"], dtype=np.float32)
        if emb.shape[0] != 29 or float(np.linalg.norm(emb)) < 5.0:
            log.warning("ingest: stale enrollment, skipping diarization")
            return None
        return emb
    except Exception as exc:
        log.warning("ingest: failed to load rep voice print: %s", exc)
        return None


async def process_upload_job(
    job_id: int,
    *,
    transcription: TranscriptionService,
    suggestions: SuggestionService,
) -> None:
    """Worker that drives a single upload_jobs row to completion.

    Reports progress + phase back to the row as it works. On failure
    sets status='error' with the exception message.
    """
    settings = get_settings()
    job = repo.get_upload_job(job_id)
    if job is None:
        log.warning("ingest: job %s missing, abort", job_id)
        return

    storage_path = job.get("storage_path")
    client_id = int(job["client_id"])
    if not storage_path:
        repo.update_upload_job(
            job_id,
            status="error",
            error="storage_path missing on job row",
            finished_at=_now_iso(),
        )
        return
    abs_path = str(Path(settings.attachments_dir) / storage_path)

    try:
        # ── 1. decode ───────────────────────────────────────────────────
        repo.update_upload_job(job_id, status="running", phase="decoding", progress=0.02)
        audio = await asyncio.to_thread(decode_to_16k_mono, abs_path)
        duration_s = float(len(audio) / settings.sample_rate)
        if duration_s < 1.0:
            raise ValueError(f"decoded audio too short: {duration_s:.2f}s")
        repo.update_upload_job(
            job_id, phase="decoding", progress=0.10, duration_s=duration_s
        )
        log.info("ingest[%s]: decoded %.1fs of audio", job_id, duration_s)

        # ── 2. transcribe (full buffer; whisper VAD does the heavy lifting) ──
        repo.update_upload_job(job_id, phase="transcribing", progress=0.15)
        t0 = time.perf_counter()
        result = await asyncio.to_thread(transcription.transcribe, audio)
        log.info(
            "ingest[%s]: whisper produced %d segments in %.1fs",
            job_id,
            len(result.segments),
            time.perf_counter() - t0,
        )
        repo.update_upload_job(job_id, phase="transcribing", progress=0.65)

        turns_raw = _group_segments_into_turns(result.segments)
        if not turns_raw:
            raise ValueError("no speech detected in audio")

        # ── 3. create session row ───────────────────────────────────────
        session_id = _new_session_id()
        repo.create_session(session_id, client_id=client_id)

        # ── 4. diarize + persist each turn ─────────────────────────────
        repo.update_upload_job(job_id, phase="diarizing", progress=0.70)
        rep_embedding = _load_rep_embedding()
        timbre_thr, pitch_thr = speaker_id.thresholds_from_settings()
        committed_turns: List[Dict[str, Any]] = []
        sr = settings.sample_rate
        n_turns = len(turns_raw)
        for i, turn in enumerate(turns_raw):
            start_idx = max(0, int(turn["start"] * sr))
            end_idx = min(len(audio), int(turn["end"] * sr))
            chunk = audio[start_idx:end_idx]
            speaker = "client"
            if rep_embedding is not None and chunk.size > 0:
                try:
                    speaker, _sim = await asyncio.to_thread(
                        speaker_id.classify_turn,
                        chunk,
                        rep_embedding=rep_embedding,
                        sample_rate=sr,
                        timbre_threshold=timbre_thr,
                        pitch_threshold_st=pitch_thr,
                    )
                except Exception as exc:
                    log.warning("ingest[%s]: diarize failed for turn %d: %s",
                                job_id, i, exc)
                    speaker = "client"
            db_turn_id = repo.insert_turn(
                session_id=session_id,
                speaker=speaker,
                text=turn["text"],
                t_start=round(float(turn["start"]), 3),
                t_end=round(float(turn["end"]), 3),
            )
            committed_turns.append({
                "speaker": speaker,
                "text": turn["text"],
                "t_start": float(turn["start"]),
                "t_end": float(turn["end"]),
                "id": db_turn_id,
            })
            # Smooth progress over the diarization phase.
            frac = 0.70 + 0.20 * ((i + 1) / n_turns)
            repo.update_upload_job(job_id, phase="diarizing", progress=frac)

        # ── 5. summarize (Ollama, if enabled) ──────────────────────────
        summary: Optional[str] = None
        if suggestions.enabled and committed_turns:
            repo.update_upload_job(job_id, phase="summarizing", progress=0.92)
            try:
                summary = await suggestions.summarize_session(turns=committed_turns)
            except Exception as exc:
                log.warning("ingest[%s]: summarize failed: %s", job_id, exc)

        repo.end_session(session_id, summary=summary)

        # ── 6. mark job done ───────────────────────────────────────────
        repo.update_upload_job(
            job_id,
            status="done",
            phase=None,
            progress=1.0,
            session_id=session_id,
            finished_at=_now_iso(),
        )
        log.info(
            "ingest[%s]: session=%s turns=%d summary=%s",
            job_id,
            session_id,
            len(committed_turns),
            "yes" if summary else "no",
        )
    except Exception as exc:
        log.exception("ingest[%s]: failed: %s", job_id, exc)
        try:
            repo.update_upload_job(
                job_id,
                status="error",
                error=str(exc)[:500],
                finished_at=_now_iso(),
            )
        except sqlite3.Error:
            log.exception("ingest[%s]: failed to mark job as error", job_id)
