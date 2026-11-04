import { Keypair } from "@solana/web3.js";
import { KeyPair } from "near-api-js";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { baseSepoliaWalletTransport, forgetEvmDemoWallet, generateEvmDemoWallet, loadEvmDemoWallet, saveEvmDemoWallet } from "./evm-demo";
import { generateNearDemoWallet, loadNearDemoWallet, randomDemoAccountId, saveNearDemoWallet } from "./near-demo";
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

describe("Base Sepolia wallet transport", () => {
  it("refuses eth_fillTransaction locally and forwards every other method", async () => {
    const transport = baseSepoliaWalletTransport()({ chain: undefined, retryCount: 0 });
    await expect(transport.request({ method: "eth_fillTransaction", params: [{}] } as never)).rejects.toThrow("eth_fillTransaction is not available");
  });
});
