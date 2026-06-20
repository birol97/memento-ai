"""Symmetric encryption for channel credentials at rest (Fernet).

Channel configs (SMTP passwords, Twilio auth tokens) are encrypted before they
touch the DB and decrypted only server-side when the app actually sends/receives.
The key is derived from ``CHANNELS_ENC_SECRET`` so any passphrase works.
"""
from __future__ import annotations

import base64
import hashlib
import json
from typing import Any, Dict

from cryptography.fernet import Fernet

from app.core.config import get_settings


def _fernet() -> Fernet:
    secret = get_settings().channels_enc_secret or "dev-insecure-channels-secret-change-me"
    key = base64.urlsafe_b64encode(hashlib.sha256(secret.encode("utf-8")).digest())
    return Fernet(key)


def encrypt_json(obj: Dict[str, Any]) -> bytes:
    return _fernet().encrypt(json.dumps(obj).encode("utf-8"))


def decrypt_json(blob: bytes) -> Dict[str, Any]:
    return json.loads(_fernet().decrypt(bytes(blob)).decode("utf-8"))
