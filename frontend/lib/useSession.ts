"use client";

// React adapter for the session-token store (lib/session.ts). Kept in its own
// "use client" module so the client-only `useSyncExternalStore` API never leaks
// into a Server Component import chain — the store itself stays framework-neutral
// and server-importable. See docs/BUG_RSC_USESYNCEXTERNALSTORE.md.
import { useSyncExternalStore } from "react";

import { getSession, subscribeSession, type SessionInfo } from "./session";

/** React hook: re-renders when the session changes. The third arg is the server
 * snapshot — there's no session during SSR, so it renders logged-out and hydrates
 * to the real value on the client. */
export function useSession(): SessionInfo | null {
  return useSyncExternalStore(subscribeSession, getSession, () => null);
}
