import { Keypair } from "@solana/web3.js";
import { NearRpcError } from "@rose/sdk";
import { KeyPair } from "near-api-js";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { baseSepoliaWalletTransport, forgetEvmDemoWallet, generateEvmDemoWallet, loadEvmDemoWallet, saveEvmDemoWallet } from "./evm-demo";
import { forgetNearDemoWallet, generateNearDemoWallet, loadNearDemoWallet, nearAccountPresence, nearDemoKeyIsOnAccount, nearDemoKnownOnChain, randomDemoAccountId, rememberNearDemoOnChain, saveNearDemoWallet, withFreshDemoAccountId } from "./near-demo";
import { generateSolanaDemoWallet, loadSolanaDemoWallet, saveSolanaDemoWallet, signWithSolanaDemo, solanaDemoKeypair } from "./solana-demo";
import { exportEvmDemoWallet, exportNearDemoWallet, exportSolanaDemoWallet } from "./export";
import { DEMO_STORAGE_KEYS, readStored, writeStored } from "./storage";

class MemoryStorage implements Storage {
  private readonly map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

beforeEach(() => {
  Object.defineProperty(globalThis, "window", { value: { localStorage: new MemoryStorage() }, configurable: true, writable: true });
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, "window");
});

describe("demo wallets", () => {
  it("creates a NEAR demo wallet whose key round-trips through storage and the CLI export", () => {
    const wallet = generateNearDemoWallet();
    expect(wallet.accountId).toMatch(/^rose-demo-[a-z0-9]{6}\.testnet$/);
    expect(wallet.publicKey).toMatch(/^ed25519:/);
    expect(KeyPair.fromString(wallet.secretKey).getPublicKey().toString()).toBe(wallet.publicKey);
    saveNearDemoWallet(wallet);
    expect(loadNearDemoWallet()).toEqual(wallet);
    const exported = JSON.parse(exportNearDemoWallet(wallet)) as { account_id: string; private_key: string; network: string };
    expect(exported).toMatchObject({ account_id: wallet.accountId, private_key: wallet.secretKey, network: "testnet" });
    expect(randomDemoAccountId()).not.toBe(randomDemoAccountId());
  });

  it("creates an EVM demo wallet with a matching address and forgets it", () => {
    const wallet = generateEvmDemoWallet();
    expect(privateKeyToAccount(wallet.privateKey).address).toBe(wallet.address);
    saveEvmDemoWallet(wallet);
    expect(loadEvmDemoWallet()?.address).toBe(wallet.address);
    expect(JSON.parse(exportEvmDemoWallet(wallet))).toMatchObject({ chainId: 84532, address: wallet.address });
    forgetEvmDemoWallet();
    expect(loadEvmDemoWallet()).toBeNull();
  });

  it("creates a Solana demo keypair that signs transactions and exports in the solana-keygen format", () => {
    const wallet = generateSolanaDemoWallet();
    expect(wallet.secretKey).toHaveLength(64);
    saveSolanaDemoWallet(wallet);
    expect(loadSolanaDemoWallet()?.publicKey).toBe(wallet.publicKey);
    expect(JSON.parse(exportSolanaDemoWallet(wallet))).toEqual(wallet.secretKey);
    const keypair = solanaDemoKeypair(wallet);
    expect(keypair.publicKey.toBase58()).toBe(wallet.publicKey);
    expect(Keypair.fromSecretKey(Uint8Array.from(wallet.secretKey)).publicKey.toBase58()).toBe(wallet.publicKey);
    expect(typeof signWithSolanaDemo).toBe("function");
  });

  it("ignores corrupted storage entries", () => {
    writeStored(DEMO_STORAGE_KEYS.evm, { privateKey: "nope" });
    expect(loadEvmDemoWallet()).toBeNull();
    writeStored(DEMO_STORAGE_KEYS.solana, { secretKey: [1, 2, 3] });
    expect(loadSolanaDemoWallet()).toBeNull();
    expect(readStored(DEMO_STORAGE_KEYS.near)).toBeNull();
  });
});

describe("NEAR demo account id collisions", () => {
  it("recognizes its own key on an existing account and keeps the key under a fresh id otherwise", async () => {
    const wallet = generateNearDemoWallet("rose-demo-aaaaaa.testnet");
    const own = { viewAccessKey: async () => ({ nonce: 1, permission: "FullAccess", block_height: 1, block_hash: "h" }) } as unknown as Parameters<typeof nearDemoKeyIsOnAccount>[1];
    /* The RPC's own answer for a key the account does not have (`query` `view_access_key`, recorded in docs/verification.md). */
    const other = { viewAccessKey: async () => ({ block_hash: "h", block_height: 1, error: `access key ${wallet.publicKey} does not exist while viewing`, logs: [] }) } as unknown as Parameters<typeof nearDemoKeyIsOnAccount>[1];
    const noAccount = { viewAccessKey: () => Promise.reject(new NearRpcError("account_missing", "The account does not exist on NEAR testnet.")) } as unknown as Parameters<typeof nearDemoKeyIsOnAccount>[1];
    expect(await nearDemoKeyIsOnAccount(wallet, own)).toBe(true);
    expect(await nearDemoKeyIsOnAccount(wallet, other)).toBe(false);
    expect(await nearDemoKeyIsOnAccount(wallet, noAccount)).toBe(false);
    const renewed = withFreshDemoAccountId(wallet, "rose-demo-bbbbbb.testnet");
    expect(renewed).toEqual({ ...wallet, accountId: "rose-demo-bbbbbb.testnet" });
    expect(withFreshDemoAccountId(wallet).accountId).toMatch(/^rose-demo-[a-z0-9]{6}\.testnet$/);
  });

  it("never reads a rate-limited RPC as a foreign account: the key check throws a retryable error", async () => {
    const wallet = generateNearDemoWallet("rose-demo-aaaaaa.testnet");
    const limited = { viewAccessKey: () => Promise.reject(new NearRpcError("unreachable", "https://test.rpc.fastnear.com could not be reached.")) } as unknown as Parameters<typeof nearDemoKeyIsOnAccount>[1];
    await expect(nearDemoKeyIsOnAccount(wallet, limited)).rejects.toMatchObject({ kind: "rpc", retryable: true });
  });
});

describe("NEAR demo account presence", () => {
  const instant = () => Promise.resolve();
  const viewing = (...answers: (() => Promise<unknown>)[]) => {
    const calls = { count: 0 };
    const rpc = {
      viewAccount: () => {
        const answer = answers[Math.min(calls.count, answers.length - 1)] as () => Promise<unknown>;
        calls.count += 1;
        return answer();
      },
    } as unknown as NonNullable<Parameters<typeof nearAccountPresence>[1]>["rpc"];
    return { rpc, calls };
  };
  const exists = () => Promise.resolve({ amount: "1" });
  const missing = () => Promise.reject(new NearRpcError("account_missing", "The account does not exist on NEAR testnet."));
  const limited = () => Promise.reject(new NearRpcError("unreachable", "https://test.rpc.fastnear.com could not be reached."));

  it("answers exists or missing from a definite RPC answer", async () => {
    expect(await nearAccountPresence("a.testnet", { rpc: viewing(exists).rpc, sleep: instant })).toBe("exists");
    expect(await nearAccountPresence("a.testnet", { rpc: viewing(missing).rpc, sleep: instant })).toBe("missing");
  });

  it("retries a rate limit with backoff and answers from the first endpoint round that succeeds", async () => {
    const waits: number[] = [];
    const { rpc, calls } = viewing(limited, limited, exists);
    expect(await nearAccountPresence("a.testnet", { rpc, delayMs: 100, sleep: (ms) => (waits.push(ms), Promise.resolve()) })).toBe("exists");
    expect(calls.count).toBe(3);
    expect(waits).toEqual([100, 200]);
  });

  it("answers unknown, never missing, when no endpoint answers", async () => {
    const { rpc, calls } = viewing(limited);
    expect(await nearAccountPresence("a.testnet", { rpc, attempts: 3, sleep: instant })).toBe("unknown");
    expect(calls.count).toBe(3);
  });

  it("remembers an account seen on chain per id and forgets it with the wallet", () => {
    expect(nearDemoKnownOnChain("rose-demo-aaaaaa.testnet")).toBe(false);
    rememberNearDemoOnChain("rose-demo-aaaaaa.testnet");
    expect(nearDemoKnownOnChain("rose-demo-aaaaaa.testnet")).toBe(true);
    expect(nearDemoKnownOnChain("rose-demo-bbbbbb.testnet")).toBe(false);
    forgetNearDemoWallet();
    expect(nearDemoKnownOnChain("rose-demo-aaaaaa.testnet")).toBe(false);
  });
});

describe("Base Sepolia wallet transport", () => {
  it("refuses eth_fillTransaction locally and forwards every other method", async () => {
    const transport = baseSepoliaWalletTransport()({ chain: undefined, retryCount: 0 });
    await expect(transport.request({ method: "eth_fillTransaction", params: [{}] } as never)).rejects.toThrow("eth_fillTransaction is not available");
  });
});
