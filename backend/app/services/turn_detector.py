"""Streaming voice-activity-driven turn detection.

Wraps the Silero VAD ONNX model that ships with faster-whisper. Unlike
``faster_whisper.vad.SileroVADModel.__call__`` (which resets the LSTM state
on every call), this wrapper persists ``h``, ``c``, and the trailing-context
window across calls so it can be fed an unbounded stream of 32 ms frames.

Two layers:

* ``StreamingSileroVAD``  — frame-level: feed 512 samples, get one speech
  probability back. Maintains the recurrent state.
* ``TurnDetector``        — turn-level: feed arbitrary chunks of float32
  samples, get a list of ``TurnEvent`` describing speech_start / turn_end
  transitions, debounced with hysteresis (different threshold for entering
  vs. leaving speech) and minimum-duration gates.

The detector is single-threaded and stateful. One instance per WebSocket
session.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from typing import List, Literal, Optional

import numpy as np

# faster_whisper imported lazily (see transcription.py) so the slim deploy boots
# without the audio stack when transcription is disabled.


# Silero v6 expects 32 ms frames at 16 kHz, prefixed with 64 samples of
# rolling context from the previous frame. Don't change these unless you
# swap the model.
FRAME_SAMPLES = 512
CONTEXT_SAMPLES = 64


@dataclass
class TurnEvent:
    type: Literal["speech_start", "turn_end"]
    timestamp: float  # seconds, session-relative


class StreamingSileroVAD:
    """Frame-by-frame Silero VAD with persistent LSTM + context state."""

    def __init__(self, onnx_path: Optional[str] = None) -> None:
        # Lazy-import so importing this module doesn't pay the onnxruntime
        # cost unless the detector is actually used.
        import onnxruntime  # type: ignore

        if onnx_path is None:
            from faster_whisper.utils import get_assets_path  # lazy
            onnx_path = os.path.join(get_assets_path(), "silero_vad_v6.onnx")

        opts = onnxruntime.SessionOptions()
        opts.intra_op_num_threads = 1
        opts.inter_op_num_threads = 1
        opts.enable_cpu_mem_arena = False
        opts.log_severity_level = 4

        self.session = onnxruntime.InferenceSession(
            onnx_path,
            providers=["CPUExecutionProvider"],
            sess_options=opts,
        )
        self.reset()

    def reset(self) -> None:
        # LSTM hidden + cell state, shape (num_layers, batch, hidden) = (1, 1, 128).
        self._h = np.zeros((1, 1, 128), dtype=np.float32)
        self._c = np.zeros((1, 1, 128), dtype=np.float32)
        # Last CONTEXT_SAMPLES of the previous frame; prepended to the next
        # frame so the model sees a continuous stream.
        self._prev_tail = np.zeros(CONTEXT_SAMPLES, dtype=np.float32)

    def process_frame(self, frame: np.ndarray) -> float:
        """Return speech probability in [0, 1] for one 512-sample frame."""
        if frame.shape != (FRAME_SAMPLES,):
            raise ValueError(f"frame must be exactly {FRAME_SAMPLES} samples, got {frame.shape}")
        if frame.dtype != np.float32:
            frame = frame.astype(np.float32)

        inp = np.concatenate([self._prev_tail, frame]).reshape(1, CONTEXT_SAMPLES + FRAME_SAMPLES)

        out, h, c = self.session.run(
            None,
            {"input": inp.astype(np.float32), "h": self._h, "c": self._c},
        )

        self._h = h
        self._c = c
        # Copy so we don't hold a view into the caller's buffer
        self._prev_tail = frame[-CONTEXT_SAMPLES:].copy()

        # Output shape is (seq_len,) — one probability per frame in the batch.
        # We feed exactly one frame, so out[0] is the speech probability.
        return float(out[0])


class TurnDetector:
    """VAD-driven turn boundary detector.

    Hysteresis: ``threshold`` is the bar to *enter* speech; ``neg_threshold``
    is the bar to remain in speech (must drop below it to start counting
    silence). This avoids flapping near the decision boundary.

    Debouncing:
      * A speech_start fires only after ``min_speech_ms`` of contiguous
        above-threshold frames.
      * A turn_end fires only after ``min_silence_ms`` of contiguous
        below-neg-threshold frames *while in speech*.

    The detector tracks total samples processed so it can stamp events with
    session-relative timestamps. ``reset()`` zeroes both the LSTM state and
    the wall-clock counter (use it on a new session, not between turns).
    """

    def __init__(
        self,
        sample_rate: int = 16000,
        threshold: float = 0.5,
        neg_threshold: Optional[float] = None,
        min_speech_ms: int = 200,
        min_silence_ms: int = 600,
        vad: Optional[StreamingSileroVAD] = None,
    ) -> None:
        if sample_rate != 16000:
            raise ValueError("Silero v6 only supports 16 kHz input")

        self.sample_rate = sample_rate
        self.threshold = threshold
        self.neg_threshold = neg_threshold if neg_threshold is not None else max(0.0, threshold - 0.15)
        self.min_speech_samples = int(sample_rate * min_speech_ms / 1000)
        self.min_silence_samples = int(sample_rate * min_silence_ms / 1000)

        self.vad = vad or StreamingSileroVAD()
        self._frame_buf = np.zeros(0, dtype=np.float32)
        self._total_samples = 0
        self._speaking = False
        self._candidate_speech_samples = 0
        self._candidate_silence_samples = 0
        self._current_turn_start: Optional[float] = None

    # ─── Properties / introspection ───────────────────────────────────────
    @property
    def is_speaking(self) -> bool:
        return self._speaking

    @property
    def current_turn_start(self) -> Optional[float]:
        """Session-relative second-mark when the current turn began, or None
        if we're not in a turn."""
        return self._current_turn_start

    # ─── Hot path ─────────────────────────────────────────────────────────
    def process(self, samples: np.ndarray) -> List[TurnEvent]:
        """Feed raw float32 PCM (any length); return any events emitted."""
        if samples.dtype != np.float32:
            samples = samples.astype(np.float32)

        events: List[TurnEvent] = []
        self._frame_buf = np.concatenate([self._frame_buf, samples])

        while self._frame_buf.size >= FRAME_SAMPLES:
            frame = self._frame_buf[:FRAME_SAMPLES]
            self._frame_buf = self._frame_buf[FRAME_SAMPLES:]

            prob = self.vad.process_frame(frame)
            self._total_samples += FRAME_SAMPLES
            now = self._total_samples / self.sample_rate

            if not self._speaking:
                # We're in silence. Watch for speech onset.
                if prob >= self.threshold:
                    self._candidate_speech_samples += FRAME_SAMPLES
                    if self._candidate_speech_samples >= self.min_speech_samples:
                        self._speaking = True
                        # The turn began min_speech_samples ago
                        self._current_turn_start = now - (self._candidate_speech_samples / self.sample_rate)
                        events.append(
                            TurnEvent(type="speech_start", timestamp=self._current_turn_start)
                        )
                        self._candidate_silence_samples = 0
                else:
                    self._candidate_speech_samples = 0
            else:
                # We're in a turn. Watch for sustained silence to close it.
                if prob < self.neg_threshold:
                    self._candidate_silence_samples += FRAME_SAMPLES
                    if self._candidate_silence_samples >= self.min_silence_samples:
                        self._speaking = False
                        events.append(TurnEvent(type="turn_end", timestamp=now))
                        self._candidate_speech_samples = 0
                        self._candidate_silence_samples = 0
                        self._current_turn_start = None
                else:
                    # Above neg_threshold means we're still in speech;
                    # reset the silence counter.
                    self._candidate_silence_samples = 0

        return events

    def reset(self) -> None:
        """Reset both the model state and the session clock. Call this on a
        fresh WebSocket session, not between turns."""
        self.vad.reset()
        self._frame_buf = np.zeros(0, dtype=np.float32)
        self._total_samples = 0
        self._speaking = False
        self._candidate_speech_samples = 0
        self._candidate_silence_samples = 0
        self._current_turn_start = None
