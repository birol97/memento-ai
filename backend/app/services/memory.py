"""Per-customer long-term memory, stored as JSON documents on Walrus.

A customer's entire memory is one JSON doc:

    {
      "customer_id": "<client_id>",
      "entries": [ MemoryEntry, ... ],
      "updated_at": "<iso>"
    }

Walrus blobs are immutable and content-addressed, so an "update" writes a NEW
blob and we move the customer→blob pointer. For this slice that pointer lives in
SQLite (`customer_memory` table); in a later slice it becomes the on-chain
`CustomerMemoryCap` so ownership is transferable between reps.

Memory follows the spec's 5-type schema. Retrieval (`recall_block`) is
type-based + recency for now:
  - facts / preferences : always loaded
  - commitments         : always surfaced
  - signals             : most-recent N
  - history             : most-recent N  (semantic similarity is a documented
                          follow-up — needs embeddings; see FEEDBACK.md)
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from app.core.config import get_settings
from app.core.logger import get_logger
from app.db import repository as repo
from app.services.walrus import WalrusStore

log = get_logger(__name__)

MEMORY_TYPES = ("fact", "preference", "commitment", "signal", "history")

_TYPE_HEADINGS = {
    "fact": "Facts",
    "preference": "Preferences",
    "commitment": "Open commitments",
    "signal": "Recent signals",
    "history": "Relevant history",
}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def _empty(customer_id: int) -> Dict[str, Any]:
    return {"customer_id": str(customer_id), "entries": [], "updated_at": None}


async def load_memory(store: WalrusStore, client_id: int) -> Dict[str, Any]:
    """Fetch the customer's latest memory doc from Walrus (empty if none)."""
    blob_id = repo.get_memory_pointer(client_id)
    if not blob_id:
        return _empty(client_id)
    try:
        doc = await store.get_json(blob_id)
        if isinstance(doc, dict) and isinstance(doc.get("entries"), list):
            return doc
        log.warning("memory blob %s has unexpected shape; ignoring", blob_id)
    except Exception as exc:  # network / decode / 404
        log.warning("failed to load memory blob %s: %s", blob_id, exc)
    return _empty(client_id)


def coerce_entries(raw: Any) -> List[Dict[str, Any]]:
    """Validate LLM-proposed entries into well-formed MemoryEntry dicts."""
    if not isinstance(raw, list):
        return []
    out: List[Dict[str, Any]] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        etype = item.get("type")
        content = (item.get("content") or "").strip() if isinstance(item.get("content"), str) else ""
        if etype not in MEMORY_TYPES or not content:
            continue
        conf = item.get("confidence")
        try:
            conf = float(conf)
        except (TypeError, ValueError):
            conf = 0.6
        entry: Dict[str, Any] = {
            "id": uuid.uuid4().hex,
            "type": etype,
            "content": content,
            "confidence": max(0.0, min(1.0, conf)),
            "created_at": _now_iso(),
        }
        if isinstance(item.get("structured"), dict):
            entry["structured"] = item["structured"]
        out.append(entry)
    return out


async def save_entries(
    store: WalrusStore,
    client_id: int,
    new_entries: List[Dict[str, Any]],
) -> Optional[Dict[str, Any]]:
    """Merge new entries into the customer's memory doc, write a new Walrus blob,
    and move the pointer. Returns a small result for the UI / verifiability."""
    if not new_entries:
        return None
    doc = await load_memory(store, client_id)
    doc["entries"].extend(new_entries)
    doc["updated_at"] = _now_iso()
    blob_id = await store.put_json(doc)
    repo.set_memory_pointer(client_id, blob_id)
    return {
        "blob_id": blob_id,
        "aggregator_url": store.aggregator_url(blob_id),
        "added": len(new_entries),
        "total": len(doc["entries"]),
    }


def recall_block(memory: Dict[str, Any], current_turns: List[Dict[str, Any]]) -> Optional[str]:
    """Render the recalled memory as a prompt block, applying per-type rules.

    `current_turns` is accepted for the future semantic-similarity pass over
    history; today history is selected by recency.
    """
    settings = get_settings()
    entries: List[Dict[str, Any]] = memory.get("entries") or []
    if not entries:
        return None

    by_type: Dict[str, List[Dict[str, Any]]] = {t: [] for t in MEMORY_TYPES}
    for e in entries:
        if e.get("type") in by_type:
            by_type[e["type"]].append(e)

    def _recent(items: List[Dict[str, Any]], n: int) -> List[Dict[str, Any]]:
        return sorted(items, key=lambda x: x.get("created_at") or "", reverse=True)[:n]

    selected: Dict[str, List[Dict[str, Any]]] = {
        "fact": by_type["fact"],
        "preference": by_type["preference"],
        "commitment": by_type["commitment"],
        "signal": _recent(by_type["signal"], settings.memory_recall_signals),
        "history": _recent(by_type["history"], settings.memory_recall_history),
    }
    if not any(selected.values()):
        return None

    lines: List[str] = [
        "# Customer memory (recalled from Walrus — prior calls with this customer)",
    ]
    for etype in MEMORY_TYPES:
        items = selected.get(etype) or []
        if not items:
            continue
        lines.append(f"\n## {_TYPE_HEADINGS[etype]}")
        for e in items:
            lines.append(f"- {e['content']}")
    return "\n".join(lines)
