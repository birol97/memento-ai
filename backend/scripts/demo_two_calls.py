"""Headless end-to-end demo of the Walrus memory loop.

Runs TWO calls against the live /ws/transcribe endpoint, both attached to the
same customer, streaming a WAV sample (stand-in for a live mic):

  Call 1 — no memory yet → after `stop`, the summarizer extracts typed entries
           and writes them to Walrus (server emits `memory_written`).
  Call 2 — same customer → on `start`, the server recalls those entries from
           Walrus (`client_attached.memory_entries` > 0) and grounds the copilot.

Usage:
    python scripts/demo_two_calls.py [path.wav] [--url ws://localhost:8000/ws/transcribe]
"""
from __future__ import annotations

import argparse
import asyncio
import json
import wave
from pathlib import Path

import numpy as np
import websockets

CUSTOMER = {"name": "Acme Corp", "phone": "+15551234567", "email": "vp@acme.example"}


def load_wav_16k_mono(path: Path) -> np.ndarray:
    with wave.open(str(path), "rb") as wf:
        assert wf.getnchannels() == 1 and wf.getframerate() == 16000 and wf.getsampwidth() == 2
        raw = wf.readframes(wf.getnframes())
    return np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0


async def run_call(url: str, samples: np.ndarray, call_no: int) -> dict:
    captured = {
        "memory_entries_on_attach": None,
        "has_history": None,
        "finals": [],
        "suggestions": [],
        "memory_written": None,
    }

    async with websockets.connect(url, ping_interval=None, max_size=None) as ws:
        done = asyncio.Event()

        async def reader() -> None:
            async for raw in ws:
                msg = json.loads(raw)
                t = msg.get("type")
                if t == "client_attached":
                    captured["memory_entries_on_attach"] = msg.get("memory_entries")
                    captured["has_history"] = msg.get("has_history")
                    print(f"  [attach ] customer={msg['client'].get('name')} "
                          f"recalled_memory_entries={msg.get('memory_entries')} "
                          f"has_history={msg.get('has_history')}")
                elif t == "final" and msg.get("text"):
                    captured["finals"].append(msg["text"])
                elif t == "suggestion_end" and msg.get("full_text"):
                    captured["suggestions"].append(msg["full_text"])
                    print(f"  [copilot] {msg['full_text'][:140]}")
                elif t == "memory_written":
                    captured["memory_written"] = msg
                    print(f"  [walrus ] wrote {msg.get('added')} entries "
                          f"(total {msg.get('total')}) → blob {msg.get('blob_id')}")
                    print(f"            verify: {msg.get('aggregator_url')}")
                elif t == "stopped":
                    done.set()
                    return

        rtask = asyncio.create_task(reader())

        await ws.send(json.dumps({
            "type": "start", "sample_rate": 16000,
            "mode": "auto", "skill": "sales", "client": CUSTOMER,
        }))
        await asyncio.sleep(0.3)

        chunk = 4000  # 250 ms @ 16 kHz
        for i in range(0, len(samples), chunk):
            await ws.send(samples[i:i + chunk].astype(np.float32).tobytes())
            await asyncio.sleep(0.03)  # ~8x real time — fast but ordered

        await ws.send(json.dumps({"type": "stop"}))
        try:
            await asyncio.wait_for(done.wait(), timeout=240)  # LLM extract is slow on CPU
        except asyncio.TimeoutError:
            print("  [warn   ] timed out waiting for stop/summary")
        rtask.cancel()

    return captured


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("wav", nargs="?", default="../samples/jfk.wav")
    ap.add_argument("--url", default="ws://localhost:8000/ws/transcribe")
    args = ap.parse_args()

    samples = load_wav_16k_mono(Path(args.wav))
    print(f"loaded {len(samples)/16000:.1f}s of audio from {args.wav}\n")

    print("════════ CALL 1 (first contact — memory should be empty) ════════")
    c1 = await run_call(args.url, samples, 1)
    print(f"  finals: {len(c1['finals'])} | suggestions: {len(c1['suggestions'])}")

    print("\n  …waiting 3s for Walrus write to settle…\n")
    await asyncio.sleep(3)

    print("════════ CALL 2 (same customer — memory should be recalled) ════════")
    c2 = await run_call(args.url, samples, 2)
    print(f"  finals: {len(c2['finals'])} | suggestions: {len(c2['suggestions'])}")

    print("\n════════ RESULT ════════")
    print(f"call 1 recalled-on-attach : {c1['memory_entries_on_attach']}  "
          f"(wrote: {c1['memory_written'] and c1['memory_written'].get('added')})")
    print(f"call 2 recalled-on-attach : {c2['memory_entries_on_attach']}")
    ok = (c1["memory_entries_on_attach"] == 0
          and bool(c1["memory_written"])
          and (c2["memory_entries_on_attach"] or 0) > 0)
    print("MEMORY LOOP:", "✅ PROVEN (call 2 inherited call 1's memory from Walrus)"
          if ok else "⚠️ see output above")


if __name__ == "__main__":
    asyncio.run(main())
