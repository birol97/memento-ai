PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Pointer from a customer (client) to the latest Walrus blob holding their
-- full memory document. Walrus blobs are immutable, so each memory write
-- creates a new blob and moves this pointer. Becomes an on-chain
-- CustomerMemoryCap in a later slice.
CREATE TABLE IF NOT EXISTS customer_memory (
    client_id   INTEGER PRIMARY KEY REFERENCES clients(id) ON DELETE CASCADE,
    blob_id     TEXT NOT NULL,
    updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Registry of per-conversation sub-namespaces under a client (the parent
-- "generic" namespace is salescall-client-<id>; each sub is
-- salescall-client-<id>__<ns_key>). MemWal can't enumerate namespaces, so we
-- track them here.
CREATE TABLE IF NOT EXISTS subspaces (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id   INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    ns_key      TEXT NOT NULL,
    label       TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE(client_id, ns_key)
);
CREATE INDEX IF NOT EXISTS idx_subspaces_client ON subspaces(client_id, created_at DESC);

CREATE TABLE IF NOT EXISTS clients (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    phone       TEXT,
    email       TEXT,
    notes       TEXT,
    role        TEXT,
    deal_stage  TEXT,
    profile     TEXT,                                    -- who the prospect is (industry, role, history)
    objective   TEXT,                                    -- what we want out of conversations with them
    relationship TEXT,                                   -- how they relate to me (colleague, friend, expert helping me, customer…)
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_clients_name  ON clients(name);
CREATE INDEX IF NOT EXISTS idx_clients_phone ON clients(phone);
CREATE INDEX IF NOT EXISTS idx_clients_email ON clients(email);

CREATE TABLE IF NOT EXISTS sessions (
    id           TEXT PRIMARY KEY,                      -- ws session id (8-char hex)
    client_id    INTEGER REFERENCES clients(id) ON DELETE SET NULL,
    started_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    ended_at     TEXT,
    summary      TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_client ON sessions(client_id, started_at DESC);

CREATE TABLE IF NOT EXISTS turns (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    speaker     TEXT NOT NULL DEFAULT 'unknown',         -- 'rep' | 'client' | 'unknown'
    text        TEXT NOT NULL,
    t_start     REAL,                                    -- session-relative seconds
    t_end       REAL,
    server_ts   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id, id);

CREATE TABLE IF NOT EXISTS suggestions (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id     TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    turn_id        INTEGER REFERENCES turns(id) ON DELETE SET NULL,
    text           TEXT NOT NULL,
    prompt         TEXT,
    system_prompt  TEXT,
    model          TEXT,
    created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_suggestions_session ON suggestions(session_id, id);

CREATE TABLE IF NOT EXISTS tags (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    name  TEXT NOT NULL UNIQUE COLLATE NOCASE
);

CREATE TABLE IF NOT EXISTS client_tags (
    client_id  INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    tag_id     INTEGER NOT NULL REFERENCES tags(id)    ON DELETE CASCADE,
    PRIMARY KEY (client_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_client_tags_tag ON client_tags(tag_id);

CREATE TABLE IF NOT EXISTS attachments (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id     INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    filename      TEXT NOT NULL,                 -- original (display) filename
    mime_type     TEXT,
    size_bytes    INTEGER NOT NULL,
    storage_path  TEXT NOT NULL,                 -- relative to settings.attachments_dir
    uploaded_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_attachments_client ON attachments(client_id, uploaded_at DESC);

-- Async ingestion jobs: rep uploads an mp3/wav of a past call, the worker
-- transcribes + diarizes + summarizes it into a session row, frontend
-- polls until status='done' (or 'error'). Soft-deleted via status='deleted'.
CREATE TABLE IF NOT EXISTS upload_jobs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id    INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    filename     TEXT NOT NULL,
    storage_path TEXT,                                       -- relative to attachments_dir; null after cleanup
    status       TEXT NOT NULL DEFAULT 'pending',            -- pending | running | done | error
    phase        TEXT,                                        -- decoding | transcribing | diarizing | summarizing
    progress     REAL NOT NULL DEFAULT 0.0,                  -- 0.0 .. 1.0
    duration_s   REAL,                                        -- decoded audio length (set after decode)
    session_id   TEXT REFERENCES sessions(id) ON DELETE SET NULL,
    error        TEXT,
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    finished_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_upload_jobs_client ON upload_jobs(client_id, created_at DESC);

-- Singleton row holding the rep's voice embedding. Used to classify each
-- committed turn as 'rep' or 'client'. CHECK enforces at most one row.
CREATE TABLE IF NOT EXISTS voice_enrollment (
    id          INTEGER PRIMARY KEY CHECK (id = 1),
    embedding   BLOB NOT NULL,        -- numpy float32 bytes (256-dim from resemblyzer)
    sample_rate INTEGER NOT NULL,
    duration_s  REAL NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
