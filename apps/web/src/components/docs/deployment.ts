import {
  CIRCLE_USDC_BASE_SEPOLIA,
  deployed,
  MPC_ACCOUNT,
  NEAR_TUSDC_ACCOUNT,
  SABLIER_LOCKUP_ADDRESS,
  STREAMFLOW_PROGRAM_ID,
  type DeploymentKey as LibDeploymentKey,
} from "@/lib/deployment";

/**
 * Deployed addresses as the docs sources name them (`{{ENGINE_ACCOUNT}}`, `{{ROSE_VAULT}}`, ...),
 * read from `lib/deployment.ts`. A `null` value means the contract is not deployed yet; pages show
 * that state instead of an empty string.
 */

export const DEPLOYMENT_KEYS = [
  "ENGINE_ACCOUNT",
  "ROSE_VAULT",
  "BASE_TUSDC",
  "DEMO_TOKEN",
  "DEMO_STREAM_FAUCET",
  "SOLANA_VAULT",
  "SOLANA_GAS_PAYER",
] as const;

export type DeploymentKey = (typeof DEPLOYMENT_KEYS)[number];

export type Deployment = Record<DeploymentKey, string | null>;

const SOURCE: Record<DeploymentKey, LibDeploymentKey> = {
  ENGINE_ACCOUNT: "engineAccount",
  ROSE_VAULT: "roseVault",
  BASE_TUSDC: "baseTestUsdc",
  DEMO_TOKEN: "demoToken",
  DEMO_STREAM_FAUCET: "demoStreamFaucet",
  SOLANA_VAULT: "solanaVault",
  SOLANA_GAS_PAYER: "solanaGasPayer",
};

/** Every deployed address, or `null` where the deployment has not happened yet. */
export function readDeployment(): Deployment {
  return Object.fromEntries(DEPLOYMENT_KEYS.map((key) => [key, deployed(SOURCE[key])])) as Deployment;
}

/** Fixed testnet addresses that are not part of the rose deployment. */
export const FIXED_ADDRESSES = {
  nearTusdc: NEAR_TUSDC_ACCOUNT,
  mpcContract: MPC_ACCOUNT,
  sablierLockup: SABLIER_LOCKUP_ADDRESS,
  circleUsdcBase: CIRCLE_USDC_BASE_SEPOLIA,
  streamflowProgram: STREAMFLOW_PROGRAM_ID,
} as const;
