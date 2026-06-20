// GET /api/accounts/:address/namespaces
// Enumerate the memory namespaces a Sui account owns, recovered from the
// CustomerMemoryCaps it holds on-chain + each cap's Walrus manifest. There is no
// native "list namespaces" API on MemWal/Walrus — see docs/ENUMERATING_NAMESPACES.md.
import { NextResponse } from "next/server";

import { namespacesOwnedBy } from "@/app/actions/onchain";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: { address: string } }) {
  const r = await namespacesOwnedBy(params.address);
  return NextResponse.json(r, { status: r.ok ? 200 : 400 });
}
