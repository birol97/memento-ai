"use client";

// Memory-map panel: visualises (and maintains) the on-chain chain that makes a
// customer's whole history recoverable from Sui alone:
//
//     🔗 CustomerMemoryCap  →  ⬡ manifest blob (Walrus)  →  💬 conversation blobs
//
// "Sync memory map on-chain" rebuilds the manifest, writes it to Walrus, and
// anchors its blob id into the cap (minting the cap the first time). After that,
// the cap is the verifiable root — fetch the manifest from its memory_blob_id and
// you have every conversation blob id, no database needed. Transferring the cap
// hands the entire relationship to another rep with zero data migration.
import { useCallback, useEffect, useState } from "react";

import { FiLink2, FiDatabase, FiMessageSquare, FiRefreshCw } from "react-icons/fi";

import { getCustomerCap, syncMemoryMap, transferCap, type CustomerCap } from "@/app/actions/onchain";
import { fetchManifest, type Manifest } from "@/lib/api";
import { clientNamespace } from "@/lib/clientNamespace";

const WALRUS_AGG =
  process.env.NEXT_PUBLIC_WALRUS_AGGREGATOR ?? "https://aggregator.walrus-testnet.walrus.space";

const blobUrl = (id: string) => `${WALRUS_AGG}/v1/blobs/${id}`;
const short = (s: string, head = 8, tail = 6) =>
  s.length > head + tail + 1 ? `${s.slice(0, head)}…${s.slice(-tail)}` : s;

export default function MemoryMapPanel({ clientId, clientName }: { clientId: number; clientName: string }) {
  const namespace = clientNamespace(clientId);
  const [cap, setCap] = useState<CustomerCap | null>(null);
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [loading, setLoading] = useState(true);
  const [note, setNote] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [to, setTo] = useState("");
  const [transferring, setTransferring] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setNote(null);
    const r = await getCustomerCap(namespace);
    if (!r.ok) {
      setNote(r.error.includes("SUI_PACKAGE_ID") ? "On-chain disabled (SUI_PACKAGE_ID not set)." : r.error);
      setCap(null);
      setManifest(null);
      setLoading(false);
      return;
    }
    setCap(r.cap);
    // resolve the manifest the cap points at (it may be an older fingerprint, not
    // a real blob — fetch is best-effort and just yields null in that case).
    if (r.cap?.memoryBlobId) {
      try {
        setManifest(await fetchManifest(r.cap.memoryBlobId));
      } catch {
        setManifest(null);
      }
    } else {
      setManifest(null);
    }
    setLoading(false);
  }, [namespace]);

  useEffect(() => {
    void load();
  }, [load]);

  async function sync() {
    setSyncing(true);
    setNote(null);
    const r = await syncMemoryMap(clientId, cap?.memoryBlobId);
    if (r.ok) {
      setNote(`✓ ${r.kind === "mint" ? "Minted cap" : "Anchored"} — ${r.conversationCount} conversation(s) indexed · tx ${short(r.digest, 6, 6)}`);
      await load();
    } else {
      setNote(`Sync failed: ${r.error}`);
    }
    setSyncing(false);
  }

  async function handoff() {
    const addr = to.trim();
    if (!/^0x[0-9a-fA-F]{1,64}$/.test(addr)) {
      setNote("Recipient must be a 0x… Sui address.");
      return;
    }
    if (!cap) {
      setNote("Nothing to transfer — sync the memory map first to mint the cap.");
      return;
    }
    if (!confirm(`Hand ${clientName} over to ${short(addr)}? The cap (and all memory) moves to them.`)) return;
    setTransferring(true);
    setNote(null);
    const r = await transferCap(cap.capId, addr);
    setNote(r.ok ? `✓ Handed off · tx ${short(r.digest, 6, 6)}` : `Transfer failed: ${r.error}`);
    if (r.ok) {
      setTo("");
      await load();
    }
    setTransferring(false);
  }

  const convos = manifest?.conversations ?? [];

  return (
    <div className="mm-panel">
      <p className="mm-intro">
        The on-chain capability is the verifiable root of this customer&apos;s memory. Sync writes a
        fresh map to Walrus and anchors it on Sui — so the whole history is recoverable from the chain
        alone, and a handoff moves it in one transaction.
      </p>

      {loading ? (
        <p className="cw-muted">loading chain…</p>
      ) : (
        <div className="mm-chain">
          {/* link 1 — the cap */}
          <div className="mm-node">
            <div className="mm-node-h"><FiLink2 /> CustomerMemoryCap</div>
            {cap ? (
              <div className="mm-node-b">
                <code>{short(cap.capId, 10, 8)}</code>
                <span className="mm-tag ok">on-chain</span>
              </div>
            ) : (
              <div className="mm-node-b">
                <span className="cw-muted">not minted yet</span>
                <span className="mm-tag">pending</span>
              </div>
            )}
          </div>
          <div className="mm-arrow">↓ memory_blob_id</div>

          {/* link 2 — the manifest blob */}
          <div className="mm-node">
            <div className="mm-node-h"><FiDatabase /> Manifest blob (Walrus)</div>
            {cap?.memoryBlobId ? (
              <div className="mm-node-b">
                <code>{short(cap.memoryBlobId, 10, 8)}</code>
                <a href={blobUrl(cap.memoryBlobId)} target="_blank" rel="noreferrer" className="mm-link">open ↗</a>
                {manifest ? <span className="mm-tag ok">verified</span> : <span className="mm-tag warn">fingerprint?</span>}
              </div>
            ) : (
              <div className="mm-node-b"><span className="cw-muted">none anchored</span></div>
            )}
          </div>
          <div className="mm-arrow">↓ indexes</div>

          {/* link 3 — the conversation blobs */}
          <div className="mm-node">
            <div className="mm-node-h"><FiMessageSquare /> Conversation blobs <span className="mm-count">{convos.length}</span></div>
            {convos.length === 0 ? (
              <div className="mm-node-b"><span className="cw-muted">no conversation blobs in the anchored map</span></div>
            ) : (
              <ul className="mm-convos">
                {convos.map((c) => (
                  <li key={c.blob_id} className="mm-convo">
                    <span className="mm-convo-label">{c.label || c.kind || "interaction"}</span>
                    <span className="mm-convo-meta">
                      {c.at ? new Date(c.at).toLocaleDateString() : ""}
                      <a href={c.aggregator_url || blobUrl(c.blob_id)} target="_blank" rel="noreferrer" className="mm-link">open ↗</a>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {note && <p className="mm-note">{note}</p>}

      <button className="mm-sync" onClick={sync} disabled={syncing}>
        {syncing ? <>Syncing to Sui…</> : cap ? <><FiRefreshCw /> Sync memory map on-chain</> : <><FiLink2 /> Mint cap + sync memory map</>}
      </button>

      <div className="mm-handoff">
        <label className="mm-handoff-l">Hand off to another rep (Sui address)</label>
        <div className="mm-handoff-row">
          <input
            className="mm-handoff-in"
            placeholder="0x…"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
          <button className="mm-handoff-btn" onClick={handoff} disabled={transferring || !cap}>
            {transferring ? "…" : "Transfer"}
          </button>
        </div>
      </div>
    </div>
  );
}
