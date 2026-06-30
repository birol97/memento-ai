"""Org / team / membership management API (Phase 2).

All endpoints authenticate via `current_principal`. RBAC is resolved against the
*target* org (path `org_id`) using the DB membership — not just the JWT — so a
user acting on an org they belong to is checked with their real role there.

Role gates:
- view members/teams         → any member (rep+)
- create team / add members  → admin+
- change/remove members      → admin+ (only owner may touch another owner)
- create org                 → any authenticated user (becomes owner)
"""
from __future__ import annotations

from typing import List, Optional

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel, Field

from app.core.auth import Principal, current_principal, verify_token_address
from app.core.logger import get_logger
from app.db import repository as repo

log = get_logger(__name__)
router = APIRouter()

_ADMIN = ("owner", "admin")


def _role_in_org(principal: Principal, org_id: int) -> Optional[str]:
    """Caller's authoritative role in `org_id`, or None if not a member.

    The synthetic default principal (transition mode, auth disabled) is treated
    as owner of any org so the existing UI keeps working.
    """
    if principal.sui_address == "default":
        return "owner"
    return repo.get_membership(org_id, principal.sui_address)


def _require_org_role(org_id: int, principal: Principal, *allowed: str) -> str:
    role = _role_in_org(principal, org_id)
    if role is None:
        raise HTTPException(403, "not a member of this org")
    if allowed and role not in allowed:
        raise HTTPException(403, f"role '{role}' not permitted; needs {list(allowed)}")
    return role


class OrgIn(BaseModel):
    name: str = Field(..., min_length=1)
    # Level B: the on-chain Org object the user created (gasless, user-signed) and
    # the zkLogin address that owns it. When present, this DB org is the off-chain
    # mirror of that on-chain company.
    org_object_id: Optional[str] = None
    owner_address: Optional[str] = None


class MemberIn(BaseModel):
    sui_address: str = Field(..., min_length=3)
    role: str = Field("rep")


class RoleIn(BaseModel):
    role: str = Field(...)


class TeamIn(BaseModel):
    name: str = Field(..., min_length=1)


class TeamMemberIn(BaseModel):
    sui_address: str = Field(..., min_length=3)


def _valid_role(role: str) -> None:
    if role not in ("owner", "admin", "manager", "rep"):
        raise HTTPException(400, "invalid role")


# ─── identity ───────────────────────────────────────────────────────────────

def _rebuild_membership_from_chain(addr: str) -> None:
    """Re-seed a user's backend org membership from their on-chain MemberCaps.

    Each on-chain Org is mirrored to a DB org keyed by its immutable object id
    (idempotent via get_org_by_object_id), and membership is restored with the
    role from the Org's authoritative members table. Best-effort — a chain read
    failure leaves the user at needs_onboarding rather than 500-ing the login."""
    from app.services import org_chain

    if not org_chain.enabled():
        return
    for co in org_chain.orgs_for_member(addr):
        existing = repo.get_org_by_object_id(co["org_object_id"])
        if existing is not None:
            org_id = existing["id"]
        else:
            org_id = repo.create_org(
                co["name"],
                org_object_id=co["org_object_id"],
                owner_address=addr if co["role"] == "owner" else None,
            )["id"]
        repo.add_org_member(org_id, addr, co["role"])


@router.post("/auth/sync")
def auth_sync(authorization: Optional[str] = Header(default=None)):
    """First-login provisioning. The Next layer verifies the user's zkLogin
    signature, then calls this with a JWT carrying their Sui address. We upsert
    the user and, if they have no org yet, create a personal workspace they own.
    Returns the org/role so Next can mint the full session JWT."""
    addr = verify_token_address(authorization)
    repo.upsert_user(addr)
    m = repo.primary_membership(addr)
    # Chain-derived identity: no local membership doesn't mean a new user — the
    # durable record is the on-chain MemberCap. Rebuild the backend org row(s) from
    # chain, keyed by the immutable on-chain Org object id, so a returning user whose
    # SQLite was wiped lands in their real org instead of being re-onboarded.
    if m is None:
        _rebuild_membership_from_chain(addr)
        m = repo.primary_membership(addr)
    # Truly new (no on-chain org) → onboarding creates the company on-chain, then
    # POST /orgs links it. current_org=None signals the frontend to route there.
    if m is None:
        return {
            "sui_address": addr,
            "current_org": None,
            "role": None,
            "needs_onboarding": True,
            "orgs": [],
        }
    return {
        "sui_address": addr,
        "current_org": m["org_id"],
        "role": m["role"],
        "needs_onboarding": False,
        "orgs": repo.list_orgs_for_user(addr),
    }


@router.get("/me")
def me(principal: Principal = Depends(current_principal)):
    if principal.sui_address == "default":
        oid = repo.default_org_id()
        orgs = [{"id": oid, "name": "Default Org", "role": "owner"}] if oid else []
        return {"sui_address": "default", "email": None, "orgs": orgs, "current_org": oid}
    user = repo.get_user(principal.sui_address) or {}
    return {
        "sui_address": principal.sui_address,
        "email": user.get("email"),
        "display_name": user.get("display_name"),
        "orgs": repo.list_orgs_for_user(principal.sui_address),
        "current_org": principal.org_id,
    }


# ─── orgs ───────────────────────────────────────────────────────────────────

@router.post("/orgs")
def create_org(
    body: OrgIn,
    authorization: Optional[str] = Header(default=None),
    principal: Principal = Depends(current_principal),
):
    # A brand-new user's session JWT carries no org yet, so current_principal falls
    # back to the synthetic "default" principal. Prefer the verified token `sub` so
    # the org is created under — and owned by — the caller's real Sui address rather
    # than "default". Falls back to the principal only in transition mode (no token).
    try:
        addr = verify_token_address(authorization)
    except HTTPException:
        addr = principal.sui_address
    if addr != "default":
        repo.upsert_user(addr)
    # Idempotent on the on-chain object: if this Org was already registered (e.g. a
    # retried onboarding call, or rebuilt from chain), reuse the row instead of
    # duplicating it.
    if body.org_object_id:
        existing = repo.get_org_by_object_id(body.org_object_id)
        if existing is not None:
            repo.add_org_member(existing["id"], addr, "owner")
            return existing
    org = repo.create_org(
        body.name,
        org_object_id=body.org_object_id,
        owner_address=body.owner_address or (addr if addr != "default" else None),
    )
    repo.add_org_member(org["id"], addr, "owner")
    return org


# ─── members ────────────────────────────────────────────────────────────────

@router.get("/orgs/{org_id}/members")
def list_members(org_id: int, principal: Principal = Depends(current_principal)):
    _require_org_role(org_id, principal)
    return {"members": repo.list_org_members(org_id)}


@router.post("/orgs/{org_id}/members")
def add_member(
    org_id: int, body: MemberIn, principal: Principal = Depends(current_principal)
):
    _require_org_role(org_id, principal, *_ADMIN)
    _valid_role(body.role)
    if body.role == "owner" and _role_in_org(principal, org_id) != "owner":
        raise HTTPException(403, "only an owner can grant the owner role")
    repo.upsert_user(body.sui_address)
    repo.add_org_member(org_id, body.sui_address, body.role)
    return {"ok": True, "members": repo.list_org_members(org_id)}


@router.patch("/orgs/{org_id}/members/{sui_address}")
def change_member_role(
    org_id: int,
    sui_address: str,
    body: RoleIn,
    principal: Principal = Depends(current_principal),
):
    caller_role = _require_org_role(org_id, principal, *_ADMIN)
    _valid_role(body.role)
    target_role = repo.get_membership(org_id, sui_address)
    if target_role is None:
        raise HTTPException(404, "member not found")
    # Only an owner may change an owner or promote someone to owner.
    if (target_role == "owner" or body.role == "owner") and caller_role != "owner":
        raise HTTPException(403, "only an owner can modify owners")
    # Don't strip the last owner.
    if target_role == "owner" and body.role != "owner" and repo.count_owners(org_id) <= 1:
        raise HTTPException(400, "cannot remove the last owner")
    repo.update_member_role(org_id, sui_address, body.role)
    return {"ok": True}


@router.delete("/orgs/{org_id}/members/{sui_address}")
def remove_member(
    org_id: int, sui_address: str, principal: Principal = Depends(current_principal)
):
    caller_role = _require_org_role(org_id, principal, *_ADMIN)
    target_role = repo.get_membership(org_id, sui_address)
    if target_role is None:
        raise HTTPException(404, "member not found")
    if target_role == "owner" and caller_role != "owner":
        raise HTTPException(403, "only an owner can remove an owner")
    if target_role == "owner" and repo.count_owners(org_id) <= 1:
        raise HTTPException(400, "cannot remove the last owner")
    repo.remove_member(org_id, sui_address)
    return {"ok": True}


# ─── teams ──────────────────────────────────────────────────────────────────

@router.get("/orgs/{org_id}/teams")
def list_teams(org_id: int, principal: Principal = Depends(current_principal)):
    _require_org_role(org_id, principal)
    return {"teams": repo.list_teams(org_id)}


@router.post("/orgs/{org_id}/teams")
def create_team(
    org_id: int, body: TeamIn, principal: Principal = Depends(current_principal)
):
    _require_org_role(org_id, principal, *_ADMIN)
    return repo.create_team(org_id, body.name)


@router.get("/teams/{team_id}/members")
def list_team_members(team_id: int, principal: Principal = Depends(current_principal)):
    team = repo.get_team(team_id)
    if team is None:
        raise HTTPException(404, "team not found")
    _require_org_role(team["org_id"], principal)
    return {"members": repo.list_team_members(team_id)}


@router.post("/teams/{team_id}/members")
def add_team_member(
    team_id: int, body: TeamMemberIn, principal: Principal = Depends(current_principal)
):
    team = repo.get_team(team_id)
    if team is None:
        raise HTTPException(404, "team not found")
    _require_org_role(team["org_id"], principal, *_ADMIN)
    if repo.get_membership(team["org_id"], body.sui_address) is None:
        raise HTTPException(400, "user must be an org member first")
    repo.add_team_member(team_id, body.sui_address)
    return {"ok": True, "members": repo.list_team_members(team_id)}
