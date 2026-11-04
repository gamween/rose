import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { baseDecode } from "near-api-js";
import { createPublicClient, createWalletClient, http, parseEther, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

export const DEFAULT_BASE_RPC_URL = "https://sepolia.base.org";
export const DEFAULT_SOLANA_RPC_URL = "https://api.devnet.solana.com";
export const DEFAULT_NEAR_HELPER_URL = "https://helper.nearprotocol.com/account";
/** 0.002 ETH: a few dozen Base Sepolia transactions. */
export const DEFAULT_BASE_ETH_WEI = parseEther("0.002");
/** 0.05 SOL: rent for a nonce account plus many transaction fees. */
export const DEFAULT_SOLANA_LAMPORTS = BigInt(LAMPORTS_PER_SOL) / 20n;
/** What the NEAR testnet helper funds a new account with (measured 2026-11-04). */
export const NEAR_HELPER_FUNDING = "10 NEAR";

export class FaucetError extends Error {
  constructor(
    readonly code: "faucet_dry" | "upstream" | "invalid_request",
    message: string,
  ) {
    super(message);
    this.name = "FaucetError";
  }
}

/** The chain senders the handler depends on; the route test mocks this interface. */
export interface FaucetSenders {
  sendBase(address: `0x${string}`): Promise<{ txHash: string; amount: string }>;
  sendSolana(address: string): Promise<{ signature: string; amount: string }>;
  createNearAccount(accountId: string, publicKey: string): Promise<{ txHash: string }>;
}

export type FaucetConfig = {
  base: { configured: boolean; rpcUrl: string; amountWei: bigint };
  solana: { configured: boolean; rpcUrl: string; lamports: bigint };
  near: { configured: boolean; helperUrl: string };
  cookieSecret: string | null;
};

function bigintEnv(value: string | undefined, fallback: bigint): bigint {
  const trimmed = value?.trim();
  return trimmed && /^\d+$/.test(trimmed) ? BigInt(trimmed) : fallback;
}

/** Reads the faucet configuration; only presence is kept for the keys, their values stay in the senders. */
export function readFaucetConfig(env: NodeJS.ProcessEnv): FaucetConfig {
  return {
    base: {
      configured: Boolean(env.BASE_FAUCET_PRIVATE_KEY?.trim()),
      rpcUrl: env.BASE_SEPOLIA_RPC_URL?.trim() || DEFAULT_BASE_RPC_URL,
      amountWei: bigintEnv(env.BASE_FAUCET_ETH_WEI, DEFAULT_BASE_ETH_WEI),
    },
    solana: {
      configured: Boolean(env.SOLANA_FAUCET_SECRET_KEY?.trim()),
      rpcUrl: env.SOLANA_RPC_URL?.trim() || DEFAULT_SOLANA_RPC_URL,
      lamports: bigintEnv(env.SOLANA_FAUCET_LAMPORTS, DEFAULT_SOLANA_LAMPORTS),
    },
    near: { configured: true, helperUrl: env.NEAR_FAUCET_HELPER_URL?.trim() || DEFAULT_NEAR_HELPER_URL },
    cookieSecret: env.FAUCET_COOKIE_SECRET?.trim() || null,
  };
}

/** First line of an upstream error, long enough to be useful and never a secret. */
export function safeMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const line = text.split("\n")[0] ?? "";
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

/** Parses the Solana secret key from a JSON byte array or a base58 string (64 bytes). */
export function parseSolanaSecretKey(value: string): Uint8Array {
  const trimmed = value.trim();
  let bytes: Uint8Array;
  if (trimmed.startsWith("[")) {
    const parsed: unknown = JSON.parse(trimmed);
    if (!Array.isArray(parsed) || !parsed.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
      throw new Error("SOLANA_FAUCET_SECRET_KEY is not a byte array");
    }
    bytes = Uint8Array.from(parsed as number[]);
  } else {
    bytes = baseDecode(trimmed);
  }
  if (bytes.length !== 64) throw new Error("SOLANA_FAUCET_SECRET_KEY must be 64 bytes");
  return bytes;
}

type NearHelperOutcome = {
  transaction?: { hash?: string };
  status?: { SuccessValue?: string; Failure?: unknown };
  receipts_outcome?: { outcome?: { status?: { Failure?: unknown } } }[];
};

function describeFailure(failure: unknown): string {
  const text = JSON.stringify(failure);
  if (text.includes("AccountAlreadyExists")) return "That account id already exists; pick another one.";
  return `The NEAR helper reported a failure: ${text.slice(0, 160)}`;
}

/** Real senders backed by the server-side hot wallets; keys are read lazily on first use. */
export function createFaucetSenders(env: NodeJS.ProcessEnv, config: FaucetConfig = readFaucetConfig(env)): FaucetSenders {
  return {
    async sendBase(address) {
      const key = env.BASE_FAUCET_PRIVATE_KEY?.trim() as Hex | undefined;
      if (!key) throw new FaucetError("upstream", "The Base faucet is not configured.");
      const account = privateKeyToAccount(key.startsWith("0x") ? key : (`0x${key}` as Hex));
      const transport = http(config.base.rpcUrl);
      const publicClient = createPublicClient({ chain: baseSepolia, transport });
      const wallet = createWalletClient({ account, chain: baseSepolia, transport });
      const amount = config.base.amountWei;
      let balance: bigint;
      let fees: { maxFeePerGas?: bigint; gasPrice?: bigint };
      try {
        [balance, fees] = await Promise.all([publicClient.getBalance({ address: account.address }), publicClient.estimateFeesPerGas()]);
      } catch (error) {
        throw new FaucetError("upstream", `Base Sepolia RPC failed: ${safeMessage(error)}`);
      }
      const gasCost = 21_000n * (fees.maxFeePerGas ?? fees.gasPrice ?? 0n) * 2n;
      if (balance < amount + gasCost) {
        throw new FaucetError("faucet_dry", "The Base Sepolia faucet wallet is empty; ask the team to refill it.");
      }
      try {
        const txHash = await wallet.sendTransaction({ to: address, value: amount });
        return { txHash, amount: amount.toString() };
      } catch (error) {
        throw new FaucetError("upstream", `Base Sepolia transfer failed: ${safeMessage(error)}`);
      }
    },

    async sendSolana(address) {
      const raw = env.SOLANA_FAUCET_SECRET_KEY;
      if (!raw?.trim()) throw new FaucetError("upstream", "The Solana faucet is not configured.");
      const payer = Keypair.fromSecretKey(parseSolanaSecretKey(raw));
      const connection = new Connection(config.solana.rpcUrl, "confirmed");
      const lamports = config.solana.lamports;
      let balance: number;
      try {
        balance = await connection.getBalance(payer.publicKey, "confirmed");
      } catch (error) {
        throw new FaucetError("upstream", `Solana devnet RPC failed: ${safeMessage(error)}`);
      }
      if (BigInt(balance) < lamports + 10_000n) {
        throw new FaucetError("faucet_dry", "The Solana devnet faucet wallet is empty; ask the team to refill it.");
      }
      const transaction = new Transaction().add(
        SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: new PublicKey(address), lamports }),
      );
      try {
        const signature = await sendAndConfirmTransaction(connection, transaction, [payer], { commitment: "confirmed" });
        return { signature, amount: lamports.toString() };
      } catch (error) {
        throw new FaucetError("upstream", `Solana devnet transfer failed: ${safeMessage(error)}`);
      }
    },

    async createNearAccount(accountId, publicKey) {
      let response: Response;
      try {
        response = await fetch(config.near.helperUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ newAccountId: accountId, newAccountPublicKey: publicKey }),
        });
      } catch (error) {
        throw new FaucetError("upstream", `The NEAR faucet helper could not be reached: ${safeMessage(error)}`);
      }
      const text = await response.text();
      if (!response.ok) {
        const detail = text.trim().slice(0, 160);
        if (response.status === 400) throw new FaucetError("invalid_request", detail || "The NEAR faucet helper rejected the request.");
        throw new FaucetError("upstream", `The NEAR faucet helper answered HTTP ${response.status}${detail ? `: ${detail}` : ""}.`);
      }
      let outcome: NearHelperOutcome;
      try {
        outcome = JSON.parse(text) as NearHelperOutcome;
      } catch {
        throw new FaucetError("upstream", "The NEAR faucet helper did not return a transaction outcome.");
      }
      const txHash = outcome.transaction?.hash;
      if (!txHash) throw new FaucetError("upstream", "The NEAR faucet helper did not return a transaction hash.");
      const failure = outcome.status?.Failure ?? outcome.receipts_outcome?.find((r) => r.outcome?.status?.Failure)?.outcome?.status?.Failure;
      if (failure !== undefined) {
        const message = describeFailure(failure);
        throw new FaucetError(message.includes("already exists") ? "invalid_request" : "upstream", message);
      }
      return { txHash };
    },
  };
}
