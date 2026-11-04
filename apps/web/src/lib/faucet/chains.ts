import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, actions, baseDecode, type KeyPairString } from "near-api-js";
import { createPublicClient, createWalletClient, formatEther, http, nonceManager, parseEther, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { capRefusal, type SendCaps, type SendUsage } from "./guards";
import { nearAccountExists, nearRpcCall, readBaseUsage, readNearKeyUsage, readSolanaUsage } from "./ledger";

export const DEFAULT_BASE_RPC_URL = "https://sepolia.base.org";
export const DEFAULT_SOLANA_RPC_URL = "https://api.devnet.solana.com";
export const DEFAULT_NEAR_HELPER_URL = "https://helper.nearprotocol.com/account";
/** 0.002 ETH: a few dozen Base Sepolia transactions. */
export const DEFAULT_BASE_ETH_WEI = parseEther("0.002");
/** 0.05 SOL: rent for a nonce account plus many transaction fees. */
export const DEFAULT_SOLANA_LAMPORTS = BigInt(LAMPORTS_PER_SOL) / 20n;
/** What the NEAR testnet helper funds a new account with (measured 2026-11-04). */
export const NEAR_HELPER_FUNDING = "10 NEAR";
/** FastNEAR, the RPC the app reads from; `rpc.testnet.near.org` answers -429 "deprecated" under load (2026-11-04). */
export const DEFAULT_NEAR_RPC_URL = "https://test.rpc.fastnear.com";
/**
 * 1 NEAR when the funder account creates the account: storage deposits of every demo flow plus
 * the up-front pessimistic cost of prepaid gas (about 0.2 NEAR for a 200 Tgas opening).
 */
export const DEFAULT_NEAR_FUNDER_YOCTO = 1_000_000_000_000_000_000_000_000n;
/** The testnet registrar: `create_account(new_account_id, new_public_key)` creates a top-level `.testnet` account funded by the attached deposit. */
export const NEAR_TESTNET_REGISTRAR = "testnet";
const NEAR_CREATE_ACCOUNT_GAS = 30_000_000_000_000n;
/** Keeps the funder account above its own storage and gas needs. */
const NEAR_FUNDER_RESERVE_YOCTO = 100_000_000_000_000_000_000_000n;

/**
 * Sends per hot wallet for everyone together, per rolling hour and day, sized on the live budgets
 * of 2026-11-04 (Base 0.046 ETH at 0.002 a send, Solana 0.4 SOL at 0.05, NEAR funder 12 NEAR at 1)
 * so a day of abuse leaves the wallets able to serve the next day. The NEAR caps apply to the
 * funder fallback only; the public helper spends its own funds under its own limits.
 */
export const DEFAULT_CAPS = {
  base: { hourly: 5, daily: 15 },
  solana: { hourly: 3, daily: 6 },
  near: { hourly: 3, daily: 6 },
} as const satisfies Record<string, SendCaps>;

export class FaucetError extends Error {
  constructor(
    readonly code: "faucet_dry" | "upstream" | "invalid_request" | "rate_limited" | "already_funded",
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "FaucetError";
  }
}

/** The chain senders the handler depends on; the route test mocks this interface. */
export interface FaucetSenders {
  sendBase(address: `0x${string}`): Promise<{ txHash: string; amount: string }>;
  sendSolana(address: string): Promise<{ signature: string; amount: string }>;
  /** `amount` is what the new account received, as a label (`10 NEAR`, `0.5 NEAR`). */
  createNearAccount(accountId: string, publicKey: string): Promise<{ txHash: string; amount: string }>;
}

export type FaucetConfig = {
  base: { configured: boolean; rpcUrl: string; amountWei: bigint; caps: SendCaps };
  solana: { configured: boolean; rpcUrl: string; lamports: bigint; caps: SendCaps };
  /**
   * The public helper is tried first; when it is rate limited or down and a funder account is
   * configured (`NEAR_FAUCET_ACCOUNT_ID` + `NEAR_FAUCET_PRIVATE_KEY`), the funder creates the
   * account through the testnet registrar instead, within `funderCaps`.
   */
  near: { configured: boolean; helperUrl: string; rpcUrl: string; funderAccountId: string | null; funderYocto: bigint; funderCaps: SendCaps };
  cookieSecret: string | null;
};

function bigintEnv(value: string | undefined, fallback: bigint): bigint {
  const trimmed = value?.trim();
  return trimmed && /^\d+$/.test(trimmed) ? BigInt(trimmed) : fallback;
}

/** `<PREFIX>_HOURLY_CAP` and `<PREFIX>_DAILY_CAP`, whole numbers, defaulting to `fallback`. */
function capsEnv(env: NodeJS.ProcessEnv, prefix: string, fallback: SendCaps): SendCaps {
  const read = (name: string, value: number) => {
    const raw = env[`${prefix}_${name}`]?.trim();
    return raw && /^\d+$/.test(raw) ? Number(raw) : value;
  };
  return { hourly: read("HOURLY_CAP", fallback.hourly), daily: read("DAILY_CAP", fallback.daily) };
}

/** Reads the faucet configuration; only presence is kept for the keys, their values stay in the senders. */
export function readFaucetConfig(env: NodeJS.ProcessEnv): FaucetConfig {
  return {
    base: {
      configured: Boolean(env.BASE_FAUCET_PRIVATE_KEY?.trim()),
      rpcUrl: env.BASE_SEPOLIA_RPC_URL?.trim() || DEFAULT_BASE_RPC_URL,
      amountWei: bigintEnv(env.BASE_FAUCET_ETH_WEI, DEFAULT_BASE_ETH_WEI),
      caps: capsEnv(env, "BASE_FAUCET", DEFAULT_CAPS.base),
    },
    solana: {
      configured: Boolean(env.SOLANA_FAUCET_SECRET_KEY?.trim()),
      rpcUrl: env.SOLANA_RPC_URL?.trim() || DEFAULT_SOLANA_RPC_URL,
      lamports: bigintEnv(env.SOLANA_FAUCET_LAMPORTS, DEFAULT_SOLANA_LAMPORTS),
      caps: capsEnv(env, "SOLANA_FAUCET", DEFAULT_CAPS.solana),
    },
    near: {
      configured: true,
      helperUrl: env.NEAR_FAUCET_HELPER_URL?.trim() || DEFAULT_NEAR_HELPER_URL,
      rpcUrl: env.NEAR_RPC_URL?.trim() || DEFAULT_NEAR_RPC_URL,
      funderAccountId: env.NEAR_FAUCET_ACCOUNT_ID?.trim() && env.NEAR_FAUCET_PRIVATE_KEY?.trim() ? env.NEAR_FAUCET_ACCOUNT_ID.trim() : null,
      funderYocto: bigintEnv(env.NEAR_FAUCET_YOCTO, DEFAULT_NEAR_FUNDER_YOCTO),
      funderCaps: capsEnv(env, "NEAR_FAUCET", DEFAULT_CAPS.near),
    },
    cookieSecret: env.FAUCET_COOKIE_SECRET?.trim() || null,
  };
}

/** First line of an upstream error, long enough to be useful and never a secret. */
export function safeMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const line = text.split("\n")[0] ?? "";
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

function durationLabel(seconds: number): string {
  if (seconds < 3600) {
    const minutes = Math.max(1, Math.ceil(seconds / 60));
    return `${String(minutes)} minute${minutes === 1 ? "" : "s"}`;
  }
  const hours = Math.ceil(seconds / 3600);
  return `${String(hours)} hour${hours === 1 ? "" : "s"}`;
}

/** Throws `rate_limited` when the hot wallet's own history shows a full hourly or daily cap. */
export function enforceCaps(label: string, usage: SendUsage, caps: SendCaps, nowSeconds: number): void {
  const refusal = capRefusal(usage, caps, nowSeconds);
  if (refusal === null) return;
  throw new FaucetError(
    "rate_limited",
    `The ${label} faucet reached its limit of ${String(refusal.cap)} sends per ${refusal.window} for all visitors. Try again in about ${durationLabel(refusal.retryAfterSeconds)}.`,
    refusal.retryAfterSeconds,
  );
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

/** `0.5 NEAR` from yoctoNEAR, trimmed to at most 3 decimals. */
export function nearAmountLabel(yocto: bigint): string {
  const milli = yocto / 10n ** 21n;
  const whole = milli / 1000n;
  const fraction = (milli % 1000n).toString().padStart(3, "0").replace(/0+$/, "");
  return `${whole.toString()}${fraction ? `.${fraction}` : ""} NEAR`;
}

type NearOutcomeStatus = { SuccessValue?: string; Failure?: unknown };

function describeFailure(failure: unknown): string {
  const text = JSON.stringify(failure);
  if (text.includes("AccountAlreadyExists")) return "That account id already exists; pick another one.";
  return `The NEAR helper reported a failure: ${text.slice(0, 160)}`;
}

/** Upstream answers meaning another sender (another instance) used the same Base nonce first. */
const NONCE_CONFLICT = /nonce too low|lower than the current nonce|replacement transaction underpriced|already known|nonce has already been used/i;

/** Real senders backed by the server-side hot wallets; keys are read lazily on first use. */
export function createFaucetSenders(env: NodeJS.ProcessEnv, config: FaucetConfig = readFaucetConfig(env), now: () => number = () => Date.now()): FaucetSenders {
  return {
    async sendBase(address) {
      const key = env.BASE_FAUCET_PRIVATE_KEY?.trim() as Hex | undefined;
      if (!key) throw new FaucetError("upstream", "The Base faucet is not configured.");
      /* The module-level nonce manager hands out consecutive nonces on this instance even when the RPC's pending count lags. */
      const account = privateKeyToAccount(key.startsWith("0x") ? key : (`0x${key}` as Hex), { nonceManager });
      const transport = http(config.base.rpcUrl);
      const publicClient = createPublicClient({ chain: baseSepolia, transport });
      const wallet = createWalletClient({ account, chain: baseSepolia, transport });
      const amount = config.base.amountWei;
      const nowSeconds = Math.floor(now() / 1000);
      let held: bigint;
      let balance: bigint;
      let fees: { maxFeePerGas?: bigint; gasPrice?: bigint };
      let usage: SendUsage;
      try {
        [held, balance, fees, usage] = await Promise.all([
          publicClient.getBalance({ address }),
          publicClient.getBalance({ address: account.address }),
          publicClient.estimateFeesPerGas(),
          readBaseUsage({ getBlock: (args) => publicClient.getBlock(args), getTransactionCount: (args) => publicClient.getTransactionCount(args) }, account.address, nowSeconds),
        ]);
      } catch (error) {
        throw new FaucetError("upstream", `Base Sepolia RPC failed: ${safeMessage(error)}`);
      }
      if (held >= amount) {
        throw new FaucetError("already_funded", `This address already holds ${formatEther(held)} ETH on Base Sepolia, at least what the faucet sends. The faucet only tops up empty wallets.`);
      }
      enforceCaps("Base Sepolia", usage, config.base.caps, nowSeconds);
      const gasCost = 21_000n * (fees.maxFeePerGas ?? fees.gasPrice ?? 0n) * 2n;
      if (balance < amount + gasCost) {
        throw new FaucetError("faucet_dry", "The Base Sepolia faucet wallet is empty; ask the team to refill it.");
      }
      for (let attempt = 0; ; attempt += 1) {
        try {
          const txHash = await wallet.sendTransaction({ to: address, value: amount });
          return { txHash, amount: amount.toString() };
        } catch (error) {
          const message = safeMessage(error);
          /* viem keeps the node's own words in the details lines of its message. */
          if (attempt === 0 && error instanceof Error && NONCE_CONFLICT.test(error.message)) {
            nonceManager.reset({ address: account.address, chainId: baseSepolia.id });
            continue;
          }
          throw new FaucetError("upstream", `Base Sepolia transfer failed: ${message}`);
        }
      }
    },

    async sendSolana(address) {
      const raw = env.SOLANA_FAUCET_SECRET_KEY;
      if (!raw?.trim()) throw new FaucetError("upstream", "The Solana faucet is not configured.");
      const payer = Keypair.fromSecretKey(parseSolanaSecretKey(raw));
      const connection = new Connection(config.solana.rpcUrl, "confirmed");
      const lamports = config.solana.lamports;
      const recipient = new PublicKey(address);
      const nowSeconds = Math.floor(now() / 1000);
      const caps = config.solana.caps;
      let held: number;
      let balance: number;
      let usage: SendUsage;
      try {
        [held, balance, usage] = await Promise.all([
          connection.getBalance(recipient, "confirmed"),
          connection.getBalance(payer.publicKey, "confirmed"),
          readSolanaUsage(connection, payer.publicKey, nowSeconds, Math.max(caps.hourly, caps.daily) + 1),
        ]);
      } catch (error) {
        throw new FaucetError("upstream", `Solana devnet RPC failed: ${safeMessage(error)}`);
      }
      if (BigInt(held) >= lamports) {
        throw new FaucetError("already_funded", `This address already holds ${(held / LAMPORTS_PER_SOL).toString()} SOL on devnet, at least what the faucet sends. The faucet only tops up empty wallets.`);
      }
      enforceCaps("Solana devnet", usage, caps, nowSeconds);
      if (BigInt(balance) < lamports + 10_000n) {
        throw new FaucetError("faucet_dry", "The Solana devnet faucet wallet is empty; ask the team to refill it.");
      }
      const transaction = new Transaction().add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: recipient, lamports }));
      try {
        const signature = await sendAndConfirmTransaction(connection, transaction, [payer], { commitment: "confirmed" });
        return { signature, amount: lamports.toString() };
      } catch (error) {
        throw new FaucetError("upstream", `Solana devnet transfer failed: ${safeMessage(error)}`);
      }
    },

    async createNearAccount(accountId, publicKey) {
      const call = nearRpcCall(config.near.rpcUrl);
      let exists: boolean;
      try {
        exists = await nearAccountExists(call, accountId);
      } catch (error) {
        throw new FaucetError("upstream", `NEAR testnet RPC failed: ${safeMessage(error)}`);
      }
      if (exists) throw new FaucetError("invalid_request", "That account id already exists; pick another one.");
      const helper = await createWithHelper(config.near.helperUrl, accountId, publicKey);
      if (helper.ok) return { txHash: helper.txHash, amount: NEAR_HELPER_FUNDING };
      const key = env.NEAR_FAUCET_PRIVATE_KEY?.trim();
      if (!helper.fallback || !config.near.funderAccountId || !key) throw helper.error;
      return createWithFunder(config.near, key as KeyPairString, accountId, publicKey, Math.floor(now() / 1000));
    },
  };
}

type HelperResult = { ok: true; txHash: string } | { ok: false; error: FaucetError; fallback: boolean };

/** The public helper near-cli-rs uses; `fallback` marks failures the funder account can work around. */
async function createWithHelper(helperUrl: string, accountId: string, publicKey: string): Promise<HelperResult> {
  let response: Response;
  try {
    response = await fetch(helperUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ newAccountId: accountId, newAccountPublicKey: publicKey }),
    });
  } catch (error) {
    return { ok: false, fallback: true, error: new FaucetError("upstream", `The NEAR faucet helper could not be reached: ${safeMessage(error)}`) };
  }
  const text = await response.text();
  if (!response.ok) {
    const detail = text.trim().slice(0, 160);
    if (response.status === 400) return { ok: false, fallback: false, error: new FaucetError("invalid_request", detail || "The NEAR faucet helper rejected the request.") };
    return { ok: false, fallback: true, error: new FaucetError("upstream", `The NEAR faucet helper answered HTTP ${response.status}${detail ? `: ${detail}` : ""}.`) };
  }
  let outcome: NearHelperOutcome;
  try {
    outcome = JSON.parse(text) as NearHelperOutcome;
  } catch {
    return { ok: false, fallback: true, error: new FaucetError("upstream", "The NEAR faucet helper did not return a transaction outcome.") };
  }
  const txHash = outcome.transaction?.hash;
  if (!txHash) return { ok: false, fallback: true, error: new FaucetError("upstream", "The NEAR faucet helper did not return a transaction hash.") };
  const failure = outcome.status?.Failure ?? outcome.receipts_outcome?.find((r) => r.outcome?.status?.Failure)?.outcome?.status?.Failure;
  if (failure !== undefined) {
    const message = describeFailure(failure);
    return { ok: false, fallback: false, error: new FaucetError(message.includes("already exists") ? "invalid_request" : "upstream", message) };
  }
  return { ok: true, txHash };
}

/** Creates `accountId` from the funder account through the testnet registrar, funded with `funderYocto`, within the funder caps. */
async function createWithFunder(near: FaucetConfig["near"], key: KeyPairString, accountId: string, publicKey: string, nowSeconds: number): Promise<{ txHash: string; amount: string }> {
  const funderId = near.funderAccountId!;
  const provider = new JsonRpcProvider({ url: near.rpcUrl });
  let signer: KeyPairSigner;
  let funderPublicKey: string;
  try {
    signer = KeyPairSigner.fromSecretKey(key);
    funderPublicKey = KeyPair.fromString(key).getPublicKey().toString();
  } catch {
    throw new FaucetError("upstream", "NEAR_FAUCET_PRIVATE_KEY is not an ed25519 secret key.");
  }
  const funder = new Account(funderId, provider, signer);
  let balance: bigint;
  let usage: SendUsage;
  try {
    [balance, usage] = await Promise.all([funder.getBalance() as Promise<bigint>, readNearKeyUsage(nearRpcCall(near.rpcUrl), funderId, funderPublicKey, nowSeconds)]);
  } catch (error) {
    throw new FaucetError("upstream", `NEAR testnet RPC failed: ${safeMessage(error)}`);
  }
  enforceCaps("NEAR testnet", usage, near.funderCaps, nowSeconds);
  if (balance < near.funderYocto + NEAR_FUNDER_RESERVE_YOCTO) {
    throw new FaucetError("faucet_dry", "The NEAR faucet helper is rate limited and the NEAR funder account is empty; ask the team to refill it.");
  }
  let outcome: { transaction: { hash: string }; status: NearOutcomeStatus | string; receipts_outcome?: { outcome?: { status?: NearOutcomeStatus | string } }[] };
  try {
    outcome = (await funder.signAndSendTransaction({
      receiverId: NEAR_TESTNET_REGISTRAR,
      actions: [actions.functionCall("create_account", { new_account_id: accountId, new_public_key: publicKey }, NEAR_CREATE_ACCOUNT_GAS, near.funderYocto)],
      waitUntil: "FINAL",
      throwOnFailure: false,
    })) as unknown as typeof outcome;
  } catch (error) {
    throw new FaucetError("upstream", `The NEAR account creation failed: ${safeMessage(error)}`);
  }
  const status = typeof outcome.status === "object" ? outcome.status : {};
  const failure = status.Failure ?? outcome.receipts_outcome?.map((r) => r.outcome?.status).find((s): s is NearOutcomeStatus => typeof s === "object" && s.Failure !== undefined)?.Failure;
  if (failure !== undefined) throw new FaucetError("upstream", describeFailure(failure));
  // The registrar returns `false` (and refunds the deposit) when the account could not be created.
  const created = status.SuccessValue !== undefined && Buffer.from(status.SuccessValue, "base64").toString("utf8") === "true";
  if (!created) throw new FaucetError("invalid_request", "That account id already exists or is invalid; pick another one.");
  return { txHash: outcome.transaction.hash, amount: nearAmountLabel(near.funderYocto) };
}
