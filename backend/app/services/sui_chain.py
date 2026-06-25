"""Read-only Sui resolver for the Walrus-first recovery path.

The frontend owns minting/anchoring/transfer of ``CustomerMemoryCap`` objects
(it holds the signing key). The backend never signs — it only *reads* the chain
so it can rebuild its SQLite cache from the source of truth (Walrus), e.g. after
the cache is wiped on a fresh/ephemeral deploy.

Given a customer namespace (``salescall[-o<org>]-client-<id>``) this resolves the
``memory_blob_id`` anchored in that customer's cap — the Walrus manifest blob that
``manifest.rebuild_from_chain`` then replays into the cache. It can also enumerate
every cap the server address owns, to repopulate the whole client list.

No Sui SDK: plain JSON-RPC over httpx. Disabled (returns nothing) unless
``sui_package_id`` and ``sui_server_address`` are configured.
"""
from __future__ import annotations

import base64
from typing import Any, Dict, List, Optional

import httpx

from app.core.config import get_settings
from app.core.logger import get_logger

log = get_logger(__name__)

_FULLNODE = {
    "testnet": "https://fullnode.testnet.sui.io:443",
    "mainnet": "https://fullnode.mainnet.sui.io:443",
    "devnet": "https://fullnode.devnet.sui.io:443",
    "localnet": "http://127.0.0.1:9000",
}


def _rpc_url() -> str:
    s = get_settings()
    if s.sui_rpc_url:
        return s.sui_rpc_url
    return _FULLNODE.get(s.sui_network, _FULLNODE["testnet"])


def _cap_type() -> str:
    return f"{get_settings().sui_package_id}::customer_memory::CustomerMemoryCap"


def enabled() -> bool:
    s = get_settings()
    return bool(s.sui_package_id and s.sui_server_address)


def _decode_vec_u8(v: Any) -> str:
    """Decode a Move ``vector<u8>`` field as returned by Sui JSON-RPC.

    Mirrors the frontend's ``decodeVecU8``: the field comes back either as an
    array of byte values or as a base64 string, depending on the node.
    """
    try:
        if isinstance(v, list):
            return bytes(int(b) & 0xFF for b in v).decode("utf-8", "replace")
        if isinstance(v, str):
            return base64.b64decode(v).decode("utf-8", "replace")
    except Exception:  # noqa: BLE001 — malformed field → treat as empty
        pass
    return ""


class Cap:
    __slots__ = ("cap_id", "customer_id", "memory_blob_id")

    def __init__(self, cap_id: str, customer_id: str, memory_blob_id: str) -> None:
        self.cap_id = cap_id
        self.customer_id = customer_id
        self.memory_blob_id = memory_blob_id

    def __repr__(self) -> str:  # pragma: no cover — debugging aid
        return f"Cap(customer_id={self.customer_id!r}, memory_blob_id={self.memory_blob_id!r})"


async def _rpc(client: httpx.AsyncClient, method: str, params: List[Any]) -> Any:
    resp = await client.post(
        _rpc_url(),
        json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params},
    )
    resp.raise_for_status()
    body = resp.json()
    if "error" in body:
        raise RuntimeError(f"sui rpc {method} error: {body['error']}")
    return body.get("result")


async def list_owned_caps() -> List[Cap]:
    """Every CustomerMemoryCap owned by the server address (paginated)."""
    if not enabled():
        return []
    s = get_settings()
    caps: List[Cap] = []
    cursor: Optional[str] = None
    async with httpx.AsyncClient(timeout=s.walrus_timeout) as client:
        while True:
            result = await _rpc(
                client,
                "suix_getOwnedObjects",
                [
                    s.sui_server_address,
                    {"filter": {"StructType": _cap_type()}, "options": {"showContent": True}},
                    cursor,
                    50,
                ],
            )
            for item in (result or {}).get("data", []):
                data = item.get("data") or {}
                content = data.get("content") or {}
                if content.get("dataType") != "moveObject":
                    continue
                fields = content.get("fields") or {}
                caps.append(
                    Cap(
                        cap_id=data.get("objectId", ""),
                        customer_id=_decode_vec_u8(fields.get("customer_id")),
                        memory_blob_id=_decode_vec_u8(fields.get("memory_blob_id")),
                    )
                )
            if result and result.get("hasNextPage"):
                cursor = result.get("nextCursor")
            else:
                break
    return caps


async def resolve_manifest_blob_id(customer_id: str) -> Optional[str]:
    """The Walrus manifest blob id anchored in a customer's cap (or None).

    ``customer_id`` is the parent namespace string, which is exactly what the cap
    stores. Returns None when recovery is disabled, no cap matches, or the cap
    holds a non-blob value (e.g. an older transcript fingerprint).
    """
    if not enabled() or not customer_id:
        return None
    try:
        for cap in await list_owned_caps():
            if cap.customer_id == customer_id:
                return cap.memory_blob_id or None
    except Exception as exc:  # noqa: BLE001 — recovery is best-effort
        log.warning("sui resolve_manifest_blob_id(%s) failed: %s", customer_id, exc)
    return None
