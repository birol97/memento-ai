"""Outbound send via a connected channel: email (SMTP) and SMS (Twilio).

Each function takes the decrypted channel config and returns a provider id (or
raises). The REST layer records the message + stores its content on Walrus.
Calls are not handled here (Twilio voice needs a public TwiML URL).
"""
from __future__ import annotations

import smtplib
from email.message import EmailMessage
from typing import Any, Dict, Optional

import httpx


def send_email(cfg: Dict[str, Any], to: str, subject: str, body: str) -> Optional[str]:
    msg = EmailMessage()
    msg["From"] = cfg["from_email"]
    msg["To"] = to
    msg["Subject"] = subject or ""
    msg.set_content(body)

    host = cfg["smtp_host"]
    port = int(cfg["smtp_port"])
    if port == 465:
        srv: smtplib.SMTP = smtplib.SMTP_SSL(host, port, timeout=20)
    else:
        srv = smtplib.SMTP(host, port, timeout=20)
        srv.ehlo()
        try:
            srv.starttls()
            srv.ehlo()
        except smtplib.SMTPException:
            pass
    try:
        srv.login(cfg["smtp_username"], cfg["smtp_password"])
        srv.send_message(msg)
    finally:
        try:
            srv.quit()
        except Exception:
            pass
    return None  # SMTP has no message id


def send_sms(cfg: Dict[str, Any], to: str, body: str) -> Optional[str]:
    sid = cfg["account_sid"]
    token = cfg["auth_token"]
    r = httpx.post(
        f"https://api.twilio.com/2010-04-01/Accounts/{sid}/Messages.json",
        data={"To": to, "From": cfg["phone_number"], "Body": body},
        auth=(sid, token),
        timeout=20.0,
    )
    if r.status_code >= 300:
        raise RuntimeError(f"twilio {r.status_code}: {r.text[:200]}")
    return r.json().get("sid")


def place_relay_call(
    relay_url: str,
    relay_api_key: str,
    twilio_cfg: Dict[str, Any],
    to: str,
    session_id: Optional[str] = None,
) -> Dict[str, Any]:
    """Trigger an outbound call via the SHARED Voice Relay, using *this user's*
    Twilio credentials (so one relay serves many users individually). The relay
    owns the media stream; we hand it the number + the user's Twilio account.
    Returns e.g. {"call_sid": "...", "status": "queued"}.
    """
    base = relay_url.rstrip("/")
    headers = {}
    if relay_api_key:
        headers["Authorization"] = f"Bearer {relay_api_key}"
    payload: Dict[str, Any] = {
        "to": to,
        "account_sid": twilio_cfg.get("account_sid"),
        "auth_token": twilio_cfg.get("auth_token"),
        "from_number": twilio_cfg.get("phone_number"),
    }
    if session_id:
        payload["session_id"] = session_id
    r = httpx.post(f"{base}/call", json=payload, headers=headers, timeout=20.0)
    if r.status_code >= 300:
        raise RuntimeError(f"relay {r.status_code}: {r.text[:200]}")
    return r.json()


def end_call(twilio_cfg: Dict[str, Any], call_sid: str) -> Dict[str, Any]:
    """Hang up an in-progress Twilio call by SID (using the user's Twilio creds)."""
    sid = twilio_cfg["account_sid"]
    r = httpx.post(
        f"https://api.twilio.com/2010-04-01/Accounts/{sid}/Calls/{call_sid}.json",
        data={"Status": "completed"},
        auth=(sid, twilio_cfg["auth_token"]),
        timeout=15.0,
    )
    if r.status_code >= 300:
        raise RuntimeError(f"twilio {r.status_code}: {r.text[:200]}")
    return r.json()


def send_via_channel(kind: str, cfg: Dict[str, Any], *, to: str, subject: str, body: str) -> Optional[str]:
    if kind == "email":
        return send_email(cfg, to, subject, body)
    if kind == "twilio":
        return send_sms(cfg, to, body)
    raise ValueError(f"unsupported channel kind: {kind}")
