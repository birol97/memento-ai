"""SQLite connection helpers.

The DB is a single file (configurable via DB_PATH). Each request/handler opens
its own connection; SQLite + WAL handles concurrent readers + a writer just
fine for our scale.
"""
from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

from app.core.config import get_settings
from app.core.logger import get_logger

log = get_logger(__name__)

_SCHEMA_PATH = Path(__file__).with_name("schema.sql")


def _connect(db_path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path, isolation_level=None, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def _column_names(conn: sqlite3.Connection, table: str) -> set[str]:
    return {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}


def _migrate(conn: sqlite3.Connection) -> None:
    """Apply additive migrations on top of the schema. Idempotent — safe to
    run on a freshly-created DB or one created before these columns existed."""
    cols = _column_names(conn, "clients")
    if "role" not in cols:
        conn.execute("ALTER TABLE clients ADD COLUMN role TEXT")
    if "deal_stage" not in cols:
        conn.execute("ALTER TABLE clients ADD COLUMN deal_stage TEXT")
    if "profile" not in cols:
        conn.execute("ALTER TABLE clients ADD COLUMN profile TEXT")
    if "objective" not in cols:
        conn.execute("ALTER TABLE clients ADD COLUMN objective TEXT")
    if "relationship" not in cols:
        conn.execute("ALTER TABLE clients ADD COLUMN relationship TEXT")

    sugg_cols = _column_names(conn, "suggestions")
    if "prompt" not in sugg_cols:
        conn.execute("ALTER TABLE suggestions ADD COLUMN prompt TEXT")
    if "system_prompt" not in sugg_cols:
        conn.execute("ALTER TABLE suggestions ADD COLUMN system_prompt TEXT")

    # ── Auth / multi-tenancy (Phase 1) ──────────────────────────────────────
    # Users keyed by Sui (zkLogin) address. memwal_* columns are per-user MemWal
    # custody (Phase 5) — nullable now so we don't re-migrate later.
    conn.execute(
        "CREATE TABLE IF NOT EXISTS users ("
        " sui_address TEXT PRIMARY KEY,"
        " email TEXT,"
        " display_name TEXT,"
        " memwal_account_id TEXT,"
        " delegate_key_enc BLOB,"
        " delegate_pubkey TEXT,"
        " created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),"
        " last_login_at TEXT"
        ")"
    )
    conn.execute(
        "CREATE TABLE IF NOT EXISTS orgs ("
        " id INTEGER PRIMARY KEY AUTOINCREMENT,"
        " name TEXT NOT NULL,"
        " slug TEXT UNIQUE,"
        " created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))"
        ")"
    )
    conn.execute(
        "CREATE TABLE IF NOT EXISTS org_members ("
        " org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,"
        " sui_address TEXT NOT NULL REFERENCES users(sui_address) ON DELETE CASCADE,"
        " role TEXT NOT NULL CHECK(role IN ('owner','admin','manager','rep')),"
        " created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),"
        " PRIMARY KEY (org_id, sui_address)"
        ")"
    )
    conn.execute(
        "CREATE TABLE IF NOT EXISTS teams ("
        " id INTEGER PRIMARY KEY AUTOINCREMENT,"
        " org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,"
        " name TEXT NOT NULL,"
        " created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))"
        ")"
    )
    conn.execute(
        "CREATE TABLE IF NOT EXISTS team_members ("
        " team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,"
        " sui_address TEXT NOT NULL REFERENCES users(sui_address) ON DELETE CASCADE,"
        " PRIMARY KEY (team_id, sui_address)"
        ")"
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_org_members_addr ON org_members(sui_address)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_teams_org ON teams(org_id)")

    # An org is linked to its on-chain Org object (Level B: the company is a Sui
    # object owned by the creator's zkLogin identity). org_object_id is the 0x… id;
    # owner_address is the zkLogin address that signed create_org and owns it.
    org_cols = _column_names(conn, "orgs")
    if "org_object_id" not in org_cols:
        conn.execute("ALTER TABLE orgs ADD COLUMN org_object_id TEXT")
    if "owner_address" not in org_cols:
        conn.execute("ALTER TABLE orgs ADD COLUMN owner_address TEXT")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_orgs_object ON orgs(org_object_id)")

    # Communication channels a user connects (email / twilio). Credentials are
    # Fernet-encrypted in config_enc; `identity` is the non-secret display value.
    conn.execute(
        "CREATE TABLE IF NOT EXISTS channels ("
        " id INTEGER PRIMARY KEY AUTOINCREMENT,"
        " org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,"
        " owner_sui_address TEXT,"
        " kind TEXT NOT NULL,"            # 'email' | 'twilio'
        " label TEXT,"
        " identity TEXT,"                 # from_email / phone_number (non-secret)
        " config_enc BLOB NOT NULL,"
        " status TEXT NOT NULL DEFAULT 'connected',"
        " created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),"
        " updated_at TEXT"
        ")"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_channels_owner ON channels(org_id, owner_sui_address)"
    )

    # Sent/received communications (the omnichannel inbox registry). Content is
    # also stored on Walrus; blob_id points at it.
    conn.execute(
        "CREATE TABLE IF NOT EXISTS messages ("
        " id INTEGER PRIMARY KEY AUTOINCREMENT,"
        " org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,"
        " owner_sui_address TEXT,"
        " client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,"
        " channel_id INTEGER REFERENCES channels(id) ON DELETE SET NULL,"
        " kind TEXT NOT NULL,"            # 'email' | 'sms'
        " direction TEXT NOT NULL,"       # 'out' | 'in'
        " to_addr TEXT, from_addr TEXT, subject TEXT, body TEXT,"
        " status TEXT NOT NULL DEFAULT 'sent', error TEXT,"
        " blob_id TEXT, provider_id TEXT,"
        " created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))"
        ")"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_messages_owner ON messages(org_id, owner_sui_address, created_at DESC)"
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_messages_client ON messages(client_id, created_at DESC)")

    # clients gains an org_id (tenant root). Every other tenant table inherits
    # tenancy transitively via client_id, so no further columns are needed.
    if "org_id" not in cols:
        conn.execute("ALTER TABLE clients ADD COLUMN org_id INTEGER")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_clients_org ON clients(org_id)")

    # Per-rep "private books": the employee (Sui address) who owns this client.
    # Reps/managers see only their own; owners/admins see all in the org.
    if "owner_sui_address" not in cols:
        conn.execute("ALTER TABLE clients ADD COLUMN owner_sui_address TEXT")
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_clients_owner ON clients(org_id, owner_sui_address)"
    )

    # Org-memory cache: the customer's own MemWalAccount id (rebuildable from chain).
    # The account is org-owned; the owner key is DERIVED, never stored. This column
    # is just a fast lookup so the app routes a customer's memory to its account.
    if "memwal_account_id" not in cols:
        conn.execute("ALTER TABLE clients ADD COLUMN memwal_account_id TEXT")

    # Ensure a default org exists, then backfill unscoped clients into it so
    # existing single-tenant data keeps working unchanged.
    settings = get_settings()
    row = conn.execute("SELECT id FROM orgs ORDER BY id ASC LIMIT 1").fetchone()
    if row is None:
        cur = conn.execute(
            "INSERT INTO orgs (name, slug) VALUES (?, ?)",
            (settings.default_org_name, "default"),
        )
        default_org_id = int(cur.lastrowid)
    else:
        default_org_id = int(row[0])
    conn.execute("UPDATE clients SET org_id = ? WHERE org_id IS NULL", (default_org_id,))

    # upload_jobs is created idempotently via schema.sql, but in case a DB
    # somehow predates this table, ensure it's there.
    conn.execute(
        "CREATE TABLE IF NOT EXISTS upload_jobs ("
        " id INTEGER PRIMARY KEY AUTOINCREMENT,"
        " client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,"
        " filename TEXT NOT NULL,"
        " storage_path TEXT,"
        " status TEXT NOT NULL DEFAULT 'pending',"
        " phase TEXT,"
        " progress REAL NOT NULL DEFAULT 0.0,"
        " duration_s REAL,"
        " session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,"
        " error TEXT,"
        " created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),"
        " finished_at TEXT"
        ")"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_upload_jobs_client "
        "ON upload_jobs(client_id, created_at DESC)"
    )

    # Agent state pointer: the latest Walrus blob id for a named agent's state
    # (e.g. the commitments monitor). The state itself lives on Walrus; this is
    # just the rebuildable pointer so the next tick knows where to resume.
    conn.execute(
        "CREATE TABLE IF NOT EXISTS agent_state ("
        " name TEXT PRIMARY KEY,"
        " blob_id TEXT NOT NULL,"
        " updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))"
        ")"
    )


def init_db() -> None:
    """Create the DB file (if absent), apply schema, and run migrations.
    Idempotent."""
    settings = get_settings()
    path = Path(settings.db_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with _connect(str(path)) as conn:
        conn.executescript(_SCHEMA_PATH.read_text())
        _migrate(conn)
    log.info("sqlite ready at %s", path)


@contextmanager
def get_conn() -> Iterator[sqlite3.Connection]:
    settings = get_settings()
    conn = _connect(settings.db_path)
    try:
        yield conn
    finally:
        conn.close()
