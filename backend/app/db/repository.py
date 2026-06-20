"""Thin data-access functions for clients, sessions, turns, suggestions.

Each function opens its own short-lived connection so callers don't have to
worry about lifecycle. Synchronous SQLite calls run fast (<1 ms) so we don't
push them onto a thread pool unless that turns out to matter.
"""
from __future__ import annotations

import sqlite3
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from app.db.connection import get_conn


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def _row(row: Optional[sqlite3.Row]) -> Optional[Dict[str, Any]]:
    return dict(row) if row else None


# ─── clients ──────────────────────────────────────────────────────────────

def _attach_tags(conn: sqlite3.Connection, clients: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Mutate-in-place add a ``tags: [str, ...]`` field to each client dict."""
    if not clients:
        return clients
    ids = [c["id"] for c in clients]
    placeholders = ",".join("?" * len(ids))
    rows = conn.execute(
        f"SELECT ct.client_id, t.name FROM client_tags ct "
        f"JOIN tags t ON t.id = ct.tag_id "
        f"WHERE ct.client_id IN ({placeholders}) "
        f"ORDER BY t.name COLLATE NOCASE",
        ids,
    ).fetchall()
    by_client: Dict[int, List[str]] = {cid: [] for cid in ids}
    for r in rows:
        by_client[r["client_id"]].append(r["name"])
    for c in clients:
        c["tags"] = by_client.get(c["id"], [])
    return clients


def list_clients(
    query: Optional[str] = None,
    limit: int = 50,
    org_id: Optional[int] = None,
    owner_sui_address: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """List clients. `owner_sui_address`, when given, restricts to that rep's
    book (callers pass it for non-oversight roles; omit it for owner/admin)."""
    clauses: List[str] = []
    params: List[Any] = []
    if org_id is not None:
        clauses.append("org_id = ?")
        params.append(org_id)
    if owner_sui_address is not None:
        clauses.append("owner_sui_address = ?")
        params.append(owner_sui_address)
    if query:
        like = f"%{query}%"
        clauses.append("(name LIKE ? OR phone LIKE ? OR email LIKE ?)")
        params.extend([like, like, like])
    where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
    params.append(limit)
    with get_conn() as conn:
        rows = conn.execute(
            f"SELECT * FROM clients {where} ORDER BY created_at DESC LIMIT ?",
            params,
        ).fetchall()
        return _attach_tags(conn, [dict(r) for r in rows])


def get_client(
    client_id: int,
    org_id: Optional[int] = None,
    owner_sui_address: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    """Fetch one client. `owner_sui_address`, when given, requires the client to
    belong to that rep (so a rep can't reach another rep's customer → 404)."""
    clauses = ["id = ?"]
    params: List[Any] = [client_id]
    if org_id is not None:
        clauses.append("org_id = ?")
        params.append(org_id)
    if owner_sui_address is not None:
        clauses.append("owner_sui_address = ?")
        params.append(owner_sui_address)
    with get_conn() as conn:
        row = conn.execute(
            f"SELECT * FROM clients WHERE {' AND '.join(clauses)}", params
        ).fetchone()
        if row is None:
            return None
        client = dict(row)
        _attach_tags(conn, [client])
        return client


_CLIENT_FIELDS = (
    "name", "phone", "email", "notes",
    "role", "deal_stage", "profile", "objective", "relationship",
)


def update_client(
    client_id: int,
    *,
    name: Optional[str] = None,
    phone: Optional[str] = None,
    email: Optional[str] = None,
    notes: Optional[str] = None,
    role: Optional[str] = None,
    deal_stage: Optional[str] = None,
    profile: Optional[str] = None,
    objective: Optional[str] = None,
    relationship: Optional[str] = None,
    org_id: Optional[int] = None,
) -> Optional[Dict[str, Any]]:
    """Patch any subset of client fields. Pass None to leave a field unchanged.

    To explicitly clear a string field, pass an empty string ("").
    When ``org_id`` is given the UPDATE is guarded so cross-org writes no-op.
    """
    values = {
        "name": name, "phone": phone, "email": email,
        "notes": notes, "role": role, "deal_stage": deal_stage,
        "profile": profile, "objective": objective, "relationship": relationship,
    }
    sets: List[str] = []
    params: List[Any] = []
    for col in _CLIENT_FIELDS:
        if values[col] is not None:
            sets.append(f"{col} = ?")
            params.append(values[col])
    if not sets:
        return get_client(client_id, org_id)
    params.append(client_id)
    guard = ""
    if org_id is not None:
        guard = " AND org_id = ?"
        params.append(org_id)
    with get_conn() as conn:
        conn.execute(f"UPDATE clients SET {', '.join(sets)} WHERE id = ?{guard}", params)
        return _row(
            conn.execute("SELECT * FROM clients WHERE id = ?", (client_id,)).fetchone()
        )


def upsert_client(
    *,
    name: str,
    phone: Optional[str] = None,
    email: Optional[str] = None,
    notes: Optional[str] = None,
    org_id: Optional[int] = None,
    owner_sui_address: Optional[str] = None,
) -> Dict[str, Any]:
    """Find by phone/email/name, else insert. The find-existing lookup is scoped
    to ``org_id`` and (for private books) to ``owner_sui_address`` when given, so
    each rep gets their own record and orgs never collide on contact identity."""
    name = name.strip()
    if not name:
        raise ValueError("client name required")

    extra = ""
    extra_vals: List[Any] = []
    if org_id is not None:
        extra += " AND org_id = ?"
        extra_vals.append(org_id)
    if owner_sui_address is not None:
        extra += " AND owner_sui_address = ?"
        extra_vals.append(owner_sui_address)

    with get_conn() as conn:
        existing: Optional[sqlite3.Row] = None
        if phone:
            existing = conn.execute(
                f"SELECT * FROM clients WHERE phone = ?{extra} LIMIT 1", (phone, *extra_vals)
            ).fetchone()
        if existing is None and email:
            existing = conn.execute(
                f"SELECT * FROM clients WHERE email = ?{extra} LIMIT 1", (email, *extra_vals)
            ).fetchone()
        if existing is None:
            existing = conn.execute(
                f"SELECT * FROM clients WHERE name = ?{extra} LIMIT 1", (name, *extra_vals)
            ).fetchone()

        if existing is not None:
            return dict(existing)

        cur = conn.execute(
            "INSERT INTO clients (name, phone, email, notes, org_id, owner_sui_address) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (name, phone, email, notes, org_id, owner_sui_address),
        )
        client_id = cur.lastrowid
        return dict(
            conn.execute("SELECT * FROM clients WHERE id = ?", (client_id,)).fetchone()
        )


def reassign_client_owner(client_id: int, org_id: int, new_owner: str) -> Optional[Dict[str, Any]]:
    """Reassign a client to another rep (oversight action). Scoped to the org."""
    with get_conn() as conn:
        conn.execute(
            "UPDATE clients SET owner_sui_address = ? WHERE id = ? AND org_id = ?",
            (new_owner, client_id, org_id),
        )
        return _row(
            conn.execute("SELECT * FROM clients WHERE id = ?", (client_id,)).fetchone()
        )


# ─── sessions ─────────────────────────────────────────────────────────────

def create_session(session_id: str, client_id: Optional[int]) -> None:
    with get_conn() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO sessions (id, client_id, started_at) VALUES (?, ?, ?)",
            (session_id, client_id, _now_iso()),
        )


def end_session(session_id: str, summary: Optional[str]) -> None:
    with get_conn() as conn:
        conn.execute(
            "UPDATE sessions SET ended_at = ?, summary = COALESCE(?, summary) WHERE id = ?",
            (_now_iso(), summary, session_id),
        )


def get_session(session_id: str) -> Optional[Dict[str, Any]]:
    with get_conn() as conn:
        return _row(
            conn.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone()
        )


# ─── customer memory pointer (Walrus) ───────────────────────────────────────

def get_memory_pointer(client_id: int) -> Optional[str]:
    """Latest Walrus blob_id holding this customer's memory doc (or None)."""
    with get_conn() as conn:
        row = conn.execute(
            "SELECT blob_id FROM customer_memory WHERE client_id = ?", (client_id,)
        ).fetchone()
        return row["blob_id"] if row else None


def list_client_blobs(client_id: int, org_id: Optional[int] = None) -> List[Dict[str, Any]]:
    """Every Walrus conversation blob recorded for a customer — the leaf nodes
    the manifest indexes (Sui cap → manifest → THESE conversation blobs).

    A message row carries a ``blob_id`` whenever its full content (call
    transcript + summary, note, etc.) was stored on Walrus. We return those so
    the manifest becomes a verifiable index of the customer's conversations,
    not just their namespaces.
    """
    clauses = ["client_id = ?", "blob_id IS NOT NULL", "blob_id != ''"]
    params: List[Any] = [client_id]
    if org_id is not None:
        clauses.append("org_id = ?")
        params.append(org_id)
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT id, blob_id, kind, direction, to_addr, subject, body, created_at "
            f"FROM messages WHERE {' AND '.join(clauses)} ORDER BY created_at DESC",
            params,
        ).fetchall()
        return [dict(r) for r in rows]


def list_subspaces(client_id: int) -> List[Dict[str, Any]]:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT ns_key, label, created_at FROM subspaces "
            "WHERE client_id = ? ORDER BY created_at DESC",
            (client_id,),
        ).fetchall()
        return [dict(r) for r in rows]


def create_subspace(client_id: int, ns_key: str, label: str) -> Dict[str, Any]:
    with get_conn() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO subspaces (client_id, ns_key, label, created_at) "
            "VALUES (?, ?, ?, ?)",
            (client_id, ns_key, label, _now_iso()),
        )
        row = conn.execute(
            "SELECT ns_key, label, created_at FROM subspaces "
            "WHERE client_id = ? AND ns_key = ?",
            (client_id, ns_key),
        ).fetchone()
        return dict(row)


def set_client_memwal_account(client_id: int, account_id: str, org_id: Optional[int] = None) -> None:
    """Cache the customer's org-owned MemWalAccount id (rebuildable from chain)."""
    params: List[Any] = [account_id, client_id]
    sql = "UPDATE clients SET memwal_account_id = ? WHERE id = ?"
    if org_id is not None:
        sql += " AND org_id = ?"
        params.append(org_id)
    with get_conn() as conn:
        conn.execute(sql, params)


def set_memory_pointer(client_id: int, blob_id: str) -> None:
    """Point a customer at their newest Walrus memory blob (upsert)."""
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO customer_memory (client_id, blob_id, updated_at) "
            "VALUES (?, ?, ?) "
            "ON CONFLICT(client_id) DO UPDATE SET "
            "blob_id = excluded.blob_id, updated_at = excluded.updated_at",
            (client_id, blob_id, _now_iso()),
        )


def get_agent_state_pointer(name: str) -> Optional[str]:
    """Latest Walrus blob id holding a named agent's state (or None)."""
    with get_conn() as conn:
        row = conn.execute("SELECT blob_id FROM agent_state WHERE name = ?", (name,)).fetchone()
        return row["blob_id"] if row else None


def set_agent_state_pointer(name: str, blob_id: str) -> None:
    """Point a named agent at its newest Walrus state blob (upsert)."""
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO agent_state (name, blob_id, updated_at) VALUES (?, ?, ?) "
            "ON CONFLICT(name) DO UPDATE SET blob_id = excluded.blob_id, updated_at = excluded.updated_at",
            (name, blob_id, _now_iso()),
        )


def list_sessions_for_client(client_id: int, limit: int = 50) -> List[Dict[str, Any]]:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM sessions WHERE client_id = ? "
            "ORDER BY started_at DESC LIMIT ?",
            (client_id, limit),
        ).fetchall()
        return [dict(r) for r in rows]


# ─── turns ────────────────────────────────────────────────────────────────

def insert_turn(
    *,
    session_id: str,
    speaker: str,
    text: str,
    t_start: Optional[float],
    t_end: Optional[float],
) -> int:
    with get_conn() as conn:
        cur = conn.execute(
            "INSERT INTO turns (session_id, speaker, text, t_start, t_end, server_ts) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (session_id, speaker, text, t_start, t_end, _now_iso()),
        )
        return int(cur.lastrowid)


def list_turns(session_id: str) -> List[Dict[str, Any]]:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM turns WHERE session_id = ? ORDER BY id ASC",
            (session_id,),
        ).fetchall()
        return [dict(r) for r in rows]


# ─── suggestions ──────────────────────────────────────────────────────────

def insert_suggestion(
    *,
    session_id: str,
    turn_id: Optional[int],
    text: str,
    model: Optional[str],
    prompt: Optional[str] = None,
    system_prompt: Optional[str] = None,
) -> int:
    with get_conn() as conn:
        cur = conn.execute(
            "INSERT INTO suggestions "
            "(session_id, turn_id, text, prompt, system_prompt, model) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (session_id, turn_id, text, prompt, system_prompt, model),
        )
        return int(cur.lastrowid)


def list_suggestions(session_id: str) -> List[Dict[str, Any]]:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM suggestions WHERE session_id = ? ORDER BY id ASC",
            (session_id,),
        ).fetchall()
        return [dict(r) for r in rows]


# ─── history retrieval (for LLM context) ─────────────────────────────────

def history_for_client(
    client_id: int,
    *,
    summary_limit: int = 5,
    full_transcript_of_last: bool = True,
) -> Dict[str, Any]:
    """Return the prior-conversation context the AI needs at session start.

    Shape:
      {
        "summaries":  [{session_id, started_at, summary}, ...],   # oldest→newest
        "last_call":  {session_id, started_at, turns: [...]} | None
      }
    """
    with get_conn() as conn:
        sessions = conn.execute(
            "SELECT id, started_at, ended_at, summary FROM sessions "
            "WHERE client_id = ? AND ended_at IS NOT NULL "
            "ORDER BY started_at DESC LIMIT ?",
            (client_id, summary_limit),
        ).fetchall()

        sessions_list = [dict(s) for s in sessions]
        result: Dict[str, Any] = {
            "summaries": [
                {"session_id": s["id"], "started_at": s["started_at"], "summary": s["summary"]}
                for s in reversed(sessions_list)
                if s["summary"]
            ],
            "last_call": None,
        }

        if full_transcript_of_last and sessions_list:
            last = sessions_list[0]
            turns = conn.execute(
                "SELECT speaker, text, t_start, t_end FROM turns "
                "WHERE session_id = ? ORDER BY id ASC",
                (last["id"],),
            ).fetchall()
            result["last_call"] = {
                "session_id": last["id"],
                "started_at": last["started_at"],
                "turns": [dict(t) for t in turns],
            }
        return result


# ─── tags ─────────────────────────────────────────────────────────────────

def _normalize_tag(name: str) -> str:
    return " ".join(name.split()).strip().lower()


def set_client_tags(client_id: int, tags: List[str]) -> List[str]:
    """Replace the client's tag set with ``tags`` (de-duplicated, lowercased).

    Returns the canonical ordered list of tag names now attached.
    """
    cleaned: List[str] = []
    seen: set[str] = set()
    for raw in tags:
        norm = _normalize_tag(raw)
        if norm and norm not in seen:
            seen.add(norm)
            cleaned.append(norm)

    with get_conn() as conn:
        conn.execute("BEGIN")
        try:
            conn.execute("DELETE FROM client_tags WHERE client_id = ?", (client_id,))
            for name in cleaned:
                conn.execute("INSERT OR IGNORE INTO tags (name) VALUES (?)", (name,))
                row = conn.execute("SELECT id FROM tags WHERE name = ?", (name,)).fetchone()
                conn.execute(
                    "INSERT OR IGNORE INTO client_tags (client_id, tag_id) VALUES (?, ?)",
                    (client_id, row["id"]),
                )
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise

        rows = conn.execute(
            "SELECT t.name FROM client_tags ct JOIN tags t ON t.id = ct.tag_id "
            "WHERE ct.client_id = ? ORDER BY t.name COLLATE NOCASE",
            (client_id,),
        ).fetchall()
        return [r["name"] for r in rows]


def list_all_tags() -> List[str]:
    with get_conn() as conn:
        rows = conn.execute("SELECT name FROM tags ORDER BY name COLLATE NOCASE").fetchall()
        return [r["name"] for r in rows]


# ─── attachments ──────────────────────────────────────────────────────────

def add_attachment(
    *,
    client_id: int,
    filename: str,
    mime_type: Optional[str],
    size_bytes: int,
    storage_path: str,
) -> Dict[str, Any]:
    with get_conn() as conn:
        cur = conn.execute(
            "INSERT INTO attachments (client_id, filename, mime_type, size_bytes, storage_path) "
            "VALUES (?, ?, ?, ?, ?)",
            (client_id, filename, mime_type, size_bytes, storage_path),
        )
        att_id = cur.lastrowid
        return dict(
            conn.execute("SELECT * FROM attachments WHERE id = ?", (att_id,)).fetchone()
        )


def list_attachments(client_id: int) -> List[Dict[str, Any]]:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM attachments WHERE client_id = ? ORDER BY uploaded_at DESC",
            (client_id,),
        ).fetchall()
        return [dict(r) for r in rows]


def get_attachment(attachment_id: int) -> Optional[Dict[str, Any]]:
    with get_conn() as conn:
        return _row(
            conn.execute(
                "SELECT * FROM attachments WHERE id = ?", (attachment_id,)
            ).fetchone()
        )


def delete_attachment(attachment_id: int) -> Optional[Dict[str, Any]]:
    with get_conn() as conn:
        row = conn.execute(
            "SELECT * FROM attachments WHERE id = ?", (attachment_id,)
        ).fetchone()
        if row is None:
            return None
        conn.execute("DELETE FROM attachments WHERE id = ?", (attachment_id,))
        return dict(row)


# ─── upload jobs ──────────────────────────────────────────────────────────

def create_upload_job(
    *,
    client_id: int,
    filename: str,
    storage_path: str,
) -> Dict[str, Any]:
    with get_conn() as conn:
        cur = conn.execute(
            "INSERT INTO upload_jobs (client_id, filename, storage_path, status) "
            "VALUES (?, ?, ?, 'pending')",
            (client_id, filename, storage_path),
        )
        job_id = cur.lastrowid
        return dict(
            conn.execute("SELECT * FROM upload_jobs WHERE id = ?", (job_id,)).fetchone()
        )


def get_upload_job(job_id: int) -> Optional[Dict[str, Any]]:
    with get_conn() as conn:
        return _row(
            conn.execute("SELECT * FROM upload_jobs WHERE id = ?", (job_id,)).fetchone()
        )


def list_upload_jobs_for_client(client_id: int) -> List[Dict[str, Any]]:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM upload_jobs WHERE client_id = ? "
            "ORDER BY created_at DESC",
            (client_id,),
        ).fetchall()
        return [dict(r) for r in rows]


_UPLOAD_JOB_FIELDS = (
    "status", "phase", "progress", "duration_s",
    "session_id", "error", "finished_at",
)


def update_upload_job(
    job_id: int,
    *,
    status: Optional[str] = None,
    phase: Optional[str] = None,
    progress: Optional[float] = None,
    duration_s: Optional[float] = None,
    session_id: Optional[str] = None,
    error: Optional[str] = None,
    finished_at: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    """Patch any subset of job fields. Pass None to leave unchanged."""
    values = {
        "status": status, "phase": phase, "progress": progress,
        "duration_s": duration_s, "session_id": session_id,
        "error": error, "finished_at": finished_at,
    }
    sets: List[str] = []
    params: List[Any] = []
    for col in _UPLOAD_JOB_FIELDS:
        if values[col] is not None:
            sets.append(f"{col} = ?")
            params.append(values[col])
    if not sets:
        return get_upload_job(job_id)
    params.append(job_id)
    with get_conn() as conn:
        conn.execute(
            f"UPDATE upload_jobs SET {', '.join(sets)} WHERE id = ?", params
        )
        return _row(
            conn.execute("SELECT * FROM upload_jobs WHERE id = ?", (job_id,)).fetchone()
        )


# ─── voice enrollment ─────────────────────────────────────────────────────

def get_rep_voice_print() -> Optional[Dict[str, Any]]:
    """Return the singleton rep voice embedding row, or None if not enrolled."""
    with get_conn() as conn:
        row = conn.execute(
            "SELECT id, embedding, sample_rate, duration_s, created_at "
            "FROM voice_enrollment WHERE id = 1"
        ).fetchone()
        return dict(row) if row else None


def set_rep_voice_print(
    *, embedding: bytes, sample_rate: int, duration_s: float
) -> Dict[str, Any]:
    """Upsert the singleton rep voice embedding."""
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO voice_enrollment (id, embedding, sample_rate, duration_s, created_at) "
            "VALUES (1, ?, ?, ?, ?) "
            "ON CONFLICT(id) DO UPDATE SET "
            "  embedding = excluded.embedding, "
            "  sample_rate = excluded.sample_rate, "
            "  duration_s = excluded.duration_s, "
            "  created_at = excluded.created_at",
            (embedding, sample_rate, duration_s, _now_iso()),
        )
    row = get_rep_voice_print()
    assert row is not None
    return row


def clear_rep_voice_print() -> bool:
    with get_conn() as conn:
        cur = conn.execute("DELETE FROM voice_enrollment WHERE id = 1")
        return cur.rowcount > 0


# ─── auth / users / orgs / teams (Phase 1) ──────────────────────────────────

def default_org_id() -> Optional[int]:
    """The first org (the default tenant created at migration)."""
    with get_conn() as conn:
        row = conn.execute("SELECT id FROM orgs ORDER BY id ASC LIMIT 1").fetchone()
        return int(row["id"]) if row else None


def get_user(sui_address: str) -> Optional[Dict[str, Any]]:
    with get_conn() as conn:
        return _row(
            conn.execute(
                "SELECT * FROM users WHERE sui_address = ?", (sui_address,)
            ).fetchone()
        )


def upsert_user(
    sui_address: str,
    *,
    email: Optional[str] = None,
    display_name: Optional[str] = None,
) -> Dict[str, Any]:
    """Create the user row if absent, refresh email/name + last_login."""
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO users (sui_address, email, display_name, last_login_at) "
            "VALUES (?, ?, ?, ?) "
            "ON CONFLICT(sui_address) DO UPDATE SET "
            "  email = COALESCE(excluded.email, users.email), "
            "  display_name = COALESCE(excluded.display_name, users.display_name), "
            "  last_login_at = excluded.last_login_at",
            (sui_address, email, display_name, _now_iso()),
        )
        return dict(
            conn.execute(
                "SELECT * FROM users WHERE sui_address = ?", (sui_address,)
            ).fetchone()
        )


def get_membership(org_id: int, sui_address: str) -> Optional[str]:
    """Return the user's role in an org, or None if not a member."""
    with get_conn() as conn:
        row = conn.execute(
            "SELECT role FROM org_members WHERE org_id = ? AND sui_address = ?",
            (org_id, sui_address),
        ).fetchone()
        return row["role"] if row else None


def primary_membership(sui_address: str) -> Optional[Dict[str, Any]]:
    """The user's first org membership (org_id + role), used to default scope."""
    with get_conn() as conn:
        row = conn.execute(
            "SELECT org_id, role FROM org_members WHERE sui_address = ? "
            "ORDER BY created_at ASC LIMIT 1",
            (sui_address,),
        ).fetchone()
        return dict(row) if row else None


def list_orgs_for_user(sui_address: str) -> List[Dict[str, Any]]:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT o.id, o.name, o.slug, m.role FROM org_members m "
            "JOIN orgs o ON o.id = m.org_id "
            "WHERE m.sui_address = ? ORDER BY m.created_at ASC",
            (sui_address,),
        ).fetchall()
        return [dict(r) for r in rows]


def create_org(name: str, slug: Optional[str] = None) -> Dict[str, Any]:
    with get_conn() as conn:
        cur = conn.execute(
            "INSERT INTO orgs (name, slug) VALUES (?, ?)", (name.strip(), slug)
        )
        return dict(
            conn.execute("SELECT * FROM orgs WHERE id = ?", (cur.lastrowid,)).fetchone()
        )


def add_org_member(org_id: int, sui_address: str, role: str) -> None:
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO org_members (org_id, sui_address, role, created_at) "
            "VALUES (?, ?, ?, ?) "
            "ON CONFLICT(org_id, sui_address) DO UPDATE SET role = excluded.role",
            (org_id, sui_address, role, _now_iso()),
        )


def list_org_members(org_id: int) -> List[Dict[str, Any]]:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT m.sui_address, m.role, m.created_at, u.email, u.display_name "
            "FROM org_members m LEFT JOIN users u ON u.sui_address = m.sui_address "
            "WHERE m.org_id = ? ORDER BY m.created_at ASC",
            (org_id,),
        ).fetchall()
        return [dict(r) for r in rows]


def update_member_role(org_id: int, sui_address: str, role: str) -> None:
    with get_conn() as conn:
        conn.execute(
            "UPDATE org_members SET role = ? WHERE org_id = ? AND sui_address = ?",
            (role, org_id, sui_address),
        )


def remove_member(org_id: int, sui_address: str) -> None:
    with get_conn() as conn:
        conn.execute(
            "DELETE FROM org_members WHERE org_id = ? AND sui_address = ?",
            (org_id, sui_address),
        )


def count_owners(org_id: int) -> int:
    with get_conn() as conn:
        row = conn.execute(
            "SELECT COUNT(*) AS n FROM org_members WHERE org_id = ? AND role = 'owner'",
            (org_id,),
        ).fetchone()
        return int(row["n"])


def create_team(org_id: int, name: str) -> Dict[str, Any]:
    with get_conn() as conn:
        cur = conn.execute(
            "INSERT INTO teams (org_id, name) VALUES (?, ?)", (org_id, name.strip())
        )
        return dict(
            conn.execute("SELECT * FROM teams WHERE id = ?", (cur.lastrowid,)).fetchone()
        )


def list_teams(org_id: int) -> List[Dict[str, Any]]:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM teams WHERE org_id = ? ORDER BY created_at ASC", (org_id,)
        ).fetchall()
        return [dict(r) for r in rows]


def get_team(team_id: int) -> Optional[Dict[str, Any]]:
    with get_conn() as conn:
        return _row(
            conn.execute("SELECT * FROM teams WHERE id = ?", (team_id,)).fetchone()
        )


def add_team_member(team_id: int, sui_address: str) -> None:
    with get_conn() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO team_members (team_id, sui_address) VALUES (?, ?)",
            (team_id, sui_address),
        )


def list_team_members(team_id: int) -> List[Dict[str, Any]]:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT t.sui_address, u.email, u.display_name FROM team_members t "
            "LEFT JOIN users u ON u.sui_address = t.sui_address "
            "WHERE t.team_id = ?",
            (team_id,),
        ).fetchall()
        return [dict(r) for r in rows]


# ─── communication channels (email / twilio) ───────────────────────────────

def create_channel(
    *,
    org_id: int,
    owner_sui_address: Optional[str],
    kind: str,
    label: Optional[str],
    identity: Optional[str],
    config_enc: bytes,
    status: str = "connected",
) -> Dict[str, Any]:
    with get_conn() as conn:
        cur = conn.execute(
            "INSERT INTO channels (org_id, owner_sui_address, kind, label, identity, "
            "config_enc, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (org_id, owner_sui_address, kind, label, identity, config_enc, status, _now_iso()),
        )
        return dict(
            conn.execute("SELECT * FROM channels WHERE id = ?", (cur.lastrowid,)).fetchone()
        )


def list_channels(org_id: int, owner_sui_address: Optional[str]) -> List[Dict[str, Any]]:
    """Channels for a user. owner_sui_address None ⇒ all in the org (oversight)."""
    with get_conn() as conn:
        if owner_sui_address is not None:
            rows = conn.execute(
                "SELECT * FROM channels WHERE org_id = ? AND owner_sui_address = ? "
                "ORDER BY created_at DESC",
                (org_id, owner_sui_address),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM channels WHERE org_id = ? ORDER BY created_at DESC",
                (org_id,),
            ).fetchall()
        return [dict(r) for r in rows]


def get_channel(
    channel_id: int, org_id: int, owner_sui_address: Optional[str] = None
) -> Optional[Dict[str, Any]]:
    clauses = ["id = ?", "org_id = ?"]
    params: List[Any] = [channel_id, org_id]
    if owner_sui_address is not None:
        clauses.append("owner_sui_address = ?")
        params.append(owner_sui_address)
    with get_conn() as conn:
        return _row(
            conn.execute(
                f"SELECT * FROM channels WHERE {' AND '.join(clauses)}", params
            ).fetchone()
        )


def set_channel_status(channel_id: int, status: str) -> None:
    with get_conn() as conn:
        conn.execute(
            "UPDATE channels SET status = ?, updated_at = ? WHERE id = ?",
            (status, _now_iso(), channel_id),
        )


def delete_channel(
    channel_id: int, org_id: int, owner_sui_address: Optional[str] = None
) -> bool:
    clauses = ["id = ?", "org_id = ?"]
    params: List[Any] = [channel_id, org_id]
    if owner_sui_address is not None:
        clauses.append("owner_sui_address = ?")
        params.append(owner_sui_address)
    with get_conn() as conn:
        cur = conn.execute(f"DELETE FROM channels WHERE {' AND '.join(clauses)}", params)
        return cur.rowcount > 0


# ─── messages (omnichannel inbox registry) ─────────────────────────────────

def create_message(
    *,
    org_id: int,
    owner_sui_address: Optional[str],
    client_id: Optional[int],
    channel_id: Optional[int],
    kind: str,
    direction: str,
    to_addr: Optional[str],
    from_addr: Optional[str],
    subject: Optional[str],
    body: Optional[str],
    status: str,
    error: Optional[str] = None,
    blob_id: Optional[str] = None,
    provider_id: Optional[str] = None,
) -> Dict[str, Any]:
    with get_conn() as conn:
        cur = conn.execute(
            "INSERT INTO messages (org_id, owner_sui_address, client_id, channel_id, kind, "
            "direction, to_addr, from_addr, subject, body, status, error, blob_id, provider_id) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (org_id, owner_sui_address, client_id, channel_id, kind, direction, to_addr,
             from_addr, subject, body, status, error, blob_id, provider_id),
        )
        return dict(
            conn.execute("SELECT * FROM messages WHERE id = ?", (cur.lastrowid,)).fetchone()
        )


def list_messages(
    org_id: int,
    owner_sui_address: Optional[str],
    client_id: Optional[int] = None,
    limit: int = 100,
) -> List[Dict[str, Any]]:
    clauses = ["org_id = ?"]
    params: List[Any] = [org_id]
    if owner_sui_address is not None:
        clauses.append("owner_sui_address = ?")
        params.append(owner_sui_address)
    if client_id is not None:
        clauses.append("client_id = ?")
        params.append(client_id)
    params.append(limit)
    with get_conn() as conn:
        rows = conn.execute(
            f"SELECT * FROM messages WHERE {' AND '.join(clauses)} "
            f"ORDER BY created_at DESC LIMIT ?",
            params,
        ).fetchall()
        return [dict(r) for r in rows]


# ─── per-user MemWal custody (Phase 5) ──────────────────────────────────────

def set_user_memwal(
    sui_address: str, *, account_id: str, delegate_key_enc: bytes, delegate_pubkey: str
) -> None:
    with get_conn() as conn:
        conn.execute(
            "UPDATE users SET memwal_account_id = ?, delegate_key_enc = ?, "
            "delegate_pubkey = ? WHERE sui_address = ?",
            (account_id, delegate_key_enc, delegate_pubkey, sui_address),
        )


def get_user_memwal(sui_address: str) -> Optional[Dict[str, Any]]:
    with get_conn() as conn:
        row = conn.execute(
            "SELECT memwal_account_id, delegate_key_enc, delegate_pubkey "
            "FROM users WHERE sui_address = ?",
            (sui_address,),
        ).fetchone()
        if row is None or row["memwal_account_id"] is None:
            return None
        return dict(row)
