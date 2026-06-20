"use server";

// Employee sign-in + scoped customer list. An employee signs in with their own
// key; the app shows ONLY the customers whose on-chain account lists that key as
// a delegate. Access is enforced by the chain (the delegate list), not the DB.
import { delegateKeyToPublicKey, delegateKeyToSuiAddress } from "@mysten-incubation/memwal";

import { listDelegates } from "@/lib/orgMemory";
import { orgsForMember } from "@/lib/orgChain";
import type { Client } from "@/lib/types";

/** The employee's on-chain org membership(s) — read from Sui, not the local DB. */
export async function employeeOrgs(address: string): Promise<{ name: string; role: string; orgId: string }[]> {
  try {
    const orgs = await orgsForMember(address);
    return orgs.map((o) => {
      const me = o.members.find((m) => m.addr.toLowerCase() === address.toLowerCase());
      return { name: o.name, role: me?.role ?? "member", orgId: o.orgId };
    });
  } catch {
    return [];
  }
}

const BACKEND = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
const norm = (h: string) => h.toLowerCase().replace(/^0x/, "");

export type EmployeeIdentity = { ok: true; pubHex: string; address: string } | { ok: false; error: string };

/** Resolve an employee's public key + address from their private key. */
export async function employeeSignIn(privateKeyHex: string): Promise<EmployeeIdentity> {
  try {
    const pk = privateKeyHex.trim();
    if (!pk) return { ok: false, error: "paste your employee key" };
    const pub = await delegateKeyToPublicKey(pk);
    const pubHex = typeof pub === "string" ? pub : Buffer.from(pub).toString("hex");
    const address = await delegateKeyToSuiAddress(pk);
    return { ok: true, pubHex, address };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "invalid key" };
  }
}

/** The customers this employee is granted (their key is a delegate on the account). */
export async function employeeCustomers(pubHex: string): Promise<Client[]> {
  const target = norm(pubHex);
  let clients: Client[] = [];
  try {
    const r = await fetch(`${BACKEND}/clients`, { cache: "no-store" });
    if (r.ok) clients = ((await r.json()) as { clients: Client[] }).clients ?? [];
  } catch {
    return [];
  }
  const granted: Client[] = [];
  await Promise.all(
    clients.map(async (c) => {
      if (!c.memwal_account_id) return;
      try {
        const dels = await listDelegates(c.memwal_account_id);
        if (dels.some((d) => norm(d.publicKeyHex) === target)) granted.push(c);
      } catch {
        /* skip unreadable account */
      }
    }),
  );
  return granted;
}
