"""Rolling audio buffer for VAD-driven turn capture.

Collects raw float32 PCM (mono, 16 kHz). Operations:

* ``append``    — push new samples from the client.
* ``snapshot``  — copy the current buffer for inference.
* ``reset``     — empty the buffer (called on turn_end).

The buffer is also size-capped: anything past ``max_seconds`` is trimmed from
the head, so a runaway client can't blow memory.

Locking is lightweight; we never block the WebSocket reader.
"""
from __future__ import annotations

import threading
from dataclasses import dataclass

import numpy as np


@dataclass
class BufferStats:
    samples: int
    seconds: float


class AudioBuffer:
    def __init__(self, sample_rate: int, max_seconds: float) -> None:
        self._sample_rate = sample_rate
        self._max_samples = int(max_seconds * sample_rate)
        self._buf = np.zeros(0, dtype=np.float32)
        self._samples_since_last_inference = 0
        self._lock = threading.Lock()

    @property
    def sample_rate(self) -> int:
        return self._sample_rate

    def append(self, samples: np.ndarray) -> None:
        if samples.dtype != np.float32:
            samples = samples.astype(np.float32)
        with self._lock:
            self._buf = np.concatenate([self._buf, samples])
            self._samples_since_last_inference += samples.size
            # If the buffer grows past max_samples we hard-trim from the head;
            # the WebSocket layer is responsible for committing earlier than this.
            if self._buf.size > self._max_samples:
                excess = self._buf.size - self._max_samples
                self._buf = self._buf[excess:]

    def snapshot(self) -> np.ndarray:
        """Return a copy of the current buffer for inference."""
        with self._lock:
            self._samples_since_last_inference = 0
            return self._buf.copy()

    def reset(self) -> None:
        """Drop all buffered audio. Use when starting a fresh session."""
        with self._lock:
            self._buf = np.zeros(0, dtype=np.float32)
            self._samples_since_last_inference = 0

    def trim(self, n: int) -> None:
        """Drop the first ``n`` samples from the head.

        Used after a final inference to discard exactly what was just
        transcribed, while preserving any audio that arrived from the WS
        reader while inference was running on a worker thread.
        """
        with self._lock:
            n = min(max(0, n), self._buf.size)
            if n:
                self._buf = self._buf[n:].copy()

    def stats(self) -> BufferStats:
        with self._lock:
            return BufferStats(samples=self._buf.size, seconds=self._buf.size / self._sample_rate)

    def seconds_since_last_inference(self) -> float:
        with self._lock:
            return self._samples_since_last_inference / self._sample_rate
