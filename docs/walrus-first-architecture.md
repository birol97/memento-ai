# Walrus-First Memory + Session-Scoping — Architecture Change

> What changed in commits `604cfdd` (Walrus-first cache), `2d3b365` (session-token
> forwarding) and `8b6b9f9` (CORS regex), why, and how the pieces fit together.
> All code snippets below are the real implementation in this repo.

---

## TL;DR — the one idea

Before, **SQLite was the source of truth** for customers. On Railway, every
redeploy wipes the SQLite file, so customers vanished and Sync returned
`404 client not found` — even though the data still existed on-chain and on Walrus.

After, the model is **inverted**:

```
        SOURCE OF TRUTH                         DISPOSABLE CACHE
  ┌──────────────────────────┐            ┌────────────────────────┐
  │  Sui CustomerMemoryCap    │            │     backend SQLite      │
  │  (on-chain, server-owned) │  rebuild   │  clients / messages /   │
  │      ↓ anchors            │ ─────────► │  subspaces / pointers   │
  │  Walrus manifest blob      │            │  (rebuilt on cache miss)│
  │  (content-addressed)       │            └────────────────────────┘
  └──────────────────────────┘
```

The cap stores a `memory_blob_id`. That blob is a **manifest** on Walrus describing
the whole customer (identity, sub-namespaces, conversation blob index, memory
pointer). If SQLite loses a customer, the backend reads the chain → finds the
blob → replays it back into SQLite. **The cache heals itself.**

The backend **never signs** anything. The frontend still owns all minting /
anchoring / transfer (it holds `SUI_SECRET_KEY`). The backend only **reads** the
chain over plain JSON-RPC.

---

## 1. Walrus-first recovery (`604cfdd`)

### 1.1 The new read-only chain resolver — `backend/app/services/sui_chain.py`

This is the only new file. It answers two questions over JSON-RPC, no Sui SDK:

1. *What caps does the server address own?* (`list_owned_caps`)
2. *Which Walrus blob is anchored in the cap for customer X?* (`resolve_manifest_blob_id`)

It is **disabled unless configured** — this is the gate that the env vars control:

```python
def enabled() -> bool:
    s = get_settings()
    return bool(s.sui_package_id and s.sui_server_address)
```

The cap type is reconstructed from the package id you set:

```python
def _cap_type() -> str:
    return f"{get_settings().sui_package_id}::customer_memory::CustomerMemoryCap"
    # → 0x0186c6bb…::customer_memory::CustomerMemoryCap
```

Enumerating owned caps is a paginated `suix_getOwnedObjects` filtered by that type:

```python
async def list_owned_caps() -> List[Cap]:
    if not enabled():
        return []
    s = get_settings()
    caps, cursor = [], None
    async with httpx.AsyncClient(timeout=s.walrus_timeout) as client:
        while True:
            result = await _rpc(client, "suix_getOwnedObjects", [
                s.sui_server_address,
                {"filter": {"StructType": _cap_type()}, "options": {"showContent": True}},
                cursor, 50,
            ])
            for item in (result or {}).get("data", []):
                content = (item.get("data") or {}).get("content") or {}
                if content.get("dataType") != "moveObject":
                    continue
                fields = content.get("fields") or {}
                caps.append(Cap(
                    cap_id=item["data"].get("objectId", ""),
                    customer_id=_decode_vec_u8(fields.get("customer_id")),
                    memory_blob_id=_decode_vec_u8(fields.get("memory_blob_id")),
                ))
            if result and result.get("hasNextPage"):
                cursor = result.get("nextCursor")
            else:
                break
    return caps
```

Note `_decode_vec_u8` — Move stores `customer_id` / `memory_blob_id` as
`vector<u8>`; the node returns them as either a byte array or base64, so this
mirrors the frontend's decoder.

Resolving a single customer's blob is a linear scan over owned caps, matched on
the namespace string the cap stores:

```python
async def resolve_manifest_blob_id(customer_id: str) -> Optional[str]:
    if not enabled() or not customer_id:
        return None
    for cap in await list_owned_caps():
        if cap.customer_id == customer_id:   # e.g. "salescall-client-7"
            return cap.memory_blob_id or None
    return None
```

### 1.2 Replaying a manifest back into the cache — `manifest.rebuild_from_chain`

Given a blob id, this reads the manifest from Walrus and **re-creates every cache
row** the customer needs. The critical detail: it restores the client with its
**original id** so the namespace (`salescall-client-<id>`) still matches the cap.

```python
async def rebuild_from_chain(manifest_blob_id, *, org_id=None, owner_sui_address=None):
    manifest = await read_manifest(manifest_blob_id)          # Walrus → JSON
    if manifest.get("kind") != MANIFEST_KIND:
        raise ValueError("anchored blob is not a namespace manifest")

    client = manifest["client"]
    client_id = client["id"]                                  # preserved id!
    restore_org = manifest.get("org_id") or org_id or repo.default_org_id()

    repo.restore_client(client_id=client_id, org_id=restore_org,
                        name=client.get("name"), owner_sui_address=owner_sui_address,
                        phone=client.get("phone"), email=client.get("email"), ...)

    # sub-namespaces → subspaces registry
    parent = client_namespace(client_id, restore_org)
    for ns in manifest.get("namespaces") or []:
        if ns.get("kind") == "sub":
            ns_key = ns["namespace"].removeprefix(f"{parent}__")
            repo.create_subspace(client_id, ns_key, ns.get("label") or ns_key)

    # conversation blobs → message rows (de-duped on blob_id)
    existing = {m["blob_id"] for m in repo.list_client_blobs(client_id, restore_org)}
    for c in manifest.get("conversations") or []:
        if c["blob_id"] not in existing:
            repo.create_message(org_id=restore_org, client_id=client_id,
                                blob_id=c["blob_id"], body=c.get("label"), ...)

    if manifest.get("memory_pointer"):
        repo.set_memory_pointer(client_id, manifest["memory_pointer"])
```

And the repository helper that makes id-preservation possible:

```python
def restore_client(*, client_id: int, name: str, org_id=None, ...):
    """Recreate a client row with its ORIGINAL id (rebuild-from-chain recovery)."""
    # INSERT with explicit id rather than autoincrement, so the namespace key
    # salescall-client-<id> still resolves the same Walrus/MemWal data.
```

### 1.3 Three places recovery kicks in

**(a) Lazy, per-customer — the `_require_client` guard in `rest.py`.**
Every customer-memory route used to do `repo.get_client(...) or 404`. They now go
through one helper that rebuilds-then-checks:

```python
async def _require_client(client_id, principal, *, recover_blob_id=None) -> dict:
    from app.services import manifest as manifest_svc
    client = await manifest_svc.ensure_client_cached(
        client_id, principal.org_id, _owner_filter(principal),
        recover_blob_id=recover_blob_id,
    )
    if client is None:
        raise HTTPException(404, "client not found")
    return client
```

`ensure_client_cached` is the heart of the lazy path:

```python
async def ensure_client_cached(client_id, org_id=None, owner=None, *, recover_blob_id=None):
    client = repo.get_client(client_id, org_id, owner)
    if client is not None:
        return client                          # cache hit → done

    blob_id = recover_blob_id                   # frontend fast-path hint…
    if not blob_id:
        ns = client_namespace(client_id, org_id)
        blob_id = await sui_chain.resolve_manifest_blob_id(ns)   # …or resolve from chain
    if not blob_id:
        return None

    await rebuild_from_chain(blob_id, org_id=org_id, owner_sui_address=owner)
    return repo.get_client(client_id, org_id, owner)   # now a hit
```

So `GET /clients/{id}`, `/sessions`, `/subspaces`, `POST /manifest` etc. all became
`async` and route through `_require_client` — a missing customer self-heals instead
of 404-ing.

**(b) Empty list — `GET /clients`.** If the list is empty (and there's no search
query), rebuild *everything* from owned caps, then re-read:

```python
clients = repo.list_clients(...)
if not clients and not q:
    result = await manifest_svc.reconcile_all_from_chain()
    if result.get("restored"):
        clients = repo.list_clients(...)
return {"clients": clients}
```

**(c) On startup — `main.py` lifespan.** Best-effort, so a fresh deploy is usable
immediately, and never blocks boot:

```python
if settings.rebuild_from_chain_on_startup:
    try:
        result = await manifest_svc.reconcile_all_from_chain()
        log.info("rebuild-from-chain on startup: %s", result)
    except Exception as exc:
        log.warning("rebuild-from-chain on startup failed: %s", exc)
```

`reconcile_all_from_chain` walks every owned cap and rebuilds each:

```python
async def reconcile_all_from_chain() -> Dict[str, Any]:
    if not sui_chain.enabled():
        return {"enabled": False, "restored": 0}
    restored = failures = 0
    for cap in await sui_chain.list_owned_caps():
        if not cap.memory_blob_id:
            continue
        try:
            await rebuild_from_chain(cap.memory_blob_id, owner_sui_address=None)
            restored += 1
        except Exception:                       # skip fingerprints / unreadable blobs
            failures += 1
    return {"enabled": True, "restored": restored, "skipped": failures}
```

> ⚠️ **Ownership caveat (by design):** on-chain caps don't record the private-book
> `owner_sui_address`, so reconciled rows come back **org-visible** (`owner=None`).
> Oversight roles (owner/admin) see them; a rep re-claims a row the first time they
> open that customer. This is an accepted trade-off of rebuilding from chain.

### 1.4 The env vars that turn it on

```python
# backend/app/core/config.py
sui_network: str = "testnet"
sui_rpc_url: str = ""              # blank → derived from sui_network
sui_package_id: str = ""          # ← REQUIRED for recovery
sui_server_address: str = ""      # ← REQUIRED for recovery
rebuild_from_chain_on_startup: bool = True
```

Your production values (Railway):

```bash
SUI_NETWORK=testnet
SUI_PACKAGE_ID=0x0186c6bb5cf3ec4bc371caf93714c20dac6c3ed28d7455e11fd551d7d61b2bc1
SUI_SERVER_ADDRESS=0x4483d8d70379f8c6c062384bd59c9ac2cd31fb075d44e7c388e011222f40b55c
REBUILD_FROM_CHAIN_ON_STARTUP=true
```

If either `SUI_PACKAGE_ID` or `SUI_SERVER_ADDRESS` is blank, `enabled()` is `False`
and the whole path **degrades gracefully** to the old "404 if not cached" behavior
— no errors, just no self-healing.

### 1.5 End-to-end recovery flow

```
Browser opens customer #7 after a Railway redeploy (SQLite wiped)
        │
        ▼
GET /clients/7  ──► _require_client(7) ──► ensure_client_cached(7)
        │                                       │ cache miss
        │                                       ▼
        │                          sui_chain.resolve_manifest_blob_id("salescall-client-7")
        │                                       │  suix_getOwnedObjects (server addr, cap type)
        │                                       ▼  → blob_id  bafkrei…
        │                          rebuild_from_chain(blob_id)
        │                                       │  read_manifest() from Walrus
        │                                       ▼  restore_client(id=7) + subspaces + msgs
        ▼                                  repo.get_client(7) → HIT
   200 OK  (customer back, namespace intact, recall works)
```

---

## 2. Session-token forwarding (`2d3b365`)

### The bug
`syncMemoryMap` is a **server action** — it holds the Sui signing key, so it runs on
the Next server, not the browser. It therefore never carried the browser-held
**session JWT**. When it called the backend it was **unauthenticated** → the backend
resolved it to the **default org** → customers created under a real zkLogin org came
back `404 not found` on Sync (wrong tenant).

### The fix — thread the token through explicitly
The server action now accepts the token and forwards it as a `Bearer` header:

```ts
// frontend/app/actions/onchain.ts
export async function syncMemoryMap(
  clientId: number,
  recoverBlobId?: string,
  authToken?: string | null,          // ← new
): Promise<SyncMapResult> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "ngrok-skip-browser-warning": "true",
  };
  if (authToken) headers.Authorization = `Bearer ${authToken}`;   // ← forward it

  const pubRes = await fetch(`${BACKEND_BASE}/clients/${clientId}/manifest`, {
    method: "POST",
    headers,
    body: JSON.stringify({ recover_blob_id: recoverBlobId ?? null }),
    cache: "no-store",
  });
  ...
}
```

Callers pass the browser's token via `getSessionToken()`:

```ts
// frontend/components/MemoryMapPanel.tsx (also ClientWorkspace.tsx, TribeMembers.tsx)
const r = await syncMemoryMap(clientId, cap?.memoryBlobId, getSessionToken());
```

Notice this dovetails with §1: the same `POST /clients/{id}/manifest` body now
carries `recover_blob_id` (the cap's anchored blob the frontend already knows) — the
**fast path** in `ensure_client_cached` that skips the chain scan.

```
Browser (has JWT) ──token──► syncMemoryMap (server action, has Sui key)
                                   │  Authorization: Bearer <jwt>
                                   │  body: { recover_blob_id }
                                   ▼
                          POST /clients/7/manifest
                                   │  current_principal verifies JWT → correct org
                                   ▼
                          _require_client(7, recover_blob_id=…) → publish manifest
```

> **Why this matters:** this is the same class of failure as the earlier
> "CORS error that was really a 500" — the request *looked* like a not-found, but
> the real cause was **wrong-tenant resolution** from a missing token, not a missing
> customer.

---

## 3. CORS regex for rotating Vercel URLs (`8b6b9f9`)

### The bug
CORS was exact-match against `ALLOWED_ORIGINS`. Every Vercel deploy/preview gets a
**different** `*.vercel.app` origin, so the browser preflight failed after each
deploy → surfaced as `Failed to fetch`.

### The fix — allow a regex of origins
```python
# backend/app/core/config.py
allowed_origin_regex: str = r"https://.*\.vercel\.app"
```

```python
# backend/app/main.py
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allowed_origins,           # exact list (localhost, custom domain)
    allow_origin_regex=settings.allowed_origin_regex or None,   # any *.vercel.app
    allow_credentials=False,                          # safe: auth is a Bearer header, not a cookie
    allow_methods=["*"],
    allow_headers=["*"],
)
```

Override with `ALLOWED_ORIGIN_REGEX` (or set `""` to disable). It's safe with
`allow_credentials=False` because the session token travels as an `Authorization`
header, not a cookie — so wildcard-ish origins don't expose credentialed requests.

---

## How the three commits reinforce each other

```
8b6b9f9  CORS regex          → the request reaches the backend at all
2d3b365  forward session JWT → it's resolved to the CORRECT org (not default)
604cfdd  Walrus-first cache  → even on a wiped DB, the customer is found / rebuilt
```

All three target the same end-to-end failure that showed up after a Railway
redeploy: *"I sync a customer and get an error."* Each removes one independent cause
(blocked origin → wrong tenant → empty cache).

---

## Trust boundaries (unchanged principle, reinforced)

| Capability            | Who | Key |
|-----------------------|-----|-----|
| Mint / anchor / transfer caps (sign txns) | **Frontend** server action | `SUI_SECRET_KEY` (never on backend) |
| **Read** chain to rebuild cache | **Backend** | none — public JSON-RPC + `SUI_SERVER_ADDRESS` (public) + `SUI_PACKAGE_ID` (public) |
| Verify session, scope by org | Backend | `SESSION_JWT_SECRET` (shared with frontend) |

The backend gaining chain access is **read-only** and uses only **public** values.
No new secret was added to the backend.
