/**
 * Checks that the live testnet deployment is the one the README describes, read-only, in seconds:
 * `node scripts/verify.ts` (Node 22.18 or later) from a fresh clone, with nothing installed or
 * built; `pnpm verify` at the root runs the same. Each check prints PASS or FAIL with what it read
 * and from where, and the exit code is 0 only when every check passes. Only settled, immutable
 * state is read (the keyless engine, its code and configuration, the RoseVault bound to it, the
 * MPC network's derivation, settled rounds); nothing is signed or sent.
 *
 * The clearing checks run the same `@rose/sdk` clearing reference the app's Verify panel runs,
 * through the comparison `e2e-live.ts` uses, from the SDK's TypeScript sources in this clone.
 *
 * Endpoints: NEAR testnet through dRPC, then FastNEAR (`rpc.testnet.near.org` is deprecated);
 * Base Sepolia through sepolia.base.org, then PublicNode. `NEAR_RPC_URL` or
 * `BASE_SEPOLIA_RPC_URL` replaces a list with that one endpoint.
 */

import { registerHooks } from "node:module";
import type { ClassView, ConfigView, Round, RoundView } from "@rose/sdk";
import { abiAddress, JsonRpc, sdkSource } from "./lib/verify.ts";

const SDK_SOURCES = new URL("../packages/sdk/src/", import.meta.url);
registerHooks({ resolve: (specifier, context, nextResolve) => nextResolve(sdkSource(specifier, context.parentURL, SDK_SOURCES) ?? specifier, context) });
const { checkClearing } = await import("./lib/clearing.ts");
const { parseRound } = await import("../packages/sdk/src/engine/parse.ts");

/* What the README states ("Deployed contracts", "Every claim, verified"). */
const ENGINE = "engine-v2.rose-app.testnet";
const ENGINE_CODE_HASH = "gC11tnmCzFJ6Bi2BjkQ6Y38Ff5Vttr2J2tKzNTiiuhK";
const ENGINE_COMMIT = "0524b3388f7bf512f39bf521e9af68736482ef9e";
const ENGINE_BUILD_IMAGE = "sourcescan/cargo-near:0.22.0-rust-1.97.0@sha256:b193c8640a27172f83136a0f0aab2a9bf9d09f6ba0e6afd187addfaa9b92bae0";
const MPC_ACCOUNT = "v1.signer-prod.testnet";
const MPC_ED25519_DOMAIN = 1;
const ROSE_VAULT = "0xb72a42bc59ec2423ed76b56ac82cd3457a6310fe";
const VAULT_BASE = "0xc345e592c6db18c162c6225bfb6f6c92b425b7cb";
const SABLIER_LOCKUP = "0xa65a1ecef02c2b9bdc604951c6a6d02335d4532e";
const VAULT_SOL = "EqywuZpmf7i4ycvYqwzxEiDKTq94RifUSjH9pQX1SdWC";
const GAS_SOL = "HWx7jD36pAzB1Bo83bCvRYtnW5SHLcfdEZw4x4Zdn1Ng";
const NEAR_TUSDC = "tusdc.rose-app.testnet";
/** The recorded tUSDC deployment (docs/verification.md). */
const NEAR_TUSDC_CODE_HASH = "7JHPYMQ1o7QVhVyMwmzzxS3vVhyqEkcWQrGJUcmubizP";
const BASE_SEPOLIA_CHAIN_ID = "0x14a34";
/** `cast sig 'SIGNER()'` and `cast sig 'LOCKUP()'`. */
const SIGNER_SELECTOR = "0x582abd12";
const LOCKUP_SELECTOR = "0x845aef4b";

interface SettledRound {
  id: string;
  kind: Round["kind"];
  /** Clearing price, tUSDC base units (6 decimals). */
  price: bigint;
  creator?: string;
  /** Whole tokens cleared. */
  tokens?: bigint;
}

/** The seeded Tender, Exit and Advance, and the Tender a Sputnik DAO ran. All settled: nothing about them can change. */
const SETTLED_ROUNDS: readonly SettledRound[] = [
  { id: "0", kind: "Tender", price: 36_000n },
  { id: "1", kind: "Exit", price: 27_000n },
  { id: "2", kind: "Advance", price: 37_500n },
  { id: "7", kind: "Tender", price: 36_000n, creator: "cindral-treasury.sputnikv2.testnet", tokens: 2_000n },
];

const near = new JsonRpc("NEAR testnet", process.env.NEAR_RPC_URL ? [process.env.NEAR_RPC_URL] : ["https://near-testnet.drpc.org", "https://test.rpc.fastnear.com"]);
const base = new JsonRpc("Base Sepolia", process.env.BASE_SEPOLIA_RPC_URL ? [process.env.BASE_SEPOLIA_RPC_URL] : ["https://sepolia.base.org", "https://base-sepolia-rpc.publicnode.com"]);

interface Fact { ok: boolean; text: string }
interface Outcome { pass: boolean; detail: string; link?: string }
/** The host that answered a read, and the NEAR block it was read at. */
interface Source { host: string; block?: number }

function show(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "bigint") return value.toString();
  if (value === undefined) return "missing";
  return JSON.stringify(value);
}

function equal(label: string, observed: unknown, expected: unknown): Fact {
  const ok = show(observed) === show(expected);
  return { ok, text: ok ? `${label} ${show(observed)}` : `${label} ${show(observed)}, expected ${show(expected)}` };
}

/** `host` or `host, block N` or `host, blocks N to M`, per host. */
function describeSources(sources: readonly Source[]): string {
  const hosts = [...new Set(sources.map((source) => source.host))];
  return hosts
    .map((host) => {
      const blocks = sources.flatMap((source) => (source.host === host && source.block !== undefined ? [source.block] : []));
      if (blocks.length === 0) return host;
      const [low, high] = [Math.min(...blocks), Math.max(...blocks)].map((block) => block.toLocaleString("en-US"));
      return low === high ? `${host}, block ${low ?? ""}` : `${host}, blocks ${low ?? ""} to ${high ?? ""}`;
    })
    .join("; ");
}

function outcome(facts: readonly Fact[], sources: readonly Source[], link?: string): Outcome {
  return { pass: facts.every((fact) => fact.ok), detail: `${facts.map((fact) => fact.text).join("; ")} [${describeSources(sources)}]`, ...(link === undefined ? {} : { link }) };
}

/** A tUSDC amount in base units (6 decimals) as a decimal number. */
function tusdc(amount: bigint): string {
  const fraction = (amount % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${(amount / 1_000_000n).toString()}${fraction === "" ? "" : `.${fraction}`} tUSDC`;
}

/** The fields of a NEAR `query` result the checks read; each one is compared with an expected value. */
interface QueryResult { block_height?: number; keys?: unknown; code_hash?: unknown; result?: unknown; error?: unknown }

async function nearQuery(params: Record<string, unknown>): Promise<{ result: QueryResult; source: Source }> {
  const { result, host } = await near.call("query", { finality: "final", ...params });
  if (typeof result !== "object" || result === null) throw new Error(`${host} answered the query with ${show(result)}`);
  const fields = result as QueryResult;
  return { result: fields, source: fields.block_height === undefined ? { host } : { host, block: fields.block_height } };
}

/** A view call's JSON answer, unvalidated: the caller compares the fields it reads. */
async function nearView(account: string, method: string, args: Record<string, unknown> = {}): Promise<{ value: unknown; source: Source }> {
  const { result, source } = await nearQuery({
    request_type: "call_function",
    account_id: account,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
  });
  if (result.error !== undefined) throw new Error(`${account} ${method}: ${show(result.error)} [${describeSources([source])}]`);
  if (!Array.isArray(result.result)) throw new Error(`${account} ${method} returned no bytes [${describeSources([source])}]`);
  return { value: JSON.parse(Buffer.from(result.result as number[]).toString("utf8")), source };
}

let config: Promise<{ value: ConfigView; source: Source }> | undefined;
function engineConfig(): Promise<{ value: ConfigView; source: Source }> {
  config ??= nearView(ENGINE, "get_config").then(({ value, source }) => ({ value: value as ConfigView, source }));
  return config;
}

/** No access key on an account that exists and runs the expected code: an absent account also lists no keys. */
async function keyless(account: string, codeHash: string): Promise<Outcome> {
  const state = await nearQuery({ request_type: "view_account", account_id: account });
  const keys = await nearQuery({ request_type: "view_access_key_list", account_id: account });
  return outcome(
    [equal("code_hash", state.result.code_hash, codeHash), equal("view_access_key_list", keys.result.keys, [])],
    [state.source, keys.source],
    `https://testnet.near.rocks/account/${account}`,
  );
}

async function reproducibleCode(): Promise<Outcome> {
  const account = await nearQuery({ request_type: "view_account", account_id: ENGINE });
  const metadata = await nearView(ENGINE, "contract_source_metadata");
  const build = (metadata.value as { build_info?: { build_environment?: string; source_code_snapshot?: string } } | null)?.build_info;
  return outcome(
    [
      equal("code_hash", account.result.code_hash, ENGINE_CODE_HASH),
      equal("source", build?.source_code_snapshot, `git+https://github.com/gamween/rose?rev=${ENGINE_COMMIT}`),
      equal("image", build?.build_environment, ENGINE_BUILD_IMAGE),
    ],
    [account.source, metadata.source],
    `https://github.com/gamween/rose/tree/${ENGINE_COMMIT}`,
  );
}

async function engineConfiguration(): Promise<Outcome> {
  const { value, source } = await engineConfig();
  return outcome(
    [equal("mpc_account", value.mpc_account, MPC_ACCOUNT), equal("rose_vault", value.rose_vault, ROSE_VAULT), equal("derived_addresses.vault_base", value.derived_addresses?.vault_base, VAULT_BASE)],
    [source],
  );
}

async function roseVault(): Promise<Outcome> {
  const { results, host } = await base.batch([
    { method: "eth_chainId", params: [] },
    { method: "eth_call", params: [{ to: ROSE_VAULT, data: SIGNER_SELECTOR }, "latest"] },
    { method: "eth_call", params: [{ to: ROSE_VAULT, data: LOCKUP_SELECTOR }, "latest"] },
  ]);
  const [chainId, signer, lockup] = results;
  const link = `https://sepolia.basescan.org/address/${ROSE_VAULT}#readContract`;
  const chain = equal("chain id", chainId, BASE_SEPOLIA_CHAIN_ID);
  if (!chain.ok) return outcome([chain], [{ host }], link);
  return outcome([chain, equal("SIGNER()", abiAddress(signer), VAULT_BASE), equal("LOCKUP()", abiAddress(lockup), SABLIER_LOCKUP)], [{ host }], link);
}

/**
 * A Solana address is the base58 Ed25519 public key itself, so the MPC network's
 * `derived_public_key` answer is compared as is. The Base key's EVM address needs keccak-256,
 * which Node does not ship: `vault_base` is held to the README by the configuration and RoseVault
 * checks instead.
 */
async function mpcDerivation(): Promise<Outcome> {
  const derived = (path: string) => nearView(MPC_ACCOUNT, "derived_public_key", { path, predecessor: ENGINE, domain_id: MPC_ED25519_DOMAIN });
  const vault = await derived("vault/sol");
  const gas = await derived("gas/sol");
  const { value, source } = await engineConfig();
  return outcome(
    [
      equal("vault/sol", vault.value, `ed25519:${VAULT_SOL}`),
      equal("gas/sol", gas.value, `ed25519:${GAS_SOL}`),
      equal("engine vault_sol", value.derived_addresses?.vault_sol, VAULT_SOL),
      equal("engine gas_sol", value.derived_addresses?.gas_sol, GAS_SOL),
    ],
    [vault.source, gas.source, source],
    `https://explorer.solana.com/address/${VAULT_SOL}?cluster=devnet`,
  );
}

async function settledRound(expected: SettledRound): Promise<Outcome> {
  const raw = await nearView(ENGINE, "get_round", { round_id: expected.id });
  if (raw.value === null) throw new Error(`round ${expected.id} does not exist [${describeSources([raw.source])}]`);
  const round = parseRound(raw.value as RoundView);
  const cls = await nearView(ENGINE, "get_class", { class_id: round.classId });
  if (cls.value === null) throw new Error(`class ${round.classId} does not exist [${describeSources([cls.source])}]`);
  const { decimals } = cls.value as ClassView;
  const sources = [raw.source, cls.source];
  const link = `https://rose-rounds.vercel.app/app/rounds/${expected.id}`;
  const facts = [equal("kind", round.kind, expected.kind), equal("status", round.status, "Settled")];
  if (round.result === null) return outcome([...facts, { ok: false, text: "no clearing result" }], sources, link);
  const check = checkClearing(round, decimals);
  const agrees = check.matches && check.reference !== "no_crossing";
  facts.push(
    equal("price", tusdc(round.result.price), tusdc(expected.price)),
    {
      ok: agrees,
      text: agrees
        ? `@rose/sdk reference on the ${check.orders} opened, valid orders: same price, volume, notional, fee and ${check.engine.fills.length} fills`
        : `@rose/sdk reference on the ${check.orders} opened, valid orders differs: ${JSON.stringify(check.reference)} vs engine ${JSON.stringify(check.engine)}`,
    },
  );
  if (expected.tokens !== undefined) {
    const units = expected.tokens * 10n ** BigInt(decimals);
    const { volume } = round.result;
    facts.push({
      ok: volume === units,
      text: `volume ${volume.toString()} units${volume === units ? "" : `, expected ${units.toString()}`} (${expected.tokens.toString()} tokens of ${decimals} decimals)`,
    });
  }
  if (expected.creator !== undefined) facts.push(equal("creator", round.creator, expected.creator));
  return outcome(facts, sources, link);
}

const CHECKS: readonly { title: string; run: () => Promise<Outcome> }[] = [
  { title: `${ENGINE} has no access key, so nobody can change its code`, run: () => keyless(ENGINE, ENGINE_CODE_HASH) },
  { title: `the engine's code hash is the one the reproducible build of commit ${ENGINE_COMMIT.slice(0, 7)} produces (docs/verification.md), and its NEP-330 metadata names that commit and image`, run: reproducibleCode },
  { title: "get_config names the MPC network, the RoseVault and its Base signer", run: engineConfiguration },
  { title: "the RoseVault on Base Sepolia is bound to that signer and the Sablier Lockup", run: roseVault },
  { title: "the MPC network derives the engine's Solana vault and fee payer", run: mpcDerivation },
  ...SETTLED_ROUNDS.map((round) => ({
    title: `round ${round.id} (${round.kind}${round.creator === undefined ? "" : `, created by ${round.creator}`}) settled as the @rose/sdk clearing reference computes`,
    run: () => settledRound(round),
  })),
  { title: `${NEAR_TUSDC} (Test USDC) has no access key and runs its recorded code`, run: () => keyless(NEAR_TUSDC, NEAR_TUSDC_CODE_HASH) },
];

console.log(`rose live deployment check: read-only, nothing is signed or sent; expected values are the README's.`);
console.log(`NEAR testnet RPC: ${near.endpoints.join(", ")}. Base Sepolia RPC: ${base.endpoints.join(", ")}.\n`);
const started = performance.now();
let passed = 0;
for (const [index, check] of CHECKS.entries()) {
  let result: Outcome;
  try {
    result = await check.run();
  } catch (error) {
    result = { pass: false, detail: error instanceof Error ? error.message : String(error) };
  }
  if (result.pass) passed += 1;
  console.log(`${result.pass ? "PASS" : "FAIL"} ${String(index + 1).padStart(2)}. ${check.title}: ${result.detail}`);
  if (result.link !== undefined) console.log(`        ${result.link}`);
}
const seconds = ((performance.now() - started) / 1000).toFixed(1);
console.log(`\n${passed === CHECKS.length ? "PASS" : "FAIL"}: ${passed} of ${CHECKS.length} checks passed in ${seconds} s.`);
process.exitCode = passed === CHECKS.length ? 0 : 1;
