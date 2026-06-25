"use server";

// Server-signed CustomerMemoryCap operations on Sui testnet. The cap holds the
// Walrus memory pointer; transferring it hands a customer to another rep with
// zero data migration (the memory stays on Walrus).
import { createHash } from "crypto";

import { Transaction } from "@mysten/sui/transactions";

import { getSui, getKeypair, serverAddress, PACKAGE_ID, CAP_TYPE } from "@/lib/sui";

/** Short sha256 of the transcript — an on-chain commitment to exactly what was learned. */
function fingerprint(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 32);
}

function toBytes(s: string): number[] {
  return Array.from(new TextEncoder().encode(s));
}

// vector<u8> comes back from getObject content either as a number[] or base64.
function decodeVecU8(v: unknown): string {
  try {
    if (Array.isArray(v)) return new TextDecoder().decode(Uint8Array.from(v as number[]));
    if (typeof v === "string") return Buffer.from(v, "base64").toString("utf8");
  } catch {
    /* fall through */
  }
  return "";
}

export type CapView = { capId: string; customerId: string; memoryBlobId: string };

export type ListResult =
  | { ok: true; owner: string; packageId: string; caps: CapView[] }
  | { ok: false; error: string };

export async function listCustomerCaps(): Promise<ListResult> {
  try {
    if (!PACKAGE_ID) return { ok: false, error: "SUI_PACKAGE_ID not set" };
    const client = getSui();
    const owner = serverAddress();
    const res = await client.getOwnedObjects({
      owner,
      filter: { StructType: CAP_TYPE },
      options: { showContent: true },
    });
    const caps: CapView[] = [];
    for (const o of res.data) {
      const c = o.data?.content;
      if (c && c.dataType === "moveObject") {
        const f = (c as unknown as { fields: Record<string, unknown> }).fields;
        caps.push({
          capId: o.data!.objectId,
          customerId: decodeVecU8(f.customer_id),
          memoryBlobId: decodeVecU8(f.memory_blob_id),
        });
      }
    }
    return { ok: true, owner, packageId: PACKAGE_ID, caps };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "list failed" };
  }
}

// ── Enumerate the namespaces a Sui account owns (Path 2 + Path 3) ───────────
// There is no "list namespaces" API on MemWal/Walrus. We recover the set from
// the on-chain CustomerMemoryCaps the address owns: each cap's `customer_id` is
// a parent namespace, and its `memory_blob_id` points to a Walrus manifest that
// lists the parent + every sub-namespace. We flatten those. See
// docs/ENUMERATING_NAMESPACES.md.
const WALRUS_AGG =
  process.env.NEXT_PUBLIC_WALRUS_AGGREGATOR ?? "https://aggregator.walrus-testnet.walrus.space";

export type OwnedNamespace = {
  namespace: string;
  kind: "parent" | "sub";
  label?: string;
  capId: string;
  customerId: string;
  /** "manifest" = resolved from the cap's manifest blob; "cap" = only the parent
   * was known (no/unreadable manifest). */
  source: "manifest" | "cap";
};

export type NamespacesResult =
  | {
      ok: true;
      owner: string;
      packageId: string;
      capCount: number;
      namespaces: OwnedNamespace[];
      warnings: string[];
    }
  | { ok: false; error: string };

export async function namespacesOwnedBy(address: string): Promise<NamespacesResult> {
  try {
    if (!PACKAGE_ID) return { ok: false, error: "SUI_PACKAGE_ID not set" };
    const owner = (address || "").trim();
    if (!/^0x[0-9a-fA-F]{1,64}$/.test(owner)) return { ok: false, error: "invalid sui address" };

    const client = getSui();
    const warnings: string[] = [];

    // 1. Page through every CustomerMemoryCap this address owns.
    const caps: { capId: string; customerId: string; memoryBlobId: string }[] = [];
    let cursor: string | null = null;
    do {
      const res = await client.getOwnedObjects({
        owner,
        filter: { StructType: CAP_TYPE },
        options: { showContent: true },
        cursor,
      });
      for (const o of res.data) {
        const c = o.data?.content;
        if (c && c.dataType === "moveObject") {
          const f = (c as unknown as { fields: Record<string, unknown> }).fields;
          caps.push({
            capId: o.data!.objectId,
            customerId: decodeVecU8(f.customer_id),
            memoryBlobId: decodeVecU8(f.memory_blob_id),
          });
        }
      }
      cursor = res.hasNextPage ? res.nextCursor ?? null : null;
    } while (cursor);

    // 2. For each cap, resolve its manifest → parent + sub namespaces.
    const out: OwnedNamespace[] = [];
    const seen = new Set<string>();
    const add = (
      cap: { capId: string; customerId: string },
      namespace: string,
      kind: OwnedNamespace["kind"],
      label: string | undefined,
      source: OwnedNamespace["source"],
    ) => {
      if (!namespace || seen.has(namespace)) return;
      seen.add(namespace);
      out.push({ namespace, kind, label, capId: cap.capId, customerId: cap.customerId, source });
    };

    for (const cap of caps) {
      let resolved = false;
      if (cap.memoryBlobId) {
        try {
          const r = await fetch(`${WALRUS_AGG}/v1/blobs/${cap.memoryBlobId}`, { cache: "no-store" });
          if (r.ok) {
            const m = (await r.json()) as { namespaces?: { namespace?: string; kind?: string; label?: string }[] };
            if (Array.isArray(m.namespaces)) {
              for (const n of m.namespaces) {
                if (n?.namespace) add(cap, n.namespace, n.kind === "parent" ? "parent" : "sub", n.label, "manifest");
              }
              resolved = true;
            }
          } else {
            warnings.push(`cap ${cap.capId}: manifest ${cap.memoryBlobId} → HTTP ${r.status}`);
          }
        } catch {
          warnings.push(`cap ${cap.capId}: manifest ${cap.memoryBlobId} unreadable`);
        }
      }
      // Fallback: at least the parent namespace is known directly from the cap.
      if (!resolved && cap.customerId) {
        add(cap, cap.customerId, "parent", "parent (cap only — no manifest)", "cap");
      }
    }

    return { ok: true, owner, packageId: PACKAGE_ID, capCount: caps.length, namespaces: out, warnings };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "enumeration failed" };
  }
}

export type TxResult = { ok: true; digest: string } | { ok: false; error: string };

export async function mintCap(customerId: string, memoryBlobId: string): Promise<TxResult> {
  try {
    if (!customerId.trim()) return { ok: false, error: "customerId required" };
    const client = getSui();
    const tx = new Transaction();
    tx.moveCall({
      target: `${PACKAGE_ID}::customer_memory::mint`,
      arguments: [
        tx.pure.vector("u8", toBytes(customerId)),
        tx.pure.vector("u8", toBytes(memoryBlobId || "(none)")),
      ],
    });
    const r = await client.signAndExecuteTransaction({
      signer: getKeypair(),
      transaction: tx,
      options: { showEffects: true },
    });
    if (r.effects?.status?.status !== "success") {
      return { ok: false, error: `mint tx status: ${r.effects?.status?.status}` };
    }
    return { ok: true, digest: r.digest };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "mint failed" };
  }
}

export async function transferCap(capId: string, to: string): Promise<TxResult> {
  try {
    if (!/^0x[0-9a-fA-F]{1,64}$/.test(to.trim())) {
      return { ok: false, error: "recipient must be a 0x… Sui address" };
    }
    const client = getSui();
    const tx = new Transaction();
    tx.moveCall({
      target: `${PACKAGE_ID}::customer_memory::transfer_cap`,
      arguments: [tx.object(capId), tx.pure.address(to.trim())],
    });
    const r = await client.signAndExecuteTransaction({
      signer: getKeypair(),
      transaction: tx,
      options: { showEffects: true },
    });
    if (r.effects?.status?.status !== "success") {
      return { ok: false, error: `transfer tx status: ${r.effects?.status?.status}` };
    }
    return { ok: true, digest: r.digest };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "transfer failed" };
  }
}

export type AnchorResult =
  | { ok: true; digest: string; kind: "mint" | "anchor"; fingerprint: string }
  | { ok: false; error: string };

// Anchor-on-upload: commit the transcript's hash on Sui (CallAnchored event).
// Mints a cap for the customer if none is owned yet, otherwise anchors the
// existing one. Pairs with the "upload conversation to memory" button.
export async function anchorMemory(
  customerId: string,
  transcript: string,
): Promise<AnchorResult> {
  try {
    if (!customerId.trim()) return { ok: false, error: "customerId required" };
    const fp = fingerprint(transcript || customerId);
    const client = getSui();
    const owner = serverAddress();
    const owned = await client.getOwnedObjects({
      owner,
      filter: { StructType: CAP_TYPE },
      options: { showContent: true },
    });
    let capId: string | undefined;
    for (const o of owned.data) {
      const c = o.data?.content;
      if (c && c.dataType === "moveObject") {
        const f = (c as unknown as { fields: Record<string, unknown> }).fields;
        if (decodeVecU8(f.customer_id) === customerId) {
          capId = o.data!.objectId;
          break;
        }
      }
    }
    const tx = new Transaction();
    if (capId) {
      tx.moveCall({
        target: `${PACKAGE_ID}::customer_memory::anchor`,
        arguments: [tx.object(capId), tx.pure.vector("u8", toBytes(fp))],
      });
    } else {
      tx.moveCall({
        target: `${PACKAGE_ID}::customer_memory::mint`,
        arguments: [tx.pure.vector("u8", toBytes(customerId)), tx.pure.vector("u8", toBytes(fp))],
      });
    }
    const r = await client.signAndExecuteTransaction({
      signer: getKeypair(),
      transaction: tx,
      options: { showEffects: true },
    });
    if (r.effects?.status?.status !== "success") {
      return { ok: false, error: `anchor tx status: ${r.effects?.status?.status}` };
    }
    return { ok: true, digest: r.digest, kind: capId ? "anchor" : "mint", fingerprint: fp };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "anchor failed" };
  }
}

// Anchor a real Walrus *manifest* blob id into the cap (the namespace memory map).
// Unlike anchorMemory (which stores a transcript fingerprint), this stores a blob
// id you can fetch back — so the cap points at a verifiable, self-describing map
// that travels with the cap on transfer. Mints the cap if none exists yet.
export async function anchorManifest(
  customerId: string,
  manifestBlobId: string,
): Promise<AnchorResult> {
  try {
    if (!customerId.trim()) return { ok: false, error: "customerId required" };
    if (!manifestBlobId.trim()) return { ok: false, error: "manifestBlobId required" };
    const client = getSui();
    const owner = serverAddress();
    const owned = await client.getOwnedObjects({
      owner,
      filter: { StructType: CAP_TYPE },
      options: { showContent: true },
    });
    let capId: string | undefined;
    for (const o of owned.data) {
      const c = o.data?.content;
      if (c && c.dataType === "moveObject") {
        const f = (c as unknown as { fields: Record<string, unknown> }).fields;
        if (decodeVecU8(f.customer_id) === customerId) {
          capId = o.data!.objectId;
          break;
        }
      }
    }
    const tx = new Transaction();
    if (capId) {
      tx.moveCall({
        target: `${PACKAGE_ID}::customer_memory::anchor`,
        arguments: [tx.object(capId), tx.pure.vector("u8", toBytes(manifestBlobId))],
      });
    } else {
      tx.moveCall({
        target: `${PACKAGE_ID}::customer_memory::mint`,
        arguments: [
          tx.pure.vector("u8", toBytes(customerId)),
          tx.pure.vector("u8", toBytes(manifestBlobId)),
        ],
      });
    }
    const r = await client.signAndExecuteTransaction({
      signer: getKeypair(),
      transaction: tx,
      options: { showEffects: true },
    });
    if (r.effects?.status?.status !== "success") {
      return { ok: false, error: `anchor tx status: ${r.effects?.status?.status}` };
    }
    return { ok: true, digest: r.digest, kind: capId ? "anchor" : "mint", fingerprint: manifestBlobId };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "anchor failed" };
  }
}

export type AnchorEvent = { txDigest: string; by: string; fingerprint: string; timestampMs: string | null };
export type AnchorsResult =
  | { ok: true; anchors: AnchorEvent[] }
  | { ok: false; error: string };

// Read the on-chain CallAnchored history for a customer — the verifiability trail.
export async function listAnchors(customerId: string): Promise<AnchorsResult> {
  try {
    const client = getSui();
    const res = await client.queryEvents({
      query: { MoveEventType: `${PACKAGE_ID}::customer_memory::CallAnchored` },
      limit: 50,
      order: "descending",
    });
    const anchors: AnchorEvent[] = [];
    for (const e of res.data) {
      const pj = e.parsedJson as { customer_id?: string; memory_blob_id?: string; by?: string } | undefined;
      if (!pj) continue;
      if (decodeVecU8(pj.customer_id) !== customerId) continue;
      anchors.push({
        txDigest: e.id.txDigest,
        by: pj.by ?? "",
        fingerprint: decodeVecU8(pj.memory_blob_id),
        timestampMs: e.timestampMs ?? null,
      });
    }
    return { ok: true, anchors };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "events query failed" };
  }
}

// ── The memory-map chain: Sui cap → manifest blob → conversation blobs ──────
// One round-trip that makes the on-chain cap the verifiable root of a customer's
// whole history: (1) rebuild + publish the namespace/conversation manifest to
// Walrus (backend), then (2) anchor that fresh blob id into the cap (minting it
// the first time). After this, the cap alone leads to every conversation blob —
// no SQLite needed for recovery, and a handoff (transfer_cap) moves the lot.
const BACKEND_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

/** A full, loggable receipt of everything pushed in one sync. */
export type SyncReceipt = {
  customerId: string;
  network: string;
  walrus: {
    profileBlobId: string | null;   // identity record on Walrus
    profileUrl: string | null;
    manifestBlobId: string;         // the index the cap points at
    manifestUrl: string;
    conversationCount: number;
  };
  sui: {
    packageId: string;
    module: string;                 // "customer_memory"
    function: "mint" | "anchor";    // which Move entry fn ran
    capType: string;                // the CustomerMemoryCap type
    capId: string | null;           // the cap object id
    txDigest: string;               // the on-chain transaction
    explorer: string;               // suiscan/explorer link
  };
};

export type SyncMapResult =
  | {
      ok: true;
      customerId: string;
      blobId: string;
      aggregatorUrl: string;
      digest: string;
      kind: "mint" | "anchor";
      conversationCount: number;
      receipt: SyncReceipt;
    }
  | { ok: false; error: string; blobId?: string; aggregatorUrl?: string };

export async function syncMemoryMap(
  clientId: number,
  recoverBlobId?: string,
): Promise<SyncMapResult> {
  try {
    // 1. publish the manifest (+ a dedicated profile/identity blob) to Walrus.
    //    `recover_blob_id` lets the backend rebuild a wiped cache from the cap's
    //    anchored manifest before publishing (Walrus-first / disposable SQLite).
    const pubRes = await fetch(`${BACKEND_BASE}/clients/${clientId}/manifest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ recover_blob_id: recoverBlobId ?? null }),
      cache: "no-store",
    });
    if (!pubRes.ok) return { ok: false, error: `publish manifest → HTTP ${pubRes.status}` };
    const pub = (await pubRes.json()) as {
      blob_id: string;
      aggregator_url: string;
      customer_id: string;
      profile_blob_id?: string | null;
      conversations?: unknown[];
    };
    if (!pub.blob_id) return { ok: false, error: "backend returned no manifest blob id" };

    // 2. anchor the manifest blob id into the on-chain cap (mints it if missing).
    const anchored = await anchorManifest(pub.customer_id, pub.blob_id);
    if (!anchored.ok) {
      return { ok: false, error: anchored.error, blobId: pub.blob_id, aggregatorUrl: pub.aggregator_url };
    }

    // 3. resolve the cap object id for the receipt.
    const capRes = await getCustomerCap(pub.customer_id);
    const capId = capRes.ok ? capRes.cap?.capId ?? null : null;
    const network = process.env.SUI_NETWORK ?? "testnet";
    const profileUrl = pub.profile_blob_id ? `${WALRUS_AGG}/v1/blobs/${pub.profile_blob_id}` : null;

    const receipt: SyncReceipt = {
      customerId: pub.customer_id,
      network,
      walrus: {
        profileBlobId: pub.profile_blob_id ?? null,
        profileUrl,
        manifestBlobId: pub.blob_id,
        manifestUrl: pub.aggregator_url,
        conversationCount: Array.isArray(pub.conversations) ? pub.conversations.length : 0,
      },
      sui: {
        packageId: PACKAGE_ID,
        module: "customer_memory",
        function: anchored.kind,
        capType: CAP_TYPE,
        capId,
        txDigest: anchored.digest,
        explorer: `https://suiscan.xyz/${network}/tx/${anchored.digest}`,
      },
    };

    // full server-side log of exactly what was pushed and where
    console.log("[syncMemoryMap] PUSH RECEIPT\n" + JSON.stringify(receipt, null, 2));

    return {
      ok: true,
      customerId: pub.customer_id,
      blobId: pub.blob_id,
      aggregatorUrl: pub.aggregator_url,
      digest: anchored.digest,
      kind: anchored.kind,
      conversationCount: receipt.walrus.conversationCount,
      receipt,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "sync failed" };
  }
}

export type CustomerCap = { capId: string; customerId: string; memoryBlobId: string };
export type CapResult =
  | { ok: true; cap: CustomerCap | null; packageId: string }
  | { ok: false; error: string };

// Find the on-chain cap for one customer namespace (or null if not minted yet).
export async function getCustomerCap(customerId: string): Promise<CapResult> {
  try {
    if (!PACKAGE_ID) return { ok: false, error: "SUI_PACKAGE_ID not set" };
    const client = getSui();
    let cursor: string | null = null;
    do {
      const res = await client.getOwnedObjects({
        owner: serverAddress(),
        filter: { StructType: CAP_TYPE },
        options: { showContent: true },
        cursor,
      });
      for (const o of res.data) {
        const c = o.data?.content;
        if (c && c.dataType === "moveObject") {
          const f = (c as unknown as { fields: Record<string, unknown> }).fields;
          if (decodeVecU8(f.customer_id) === customerId) {
            return {
              ok: true,
              packageId: PACKAGE_ID,
              cap: {
                capId: o.data!.objectId,
                customerId,
                memoryBlobId: decodeVecU8(f.memory_blob_id),
              },
            };
          }
        }
      }
      cursor = res.hasNextPage ? res.nextCursor ?? null : null;
    } while (cursor);
    return { ok: true, cap: null, packageId: PACKAGE_ID };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "cap lookup failed" };
  }
}
