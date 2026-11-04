# Deployment and end-to-end scripts

Testnet only: NEAR testnet, Base Sepolia, Solana devnet. One style: bash (3.2 or later, the macOS
default works) plus near-cli-rs (`near`), Foundry (`forge`, `cast`), `jq` and `curl`; `python3` is
used only to decode base58; the two end-to-end helpers that need the rose-ibe wasm build or the
Streamflow SDK run under Node 22. Keys are read from `~/.config/rose/*.env`
(`EVM_DEPLOYER_PRIVATE_KEY`), `~/.near-credentials/testnet/<account>.json` (the legacy keychain
of near-cli-rs) and `~/.config/rose/solana-ops.json`; no script prints a key. Every deployment and
every end-to-end run is recorded under `deployments/` (addresses, transaction hashes, block
numbers, gas: no secrets).

| Script | What it does |
|---|---|
| `derive-vault-signer.sh <engine account> [--all]` | Prints the engine's MPC-derived Base vault address (`derived_public_key("vault/base", engine, 0)` mapped to an EVM address exactly as the engine does). The engine account does not need to exist: the derivation only depends on its name. `--all` also prints the Solana vault and gas payer. |
| `deploy-base.sh --engine <engine account> [--role staging\|final] [--signer 0x…] [--demo-assets-from <engine account>]` | Deploys TestUSDC, DemoToken ("Cindral", "CINDR"), DemoStreamFaucet and RoseVault on Base Sepolia with the Foundry scripts in `contracts/evm/script`; `--demo-assets-from` reuses the three demo contracts recorded for another engine and deploys only the RoseVault. Refuses to broadcast unless the RoseVault signer equals `derive-vault-signer.sh` for the engine account (the vault is immutable), and checks the deployed `SIGNER()` afterwards. |
| `deploy-engine.sh <engine account> [--role staging\|final] [--balance "13 NEAR"] [--rose-vault 0x…] [--keyless] [--skip-create]` | Creates the engine as a sub-account of its parent, deploys `target/near/rose_engine/rose_engine.wasm` with the `new` init call (MPC `v1.signer-prod.testnet`, domains 0/1/2/3, the live CKD public key, the parent as fee recipient, `tusdc.rose-app.testnet`, the RoseVault and accepted Base cash tokens recorded by `deploy-base.sh`, Sablier Lockup, chain id 84532, Streamflow), calls `bootstrap`, waits for the derived addresses and checks them against the MPC view. With `--keyless` it deletes every access key and verifies `view_access_key_list` is empty. |
| `e2e-base-tender.sh <engine account> <step\|all> [--holder a] [--issuer b] [--stream id] [--receipt file] [--evm-env name]` | Real-testnet flow of a Base position: mint a KOL demo stream, `depositStream` into RoseVault, `register_base_deposit` after the Base safe head (real ForeignTx attestation), fund the Tender in NEAR tUSDC, create the Tender, place a sealed ask (encrypted with the rose-ibe wasm build through `ibe.mjs`), `close` (real CKD key release), `open_bid`, `clear`, `settle_bid`, `claim_base_tokens` (real MPC signature) and `executeTransfer` on RoseVault. State and every hash go to `deployments/e2e/<engine>.json`. `--evm-env` names the `~/.config/rose/<name>.env` holding the EVM holder's key (`EVM_PRIVATE_KEY`; default `evm-deployer`): DemoStreamFaucet lets one address mint one KOL position per day. |
| `e2e-solana-stream.mjs <engine account> <step\|all>` | Real-devnet flow of a Streamflow position: create a stream of a devnet test SPL token to a holder, `transfer_recipient` to the holder's engine deposit address, `attribute_sol_deposit` (real `AccountState` proof), `move_sol_deposit` (engine-signed move to the vault, broadcast), `register_sol_deposit`, then `claim_sol_tokens` with the engine-built `withdraw` + `TransferChecked` durable-nonce transaction, broadcast. State in `deployments/e2e/<engine>.solana.json`. Needs `pnpm install --ignore-workspace` in this directory once. |
| `ibe.mjs` | Node wrapper over `packages/ibe-wasm/pkg` (the browser's wasm): `encrypt`, `decrypt`, `plaintext` and `unwrap` (a CKD response to the round key). |
| `lib.sh` | Shared helpers (RPC views, near-cli calls, base58, deployments file). Sourced by the bash scripts. |

Order for a new engine account `<engine>`:

```sh
cd contracts/engine && cargo near build non-reproducible-wasm && cd ../..
scripts/derive-vault-signer.sh <engine> --all
scripts/deploy-base.sh --engine <engine> --role final
scripts/deploy-engine.sh <engine> --role final --keyless
```

`deployments/testnet.json` then holds everything the web app needs; `deployments/<engine>.env` is
the matching `NEXT_PUBLIC_*` snippet for `apps/web/.env` or the Vercel environment.

## Sandbox integration tests

`contracts/engine/tests/sandbox_*.rs` run the engine in a local NEAR sandbox (near-workspaces 0.24,
neard 2.14.0) next to `contracts/mock-mpc` (replays recorded live MPC responses) and
`contracts/tusdc`. They are gated: without `ROSE_SANDBOX=1` each prints a skip line and passes, so
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
