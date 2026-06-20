"""Communication channels: connect / list / remove Email (SMTP/IMAP) and Twilio.

Credentials are encrypted at rest (Fernet); the API never returns secrets — only
a masked summary (kind, label, identity, status). Channels are per-user (the rep
who connects them); owner/admin can view all in the org. Sending/receiving and
the omnichannel inbox are a later step — this module is the connection manager.
"""
from __future__ import annotations

import smtplib
from typing import Any, Dict, List, Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.core.auth import OVERSIGHT_ROLES, Principal, current_principal
from app.core.crypto import decrypt_json, encrypt_json
from app.core.logger import get_logger
from app.db import repository as repo

log = get_logger(__name__)
router = APIRouter()

# Required credential fields per channel kind, and which field is the (non-secret)
# display identity.
REQUIRED: Dict[str, List[str]] = {
    "email": ["from_email", "smtp_host", "smtp_port", "smtp_username", "smtp_password"],
    "twilio": ["account_sid", "auth_token", "phone_number"],
}
IDENTITY_FIELD = {"email": "from_email", "twilio": "phone_number"}


class ChannelIn(BaseModel):
    kind: str = Field(..., pattern="^(email|twilio)$")
    label: Optional[str] = None
    config: Dict[str, Any] = Field(default_factory=dict)


def _owner_filter(p: Principal) -> Optional[str]:
    return None if p.role in OVERSIGHT_ROLES else p.sui_address


VOICE_FIELDS = ("account_sid", "api_key_sid", "api_key_secret", "twiml_app_sid")


def _voice_ready(row: Dict[str, Any]) -> bool:
    """True when a twilio channel carries the extra creds in-app calling needs."""
    if row.get("kind") != "twilio" or not row.get("config_enc"):
        return False
    try:
        cfg = decrypt_json(row["config_enc"])
    except Exception:  # noqa: BLE001
        return False
    return all(str(cfg.get(f, "")).strip() for f in VOICE_FIELDS)


def _mask(row: Dict[str, Any]) -> Dict[str, Any]:
    """Public view of a channel — never includes the encrypted credentials."""
    return {
        "id": row["id"],
        "kind": row["kind"],
        "label": row.get("label"),
        "identity": row.get("identity"),
        "status": row.get("status"),
        "created_at": row.get("created_at"),
        "voice_ready": _voice_ready(row),  # can place in-browser calls?
    }


def _test_channel(kind: str, cfg: Dict[str, Any]) -> tuple[bool, Optional[str]]:
    """Best-effort credential check. Returns (ok, error)."""
    try:
        if kind == "twilio":
            r = httpx.get(
                f"https://api.twilio.com/2010-04-01/Accounts/{cfg['account_sid']}.json",
                auth=(cfg["account_sid"], cfg["auth_token"]),
                timeout=8.0,
            )
            return (r.status_code == 200, None if r.status_code == 200 else f"twilio {r.status_code}")
        if kind == "email":
            port = int(cfg["smtp_port"])
            host = cfg["smtp_host"]
            if port == 465:
                srv = smtplib.SMTP_SSL(host, port, timeout=8.0)
            else:
                srv = smtplib.SMTP(host, port, timeout=8.0)
                srv.ehlo()
                try:
                    srv.starttls()
                    srv.ehlo()
                except smtplib.SMTPException:
                    pass  # server may not support STARTTLS
            srv.login(cfg["smtp_username"], cfg["smtp_password"])
            srv.quit()
            return (True, None)
    except Exception as exc:  # noqa: BLE001 — surface any connect/auth failure
        return (False, str(exc)[:200])
    return (False, "unknown kind")


@router.get("/channels")
def list_channels(principal: Principal = Depends(current_principal)):
    rows = repo.list_channels(principal.org_id, _owner_filter(principal))
    return {"channels": [_mask(r) for r in rows]}


@router.post("/channels")
def create_channel(body: ChannelIn, principal: Principal = Depends(current_principal)):
    missing = [f for f in REQUIRED[body.kind] if not str(body.config.get(f, "")).strip()]
    if missing:
        raise HTTPException(400, f"missing fields for {body.kind}: {missing}")

    ok, err = _test_channel(body.kind, body.config)
    status = "connected" if ok else "error"

    row = repo.create_channel(
        org_id=principal.org_id,
        owner_sui_address=principal.sui_address,
        kind=body.kind,
        label=body.label or body.config.get(IDENTITY_FIELD[body.kind]),
        identity=str(body.config.get(IDENTITY_FIELD[body.kind]) or ""),
        config_enc=encrypt_json(dict(body.config)),
        status=status,
    )
    return {"channel": _mask(row), "test": {"ok": ok, "error": err}}


@router.post("/channels/{channel_id}/test")
def test_channel(channel_id: int, principal: Principal = Depends(current_principal)):
    from app.core.crypto import decrypt_json

    row = repo.get_channel(channel_id, principal.org_id, _owner_filter(principal))
    if row is None:
        raise HTTPException(404, "channel not found")
    cfg = decrypt_json(row["config_enc"])
    ok, err = _test_channel(row["kind"], cfg)
    repo.set_channel_status(channel_id, "connected" if ok else "error")
    return {"ok": ok, "error": err}


@router.delete("/channels/{channel_id}")
def delete_channel(channel_id: int, principal: Principal = Depends(current_principal)):
    if not repo.delete_channel(channel_id, principal.org_id, _owner_filter(principal)):
        raise HTTPException(404, "channel not found")
    return {"deleted": channel_id}
