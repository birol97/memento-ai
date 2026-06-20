# Memento AI — FastAPI backend (full: live mic advisor + Whisper transcription).
# Built for Railway (CPU). Whisper runs via ctranslate2 (NOT torch), so the
# image stays moderate. Suggestions stream from OpenRouter when keyed.
FROM python:3.13-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    HF_HOME=/app/.hf_cache \
    TRANSCRIPTION_ENABLED=true \
    WHISPER_MODEL=base.en \
    WHISPER_DEVICE=cpu \
    WHISPER_COMPUTE_TYPE=int8

# ctranslate2 needs OpenMP at runtime; PyAV/onnxruntime wheels bundle the rest.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgomp1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install -r requirements.txt

COPY app ./app

# SQLite cache + attachments live here (ephemeral on Railway — it's a
# rebuildable cache by design; durable memory is on Walrus).
RUN mkdir -p data/attachments

# Pre-bake the Whisper model so the first call isn't slow and we don't depend
# on HuggingFace being reachable at runtime.
RUN python -c "from faster_whisper import WhisperModel; WhisperModel('base.en', device='cpu', compute_type='int8')"

EXPOSE 8000
# Railway injects $PORT. Single worker: the WS pipeline holds per-session state
# in-process, so do NOT scale workers without a shared store.
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
