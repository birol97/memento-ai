"""Read-only Sui resolver for the on-chain ORG directory (chain-derived identity).

The org/team roster is authoritative on-chain: a company is a ``salescall::org::Org``
object whose ``members`` table is the source of truth for "who works here + role",
and each member holds a ``MemberCap`` NFT pointing back at their Org. The frontend
creates/edits this (it signs); the backend only *reads* it.

This lets ``/auth/sync`` rebuild a user's backend org membership **from chain** when
the local SQLite cache is empty (fresh/ephemeral deploy) — so a returning user lands
in their real org instead of being pushed through onboarding again. Trust stays on
chain: we never accept a client's claim of membership, we read the MemberCap + Org.

No Sui SDK: plain JSON-RPC over httpx. Disabled (returns nothing) unless
``sui_org_package_id`` is configured. Mirrors services/sui_chain.py.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

import httpx

from app.core.config import get_settings
from app.core.logger import get_logger

log = get_logger(__name__)

# Must match frontend lib/orgChain.ts ROLES ordering (role is a Move u8 index).
_ROLES = ("owner", "admin", "manager", "rep")

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


def _membercap_type() -> str:
    return f"{get_settings().sui_org_package_id}::org::MemberCap"


def enabled() -> bool:
    return bool(get_settings().sui_org_package_id)


def _role_label(n: Any) -> str:
    try:
        return _ROLES[int(n)]
    except (ValueError, TypeError, IndexError):
        return "rep"


def _rpc(client: httpx.Client, method: str, params: List[Any]) -> Any:
    resp = client.post(
        _rpc_url(),
        json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params},
    )
    resp.raise_for_status()
    body = resp.json()
    if "error" in body:
        raise RuntimeError(f"sui rpc {method} error: {body['error']}")
    return body.get("result")


def _member_org_ids(client: httpx.Client, address: str) -> List[str]:
    """Org object ids the address holds a MemberCap for (paginated)."""
    org_ids: List[str] = []
    cursor: Optional[str] = None
    while True:
        result = _rpc(
            client,
            "suix_getOwnedObjects",
            [
                address,
                {"filter": {"StructType": _membercap_type()}, "options": {"showContent": True}},
                cursor,
                50,
            ],
        )
        for item in (result or {}).get("data", []):
            content = (item.get("data") or {}).get("content") or {}
            if content.get("dataType") != "moveObject":
                continue
            org = (content.get("fields") or {}).get("org")
            if org:
                org_ids.append(str(org))
        if result and result.get("hasNextPage"):
            cursor = result.get("nextCursor")
        else:
            break
    return org_ids


def _read_org(client: httpx.Client, org_id: str, address: str) -> Optional[Dict[str, Any]]:
    """An Org's {org_object_id, name, role} for `address`, re-verified against the
    authoritative members table (a stale cap whose member was revoked → None)."""
    result = _rpc(client, "sui_getObject", [org_id, {"showContent": True}])
    content = (result or {}).get("data", {}).get("content") or {}
    if content.get("dataType") != "moveObject":
        return None
    fields = content.get("fields") or {}
    want = address.lower()
    for m in fields.get("members") or []:
        mf = (m.get("fields") if isinstance(m, dict) and "fields" in m else m) or {}
        if str(mf.get("addr", "")).lower() == want:
            return {
                "org_object_id": org_id,
                "name": str(fields.get("name") or ""),
                "role": _role_label(mf.get("role")),
            }
    return None


def orgs_for_member(address: str) -> List[Dict[str, Any]]:
    """Every on-chain org `address` is an active member of, as
    [{org_object_id, name, role}]. Empty when disabled, on read error, or none.
    Synchronous (httpx.Client) so it can be called from the sync /auth/sync route."""
    if not enabled() or not address:
        return []
    s = get_settings()
    out: List[Dict[str, Any]] = []
    try:
        with httpx.Client(timeout=s.walrus_timeout) as client:
            for org_id in _member_org_ids(client, address):
                org = _read_org(client, org_id, address)
                if org is not None:
                    out.append(org)
    except Exception as exc:  # noqa: BLE001 — chain-derived recovery is best-effort
        log.warning("org_chain.orgs_for_member(%s) failed: %s", address, exc)
    return out
