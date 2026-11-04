/**
 * Keys of the demo cast, generated once into `~/.config/rose/seed-accounts.json` (mode 600) and
 * reused for every engine: a NEAR key per account, an EVM key per holder (payout recipient and,
 * for the KOL holder, the wallet that self-deposits a stream), a Solana key per Strategic Round
 * holder. The project keys (Base deployer, Solana ops) are read from `~/.config/rose` as the other
 * scripts do. Nothing here is ever printed.
 */

import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Keypair } from "@solana/web3.js";
import { KeyPair, type KeyPairString } from "near-api-js";
import { generatePrivateKey, privateKeyToAddress } from "viem/accounts";
import type { Address, Hex } from "viem";
import { CONFIG_DIR, readEnvFile } from "./env.ts";

interface KeyFile {
  near: Record<string, string>;
  evm: Record<string, string>;
  solana: Record<string, number[]>;
}

export const SEED_KEYS_FILE = join(CONFIG_DIR, "seed-accounts.json");

export class SeedKeys {
  private readonly file: KeyFile;

  constructor() {
    this.file = existsSync(SEED_KEYS_FILE) ? (JSON.parse(readFileSync(SEED_KEYS_FILE, "utf8")) as KeyFile) : { near: {}, evm: {}, solana: {} };
  }

  private save(): void {
    writeFileSync(SEED_KEYS_FILE, `${JSON.stringify(this.file, null, 2)}\n`, { mode: 0o600 });
    chmodSync(SEED_KEYS_FILE, 0o600);
  }

  /** The NEAR key of `accountId`, generated when missing. */
  near(accountId: string): { secretKey: KeyPairString; publicKey: string } {
    let secret = this.file.near[accountId];
    if (secret === undefined) {
      secret = KeyPair.fromRandom("ed25519").toString();
      this.file.near[accountId] = secret;
      this.save();
    }
    const secretKey = secret as KeyPairString;
    return { secretKey, publicKey: KeyPair.fromString(secretKey).getPublicKey().toString() };
  }

  evm(slug: string): { privateKey: Hex; address: Address } {
    let key = this.file.evm[slug];
    if (key === undefined) {
      key = generatePrivateKey();
      this.file.evm[slug] = key;
      this.save();
    }
    const privateKey = key as Hex;
    return { privateKey, address: privateKeyToAddress(privateKey) };
  }

  solana(slug: string): Keypair {
    let secret = this.file.solana[slug];
    if (secret === undefined) {
      secret = Array.from(Keypair.generate().secretKey);
      this.file.solana[slug] = secret;
      this.save();
    }
    return Keypair.fromSecretKey(Uint8Array.from(secret));
  }
}

/** The Base Sepolia deployer (`~/.config/rose/evm-deployer.env`): the Cindral treasury on Base. */
export function deployerKey(): Hex {
  const key = readEnvFile(join(CONFIG_DIR, "evm-deployer.env")).get("EVM_DEPLOYER_PRIVATE_KEY");
  if (key === undefined || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("EVM_DEPLOYER_PRIVATE_KEY missing in evm-deployer.env");
  return key as Hex;
}

/** The Solana ops key (`~/.config/rose/solana-ops.json`): the Cindral treasury on Solana devnet. */
export function opsKeypair(): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(join(CONFIG_DIR, "solana-ops.json"), "utf8")) as number[]));
}
