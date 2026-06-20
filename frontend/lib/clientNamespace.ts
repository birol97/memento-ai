// Each sales customer (client) maps to one MemWal namespace, so a customer's
// memory is an isolated, owner+namespace-scoped space.
//
// Multi-tenancy (mirrors backend `app/services/manifest.py`):
//   - default org (or no org)  → legacy `salescall-client-<id>` so existing
//     Walrus memories + on-chain cap `customer_id` lookups keep resolving.
//   - any other org            → `salescall-o<orgId>-client-<id>` so client ids
//     can't collide across tenants.
// Pass `orgId` only for non-default orgs; omit it for the default/legacy org.
export function clientNamespace(
  clientId: number | string,
  orgId?: number | string | null,
): string {
  const id = String(clientId).replace(/[^a-zA-Z0-9_-]/g, "");
  if (!id) throw new Error(`invalid client id for namespace: ${clientId}`);
  if (orgId === undefined || orgId === null || orgId === "") {
    return `salescall-client-${id}`;
  }
  const oid = String(orgId).replace(/[^a-zA-Z0-9_-]/g, "");
  return `salescall-o${oid}-client-${id}`;
}

// Per-conversation sub-namespace under a client's generic namespace.
// <parent>__<nsKey> — flat string, "__" is the hierarchy separator.
export function subNamespace(
  clientId: number | string,
  nsKey: string,
  orgId?: number | string | null,
): string {
  const key = String(nsKey).replace(/[^a-zA-Z0-9_-]/g, "");
  if (!key) throw new Error(`invalid sub-namespace key: ${nsKey}`);
  return `${clientNamespace(clientId, orgId)}__${key}`;
}

// Server-side guard: only our app's namespaces (parent or sub) are allowed.
// Accepts both the legacy and the org-prefixed forms.
export function isAppNamespace(ns: string): boolean {
  return /^salescall-(o[A-Za-z0-9_-]+-)?client-[A-Za-z0-9_-]+$/.test(ns);
}

// Extract the numeric client id from any of our namespaces
// (salescall-client-13, salescall-o2-client-13, salescall-client-13__sub).
export function clientIdFromNamespace(ns: string): number | null {
  const m = ns.match(/^salescall-(?:o[A-Za-z0-9_-]+-)?client-(\d+)/);
  return m ? Number(m[1]) : null;
}
