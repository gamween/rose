/**
 * The single source of deployed addresses for the web app, read from `NEXT_PUBLIC_*` variables
 * (documented in `apps/web/.env.example`). Every value is optional: an unset variable gives a
 * clear "not deployed" state instead of a fake address. The docs pages map these keys to their
 * `{{PLACEHOLDER}}` names in `components/docs/deployment.ts`.
 */

/**
 * FastNEAR, the primary NEAR testnet endpoint (spec section 6) and the only public one that holds
 * a transaction wait without cutting it (`tx` with `wait_until`, measured; `send_tx` inferred from
 * it): the demo wallet sends through it. It answers about 30 requests per IP, then HTTP 429 without CORS headers
 * (`rpc.testnet.fastnear.com` shares the same limit), so reads fall over to the endpoints below.
 */
export const NEAR_RPC_URL = "https://test.rpc.fastnear.com";
/**
 * dRPC's public NEAR testnet endpoint: CORS headers on every answer, no limit reached at 80
 * parallel requests. Reads only: its free plan cuts waits after 2 s (HTTP 408), so wallets never
 * send through it (docs/verification.md, "NEAR RPC endpoints").
 */
export const NEAR_RPC_READ_FALLBACK_URL = "https://near-testnet.drpc.org";
/**
 * Intear's public testnet RPC, the last resort of reads: CORS headers, slowed by about a second
 * per request without an API key, and a transaction wait never answers. `rpc.testnet.near.org`
 * is not in the list: it is deprecated, and on 2026-11-14 it answered "THIS ENDPOINT IS DEPRECATED"
 * with HTTP 429 and no CORS headers before answering again, about 3 s per request, later that day.
 */
export const NEAR_RPC_READ_LAST_RESORT_URL = "https://testnet-rpc.intea.rs";
/** Failover order of every read-only NEAR client of the app: one list, so identical reads in flight share one round trip. */
export const NEAR_READ_RPC_ENDPOINTS: readonly string[] = [NEAR_RPC_URL, NEAR_RPC_READ_FALLBACK_URL, NEAR_RPC_READ_LAST_RESORT_URL];
export const BASE_SEPOLIA_RPC_URL = "https://sepolia.base.org";
/** Base Sepolia chain id, as `@rose/sdk` declares it; kept here so SDK-free modules can name the chain. */
export const BASE_SEPOLIA_CHAIN_ID = 84532;
export const SOLANA_DEVNET_RPC_URL = "https://api.devnet.solana.com";
export const MPC_ACCOUNT = "v1.signer-prod.testnet";
export const SABLIER_LOCKUP_ADDRESS = "0xA65A1ecEf02C2B9BDc604951c6A6D02335D4532e" as const;
export const STREAMFLOW_PROGRAM_ID = "HqDGZjaVRXJ9MGRQEw7qDc2rAr6iH1n1kAQdCZaCMfMZ";
export const NEAR_TUSDC_ACCOUNT = "tusdc.rose-app.testnet";
export const CIRCLE_USDC_BASE_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;

export type DeploymentKey =
  | "engineAccount"
  | "roseVault"
  | "baseTestUsdc"
  | "demoToken"
  | "demoStreamFaucet"
  | "solanaVault"
  | "solanaGasPayer"
  | "solanaDemoMint";

export type DeploymentEntry = {
  key: DeploymentKey;
  /** `NEXT_PUBLIC_*` variable name. */
  env: string;
  label: string;
  chain: "near" | "base" | "solana";
  value: string | null;
};

/**
 * `process.env.NEXT_PUBLIC_*` must be read with literal member access so Next.js can inline the
 * values into the client bundle at build time.
 */
function read(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

const RAW: Record<DeploymentKey, Omit<DeploymentEntry, "key">> = {
  engineAccount: {
    env: "NEXT_PUBLIC_ENGINE_ACCOUNT",
    label: "rose-engine (NEAR testnet)",
    chain: "near",
    value: read(process.env.NEXT_PUBLIC_ENGINE_ACCOUNT),
  },
  roseVault: {
    env: "NEXT_PUBLIC_ROSE_VAULT_ADDRESS",
    label: "RoseVault (Base Sepolia)",
    chain: "base",
    value: read(process.env.NEXT_PUBLIC_ROSE_VAULT_ADDRESS),
  },
  baseTestUsdc: {
    env: "NEXT_PUBLIC_BASE_TUSDC_ADDRESS",
    label: "Test USDC (Base Sepolia)",
    chain: "base",
    value: read(process.env.NEXT_PUBLIC_BASE_TUSDC_ADDRESS),
  },
  demoToken: {
    env: "NEXT_PUBLIC_DEMO_TOKEN_ADDRESS",
    label: "Demo token (Base Sepolia)",
    chain: "base",
    value: read(process.env.NEXT_PUBLIC_DEMO_TOKEN_ADDRESS),
  },
  demoStreamFaucet: {
    env: "NEXT_PUBLIC_DEMO_STREAM_FAUCET_ADDRESS",
    label: "DemoStreamFaucet (Base Sepolia)",
    chain: "base",
    value: read(process.env.NEXT_PUBLIC_DEMO_STREAM_FAUCET_ADDRESS),
  },
  solanaVault: {
    env: "NEXT_PUBLIC_SOLANA_VAULT_ADDRESS",
    label: "Engine vault (Solana devnet, path vault/sol)",
    chain: "solana",
    value: read(process.env.NEXT_PUBLIC_SOLANA_VAULT_ADDRESS),
  },
  solanaGasPayer: {
    env: "NEXT_PUBLIC_SOLANA_GAS_PAYER_ADDRESS",
    label: "Engine gas payer (Solana devnet, path gas/sol)",
    chain: "solana",
    value: read(process.env.NEXT_PUBLIC_SOLANA_GAS_PAYER_ADDRESS),
  },
  solanaDemoMint: {
    env: "NEXT_PUBLIC_SOLANA_DEMO_MINT",
    label: "Demo token mint (Solana devnet)",
    chain: "solana",
    value: read(process.env.NEXT_PUBLIC_SOLANA_DEMO_MINT),
  },
};

export const DEPLOYMENT: readonly DeploymentEntry[] = (Object.keys(RAW) as DeploymentKey[]).map((key) => ({ key, ...RAW[key] }));

/** The deployed value of `key`, or null while it is not deployed. */
export function deployed(key: DeploymentKey): string | null {
  return RAW[key].value;
}

/** Deployed EVM address typed for viem, or null. */
export function deployedAddress(key: "roseVault" | "baseTestUsdc" | "demoToken" | "demoStreamFaucet"): `0x${string}` | null {
  const value = RAW[key].value;
  return value && /^0x[0-9a-fA-F]{40}$/.test(value) ? (value as `0x${string}`) : null;
}

/** Entries still missing, so the UI can say exactly what is not deployed. */
export function missingDeployments(): DeploymentEntry[] {
  return DEPLOYMENT.filter((entry) => entry.value === null);
}

export function isDeployed(...keys: DeploymentKey[]): boolean {
  return keys.every((key) => RAW[key].value !== null);
}
