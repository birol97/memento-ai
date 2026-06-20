"""FastAPI entry point.

Run with: uvicorn app.main:app --host 0.0.0.0 --port 8000
"""
from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api import rest as rest_module
from app.api import orgs as orgs_module
from app.api import channels as channels_module
from app.api import messaging as messaging_module
from app.api import websocket as ws_module
from app.api import twilio_ws as twilio_module
from app.api import calls_stream as calls_module
from app.core.config import get_settings
from app.core.logger import configure_logging, get_logger
from app.db.connection import init_db
from app.services.suggestions import SuggestionService
from app.services.transcription import TranscriptionService

configure_logging()
log = get_logger(__name__)
settings = get_settings()
transcription = TranscriptionService(settings)
suggestions = SuggestionService()


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    if settings.transcription_enabled:
        transcription.load()
    else:
        log.info("transcription disabled (slim deploy) — Whisper not loaded")
    # Stash on app.state so REST endpoints can reuse the same instances
    # the websocket pipeline does — one Whisper model, one Ollama client.
    app.state.transcription = transcription
    app.state.suggestions = suggestions
    yield


app = FastAPI(title="Conversation Copilot", version="0.2.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allowed_origins,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/healthz")
def healthz() -> dict:
    return {
        "status": "ok",
        "model": settings.whisper_model,
        "device": settings.whisper_device,
        "sample_rate": settings.sample_rate,
        "suggestions_enabled": bool(settings.suggestions_enabled),
        "llm_provider": "openrouter" if settings.openrouter_api_key else "ollama",
        "copilot_model": settings.openrouter_model if settings.openrouter_api_key else settings.ollama_model,
    }


app.include_router(rest_module.router)
app.include_router(orgs_module.router)
app.include_router(channels_module.router)
app.include_router(messaging_module.router)
ws_module.register(app, transcription)
twilio_module.register_twilio(app, transcription)
calls_module.register_calls(app)
