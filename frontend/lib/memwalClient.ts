// Server-only MemWal client. The delegate private key is read from the
// environment and never reaches the browser — every caller is a "use server"
// action. One cached instance per process (key read once), exactly like the
// workshop-kit pattern.
import { MemWal } from "@mysten-incubation/memwal";

import { clientIdFromNamespace } from "./clientNamespace";
import { memForAccount } from "./orgMemory";

let cached: MemWal | null = null;

export function getMemWal(): MemWal {
  if (cached) return cached;

  const key = process.env.MEMWAL_PRIVATE_KEY;
  const accountId = process.env.MEMWAL_ACCOUNT_ID;
  const serverUrl = process.env.MEMWAL_SERVER_URL ?? "https://relayer.memwal.ai";

  if (!key || !accountId) {
    throw new Error(
      "MEMWAL_PRIVATE_KEY and MEMWAL_ACCOUNT_ID must be set in frontend/.env.local "
      + "(create a delegate key + account at https://staging.memwal.ai for testnet).",
    );
  }

  // The default namespace is never used directly — every call passes an
  // explicit per-client namespace (see clientNamespace).
  cached = MemWal.create({ key, accountId, serverUrl, namespace: "salescall" });
  return cached;
}

// ── per-customer account routing ────────────────────────────────────────────
// Resolve a namespace to the customer's OWN org-owned account when provisioned,
// else fall back to the shared account. Positive lookups are cached.
const BACKEND = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
const accountIdCache = new Map<number, string>();

async function clientAccountId(clientId: number): Promise<string | null> {
  const hit = accountIdCache.get(clientId);
  if (hit) return hit;
  try {
    const r = await fetch(`${BACKEND}/clients/${clientId}`, { cache: "no-store" });
    if (!r.ok) return null;
    const c = await r.json();
    const a = typeof c?.memwal_account_id === "string" ? c.memwal_account_id : null;
    if (a) accountIdCache.set(clientId, a); // cache only provisioned (positive) results
    return a;
  } catch {
    return null;
  }
}

/** Get the MemWal client for a namespace — the customer's own account if it has
 *  one, otherwise the shared account. Use this instead of getMemWal() in the
 *  recall/remember/analyze paths. */
export async function getMemWalForNamespace(namespace: string): Promise<MemWal> {
  const id = clientIdFromNamespace(namespace);
  if (id != null) {
    const accountId = await clientAccountId(id);
    if (accountId) return memForAccount(accountId, namespace);
  }
  return getMemWal();
}
