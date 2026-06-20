"""Wraps faster-whisper for streaming-friendly inference on numpy buffers."""
from __future__ import annotations

import time
from dataclasses import dataclass
from typing import TYPE_CHECKING, List, Optional

import numpy as np

# faster-whisper is imported lazily (inside load()) so the backend can be deployed
# WITHOUT the heavy audio stack (torch/ctranslate2/av) when transcription is off.
if TYPE_CHECKING:
    from faster_whisper import WhisperModel

from app.core.config import Settings
from app.core.logger import get_logger

log = get_logger(__name__)


@dataclass
class Segment:
    text: str
    start: float
    end: float
    no_speech_prob: float


@dataclass
class TranscriptionResult:
    segments: List[Segment]
    language: str
    inference_ms: float


class TranscriptionService:
    """Thin wrapper around WhisperModel.

    The model is created once and reused. Inference is synchronous (CPU/GPU bound)
    and is expected to be called from a worker thread via ``asyncio.to_thread``.
    """

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._model: Optional[WhisperModel] = None

    def load(self) -> None:
        if self._model is not None:
            return
        from faster_whisper import WhisperModel  # lazy — only when transcription is enabled
        log.info(
            "Loading Whisper model name=%s device=%s compute_type=%s",
            self._settings.whisper_model,
            self._settings.whisper_device,
            self._settings.whisper_compute_type,
        )
        t0 = time.perf_counter()
        self._model = WhisperModel(
            self._settings.whisper_model,
            device=self._settings.whisper_device,
            compute_type=self._settings.whisper_compute_type,
        )
        log.info("Whisper model loaded in %.2fs", time.perf_counter() - t0)

    def transcribe(
        self,
        audio: np.ndarray,
        *,
        language: Optional[str] = None,
        initial_prompt: Optional[str] = None,
    ) -> TranscriptionResult:
        if self._model is None:
            raise RuntimeError("TranscriptionService.load() was not called")

        # faster-whisper expects float32 mono PCM at 16 kHz
        if audio.dtype != np.float32:
            audio = audio.astype(np.float32)

        t0 = time.perf_counter()
        segments_iter, info = self._model.transcribe(
            audio,
            language=language,
            initial_prompt=initial_prompt,
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 300},
            beam_size=1,
            condition_on_previous_text=False,
        )
        segments = [
            Segment(
                text=s.text.strip(),
                start=float(s.start),
                end=float(s.end),
                no_speech_prob=float(s.no_speech_prob),
            )
            for s in segments_iter
        ]
        elapsed_ms = (time.perf_counter() - t0) * 1000.0
        return TranscriptionResult(
            segments=segments,
            language=info.language,
            inference_ms=elapsed_ms,
        )
