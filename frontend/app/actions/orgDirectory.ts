"use server";

// Server actions for the on-chain org directory (the employee directory lives on
// Sui, not the local DB). The company address signs; reads come from the chain.
import { createOrg, addMember, revokeMember, getOrg, listOwnedOrgs, orgsForMember, type Role, type OrgView } from "@/lib/orgChain";

export async function createOrgAction(name: string): Promise<{ ok: true; orgId: string; digest: string } | { ok: false; error: string }> {
  try {
    if (!name.trim()) return { ok: false, error: "name required" };
    return { ok: true, ...(await createOrg(name.trim())) };
  } catch (e) { return { ok: false, error: e instanceof Error ? e.message : "create failed" }; }
}

export async function addMemberAction(orgId: string, member: string, role: Role, label: string): Promise<{ ok: true; digest: string } | { ok: false; error: string }> {
  try {
    if (!/^0x[0-9a-fA-F]{1,64}$/.test(member.trim())) return { ok: false, error: "member must be a 0x… Sui address" };
    return { ok: true, digest: await addMember(orgId, member.trim(), role, label.trim() || "Member") };
  } catch (e) { return { ok: false, error: e instanceof Error ? e.message : "add failed" }; }
}

export async function revokeMemberAction(orgId: string, member: string): Promise<{ ok: true; digest: string } | { ok: false; error: string }> {
  try { return { ok: true, digest: await revokeMember(orgId, member) }; }
  catch (e) { return { ok: false, error: e instanceof Error ? e.message : "revoke failed" }; }
}

export async function listOrgsAction(): Promise<OrgView[]> {
  try { return await listOwnedOrgs(); } catch { return []; }
}

export async function getOrgAction(orgId: string): Promise<OrgView | null> {
  try { return await getOrg(orgId); } catch { return null; }
}

export async function myOrgsAction(address: string): Promise<OrgView[]> {
  try { return await orgsForMember(address); } catch { return []; }
}
