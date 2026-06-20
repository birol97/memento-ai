"""Outbound send + message list (the start of the omnichannel inbox).

POST /channels/{id}/send  — send email/SMS via a connected channel; the content
is stored on Walrus and recorded in the messages registry.
GET  /messages            — list communications (scoped per-user; oversight sees all).
"""
from __future__ import annotations

import asyncio
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.core.auth import OVERSIGHT_ROLES, Principal, current_principal
from app.core.config import get_settings
from app.core.crypto import decrypt_json
from app.core.logger import get_logger
from app.db import repository as repo
from app.services.messaging import end_call, place_relay_call, send_via_channel
from app.services.walrus import WalrusStore

log = get_logger(__name__)
router = APIRouter()


def _owner_filter(p: Principal) -> Optional[str]:
    return None if p.role in OVERSIGHT_ROLES else p.sui_address


class SendIn(BaseModel):
    to: str = Field(..., min_length=1)
    subject: Optional[str] = None
    body: str = Field(..., min_length=1)
    client_id: Optional[int] = None


class CallIn(BaseModel):
    to: str = Field(..., min_length=1)
    client_id: Optional[int] = None


class HangupIn(BaseModel):
    call_sid: str = Field(..., min_length=1)


def _public_message(m: Dict[str, Any]) -> Dict[str, Any]:
    return {
        k: m.get(k)
        for k in (
            "id", "kind", "direction", "to_addr", "from_addr", "subject", "body",
            "status", "error", "blob_id", "provider_id", "client_id", "channel_id",
            "created_at",
        )
    }


@router.post("/channels/{channel_id}/send")
async def send_message(
    channel_id: int, body: SendIn, principal: Principal = Depends(current_principal)
):
    ch = repo.get_channel(channel_id, principal.org_id, _owner_filter(principal))
    if ch is None:
        raise HTTPException(404, "channel not found")
    cfg = decrypt_json(ch["config_enc"])
    kind = ch["kind"]

    # 1. send (blocking provider call off the event loop)
    status, err, provider_id = "sent", None, None
    try:
        provider_id = await asyncio.to_thread(
            send_via_channel, kind, cfg, to=body.to, subject=body.subject or "", body=body.body
        )
    except Exception as exc:  # noqa: BLE001 — surface the provider error to the UI
        status, err = "error", str(exc)[:300]

    # 2. store the content on Walrus (best-effort; never blocks the record)
    blob_id = None
    try:
        store = WalrusStore()
        from datetime import datetime, timezone
        blob_id = await store.put_json(
            {
                "kind": kind, "direction": "out", "to": body.to,
                "from": ch.get("identity"), "subject": body.subject, "body": body.body,
                "channel_id": channel_id, "status": status,
                "at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ"),
            }
        )
    except Exception as exc:  # noqa: BLE001
        log.warning("walrus store failed for message: %s", exc)

    # 3. record in the inbox registry
    msg = repo.create_message(
        org_id=principal.org_id,
        owner_sui_address=principal.sui_address,
        client_id=body.client_id,
        channel_id=channel_id,
        kind=kind,
        direction="out",
        to_addr=body.to,
        from_addr=ch.get("identity"),
        subject=body.subject,
        body=body.body,
        status=status,
        error=err,
        blob_id=blob_id,
        provider_id=provider_id,
    )
    return {"message": _public_message(msg), "ok": status == "sent", "error": err}


@router.post("/channels/{channel_id}/call")
async def place_call(
    channel_id: int, body: CallIn, principal: Principal = Depends(current_principal)
):
    """Place an outbound call using this user's TWILIO channel, routed through the
    shared Voice Relay (invisible infra — one relay serves every user's own
    Twilio account)."""
    settings = get_settings()
    if not settings.voice_relay_url:
        raise HTTPException(503, "voice relay not configured (set VOICE_RELAY_URL)")
    ch = repo.get_channel(channel_id, principal.org_id, _owner_filter(principal))
    if ch is None:
        raise HTTPException(404, "channel not found")
    if ch["kind"] != "twilio":
        raise HTTPException(400, "calls require a Twilio channel")
    cfg = decrypt_json(ch["config_enc"])

    status, err, call_sid = "sent", None, None
    try:
        # session_id lets the relay correlate its live transcript stream back to us.
        result = await asyncio.to_thread(
            place_relay_call,
            settings.voice_relay_url,
            settings.voice_relay_api_key,
            cfg,
            body.to,
            f"call-{principal.org_id}-{body.client_id or 0}",
        )
        call_sid = result.get("call_sid")
    except Exception as exc:  # noqa: BLE001
        status, err = "error", str(exc)[:300]

    blob_id = None
    try:
        from datetime import datetime, timezone
        blob_id = await WalrusStore().put_json(
            {"kind": "call", "direction": "out", "to": body.to,
             "from": ch.get("identity"), "channel_id": channel_id,
             "status": status, "call_sid": call_sid,
             "at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")}
        )
    except Exception as exc:  # noqa: BLE001
        log.warning("walrus store failed for call: %s", exc)

    msg = repo.create_message(
        org_id=principal.org_id, owner_sui_address=principal.sui_address,
        client_id=body.client_id, channel_id=channel_id, kind="call", direction="out",
        to_addr=body.to, from_addr=ch.get("identity"), subject=None,
        body=f"Outbound call ({call_sid})" if call_sid else "Outbound call",
        status=status, error=err, blob_id=blob_id, provider_id=call_sid,
    )
    return {"message": _public_message(msg), "ok": status == "sent", "error": err, "call_sid": call_sid}


@router.post("/channels/{channel_id}/hangup")
async def hangup(
    channel_id: int, body: HangupIn, principal: Principal = Depends(current_principal)
):
    """End an in-progress call (by SID) using this user's Twilio channel."""
    ch = repo.get_channel(channel_id, principal.org_id, _owner_filter(principal))
    if ch is None or ch["kind"] != "twilio":
        raise HTTPException(404, "twilio channel not found")
    cfg = decrypt_json(ch["config_enc"])
    try:
        result = await asyncio.to_thread(end_call, cfg, body.call_sid)
        return {"ok": True, "status": result.get("status")}
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"hangup failed: {exc}")


@router.post("/channels/{channel_id}/voice-token")
def voice_token(channel_id: int, principal: Principal = Depends(current_principal)):
    """Mint a Twilio Voice access token for the in-browser softphone. Requires the
    Twilio channel to carry api_key_sid / api_key_secret / twiml_app_sid."""
    ch = repo.get_channel(channel_id, principal.org_id, _owner_filter(principal))
    if ch is None or ch["kind"] != "twilio":
        raise HTTPException(404, "twilio channel not found")
    cfg = decrypt_json(ch["config_enc"])
    needed = ["account_sid", "api_key_sid", "api_key_secret", "twiml_app_sid"]
    missing = [f for f in needed if not str(cfg.get(f, "")).strip()]
    if missing:
        raise HTTPException(400, f"channel missing for in-app calling: {missing}")

    from twilio.jwt.access_token import AccessToken
    from twilio.jwt.access_token.grants import VoiceGrant

    identity = f"ch{channel_id}"
    tok = AccessToken(cfg["account_sid"], cfg["api_key_sid"], cfg["api_key_secret"], identity=identity, ttl=3600)
    tok.add_grant(VoiceGrant(outgoing_application_sid=cfg["twiml_app_sid"], incoming_allow=False))
    jwt = tok.to_jwt()
    return {"token": jwt.decode() if isinstance(jwt, bytes) else jwt, "identity": identity, "from": ch.get("identity")}


@router.get("/messages")
def list_messages(
    client_id: Optional[int] = None, principal: Principal = Depends(current_principal)
):
    rows = repo.list_messages(principal.org_id, _owner_filter(principal), client_id=client_id)
    return {"messages": [_public_message(m) for m in rows]}
