import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

/**
 * The checks deploy-engine.sh and deploy-base.sh run before an irreversible step, sourced from
 * scripts/lib.sh with a stand-in `cast` on PATH and a stand-in `near_view`, so they run offline.
 */
const LIB = join(import.meta.dirname, "..", "lib.sh");
const bin = mkdtempSync(join(tmpdir(), "rose-deploy-checks-"));
process.once("exit", () => {
  rmSync(bin, { recursive: true, force: true });
});

// Answers from the FAKE_* environment variables; FAKE_CAST_FAIL makes every call fail.
writeFileSync(
  join(bin, "cast"),
  `#!/usr/bin/env bash
[[ -z "\${FAKE_CAST_FAIL:-}" ]] || exit 1
case "$*" in
  *"SIGNER()(address)"*) printf '%s\\n' "\${FAKE_SIGNER:-}" ;;
  *"LOCKUP()(address)"*) printf '%s\\n' "\${FAKE_LOCKUP:-}" ;;
  *"name()(string)"*) printf '%s\\n' "\${FAKE_NAME:-}" ;;
  chain-id*) printf '%s\\n' "\${FAKE_CHAIN:-}" ;;
  *) exit 1 ;;
esac
`,
);
chmodSync(join(bin, "cast"), 0o755);

const LOCKUP = "0xa65a1ecef02c2b9bdc604951c6a6d02335d4532e";
const VAULT = "0x62358c4f6fadb303f3a7d18ad34a1afcc1174d06";
const SIGNER = "0x89caef524792109c4b6c8e6373bcf54d84acffc6";

interface Run {
  status: number | null;
  stderr: string;
}

/** Runs `script` after sourcing lib.sh, with a `near_view` that prints FAKE_CONFIG. */
function run(script: string, env: Record<string, string> = {}): Run {
  const result = spawnSync("bash", ["-c", `source "${LIB}"; near_view() { printf '%s' "$FAKE_CONFIG"; }; ${script}`], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, ...env },
    encoding: "utf8",
  });
  return { status: result.status, stderr: result.stderr };
}

function dies(result: Run, message: RegExp): void {
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, message);
}

await test("the RoseVault check passes only on the live signer and the Sablier Lockup", () => {
  const live = { FAKE_SIGNER: "0x89CAEF524792109C4B6C8E6373BCF54D84ACFFC6", FAKE_LOCKUP: "0xA65A1ecEf02C2B9BDc604951c6A6D02335D4532e" };
  const ok = run(`require_rose_vault ${VAULT} ${SIGNER}`, live);
  assert.equal(ok.status, 0, ok.stderr);
  dies(run(`require_rose_vault ${VAULT} ${SIGNER}`, { ...live, FAKE_SIGNER: "0x80ce2541602e7be22664f23931fe1118e86e1f09" }), /has SIGNER\(\) 0x80ce.*must be redeployed/);
  dies(run(`require_rose_vault ${VAULT} ${SIGNER}`, { ...live, FAKE_LOCKUP: "0x0000000000000000000000000000000000000001" }), /has LOCKUP\(\) 0x0{39}1, not the Sablier Lockup/);
});

await test("the RoseVault check never passes on a missing answer", () => {
  dies(run(`require_rose_vault ${VAULT} ${SIGNER}`, { FAKE_CAST_FAIL: "1" }), /cast call .*SIGNER\(\)\(address\)' failed/);
  dies(run(`require_rose_vault ${VAULT} ${SIGNER}`, { FAKE_LOCKUP: LOCKUP }), /answered nothing/);
  dies(run(`require_rose_vault "" ${SIGNER}`), /is not a 20-byte hex address/);
});

await test("the chain and Lockup identity checks", () => {
  assert.equal(run("require_base_chain", { FAKE_CHAIN: "84532" }).status, 0);
  dies(run("require_base_chain", { FAKE_CHAIN: "8453" }), /chain 8453, not Base Sepolia/);
  dies(run("require_base_chain", { FAKE_CAST_FAIL: "1" }), /cast chain-id failed/);
  assert.equal(run("require_sablier_lockup", { FAKE_NAME: '"Sablier Lockup NFT"' }).status, 0);
  dies(run("require_sablier_lockup", { FAKE_NAME: '"Wrapped Ether"' }), /not "Sablier Lockup NFT"/);
});

await test("the engine configuration must equal every expected init argument", () => {
  const expected = {
    mpc_account: "v1.signer-prod.testnet",
    ckd_domain: 2,
    ckd_public_key: "bls12381g2:live",
    base_cash_tokens: ["0x69fa19ad79c1c890d37cbabaa6fe99d1aa54bc01"],
    rose_vault: VAULT,
    default_key_timeout: null,
    default_reveal_window: null,
  };
  const onChain = { ...expected, default_key_timeout: "3600000000000", default_reveal_window: "600000000000", derived_addresses: null };
  const check = `require_engine_config engine.rose-app.testnet '${JSON.stringify(expected)}'`;
  assert.equal(run(check, { FAKE_CONFIG: JSON.stringify(onChain) }).status, 0);
  dies(run(check, { FAKE_CONFIG: JSON.stringify({ ...onChain, ckd_public_key: "bls12381g2:stale" }) }), /ckd_public_key: expected "bls12381g2:live", on chain "bls12381g2:stale"/);
  dies(run(check, { FAKE_CONFIG: JSON.stringify({ ...onChain, rose_vault: "0x0000000000000000000000000000000000000002", ckd_domain: 0 }) }), /ckd_domain: expected 2, on chain 0;rose_vault/);
  dies(run(check, { FAKE_CONFIG: JSON.stringify({ ...onChain, base_cash_tokens: [] }) }), /base_cash_tokens/);
  dies(run(check, { FAKE_CONFIG: "" }), /cannot compare the configuration/);
});

await test("a reproducible artifact names its commit and HEAD when they differ", () => {
  const snapshot = "git+https://github.com/gamween/rose?rev=b32248e8e5204ce9812929ad59570e210e638587";
  const same = spawnSync("bash", ["-c", `source "${LIB}"; artifact_revision_note "${snapshot}" b32248e8e5204ce9812929ad59570e210e638587`], { encoding: "utf8" });
  assert.equal(same.stdout, "deploying the artifact of b32248e8e5204ce9812929ad59570e210e638587 (HEAD)\n");
  const other = spawnSync("bash", ["-c", `source "${LIB}"; artifact_revision_note "${snapshot}" 15316b4`], { encoding: "utf8" });
  assert.equal(other.stdout, "deploying the artifact of b32248e8e5204ce9812929ad59570e210e638587, HEAD is 15316b4: the artifact is not built from HEAD\n");
});

await test("the engine's vault must be the one the deployments file records", () => {
  const record = join(bin, "testnet.json");
  writeFileSync(record, JSON.stringify({ deployments: { "engine.rose-app.testnet": { base: { rose_vault: { address: VAULT } } } } }));
  const check = (vault: string) => run(`DEPLOYMENTS_FILE="${record}"; require_recorded_vault engine.rose-app.testnet ${vault}`);
  assert.equal(check(VAULT).status, 0);
  assert.equal(check(VAULT.toUpperCase().replace("0X", "0x")).status, 0);
  dies(check("0x0000000000000000000000000000000000000002"), /records RoseVault 0x62358c4f.* not 0x0{39}2/);
  const unrecorded = run(`DEPLOYMENTS_FILE="${record}"; require_recorded_vault engine-s9.rose-app.testnet ${VAULT}`);
  assert.equal(unrecorded.status, 0, unrecorded.stderr);
});

await test("the SDK's Sablier Lockup is the one the scripts deploy against", () => {
  const lib = /^SABLIER_LOCKUP="(0x[0-9a-f]{40})"$/m.exec(readFileSync(LIB, "utf8"))?.[1];
  const client = readFileSync(join(import.meta.dirname, "..", "..", "packages", "sdk", "src", "chains", "base", "client.ts"), "utf8");
  const sdk = /export const SABLIER_LOCKUP_V4: Address = "(0x[0-9a-fA-F]{40})"/.exec(client)?.[1];
  assert.ok(lib && sdk);
  assert.equal(sdk.toLowerCase(), lib);
});
