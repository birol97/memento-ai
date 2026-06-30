"""Application configuration loaded from environment variables."""
from __future__ import annotations

from functools import lru_cache
from typing import Annotated, List

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    host: str = "0.0.0.0"
    port: int = 8000
    log_level: str = "INFO"

    # NoDecode skips pydantic-settings' default JSON pre-parse for complex types,
    # so the validator below can do the comma-split.
    allowed_origins: Annotated[List[str], NoDecode] = Field(
        default_factory=lambda: ["http://localhost:3000"]
    )
    # Regex of additional allowed origins (CORS). Defaults to any *.vercel.app so
    # rotating Vercel deploy/preview URLs don't break the browser with a CORS error.
    # Set to "" to disable, or override for your own domain.
    allowed_origin_regex: str = r"https://.*\.vercel\.app"

    # Set TRANSCRIPTION_ENABLED=false on hosts without the audio stack (slim deploy).
    transcription_enabled: bool = True
    whisper_model: str = "base.en"
    whisper_device: str = "cpu"
    whisper_compute_type: str = "int8"

    sample_rate: int = 16000
    max_buffer_seconds: float = 15.0
    inference_interval_seconds: float = 1.0

    # Voice-activity-driven turn detection (M3).
    vad_enabled: bool = True
    vad_threshold: float = 0.5
    vad_neg_threshold: float = 0.35
    vad_min_speech_ms: int = 200
    vad_min_silence_ms: int = 600

    # Persistence (M4 knowledge base).
    db_path: str = "data/copilot.sqlite3"
    attachments_dir: str = "data/attachments"
    attachment_max_bytes: int = 25 * 1024 * 1024  # 25 MB per file

    # Streaming copilot (M4). Provider is chosen at runtime: if
    # OPENROUTER_API_KEY is set, the live mic advisor + call summaries stream
    # from OpenRouter (hosted, no local dep — required for a hosted backend);
    # otherwise it falls back to local Ollama. Same prompts, same WS protocol.
    suggestions_enabled: bool = True
    suggestion_history_summaries: int = 5
    suggestion_max_tokens: int = 220
    # OpenRouter (OpenAI-compatible). Set OPENROUTER_API_KEY to enable.
    openrouter_api_key: str = ""
    openrouter_base_url: str = "https://openrouter.ai/api/v1"
    # Cheap+fast model is plenty for live next-utterance coaching. Override
    # with OPENROUTER_MODEL if you want a stronger model.
    openrouter_model: str = "google/gemini-2.5-flash"
    openrouter_app_url: str = "https://memento.ai"   # sent as HTTP-Referer
    ollama_base_url: str = "http://localhost:11434"
    ollama_model: str = "qwen2.5:7b"
    # Per-request timeout (seconds). Local 7B models on CPU can take
    # 20–40s for a 200-token completion, so default generously.
    ollama_request_timeout: float = 120.0

    # Speaker ID (M5). Cosine-similarity threshold above which a turn is
    # classified as the rep. Tune up if too many client turns get tagged
    # as rep, down if rep turns get missed.
    speaker_id_threshold: float = 0.7

    # ── Walrus-backed long-term customer memory (raw Walrus, no relayer) ──
    # The "memory loop": recall prior-call memory into the copilot prompt on
    # call start; a post-call summarizer extracts typed entries and writes them
    # back to Walrus. Storage is the public testnet publisher/aggregator.
    memory_enabled: bool = True
    walrus_publisher_url: str = "https://publisher.walrus-testnet.walrus.space"
    walrus_aggregator_url: str = "https://aggregator.walrus-testnet.walrus.space"
    # Storage lease length. Walrus is a LEASE, not permanent — blobs are deleted
    # after this many epochs. Since retrieval now reads from Walrus (not SQLite),
    # this is the real durability knob: raise it for longer retention. For true
    # permanence you must RENEW blobs before they expire (see services/walrus.py
    # extend_blob stub). Override with WALRUS_EPOCHS in the environment.
    walrus_epochs: int = 53           # storage lifetime in Walrus epochs
    walrus_timeout: float = 60.0
    memory_recall_signals: int = 5    # most-recent N 'signal' entries to surface
    memory_recall_history: int = 8    # most-recent N 'history' entries to surface

    # ── On-chain recovery (Walrus-first memory) ──
    # The customer-memory path treats Walrus as the source of truth and SQLite as
    # a disposable cache. When a customer isn't in the cache, the backend resolves
    # its on-chain CustomerMemoryCap → anchored manifest blob → rebuilds the cache
    # (see services/sui_chain.py + manifest.rebuild_from_chain). These locate the
    # caps; leave sui_package_id / sui_server_address empty to disable recovery
    # (the path then degrades to the old "404 if not cached" behaviour).
    sui_network: str = "testnet"
    sui_rpc_url: str = ""             # blank → derived from sui_network
    sui_package_id: str = ""         # the published customer_memory package
    sui_server_address: str = ""     # address that OWNS the caps (frontend's signer)
    # Best-effort: on startup, rebuild the whole client list from owned caps so the
    # app is usable against an empty DB. Turn off if you don't want startup RPC.
    rebuild_from_chain_on_startup: bool = True
    # The published salescall::org package — lets /auth/sync rebuild a user's org
    # membership from their on-chain MemberCap when SQLite is empty (chain-derived
    # identity; see services/org_chain.py). Same id the frontend uses as
    # SUI_ORG_PACKAGE_ID. Leave blank to disable (user is sent to onboarding).
    sui_org_package_id: str = ""

    # ── Auth / multi-tenancy (Phase 1) ──
    # HS256 secret shared with the Next frontend, which mints the session JWT
    # after verifying the user's zkLogin/Enoki session. The backend only verifies.
    session_jwt_secret: str = ""
    # While False, requests without a valid token resolve to a synthetic
    # default-org `owner` principal so the existing UI keeps working. Flip True
    # (Phase 6) to reject anonymous calls.
    auth_required: bool = False
    default_org_name: str = "Default Org"
    # Passphrase used to derive the Fernet key that encrypts channel credentials
    # (SMTP/Twilio secrets) at rest. Set a strong value in production.
    channels_enc_secret: str = ""

    # ── Voice Relay (shared infra) ──
    # One relay instance serves every user; the app sends each user's own Twilio
    # creds per call, so the relay is multi-tenant. Not a user-facing channel.
    voice_relay_url: str = ""          # e.g. https://abcd.ngrok.io
    voice_relay_api_key: str = ""      # matches the relay's RELAY_API_KEY

    @field_validator("allowed_origins", mode="before")
    @classmethod
    def _split_origins(cls, value: object) -> object:
        if isinstance(value, str):
            return [origin.strip() for origin in value.split(",") if origin.strip()]
        return value


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
