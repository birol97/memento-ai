// Organizational memory engine (server-only).
//
// Each CUSTOMER = a MemWalAccount the ORG owns. The owner key is DERIVED from the
// org master + customer id (never stored). Employees are granted/revoked on-chain
// (owner-only). The app reads/writes a customer's memory via the org's delegate key.
//
//   provisionCustomerAccount(ns) → create the org-owned account, add the org delegate
//   grantEmployee / revokeEmployee(ns, account, employeePubKey) → on-chain, owner-only
//   memForAccount(accountId) → a MemWal client scoped to that customer's account
//
// Proven by scripts/{provision-customer,poc-org-memory,derive-owner}.mjs.
import { hkdfSync } from "crypto";

import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { Ed25519Keypair, Ed25519PublicKey } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { fromHex } from "@mysten/sui/utils";
import { Transaction } from "@mysten/sui/transactions";
import { createAccount, addDelegateKey, removeDelegateKey } from "@mysten-incubation/memwal/account";
import { MemWal, delegateKeyToPublicKey } from "@mysten-incubation/memwal";

import { enokiEnabled, sponsorExecute } from "./enokiSponsor";

const CLOCK = "0x0000000000000000000000000000000000000000000000000000000000000006";
const T_CREATE = "::account::create_account";
const T_ADD = "::account::add_delegate_key";
const T_REMOVE = "::account::remove_delegate_key";

function toPkBytes(pk: Uint8Array | string): Uint8Array {
  return typeof pk === "string" ? fromHex(pk.replace(/^0x/, "")) : pk;
}
function pkSuiAddress(pkBytes: Uint8Array): string {
  return new Ed25519PublicKey(pkBytes).toSuiAddress();
}

const PACKAGE = process.env.MEMWAL_PACKAGE_ID ?? "0xcf6ad755a1cdff7217865c796778fabe5aa399cb0cf2eba986f4b582047229c6";
const REGISTRY = process.env.MEMWAL_REGISTRY_ID ?? "0xe80f2feec1c139616a86c9f71210152e2a7ca552b20841f2e192f99f75864437";
const NET = process.env.SUI_NETWORK ?? "testnet";
const FULLNODE = NET === "mainnet" ? "https://fullnode.mainnet.sui.io:443" : "https://fullnode.testnet.sui.io:443";
const SERVER = process.env.MEMWAL_SERVER_URL ?? "https://relayer.memwal.ai";
const FUND_MIST = 50_000_000n; // 0.05 SUI to a fresh owner key so it can pay for createAccount

function orgMaster(): Uint8Array {
  const k = process.env.SUI_SECRET_KEY;
  if (!k) throw new Error("SUI_SECRET_KEY (org master) not set");
  return decodeSuiPrivateKey(k).secretKey;
}
function orgDelegateKey(): string {
  const k = process.env.MEMWAL_PRIVATE_KEY;
  if (!k) throw new Error("MEMWAL_PRIVATE_KEY (org app delegate) not set");
  return k;
}
function sui() { return new SuiJsonRpcClient({ network: NET as "testnet" | "mainnet", url: FULLNODE }); }
function orgKeypair() { return Ed25519Keypair.fromSecretKey(orgMaster()); }

/** Deterministic per-customer account owner key — derived, never stored. */
export function deriveOwnerKey(customerId: string): Ed25519Keypair {
  const seed = new Uint8Array(
    hkdfSync("sha256", orgMaster(), Buffer.from("memwal-org-v1"), Buffer.from("owner:" + customerId), 32),
  );
  return Ed25519Keypair.fromSecretKey(seed);
}

export type ProvisionResult = { accountId: string; ownerAddress: string };

/** Create the org-owned MemWalAccount for a customer + add the org's app delegate.
 *  Gasless via Enoki when configured; otherwise the org funds the owner key. */
export async function provisionCustomerAccount(customerId: string): Promise<ProvisionResult> {
  const c = sui();
  const owner = deriveOwnerKey(customerId);
  const ownerAddress = owner.getPublicKey().toSuiAddress();
  const orgPub = await delegateKeyToPublicKey(orgDelegateKey());

  // ── gasless path: Enoki sponsors the org-owner's txs (no funding needed) ──
  if (enokiEnabled()) {
    try {
      const createTx = new Transaction();
      createTx.moveCall({ target: `${PACKAGE}${T_CREATE}`, arguments: [createTx.object(REGISTRY), createTx.object(CLOCK)] });
      const digest = await sponsorExecute(c, createTx, owner, [`${PACKAGE}${T_CREATE}`]);
      const txb = await c.getTransactionBlock({ digest, options: { showObjectChanges: true } });
      const created = (txb.objectChanges ?? []).find(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (ch: any) => ch.type === "created" && String(ch.objectType).includes("::account::MemWalAccount"),
      ) as { objectId?: string } | undefined;
      const accountId = created?.objectId;
      if (!accountId) throw new Error("sponsored create: account id not found");
      await sponsoredAddDelegate(c, owner, accountId, toPkBytes(orgPub), "Org App");
      return { accountId, ownerAddress };
    } catch (e) {
      console.warn("[enoki] sponsored provision failed → funding fallback:", e instanceof Error ? e.message : e);
    }
  }

  // ── fallback: fund the owner, then self-execute via the SDK ──
  const fundTx = new Transaction();
  const [coin] = fundTx.splitCoins(fundTx.gas, [FUND_MIST]);
  fundTx.transferObjects([coin], ownerAddress);
  await c.signAndExecuteTransaction({ signer: orgKeypair(), transaction: fundTx });
  await new Promise((r) => setTimeout(r, 2500));

  const acc = await createAccount({ packageId: PACKAGE, registryId: REGISTRY, suiPrivateKey: owner.getSecretKey(), suiClient: c });
  await addDelegateKey({ packageId: PACKAGE, accountId: acc.accountId, publicKey: orgPub, label: "Org App", suiPrivateKey: owner.getSecretKey(), suiClient: c });
  return { accountId: acc.accountId, ownerAddress };
}

async function sponsoredAddDelegate(c: SuiJsonRpcClient, owner: Ed25519Keypair, accountId: string, pkBytes: Uint8Array, label: string): Promise<string> {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PACKAGE}${T_ADD}`,
    arguments: [tx.object(accountId), tx.pure.vector("u8", Array.from(pkBytes)), tx.pure.address(pkSuiAddress(pkBytes)), tx.pure.string(label), tx.object(CLOCK)],
  });
  return sponsorExecute(c, tx, owner, [`${PACKAGE}${T_ADD}`]);
}

/** Grant an employee (their own wallet pubkey) read/write to one customer — on-chain, owner-only. */
export async function grantEmployee(customerId: string, accountId: string, employeePublicKey: Uint8Array | string, label: string): Promise<{ digest: string }> {
  const c = sui();
  const owner = deriveOwnerKey(customerId);
  const pkBytes = toPkBytes(employeePublicKey);
  if (enokiEnabled()) {
    try {
      return { digest: await sponsoredAddDelegate(c, owner, accountId, pkBytes, label) };
    } catch (e) {
      console.warn("[enoki] sponsored grant failed → funding fallback:", e instanceof Error ? e.message : e);
      await ensureFunds(c, owner.getPublicKey().toSuiAddress());
    }
  }
  const r = await addDelegateKey({ packageId: PACKAGE, accountId, publicKey: pkBytes, label, suiPrivateKey: owner.getSecretKey(), suiClient: c });
  return { digest: r.digest };
}

/** Revoke an employee — on-chain, owner-only. */
export async function revokeEmployee(customerId: string, accountId: string, employeePublicKey: Uint8Array | string): Promise<{ digest: string }> {
  const c = sui();
  const owner = deriveOwnerKey(customerId);
  const pkBytes = toPkBytes(employeePublicKey);
  if (enokiEnabled()) {
    try {
      const tx = new Transaction();
      tx.moveCall({ target: `${PACKAGE}${T_REMOVE}`, arguments: [tx.object(accountId), tx.pure.vector("u8", Array.from(pkBytes))] });
      return { digest: await sponsorExecute(c, tx, owner, [`${PACKAGE}${T_REMOVE}`]) };
    } catch (e) {
      console.warn("[enoki] sponsored revoke failed → funding fallback:", e instanceof Error ? e.message : e);
      await ensureFunds(c, owner.getPublicKey().toSuiAddress());
    }
  }
  const r = await removeDelegateKey({ packageId: PACKAGE, accountId, publicKey: pkBytes, suiPrivateKey: owner.getSecretKey(), suiClient: c });
  return { digest: r.digest };
}

// top up the derived owner so the SDK fallback can self-pay gas
async function ensureFunds(c: SuiJsonRpcClient, ownerAddress: string): Promise<void> {
  try {
    const bal = await c.getBalance({ owner: ownerAddress });
    if (BigInt(bal.totalBalance) >= FUND_MIST) return;
    const tx = new Transaction();
    const [coin] = tx.splitCoins(tx.gas, [FUND_MIST]);
    tx.transferObjects([coin], ownerAddress);
    await c.signAndExecuteTransaction({ signer: orgKeypair(), transaction: tx });
    await new Promise((r) => setTimeout(r, 2000));
  } catch {
    /* best-effort */
  }
}

/** A MemWal client scoped to one customer's account, using the org's app delegate key. */
export function memForAccount(accountId: string, namespace = "profile"): MemWal {
  return MemWal.create({ key: orgDelegateKey(), accountId, serverUrl: SERVER, namespace });
}

export type Delegate = { label: string; suiAddress: string; publicKeyHex: string };

/** Read the on-chain delegate-key list for a customer account (the access list). */
export async function listDelegates(accountId: string): Promise<Delegate[]> {
  const o = await sui().getObject({ id: accountId, options: { showContent: true } });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fields = (o.data?.content as any)?.fields;
  const arr: any[] = fields?.delegate_keys ?? []; // eslint-disable-line @typescript-eslint/no-explicit-any
  return arr.map((d) => {
    const f = d?.fields ?? d;
    const pk = f?.public_key;
    const hex = Array.isArray(pk) ? Buffer.from(pk).toString("hex") : typeof pk === "string" ? pk : "";
    return { label: f?.label ?? "", suiAddress: f?.sui_address ?? "", publicKeyHex: hex };
  });
}
