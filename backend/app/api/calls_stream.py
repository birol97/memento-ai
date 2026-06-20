"""Live call event stream (Server-Sent Events).

The Twilio Media Streams handler publishes call events (start / turn / stop) here;
the Phone tab in the UI subscribes via EventSource to watch calls transcribe live.
In-memory fan-out (single process, demo scale).
"""
from __future__ import annotations

import asyncio
import json
from typing import Any, Dict, Set

from fastapi import Request, WebSocket, WebSocketDisconnect
from fastapi.responses import StreamingResponse

from app.core.logger import get_logger

log = get_logger(__name__)

_subscribers: Set["asyncio.Queue[Dict[str, Any]]"] = set()


def publish(event: Dict[str, Any]) -> None:
    """Fan an event out to all connected SSE subscribers (non-blocking)."""
    for q in list(_subscribers):
        try:
            q.put_nowait(event)
        except Exception:
            pass


def register_calls(app) -> None:
    @app.websocket("/relay/ingest")
    async def relay_ingest(ws: WebSocket) -> None:
        """The Voice Relay connects here (MAINAPP_WS_URL) and pushes live call
        events — call.started / transcript{speaker,text,session_id} / call.ended.
        We fan each one straight into the SSE stream the UI is watching."""
        await ws.accept()
        log.info("[relay] ingest WS connected")
        try:
            while True:
                raw = await ws.receive_text()
                try:
                    ev = json.loads(raw)
                except Exception:
                    continue
                publish(ev)
        except WebSocketDisconnect:
            log.info("[relay] ingest WS disconnected")
        except Exception as exc:  # noqa: BLE001
            log.warning("[relay] ingest WS error: %s", exc)

    @app.get("/calls/stream")
    async def calls_stream(request: Request) -> StreamingResponse:
        q: "asyncio.Queue[Dict[str, Any]]" = asyncio.Queue()
        _subscribers.add(q)

        async def gen():
            try:
                yield ": connected\n\n"
                while True:
                    if await request.is_disconnected():
                        break
                    try:
                        ev = await asyncio.wait_for(q.get(), timeout=15.0)
                        yield f"data: {json.dumps(ev)}\n\n"
                    except asyncio.TimeoutError:
                        yield ": ping\n\n"  # keepalive
            finally:
                _subscribers.discard(q)

        return StreamingResponse(
            gen(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )
