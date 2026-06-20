// Client-side session store. Holds the backend session JWT (minted by the
// `establishSession` server action after zkLogin verifies) so `lib/api.ts` can
// attach it as a Bearer token, and React components can react to login state.
//
// v1: in-memory + localStorage (survives refresh). This module is intentionally
// framework-neutral (NO React import) so it can be imported from both client
// components and the (server-side) api helpers like lib/api.ts. The React hook
// lives in lib/useSession.ts ("use client") so a client-only React API never gets
// dragged into a Server Component import chain. See docs/BUG_RSC_USESYNCEXTERNALSTORE.md.

export type OrgRef = { id: number; name: string; role: string };
export type SessionInfo = {
  token: string;
  address: string;
  orgId: number;
  role: string;
  orgs: OrgRef[];
};

const KEY = "salescall.session";
let mem: SessionInfo | null = null;
let loaded = false;
const subs = new Set<() => void>();

/** Unix-ms expiry from a JWT payload, or 0 if unparseable. */
function jwtExpMs(token: string): number {
  try {
    const payload = JSON.parse(
      typeof atob !== "undefined"
        ? atob(token.split(".")[1])
        : Buffer.from(token.split(".")[1], "base64").toString("utf8"),
    );
    return (payload.exp ?? 0) * 1000;
  } catch {
    return 0;
  }
}

function load(): SessionInfo | null {
  if (loaded) return mem;
  loaded = true;
  if (typeof window !== "undefined") {
    try {
      const raw = window.localStorage.getItem(KEY);
      if (raw) mem = JSON.parse(raw) as SessionInfo;
    } catch {
      /* ignore */
    }
  }
  // Drop an expired token so the gate re-establishes a fresh session instead of
  // silently falling back to the default org.
  if (mem && jwtExpMs(mem.token) < Date.now()) {
    mem = null;
    if (typeof window !== "undefined") {
      try {
        window.localStorage.removeItem(KEY);
      } catch {
        /* ignore */
      }
    }
  }
  return mem;
}

export function getSession(): SessionInfo | null {
  return load();
}

export function getSessionToken(): string | null {
  return load()?.token ?? null;
}

export function setSession(s: SessionInfo | null): void {
  mem = s;
  loaded = true;
  if (typeof window !== "undefined") {
    try {
      if (s) window.localStorage.setItem(KEY, JSON.stringify(s));
      else window.localStorage.removeItem(KEY);
    } catch {
      /* ignore */
    }
  }
  subs.forEach((f) => f());
}

/** Subscribe to session changes. Returns an unsubscribe fn. Consumed by the
 * `useSession` hook in lib/useSession.ts (kept here so the store stays React-free). */
export function subscribeSession(f: () => void): () => void {
  subs.add(f);
  return () => {
    subs.delete(f);
  };
}
