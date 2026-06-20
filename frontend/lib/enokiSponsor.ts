// Enoki sponsored transactions (server-side, secret-key flow). Lets the org pay
// gas for a customer's derived owner key so we never have to fund it — gasless
// provisioning + grants. Falls back to self-funding when ENOKI_PRIVATE_KEY is
// unset or Enoki rejects (e.g. targets not allowlisted in the Enoki portal).
import { EnokiClient } from "@mysten/enoki";
import { toBase64, fromBase64 } from "@mysten/sui/utils";
import type { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import type { Transaction } from "@mysten/sui/transactions";
import type { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";

const ENOKI_SECRET = process.env.ENOKI_PRIVATE_KEY;
const NET = (process.env.SUI_NETWORK ?? "testnet") as "testnet" | "mainnet";

export function enokiEnabled(): boolean {
  return !!ENOKI_SECRET;
}

let _client: EnokiClient | null = null;
function enoki(): EnokiClient {
  if (!_client) _client = new EnokiClient({ apiKey: ENOKI_SECRET! });
  return _client;
}

/** Build → sponsor (Enoki pays gas) → sign with `signer` → execute. Returns the digest. */
export async function sponsorExecute(
  suiClient: SuiJsonRpcClient,
  tx: Transaction,
  signer: Ed25519Keypair,
  allowedMoveCallTargets: string[],
): Promise<string> {
  const sender = signer.getPublicKey().toSuiAddress();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const kindBytes: Uint8Array = await tx.build({ client: suiClient as any, onlyTransactionKind: true });
  const sponsored = await enoki().createSponsoredTransaction({
    network: NET,
    transactionKindBytes: toBase64(kindBytes),
    sender,
    allowedMoveCallTargets,
  });
  const { signature } = await signer.signTransaction(fromBase64(sponsored.bytes));
  const res = await enoki().executeSponsoredTransaction({ digest: sponsored.digest, signature });
  return res.digest;
}
