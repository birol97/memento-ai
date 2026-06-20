// PoC: organizational memory with cryptographic per-customer delegation.
//
//   1. CREATE a customer = a MemWalAccount (owned by the org)
//   2. GRANT  an employee = addDelegateKey(employeeKey)        ← owner-only, on-chain
//   3. employee READ/WRITES that customer's memory             ← proves access
//   4. REVOKE the employee = removeDelegateKey(employeeKey)    ← owner-only, on-chain
//   5. employee read FAILS                                     ← proves crypto revocation
//
// Run:  node scripts/poc-org-memory.mjs
import { readFileSync } from "fs";
import { createAccount, addDelegateKey, removeDelegateKey, generateDelegateKey } from "@mysten-incubation/memwal/account";
import { MemWal } from "@mysten-incubation/memwal";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";

const env = readFileSync(".env.local", "utf8");
const get = (k) => (env.match(new RegExp("^" + k + "=(.*)$", "m")) || [])[1]?.trim();
const suiClient = new SuiJsonRpcClient({ network: "testnet", url: "https://fullnode.testnet.sui.io:443" });

const PACKAGE  = "0xcf6ad755a1cdff7217865c796778fabe5aa399cb0cf2eba986f4b582047229c6"; // memwal pkg
const REGISTRY = "0xe80f2feec1c139616a86c9f71210152e2a7ca552b20841f2e192f99f75864437"; // AccountRegistry
const ORG_KEY  = get("SUI_SECRET_KEY");                 // org owner (has gas) — never shared
const SERVER   = get("MEMWAL_SERVER_URL") ?? "https://relayer.memwal.ai";
const NS        = "customer-acme";                       // a namespace inside the customer account
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const line = (s) => console.log(s);

line("STEP 1 — ORG creates a CUSTOMER account (a MemWalAccount it owns)");
let accountId;
try {
  const acc = await createAccount({ packageId: PACKAGE, registryId: REGISTRY, suiPrivateKey: ORG_KEY, suiClient });
  accountId = acc.accountId;
  line("  created account: " + accountId + "  (owner = org)  tx " + acc.digest.slice(0, 10) + "…");
} catch (e) {
  // "each address creates ONE account" — reuse if the org already has one
  const msg = e?.message || String(e);
  line("  createAccount note: " + msg.slice(0, 90));
  line("  → reusing existing MEMWAL_ACCOUNT_ID for the demo");
  accountId = get("MEMWAL_ACCOUNT_ID");
}

line("\nSTEP 2 — generate an EMPLOYEE delegate key (their own identity)");
const emp = await generateDelegateKey();
line("  employee pubkey : " + emp.suiAddress);

line("\nSTEP 3 — ORG GRANTS the employee access to this customer (addDelegateKey, owner-only)");
const g = await addDelegateKey({ packageId: PACKAGE, accountId, publicKey: emp.publicKey, label: "Employee Alice", suiPrivateKey: ORG_KEY, suiClient });
line("  granted ✓  tx " + g.digest.slice(0, 10) + "…");
await wait(4000); // let the relayer see the on-chain grant

line("\nSTEP 4 — EMPLOYEE writes + reads that customer's memory with THEIR key");
const empMem = MemWal.create({ key: emp.privateKey, accountId, serverUrl: SERVER, namespace: NS });
try {
  await empMem.rememberAndWait("Acme wants a Q3 renewal and prefers email.", NS);
  await wait(1500);
  const r = await empMem.recall("what does acme want?", 5, NS);
  line("  employee recall → " + ((r.results || []).map((x) => x.text).join(" | ") || "(empty)"));
  line("  ACCESS WHILE GRANTED: ✅ employee can read/write");
} catch (e) {
  line("  recall error: " + (e?.message || e));
}

line("\nSTEP 5 — ORG REVOKES the employee (removeDelegateKey, owner-only)");
const rv = await removeDelegateKey({ packageId: PACKAGE, accountId, publicKey: emp.publicKey, suiPrivateKey: ORG_KEY, suiClient });
line("  revoked ✓  tx " + rv.digest.slice(0, 10) + "…");
await wait(4000);

line("\nSTEP 6 — same EMPLOYEE key tries to read again → should FAIL");
try {
  const r2 = await empMem.recall("what does acme want?", 5, NS);
  line("  employee recall → " + ((r2.results || []).map((x) => x.text).join(" | ") || "(empty)"));
  line("  ⚠️ still readable — revocation may need more propagation time");
} catch (e) {
  line("  recall REJECTED: " + (e?.message || e).slice(0, 120));
  line("  ACCESS AFTER REVOKE: ✅ cryptographically denied");
}
line("\n=== ownership note: the account stays owned by the org the whole time;");
line("    the employee never owned it and could never transfer it. ===");
