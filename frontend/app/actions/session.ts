"use server";

// Server actions that turn a verified zkLogin session into a backend session JWT.
//
// The linchpin: `establishSession` cryptographically verifies the user controls
// the Sui address (verifyPersonalMessageSignature, which handles zkLogin sigs)
// BEFORE minting any token — so a client can't claim an address it doesn't own.
// Then the backend `/auth/sync` provisions the user + their org, and we mint the
// HS256 session JWT the backend verifies on every request.
import { SignJWT, jwtVerify } from "jose";
import { verifyPersonalMessageSignature } from "@mysten/sui/verify";

import { getSui } from "@/lib/sui";
import type { OrgRef } from "@/lib/session";

function secret(): Uint8Array {
  return new TextEncoder().encode(process.env.SESSION_JWT_SECRET ?? "");
}

function backendBase(): string {
  const ws = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:8000/ws/transcribe";
  try {
    const u = new URL(ws);
    return `${u.protocol === "wss:" ? "https:" : "http:"}//${u.host}`;
  } catch {
    return "http://localhost:8000";
  }
}

async function mint(
  payload: { sub: string; org_id?: number; role?: string },
  exp: string,
): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(exp)
    .sign(secret());
}

type SyncResponse = { sui_address: string; current_org: number; role: string; orgs: OrgRef[] };

async function sync(bootstrapToken: string): Promise<SyncResponse> {
  const res = await fetch(`${backendBase()}/auth/sync`, {
    method: "POST",
    headers: { Authorization: `Bearer ${bootstrapToken}` },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`auth/sync failed: ${res.status}`);
  return (await res.json()) as SyncResponse;
}

export type EstablishResult =
  | { ok: true; token: string; address: string; orgId: number; role: string; orgs: OrgRef[] }
  | { ok: false; error: string };

/**
 * Verify the user controls `address` (via the personal-message signature), then
 * provision + mint a session JWT. `messageB64` is the base64 the wallet signed
 * (returned as `bytes` from useSignPersonalMessage).
 */
export async function establishSession(
  address: string,
  messageB64: string,
  signature: string,
): Promise<EstablishResult> {
  try {
    if (!process.env.SESSION_JWT_SECRET) return { ok: false, error: "SESSION_JWT_SECRET not set on the server" };

    const msgBytes = new Uint8Array(Buffer.from(messageB64, "base64"));

    // 1. cryptographic proof of address control (zkLogin-aware verifier).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pk = await verifyPersonalMessageSignature(msgBytes, signature, {
      client: getSui() as any,
      address,
    });
    if (pk.toSuiAddress() !== address) return { ok: false, error: "address / signature mismatch" };

    // 2. freshness — message carries `ts:<ms>`; reject if older than 5 min.
    const text = Buffer.from(msgBytes).toString("utf8");
    const m = text.match(/ts:(\d+)/);
    if (!m || Math.abs(Date.now() - Number(m[1])) > 5 * 60_000) {
      return { ok: false, error: "login message expired — try again" };
    }

    // 3. provision user + org via the backend, then mint the full session JWT.
    const bootstrap = await mint({ sub: address }, "2m");
    const s = await sync(bootstrap);
    const token = await mint({ sub: address, org_id: s.current_org, role: s.role }, "12h");
    return { ok: true, token, address, orgId: s.current_org, role: s.role, orgs: s.orgs };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "establish failed" };
  }
}

/**
 * After a brand-new user creates their company on-chain, mirror it to the backend
 * (POST /orgs — idempotent on org_object_id) and re-mint the session JWT scoped to
 * that org. Without this the new user's token still carries no org, so their first
 * customer would be created under the default org instead of their company — and
 * chain-derived identity would later re-home the org but leave that customer
 * stranded. `currentToken` is their existing (orgless) session JWT; it both
 * authorizes the POST and proves address control.
 */
export async function linkOrgAndSwitch(
  currentToken: string,
  name: string,
  orgObjectId: string,
  ownerAddress: string,
): Promise<EstablishResult> {
  try {
    const { payload } = await jwtVerify(currentToken, secret());
    const address = String(payload.sub);
    const res = await fetch(`${backendBase()}/orgs`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${currentToken}` },
      cache: "no-store",
      body: JSON.stringify({ name, org_object_id: orgObjectId, owner_address: ownerAddress }),
    });
    if (!res.ok) return { ok: false, error: `link org failed: ${res.status}` };
    const org = (await res.json()) as { id: number };
    // Re-sync + re-mint so every subsequent request is scoped to the new org.
    const bootstrap = await mint({ sub: address }, "2m");
    const s = await sync(bootstrap);
    const role = s.orgs.find((o) => o.id === org.id)?.role ?? "owner";
    const token = await mint({ sub: address, org_id: org.id, role }, "12h");
    return { ok: true, token, address, orgId: org.id, role, orgs: s.orgs };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "link failed" };
  }
}

/** Switch the active org. Requires the current valid session token (proves the
 * caller already authenticated); re-checks membership before re-minting. */
export async function switchOrg(currentToken: string, orgId: number): Promise<EstablishResult> {
  try {
    const { payload } = await jwtVerify(currentToken, secret());
    const address = String(payload.sub);
    const bootstrap = await mint({ sub: address }, "2m");
    const s = await sync(bootstrap);
    const target = s.orgs.find((o) => o.id === orgId);
    if (!target) return { ok: false, error: "not a member of that org" };
    const token = await mint({ sub: address, org_id: orgId, role: target.role }, "12h");
    return { ok: true, token, address, orgId, role: target.role, orgs: s.orgs };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "switch failed" };
  }
}
