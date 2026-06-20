// Server-only Sui client + signer for CustomerMemoryCap mint/transfer.
// The secret key lives in SUI_SECRET_KEY and is read only by "use server"
// actions — consistent with how the MemWal delegate key is handled.
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";

type Network = "testnet" | "mainnet" | "devnet" | "localnet";

let _client: SuiJsonRpcClient | null = null;
let _kp: Ed25519Keypair | null = null;

export const PACKAGE_ID = process.env.SUI_PACKAGE_ID ?? "";
export const CAP_TYPE = `${PACKAGE_ID}::customer_memory::CustomerMemoryCap`;

const FULLNODE: Record<Network, string> = {
  testnet: "https://fullnode.testnet.sui.io:443",
  mainnet: "https://fullnode.mainnet.sui.io:443",
  devnet: "https://fullnode.devnet.sui.io:443",
  localnet: "http://127.0.0.1:9000",
};

export function getSui(): SuiJsonRpcClient {
  if (!_client) {
    const net = (process.env.SUI_NETWORK ?? "testnet") as Network;
    // 2.x dropped getFullnodeUrl — pass network + explicit fullnode URL.
    _client = new SuiJsonRpcClient({ network: net, url: FULLNODE[net] });
  }
  return _client;
}

export function getKeypair(): Ed25519Keypair {
  if (!_kp) {
    const sk = process.env.SUI_SECRET_KEY;
    if (!sk) throw new Error("SUI_SECRET_KEY not set in frontend/.env.local");
    const { secretKey } = decodeSuiPrivateKey(sk);
    _kp = Ed25519Keypair.fromSecretKey(secretKey);
  }
  return _kp;
}

export function serverAddress(): string {
  return getKeypair().getPublicKey().toSuiAddress();
}
