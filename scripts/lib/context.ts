/**
 * Everything a seed or end-to-end run needs for one engine: the deployment, the journals, the cast
 * with its keys and signers, and clients for the three chains.
 */

import { join } from "node:path";
import { Connection, PublicKey, type Keypair } from "@solana/web3.js";
import { createWalletClient, http, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepoliaChain, createBaseClient, EngineCalls, type ConfigView, type EngineViews, type SignerClient } from "@rose/sdk";
import { BASE_RPC, CONFIG_DIR, loadDeployment, ROOT, SOLANA_RPC, type Deployment } from "./env.ts";
import { accountOf, CAST, identityJournalPath, ROOT_ACCOUNT, type Who } from "./identity.ts";
import { Journal } from "./journal.ts";
import { deployerKey, opsKeypair, SeedKeys } from "./keys.ts";
import { engineViews, keychainActor, NearActor, withRetry } from "./near.ts";

export interface Context {
  deployment: Deployment;
  engine: string;
  views: EngineViews;
  calls: EngineCalls;
  config: ConfigView;
  derived: { vaultBase: Address; vaultSol: PublicKey; gasSol: PublicKey };
  /** Engine-independent identity: accounts, addresses, the devnet mint. */
  identity: Journal;
  /** Public record of this engine's seed (`deployments/e2e/<engine>.seed.json`). */
  seed: Journal;
  /** Public record of this engine's end-to-end proofs (`deployments/e2e/<engine>.live.json`). */
  live: Journal;
  /** Sealed orders before they are opened (outside the repository, mode 600). */
  secrets: Journal;
  keys: SeedKeys;
  /** Funds the cast and drives permissionless steps ("anyone" in the spec). */
  funder: NearActor;
  actor(who: Who): NearActor;
  base: PublicClient;
  deployer: SignerClient;
  evmWallet(privateKey: Hex): SignerClient;
  solana: Connection;
  ops: Keypair;
}

export async function createContext(envFile: string): Promise<Context> {
  const deployment = loadDeployment(envFile);
  const engine = deployment.engine;
  const views = engineViews(engine);
  const config = await withRetry("get_config", () => views.getConfig());
  const derived = config.derived_addresses;
  if (derived === undefined || derived === null) throw new Error(`${engine} is not bootstrapped (no derived addresses)`);
  const keys = new SeedKeys();
  const header = { engine, env_file: deployment.envFile.replace(`${ROOT}/`, "") };
  const actors = new Map<Who, NearActor>();
  const evmWallet = (privateKey: Hex): SignerClient =>
    createWalletClient({ account: privateKeyToAccount(privateKey), chain: baseSepoliaChain, transport: http(BASE_RPC) });
  return {
    deployment,
    engine,
    views,
    calls: new EngineCalls(engine),
    config,
    derived: { vaultBase: derived.vault_base as Address, vaultSol: new PublicKey(derived.vault_sol), gasSol: new PublicKey(derived.gas_sol) },
    identity: new Journal(join(ROOT, identityJournalPath()), { issuer: CAST.issuer.name, token: "Cindral (CINDR)", root_account: ROOT_ACCOUNT }),
    seed: new Journal(join(ROOT, "deployments", "e2e", `${engine}.seed.json`), header),
    live: new Journal(join(ROOT, "deployments", "e2e", `${engine}.live.json`), header),
    secrets: new Journal(join(CONFIG_DIR, "seed-orders", `${engine}.json`), { engine }, 0o600),
    keys,
    funder: keychainActor(ROOT_ACCOUNT),
    actor(who) {
      let actor = actors.get(who);
      if (actor === undefined) {
        actor = new NearActor(accountOf(who), keys.near(accountOf(who)).secretKey);
        actors.set(who, actor);
      }
      return actor;
    },
    base: createBaseClient({ rpcUrl: BASE_RPC }),
    deployer: evmWallet(deployerKey()),
    evmWallet,
    solana: new Connection(SOLANA_RPC, "confirmed"),
    ops: opsKeypair(),
  };
}
