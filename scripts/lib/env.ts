/**
 * Paths, endpoints and the deployment a script targets. Testnet only: NEAR testnet, Base Sepolia,
 * Solana devnet. The deployment comes from an engine env file (`deployments/<engine>.env`, the
 * `NEXT_PUBLIC_*` snippet `deploy-engine.sh` writes), so nothing engine-specific is hardcoded.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BASE_SEPOLIA_RPC, NEAR_TESTNET_RPC, NEAR_TESTNET_RPC_FALLBACK, SOLANA_DEVNET_RPC } from "@rose/sdk";
import type { Address } from "viem";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const CONFIG_DIR = process.env.ROSE_CONFIG_DIR ?? join(homedir(), ".config", "rose");
export const NEAR_CREDENTIALS_DIR = join(homedir(), ".near-credentials", "testnet");

export const NEAR_RPC_ENDPOINTS: readonly string[] = [process.env.NEAR_RPC_URL ?? NEAR_TESTNET_RPC, NEAR_TESTNET_RPC_FALLBACK];
export const BASE_RPC = process.env.BASE_SEPOLIA_RPC_URL ?? BASE_SEPOLIA_RPC;
export const SOLANA_RPC = process.env.SOLANA_RPC_URL ?? SOLANA_DEVNET_RPC;
export const NEAR_CASH_TOKEN = "tusdc.rose-app.testnet";
export const DEFAULT_ENV_FILE = "deployments/engine-v2.rose-app.testnet.env";

export function nearTxUrl(hash: string): string {
  return `https://testnet.near.rocks/tx/${hash}`;
}

export function log(message: string): void {
  process.stderr.write(`${message}\n`);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

/** The engine and the Base contracts a run targets. */
export interface Deployment {
  envFile: string;
  engine: string;
  roseVault: Address;
  baseTusdc: Address;
  demoToken: Address;
  demoFaucet: Address;
}

/** `KEY=value` lines of an env file (comments and blank lines ignored). */
export function readEnvFile(path: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) values.set(match[1], match[2].replace(/^"(.*)"$/, "$1"));
  }
  return values;
}

function address(values: Map<string, string>, key: string, file: string): Address {
  const value = values.get(key);
  if (value === undefined || !/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error(`${file}: ${key} is missing or not an address`);
  return value.toLowerCase() as Address;
}

export function loadDeployment(envFile: string): Deployment {
  const path = isAbsolute(envFile) ? envFile : join(ROOT, envFile);
  if (!existsSync(path)) throw new Error(`env file ${path} not found`);
  const values = readEnvFile(path);
  const engine = values.get("NEXT_PUBLIC_ENGINE_ACCOUNT");
  if (engine === undefined || engine === "") throw new Error(`${path}: NEXT_PUBLIC_ENGINE_ACCOUNT is missing`);
  return {
    envFile: path,
    engine,
    roseVault: address(values, "NEXT_PUBLIC_ROSE_VAULT_ADDRESS", path),
    baseTusdc: address(values, "NEXT_PUBLIC_BASE_TUSDC_ADDRESS", path),
    demoToken: address(values, "NEXT_PUBLIC_DEMO_TOKEN_ADDRESS", path),
    demoFaucet: address(values, "NEXT_PUBLIC_DEMO_STREAM_FAUCET_ADDRESS", path),
  };
}

/** `<step> [--flag value]...`: the positional step and the flags. */
export interface Args {
  step: string;
  flags: Map<string, string>;
}

export function parseArgs(argv: readonly string[], usage: string): Args {
  const flags = new Map<string, string>();
  let step: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg.startsWith("--")) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${arg} needs a value\n${usage}`);
      flags.set(arg.slice(2), value);
      i += 1;
    } else if (step === undefined) {
      step = arg;
    } else {
      throw new Error(`unexpected argument ${arg}\n${usage}`);
    }
  }
  return { step: step ?? "all", flags };
}

export function numberFlag(args: Args, name: string, fallback: number): number {
  const raw = args.flags.get(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`--${name} must be a positive number`);
  return value;
}
