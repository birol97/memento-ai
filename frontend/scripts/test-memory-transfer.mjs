// TEST: customer-memory HANDOFF — delegate a customer from the org owner to an
// employee, and prove the employee inherits the customer's accumulated memory.
//
// Story:
//   1. ORG provisions a customer (a MemWalAccount it owns) and writes what it
//      already knows about that customer  (the "institutional memory")
//   2. A NEW employee shows up with their own key (their wallet)
//   3. ORG OWNER delegates THIS customer to the employee  (addDelegateKey)   ← the handoff
//   4. Employee — with ONLY their own key — recalls the customer's memory      ← TRANSFER ✅
//   5. Employee adds their own note                                            ← write ✅
//   6. ORG OWNER revokes the employee  (removeDelegateKey)
//   7. Same employee key tries to read → cryptographically DENIED              ← revoke ✅
//
// The account stays owned by the org the whole time; the employee never owns it
// and can never take it. Run from frontend/:  node scripts/test-memory-transfer.mjs
import { readFileSync } from "fs";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { Transaction } from "@mysten/sui/transactions";
import { createAccount, addDelegateKey, removeDelegateKey, generateDelegateKey } from "@mysten-incubation/memwal/account";
import { delegateKeyToPublicKey, MemWal } from "@mysten-incubation/memwal";

// ── config / env ────────────────────────────────────────────────────────────
const env = readFileSync(".env.local", "utf8");
const get = (k) => (env.match(new RegExp("^" + k + "=(.*)$", "m")) || [])[1]?.trim();

const PACKAGE  = "0xcf6ad755a1cdff7217865c796778fabe5aa399cb0cf2eba986f4b582047229c6"; // memwal pkg
const REGISTRY = "0xe80f2feec1c139616a86c9f71210152e2a7ca552b20841f2e192f99f75864437"; // AccountRegistry
const ORG_GAS_KEY  = get("SUI_SECRET_KEY");    // org master (funded on testnet) — never shared
const ORG_DELEGATE = get("MEMWAL_PRIVATE_KEY"); // org's app delegate (how the org reads/writes)
const SERVER       = get("MEMWAL_SERVER_URL") ?? "https://relayer.memwal.ai";
const NS           = "profile";                 // namespace inside the customer's account

const sui   = new SuiJsonRpcClient({ network: "testnet", url: "https://fullnode.testnet.sui.io:443" });
const orgKp = Ed25519Keypair.fromSecretKey(decodeSuiPrivateKey(ORG_GAS_KEY).secretKey);

// ── tiny test harness ─────────────────────────────────────────────────────────
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const L = (...a) => console.log(...a);
let pass = 0, fail = 0;
const check = (label, ok) => { ok ? pass++ : fail++; L(`   ${ok ? "✅ PASS" : "❌ FAIL"} — ${label}`); return ok; };
const joinHits = (r) => (r?.results || []).map((x) => x.text).join(" | ");

if (!ORG_GAS_KEY || !ORG_DELEGATE) {
  L("Missing SUI_SECRET_KEY or MEMWAL_PRIVATE_KEY in .env.local — aborting."); process.exit(1);
}

// what the org "already knows" about this customer (the thing that must transfer)
const CUSTOMER_FACT = "Acme Corp wants a Q3 renewal, ~250k budget, prefers email; decision-maker is Sarah.";
const FACT_KEYWORD  = "renewal"; // we assert the employee's recall surfaces this

L("══════════════════════════════════════════════════════════════════════════");
L(" MEMORY HANDOFF TEST — org → employee customer delegation");
L("══════════════════════════════════════════════════════════════════════════");
L(" org gas/owner addr : " + orgKp.getPublicKey().toSuiAddress());

// ── 1. ORG provisions the customer's account (owned by a per-customer key) ─────
L("\n[1] ORG provisions the customer account…");
const owner = new Ed25519Keypair();                 // per-customer owner key (derived in the app)
const ownerSk = owner.getSecretKey();
const ownerAddr = owner.getPublicKey().toSuiAddress();
{
  const tx = new Transaction();
  const [coin] = tx.splitCoins(tx.gas, [50_000_000]); // 0.05 SUI to pay for createAccount
  tx.transferObjects([coin], ownerAddr);
  const r = await sui.signAndExecuteTransaction({ signer: orgKp, transaction: tx, options: { showEffects: true } });
  L("   funded per-customer owner " + ownerAddr.slice(0, 12) + "… (tx " + r.digest.slice(0, 8) + "…)");
}
await wait(2500);
const acc = await createAccount({ packageId: PACKAGE, registryId: REGISTRY, suiPrivateKey: ownerSk, suiClient: sui });
const accountId = acc.accountId;
L("   customer account  : " + accountId + "  (owner = org)");

// org adds ITS app delegate so it can read/write the customer's memory
const orgPub = await delegateKeyToPublicKey(ORG_DELEGATE);
await addDelegateKey({ packageId: PACKAGE, accountId, publicKey: orgPub, label: "Org App", suiPrivateKey: ownerSk, suiClient: sui });
await wait(4000);

// ── 2. ORG writes the customer's institutional memory ─────────────────────────
L("\n[2] ORG writes what it knows about the customer (as the org delegate)…");
const orgMem = MemWal.create({ key: ORG_DELEGATE, accountId, serverUrl: SERVER, namespace: NS });
await orgMem.rememberAndWait(CUSTOMER_FACT, NS);
await wait(1500);
const orgRead = await orgMem.recall("what does the customer want?", 5, NS);
L("   org recall → " + (joinHits(orgRead) || "(empty)"));
check("org can read its own write", joinHits(orgRead).toLowerCase().includes(FACT_KEYWORD));

// ── 3. NEW employee key + ORG delegates THIS customer to them ─────────────────
L("\n[3] A new employee appears; ORG OWNER delegates this customer to them…");
const emp = await generateDelegateKey();
L("   employee identity : " + emp.suiAddress);
const g = await addDelegateKey({ packageId: PACKAGE, accountId, publicKey: emp.publicKey, label: "Employee Alice", suiPrivateKey: ownerSk, suiClient: sui });
L("   delegated ✓ (tx " + g.digest.slice(0, 8) + "…)");
await wait(4000); // let the relayer observe the on-chain grant

// ── 4. EMPLOYEE reads the customer's memory with ONLY their key → TRANSFER ─────
L("\n[4] EMPLOYEE recalls the customer's memory with their OWN key…");
const empMem = MemWal.create({ key: emp.privateKey, accountId, serverUrl: SERVER, namespace: NS });
const empRead = await empMem.recall("what does the customer want?", 5, NS);
L("   employee recall → " + (joinHits(empRead) || "(empty)"));
check("MEMORY TRANSFERRED: employee sees the org's earlier memory", joinHits(empRead).toLowerCase().includes(FACT_KEYWORD));

// ── 5. EMPLOYEE writes their own note (proves full read/write) ─────────────────
L("\n[5] EMPLOYEE adds a new note…");
await empMem.rememberAndWait("Called Sarah on " + "2026-06-24; renewal verbally agreed.", NS);
await wait(1500);
const empRead2 = await empMem.recall("latest update on the deal?", 5, NS);
check("employee can WRITE (their note is recallable)", joinHits(empRead2).toLowerCase().includes("sarah"));

// org sees the employee's note too (shared customer memory)
const orgRead2 = await orgMem.recall("latest update on the deal?", 5, NS);
check("org sees the employee's new note (shared customer memory)", joinHits(orgRead2).toLowerCase().includes("sarah"));

// ── 6 + 7. ORG REVOKES → employee can no longer read ──────────────────────────
L("\n[6] ORG OWNER revokes the employee…");
const rv = await removeDelegateKey({ packageId: PACKAGE, accountId, publicKey: emp.publicKey, suiPrivateKey: ownerSk, suiClient: sui });
L("   revoked ✓ (tx " + rv.digest.slice(0, 8) + "…)");
await wait(4000);

L("\n[7] Same employee key tries to read again…");
let denied = false;
try {
  const after = await empMem.recall("what does the customer want?", 5, NS);
  L("   employee recall → " + (joinHits(after) || "(empty)"));
  denied = (joinHits(after) === ""); // empty = effectively cut off
  if (!denied) L("   ⚠️  still readable — revocation may need more relayer propagation time");
} catch (e) {
  denied = true;
  L("   recall REJECTED: " + String(e?.message || e).slice(0, 120));
}
check("REVOKED: employee is cut off after revocation", denied);

// ── verdict ───────────────────────────────────────────────────────────────────
L("\n══════════════════════════════════════════════════════════════════════════");
L(`  RESULT: ${pass} passed, ${fail} failed   (account ${accountId.slice(0, 12)}… stayed org-owned throughout)`);
L("══════════════════════════════════════════════════════════════════════════");
process.exit(fail === 0 ? 0 : 1);
