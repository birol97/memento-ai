"""Request authentication + org context (Phase 1).

The Next frontend verifies the user's zkLogin/Enoki session and mints a
short-lived HS256 session JWT `{sub: sui_address, org_id, role, exp}` signed with
``SESSION_JWT_SECRET``. This module only *verifies* that JWT (no network call) and
resolves the caller to a ``Principal``.

Transition: while ``settings.auth_required`` is False, a missing/invalid token
resolves to a synthetic default-org ``owner`` so the existing UI keeps working.
Flip ``auth_required`` True (Phase 6) to reject anonymous calls.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

from fastapi import Depends, Header, HTTPException

from app.core.config import get_settings
from app.core.logger import get_logger
from app.db import repository as repo

log = get_logger(__name__)

# Role ranking, most → least privileged. Used for documentation + gates.
ROLES = ("owner", "admin", "manager", "rep")

# Roles with org-wide visibility: they see EVERY employee's customers. Everyone
# else (manager, rep) sees only their own book.
OVERSIGHT_ROLES = ("owner", "admin")


@dataclass
class Principal:
    sui_address: str
    org_id: int
    role: str


def _synthetic_default_principal() -> Principal:
    """Owner of the default org — used only while auth_required is False."""
    return Principal(sui_address="default", org_id=repo.default_org_id() or 1, role="owner")


def current_principal(authorization: Optional[str] = Header(default=None)) -> Principal:
    settings = get_settings()

    token: Optional[str] = None
    if authorization and authorization.lower().startswith("bearer "):
        token = authorization[7:].strip()

    if not token:
        if settings.auth_required:
            raise HTTPException(401, "missing bearer token")
        return _synthetic_default_principal()

    try:
        import jwt  # PyJWT

        payload = jwt.decode(token, settings.session_jwt_secret, algorithms=["HS256"])
    except Exception as exc:  # invalid signature / expired / pyjwt missing
        if settings.auth_required:
            raise HTTPException(401, f"invalid token: {exc}")
        log.warning("invalid session token; using default principal: %s", exc)
        return _synthetic_default_principal()

    sub = payload.get("sub")
    org_id = payload.get("org_id")
    role = payload.get("role", "rep")
    if not sub or org_id is None:
        if settings.auth_required:
            raise HTTPException(401, "token missing sub/org_id")
        return _synthetic_default_principal()

    return Principal(sui_address=str(sub), org_id=int(org_id), role=str(role))


def verify_token_address(authorization: Optional[str]) -> str:
    """Verify a session/bootstrap JWT and return its `sub` (Sui address).

    Used by the first-login `/auth/sync` endpoint, where the token may carry only
    `sub` (no org yet). Always enforces the signature, regardless of auth_required.
    """
    settings = get_settings()
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(401, "missing bearer token")
    token = authorization[7:].strip()
    try:
        import jwt

        payload = jwt.decode(token, settings.session_jwt_secret, algorithms=["HS256"])
    except Exception as exc:
        raise HTTPException(401, f"invalid token: {exc}")
    sub = payload.get("sub")
    if not sub:
        raise HTTPException(401, "token missing sub")
    return str(sub)


def require_role(*allowed: str):
    """Dependency factory: 403 unless the caller's role is in ``allowed``."""

    def _dep(principal: Principal = Depends(current_principal)) -> Principal:
        if principal.role not in allowed:
            raise HTTPException(
                403, f"role '{principal.role}' not permitted; needs one of {list(allowed)}"
            )
        return principal

    return _dep
