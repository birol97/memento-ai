// Proves the "store NO owner key" model: the per-customer account owner key is
// DERIVED deterministically from the org master + customerId. The server can
// re-derive it any time to grant/revoke — nothing is ever stored in the DB.
//
//   derive(orgMaster, customerId) → ownerKey   (deterministic, secret)
//   provision once → createAccount with it
//   later: RE-DERIVE the same key from scratch → manage the account (grant)
//
// Run: node scripts/derive-owner.mjs
import { readFileSync } from "fs";
import { hkdfSync } from "crypto";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { Transaction } from "@mysten/sui/transactions";
import { createAccount, addDelegateKey, generateDelegateKey } from "@mysten-incubation/memwal/account";
import { MemWal } from "@mysten-incubation/memwal";

const env = readFileSync(".env.local", "utf8");
const get = (k) => (env.match(new RegExp("^" + k + "=(.*)$", "m")) || [])[1]?.trim();
const sui = new SuiJsonRpcClient({ network: "testnet", url: "https://fullnode.testnet.sui.io:443" });
const PACKAGE  = "0xcf6ad755a1cdff7217865c796778fabe5aa399cb0cf2eba986f4b582047229c6";
const REGISTRY = "0xe80f2feec1c139616a86c9f71210152e2a7ca552b20841f2e192f99f75864437";
const SERVER = get("MEMWAL_SERVER_URL") ?? "https://relayer.memwal.ai";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const L = console.log;

// org master secret → 32 bytes of key material (stays in env/vault, never in DB)
const MASTER = decodeSuiPrivateKey(get("SUI_SECRET_KEY")).secretKey;
const orgKp = Ed25519Keypair.fromSecretKey(MASTER);

// THE derivation: deterministic per-customer owner key. Store nothing.
function deriveOwnerKey(customerId) {
  const seed = new Uint8Array(hkdfSync("sha256", MASTER, Buffer.from("memwal-org-v1"), Buffer.from("owner:" + customerId), 32));
  return Ed25519Keypair.fromSecretKey(seed);
}

const CUSTOMER = "client-derivation-test";

const k1 = deriveOwnerKey(CUSTOMER);
L("derive #1  owner addr : " + k1.getPublicKey().toSuiAddress());

// fund + create the account with the derived key
{
  const tx = new Transaction();
  const [coin] = tx.splitCoins(tx.gas, [50_000_000]);
  tx.transferObjects([coin], k1.getPublicKey().toSuiAddress());
  await sui.signAndExecuteTransaction({ signer: orgKp, transaction: tx });
}
await wait(2500);
const acc = await createAccount({ packageId: PACKAGE, registryId: REGISTRY, suiPrivateKey: k1.getSecretKey(), suiClient: sui });
L("provisioned account   : " + acc.accountId);

// ---- now FORGET k1 entirely. Re-derive from scratch (as a later request would) ----
L("\n…simulating a later request: re-derive the owner key from org master + id…");
const k2 = deriveOwnerKey(CUSTOMER);
const same = k1.getPublicKey().toSuiAddress() === k2.getPublicKey().toSuiAddress();
L("derive #2  owner addr : " + k2.getPublicKey().toSuiAddress() + (same ? "  ← IDENTICAL ✅" : "  ← MISMATCH ❌"));

// use the RE-DERIVED key to manage the account (grant an employee) — proves no storage needed
const emp = await generateDelegateKey();
const g = await addDelegateKey({ packageId: PACKAGE, accountId: acc.accountId, publicKey: emp.publicKey, label: "Employee (own wallet)", suiPrivateKey: k2.getSecretKey(), suiClient: sui });
L("granted employee via RE-DERIVED key ✓ tx " + g.digest.slice(0, 10) + "…");
await wait(4000);

// employee (their own key) can now read/write
const mem = MemWal.create({ key: emp.privateKey, accountId: acc.accountId, serverUrl: SERVER, namespace: "profile" });
await mem.rememberAndWait("Derivation works: org manages with zero stored keys.", "profile");
await wait(1500);
const r = await mem.recall("does derivation work?", 3, "profile");
L("employee recall       : " + ((r.results || []).map((x) => x.text).join(" | ") || "(empty)"));

L("\n=== RESULT: account managed end-to-end with the owner key DERIVED, never stored.");
L("    DB needs to keep: nothing secret. (account id is a rebuildable cache.) ===");
