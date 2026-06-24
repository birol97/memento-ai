// On-chain organization directory (salescall::org). The company owns the Org
// object; its member table is the authoritative "who works here + role". No
// local DB row — the directory lives on Sui. Reads come straight from the object;
// employees discover their org via the MemberCap issued to them.
import { Transaction } from "@mysten/sui/transactions";

import { getSui, getKeypair, serverAddress } from "@/lib/sui";

const ORG_PKG = process.env.SUI_ORG_PACKAGE_ID ?? "";
const ORG_TYPE = `${ORG_PKG}::org::Org`;
const MEMBERCAP_TYPE = `${ORG_PKG}::org::MemberCap`;

export const ROLES = ["owner", "admin", "manager", "rep"] as const;
export type Role = (typeof ROLES)[number];
export const roleLabel = (n: number): Role => ROLES[n] ?? "rep";
export const roleNum = (r: Role): number => Math.max(0, ROLES.indexOf(r));

export type OrgMember = { addr: string; role: Role; label: string };
export type OrgView = { orgId: string; name: string; owner: string; members: OrgMember[] };

function decodeMembers(fields: Record<string, unknown>): OrgMember[] {
  const arr = (fields?.members as { fields?: Record<string, unknown> }[]) ?? [];
  return arr.map((m) => {
    const f = (m.fields ?? m) as Record<string, unknown>;
    return { addr: String(f.addr), role: roleLabel(Number(f.role)), label: String(f.label ?? "") };
  });
}

async function exec(tx: Transaction): Promise<string> {
  const client = getSui();
  const r = await client.signAndExecuteTransaction({ signer: getKeypair(), transaction: tx, options: { showEffects: true, showObjectChanges: true } });
  if (r.effects?.status?.status !== "success") throw new Error(`tx status: ${r.effects?.status?.status}`);
  return r.digest;
}

/** Create a company on-chain (owned by the company / server address). */
export async function createOrg(name: string): Promise<{ orgId: string; digest: string }> {
  if (!ORG_PKG) throw new Error("SUI_ORG_PACKAGE_ID not set");
  const tx = new Transaction();
  tx.moveCall({ target: `${ORG_PKG}::org::create_org`, arguments: [tx.pure.string(name)] });
  const client = getSui();
  const r = await client.signAndExecuteTransaction({ signer: getKeypair(), transaction: tx, options: { showObjectChanges: true } });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const created = (r.objectChanges ?? []).find((c: any) => c.type === "created" && String(c.objectType).endsWith("::org::Org")) as { objectId?: string } | undefined;
  if (!created?.objectId) throw new Error("org object not found in tx");
  return { orgId: created.objectId, digest: r.digest };
}

/** Create a company AND register `ownerAddress` as its owner-member in one go.
 *  The server still signs/pays gas, but the resulting org is scoped to the creator:
 *  the MemberCap issued here makes it show up under `orgsForMember(ownerAddress)`
 *  (and only there), so a different login never sees someone else's company. The
 *  on-chain Org.owner stays the server (gas payer) — the member table is the
 *  authoritative owner until true per-user signing (sponsored tx) is enabled. */
export async function createOrgForOwner(name: string, ownerAddress: string): Promise<{ orgId: string; digest: string }> {
  const { orgId, digest } = await createOrg(name);
  await addMember(orgId, ownerAddress, "owner", "Owner");
  return { orgId, digest };
}

/** Add (or update) an employee — owner-only; issues them a MemberCap. */
export async function addMember(orgId: string, member: string, role: Role, label: string): Promise<string> {
  const tx = new Transaction();
  tx.moveCall({ target: `${ORG_PKG}::org::add_member`, arguments: [tx.object(orgId), tx.pure.address(member), tx.pure.u8(roleNum(role)), tx.pure.string(label)] });
  return exec(tx);
}

/** Revoke an employee — remove them from the authoritative table. */
export async function revokeMember(orgId: string, member: string): Promise<string> {
  const tx = new Transaction();
  tx.moveCall({ target: `${ORG_PKG}::org::revoke_member`, arguments: [tx.object(orgId), tx.pure.address(member)] });
  return exec(tx);
}

/** Read the directory straight from the on-chain Org object. */
export async function getOrg(orgId: string): Promise<OrgView | null> {
  const client = getSui();
  const o = await client.getObject({ id: orgId, options: { showContent: true } });
  const c = o.data?.content;
  if (!c || c.dataType !== "moveObject") return null;
  const f = (c as unknown as { fields: Record<string, unknown> }).fields;
  return { orgId, name: String(f.name ?? ""), owner: String(f.owner ?? ""), members: decodeMembers(f) };
}

/** Every Org the company (server address) owns. */
export async function listOwnedOrgs(): Promise<OrgView[]> {
  if (!ORG_PKG) return [];
  const client = getSui();
  const res = await client.getOwnedObjects({ owner: serverAddress(), filter: { StructType: ORG_TYPE }, options: { showContent: true } });
  const out: OrgView[] = [];
  for (const o of res.data) {
    const c = o.data?.content;
    if (c && c.dataType === "moveObject") {
      const f = (c as unknown as { fields: Record<string, unknown> }).fields;
      out.push({ orgId: o.data!.objectId, name: String(f.name ?? ""), owner: String(f.owner ?? ""), members: decodeMembers(f) });
    }
  }
  return out;
}

/** The orgs an employee belongs to — discovered via their MemberCap(s), then
 *  re-verified against each Org's authoritative table (a stale cap is ignored). */
export async function orgsForMember(address: string): Promise<OrgView[]> {
  if (!ORG_PKG) return [];
  const client = getSui();
  const res = await client.getOwnedObjects({ owner: address, filter: { StructType: MEMBERCAP_TYPE }, options: { showContent: true } });
  const orgIds = new Set<string>();
  for (const o of res.data) {
    const c = o.data?.content;
    if (c && c.dataType === "moveObject") {
      const f = (c as unknown as { fields: Record<string, unknown> }).fields;
      if (f.org) orgIds.add(String(f.org));
    }
  }
  const out: OrgView[] = [];
  for (const id of orgIds) {
    const org = await getOrg(id).catch(() => null);
    if (org && org.members.some((m) => m.addr.toLowerCase() === address.toLowerCase())) out.push(org);
  }
  return out;
}
