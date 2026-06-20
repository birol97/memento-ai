"""Live phone flow:  Phone Call → Twilio → WebSocket → Live Audio → STT → Memento.

Twilio Media Streams opens a WebSocket to /ws/twilio and streams the call audio
(base64 μ-law, 8 kHz) in real time. We turn it into 16 kHz PCM and feed the
existing Whisper + VAD pipeline (no external STT key). On call end the transcript
is written to the caller's Walrus memory namespace via /api/ingest.

(Python 3.13 removed `audioop`, so μ-law→PCM is a tiny numpy step. To skip even
that, point the stream at a streaming STT like Deepgram instead — same WS shape.)
"""
from __future__ import annotations

import asyncio
import base64
import json
import os
import time
import wave
from pathlib import Path
from xml.sax.saxutils import escape, quoteattr

import httpx
import numpy as np
from fastapi import Request, Response, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse

from app.api.calls_stream import publish
from app.core.config import get_settings
from app.core.logger import get_logger
from app.services.audio_buffer import AudioBuffer
from app.services.transcription import TranscriptionService
from app.services.turn_detector import TurnDetector

log = get_logger(__name__)


def _ulaw_table() -> np.ndarray:
    t = np.zeros(256, dtype=np.int16)
    for i in range(256):
        u = ~i & 0xFF
        sign = u & 0x80
        exp = (u >> 4) & 0x07
        man = u & 0x0F
        mag = (((man << 3) + 0x84) << exp) - 0x84
        t[i] = -mag if sign else mag
    return t


_ULAW = _ulaw_table()


def _ulaw_to_f32_16k(mulaw: bytes) -> np.ndarray:
    """μ-law 8 kHz bytes → float32 [-1,1], upsampled to 16 kHz (x2 linear)."""
    if not mulaw:
        return np.zeros(0, dtype=np.float32)
    pcm = _ULAW[np.frombuffer(mulaw, dtype=np.uint8)].astype(np.float32) / 32768.0
    n = pcm.shape[0]
    if n == 0:
        return pcm
    return np.interp(np.arange(2 * n) / 2.0, np.arange(n), pcm).astype(np.float32)


RECORDINGS_DIR = Path(os.environ.get("RECORDINGS_DIR", "recordings"))


def _write_wav(mulaw: bytes, call_sid: str) -> Path | None:
    """Write the full call's μ-law audio as an 8 kHz/mono/PCM16 .wav (reuses _ULAW)."""
    if not mulaw:
        return None
    RECORDINGS_DIR.mkdir(parents=True, exist_ok=True)
    pcm = _ULAW[np.frombuffer(mulaw, dtype=np.uint8)].astype("<i2")  # int16 PCM @ 8 kHz
    path = RECORDINGS_DIR / f"{call_sid or 'call'}.wav"
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(8000)
        w.writeframes(pcm.tobytes())
    return path


async def _post_recording(path: Path, frm: str, call_sid: str) -> None:
    """Relay the final .wav to RECORDING_RELAY_URL (best-effort, multipart)."""
    url = os.environ.get("RECORDING_RELAY_URL")
    if not url:
        return
    headers = {}
    secret = os.environ.get("INGEST_SECRET")
    if secret:
        headers["x-ingest-secret"] = secret
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            r = await client.post(
                url,
                headers=headers,
                files={"audio": (path.name, path.read_bytes(), "audio/wav")},
                data={"from": frm, "callSid": call_sid},
            )
            log.info("[twilio] recording relay %s -> %s", r.status_code, r.text[:120])
    except Exception as exc:  # pragma: no cover
        log.warning("[twilio] recording relay failed: %s", exc)


async def _post_to_ingest(frm: str, text: str) -> None:
    url = os.environ.get("INGEST_URL", "http://localhost:3000/api/ingest")
    headers = {"Content-Type": "application/json"}
    secret = os.environ.get("INGEST_SECRET")
    if secret:
        headers["x-ingest-secret"] = secret
    try:
        async with httpx.AsyncClient(timeout=180.0) as client:
            r = await client.post(url, headers=headers, json={"channel": "call", "from": frm, "text": text})
            log.info("[twilio] ingest %s -> %s", r.status_code, r.text[:160])
    except Exception as exc:  # pragma: no cover
        log.warning("[twilio] ingest post failed: %s", exc)


def register_twilio(app, transcription: TranscriptionService) -> None:
    settings = get_settings()

    @app.post("/twilio/call")
    async def twilio_call(request: Request) -> Response:
        """Place an OUTBOUND call from the app via Twilio's REST API. Twilio dials
        `to`, and on answer fetches /twilio/voice (which starts the media stream)."""
        try:
            body = await request.json()
        except Exception:
            body = {}
        to = str(body.get("to") or "").strip()
        sid = os.environ.get("TWILIO_ACCOUNT_SID")
        tok = os.environ.get("TWILIO_AUTH_TOKEN")
        num = os.environ.get("TWILIO_NUMBER")
        base = os.environ.get("PUBLIC_BASE_URL")  # https tunnel/host serving /twilio/voice
        if not (sid and tok and num):
            return JSONResponse({"ok": False, "error": "Twilio not configured (set TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_NUMBER)"}, status_code=400)
        if not base:
            return JSONResponse({"ok": False, "error": "set PUBLIC_BASE_URL to your public https host"}, status_code=400)
        if not to:
            return JSONResponse({"ok": False, "error": "missing 'to' number"}, status_code=400)
        try:
            async with httpx.AsyncClient(timeout=20.0) as client:
                r = await client.post(
                    f"https://api.twilio.com/2010-04-01/Accounts/{sid}/Calls.json",
                    data={"To": to, "From": num, "Url": f"{base}/twilio/voice"},
                    auth=(sid, tok),
                )
            if r.status_code >= 300:
                return JSONResponse({"ok": False, "error": r.text[:200]}, status_code=502)
            return JSONResponse({"ok": True, "callSid": r.json().get("sid"), "to": to})
        except Exception as exc:
            return JSONResponse({"ok": False, "error": str(exc)}, status_code=502)

    @app.api_route("/twilio/dial", methods=["GET", "POST"])
    async def twilio_dial(request: Request) -> Response:
        """TwiML for the IN-APP softphone (Twilio Voice SDK).

        Point your TwiML App's *Voice Request URL* at {PUBLIC_BASE_URL}/twilio/dial.
        When the browser places a call, Twilio fetches this and we <Dial> the
        customer's number, using the rep's Twilio number as caller ID. Without a
        valid TwiML here the gateway hangs up the call (error 31005)."""
        form = await request.form()
        to = str(form.get("To") or request.query_params.get("To") or "").strip()
        caller = str(form.get("From") or os.environ.get("TWILIO_NUMBER") or "").strip()
        # session_id correlates this specific call's transcript to its browser panel,
        # so many simultaneous calls/conferences never cross streams.
        session_id = str(form.get("session_id") or request.query_params.get("session_id") or "").strip()
        if not to:
            twiml = (
                '<?xml version="1.0" encoding="UTF-8"?>'
                "<Response><Say>No number to dial.</Say></Response>"
            )
            return Response(content=twiml, media_type="text/xml")

        # Fork BOTH legs' audio to our transcriber in the background (<Start><Stream>
        # does not interrupt the live two-way call), tagged with this session_id.
        stream_block = ""
        wss = os.environ.get("TWILIO_STREAM_WSS")
        if not wss:
            host = request.headers.get("host", "")
            wss = f"wss://{host}/ws/twilio" if host else ""
        if wss:
            params = (
                f'<Parameter name="session_id" value={quoteattr(session_id)}/>'
                f'<Parameter name="from" value={quoteattr(caller)}/>'
            )
            stream_block = f'<Start><Stream url={quoteattr(wss)} track="both_tracks">{params}</Stream></Start>'

        caller_attr = f" callerId={quoteattr(caller)}" if caller else ""
        twiml = (
            '<?xml version="1.0" encoding="UTF-8"?>'
            f"<Response>{stream_block}<Dial{caller_attr}><Number>{escape(to)}</Number></Dial></Response>"
        )
        return Response(content=twiml, media_type="text/xml")

    @app.post("/twilio/voice")
    async def twilio_voice(request: Request) -> Response:
        """TwiML: greet, then stream the live call audio to our WebSocket."""
        form = await request.form()
        # The customer is the *other* party: To on outbound, From on inbound.
        direction = str(form.get("Direction") or "")
        frm = str(form.get("To") if "outbound" in direction else form.get("From") or "")
        wss = os.environ.get("TWILIO_STREAM_WSS")
        if not wss:
            host = request.headers.get("host", "localhost:8000")
            wss = f"wss://{host}/ws/twilio"
        twiml = (
            '<?xml version="1.0" encoding="UTF-8"?>'
            "<Response>"
            "<Say>Connected to Memento. Go ahead.</Say>"
            "<Connect>"
            f'<Stream url="{wss}"><Parameter name="from" value="{frm}"/></Stream>'
            "</Connect>"
            "</Response>"
        )
        return Response(content=twiml, media_type="text/xml")

    def _new_turn_detector() -> TurnDetector:
        return TurnDetector(
            sample_rate=settings.sample_rate,
            threshold=settings.vad_threshold,
            neg_threshold=settings.vad_neg_threshold,
            min_speech_ms=settings.vad_min_speech_ms,
            min_silence_ms=settings.vad_min_silence_ms,
        )

    @app.websocket("/ws/twilio")
    async def twilio_ws(ws: WebSocket) -> None:  # noqa: C901
        await ws.accept()
        # Per-track audio: Twilio sends interleaved frames for both call legs
        # (track=inbound/outbound). Buffering them together garbles the audio and
        # Whisper drops most of it — so keep one buffer + VAD PER track.
        track_bufs: dict[str, AudioBuffer] = {}
        track_tds: dict[str, TurnDetector] = {}

        def _track(track: str) -> tuple[AudioBuffer, TurnDetector]:
            if track not in track_bufs:
                track_bufs[track] = AudioBuffer(sample_rate=settings.sample_rate, max_seconds=settings.max_buffer_seconds)
                track_tds[track] = _new_turn_detector()
            return track_bufs[track], track_tds[track]

        infer_lock = asyncio.Lock()
        turns: list[str] = []
        caller = ""
        call_sid = ""
        session_id = ""  # correlates this call to the right browser panel (multi-call safe)
        mulaw_all = bytearray()  # full call audio (μ-law) for the recording
        started = time.perf_counter()

        async def finalize(track: str) -> None:
            tbuf = track_bufs.get(track)
            if tbuf is None:
                return
            async with infer_lock:
                snap = tbuf.snapshot()
                if snap.size < int(0.4 * settings.sample_rate):
                    tbuf.trim(snap.size)
                    return
                result = await asyncio.to_thread(transcription.transcribe, snap)
                text = " ".join(
                    s.text for s in result.segments if s.text and s.no_speech_prob < 0.6
                ).strip()
                tbuf.trim(snap.size)
                if text:
                    turns.append(text)
                    # inbound = the rep's mic on a Voice-SDK call; outbound = the other party
                    speaker = "rep" if track.startswith("inbound") else "customer"
                    publish({"type": "turn", "from": caller, "text": text,
                             "session_id": session_id, "track": track, "speaker": speaker})
                    log.info("[twilio] turn (%s): %s", track, text[:80])

        try:
            while True:
                msg = json.loads(await ws.receive_text())
                ev = msg.get("event")
                if ev == "start":
                    start = msg.get("start") or {}
                    params = start.get("customParameters") or {}
                    caller = str(params.get("from") or "")
                    session_id = str(params.get("session_id") or "")
                    call_sid = str(start.get("callSid") or "")
                    publish({"type": "start", "from": caller, "callSid": call_sid, "session_id": session_id})
                    log.info("[twilio] stream start, caller=%s session=%s", caller, session_id)
                elif ev == "media":
                    media = msg.get("media") or {}
                    payload = media.get("payload")
                    if not payload:
                        continue
                    track = str(media.get("track") or "inbound")
                    raw = base64.b64decode(payload)
                    mulaw_all += raw
                    samples = _ulaw_to_f32_16k(raw)
                    tbuf, ttd = _track(track)
                    tbuf.append(samples)
                    if any(e.type == "turn_end" for e in ttd.process(samples)):
                        asyncio.create_task(finalize(track))
                    elif tbuf.stats().seconds >= settings.max_buffer_seconds * 0.85:
                        asyncio.create_task(finalize(track))
                elif ev == "stop":
                    log.info("[twilio] stream stop")
                    break
        except WebSocketDisconnect:
            log.info("[twilio] disconnected after %.1fs", time.perf_counter() - started)
        except Exception as exc:  # pragma: no cover
            log.warning("[twilio] handler error: %s", exc)

        for tr in list(track_bufs):
            try:
                await finalize(tr)
            except Exception:
                pass
        transcript = "\n".join(turns).strip()
        publish({"type": "stop", "from": caller, "session_id": session_id})
        if transcript and caller:
            asyncio.create_task(_post_to_ingest(caller, transcript))
        elif transcript:
            log.warning("[twilio] no caller id — transcript not stored")

        # Save + relay the full-call recording (best-effort; never blocks teardown).
        wav_path = None
        try:
            wav_path = _write_wav(bytes(mulaw_all), call_sid)
        except Exception as exc:  # pragma: no cover
            log.warning("[twilio] wav write failed: %s", exc)
        if wav_path:
            size = wav_path.stat().st_size
            log.info("[twilio] saved %s (%d bytes)", wav_path, size)
            publish({"type": "recording", "from": caller, "callSid": call_sid,
                     "path": str(wav_path), "bytes": size})
            asyncio.create_task(_post_recording(wav_path, caller, call_sid))
