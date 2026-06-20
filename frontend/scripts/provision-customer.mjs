// Build step 1 — PROVISIONING: create one org-owned MemWal account PER customer.
// Proves the repeatable lifecycle the app will run on every customer create:
//   gen per-customer owner key → fund it from the org → createAccount (owner)
//   → add the ORG's delegate key (so the app/org can always read/write)
//   → write + read as the org delegate.
// Run: node scripts/provision-customer.mjs
import { readFileSync } from "fs";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { Transaction } from "@mysten/sui/transactions";
import { createAccount, addDelegateKey, generateDelegateKey } from "@mysten-incubation/memwal/account";
import { delegateKeyToPublicKey } from "@mysten-incubation/memwal";
import { MemWal } from "@mysten-incubation/memwal";

const env = readFileSync(".env.local", "utf8");
const get = (k) => (env.match(new RegExp("^" + k + "=(.*)$", "m")) || [])[1]?.trim();
const sui = new SuiJsonRpcClient({ network: "testnet", url: "https://fullnode.testnet.sui.io:443" });
const PACKAGE  = "0xcf6ad755a1cdff7217865c796778fabe5aa399cb0cf2eba986f4b582047229c6";
const REGISTRY = "0xe80f2feec1c139616a86c9f71210152e2a7ca552b20841f2e192f99f75864437";
const ORG_GAS_KEY = get("SUI_SECRET_KEY");                  // org's funded key (master)
const ORG_DELEGATE = get("MEMWAL_PRIVATE_KEY");             // org's app delegate key (hex)
const SERVER = get("MEMWAL_SERVER_URL") ?? "https://relayer.memwal.ai";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const L = console.log;

const orgKp = Ed25519Keypair.fromSecretKey(decodeSuiPrivateKey(ORG_GAS_KEY).secretKey);

// 1) per-customer OWNER key (in the app this is derived from the org master + customerId)
const owner = new Ed25519Keypair();
const ownerSk = owner.getSecretKey();              // bech32 suiprivkey…
const ownerAddr = owner.getPublicKey().toSuiAddress();
L("1. per-customer owner key  : " + ownerAddr);

// 2) fund it from the org so it can pay for createAccount
L("2. funding owner from org…");
{
  const tx = new Transaction();
  const [coin] = tx.splitCoins(tx.gas, [50_000_000]); // 0.05 SUI
  tx.transferObjects([coin], ownerAddr);
  const r = await sui.signAndExecuteTransaction({ signer: orgKp, transaction: tx, options: { showEffects: true } });
  L("   funded ✓ tx " + r.digest.slice(0, 10) + "…  status " + r.effects?.status?.status);
}
await wait(2500);

// 3) create the customer's MemWal account, owned by the per-customer key
L("3. createAccount (owner = per-customer key)…");
const acc = await createAccount({ packageId: PACKAGE, registryId: REGISTRY, suiPrivateKey: ownerSk, suiClient: sui });
L("   customer account: " + acc.accountId);

// 4) add the ORG's delegate key so the app/org can always read/write this customer
L("4. add ORG delegate key (app access)…");
const orgDelegatePub = await delegateKeyToPublicKey(ORG_DELEGATE);
const g = await addDelegateKey({ packageId: PACKAGE, accountId: acc.accountId, publicKey: orgDelegatePub, label: "Org App", suiPrivateKey: ownerSk, suiClient: sui });
L("   org delegate added ✓ tx " + g.digest.slice(0, 10) + "…");
await wait(4000);

// 5) the app (org delegate) writes + reads this customer's memory
L("5. app writes+reads via org delegate…");
const mem = MemWal.create({ key: ORG_DELEGATE, accountId: acc.accountId, serverUrl: SERVER, namespace: "profile" });
await mem.rememberAndWait("Mamdouh graduated college with high honour; prefers WhatsApp.", "profile");
await wait(1500);
const r = await mem.recall("what do we know about him?", 5, "profile");
L("   recall → " + ((r.results || []).map((x) => x.text).join(" | ") || "(empty)"));

L("\n=== RESULT: this customer now has its OWN account " + acc.accountId.slice(0, 12) + "…");
L("    owned by the org, app has delegate access, ready to grant employees per-customer. ===");
L("    (store on the client row: memwal_account_id=" + acc.accountId + " , owner key encrypted)");
