# Deployment and end-to-end scripts

Testnet only: NEAR testnet, Base Sepolia, Solana devnet. One style: bash (3.2 or later, the macOS
default works) plus near-cli-rs (`near`), Foundry (`forge`, `cast`), `jq` and `curl`; `python3` is
used only to decode base58; the end-to-end helpers that need the rose-ibe wasm build, the
Streamflow SDK or `@rose/sdk` run under Node 22.18 or later (the TypeScript ones with Node's native
type stripping, no build step). `scripts` is a workspace package (`@rose/scripts`): `pnpm install`
at the root installs it, and `pnpm --filter @rose/sdk --filter @rose/ibe-wasm build` must have run
once so `@rose/sdk` and `@rose/ibe-wasm` resolve. Keys are read from `$ROSE_CONFIG_DIR`
(default `~/.config/rose`: `evm-deployer.env` with `EVM_DEPLOYER_PRIVATE_KEY`, `solana-ops.json`,
the generated `seed-accounts.json`; [`.env.example`](../.env.example) lists every file) and from
`~/.near-credentials/testnet/<account>.json` (the legacy keychain of near-cli-rs). No script
prints a key or puts one on a command line: cast and forge sign through an encrypted keystore
(`evm-keystore.ts`), near-cli-rs through the keychain. near-cli-rs writes keychain files
world-readable, so `deploy-engine.sh` and `rehearse-keyless.sh` set the files they create to mode
600; do the same once for the parent account (`chmod 700 ~/.near-credentials ~/.near-credentials/testnet`
and `chmod 600 ~/.near-credentials/testnet/<parent>.json`). Every deployment and every end-to-end
run is recorded under `deployments/` (addresses, transaction hashes, block numbers, gas: no
secrets).

| Script | What it does |
|---|---|
| `derive-vault-signer.sh <engine account> [--all]` | Prints the engine's MPC-derived Base vault address (`derived_public_key("vault/base", engine, 0)` mapped to an EVM address exactly as the engine does). The engine account does not need to exist: the derivation only depends on its name. `--all` also prints the Solana vault and gas payer. |
| `deploy-base.sh --engine <engine account> [--role staging\|final] [--signer 0x…] [--demo-assets-from <engine account>]` | Deploys TestUSDC, DemoToken ("Cindral", "CINDR"), DemoStreamFaucet and RoseVault on Base Sepolia with the Foundry scripts in `contracts/evm/script`; `--demo-assets-from` reuses the three demo contracts recorded for another engine and deploys only the RoseVault. Refuses to broadcast unless the RoseVault signer equals `derive-vault-signer.sh` for the engine account (the vault is immutable), and checks the deployed `SIGNER()` afterwards. |
| `deploy-engine.sh <engine account> [--role staging\|final] [--balance "17 NEAR"] [--rose-vault 0x…] [--keyless] [--skip-create] [--verify-only]` | Creates the engine as a sub-account of its parent, deploys `target/near/rose_engine/rose_engine.wasm` with the `new` init call (MPC `v1.signer-prod.testnet`, domains 0/1/2/3, the live CKD public key, the parent as fee recipient, `tusdc.rose-app.testnet`, the RoseVault and accepted Base cash tokens recorded by `deploy-base.sh`, Sablier Lockup, chain id 84532, Streamflow), calls `bootstrap`, waits for the derived addresses and checks them against the MPC view, then checks that the on-chain code hash equals the sha256 of the local wasm. With `--keyless`, and only once every check passed, it deletes every access key in one transaction (the keychain key that signs it listed last) and polls `view_access_key_list` at `final` for up to 60 s until it returns `[]`. `--role final` refuses to run without `--keyless`. `--skip-create` resumes a stopped run on an existing account (deployment and bootstrap skipped when already done on chain); `--verify-only` sends nothing, rechecks everything and records the result, which recovers a run that stopped after the key deletion. `.near.engine.keyless` is written from the live access key list. |
| `rehearse-keyless.sh <keyless-rehearsal-*.<parent>.testnet> [--wasm file] [--balance "0.02 NEAR"]` | Rehearses the keyless step on a throwaway sub-account with the same `lib.sh` helpers: creates it, deploys a wasm without init (by default a 34-byte module exporting `noop`), adds a second full-access key nobody holds, checks the code hash, deletes both keys in one transaction, polls until `view_access_key_list` returns `[]`, then reruns the checks to show a repeated run sends nothing. Record: `deployments/e2e/<account>.json`. |
| `evm-keystore.ts <name>` | Writes `$ROSE_CONFIG_DIR/keystores/<name>.json`, the encrypted keystore (Web3 Secret Storage v3, scrypt) of the key in `<name>.env`, with a random `<name>.password` (both mode 600), once; prints their paths and the address. `lib.sh`'s `evm_signer` calls it so cast and forge get `--keystore` and `--password-file`, never `--private-key`. |
| `solana-vectors.ts [--check]` | Rebuilds the web3.js legacy message vectors of the engine's Solana encoder (`contracts/engine/tests/vectors/foreign/solana_web3js_messages.json`, mirrored by `packages/sdk/test/chains/fixtures/solana_messages.json`) from web3.js, spl-token and the Streamflow SDK's own instruction builders; `--check` exits non-zero unless both committed files match byte for byte. |
| `e2e-base-tender.sh <engine account> <step\|all> [--holder a] [--issuer b] [--stream id] [--receipt file] [--evm-env name]` | Real-testnet flow of a Base position: mint a KOL demo stream, `depositStream` into RoseVault, `register_base_deposit` after the Base safe head (real ForeignTx attestation), fund the Tender in NEAR tUSDC, create the Tender, place a sealed ask (encrypted with the rose-ibe wasm build through `ibe.mjs`), `close` (real CKD key release), `open_bid`, `clear`, `settle_bid`, `claim_base_tokens` (real MPC signature) and `executeTransfer` on RoseVault. State and every hash go to `deployments/e2e/<engine>.json`. `--holder` is required on the first run (then read from the state file); the issuer defaults to `$ROSE_ROOT_ACCOUNT`. The minted stream id comes from the faucet's own `PositionMinted` log and the payout id from the claim's own `payout_requested` event (the Lockup and the engine are shared); a mint or a claim an earlier run sent is resumed, not repeated. `--evm-env` names the `~/.config/rose/<name>.env` holding the EVM holder's key (`EVM_PRIVATE_KEY`; default `evm-deployer`): DemoStreamFaucet lets one address mint one KOL position per day. |
| `e2e-solana-stream.mjs <engine account> <step\|all> [--holder <near account>]` | Real-devnet flow of a Streamflow position: create a stream of a devnet test SPL token to a holder, `transfer_recipient` to the holder's engine deposit address, `attribute_sol_deposit` (real `AccountState` proof), `move_sol_deposit` (engine-signed move to the vault, broadcast), `register_sol_deposit`, `claim_sol_tokens` drawing on the stream from a durable nonce account created with the claimant's seed (`createWithSeed(ops, nonceSeedPrefix(holder) + suffix)`, `@rose/sdk`) (engine-built `withdraw` + `TransferChecked` durable-nonce transaction, broadcast), `confirm_sol_payout` (proof that the nonce advanced and the stream paid), then `redeem` of the position (`AdvanceNonceAccount` + `transfer_recipient` to the holder, broadcast) and `confirm_sol_redeem`. State in `deployments/e2e/<engine>.solana.json`; `--holder` is required on the first run. `setup` and `claim` record each transaction as soon as it exists and resume instead of minting, creating or claiming twice; the payout id comes from the claim's own event. Honors `ROSE_CONFIG_DIR`, `SOLANA_RPC_URL` and `NEAR_RPC_URL`. |
| `seed.ts [step\|all] [--env deployments/<engine>.env] [--window-minutes 12] [--reveal-minutes 5] [--kol-wallet nadia]` (`pnpm --filter @rose/scripts seed`) | Demo seed of spec 9 against the engine named in the env file: the fictional Cindral Foundation and its token Cindral (CINDR); NEAR sub-accounts of the root account (`ROSE_ROOT_ACCOUNT`, default `rose-app.testnet`, whose keychain key must be present) for the issuer and six holders (Halden Ventures, Tessaro Capital, Ines Marlow, Varick Partners, Teodor Vance, Nadia Solvik), funded from it; the Seed Round and KOL Round created in custody with `RoseVault.createStreams` on the DemoStreamFaucet schedules (so positions minted from the app join the same classes), one KOL stream self-deposited with `depositStream`, the Strategic Round as Streamflow streams of a devnet CINDR mint deposited in three engine calls; every log registered through ForeignTx; tUSDC cash on NEAR and on Base; then a Tender (Seed Round, Base tUSDC), an Exit (Strategic Round, NEAR tUSDC, including one deliberately malformed bid) and an Advance (KOL Round) with sealed orders encrypted to the live CKD key. `--kol-wallet` names the key in `seed-accounts.json` that mints and self-deposits Nadia Solvik's own KOL stream (default `nadia`, generated on first use): DemoStreamFaucet allows one mint per address per day, so seeding another engine within 24 h names a fresh key, and the step refuses early with the next mint time otherwise. Steps: `fund`, `base`, `solana`, `register`, `cash`, `rounds`, `summary`; each is recorded once and a run resumes where it stopped. Records: `deployments/e2e/cindral.json` (engine-independent cast and mint; `cindral.<root>.json` under another root account) and `deployments/e2e/<engine>.seed.json`; keys in `~/.config/rose/seed-accounts.json` and sealed orders in `~/.config/rose/seed-orders/<engine>.json` (both mode 600). `summary` writes the devnet mint to `deployments/testnet.json` and the env file. |
| `e2e-live.ts [step\|all] [--env deployments/<engine>.env]` (`pnpm --filter @rose/scripts e2e:live`) | Drives the seeded rounds to settlement on the real testnets and records every proof in `deployments/e2e/<engine>.live.json`: `cancel-no-key` (an Exit with a 60 s key timeout that nobody closes: `close` refused, `cancel_no_key`, refund), `close` (CKD key release checked against an offline unwrap), `open` (every opening sent by the funder account, which is neither a bidder nor a round creator; the malformed bid cannot be decrypted and its author's own opening must be refused on chain with "Opening does not match the ciphertext"), `clear` (compared with the `@rose/sdk` clearing reference; exits non-zero on a mismatch), `settle` (the malformed bid's bond is slashed), `payouts` (`withdraw_near_cash`, `withdraw_base_cash` + `executeTransfer`, an Advance lien share repaid from unlocks + `executeTransfer` of CINDR, `redeem` + `executeRelease`) and `report` (the markdown table of every transaction). |
| `demo-manifest.ts [--env deployments/<engine>.env]` | Writes the guided demo's data file (`/app/demo`, "Watch a full round") for the engine named in the env file: reads `deployments/e2e/cindral.json` and `deployments/e2e/<engine>.{seed,live}.json`, builds the manifest with the web app's own builder and validator (`apps/web/src/lib/demo/manifest.ts`: every transaction of each settled seeded round grouped by step, the cast's names, the off-chain checks), writes `apps/web/src/content/demo/<engine>.json` and regenerates `apps/web/src/content/demo/index.ts`. The app shows the demo only for the engine it is built with, so after seeding a new engine and running `e2e-live.ts`, this script is all the demo needs. |
| `ibe.mjs` | Node wrapper over `packages/ibe-wasm/pkg` (the browser's wasm): `encrypt`, `decrypt`, `plaintext` and `unwrap` (a CKD response to the round key). |
| `lib.sh` | Shared helpers (RPC views, near-cli calls, base58, the deployments file, the keyless helpers `near_require_code`, `near_delete_all_keys` and `near_wait_keyless`, `evm_signer`). Sourced by the bash scripts. |

NEAR views go to `NEAR_RPC_URL` (default `https://test.rpc.fastnear.com`) in the bash scripts and in `e2e-solana-stream.mjs`, which backs off and retries when the RPC answers -429 (rate limited); a step that stopped after its NEAR call can be run again: payout requests (`withdraw_base_cash`, the lien claim, `redeem`) are looked up and resumed, not sent twice.

Order for a new engine account `<engine>` (the final deployment reuses the demo assets of
`engine-s4`, so positions minted from the app stay in the seeded classes; drop
`--demo-assets-from` to deploy a new TestUSDC, DemoToken and DemoStreamFaucet):

```sh
cd contracts/engine && cargo near build non-reproducible-wasm && cd ../..
scripts/derive-vault-signer.sh <engine> --all
scripts/rehearse-keyless.sh keyless-rehearsal-$(date +%s).<parent>   # optional dry run of the key deletion, 0.02 NEAR
scripts/deploy-base.sh --engine <engine> --role final --demo-assets-from engine-s4.rose-app.testnet
scripts/deploy-engine.sh <engine> --role final --keyless
```

If `deploy-engine.sh` stops half way, run it again with `--skip-create` (the deployment is skipped
when the on-chain code already equals the local wasm, the bootstrap when the derived addresses are
stored); if it stops after deleting the keys,
`scripts/deploy-engine.sh <engine> --role final --keyless --verify-only` checks and records the
result without sending anything.

`deployments/testnet.json` then holds everything the web app needs; `deployments/<engine>.env` is
the matching `NEXT_PUBLIC_*` snippet for `apps/web/.env` or the Vercel environment.

## Sandbox integration tests

`contracts/engine/tests/sandbox_*.rs` run the engine in a local NEAR sandbox (near-workspaces 0.24,
neard 2.14.0) next to `contracts/mock-mpc` (signs with deterministic test keys; recorded live
responses are replayed only for the payload they were recorded over) and `contracts/tusdc`. They are gated: without `ROSE_SANDBOX=1` each prints a skip line and passes, so
`cargo test --workspace` stays offline and fast. Run them one suite at a time:

```sh
ROSE_SANDBOX=1 cargo test -p rose-engine --test sandbox_lifecycle -- --test-threads=1
ROSE_SANDBOX=1 cargo test -p rose-engine --test sandbox_recorded -- --test-threads=1
ROSE_SANDBOX=1 cargo test -p rose-engine --test sandbox_staging -- --test-threads=1
```

The first run downloads the sandbox binary (73 MB, into `target/debug/build/near-sandbox-*`) and
each suite builds the three contracts with cargo-near. Every test owns its sandbox: the `neard`
child is killed and its home directory removed when the test ends, also on failure, so no process
outlives the run. Each test prints its gas table and asserts every user-facing call stays under
300 Tgas.
