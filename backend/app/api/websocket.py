"""WebSocket endpoint that streams raw PCM in and JSON transcripts out.

Wire protocol (see docs/api.md for the full spec):

  Client → Server
    ─ JSON  {"type":"start","sample_rate":16000,
             "client": {"name":"Acme Corp","phone":"+1...","email":"..."}}
    ─ Bytes Float32 little-endian PCM samples (mono)
    ─ JSON  {"type":"stop"}
    ─ JSON  {"type":"ping"}

  Server → Client
    ─ {"type":"ready", session_id, server_ts, client?: {id,name,...}}
    ─ {"type":"speech_start", turn_start_ts}                ─┐
    ─ {"type":"turn_end",     turn_start_ts, turn_end_ts}   ─┘ M3
    ─ {"type":"partial", text, segments[], buffer_seconds, inference_ms, server_ts}
    ─ {"type":"final",   text, segments[], buffer_seconds, inference_ms, server_ts, turn_id}
    ─ {"type":"suggestion_start", turn_id}                  ─┐
    ─ {"type":"suggestion_token", text}                      │ M4
    ─ {"type":"suggestion_end",   turn_id, full_text}       ─┘
    ─ {"type":"stopped"}
    ─ {"type":"error","message":"..."}
"""
from __future__ import annotations

import asyncio
import json
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import numpy as np
from fastapi import WebSocket, WebSocketDisconnect

from app.core.config import get_settings
from app.core.logger import get_logger
from app.db import repository as repo
from app.services.audio_buffer import AudioBuffer
from app.services import speaker_id
from app.services.suggestions import (
    DEFAULT_SKILL,
    SuggestionService,
    build_history_block,
    coerce_skill,
)
from app.services.transcription import Segment, TranscriptionService
from app.services.turn_detector import TurnDetector

log = get_logger(__name__)


# Auto-suggestion mode + cadence. The frontend sends one of these literal
# values; anything else falls back to the default. `interval=0` means "fire
# on every committed turn" (no throttle).
_VALID_MODES = ("auto", "manual")
_VALID_INTERVALS = (0.0, 60.0, 120.0, 300.0)


def _coerce_mode(value: Any, default: str = "auto") -> str:
    if isinstance(value, str) and value in _VALID_MODES:
        return value
    return default


def _coerce_interval(value: Any, default: float = 0.0) -> float:
    try:
        v = float(value)
    except (TypeError, ValueError):
        return default
    return v if v in _VALID_INTERVALS else default


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def _segments_to_dict(segments: List[Segment], time_offset: float) -> List[Dict[str, Any]]:
    return [
        {
            "text": s.text,
            "start": round(s.start + time_offset, 3),
            "end": round(s.end + time_offset, 3),
        }
        for s in segments
        if s.text and s.no_speech_prob < 0.6
    ]


def register(app, transcription: TranscriptionService) -> None:
    """Wire the WS route. We pass the model in instead of relying on globals
    so tests can swap in a fake."""
    settings = get_settings()
    suggestions = SuggestionService()

    @app.websocket("/ws/transcribe")
    async def transcribe_ws(ws: WebSocket) -> None:  # noqa: C901  — flat is fine here
        await ws.accept()
        session_id = uuid.uuid4().hex[:8]
        log.info("[%s] client connected (vad=%s)", session_id, settings.vad_enabled)

        buf = AudioBuffer(
            sample_rate=settings.sample_rate,
            max_seconds=settings.max_buffer_seconds,
        )

        turn_detector: Optional[TurnDetector] = None
        if settings.vad_enabled:
            turn_detector = TurnDetector(
                sample_rate=settings.sample_rate,
                threshold=settings.vad_threshold,
                neg_threshold=settings.vad_neg_threshold,
                min_speech_ms=settings.vad_min_speech_ms,
                min_silence_ms=settings.vad_min_silence_ms,
            )

        committed_offset = 0.0
        infer_lock = asyncio.Lock()
        session_started = time.perf_counter()

        # Set after the first `start` frame.
        client_record: Optional[Dict[str, Any]] = None
        history_block: Optional[str] = None
        # Persisted view of the session's committed turns. Used to build
        # context for each Claude suggestion.
        committed_turns: List[Dict[str, Any]] = []
        # Suggestion mode + cadence. Updated by `start.mode` and `set_mode`
        # control frames. interval=0.0 means "fire on every turn".
        mode: str = "auto"
        auto_interval_seconds: float = 0.0
        last_auto_fired_at: Optional[float] = None
        # Persona/skill — swaps the system prompt at suggestion time.
        skill: str = DEFAULT_SKILL

        # Rep voice print, loaded once at session start (if enrolled). Used
        # to label each finalized turn as 'rep' or 'client'.
        rep_embedding: Optional[np.ndarray] = None
        rep_voice_row = repo.get_rep_voice_print()
        if rep_voice_row is not None:
            try:
                rep_embedding = np.frombuffer(
                    rep_voice_row["embedding"], dtype=np.float32
                )
                # Reject stale L2-normalized fingerprints from the previous
                # speaker_id format. Current format stores F0 in semitones
                # (mean ≈ 30-80) so its L2 norm is well above 1.
                if (
                    rep_embedding.shape[0] != 29
                    or float(np.linalg.norm(rep_embedding)) < 5.0
                ):
                    log.warning(
                        "[%s] rep voice print is stale (norm=%.3f) — "
                        "skipping diarization. Please re-enroll.",
                        session_id,
                        float(np.linalg.norm(rep_embedding)) if rep_embedding.size else 0.0,
                    )
                    rep_embedding = None
                else:
                    log.info(
                        "[%s] rep voice print loaded (%d-dim, enrolled %s, norm=%.2f)",
                        session_id,
                        rep_embedding.shape[0],
                        rep_voice_row.get("created_at"),
                        float(np.linalg.norm(rep_embedding)),
                    )
            except Exception as exc:  # pragma: no cover  — defensive
                log.warning("[%s] failed to load rep voice print: %s", session_id, exc)
                rep_embedding = None
        diarization_timbre_thr, diarization_pitch_thr = speaker_id.thresholds_from_settings()
        # Background tasks we kick off (suggestions, summaries) so we can
        # await them on stop instead of orphaning.
        background: List[asyncio.Task] = []

        repo.create_session(session_id, client_id=None)

        await ws.send_json({"type": "ready", "session_id": session_id, "server_ts": _now_iso()})

        async def safe_send(payload: Dict[str, Any]) -> None:
            try:
                await ws.send_json(payload)
            except Exception:
                pass

        async def stream_user_query(prompt: str, ask_id: str) -> None:
            """Stream a Claude response to a free-text question from the rep.

            Sends ``ask_start`` / ``ask_token`` / ``ask_end``. Echoes the
            client-supplied ``ask_id`` on every event so the frontend can
            route tokens to the correct chat bubble.
            """
            if not suggestions.enabled:
                await safe_send(
                    {
                        "type": "ask_end",
                        "ask_id": ask_id,
                        "full_text": "(copilot disabled — set SUGGESTIONS_ENABLED=true and configure OPENROUTER_API_KEY or a local Ollama server)",
                        "error": True,
                    }
                )
                return

            await safe_send({"type": "ask_start", "ask_id": ask_id, "prompt": prompt})
            buffer: List[str] = []

            async def on_token(text: str) -> None:
                buffer.append(text)
                await safe_send({"type": "ask_token", "ask_id": ask_id, "text": text})

            try:
                result = await suggestions.stream_user_query(
                    prompt=prompt,
                    history_block=history_block,
                    current_turns=committed_turns,
                    on_token=on_token,
                    skill=skill,
                )
            except Exception as exc:
                await safe_send(
                    {
                        "type": "ask_end",
                        "ask_id": ask_id,
                        "full_text": f"(error: {exc})",
                        "error": True,
                    }
                )
                return

            full = result.text or "".join(buffer)
            # Persist as a suggestion row so it shows up in /sessions/[id].
            # turn_id=None marks it as a user-initiated query.
            if full:
                repo.insert_suggestion(
                    session_id=session_id,
                    turn_id=None,
                    text=full,
                    prompt=result.prompt or prompt,
                    system_prompt=result.system_prompt,
                    model=suggestions.model,
                )
            await safe_send(
                {"type": "ask_end", "ask_id": ask_id, "full_text": full}
            )

        async def stream_suggestion_for_turn(turn_id: int) -> None:
            if not suggestions.enabled:
                return
            await safe_send({"type": "suggestion_start", "turn_id": turn_id})
            buffer = []

            async def on_token(text: str) -> None:
                buffer.append(text)
                await safe_send({"type": "suggestion_token", "text": text})

            try:
                result = await suggestions.stream_suggestion(
                    history_block=history_block,
                    current_turns=committed_turns,
                    on_token=on_token,
                    skill=skill,
                )
            except Exception as exc:
                await safe_send({"type": "error", "message": f"suggestion failed: {exc}"})
                return

            full = result.text or "".join(buffer)
            if full:
                repo.insert_suggestion(
                    session_id=session_id,
                    turn_id=turn_id,
                    text=full,
                    prompt=result.prompt,
                    system_prompt=result.system_prompt,
                    model=suggestions.model,
                )
            await safe_send(
                {"type": "suggestion_end", "turn_id": turn_id, "full_text": full}
            )

        async def run_inference(*, finalize: bool, turn_offset: float) -> None:
            nonlocal committed_offset
            async with infer_lock:
                snapshot = buf.snapshot()
                if snapshot.size < int(0.3 * settings.sample_rate):
                    if finalize:
                        buf.reset()
                    return

                t_start = time.perf_counter()
                result = await asyncio.to_thread(transcription.transcribe, snapshot)
                buffer_seconds = snapshot.size / settings.sample_rate
                end_to_end_ms = (time.perf_counter() - t_start) * 1000.0

                segments = _segments_to_dict(result.segments, turn_offset)
                joined = " ".join(seg["text"] for seg in segments).strip()

                turn_id: Optional[int] = None
                turn_speaker: str = "client"
                turn_speaker_sim: Optional[float] = None
                if finalize and joined:
                    t_end = turn_offset + buffer_seconds
                    if rep_embedding is not None:
                        try:
                            turn_speaker, turn_speaker_sim = await asyncio.to_thread(
                                speaker_id.classify_turn,
                                snapshot,
                                rep_embedding=rep_embedding,
                                sample_rate=settings.sample_rate,
                                timbre_threshold=diarization_timbre_thr,
                                pitch_threshold_st=diarization_pitch_thr,
                            )
                            log.info(
                                "[%s] speaker=%s timbre_cos=%s",
                                session_id,
                                turn_speaker,
                                "%.3f" % turn_speaker_sim if turn_speaker_sim is not None else "n/a",
                            )
                        except Exception as exc:
                            log.warning(
                                "[%s] speaker_id failed, falling back to client: %s",
                                session_id,
                                exc,
                            )
                            turn_speaker, turn_speaker_sim = "client", None
                    turn_id = repo.insert_turn(
                        session_id=session_id,
                        speaker=turn_speaker,
                        text=joined,
                        t_start=round(turn_offset, 3),
                        t_end=round(t_end, 3),
                    )
                    committed_turns.append(
                        {
                            "speaker": turn_speaker,
                            "text": joined,
                            "t_start": round(turn_offset, 3),
                            "t_end": round(t_end, 3),
                        }
                    )

                payload: Dict[str, Any] = {
                    "type": "final" if finalize else "partial",
                    "text": joined,
                    "segments": segments,
                    "buffer_seconds": round(buffer_seconds, 3),
                    "inference_ms": round(result.inference_ms, 1),
                    "end_to_end_ms": round(end_to_end_ms, 1),
                    "server_ts": _now_iso(),
                }
                if turn_id is not None:
                    payload["turn_id"] = turn_id
                    payload["speaker"] = turn_speaker
                    if turn_speaker_sim is not None:
                        payload["speaker_similarity"] = round(turn_speaker_sim, 3)
                await safe_send(payload)

                log.info(
                    "[%s] %s buffer=%.2fs inf=%.0fms e2e=%.0fms text=%r",
                    session_id,
                    "FINAL " if finalize else "partial",
                    buffer_seconds,
                    result.inference_ms,
                    end_to_end_ms,
                    joined[:80],
                )

                if finalize:
                    nonlocal last_auto_fired_at
                    committed_offset += buffer_seconds
                    buf.trim(snapshot.size)
                    # Auto-suggest only on prospect turns. The rep doesn't
                    # need coaching on what they themselves just said.
                    if (
                        turn_id is not None
                        and suggestions.enabled
                        and mode == "auto"
                        and turn_speaker != "rep"
                    ):
                        now = time.perf_counter()
                        ready = (
                            auto_interval_seconds == 0.0
                            or last_auto_fired_at is None
                            or (now - last_auto_fired_at) >= auto_interval_seconds
                        )
                        if ready:
                            last_auto_fired_at = now
                            background.append(
                                asyncio.create_task(stream_suggestion_for_turn(turn_id))
                            )

        async def on_audio_chunk(samples: np.ndarray) -> None:
            buf.append(samples)

            if turn_detector is not None:
                events = turn_detector.process(samples)
                for ev in events:
                    if ev.type == "speech_start":
                        await safe_send(
                            {
                                "type": "speech_start",
                                "turn_start": round(ev.timestamp, 3),
                                "server_ts": _now_iso(),
                            }
                        )
                        log.info("[%s] turn START at %.2fs", session_id, ev.timestamp)
                    elif ev.type == "turn_end":
                        turn_start = (
                            turn_detector.current_turn_start
                            if turn_detector.current_turn_start is not None
                            else max(0.0, ev.timestamp - buf.stats().seconds)
                        )
                        await safe_send(
                            {
                                "type": "turn_end",
                                "turn_start": round(turn_start, 3),
                                "turn_end": round(ev.timestamp, 3),
                                "server_ts": _now_iso(),
                            }
                        )
                        log.info(
                            "[%s] turn END   at %.2fs (turn was %.2fs)",
                            session_id,
                            ev.timestamp,
                            ev.timestamp - turn_start,
                        )
                        asyncio.create_task(
                            run_inference(finalize=True, turn_offset=committed_offset)
                        )
                        return

            stats = buf.stats()
            should_partial = buf.seconds_since_last_inference() >= settings.inference_interval_seconds
            if not should_partial:
                return

            force_final = stats.seconds >= settings.max_buffer_seconds * 0.85
            if force_final and turn_detector is not None:
                log.warning(
                    "[%s] forcing finalize: turn ran past safety cap (%.2fs)",
                    session_id,
                    stats.seconds,
                )
            asyncio.create_task(
                run_inference(finalize=force_final, turn_offset=committed_offset)
            )

        async def handle_start(ctrl: Dict[str, Any]) -> None:
            nonlocal client_record, history_block, mode, auto_interval_seconds, skill

            mode = _coerce_mode(ctrl.get("mode"), default=mode)
            auto_interval_seconds = _coerce_interval(
                ctrl.get("auto_interval_seconds"), default=auto_interval_seconds
            )
            skill = coerce_skill(ctrl.get("skill"), default=skill)
            log.info(
                "[%s] mode=%s auto_interval=%ss skill=%s",
                session_id,
                mode,
                int(auto_interval_seconds),
                skill,
            )

            client_sr = int(ctrl.get("sample_rate") or settings.sample_rate)
            if client_sr != settings.sample_rate:
                await safe_send(
                    {
                        "type": "error",
                        "message": (
                            f"sample_rate mismatch: client={client_sr} server={settings.sample_rate}"
                        ),
                    }
                )

            client_info = ctrl.get("client")
            if isinstance(client_info, dict):
                cid = client_info.get("id")
                if isinstance(cid, int):
                    client_record = repo.get_client(cid)
                elif client_info.get("name"):
                    client_record = repo.upsert_client(
                        name=str(client_info["name"]),
                        phone=client_info.get("phone") or None,
                        email=client_info.get("email") or None,
                        notes=client_info.get("notes") or None,
                    )
                if client_record:
                    repo.create_session(session_id, client_id=int(client_record["id"]))
                    history = repo.history_for_client(
                        int(client_record["id"]),
                        summary_limit=settings.suggestion_history_summaries,
                    )
                    history_block = build_history_block(history, client=client_record)
                    # MemWal memory is recalled by the frontend (per-client
                    # namespace) and arrives as a prebuilt block on the start
                    # frame — fold it into the copilot context next to the
                    # SQLite profile/history so suggestions are grounded.
                    mem = ctrl.get("memory")
                    if isinstance(mem, str) and mem.strip():
                        history_block = (
                            f"{history_block}\n\n{mem}" if history_block else mem
                        )
                    await safe_send(
                        {
                            "type": "client_attached",
                            "client": client_record,
                            "has_history": history_block is not None,
                            "server_ts": _now_iso(),
                        }
                    )
                    log.info(
                        "[%s] attached to client %s (history=%s)",
                        session_id,
                        client_record.get("name"),
                        bool(history_block),
                    )
            log.info("[%s] start sr=%d", session_id, client_sr)

        async def finalize_session() -> None:
            # Wait for any in-flight suggestion tasks before summarizing.
            if background:
                await asyncio.gather(*background, return_exceptions=True)

            summary: Optional[str] = None
            if suggestions.enabled and committed_turns:
                summary = await suggestions.summarize_session(turns=committed_turns)
            repo.end_session(session_id, summary=summary)
            # NOTE: long-term memory write is now done by the frontend via the
            # MemWal SDK (analyze → per-client namespace) on `stopped`. The
            # backend only persists the SQLite session summary above.

        try:
            while True:
                msg = await ws.receive()
                if msg["type"] == "websocket.disconnect":
                    raise WebSocketDisconnect()

                if (data := msg.get("bytes")) is not None:
                    if not data:
                        continue
                    samples = np.frombuffer(data, dtype=np.float32)
                    await on_audio_chunk(samples)
                    continue

                if (text := msg.get("text")) is not None:
                    try:
                        ctrl = json.loads(text)
                    except json.JSONDecodeError:
                        await safe_send({"type": "error", "message": "invalid json control frame"})
                        continue

                    ctype = ctrl.get("type")
                    if ctype == "start":
                        await handle_start(ctrl)
                    elif ctype == "stop":
                        log.info("[%s] stop requested, flushing", session_id)
                        await run_inference(finalize=True, turn_offset=committed_offset)
                        await finalize_session()
                        await safe_send({"type": "stopped", "server_ts": _now_iso()})
                        break
                    elif ctype == "ping":
                        await safe_send({"type": "pong", "server_ts": _now_iso()})
                    elif ctype == "set_mode":
                        mode = _coerce_mode(ctrl.get("mode"), default=mode)
                        auto_interval_seconds = _coerce_interval(
                            ctrl.get("auto_interval_seconds"),
                            default=auto_interval_seconds,
                        )
                        if "skill" in ctrl:
                            skill = coerce_skill(ctrl.get("skill"), default=skill)
                        last_auto_fired_at = None
                        log.info(
                            "[%s] set_mode mode=%s auto_interval=%ss skill=%s",
                            session_id,
                            mode,
                            int(auto_interval_seconds),
                            skill,
                        )
                        await safe_send(
                            {
                                "type": "mode_changed",
                                "mode": mode,
                                "auto_interval_seconds": auto_interval_seconds,
                                "skill": skill,
                                "server_ts": _now_iso(),
                            }
                        )
                    elif ctype == "ask":
                        prompt = (ctrl.get("prompt") or "").strip()
                        ask_id = str(ctrl.get("ask_id") or uuid.uuid4().hex[:8])
                        if not prompt:
                            await safe_send(
                                {"type": "error", "message": "ask: empty prompt"}
                            )
                        else:
                            log.info("[%s] ask id=%s prompt=%r", session_id, ask_id, prompt[:80])
                            background.append(
                                asyncio.create_task(stream_user_query(prompt, ask_id))
                            )
                    else:
                        await safe_send({"type": "error", "message": f"unknown control type: {ctype}"})

        except WebSocketDisconnect:
            log.info("[%s] disconnected after %.1fs", session_id, time.perf_counter() - session_started)
            try:
                await finalize_session()
            except Exception as exc:  # pragma: no cover
                log.warning("[%s] finalize on disconnect failed: %s", session_id, exc)
        except Exception as exc:  # pragma: no cover  — defensive
            log.exception("[%s] handler crashed: %s", session_id, exc)
            try:
                await safe_send({"type": "error", "message": str(exc)})
            except Exception:
                pass
