"""Replay a 16 kHz mono WAV through the live /ws/transcribe endpoint at
real-time pace. Prints every server message inline.

Usage:
    python scripts/ws_replay.py [--url ws://...] [--speed 1] [path.wav]

Used to verify the M3 turn-detection wiring without touching the browser.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
import wave
from pathlib import Path

import numpy as np
import websockets


def load_wav_16k_mono(path: Path) -> np.ndarray:
    with wave.open(str(path), "rb") as wf:
        if wf.getnchannels() != 1:
            raise SystemExit(f"{path}: expected mono, got {wf.getnchannels()} channels")
        if wf.getframerate() != 16000:
            raise SystemExit(f"{path}: expected 16 kHz, got {wf.getframerate()} Hz")
        if wf.getsampwidth() != 2:
            raise SystemExit(f"{path}: expected 16-bit PCM, got {wf.getsampwidth() * 8}-bit")
        raw = wf.readframes(wf.getnframes())
    return np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0


async def replay(url: str, samples: np.ndarray, speed: float) -> int:
    chunk = 4000  # 250 ms at 16 kHz, same as the worklet
    chunk_ms = (chunk / 16000) * 1000 / speed
    finals = 0
    starts = 0
    ends = 0

    async with websockets.connect(url, ping_interval=None) as ws:

        async def reader() -> None:
            nonlocal finals, starts, ends
            async for raw in ws:
                msg = json.loads(raw)
                t = msg.get("type")
                if t == "ready":
                    print(f"  [ready  ] session={msg['session_id']}")
                elif t == "speech_start":
                    starts += 1
                    print(f"  [start  ] turn at {msg['turn_start']}s")
                elif t == "turn_end":
                    ends += 1
                    duration = msg["turn_end"] - msg["turn_start"]
                    print(f"  [end    ] turn at {msg['turn_end']}s (lasted {duration:.2f}s)")
                elif t == "partial":
                    print(f"  [partial] inf={msg['inference_ms']:.0f}ms  {msg['text']!r}")
                elif t == "final":
                    finals += 1
                    print(f"  [FINAL  ] inf={msg['inference_ms']:.0f}ms  {msg['text']!r}")
                elif t == "stopped":
                    print("  [stopped]")
                    return
                elif t == "error":
                    print(f"  [ERROR  ] {msg['message']}")
                else:
                    print(f"  [?] {msg}")

        reader_task = asyncio.create_task(reader())
        await ws.send(json.dumps({"type": "start", "sample_rate": 16000}))

        # Stream PCM
        for i in range(0, samples.size, chunk):
            slice_ = samples[i : i + chunk]
            await ws.send(slice_.astype(np.float32).tobytes())
            await asyncio.sleep(chunk_ms / 1000)

        # Tell server to flush
        await ws.send(json.dumps({"type": "stop"}))

        # Wait briefly for the final to arrive
        try:
            await asyncio.wait_for(reader_task, timeout=10)
        except asyncio.TimeoutError:
            print("  [warn] reader timed out waiting for stopped")

    print()
    print(f"counts: speech_start={starts} turn_end={ends} finals={finals}")
    return 0


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("wav", nargs="?",
                   default=str(Path(__file__).resolve().parents[2] / "samples" / "jfk.wav"))
    p.add_argument("--url", default="ws://127.0.0.1:8000/ws/transcribe")
    p.add_argument("--speed", type=float, default=4.0,
                   help="streaming speed; 1=realtime, 4=4x")
    args = p.parse_args()

    path = Path(args.wav)
    if not path.exists():
        print(f"file not found: {path}", file=sys.stderr)
        return 2

    samples = load_wav_16k_mono(path)
    duration = samples.size / 16000
    print(f"streaming {path.name} ({duration:.2f}s) at {args.speed}× to {args.url}")
    print()

    return asyncio.run(replay(args.url, samples, args.speed))


if __name__ == "__main__":
    sys.exit(main())
