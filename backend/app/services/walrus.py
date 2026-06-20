"""Raw Walrus storage over the public testnet HTTP publisher / aggregator.

No MemWal relayer and no wallet/funds required: on testnet the public publisher
accepts unauthenticated PUTs and the aggregator serves any blob by ID. This is
the *same* Walrus network the `@mysten/walrus` SDK targets — we go over HTTP so
the whole memory loop can live next to the copilot in this Python backend.

When we add per-rep signed/paid storage + Sui ownership (later slice), this
module is the seam to swap for the `@mysten/walrus` SDK + a wallet.
"""
from __future__ import annotations

import json
from typing import Any

import httpx

from app.core.config import get_settings
from app.core.logger import get_logger

log = get_logger(__name__)


class WalrusStore:
    """Thin async client for the Walrus publisher (writes) + aggregator (reads)."""

    def __init__(self) -> None:
        s = get_settings()
        self._publisher = s.walrus_publisher_url.rstrip("/")
        self._aggregator = s.walrus_aggregator_url.rstrip("/")
        self._epochs = s.walrus_epochs
        self._timeout = s.walrus_timeout

    def aggregator_url(self, blob_id: str) -> str:
        """Public URL anyone can GET to verify a blob lives on Walrus."""
        return f"{self._aggregator}/v1/blobs/{blob_id}"

    async def put_bytes(self, data: bytes) -> str:
        url = f"{self._publisher}/v1/blobs"
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            res = await client.put(url, params={"epochs": str(self._epochs)}, content=data)
            res.raise_for_status()
            body = res.json()
        # Publisher returns one of two shapes depending on whether the blob's
        # content was already stored by someone else (Walrus is content-addressed).
        if "newlyCreated" in body:
            return body["newlyCreated"]["blobObject"]["blobId"]
        if "alreadyCertified" in body:
            return body["alreadyCertified"]["blobId"]
        raise RuntimeError(f"unexpected Walrus publisher response: {body}")

    async def put_json(self, obj: Any) -> str:
        return await self.put_bytes(json.dumps(obj, ensure_ascii=False).encode("utf-8"))

    async def get_bytes(self, blob_id: str) -> bytes:
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            res = await client.get(self.aggregator_url(blob_id))
            res.raise_for_status()
            return res.content

    async def get_json(self, blob_id: str) -> Any:
        return json.loads((await self.get_bytes(blob_id)).decode("utf-8"))

    async def extend_blob(self, blob_id: str, epochs: int | None = None) -> None:
        """Renew a blob's storage lease so it doesn't expire (durability).

        STUB — the public testnet publisher doesn't expose a generic extend
        endpoint; real renewal needs the @mysten/walrus SDK + a funded wallet to
        re-register/extend the on-chain Blob object. Wire that here, then run this
        from a periodic job over the manifest's conversation blob_ids
        (e.g. "renew anything expiring within N epochs"). Until then, set a large
        `walrus_epochs` so blobs outlive your retention window.
        """
        raise NotImplementedError(
            "Blob renewal requires the @mysten/walrus SDK + a funded Sui wallet; "
            "use a large walrus_epochs until that's wired."
        )
