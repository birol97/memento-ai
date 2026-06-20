"""Offline check: feed samples/jfk.wav into TurnDetector in 250 ms slices
(simulating live streaming) and report the events.

Usage:
    cd backend && source .venv/bin/activate
    python scripts/test_turn_detector.py            # default: jfk.wav
    python scripts/test_turn_detector.py path.wav   # custom file (must be 16 kHz mono)

Prints turn events and a few aggregate stats. Exits non-zero if zero turns
were detected, so this doubles as a smoke test in CI later.
"""
from __future__ import annotations

import argparse
import struct
import sys
import time
import wave
from pathlib import Path

import numpy as np

# Make 'app.*' importable without installing the package
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services.turn_detector import TurnDetector  # noqa: E402


def load_wav_16k_mono(path: Path) -> np.ndarray:
    with wave.open(str(path), "rb") as wf:
        if wf.getnchannels() != 1:
            raise SystemExit(f"{path}: expected mono, got {wf.getnchannels()} channels")
        if wf.getframerate() != 16000:
            raise SystemExit(f"{path}: expected 16 kHz, got {wf.getframerate()} Hz")
        if wf.getsampwidth() != 2:
            raise SystemExit(f"{path}: expected 16-bit PCM, got {wf.getsampwidth() * 8}-bit")
        n = wf.getnframes()
        raw = wf.readframes(n)
    samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    return samples


def main() -> int:
    p = argparse.ArgumentParser()
    default_sample = Path(__file__).resolve().parents[2] / "samples" / "jfk.wav"
    p.add_argument("wav", nargs="?", default=str(default_sample))
    p.add_argument("--chunk-ms", type=int, default=250, help="simulated live chunk size")
    p.add_argument("--threshold", type=float, default=0.5)
    p.add_argument("--min-silence-ms", type=int, default=600)
    p.add_argument("--min-speech-ms", type=int, default=200)
    args = p.parse_args()

    wav_path = Path(args.wav)
    if not wav_path.exists():
        raise SystemExit(f"file not found: {wav_path}")

    samples = load_wav_16k_mono(wav_path)
    duration = samples.size / 16000
    print(f"file: {wav_path}")
    print(f"duration: {duration:.2f}s ({samples.size} samples)")
    print()

    detector = TurnDetector(
        threshold=args.threshold,
        min_silence_ms=args.min_silence_ms,
        min_speech_ms=args.min_speech_ms,
    )

    chunk_samples = int(16000 * args.chunk_ms / 1000)
    all_events = []

    t0 = time.perf_counter()
    for i in range(0, samples.size, chunk_samples):
        chunk = samples[i : i + chunk_samples]
        for ev in detector.process(chunk):
            wall_offset = (i + chunk.size) / 16000
            all_events.append(ev)
            print(f"  [{ev.timestamp:6.2f}s session]  {ev.type:<13} (chunk ended at {wall_offset:.2f}s)")
    elapsed = time.perf_counter() - t0

    print()
    print(f"processed in {elapsed*1000:.0f} ms ({duration / elapsed:.0f}× real-time)")
    print(f"events: {len(all_events)}")
    starts = [e for e in all_events if e.type == "speech_start"]
    ends = [e for e in all_events if e.type == "turn_end"]
    print(f"  speech_start: {len(starts)}")
    print(f"  turn_end:     {len(ends)}")

    if not starts:
        print("FAIL: no speech detected")
        return 1
    if not ends and detector.is_speaking:
        # JFK is short and may end mid-speech. That's fine — a real session
        # will get a turn_end after the speaker stops.
        print("note: file ended mid-speech (no turn_end fired). OK for short clips.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
