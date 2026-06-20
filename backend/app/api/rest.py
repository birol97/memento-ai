"""REST endpoints for the knowledge-base UI.

  GET    /clients?q=...                  search clients (name/phone/email)
  POST   /clients                        create or upsert a client
  GET    /clients/{id}                   one client (with tags)
  PATCH  /clients/{id}                   patch any subset of fields
  DELETE /clients/{id}                   delete client (cascades sessions, tags, attachments)
  PUT    /clients/{id}/tags              replace tag set ({"tags": ["a","b"]})
  GET    /tags                           all tag names (autocomplete)

  GET    /clients/{id}/sessions          list sessions for a client (newest first)
  GET    /sessions/{id}                  session detail (turns + suggestions)

  GET    /clients/{id}/attachments       list files for a client
  POST   /clients/{id}/attachments       multipart upload (field name: 'file')
  GET    /attachments/{id}               download file (Content-Disposition: attachment)
  DELETE /attachments/{id}               delete file (and remove from disk)
"""
from __future__ import annotations

import mimetypes
import re
import uuid
from pathlib import Path
from typing import List, Optional

import asyncio

from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from app.core.auth import OVERSIGHT_ROLES, Principal, current_principal, require_role
from app.core.config import get_settings
from app.core.logger import get_logger
from app.db import repository as repo
from app.services.audio_ingest import process_upload_job

log = get_logger(__name__)
router = APIRouter()


def _owner_filter(p: Principal) -> Optional[str]:
    """None for oversight roles (see all org clients); the caller's address for
    reps/managers (private books — see only their own)."""
    return None if p.role in OVERSIGHT_ROLES else p.sui_address


class ClientIn(BaseModel):
    name: str = Field(..., min_length=1)
    phone: Optional[str] = None
    email: Optional[str] = None
    notes: Optional[str] = None
    role: Optional[str] = None
    deal_stage: Optional[str] = None
    profile: Optional[str] = None
    objective: Optional[str] = None
    relationship: Optional[str] = None


class ClientPatch(BaseModel):
    name: Optional[str] = None
    phone: Optional[str] = None
    email: Optional[str] = None
    notes: Optional[str] = None
    role: Optional[str] = None
    deal_stage: Optional[str] = None
    profile: Optional[str] = None
    objective: Optional[str] = None
    relationship: Optional[str] = None


class TagsIn(BaseModel):
    tags: List[str] = Field(default_factory=list)


# ─── clients ──────────────────────────────────────────────────────────────

@router.get("/clients")
def list_clients(
    q: Optional[str] = None,
    limit: int = 50,
    principal: Principal = Depends(current_principal),
):
    return {
        "clients": repo.list_clients(
            query=q, limit=limit, org_id=principal.org_id,
            owner_sui_address=_owner_filter(principal),
        )
    }


@router.post("/clients")
def create_client(body: ClientIn, principal: Principal = Depends(current_principal)):
    client = repo.upsert_client(
        name=body.name,
        phone=body.phone or None,
        email=body.email or None,
        notes=body.notes or None,
        org_id=principal.org_id,
        owner_sui_address=principal.sui_address,
    )
    # Optional profile fields on initial create — apply via patch since
    # upsert is by contact identity and shouldn't overwrite these on
    # returning clients.
    has_extra = any(
        v is not None
        for v in (body.role, body.deal_stage, body.profile, body.objective, body.relationship)
    )
    if has_extra:
        client = repo.update_client(
            client["id"],
            role=body.role,
            deal_stage=body.deal_stage,
            profile=body.profile,
            objective=body.objective,
            relationship=body.relationship,
            org_id=principal.org_id,
        ) or client
    return repo.get_client(client["id"], principal.org_id, _owner_filter(principal))


@router.get("/clients/{client_id}")
def get_client(client_id: int, principal: Principal = Depends(current_principal)):
    client = repo.get_client(client_id, principal.org_id, _owner_filter(principal))
    if client is None:
        raise HTTPException(404, "client not found")
    return client


@router.patch("/clients/{client_id}")
def patch_client(
    client_id: int, body: ClientPatch, principal: Principal = Depends(current_principal)
):
    if repo.get_client(client_id, principal.org_id, _owner_filter(principal)) is None:
        raise HTTPException(404, "client not found")
    repo.update_client(
        client_id,
        name=body.name,
        phone=body.phone,
        email=body.email,
        notes=body.notes,
        role=body.role,
        deal_stage=body.deal_stage,
        profile=body.profile,
        objective=body.objective,
        relationship=body.relationship,
        org_id=principal.org_id,
    )
    return repo.get_client(client_id, principal.org_id, _owner_filter(principal))


@router.delete("/clients/{client_id}")
def delete_client(
    client_id: int, principal: Principal = Depends(require_role("owner", "admin"))
):
    settings = get_settings()
    if repo.get_client(client_id, principal.org_id, _owner_filter(principal)) is None:
        raise HTTPException(404, "client not found")
    # Best-effort: remove attachment files from disk before the cascade.
    for att in repo.list_attachments(client_id):
        _safe_unlink(Path(settings.attachments_dir) / att["storage_path"])
    from app.db.connection import get_conn
    with get_conn() as conn:
        conn.execute(
            "DELETE FROM clients WHERE id = ? AND org_id = ?", (client_id, principal.org_id)
        )
    return {"deleted": client_id}


class OwnerIn(BaseModel):
    sui_address: str = Field(..., min_length=3)


@router.patch("/clients/{client_id}/owner")
def reassign_client(
    client_id: int,
    body: OwnerIn,
    principal: Principal = Depends(require_role("owner", "admin")),
):
    """Reassign a client to another rep (oversight only). The new owner must be a
    member of the same org."""
    if repo.get_client(client_id, principal.org_id) is None:
        raise HTTPException(404, "client not found")
    if repo.get_membership(principal.org_id, body.sui_address) is None:
        raise HTTPException(400, "new owner must be a member of this org")
    return repo.reassign_client_owner(client_id, principal.org_id, body.sui_address)


# ─── tags ─────────────────────────────────────────────────────────────────

@router.put("/clients/{client_id}/tags")
def set_tags(
    client_id: int, body: TagsIn, principal: Principal = Depends(current_principal)
):
    if repo.get_client(client_id, principal.org_id, _owner_filter(principal)) is None:
        raise HTTPException(404, "client not found")
    return {"tags": repo.set_client_tags(client_id, body.tags)}


@router.get("/tags")
def all_tags():
    return {"tags": repo.list_all_tags()}


# ─── sessions ─────────────────────────────────────────────────────────────

@router.get("/clients/{client_id}/sessions")
def list_client_sessions(
    client_id: int, limit: int = 50, principal: Principal = Depends(current_principal)
):
    if repo.get_client(client_id, principal.org_id, _owner_filter(principal)) is None:
        raise HTTPException(404, "client not found")
    return {"sessions": repo.list_sessions_for_client(client_id, limit=limit)}


# ─── sub-namespaces (per-conversation memory spaces under a client) ─────────

class SubspaceIn(BaseModel):
    label: str = Field(..., min_length=1)
    ns_key: Optional[str] = None


class NoteIn(BaseModel):
    text: str = Field(..., min_length=1)


class CallLogIn(BaseModel):
    to: str = Field(..., min_length=1)
    seconds: int = 0
    status: str = "completed"  # completed | missed | failed
    direction: str = "out"
    transcript: str = ""  # full call transcript (assisted calls) → summarized + stored


async def _summarize_call(transcript: str) -> str:
    """Best-effort one-paragraph summary of a call transcript via Ollama."""
    if not transcript.strip():
        return ""
    import httpx
    from app.core.config import get_settings
    s = get_settings()
    prompt = (
        "Summarize this phone call in 2-3 sentences: what was discussed, any "
        "decisions, and any new facts about the customer (e.g. they moved, changed "
        "goals). Be concrete.\n\nTRANSCRIPT:\n" + transcript[:6000]
    )
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            r = await client.post(
                f"{s.ollama_base_url}/api/generate",
                json={"model": s.ollama_model, "prompt": prompt, "stream": False},
            )
            return (r.json().get("response") or "").strip() if r.status_code == 200 else ""
    except Exception as exc:  # noqa: BLE001
        log.warning("call summary failed: %s", exc)
        return ""


@router.get("/clients/{client_id}/subspaces")
def list_client_subspaces(
    client_id: int, principal: Principal = Depends(current_principal)
):
    if repo.get_client(client_id, principal.org_id, _owner_filter(principal)) is None:
        raise HTTPException(404, "client not found")
    return {"subspaces": repo.list_subspaces(client_id)}


@router.post("/clients/{client_id}/subspaces")
def create_client_subspace(
    client_id: int, body: SubspaceIn, principal: Principal = Depends(current_principal)
):
    if repo.get_client(client_id, principal.org_id, _owner_filter(principal)) is None:
        raise HTTPException(404, "client not found")
    import re
    import uuid

    key = (body.ns_key or "").strip()
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,40}", key):
        key = "s-" + uuid.uuid4().hex[:8]
    return repo.create_subspace(client_id, key, body.label.strip() or key)


@router.post("/clients/{client_id}/notes")
async def add_client_note(
    client_id: int, body: NoteIn, principal: Principal = Depends(current_principal)
):
    """Add a free-text note to a customer — as simple as sending a message. The
    note is recorded in the thread as a `note` message and stored on Walrus. The
    semantic write into the customer's MemWal namespace is done client-side via
    rememberRaw (the relayer key lives in the frontend)."""
    if repo.get_client(client_id, principal.org_id, _owner_filter(principal)) is None:
        raise HTTPException(404, "client not found")
    text = body.text.strip()
    blob_id = None
    try:
        from app.services.walrus import WalrusStore
        from datetime import datetime, timezone
        blob_id = await WalrusStore().put_json(
            {"kind": "note", "direction": "out", "client_id": client_id, "text": text,
             "at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")}
        )
    except Exception as exc:  # noqa: BLE001 — Walrus is best-effort
        log.warning("walrus store failed for note: %s", exc)
    msg = repo.create_message(
        org_id=principal.org_id,
        owner_sui_address=principal.sui_address,
        client_id=client_id,
        channel_id=None,
        kind="note",
        direction="out",
        to_addr=None,
        from_addr=None,
        subject=None,
        body=text,
        status="sent",
        blob_id=blob_id,
    )
    return {"message": msg, "ok": True, "blob_id": blob_id}


@router.post("/clients/{client_id}/calls")
async def log_client_call(
    client_id: int, body: CallLogIn, principal: Principal = Depends(current_principal)
):
    """Record an in-app phone call in the customer's thread. The browser softphone
    talks straight to Twilio, so the backend never saw the call — the client logs
    it here when the call ends so it shows up in the chat like any interaction. The
    call detail is also written to Walrus (like notes) so the record is durable."""
    if repo.get_client(client_id, principal.org_id, _owner_filter(principal)) is None:
        raise HTTPException(404, "client not found")
    direction = body.direction if body.direction in ("in", "out") else "out"
    mins, secs = divmod(max(0, body.seconds), 60)
    dur = f"{mins}m {secs}s" if mins else f"{secs}s"
    # AI summary of the conversation (when we have a transcript)
    convo_summary = await _summarize_call(body.transcript) if body.transcript.strip() else ""
    label = "Missed call" if body.status == "missed" else (
        "Call failed" if body.status == "failed" else f"Phone call · {dur}"
    )
    # the thread message shows the summary so you can read what the call was about
    summary = f"{label} — {convo_summary}" if convo_summary else label
    blob_id = None
    try:
        from app.services.walrus import WalrusStore
        from datetime import datetime, timezone
        blob_id = await WalrusStore().put_json({
            "kind": "call",
            "client_id": client_id,
            "direction": direction,
            "to": body.to,
            "seconds": max(0, body.seconds),
            "status": body.status,
            "summary": convo_summary,
            "transcript": body.transcript,  # full transcript stored on Walrus
            "at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ"),
        })
    except Exception as exc:  # noqa: BLE001 — Walrus is best-effort
        log.warning("walrus store failed for call: %s", exc)
    msg = repo.create_message(
        org_id=principal.org_id,
        owner_sui_address=principal.sui_address,
        client_id=client_id,
        channel_id=None,
        kind="call",
        direction=direction,
        to_addr=body.to,
        from_addr=None,
        subject=None,
        body=summary,
        status="sent" if body.status == "completed" else "error",
        blob_id=blob_id,
    )
    return {"message": msg, "ok": True, "blob_id": blob_id}


# ─── namespace manifest (the memory-map blob on Walrus) ─────────────────────

@router.post("/clients/{client_id}/manifest")
async def publish_client_manifest(
    client_id: int, principal: Principal = Depends(current_principal)
):
    """Build this customer's namespace map and write it to Walrus as an immutable
    blob. Returns the blob id (to anchor in the on-chain cap) + a public URL."""
    if repo.get_client(client_id, principal.org_id, _owner_filter(principal)) is None:
        raise HTTPException(404, "client not found")
    from app.services import manifest as manifest_svc
    try:
        return await manifest_svc.publish_manifest(client_id, org_id=principal.org_id)
    except Exception as exc:  # network / Walrus errors surface as 502
        log.warning("manifest publish failed for client %s: %s", client_id, exc)
        raise HTTPException(502, f"walrus publish failed: {exc}")


@router.post("/clients/{client_id}/memwal-account")
def set_client_memwal_account(
    client_id: int, body: dict, principal: Principal = Depends(current_principal)
):
    """Cache the customer's org-owned MemWalAccount id (provisioned client-side)."""
    if repo.get_client(client_id, principal.org_id, _owner_filter(principal)) is None:
        raise HTTPException(404, "client not found")
    account_id = (body or {}).get("account_id")
    if not isinstance(account_id, str) or not account_id.startswith("0x"):
        raise HTTPException(400, "account_id (0x…) required")
    repo.set_client_memwal_account(client_id, account_id, org_id=principal.org_id)
    return {"ok": True, "memwal_account_id": account_id}


@router.get("/clients/{client_id}/manifest")
def preview_client_manifest(
    client_id: int, principal: Principal = Depends(current_principal)
):
    """Preview the manifest that *would* be published (no Walrus write)."""
    if repo.get_client(client_id, principal.org_id, _owner_filter(principal)) is None:
        raise HTTPException(404, "client not found")
    from app.services import manifest as manifest_svc
    return manifest_svc.build_manifest(client_id, org_id=principal.org_id)


@router.get("/manifest/{blob_id}")
async def read_manifest_blob(blob_id: str):
    """Fetch + parse a manifest back from Walrus by blob id (verify / handoff).

    This is what a NEW owner of the cap calls: read the cap's pointer, then this,
    to learn every namespace without any local registry."""
    from app.services import manifest as manifest_svc
    try:
        return await manifest_svc.read_manifest(blob_id)
    except Exception as exc:
        raise HTTPException(404, f"manifest not found / unreadable: {exc}")


# ─── agent storage: shared Walrus blobs + per-agent resumable state ──────────
# The multi-agent pipeline (scanner → drafter → actioner) coordinates by writing
# and reading content-addressed Walrus blobs; agent state survives restarts via
# the agent_state pointer (the blob is the truth, this row just locates it).
@router.post("/agent/blob")
async def put_agent_blob(body: dict, principal: Principal = Depends(current_principal)):
    """Store an agent artifact (findings/drafts/actions/state) on Walrus."""
    from app.services.walrus import WalrusStore
    payload = (body or {}).get("data")
    if payload is None:
        raise HTTPException(400, "data required")
    store = WalrusStore()
    blob_id = await store.put_json(payload)
    return {"ok": True, "blob_id": blob_id, "aggregator_url": store.aggregator_url(blob_id)}


@router.get("/agent/blob/{blob_id}")
async def get_agent_blob(blob_id: str):
    """Fetch an agent artifact back from Walrus."""
    from app.services.walrus import WalrusStore
    try:
        return await WalrusStore().get_json(blob_id)
    except Exception as exc:
        raise HTTPException(404, f"blob not found / unreadable: {exc}")


@router.get("/agent/state/{name}")
def get_agent_state(name: str, principal: Principal = Depends(current_principal)):
    """The latest state-blob pointer for a named agent (e.g. 'commitments-monitor')."""
    return {"name": name, "blob_id": repo.get_agent_state_pointer(name)}


@router.post("/agent/state/{name}")
def set_agent_state(name: str, body: dict, principal: Principal = Depends(current_principal)):
    """Point a named agent at its newest Walrus state blob."""
    blob_id = (body or {}).get("blob_id")
    if not isinstance(blob_id, str) or not blob_id:
        raise HTTPException(400, "blob_id required")
    repo.set_agent_state_pointer(name, blob_id)
    return {"ok": True, "name": name, "blob_id": blob_id}


# ─── access index: everything the current user can retrieve ─────────────────

@router.get("/me/memory-index")
def my_memory_index(
    limit_messages: int = 500,
    principal: Principal = Depends(current_principal),
):
    """The complete, RBAC-scoped retrieval index for the signed-in user.

    Returns two retrieval surfaces, both scoped to what this principal can access
    (own book for manager/rep; whole org for owner/admin):

    1. ``clients[].namespaces`` — MemWal namespaces (parent + per-conversation
       subspaces). Retrieve content with ``recall(namespace)``.
    2. ``inbox[]`` — message rows, each with a ``blob_id`` for the raw Walrus blob
       holding that message's content (inbox is NOT MemWal namespace-addressed).

    This is the authoritative source for "what can this user read?" — built from the
    SQLite registry (complete), unlike on-chain cap enumeration (anchored subset)."""
    from app.services import manifest as manifest_svc

    owner = _owner_filter(principal)
    org_id = principal.org_id

    clients_out = []
    flat_namespaces = []
    for c in repo.list_clients(limit=10_000, org_id=org_id, owner_sui_address=owner):
        cid = c["id"]
        parent = manifest_svc.client_namespace(cid, org_id)
        namespaces = [{"namespace": parent, "kind": "parent", "label": "Generic profile"}]
        for s in repo.list_subspaces(cid):
            namespaces.append({
                "namespace": manifest_svc.sub_namespace(cid, s["ns_key"], org_id),
                "kind": "sub",
                "label": s.get("label") or s["ns_key"],
            })
        flat_namespaces.extend(n["namespace"] for n in namespaces)
        clients_out.append({
            "client_id": cid,
            "name": c.get("name"),
            "relationship": c.get("relationship"),
            "namespaces": namespaces,
        })

    inbox = [
        {
            "id": m["id"],
            "kind": m["kind"],
            "direction": m["direction"],
            "client_id": m.get("client_id"),
            "channel_id": m.get("channel_id"),
            "to_addr": m.get("to_addr"),
            "from_addr": m.get("from_addr"),
            "subject": m.get("subject"),
            "blob_id": m.get("blob_id"),   # → fetch raw content from the Walrus aggregator
            "created_at": m.get("created_at"),
        }
        for m in repo.list_messages(org_id, owner, limit=limit_messages)
    ]

    return {
        "org_id": org_id,
        "role": principal.role,
        "scope": "org" if owner is None else "own",
        "client_count": len(clients_out),
        "namespace_count": len(flat_namespaces),
        "namespaces": flat_namespaces,   # convenience: flat list for bulk recall
        "clients": clients_out,
        "inbox": inbox,
    }


@router.get("/sessions/{session_id}")
def get_session(session_id: str, principal: Principal = Depends(current_principal)):
    session = repo.get_session(session_id)
    if session is None:
        raise HTTPException(404, "session not found")
    client = (
        repo.get_client(session["client_id"], principal.org_id, _owner_filter(principal))
        if session.get("client_id")
        else None
    )
    # A session tied to a client in another org is not visible to this caller.
    if session.get("client_id") and client is None:
        raise HTTPException(404, "session not found")
    return {
        "session": session,
        "client": client,
        "turns": repo.list_turns(session_id),
        "suggestions": repo.list_suggestions(session_id),
    }


# ─── attachments ──────────────────────────────────────────────────────────

_FILENAME_SAFE_RE = re.compile(r"[^A-Za-z0-9._-]+")


def _safe_unlink(path: Path) -> None:
    try:
        path.unlink(missing_ok=True)
    except Exception as exc:  # pragma: no cover
        log.warning("failed to unlink %s: %s", path, exc)


def _safe_filename(name: str) -> str:
    base = Path(name).name  # strip any directory components
    cleaned = _FILENAME_SAFE_RE.sub("_", base).strip("._-") or "file"
    return cleaned[:120]


@router.get("/clients/{client_id}/attachments")
def list_client_attachments(
    client_id: int, principal: Principal = Depends(current_principal)
):
    if repo.get_client(client_id, principal.org_id, _owner_filter(principal)) is None:
        raise HTTPException(404, "client not found")
    return {"attachments": repo.list_attachments(client_id)}


@router.post("/clients/{client_id}/attachments")
async def upload_attachment(
    client_id: int,
    file: UploadFile = File(...),
    principal: Principal = Depends(current_principal),
):
    settings = get_settings()
    if repo.get_client(client_id, principal.org_id, _owner_filter(principal)) is None:
        raise HTTPException(404, "client not found")
    if not file.filename:
        raise HTTPException(400, "filename required")

    storage_dir = Path(settings.attachments_dir)
    storage_dir.mkdir(parents=True, exist_ok=True)

    safe_name = _safe_filename(file.filename)
    rel_path = f"{uuid.uuid4().hex}_{safe_name}"
    abs_path = storage_dir / rel_path

    size = 0
    chunk_size = 1024 * 1024
    try:
        with abs_path.open("wb") as f:
            while True:
                chunk = await file.read(chunk_size)
                if not chunk:
                    break
                size += len(chunk)
                if size > settings.attachment_max_bytes:
                    f.close()
                    abs_path.unlink(missing_ok=True)
                    raise HTTPException(
                        413,
                        f"file too large (max {settings.attachment_max_bytes // (1024 * 1024)} MB)",
                    )
                f.write(chunk)
    except HTTPException:
        raise
    except Exception as exc:
        _safe_unlink(abs_path)
        raise HTTPException(500, f"upload failed: {exc}")

    mime = file.content_type or mimetypes.guess_type(file.filename)[0]
    return repo.add_attachment(
        client_id=client_id,
        filename=file.filename,
        mime_type=mime,
        size_bytes=size,
        storage_path=rel_path,
    )


@router.get("/attachments/{attachment_id}")
def download_attachment(
    attachment_id: int, principal: Principal = Depends(current_principal)
):
    settings = get_settings()
    att = repo.get_attachment(attachment_id)
    if att is None or repo.get_client(att["client_id"], principal.org_id, _owner_filter(principal)) is None:
        raise HTTPException(404, "attachment not found")
    abs_path = Path(settings.attachments_dir) / att["storage_path"]
    if not abs_path.exists():
        raise HTTPException(410, "file no longer present on disk")
    return FileResponse(
        path=abs_path,
        media_type=att.get("mime_type") or "application/octet-stream",
        filename=att["filename"],
    )


@router.delete("/attachments/{attachment_id}")
def delete_attachment_route(
    attachment_id: int, principal: Principal = Depends(current_principal)
):
    settings = get_settings()
    att = repo.get_attachment(attachment_id)
    if att is None or repo.get_client(att["client_id"], principal.org_id, _owner_filter(principal)) is None:
        raise HTTPException(404, "attachment not found")
    repo.delete_attachment(attachment_id)
    _safe_unlink(Path(settings.attachments_dir) / att["storage_path"])
    return {"deleted": attachment_id}


# ─── voice enrollment ─────────────────────────────────────────────────────

# Cap upload at 60s of 16 kHz Float32 mono. Enrollment only needs ~10s, but
# we leave headroom in case the rep records a longer sample.
_ENROLL_MAX_BYTES = 60 * 16000 * 4
# Need at least ~3s of voice for a stable embedding.
_ENROLL_MIN_BYTES = 3 * 16000 * 4


@router.get("/enrollment")
def get_enrollment():
    """Return whether a rep voice print is enrolled, and basic metadata."""
    row = repo.get_rep_voice_print()
    if row is None:
        return {"enrolled": False}
    return {
        "enrolled": True,
        "duration_s": row["duration_s"],
        "sample_rate": row["sample_rate"],
        "created_at": row["created_at"],
    }


@router.post("/enrollment")
async def post_enrollment(file: UploadFile = File(...)):
    """Accept a Float32 PCM mono 16 kHz blob, extract the rep's voice print,
    and store it as the singleton enrollment row.

    The frontend records via AudioCapture and uploads the raw Float32 bytes
    as multipart/form-data — same wire format as our WebSocket binary frames.
    """
    import numpy as np

    try:
        from app.services import speaker_id
    except Exception as exc:  # pragma: no cover  — extreme defensive
        raise HTTPException(503, f"speaker_id unavailable: {exc}")

    payload = await file.read(_ENROLL_MAX_BYTES + 1)
    if len(payload) > _ENROLL_MAX_BYTES:
        raise HTTPException(413, f"enrollment too large (max {_ENROLL_MAX_BYTES // 4 // 16000}s)")
    if len(payload) < _ENROLL_MIN_BYTES:
        raise HTTPException(
            400,
            f"enrollment too short — need at least {_ENROLL_MIN_BYTES // 4 // 16000}s of audio "
            f"({len(payload) // 4 / 16000:.2f}s received)",
        )
    if len(payload) % 4 != 0:
        raise HTTPException(400, "payload must be a multiple of 4 bytes (Float32)")

    samples = np.frombuffer(payload, dtype=np.float32)
    duration_s = float(len(samples) / 16000)

    try:
        embedding = speaker_id.extract_embedding(samples, sample_rate=16000)
    except speaker_id.SpeakerIdUnavailable as exc:
        raise HTTPException(503, str(exc))
    except ValueError as exc:
        raise HTTPException(400, str(exc))

    row = repo.set_rep_voice_print(
        embedding=embedding.tobytes(),
        sample_rate=16000,
        duration_s=duration_s,
    )
    log.info("rep voice print enrolled: %.2fs, %d-dim", duration_s, embedding.shape[0])
    return {
        "enrolled": True,
        "duration_s": row["duration_s"],
        "sample_rate": row["sample_rate"],
        "created_at": row["created_at"],
    }


@router.delete("/enrollment")
def delete_enrollment():
    cleared = repo.clear_rep_voice_print()
    return {"enrolled": False, "deleted": cleared}


# ─── upload past calls ───────────────────────────────────────────────────

# Reasonable cap for an audio upload (mp3/wav/etc). 200 MB covers a
# multi-hour mp3; large enough that we're not the bottleneck.
_UPLOAD_MAX_BYTES = 200 * 1024 * 1024


def _job_to_response(job: dict) -> dict:
    """Trim job rows to a stable JSON shape for the polling endpoint."""
    return {
        "id": job["id"],
        "client_id": job["client_id"],
        "filename": job["filename"],
        "status": job["status"],
        "phase": job.get("phase"),
        "progress": float(job.get("progress") or 0.0),
        "duration_s": job.get("duration_s"),
        "session_id": job.get("session_id"),
        "error": job.get("error"),
        "created_at": job.get("created_at"),
        "finished_at": job.get("finished_at"),
    }


@router.post("/clients/{client_id}/sessions/from-audio")
async def upload_past_call(
    request: Request,
    client_id: int,
    file: UploadFile = File(...),
    principal: Principal = Depends(current_principal),
):
    """Upload a recorded call. The server transcribes + diarizes + summarizes
    asynchronously and links the result as a session for this client.

    Returns the upload job row immediately; the frontend polls
    ``GET /jobs/{id}`` until ``status='done'``, then loads
    ``GET /sessions/{job.session_id}``.
    """
    settings = get_settings()
    if repo.get_client(client_id, principal.org_id, _owner_filter(principal)) is None:
        raise HTTPException(404, "client not found")
    if not file.filename:
        raise HTTPException(400, "filename required")

    storage_dir = Path(settings.attachments_dir)
    storage_dir.mkdir(parents=True, exist_ok=True)
    safe_name = _safe_filename(file.filename)
    rel_path = f"upload_{uuid.uuid4().hex}_{safe_name}"
    abs_path = storage_dir / rel_path

    size = 0
    try:
        with abs_path.open("wb") as f:
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                if size > _UPLOAD_MAX_BYTES:
                    f.close()
                    abs_path.unlink(missing_ok=True)
                    raise HTTPException(
                        413,
                        f"file too large (max {_UPLOAD_MAX_BYTES // (1024 * 1024)} MB)",
                    )
                f.write(chunk)
    except HTTPException:
        raise
    except Exception as exc:
        _safe_unlink(abs_path)
        raise HTTPException(500, f"upload failed: {exc}")

    if size == 0:
        _safe_unlink(abs_path)
        raise HTTPException(400, "empty file")

    job = repo.create_upload_job(
        client_id=client_id, filename=file.filename, storage_path=rel_path,
    )

    transcription_svc = request.app.state.transcription
    suggestions_svc = request.app.state.suggestions

    # Fire-and-forget worker. We rely on the upload_jobs row for state;
    # the asyncio task itself doesn't need to be awaited or tracked.
    asyncio.create_task(
        process_upload_job(
            int(job["id"]),
            transcription=transcription_svc,
            suggestions=suggestions_svc,
        )
    )

    log.info(
        "upload queued: client=%s job=%s file=%s size=%d",
        client_id, job["id"], file.filename, size,
    )
    return _job_to_response(job)


@router.get("/jobs/{job_id}")
def get_job(job_id: int, principal: Principal = Depends(current_principal)):
    job = repo.get_upload_job(job_id)
    if job is None or repo.get_client(job["client_id"], principal.org_id, _owner_filter(principal)) is None:
        raise HTTPException(404, "job not found")
    return _job_to_response(job)


@router.get("/clients/{client_id}/jobs")
def list_client_jobs(client_id: int, principal: Principal = Depends(current_principal)):
    if repo.get_client(client_id, principal.org_id, _owner_filter(principal)) is None:
        raise HTTPException(404, "client not found")
    jobs = repo.list_upload_jobs_for_client(client_id)
    return {"jobs": [_job_to_response(j) for j in jobs]}
