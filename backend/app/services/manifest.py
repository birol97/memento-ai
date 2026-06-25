"""Customer memory-map manifest: the self-describing namespace map on Walrus.

A manifest is a small JSON document listing every memory namespace that belongs
to a customer (the generic profile namespace + every per-conversation
sub-namespace). It is written to Walrus as an immutable blob; its blob id is then
anchored in the on-chain ``CustomerMemoryCap``.

The point: the namespace *index* stops living only in this server's SQLite. It
becomes a verifiable Walrus blob owned by an on-chain capability — so when the cap
is transferred to another rep, the new owner reads the cap, fetches this manifest,
and instantly knows every namespace to recall. Zero data migration.

The memory *contents* still live in their MemWal namespaces; this manifest is the
map, not the territory.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict

from app.db import repository as repo
from app.services.walrus import WalrusStore

MANIFEST_VERSION = 1
MANIFEST_KIND = "salescall-namespace-manifest"


def client_namespace(client_id: int | str, org_id: int | None = None) -> str:
    """Parent namespace for a client — mirrors frontend lib/clientNamespace.ts.

    Back-compat: the default org keeps emitting the legacy `salescall-client-<id>`
    so existing Walrus memories + cap `customer_id` lookups keep resolving; other
    orgs get an `salescall-o<orgId>-client-<id>` prefix so ids can't collide.
    """
    if org_id is None or org_id == repo.default_org_id():
        return f"salescall-client-{client_id}"
    return f"salescall-o{org_id}-client-{client_id}"


def sub_namespace(client_id: int | str, ns_key: str, org_id: int | None = None) -> str:
    return f"{client_namespace(client_id, org_id)}__{ns_key}"


def build_manifest(client_id: int, org_id: int | None = None) -> Dict[str, Any]:
    """Assemble the namespace map for a customer from the local registry."""
    client = repo.get_client(client_id, org_id)
    if client is None:
        raise ValueError(f"client {client_id} not found")

    parent = client_namespace(client_id, org_id)
    namespaces = [{"namespace": parent, "kind": "parent", "label": "Generic profile"}]
    for s in repo.list_subspaces(client_id):
        namespaces.append(
            {
                "namespace": sub_namespace(client_id, s["ns_key"], org_id),
                "kind": "sub",
                "label": s.get("label") or s["ns_key"],
            }
        )

    # The leaf layer of the chain: every conversation blob on Walrus for this
    # customer. With these in the manifest, the on-chain cap is the verifiable
    # root of the whole tree — Sui cap → manifest blob → conversation blobs —
    # so a months-old call is recoverable from the chain alone, no SQLite.
    store = WalrusStore()
    conversations = []
    for m in repo.list_client_blobs(client_id, org_id):
        label = m.get("body") or m.get("subject") or m.get("kind") or "interaction"
        conversations.append(
            {
                "blob_id": m["blob_id"],
                "kind": m.get("kind"),
                "direction": m.get("direction"),
                "label": (label or "")[:140],
                "at": m.get("created_at"),
                "aggregator_url": store.aggregator_url(m["blob_id"]),
            }
        )

    return {
        "version": MANIFEST_VERSION,
        "kind": MANIFEST_KIND,
        "customer_id": parent,  # == the on-chain cap's customer_id
        "org_id": org_id,
        # Full IDENTITY embedded in the manifest — so the on-chain cap carries the
        # whole customer (who they are + contact + profile), not just the history.
        # Transferring the cap hands over the entire record, zero SQLite needed.
        "client": {
            "id": client["id"],
            "name": client.get("name"),
            "phone": client.get("phone"),
            "email": client.get("email"),
            "relationship": client.get("relationship"),
            "role": client.get("role"),
            "deal_stage": client.get("deal_stage"),
            "profile": client.get("profile"),
            "objective": client.get("objective"),
            "notes": client.get("notes"),
        },
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ"),
        "namespaces": namespaces,
        "conversations": conversations,
        "memory_pointer": repo.get_memory_pointer(client_id),
    }


async def publish_manifest(client_id: int, org_id: int | None = None) -> Dict[str, Any]:
    """Build the manifest and write it to Walrus. Returns the blob id + URL.

    Also writes a dedicated, content-addressed PROFILE blob (the identity record)
    so the customer's "who they are" lives on Walrus under their namespace — not
    only embedded in the manifest. The manifest references it via profile_blob_id.
    """
    manifest = build_manifest(client_id, org_id)
    store = WalrusStore()

    # identity → its own Walrus blob (so it's independently verifiable & fetchable)
    try:
        profile_blob_id = await store.put_json({
            "kind": "profile",
            "namespace": manifest["customer_id"],
            **manifest["client"],
            "at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ"),
        })
        manifest["client"]["profile_blob_id"] = profile_blob_id
        manifest["profile_blob_id"] = profile_blob_id
    except Exception:  # noqa: BLE001 — identity stays embedded even if the blob write fails
        pass

    blob_id = await store.put_json(manifest)
    return {
        "blob_id": blob_id,
        "aggregator_url": store.aggregator_url(blob_id),
        "namespaces": manifest["namespaces"],
        "conversations": manifest["conversations"],
        "customer_id": manifest["customer_id"],
        "profile_blob_id": manifest.get("profile_blob_id"),
        "manifest": manifest,
    }


async def read_manifest(blob_id: str) -> Dict[str, Any]:
    """Fetch + parse a manifest blob back from Walrus (the verify/handoff path)."""
    return await WalrusStore().get_json(blob_id)


# ─── rebuild-from-chain (Walrus is the source of truth; SQLite is a cache) ───
# When a customer is missing from SQLite (fresh/ephemeral deploy, wiped cache),
# the on-chain cap still points at the customer's manifest blob on Walrus. Reading
# that blob is enough to reseed the local cache — identity, sub-namespaces, the
# conversation blob index, and the memory pointer — so recall/sync work again.

async def rebuild_from_chain(
    manifest_blob_id: str,
    *,
    org_id: int | None = None,
    owner_sui_address: str | None = None,
) -> Dict[str, Any]:
    """Replay a Walrus manifest blob into the local cache. Raises if the blob is
    unreadable or isn't a namespace manifest (e.g. a transcript fingerprint)."""
    manifest = await read_manifest(manifest_blob_id)
    if not isinstance(manifest, dict) or manifest.get("kind") != MANIFEST_KIND:
        raise ValueError("anchored blob is not a namespace manifest")

    client = manifest.get("client") or {}
    client_id = client.get("id")
    if not isinstance(client_id, int):
        raise ValueError("manifest has no client.id — cannot restore")

    manifest_org = manifest.get("org_id")
    restore_org = manifest_org if isinstance(manifest_org, int) else org_id
    if restore_org is None:
        restore_org = repo.default_org_id()

    repo.restore_client(
        client_id=client_id,
        name=client.get("name") or f"client-{client_id}",
        org_id=restore_org,
        owner_sui_address=owner_sui_address,
        phone=client.get("phone"),
        email=client.get("email"),
        notes=client.get("notes"),
        role=client.get("role"),
        deal_stage=client.get("deal_stage"),
        profile=client.get("profile"),
        objective=client.get("objective"),
        relationship=client.get("relationship"),
    )

    # sub-namespaces → subspaces registry (strip the parent prefix to get ns_key)
    parent = client_namespace(client_id, restore_org)
    prefix = f"{parent}__"
    subs_restored = 0
    for ns in manifest.get("namespaces") or []:
        if ns.get("kind") != "sub":
            continue
        full = ns.get("namespace") or ""
        ns_key = full[len(prefix):] if full.startswith(prefix) else full
        if ns_key:
            repo.create_subspace(client_id, ns_key, ns.get("label") or ns_key)
            subs_restored += 1

    # conversation blobs → message rows (the leaf index), de-duped on blob_id
    existing = {m["blob_id"] for m in repo.list_client_blobs(client_id, restore_org)}
    convos_restored = 0
    for c in manifest.get("conversations") or []:
        blob_id = c.get("blob_id")
        if not blob_id or blob_id in existing:
            continue
        repo.create_message(
            org_id=restore_org,
            owner_sui_address=owner_sui_address,
            client_id=client_id,
            channel_id=None,
            kind=c.get("kind") or "note",
            direction=c.get("direction") or "in",
            to_addr=None,
            from_addr=None,
            subject=None,
            body=c.get("label"),
            status="sent",
            blob_id=blob_id,
        )
        existing.add(blob_id)
        convos_restored += 1

    # the customer's memory-doc pointer (recall reads from this)
    pointer = manifest.get("memory_pointer")
    if pointer:
        repo.set_memory_pointer(client_id, pointer)

    return {
        "client_id": client_id,
        "org_id": restore_org,
        "subspaces_restored": subs_restored,
        "conversations_restored": convos_restored,
        "memory_pointer_restored": bool(pointer),
    }


async def ensure_client_cached(
    client_id: int,
    org_id: int | None = None,
    owner_sui_address: str | None = None,
    *,
    recover_blob_id: str | None = None,
) -> Dict[str, Any] | None:
    """Return a client from the cache, transparently rebuilding it from chain if
    it's missing. The customer-memory routes call this instead of ``repo.get_client``
    so they work against an empty/wiped cache.

    ``recover_blob_id`` is a fast path (the caller already knows the cap's anchored
    blob, e.g. the frontend); otherwise the backend resolves it from the cap on Sui.
    """
    from app.services import sui_chain  # local import avoids import cycle

    client = repo.get_client(client_id, org_id, owner_sui_address)
    if client is not None:
        return client

    blob_id = recover_blob_id
    if not blob_id:
        namespace = client_namespace(client_id, org_id)
        blob_id = await sui_chain.resolve_manifest_blob_id(namespace)
    if not blob_id:
        return None

    try:
        await rebuild_from_chain(blob_id, org_id=org_id, owner_sui_address=owner_sui_address)
    except Exception as exc:  # noqa: BLE001 — recovery is best-effort
        from app.core.logger import get_logger
        get_logger(__name__).warning(
            "rebuild-from-chain failed for client %s (blob %s): %s", client_id, blob_id, exc
        )
        return None
    return repo.get_client(client_id, org_id, owner_sui_address)


async def reconcile_all_from_chain() -> Dict[str, Any]:
    """Rebuild the whole client list from every cap the server address owns.

    Used to make the app usable against an empty cache (startup / empty list).
    Ownership (a private-book concept) isn't recorded on-chain, so restored rows
    are org-visible (owner_sui_address=None) — oversight roles see them, and a rep
    re-claims a row the first time they open that customer.
    """
    from app.services import sui_chain  # local import avoids import cycle

    if not sui_chain.enabled():
        return {"enabled": False, "restored": 0}

    restored = 0
    failures = 0
    for cap in await sui_chain.list_owned_caps():
        if not cap.memory_blob_id:
            continue
        try:
            await rebuild_from_chain(cap.memory_blob_id, owner_sui_address=None)
            restored += 1
        except Exception:  # noqa: BLE001 — skip fingerprints / unreadable blobs
            failures += 1
    return {"enabled": True, "restored": restored, "skipped": failures}
