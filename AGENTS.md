# Notes for AI agents and automated reviewers

rose runs sealed, uniform-price rounds (Tender buybacks, Exits, Advances) on locked token positions
held on Base Sepolia and Solana devnet, settled by a keyless NEAR testnet contract. This file tells an
automated reviewer where things are and how to check them quickly. The [README](./README.md) is the
full description; every claim in it links a transaction, a test or a file.

## What is real and what is demo

- Testnets only: NEAR testnet, Base Sepolia, Solana devnet. Nothing touches mainnet.
- The issuer **Cindral Foundation**, its token **Cindral (CINDR)** and its cast of holders are
  fictional. Their streams, deposits, rounds and payouts are real testnet transactions
  ([`docs/verification.md`](./docs/verification.md)).
- The engine the app uses is `engine-v2.rose-app.testnet`: a reproducible build with no access key,
  so nobody can upgrade or change it. Its RoseVault on Base Sepolia is
  `0xb72a42bc59ec2423ed76b56ac82cd3457a6310fe`. The NEAR MPC network is `v1.signer-prod.testnet`.
- The hosted app is https://rose-rounds.vercel.app. Its demo wallets keep their keys in the browser
  and are funded by the app's own testnet faucet route.

## Layout

| Path | What |
|---|---|
| `contracts/engine` | The NEAR engine (Rust, near-sdk): classes, NEP-245 units, rounds, sealed orders, clearing, settlement, cross-chain custody through the MPC network |
| `contracts/ibe` | Identity-based encryption against the MPC network's CKD key (ported from Sealwell) |
| `contracts/tusdc` | The NEP-141 test USDC used as the NEAR cash venue |
| `contracts/mock-mpc` | A signing mock of the MPC contract, for the sandbox suites only |
| `contracts/evm` | RoseVault and the demo token, test USDC and stream faucet (Solidity, Foundry) |
| `packages/sdk` | `@rose/sdk`: typed views and call builders for the engine, the clearing reference, Base and Solana adapters |
| `packages/ibe-wasm` | The IBE crate compiled to WebAssembly for the browser |
| `apps/web` | The Next.js app (landing, `/app`, `/status`, `/docs`) |
| `scripts` | Deployment, seed and live end-to-end scripts; each records its transactions under `deployments/` |
| `docs` | Specification (source of truth), architecture, security model, verification log |

## Check the live deployment in a minute, no build

`node scripts/verify.ts` (Node 22.18 or later, nothing to install; `pnpm verify` runs the same) runs
10 read-only checks against NEAR testnet and Base Sepolia and exits 0 only if every one passes: the
engine and test USDC run their recorded code with no access key, the engine's code hash and NEP-330
metadata, `get_config`, the RoseVault's chain, `SIGNER()` and `LOCKUP()`, the MPC-derived Solana keys,
and the clearing of the settled rounds 0, 1, 2 and 7 recomputed with the `@rose/sdk` clearing
reference. The raw calls below reproduce some of these reads by hand.

Any NEAR testnet RPC works. `rpc.testnet.near.org` is deprecated and can answer HTTP 429 "THIS
ENDPOINT IS DEPRECATED"; if it or FastNEAR answers HTTP 429, use `https://near-testnet.drpc.org`.

```sh
RPC=https://near-testnet.drpc.org
q() { curl -s $RPC -H 'content-type: application/json' -d "$1"; }
# No access key on the engine: prints "keys":[]
q '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"view_access_key_list","finality":"final","account_id":"engine-v2.rose-app.testnet"}}'
# The deployed code hash: gC11tnmCzFJ6Bi2BjkQ6Y38Ff5Vttr2J2tKzNTiiuhK, the reproducible build recorded in docs/verification.md
q '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"view_account","finality":"final","account_id":"engine-v2.rose-app.testnet"}}'
# The engine's configuration, including its MPC-derived vault addresses (derived_addresses.vault_base)
q '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"call_function","finality":"final","account_id":"engine-v2.rose-app.testnet","method_name":"get_config","args_base64":"e30="}}'
# A round's public terms (round ids are strings: {"round_id":"8"}, not 8)
q '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"call_function","finality":"final","account_id":"engine-v2.rose-app.testnet","method_name":"get_round","args_base64":"'"$(printf '{"round_id":"8"}' | base64)"'"}}'
# RoseVault only obeys that address (needs Foundry's cast): prints 0xC345e592C6Db18c162c6225BFb6F6c92b425b7cb
cast call 0xb72a42bc59ec2423ed76b56ac82cd3457a6310fe "SIGNER()(address)" --rpc-url https://sepolia.base.org
```

`call_function` results are byte arrays of JSON. The app's `/status` page runs the same checks in
the browser and shows the raw results.

## Reproduce the build and the tests

Requirements and commands are in the README's [Getting started](./README.md#getting-started).
Without secrets, a clean clone runs:

| Command | What it runs |
|---|---|
| `cargo test --workspace` | Engine, IBE, tUSDC and mock-MPC tests, clearing and unlock property tests, recorded live vectors; the sandbox suites skip unless `ROSE_SANDBOX=1` |
| `forge test` | RoseVault and the demo contracts, including fork tests against the live Sablier Lockup |
| `pnpm -r typecheck && pnpm -r lint && pnpm -r test && pnpm -r build` | SDK, IBE wasm wrapper, scripts and web app |

[CI](./.github/workflows/ci.yml) runs these on every push to `main` and every pull request.
Opt-in suites, each documented where it lives: `ROSE_SANDBOX=1` for the NEAR sandbox suites (real
engine wasm, mock MPC), `ROSE_LIVE_SMOKE=1` with `PLAYWRIGHT_BASE_URL` for the Playwright smoke tests
against a live deployment. The deployment, seed and live end-to-end scripts need funded testnet keys
(`scripts/README.md`); their recorded runs are under `deployments/e2e/`.

## Where each claim is proven

- README, [Every claim, verified](./README.md#every-claim-verified): one row per claim with its
  transactions.
- [`docs/verification.md`](./docs/verification.md): every external fact the code relies on (addresses,
  method names, byte layouts, gas) with the command that checked it.
- [`docs/security.md`](./docs/security.md): trust model and known limits.
