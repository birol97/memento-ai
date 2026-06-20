// Agent storage on Walrus (via the backend). The multi-agent pipeline coordinates
// by writing/reading these content-addressed blobs; per-agent state survives
// restarts via the named state pointer. This IS the shared memory the agents use.
const BACKEND = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
const WALRUS_AGG = process.env.NEXT_PUBLIC_WALRUS_AGGREGATOR ?? "https://aggregator.walrus-testnet.walrus.space";

export const aggUrl = (blobId: string) => `${WALRUS_AGG}/v1/blobs/${blobId}`;

/** Write any agent artifact to Walrus → returns its blob id. */
export async function putBlob(data: unknown): Promise<string> {
  const r = await fetch(`${BACKEND}/agent/blob`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ data }),
  });
  if (!r.ok) throw new Error(`putBlob → HTTP ${r.status}`);
  return (await r.json()).blob_id as string;
}

/** Read an agent artifact back from Walrus. */
export async function getBlob<T = unknown>(blobId: string): Promise<T | null> {
  try {
    const r = await fetch(aggUrl(blobId), { cache: "no-store" });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

/** The latest state blob id for a named agent (or null on first run). */
export async function getStatePointer(name: string): Promise<string | null> {
  try {
    const r = await fetch(`${BACKEND}/agent/state/${encodeURIComponent(name)}`, { cache: "no-store" });
    if (!r.ok) return null;
    return ((await r.json()).blob_id as string) || null;
  } catch {
    return null;
  }
}

/** Point a named agent at its newest state blob. */
export async function setStatePointer(name: string, blobId: string): Promise<void> {
  await fetch(`${BACKEND}/agent/state/${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ blob_id: blobId }),
  }).catch(() => {});
}

export type MonitorState = { last_run: string | null; handled: string[] };

export async function loadState(name: string): Promise<MonitorState> {
  const ptr = await getStatePointer(name);
  if (!ptr) return { last_run: null, handled: [] };
  const s = await getBlob<MonitorState>(ptr);
  return s && Array.isArray(s.handled) ? s : { last_run: null, handled: [] };
}

export async function saveState(name: string, state: MonitorState): Promise<string> {
  const blobId = await putBlob(state);
  await setStatePointer(name, blobId);
  return blobId;
}
