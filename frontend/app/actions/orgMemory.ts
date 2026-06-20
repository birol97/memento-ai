"use server";

// Provision a customer's org-owned MemWalAccount, then cache its id on the client
// row. The owner key is derived (never stored); the org's app delegate is added so
// the app can read/write. Safe to call best-effort after customer create.
import { generateDelegateKey } from "@mysten-incubation/memwal/account";

import { provisionCustomerAccount, grantEmployee, revokeEmployee, listDelegates, type Delegate } from "@/lib/orgMemory";
import { clientNamespace } from "@/lib/clientNamespace";

const BACKEND = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

export type ProvisionClientResult =
  | { ok: true; accountId: string; ownerAddress: string }
  | { ok: false; error: string };

export async function provisionClientAccount(clientId: number): Promise<ProvisionClientResult> {
  try {
    const ns = clientNamespace(clientId);
    const { accountId, ownerAddress } = await provisionCustomerAccount(ns);
    await fetch(`${BACKEND}/clients/${clientId}/memwal-account`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ account_id: accountId }),
    }).catch(() => {});
    return { ok: true, accountId, ownerAddress };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "provision failed" };
  }
}

/** Grant an employee (their own wallet pubkey) access to one customer's account. */
export async function grantEmployeeAccess(clientId: number, accountId: string, employeePublicKeyHex: string, label: string) {
  try {
    const r = await grantEmployee(clientNamespace(clientId), accountId, employeePublicKeyHex, label);
    return { ok: true as const, digest: r.digest };
  } catch (e) {
    return { ok: false as const, error: e instanceof Error ? e.message : "grant failed" };
  }
}

/** Revoke an employee's access to one customer's account. */
export async function revokeEmployeeAccess(clientId: number, accountId: string, employeePublicKeyHex: string) {
  try {
    const r = await revokeEmployee(clientNamespace(clientId), accountId, employeePublicKeyHex);
    return { ok: true as const, digest: r.digest };
  } catch (e) {
    return { ok: false as const, error: e instanceof Error ? e.message : "revoke failed" };
  }
}

/** The on-chain access list for a customer account. */
export async function listAccountDelegates(accountId: string): Promise<{ ok: true; delegates: Delegate[] } | { ok: false; error: string }> {
  try {
    return { ok: true, delegates: await listDelegates(accountId) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "list failed" };
  }
}

/** Demo helper: generate an employee keypair (in production the employee brings
 *  their own wallet pubkey). Returns the public key hex to grant + the private
 *  key shown ONCE so you can test recall as that employee. */
export async function generateEmployeeKey(): Promise<{ publicKeyHex: string; privateKey: string; suiAddress: string }> {
  const k = await generateDelegateKey();
  const pubHex = typeof k.publicKey === "string" ? k.publicKey : Buffer.from(k.publicKey).toString("hex");
  return { publicKeyHex: pubHex, privateKey: k.privateKey, suiAddress: k.suiAddress };
}
