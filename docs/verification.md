# Verification log

Every external fact rose relies on (addresses, versions, method names, byte layouts, gas, protocol
behaviour) and every live proof behind the README, recorded with the command that checked it and
its result. The sections are grouped by topic; each table states the date of its check, and dates
are UTC. The deployment records under `deployments/` also keep every transaction of every scripted
run.

RPC endpoints: NEAR testnet `https://test.rpc.fastnear.com`, Base Sepolia `https://sepolia.base.org`, Solana devnet `https://api.devnet.solana.com`.

NEAR transaction hashes link to `https://testnet.near.rocks/tx/<hash>` (see "Explorers" for why), Base hashes to `https://sepolia.basescan.org/tx/<hash>`, Solana signatures to `https://explorer.solana.com/tx/<sig>?cluster=devnet`. Spike accounts and contracts are throwaway and live outside the repo (scratchpad); only the facts are kept here.

A helper used below for NEAR view calls:

```bash
view() { curl -s https://test.rpc.fastnear.com -H 'content-type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"call_function\",\"finality\":\"final\",\"account_id\":\"$1\",\"method_name\":\"$2\",\"args_base64\":\"$(printf '%s' "${3:-{\}}" | base64)\"}}" \
  | python3 -c 'import json,sys;print(bytes(json.load(sys.stdin)["result"]["result"]).decode())'; }
```

## Contents

- NEAR MPC network
  - [NEAR MPC network](#near-mpc-network)
  - [MPC network 3.19.0, re-verified live (2026-11-14)](#mpc-network-3190-re-verified-live-2026-11-14)
  - [Primary sources for the MPC domains (2026-11-14)](#primary-sources-for-the-mpc-domains-2026-11-14)
  - [NEAR MPC sign (domains 0 and 1), measured from a contract](#near-mpc-sign-domains-0-and-1-measured-from-a-contract)
  - [ForeignTx verification (domain 3), measured](#foreigntx-verification-domain-3-measured)
  - [CKD and IBE (domain 2), measured](#ckd-and-ibe-domain-2-measured)
  - [MPC derived keys, Sablier live triples, SPL mint layout](#mpc-derived-keys-sablier-live-triples-spl-mint-layout)
  - [MPC request rules read in the 3.18.0 source (2026-11-06)](#mpc-request-rules-read-in-the-3180-source-2026-11-06)
- Base Sepolia: Sablier and RoseVault
  - [Base Sepolia: Sablier Lockup v4](#base-sepolia-sablier-lockup-v4)
  - [Sablier creation and status rules used by RoseVault](#sablier-creation-and-status-rules-used-by-rosevault)
  - [Base Sepolia: RoseVault spike (prototype, signer = spike key)](#base-sepolia-rosevault-spike-prototype-signer--spike-key)
  - [RoseVault and EVM facts after the spike (2026-11-04 to 2026-11-14)](#rosevault-and-evm-facts-after-the-spike-2026-11-04-to-2026-11-14)
- Solana devnet: Streamflow and durable nonces
  - [Solana custody v2: facts behind the two-phase protocol (2026-11-04)](#solana-custody-v2-facts-behind-the-two-phase-protocol-2026-11-04)
  - [Streamflow withdrawals, nonce seeds and mint checks (2026-11-04)](#streamflow-withdrawals-nonce-seeds-and-mint-checks-2026-11-04)
  - [Streamflow auto-claim and the receipt nonce (2026-11-04)](#streamflow-auto-claim-and-the-receipt-nonce-2026-11-04)
  - [Streamflow automatic withdrawal after the deposit (2026-11-14)](#streamflow-automatic-withdrawal-after-the-deposit-2026-11-14)
  - [Solana settlement facts the app relies on (2026-11-04)](#solana-settlement-facts-the-app-relies-on-2026-11-04)
  - [Payout nonce seeds per engine (2026-11-06)](#payout-nonce-seeds-per-engine-2026-11-06)
- NEAR runtime, RPC endpoints and explorers
  - [NEAR storage, logs and token registration (2026-11-04 to 2026-11-06)](#near-storage-logs-and-token-registration-2026-11-04-to-2026-11-06)
  - [Distribution cap, log limits and Solana polling (2026-11-06)](#distribution-cap-log-limits-and-solana-polling-2026-11-06)
  - [NEAR RPC endpoints (2026-11-14)](#near-rpc-endpoints-2026-11-14)
  - [Explorers](#explorers)
- Engine: clearing, builds, deployment scripts and tests
  - [Clearing and unlock math (contracts/engine, pure Rust)](#clearing-and-unlock-math-contractsengine-pure-rust)
  - [Sandbox integration tests and gas (2026-11-04)](#sandbox-integration-tests-and-gas-2026-11-04)
  - [Build notes](#build-notes)
  - [IBE wasm build paths (2026-11-14)](#ibe-wasm-build-paths-2026-11-14)
  - [Engine ABI snapshot for the SDK's binding check (2026-11-14)](#engine-abi-snapshot-for-the-sdks-binding-check-2026-11-14)
  - [Keyless deployment path and script checks (2026-11-04)](#keyless-deployment-path-and-script-checks-2026-11-04)
  - [Production dependency advisories (2026-11-14)](#production-dependency-advisories-2026-11-14)
- Web app, wallets and faucet
  - [Web app: toolchain, fonts and engine view errors](#web-app-toolchain-fonts-and-engine-view-errors)
  - [Web wallets, chain layer and faucet (2026-11-04)](#web-wallets-chain-layer-and-faucet-2026-11-04)
  - [Web app: facts measured against a live engine (2026-11-04)](#web-app-facts-measured-against-a-live-engine-2026-11-04)
  - [Engine views the app reads (2026-11-04)](#engine-views-the-app-reads-2026-11-04)
  - [Faucet limits and DAO funding (2026-11-04)](#faucet-limits-and-dao-funding-2026-11-04)
  - [Hosted app (2026-11-04)](#hosted-app-2026-11-04)
  - [Hosted demo: faucet capacity (2026-11-14)](#hosted-demo-faucet-capacity-2026-11-14)
  - [Facts behind the user guides (2026-11-06)](#facts-behind-the-user-guides-2026-11-06)
- Issuer console, demo identity and sources
  - [Issuer console: Sputnik DAO v2 and Trezu (2026-11-04)](#issuer-console-sputnik-dao-v2-and-trezu-2026-11-04)
  - [Issuer console: amounts, stream ids and voting periods (2026-11-06 to 2026-11-14)](#issuer-console-amounts-stream-ids-and-voting-periods-2026-11-06-to-2026-11-14)
  - [Demo identity: no collision with a real project](#demo-identity-no-collision-with-a-real-project)
  - [Demo identity, re-checked (2026-11-04 and 2026-11-06)](#demo-identity-re-checked-2026-11-04-and-2026-11-06)
  - [Sources the README quotes (2026-11-04)](#sources-the-readme-quotes-2026-11-04)
- Deployed contracts and live proofs
  - [Cash tokens](#cash-tokens)
  - [Test funds](#test-funds)
  - [Deployed: rose tUSDC on NEAR testnet](#deployed-rose-tusdc-on-near-testnet)
  - [Demo assets (2026-11-04)](#demo-assets-2026-11-04)
  - [Final deployment (2026-11-06)](#final-deployment-2026-11-06)
  - [Live end-to-end, final engine (2026-11-06)](#live-end-to-end-final-engine-2026-11-06)
  - [RoseVault for the second final engine (2026-11-06)](#rosevault-for-the-second-final-engine-2026-11-06)
  - [Second final deployment (2026-11-06)](#second-final-deployment-2026-11-06)
  - [Live end-to-end, engine-v2 (2026-11-06)](#live-end-to-end-engine-v2-2026-11-06)
  - [Final proofs on 3a99e6e (2026-11-06)](#final-proofs-on-3a99e6e-2026-11-06)
  - [Sputnik DAO run and judging rounds (2026-11-14)](#sputnik-dao-run-and-judging-rounds-2026-11-14)
  - [Paths not produced live](#paths-not-produced-live)
  - [Staging engines (2026-11-04 to 2026-11-06)](#staging-engines-2026-11-04-to-2026-11-06)
  - [One-command live check and CI (2026-11-14)](#one-command-live-check-and-ci-2026-11-14)

## NEAR MPC network

| Fact | Command | Result (2026-11-04) |
|---|---|---|
| MPC contract version | `view v1.signer-prod.testnet version` | `"3.18.0"` (source tag `3.18.0`, commit `e691bdb98d68dcf74653da58d043453a6318765f`) |
| Domains | `view v1.signer-prod.testnet state` | 0: Sign, CaitSith (secp256k1); 1: Sign, Frost (Ed25519); 2: ConfidentialKeyDerivation (BLS12-381), keyset epoch 27; 3: ForeignTx, CaitSith (secp256k1); reconstruction threshold 11 |
| CKD master public key (domain 2) | `view v1.signer-prod.testnet public_key '{"domain_id":2}'` | `bls12381g2:xeYho48G2Sr9oJz4gw9sLGZGspeeKpHZvMDAwWvoNTRnVMFJH96GxX98TT2MRhTtsot1wcGR1Ti2Xh8PCsbYJ2enbLNdJXDvTYSK8aTE3nJ5NZXU7Kt1F6mFtReWs5pR4kj` (identical to Sealwell's vector) |
| ForeignTx public key (domain 3) | `view v1.signer-prod.testnet public_key '{"domain_id":3}'` | `secp256k1:2KGCoy2pZt7n85QfJnQzCT1eHySuNpquUfNc8ySpRbr15F5kqU7agJYjfo5RkrzNd4tZimDFv2wAZri7RRZ32qj1` |
| Foreign chains served | `view v1.signer-prod.testnet get_available_foreign_chains` | `["Solana","Base","Bnb","Arbitrum","Abstract","Starknet","Polygon","HyperEvm","Aptos","Sui","Avalanche","Fogo"]` (no Ethereum) |
| Live gas requirements | `view v1.signer-prod.testnet config` | `sign_call_gas_attachment_requirement_tera_gas: 15`, `ckd_call_gas_attachment_requirement_tera_gas: 15`, `return_signature_and_clean_state_on_success_call_tera_gas: 7`, `return_ck_and_clean_state_on_success_call_tera_gas: 7`, `fail_on_timeout` 2 Tgas. The README at tag `3.18.0` still says 10 Tgas: the live config wins |
| Deposit | `near/mpc` tag `3.18.0`, `crates/contract/README.md` "Deposit requirement", confirmed by every live call below | `sign`, `request_app_private_key`, `verify_foreign_transaction` need at least 1 yoctoNEAR; excess refunded |
| `app_id` derivation | `crates/near-mpc-crypto-types/src/kdf.rs`; confirmed by a live CKD key verifying against `round_app_id(engine, id)` | `SHA3-256("near-mpc v0.1.0 app_id derivation:" + predecessor + "," + path)`, predecessor = the calling contract |
| CKD hash-to-curve | `crates/contract/src/primitives/ckd.rs`; confirmed by live key verification | `H = hash_to_curve_G1(compressed_mpk(96) \|\| app_id)`, DST `NEAR BLS12381G1_XMD:SHA-256_SSWU_RO_` |
| CKD response format | receipts of the CKD transactions below | `{"big_y":"bls12381g1:...","big_c":"bls12381g1:..."}`, key = `C - a * Y` |
| `sign` response formats | `crates/near-mpc-crypto-types/src/primitives.rs`, live callbacks | `{"scheme":"Secp256k1","big_r":{"affine_point":"<33B hex>"},"s":{"scalar":"<32B hex>"},"recovery_id":0\|1}` and `{"scheme":"Ed25519","signature":[64 numbers]}`; both deserialize with `#[callback_result]` in near-sdk 5.30 |
| near-sdk 5.30 BLS host functions | `~/.cargo/registry/src/*/near-sdk-5.30.0/src/environment/env.rs` lines 1036-1165 | every `env::bls12381_*` returns `Option`; `bls12381_p1/p2_decompress` do not check subgroup membership (NEP-488), `multiexp` and `pairing_check` do |
| Toolchain | `cargo test` with rustc 1.91.1: `near-sdk@5.30.0 requires rustc 1.95` | Rust 1.95.0 pinned in `rust-toolchain.toml`; cargo-near 0.22.0, near-cli-rs 0.30.1 |

## MPC network 3.19.0, re-verified live (2026-11-14)

The testnet MPC contract moved from 3.18.0 (the version rose was built and recorded against) to
3.19.0 (release of 12 November: presignatures removed from ECDSA signing, foreign-chain whitelist
enforcement, attestation expiry taken from the collateral). The engine is keyless, so each domain was
re-checked on the live engine.

| Fact | Command | Result |
|---|---|---|
| Contract version | `call_function v1.signer-prod.testnet version {}` (any NEAR RPC; `https://near-testnet.drpc.org` when FastNEAR answers 429) | `"3.19.0"` |
| Domains and threshold | `call_function v1.signer-prod.testnet state {}` | `Running`: eight domains, each `reconstruction_threshold` 11, 16 participants: 0 Sign CaitSith, 1 Sign Frost, 2 ConfidentialKeyDerivation, 3 ForeignTx CaitSith (the four rose's `get_config` names), and 4 to 7 with the same four purposes and protocols |
| Release notes | `gh api repos/near/mpc/releases/tags/3.19.0 --jq .body` | the breaking item is node-side (attestation expiry); `sign`, `request_app_private_key` and `verify_foreign_transaction` arguments unchanged |
| Domain 2 (CKD) on 3.19.0 | `get_events` of `engine-v2.rose-app.testnet` from seq 196 | rounds 5 and 6: `key_requested` 00:54:00Z / 00:54:17Z, `key_received` (source `Callback`) 00:54:06Z / 00:54:22Z; round 7 key 4.36 s after its request |
| Domain 3 (ForeignTx, Base `Log`) on 3.19.0 | same events | `deposit_verification_requested` then `position_registered` at 00:38Z and 00:46Z (two Sablier deposits from the app) |
| Domain 0 (secp256k1) on 3.19.0 | `withdraw_base_cash` of 10 tUSDC by `tessaro-capital.rose-app.testnet` [DUVW9EiQ…](https://testnet.near.rocks/tx/DUVW9EiQH48u37pdCrcz4zDdHAco1U77yrpwNT7PYtn2), then `RoseVault.executeTransfer` [0xe3b65667…](https://sepolia.basescan.org/tx/0xe3b65667ef2147bbe421a62a0ddeba81622e98e6d3cb222eb450f810541cfbbc) | payout 11 signed 4.81 s after the request (MPC part 3.7 s); the vault accepted the signature, +10 tUSDC to the holder |
| Domain 1 (Ed25519) on 3.19.0 | `move_sol_deposit` [HMar1kmX…](https://testnet.near.rocks/tx/HMar1kmXeJ3gDGJBGG5nMc1HQnCi74Qm76W6azBUpaJ8), broadcast on devnet [4QCoEcjn…](https://explorer.solana.com/tx/4QCoEcjnU8ZmW31tEupKSBDTz7xVogVvhnMqUNiije9HnGGrVQZ7LSQq7KDDQ4e75NJXd9GmUqTq2Jdw9CPPJsGC?cluster=devnet) | two Ed25519 signatures (deposit key and `gas/sol`) in 4.8 s; finalized without error |
| Domain 3 (ForeignTx, Solana `AccountState`) on 3.19.0 | `claim_sol_tokens` and `attribute_sol_deposit` requests, 01:10Z to 01:35Z | degraded: 7 of 9 requests timed out at the 120 s yield; every failed claim (payouts 14 to 18) refunded by the engine; one attribution passed in 37 s |
| Domain 3 (Solana) and domain 1 again, 02:45Z | one `claim_sol_tokens` of a Streamflow test position held by `b1.rose-ckd-1793753433.testnet` [8n12Gn4x…](https://testnet.near.rocks/tx/8n12Gn4xy5ZdcZ1SHcsJchyGTZTmF1tdwxXMoHyWZsXw) (nonce proof, then two Ed25519 signatures), broadcast [39rXLfjG…](https://explorer.solana.com/tx/39rXLfjGxBc9cUeg6LmGNu73eW5vky7nAeQ9YfSsrGTmU8gCe2KYKWrFnR2wwFe41b4WNgVsvziyqPyxq16cotdv?cluster=devnet), `confirm_sol_payout` [FF5z7gYw…](https://testnet.near.rocks/tx/FF5z7gYweWiPVSQre4DSMFKKFoJKTLEG5pqgobQHYgtS) | payout 20 `Landed`, 5,760 test tokens: Solana attestations recovered |
| Domain 3 (Solana), 03:48Z to 04:13Z | a Solana deposit from the app with the demo wallet `rose-demo-cbos3k.testnet`: `register_sol_deposit` [GmAZSMNL…](https://testnet.near.rocks/tx/GmAZSMNLG3VEfeTUwr55mNgNYJMaHHHGsdSpec1AifHr) (03:48:27Z), [HAQ8hxVX…](https://testnet.near.rocks/tx/HAQ8hxVXnrkV8vF7V3w6mb3CaBmT17JVwCPw3unKru3Y) (03:54:27Z), [3ekz8u55…](https://testnet.near.rocks/tx/3ekz8u55XogPKtHPDTSKDZyWF43mhUWkVxfETAtHt7B7) (04:13:17Z); found with `curl -s "https://api-testnet.nearblocks.io/v1/account/engine-v2.rose-app.testnet/txns?method=register_sol_deposit"` | the first two timed out at the MPC (refunded about 120 s later, "MPC verification timed out … Retry this step"), the third registered the position at 04:13Z: Solana attestations work on 3.19.0 but not every time |

## Primary sources for the MPC domains (2026-11-14)

| Fact | Command | Result |
|---|---|---|
| NEAR's Chain Signatures page lists only domains 0 and 1 | `curl -sL https://docs.near.org/chain-abstraction/chain-signatures` | "only the two signing domains are currently supported: 0 for Secp256k1 or 1 for Ed25519" |
| near/mpc names CKD and foreign-chain verification | `curl -sL https://raw.githubusercontent.com/near/mpc/main/README.md` | "Confidential Key Derivation — derives application-specific keys without revealing the master secret (BLS12-381)"; "Read RPC — nodes independently verify transactions on foreign chains (Ethereum, Solana, Aptos, …) … Known under the working name foreign chain transaction verification" |
| Near One names time-lock encryption as a CKD use | `curl -sL https://blog.nearone.org/research/2026/02/23/mpc-ckd.html` | "it can be used to enable time-lock encryption. A smart contract could encrypt data under a key that is only derivable once certain on-chain conditions …" |
| MPC nodes run in TEEs | `curl -sL https://raw.githubusercontent.com/near/mpc/main/README.md` | "signatures produced jointly by t-of-n nodes running in TEEs, with no single party ever holding the complete key"; "Nodes run inside trusted execution environments (TEEs) and attest what they run on chain" |
| NEAR Intents has no testnet | `curl -sS https://nearhackathon.com/HACKATHON.md`, Q-007 | "Testnet for Intents? None exists or is planned. Mainnet, separate dev accounts, tiny amounts, dry: true quotes." |
| NEAR Intents' 1Click API | `curl -sL https://docs.near-intents.org/integration/distribution-channels/1click-api/quickstart` (HTTP 308 to the page) | the 1Click API (`https://1click.chaindefuser.com/docs/v0/openapi.yaml`) creates cross-chain swap orders; with no Intents testnet it runs on mainnet only |
| NEAR Business | `curl -sS https://nearhackathon.com/HACKATHON.md`, partner notes | "NEAR Business (business.near.com): a confidential multisig built on NEAR Intents. It keeps treasury balances and transfers hidden from the public, manages assets on 35+ chains from one dashboard" |
| Live facts quoted in `AGENTS.md` | `view_account` and `get_config` of `engine-v2.rose-app.testnet`; `cast call 0xb72a42bc59ec2423ed76b56ac82cd3457a6310fe "SIGNER()(address)"` | code hash `gC11tnmCzFJ6Bi2BjkQ6Y38Ff5Vttr2J2tKzNTiiuhK`; `derived_addresses.vault_base` `0xc345e592c6db18c162c6225bfb6f6c92b425b7cb` = `SIGNER()` |

## NEAR MPC `sign` (domains 0 and 1), measured from a contract

Spike contract `c.rose-sign-1793752785.testnet` (throwaway, outside the repo; created in tx [8mWTcWtC…](https://testnet.near.rocks/tx/8mWTcWtCPTuhhWkAUzMpXhYbTFbs6AspV7xnJtXqdjPq), deployed in [BvzxSk8G…](https://testnet.near.rocks/tx/BvzxSk8GVabrdFowCN1oRAmtxKxkJ37DdQQRzNSp36Db)). Hashes checked with RPC `EXPERIMENTAL_tx_status`. Derived keys for that predecessor (the engine derives different ones): `derived_public_key("vault/base", …, 0)` = `secp256k1:4D8Exx2unEhfBkEa3EcjMKYrEUJgfMbecYd4nG9zE6T49hepuCvMrFEVofBWUVnFkYbjJs2MgaeD7hp72gLAjP65` = `0x556e29bce7c6ab74a8B36b3c754D3Ac2842223b5`; `("vault/sol", …, 1)` = `ed25519:ERKmrj6yveQaKExLsfuiJZW19MYnwFhUUwdLBPniG6GL`; `("gas/sol", …, 1)` = `ed25519:CBx96X3pThHzNJYjfXBKjdKktZxVApRaiNS8Ej6G7Qwz`.

| Fact | Evidence | Result (2026-11-04) |
|---|---|---|
| `sign` gas floor | `view v1.signer-prod.testnet config`; call with 14 Tgas, tx [AJowwtnx…](https://testnet.near.rocks/tx/AJowwtnxEwTxSmeZLjswrPjjMA7fy98HPYNqe31CWRfH) | `sign_call_gas_attachment_requirement_tera_gas: 15` (README says 10); 14 Tgas panics `Provided gas is lower than required. Provided: 14000000000000, required: 15000000000000` |
| ECDSA payload bound | payload n+1, tx [AzXGcUjG…](https://testnet.near.rocks/tx/AzXGcUjGgaj2EcuMVqE7ywC2W9tizaRwUXb4L35GLqxe); `crates/contract/src/api/sign.rs:47-50` at 3.18.0 (`k256::Scalar::from_repr`) | Must be below the group order n (README says field size p): `Ecdsa payload cannot be converted to Scalar` |
| Domain 0 signature recovers to the derived address | tx [57TzcvbH…](https://testnet.near.rocks/tx/57TzcvbHbkBrZioL6Dg2jLnTxGGbYEYBY7oACbXv87MT) (fixture), Foundry `ecrecover` (5 tests), `cast wallet verify --no-hash`, k256 and @noble/curves recovery | EIP-712 digest `0x50082754a6fac1ef5903aa07f91c8db9b1d180a6ff13ecf22469889b07c71921` signed for path `vault/base` recovers to `0x556e29bce7c6ab74a8B36b3c754D3Ac2842223b5`; mapping r = big_R.x, v = 27 + recovery_id |
| Low s, recovery id | 10 live signatures: [C96uAkLL…](https://testnet.near.rocks/tx/C96uAkLL5Y5gWMjLc1Un7BBXo8uRKqop9ViKoPZzRXpD), [2ukJqjHo…](https://testnet.near.rocks/tx/2ukJqjHoPqLpGyuepFdtrK1116FyAkK5GGp7J6FKeuKP), [Aja9qUJv…](https://testnet.near.rocks/tx/Aja9qUJvawRd5izrzgriE8V9NhV8hnRprTcDyd15eW7r), [9ZAVHyog…](https://testnet.near.rocks/tx/9ZAVHyogCCLCx9tHr2cmuh356dpAeaByjs5rqQ9XuH8j), [HS5FJqKr…](https://testnet.near.rocks/tx/HS5FJqKr25GgQZv27moujTzkCchN3nT76a3PnrVpoJhC), [H2XEUws7…](https://testnet.near.rocks/tx/H2XEUws7xxdWWy4hiXq8iPc4qcNMscRJUuJEDGoJmoNW), [5Tee6EEr…](https://testnet.near.rocks/tx/5Tee6EErKv5uJQTxnMwuvXixtB5WRs4cDyZrqsHAh9gx), [JwMpjqXb…](https://testnet.near.rocks/tx/JwMpjqXbXNjXcscfuXFgxqyW1CG49gxNqKAYtnV8DmW), [71ZpgcYi…](https://testnet.near.rocks/tx/71ZpgcYixtSjzT8MpwMmdBdxwqgURi6WXV51VfBiNVK7); `respond` verifies with `malleability_flag = true` (`crates/near-mpc-signature-verifier/src/lib.rs`) | all 10 low-s (guaranteed by the contract); all four big_R prefix / recovery_id combinations occur, so v is always taken from `recovery_id`, never from the prefix |
| Domain 0 cost and latency | 10 transactions, `tools/txinfo.py` on block timestamps | `sign_evm` 2.17 Tgas, MPC `sign` 4.28, resume 3.47, callback 1.52: about 12.7 Tgas burnt; 21 Tgas prepaid works, 20 fails (`Exceeded the prepaid gas`, atomic); latency 3.73 to 6.04 s, median 4.87 s (7 to 10 blocks) |
| Two `sign` promises joined (domain 1, paths `vault/sol` and `gas/sol`) | tx [DiXxwbXD…](https://testnet.near.rocks/tx/DiXxwbXDzWJg8g1tqsKi394foDAQWqHwSkFvyBMXSYN6) (joined), [FdnkuTuP…](https://testnet.near.rocks/tx/FdnkuTuP2TwAXAUoQF24xWeCwH4Y8TCvnimicNyAJsyK) (single), [2Gi9QVi6…](https://testnet.near.rocks/tx/2Gi9QVi6PE8ruPc1ondNboY7adCpJCTdmmY8F4rsVqxK) (616-byte withdraw + SPL message) | about 22.8 Tgas burnt, 38 Tgas prepaid works, 37 fails; EdDSA `sign` 4.75 to 4.80 Tgas; joined pairs 4.29 to 4.86 s, no slower than one request; both resolve in the same block |
| Refund only on `PromiseError` | txs [BToSjfQN…](https://testnet.near.rocks/tx/BToSjfQNBoj5Nev73VpGJvpJTWvTvSQAUhWPKgEKmqaf), [AJowwtnx…](https://testnet.near.rocks/tx/AJowwtnxEwTxSmeZLjswrPjjMA7fy98HPYNqe31CWRfH), [AzXGcUjG…](https://testnet.near.rocks/tx/AzXGcUjGgaj2EcuMVqE7ywC2W9tizaRwUXb4L35GLqxe) | three failures refunded (gas 14, payload ffff…, payload n+1) about 1.2 s (2 blocks) after the request; every success kept its debit (counter 1000 − 18 + 3 = 985) |
| Durable-nonce payout signed by the MPC and broadcast | NEAR tx [2EnjBoZA…](https://testnet.near.rocks/tx/2EnjBoZADxx2GoBng8XHRq4LDbagHjKwB1exhasZtgxH); nonce account `4X9oUfBiS6x99yUUkr2fENd19Vojphg4gnisq3evE5Z6` created in [5TtcgrKj…](https://explorer.solana.com/tx/5TtcgrKjwvewysvUYrRF4Wy7Y84Y4JWJYjS19pb5eBbiw1H3RpBzybLZwDXEmWJ6EvdyQinicxjuLUc3uiK3qLUd?cluster=devnet) (slot 518404430); Solana [4CrVjw75…](https://explorer.solana.com/tx/4CrVjw75paRmX7Uopaoeyfv1D83oLKpyJBLM6AbNziMkuPGQ4ykxgUBGT3TZ8vxZeajR7XqsAvnEMtutNBuTL9Wy?cluster=devnet) | landed at slot 518404964, 534 slots (127 s) after the nonce value was read; fee 10,000 lamports paid by `gas/sol`; wire format `[2] ‖ sig(gas) ‖ sig(vault) ‖ message`; replay rejected (`BlockhashNotFound`) |
| Solana legacy message serialization | Rust builder vs web3.js 1.98.4 `TransactionMessage.compileToLegacyMessage()` on 5 messages (nonce + SOL transfer 256 B, nonce + SPL TransferChecked 352 B, nonce + Streamflow withdraw + SPL transfer 616 B, nonce + ATA create-idempotent + Streamflow transfer_recipient 503 B, create-account + initialize nonce 296 B) | byte-for-byte identical (`Transaction.compileMessage` may order keys differently and is not used) |
| ATA derivation inside a NEAR contract | txs [5WJAQJh3…](https://testnet.near.rocks/tx/5WJAQJh3tTvc6zWogCbc6KKe7WERsN1LxgPXuittNGHt), [4reqx9eh…](https://testnet.near.rocks/tx/4reqx9ehTvunZohW4kWV7xCKcNAMGi82gjxDXcv13jDm) | 0.35 to 0.85 Tgas, results equal spl-token (`DGQBYp6TikzdjMzXd6uwyDo99mXmoG28YHu5hkMAW8Yc`, `8u44P2hQQCP7GJ7g43r9ELRoDWVLQ4THUP1BoiRQ8GKE` bump 255) |
| Streamflow `withdraw` / `transfer_recipient` encodings | `@streamflow/stream` 13.4.0 (commit `fb236fff325ab02d7ff5d0ff5e393be8934cda9d`, `packages/stream/solana/instructions.ts`, `StreamClient.ts`), `streamflow-sdk` 0.15.0 (commit `63df7d7b831340daa27f31d007eec2a98380364c`, `programs/streamflow-sdk/src/lib.rs` lines 804-846 `Withdraw` and 902-928 `Transfer`) | `withdraw`: data `sha256("global:withdraw")[..8] = b712469c946da122` ‖ amount u64 LE ‖ 10 zero bytes (`u64::MAX` = everything unlocked); 11 accounts (authority s/w, recipient, recipient_tokens, metadata, escrow_tokens, treasury `5SEpbdjFK5FxwTvfsGMXVQTD2v4M2c5tyRTxhdsPkgDw`, treasury ATA, partner, partner ATA, mint, token program). `transfer_recipient`: data `ebf6e04069a6148a` ‖ 10 zero bytes; accounts authority s/w, new_recipient, new_recipient ATA, metadata, mint, rent, token, ATA program, system; the only signer pays any ATA rent, so the engine prepends `create_associated_token_account_idempotent(payer = gas/sol)`. Rust encoders equal the js-sdk bytes |

## ForeignTx verification (domain 3), measured

Direct calls from `rose-ftx-752857.testnet` (1 yoctoNEAR each; latency = submit to final outcome, and transaction block to last receipt block). Probe contract `probe.rose-ftx-752857.testnet` (request + callback, deploy tx [8nVD9TsS…](https://testnet.near.rocks/tx/8nVD9TsS1JDW7B3DoHKUw4WAqyUXYTKhCvisUs4jsHp)). Throwaway Base emitter `0x3be8E695569b2927fa8b2ddFE61D8Fde7556C82f` (deploy [0x2e627e7f…](https://sepolia.basescan.org/tx/0x2e627e7f9adc7ae0ccee57a609556be95334faf12881ff2aa984bc173c44a1a9)); `emitBoth` emits `Ping` then a `StreamDeposited`-shaped event: emit 1 [0xbf9a7be7…](https://sepolia.basescan.org/tx/0xbf9a7be7a3c7cadd95db81affdcb4ce08e61fd85139d62a475253d4a24050e6b) (block 54155063, tx index 5, block-level `logIndex` 6 and 7), emit 2 [0xa387704d…](https://sepolia.basescan.org/tx/0xa387704d93b1511666f2613a8c2af2a9de692f30deea174ccaa4e6c86a340568) (block 54159500, `logIndex` 6).

### Wire format and payload hash

Source at tag `3.18.0` (`crates/contract/src/api/foreign_chain/requests.rs`, `crates/node/src/providers/verify_foreign_tx/sign.rs`, `crates/foreign-chain-inspector/src/{evm,svm}/inspector.rs`, `crates/node/src/requests/queue.rs`) and the snapshot `should_match_the_wire_format_catalog.snap`:

```json
{"request":{"request":{"Base":{"tx_id":"<32B hex, no 0x>","extractors":[{"Log":{"log_index":7}}],"finality":"Latest|Safe|Finalized"}},
            "domain_id":3,"payload_version":1,"expected_payload_hash":"<optional 32B hex>"}}
{"request":{"request":{"Solana":{"tx_id":"<64B hex>","finality":"Confirmed|Finalized","extractors":[{"AccountState":{"pubkey":"<32B hex>"}}]}},
            "domain_id":3,"payload_version":1}}
```

Response: `{"payload_hash":"<hex>","signature":{"scheme":"Secp256k1","big_r":{"affine_point":"<33B hex>"},"s":{"scalar":"<32B hex>"},"recovery_id":0|1}}`. Payload hash = `sha256(borsh(ForeignTxSignPayload::V1 { request, values }))`; Borsh tags `V1` = 0, `ForeignChainRpcRequest::Solana` = 2, `::Base` = 6, `EvmFinality` 0/1/2, `EvmExtractor::Log` = 1, `SvmFinality` 0/1, `SvmExtractor::AccountState` = 2, `ExtractedValue::Evm` = 1, `::Svm` = 6, `EvmExtractedValue::Log` = 1, `SvmExtractedValue::AccountState` = 1; field order `EvmRpcRequest {tx_id, extractors, finality}` but `SvmRpcRequest {tx_id, finality, extractors}`; `EvmLog {removed, log_index, transaction_index, transaction_hash, block_hash, block_number, address (20 B), data: String ("0x" + lowercase hex, verbatim from the RPC), topics}`; `SvmAccount {owner, data: Vec<u8>}`. `domain_id`, `payload_version` and `expected_payload_hash` are not hashed; finality is. A mirror module reproduces the real crate (`near-mpc-contract-interface` 3.18.0) on 1000 random cases and 10 live vectors, and every live signature recovers (`recover_from_prehash`, no extra hashing) to the domain 3 key. The engine does not need to verify the signature: the MPC contract verifies it (`respond_verify_foreign_tx`) before resuming the yield, and the callback is `#[private]`.

### Facts

| Fact | Command | Result (2026-11-04) |
|---|---|---|
| Gas floor and reserves | `view v1.signer-prod.testnet config` | 15 Tgas attached minimum; yield callback 7 Tgas; `fail_on_timeout` 2 Tgas |
| Gas burnt, direct call | runs below | 8.43 Tgas (Base), 8.62 Tgas (Solana): request receipt 4.4 to 4.6 Tgas, yield callback 3.5 Tgas; timeout path 11.23 Tgas |
| Gas, probe contract (request + callback) | txs [6FfiRfxX…](https://testnet.near.rocks/tx/6FfiRfxXLXkff7zvTSvs7gnr5oeffPPkvcpFnuhovttJ) (21 Tgas, ok), [BAhMN99C…](https://testnet.near.rocks/tx/BAhMN99CPsXEeChkvJcTcA32rzsbB1m2Vv7yzCNGTS7h) (22, ok), [6pQxLR57…](https://testnet.near.rocks/tx/6pQxLR57CiLiQzsRTzZuzCrDJ7XkL5RqYA7r8Tben1iU) (20, `Exceeded the prepaid gas.`) | minimum 21 Tgas total (15 to MPC + 2 callback); `probe` 2.43 Tgas, callback 1.27 to 1.33 Tgas; 12.7 to 12.8 Tgas burnt end to end, 15.2 to 15.5 on timeout |
| 14 Tgas to the MPC | tx [2XphG6iM…](https://testnet.near.rocks/tx/2XphG6iM2rJWYuM8ZXVeN6jpSYBXp3rkz93WckvuAs7t) | MPC receipt panics `Provided gas is lower than required. Provided: 14000000000000, required: 15000000000000`; callback gets `PromiseError::Failed` after 2 blocks |
| Yield timeout | node const `REQUEST_EXPIRATION_BLOCKS = 200`; live timeouts below | failure at +201 blocks, caller callback at +204 blocks, 114 to 126 s; the MPC panics `Request has timed out.` |
| Block times | 205 NEAR blocks in 124 s; `cast block latest` twice (856 Base blocks in 169 s) | NEAR testnet about 0.6 s, Base Sepolia about 0.2 s |
| Duplicate requests | `requests.rs` | same caller and args while pending: queued, all get the same response (bounded queue, `PendingRequestQueueFull` beyond) |
| Node retries | `queue.rs` | leader 10 attempts, failover leaders 5 every 10 s, depth 4, within the 200-block window |
| EVM inspector | `evm/inspector.rs` | `eth_getTransactionReceipt`; finality via `eth_getBlockByNumber(latest\|safe\|finalized)`, `head.number < receipt.block_number → NotFinalized`; failed tx → `TransactionFailed`; `Log { log_index }` selects the receipt log with that block-level `logIndex`, missing → `LogIndexOutOfBounds`; all finality values accepted for Base |
| SVM inspector | `svm/inspector.rs` | `getTransaction` at the commitment, `meta.err` must be null; `AccountState` = `getAccountInfo` at the same commitment with `context.slot >= tx.slot`, returns `{owner, data}`, missing → `AccountNotFound`; the account need not appear in the transaction |
| Quorum | `foreign-chain-inspector/src/lib.rs::extract_with_quorum` | every provider must return the same verdict (`InspectorResponseMismatch` otherwise) |

### Base `Log` runs (direct calls)

| Run | NEAR tx | Request | Result | Wall | Blocks |
|---|---|---|---|---|---|
| base_latest | [8Pg3zu3R…](https://testnet.near.rocks/tx/8Pg3zu3RgVhfQGN45eJmnYVBGSGBNCGmtH1KC5fdyogf) | emit 1, log 7, Latest | ok, hash `9994366753549d68a03bb87cd9b6bae79c2db5012fa72d28f7c1c847eb2af0c7` | 7.6 s | 11 |
| base_safe | [58WGJALw…](https://testnet.near.rocks/tx/58WGJALwh42mLJh2jTbqcEAEHVbExbjGE42Heb5NWW5T) | emit 1, Safe, about 10 min after mining | ok (safe head passed while pending) | 17.3 s | 26 |
| base_finalized | [3ihUTeKB…](https://testnet.near.rocks/tx/3ihUTeKBo3LGpWMpeJ3CjnfhD1XwLjNbJwSepyWjKisH) | emit 1, Finalized, not yet finalized | `Smart contract panicked: Request has timed out.` | 125 s | 203 |
| base_after_final_Finalized | [76jtgVnU…](https://testnet.near.rocks/tx/76jtgVnU9MP96MJq7M4xaUu3daSdQqRfhGPgMSUHT2t) | emit 1, Finalized, after the finalized head passed | ok | 7.7 s | 11 |
| emit2_after_final_Finalized | [BFoyrPMb…](https://testnet.near.rocks/tx/BFoyrPMbktqsJDeoe1c89rGLgLuj4mABDZ2tHVxUZN6o) | emit 2, Finalized, sent the moment the public RPC reported it finalized | ok after node retries (providers lagging) | 89 s | 143 |
| emit2_immediate_Latest | [8iXdwr75…](https://testnet.near.rocks/tx/8iXdwr756TUA9iKT9w4ZgCQPxZKWGxtLghQQZm9sUtaw) | emit 2, Latest, right after the receipt | ok | 6.7 s | 9 |
| emit2_immediate_Safe | [GGZJyF6y…](https://testnet.near.rocks/tx/GGZJyF6yDCBfreEV98PhUw67ooukxMgYPSbcNmGL7yza) | emit 2, Safe, right after mining | timed out | 114 s | 203 |
| emit2_after_safe_Safe | [8wicPaoW…](https://testnet.near.rocks/tx/8wicPaoWowXvyq22UigZDcGtkqtfcPwx2seZX8C82W5A) | emit 2, Safe, after the safe head passed | ok | 8.9 s | 12 |

### Base finality timing (`heads_emit2.log`, polling `eth_getBlockByNumber` for `latest`, `safe`, `finalized`)

| Tag | Observation |
|---|---|
| `latest` | usable immediately (nodes had the receipt 2 to 3 s after mining) |
| `safe` | head jumps every 3 to 4 min (t0, +178 s, +408 s); emit 2 became safe 178 s after mining |
| `finalized` | head jumps every 4 to 6 min (+220 s, +596 s, +983 s), lagging safe by about 13 min; emit 2 finalized 985 s (16.4 min) after mining |
| Provider lag | a request sent on the exact head transition took 89 s instead of 8 s; wait one head update or about 30 s of margin |

Decision: Base `Safe` (the app waits for `eth_getBlockByNumber("safe").number >= receipt.blockNumber` plus margin), Solana `Finalized` (a transaction finalizes in about 13 s; same MPC latency as Confirmed).

### Mismatch behavior (probe contract, Base emit 1, log 7, Latest unless stated)

| Case | NEAR tx | Outcome | Time |
|---|---|---|---|
| (a) correct values + `expected_payload_hash` | [8h1DoNW5…](https://testnet.near.rocks/tx/8h1DoNW5hNbjizS4KN5MpCsteKdVGyPZFdgzYGTkUQkT) | response, hashes match | 7.6 s, 10 blocks |
| (b) wrong values (last data byte flipped) + expected hash | [dJTDABSJ…](https://testnet.near.rocks/tx/dJTDABSJjzPDcrrJL37x6uJcx4s7UcFew5ELif6Ywgq) | no response; MPC `Request has timed out.`; callback `PromiseError::Failed` | 124 s, 204 blocks |
| (c) wrong values, no expected hash | [GfRy8cvm…](https://testnet.near.rocks/tx/GfRy8cvm8TvGYikQDS7YmGecuDgFEM91GvhPFUWVGjGx) | response with the true hash `9994…f0c7`; recomputation `a7aa…7fd9` differs, mismatch detected by the callback | 7.3 s |
| (d) non-existent tx hash + expected | [EWWN8Qnb…](https://testnet.near.rocks/tx/EWWN8Qnb7TazYkA4coaS2tmjUbzFKyJBe574quuauWpC) | timeout, `PromiseError::Failed` | 125 s |
| (d2) non-existent tx hash, no expected | [8XJvU2cJ…](https://testnet.near.rocks/tx/8XJvU2cJBnWb1pcFw67pxyaGxDuACYQqotXDKmE8Lod4) | timeout, `PromiseError::Failed` | 125 s |
| (e) `log_index` 99 (absent) + expected | [vD9zGRK4…](https://testnet.near.rocks/tx/vD9zGRK4WcSuLGf65vY2Dza2p5oxVSy95Wo2aF9xr6e) | timeout, `PromiseError::Failed` | 126 s |
| (e2) `log_index` 1 (transaction-relative index), no expected | [FRwqqGth…](https://testnet.near.rocks/tx/FRwqqGthPrn2CV4VU9nVAKuLmJ9E1BDLoi9MRc7kW9Cr) | timeout, `PromiseError::Failed` (confirms the index is block-level) | 114 s |
| (f) finality not reached | emit2_immediate_Safe, base_finalized above | timeout | 114 to 125 s |

Consequence (spec 7.1): `expected_payload_hash` turns a mismatch into a silent 2-minute timeout (`build_signature_request` bails before using a presignature, so no node ever responds), so the engine omits it and compares the response's `payload_hash` with its own recomputation. The callback cannot tell "wrong values" from "unknown transaction" or "not final yet": all are one `PromiseError` after about 204 blocks.

Error strings observed: `Provided gas is lower than required. Provided: <n>, required: 15000000000000` (MPC, under the floor), `Exceeded the prepaid gas.` (caller, under its own budget), `Smart contract panicked: Request has timed out.` (MPC yield timeout), `PromiseError::Failed` (caller callback on any MPC-side failure). Node-side verdicts that never reach the caller: `NotFinalized`, `TransactionFailed`, `LogIndexOutOfBounds`, `AccountNotFound`, `InspectorResponseMismatch`, `UnexpectedPayloadHash`.

### Solana `AccountState` runs

| Run | NEAR tx | Request | Result | Wall | Blocks |
|---|---|---|---|---|---|
| sol_confirmed | [GyRANbrR…](https://testnet.near.rocks/tx/GyRANbrRjBUoSq9iyRVHsJNMaAiG1xBH3SRYdi43C6XF) | stream `Fpc2vjHeSEzXh92fdHHZ5UDtYazNK6e2cwcG5dozLzmZ`, anchor [cXLrwF4J…](https://explorer.solana.com/tx/cXLrwF4Jy8GXTP9nfz2TUFJEnkPa4MXCvQcuqUrWkCHsbWiGk6KyTSbQNt2roHPEfhEFspkWCFDvWmrKyGv6jH7?cluster=devnet), Confirmed | ok, owner `HqDGZ…CMfMZ`, 1104 bytes | 6.5 s | 9 |
| sol_finalized | [7rej8x58…](https://testnet.near.rocks/tx/7rej8x58nxGFxZJ4xDFxaD3JhMEBJCNASW43458PbmSK) | same, Finalized | ok | 7.0 s | 9 |
| sol_volatile_finalized | [FuoM8sJ3…](https://testnet.near.rocks/tx/FuoM8sJ3nfhtg1aJDmiEfBrMGqxmwj8eDLj4u36v3YNB) | stream `6YyXecAuk8RWUuNXXyEBKafjgqxGFLRvSyhak14MAroE` (auto-withdrawn every 60 s), anchor [5XQjpnhL…](https://explorer.solana.com/tx/5XQjpnhLgwkLXhzaegbL3tm1sQrQ1uCRQiFBoy8CCe5cco5PQEJ4r6uaNpyh7vHHdf3ZrTQHskb46MBee1ds4zGD?cluster=devnet), Finalized | ok; the signed bytes are the state at request time (reconstructed by rolling back `amount_withdrawn` at 17 and `last_withdrawn_at` at 41), not the state as of the anchor | 5.7 s | 8 |
| own_stream_finalized_expected | [Dnz8n48X…](https://testnet.near.rocks/tx/Dnz8n48XtzxhBpduEr11tBu7aahu2odPDiqoeb65qD6n) | our stream `J2MxwxkCVey1o7SQUgLh4VPuomnnhtYJbkzVbGf4jdPc` (create tx [2AKysXtT…](https://explorer.solana.com/tx/2AKysXtTpbHCzcQJ8opT5CEikNPSRGJy95frD5pRSk5siqjgRQTmJRVteCH83w63vuiAWuRLn1sbnd5gjweXhboQ?cluster=devnet), mint `3q81mxTA7rricmjJQaiZk9HbZzF2Pt8aN5SJaJcXvZ4w`), Finalized, with expected hash from our own `getAccountInfo` | ok, hash equal | 7.6 s | 9 |

`getProgramAccounts` on `HqDGZjaVRXJ9MGRQEw7qDc2rAr6iH1n1kAQdCZaCMfMZ` with `dataSize: 1104`: 73,664 accounts. The program is live, BPFLoaderUpgradeable, executable.

### Streamflow metadata layout (1,104 bytes, little-endian, no discriminator)

Sources: streamflow-finance/js-sdk `packages/stream/solana/layout.ts` (`streamLayout`), commit `fb236fff325ab02d7ff5d0ff5e393be8934cda9d` (2026-09-01), `CREATE_PARAMS_PADDING = 121` in `constants.ts`; streamflow-finance/rust-sdk `programs/streamflow-sdk/src/state.rs` (`Contract`, `CreateParams`, `METADATA_LEN = 1104`), commit `63df7d7b831340daa27f31d007eec2a98380364c` (2026-08-31). Both agree up to `bump`; js adds `fee_partner` and `cancel_request_time`; bytes 819..1104 are zero padding. Every offset was checked on stream `J2Mx…jdPc`, created with distinctive values (amount 1,234,567,890; cliff_amount 234,567,890; amount_per_period 10,000,000; period 77; start now+300; cliff now+900; `end_time` = cliff + 100 × 77 as expected).

| Offset | Size | Field | Offset | Size | Field |
|---|---|---|---|---|---|
| 0 | 8 | magic (observed 4) | 409 | 8 | start_time |
| 8 | 1 | version (observed 4) | 417 | 8 | net_amount_deposited |
| 9 | 8 | created_at | 425 | 8 | period |
| 17 | 8 | amount_withdrawn | 433 | 8 | amount_per_period |
| 25 | 8 | canceled_at | 441 | 8 | cliff |
| 33 | 8 | end_time | 449 | 8 | cliff_amount |
| 41 | 8 | last_withdrawn_at | 457 | 1 | cancelable_by_sender |
| 49 | 32 | sender | 458 | 1 | cancelable_by_recipient |
| 81 | 32 | sender_tokens | 459 | 1 | automatic_withdrawal |
| 113 | 32 | recipient | 460 | 1 | transferable_by_sender |
| 145 | 32 | recipient_tokens | 461 | 1 | transferable_by_recipient |
| 177 | 32 | mint | 462 | 1 | can_topup |
| 209 | 32 | escrow_tokens | 463 | 64 | stream_name |
| 241 | 32 | streamflow_treasury | 527 | 8 | withdraw_frequency |
| 273 | 32 | streamflow_treasury_tokens | 535 | 4 | ghost |
| 305 | 8 | streamflow_fee_total | 539 | 1 | pausable |
| 313 | 8 | streamflow_fee_withdrawn | 540 | 1 | can_update_rate |
| 321 | 4 | streamflow_fee_percent (f32) | 541 | 4 | ghost2 |
| 325 | 32 | partner | 545 | 1 | is_pda |
| 357 | 32 | partner_tokens | 546 | 4 | nonce (u32) |
| 389 | 8 | partner_fee_total | 550 | 121 | ix_padding |
| 397 | 8 | partner_fee_withdrawn | 671 | 1 | closed |
| 405 | 4 | partner_fee_percent (f32) | 672 | 8 | current_pause_start |
| | | | 680 | 8 | pause_cumulative |
| | | | 688 | 8 | last_rate_change_time |
| | | | 696 | 8 | funds_unlocked_at_last_rate_change |
| | | | 704 | 4 | creation_fee (u32) |
| | | | 708 | 1 | creation_fee_claimed |
| | | | 709 | 4 | auto_claim_fee (u32) |
| | | | 713 | 1 | auto_claim_fee_claimed |
| | | | 714 | 32 | old_metadata |
| | | | 746 | 32 | payer |
| | | | 778 | 1 | bump |
| | | | 779 | 32 | fee_partner (js only) |
| | | | 811 | 8 | cancel_request_time (js only) |

Schedule semantics (`state.rs`): effective start = `cliff` if `cliff > 0` else `start_time`; unlocks are whole periods; `vested = periods × amount_per_period + funds_unlocked_at_last_rate_change`, plus `cliff_amount` at `cliff`; pauses shift time when `pausable`. Deposit eligibility (spec 7.2): `cancelable_by_sender`, `transferable_by_sender`, `pausable`, `can_update_rate`, `can_topup`, `closed`, `canceled_at` all 0.

## CKD and IBE (domain 2), measured

Spike account `rose-ckd-1793753433.testnet` (contract deployed in [9DaF5GFs…](https://testnet.near.rocks/tx/9DaF5GFsik553XqqmEsotPwc1XTRULY4EiEeoKMkCsXE), final code in [7hFGToyQ…](https://testnet.near.rocks/tx/7hFGToyQvioVAzyiyGfp9FfVExX7C7E9fFbNAxuDg5je)); bidders `b1.` and `b2.rose-ckd-1793753433.testnet`. Request format: `{"request":{"derivation_path":"round/<id>","app_public_key":{"AppPublicKeyPV":{"pk1","pk2"}},"domain_id":2}}`, 1 yocto. Product crate `contracts/ibe` (`rose-ibe`): `cargo test -p rose-ibe --all-features` 17 unit + 7 testnet-vector tests, clippy `-D warnings` clean for default, `--all-features`, `--no-default-features`, `--target wasm32-unknown-unknown --features near` and `--features wasm`.

| Fact | Evidence | Result (2026-11-04) |
|---|---|---|
| mpk, config | `view v1.signer-prod.testnet public_key '{"domain_id":2}'`, `config` | see "NEAR MPC network": `bls12381g2:xeYho48G…` identical to Sealwell's vector; CKD floor 15 Tgas, yield return 7 Tgas |
| CKD 10 Tgas | [HrbtVuTH…](https://testnet.near.rocks/tx/HrbtVuTHqzcbmiQr9P8Uy2ZWN5rZEC7BJzC13kGJB52P) | MPC panics `Provided gas is lower than required. Provided: 10000000000000, required: 15000000000000` |
| CKD 15 Tgas | [Hg1LySuJ…](https://testnet.near.rocks/tx/Hg1LySuJzXCFRQMhvACh6hiR4PHKbqvRbN4L6WZfWtPH) | MPC `Exceeded the prepaid gas.` (10.30 Tgas burnt) |
| CKD 17, 18 Tgas | [Fhxa3RR1…](https://testnet.near.rocks/tx/Fhxa3RR1ZkNcrStEuvYmMYwy5QyGBWD9JZUwN311b2vC), [6ZcZZbn6…](https://testnet.near.rocks/tx/6ZcZZbn6Vi7BZp1Vc2VAzRKe8chxehJEMTyGtTWuzgCP) | `Exceeded the prepaid gas.` (10.67 and 11.02 Tgas burnt) |
| CKD 19 Tgas (measured minimum) | [2uxxhrTm…](https://testnet.near.rocks/tx/2uxxhrTmEamhWo7GYzLaXmckEVMgfaa6YrQAE8V6rkDA) | success, MPC response 3.12 s, 34.93 Tgas total; the engine attaches 25 (spec 5.1) |
| CKD 20 Tgas, full round trip | [2hL3YiPR…](https://testnet.near.rocks/tx/2hL3YiPRnVyw7thp6CjwJjT8187bUpV9F25WXpdoa7yM) | 35.10 Tgas total: `close` 6.05 (pk1/pk2 via host 3.32), MPC request 11.61, MPC resume 3.79, callback 12.44 (unwrap 2.53, pairing check 8.02); key unwrapped and pairing-checked in the callback |
| Latency | block timestamps of [2hL3YiPR…](https://testnet.near.rocks/tx/2hL3YiPRnVyw7thp6CjwJjT8187bUpV9F25WXpdoa7yM), [DsxDu5h3…](https://testnet.near.rocks/tx/DsxDu5h35GFEs2R9rDLyNG8Akq23CpAmXijNy3DUX8Ar), [BmW3nLLF…](https://testnet.near.rocks/tx/BmW3nLLFPvQaa2H3PuRGF7YETBMyZBQiAP5MYkLgKu57) | request receipt to MPC response 2.9 to 3.8 s; close transaction to stored key 4.225, 4.819, 4.722 s; CLI wall clock 7.8 to 8.6 s |
| Browser encryption | Node (`encrypt.cjs`) and headless Chromium 141 (`browser.mjs`, Playwright 1.56.1): bids [GWs6mEUu…](https://testnet.near.rocks/tx/GWs6mEUuc4khq6TKSnMnP5QaJiUzrSvyTyE1799dNhU5), [9skS8jJc…](https://testnet.near.rocks/tx/9skS8jJcwDuVdZ434hBvJk3cGLL6DpyxcCfqCGahvvFD), [kdJVKWFw…](https://testnet.near.rocks/tx/kdJVKWFwfkRgHk8vqrbW8J86fHdmys2ZDtjrspk72KY) | 11.7 to 16.5 ms per encryption, 27 ms per decryption (Node); 192-byte constant ciphertext `U(96) ‖ V(32) ‖ W(64)`; `submit_bid` 2.13 to 2.21 Tgas |
| Verified opening | [Dm5hBXUz…](https://testnet.near.rocks/tx/Dm5hBXUzRLGXd7XPfWQ7cJkgaV5MTQnttTZQACYBa8Pd), [2odkYzVz…](https://testnet.near.rocks/tx/2odkYzVzthtqjVWuAvQisuAYmz55Q3CZbEcUE5M7Bccx), [Hs8XYNZB…](https://testnet.near.rocks/tx/Hs8XYNZBcZXuABoQkfEV71Bjc8ouPjFwVed9ypgRnWfc), [GxexUXFs…](https://testnet.near.rocks/tx/GxexUXFstZp2RZCBsHrG3KYATEPAmSyoWg4WXrGsNrpJ), [BLMM4P6Y…](https://testnet.near.rocks/tx/BLMM4P6YpkgAGtuK27VPZfLyxT1odpmhQEzhFS99Hsxv) | 124.32 to 124.40 Tgas per transaction (verification 122.05 to 122.08), 0.0124 NEAR; opened by third parties |
| Malformed bid (one bit of V flipped, author keeps sigma and plaintext) | bid [D6ooxm7M…](https://testnet.near.rocks/tx/D6ooxm7MgdwZAdheJmcvmWFide9ndNhCyRGcvvwpafTJ) accepted (indistinguishable); opening [DogWVE6E…](https://testnet.near.rocks/tx/DogWVE6EoKfed3fGGatzsVT2rWioArhey42DzugQXdN5) | `opening does not match ciphertext` with the key public, 124.02 Tgas burnt; off-chain decryption also fails |
| Copied ciphertext (b2 submits a byte-for-byte copy of b1's bid) | bids [7gDvvnHD…](https://testnet.near.rocks/tx/7gDvvnHDMtviNk7Ujx8LXzcfhgZoLKXqbEif72mUUfjR), [B8HZQLk8…](https://testnet.near.rocks/tx/B8HZQLk8XiFXbiQ4zVKzQXngzuF89dL8aucdJqiFPogD); opening [8uQstwBS…](https://testnet.near.rocks/tx/8uQstwBSVsTibSVgv6uPM1gS1Bwgmpo2cWv1agAUuJ94) | fails at the `U` check, 4.36 Tgas (the associated data binds the bidder) |
| Lost callback, `submit_key` path | close with a starved callback [HqfzMbWu…](https://testnet.near.rocks/tx/HqfzMbWuxVLvdZ4ncWkZj826pFzshhE8zxAyciFeZ2EY) (MPC responded, callback `Exceeded the prepaid gas`, key null); off-chain `unwrap.cjs` with the public scalar; wrong key [4uKaYqtk…](https://testnet.near.rocks/tx/4uKaYqtk1kS9Ryw942SY4p2AvGjJGgnHm8xMr74zbrEj); recovered key by b2 [DXHJDWw5…](https://testnet.near.rocks/tx/DXHJDWw5obEKBgHMNGMSV7DCs2djxK2KL5iG6ZNZeY2V); opening after it [GxexUXFs…](https://testnet.near.rocks/tx/GxexUXFstZp2RZCBsHrG3KYATEPAmSyoWg4WXrGsNrpJ) | wrong identity rejected `key does not verify` (9.87 Tgas); recovered key stored, `key_source: submit_key`, 10.23 Tgas (pairing check 8.00) |
| Callback gas by weight | [DsxDu5h3…](https://testnet.near.rocks/tx/DsxDu5h35GFEs2R9rDLyNG8Akq23CpAmXijNy3DUX8Ar) (static 3 Tgas, prepaid 40) | near-sdk forwards unused prepaid gas to the callback by weight (12.42 Tgas used), so a fixed static 15 Tgas plus about 60 Tgas on `close` is the engine's setting |
| Wasm sizes | `ls -l` after `cargo near build` and wasm-bindgen 0.2.130 | browser `rose_ibe_bg.wasm` 216,109 bytes (82,754 gzip -9, no wasm-opt); spike contract with the `near` feature 244,772 bytes |
| Versions | `Cargo.lock` | arkworks 0.4 (ark-bls12-381 0.4.0, ark-ec/ff/serialize 0.4.2), chacha20poly1305 0.10.1, sha2/sha3 0.10.9, bs58 0.5.1, getrandom 0.2.17 (`js`), wasm-bindgen 0.2.130, js-sys 0.3.107 |

Round 1 values: `app_id` `305bd2a108c0772db82c2d803d5eea87ba669442b9abcf6bd45b28b8926aa8f5`; `big_y` `bls12381g1:6JsKyncUXqmVX4RcTD83LCcSL25iVYoi1ShPZxFE2hBoo27Lh2nXDNHu3JnA3Paara`; `big_c` `bls12381g1:5jQ5mhW68mDqLQGxgnDiFShQy87sFxrDrQ1QLoYibyyZWDUsaJ19nVCaYr38FnqBbF`; key `bls12381g1:6znYwWzn6SVgzXFKy7zEmZA6CR2aS317nJXuWKAmmeEdnrc3Qp6dX7EfE26GZBA889`; the MPC log's `pk1`/`pk2` equal the pure-Rust `app_public_key_pv(app_scalar(engine, 1))` (asserted in `tests/testnet_vectors.rs`).

## MPC derived keys, Sablier live triples, SPL mint layout

| Fact | Command | Result (2026-11-04) |
|---|---|---|
| `derived_public_key` argument shape | `near/mpc` tag `3.18.0`, `crates/contract/src/api/keys.rs:29` (`#[handle_result]`, `DerivedPublicKeyArgs { path, predecessor, domain_id }`); `view v1.signer-prod.testnet derived_public_key '{"path":"vault/base","predecessor":"engine-s1.rose-app.testnet","domain_id":0}'` | a JSON string: `"secp256k1:5yxTg4vNDMTiFmfGtzdxKASHS79uPSTMVSs7MMGjZpDKPQtLr2A2iiCeT1wmgbQzPq7EVAXYb9rbDME7j4ga7sTN"` for domain 0, `"ed25519:…"` for domain 1; the predecessor does not need to exist, so the vault signer is known before the engine account is created |
| secp256k1 key to EVM address | `scripts/derive-vault-signer.sh c.rose-sign-1793752785.testnet` (base58 decode of the 64 uncompressed bytes, `cast keccak`, last 20 bytes) | `0x556e29bce7c6ab74a8b36b3c754d3ac2842223b5`, equal to the spike's recovered signer; for `engine-s1.rose-app.testnet`: `0x80ce2541602e7be22664f23931fe1118e86e1f09`, `vault/sol` `77DPmxotR35D3zAWGSCJ1UxN6T4KYVkSkkEkZS59AHad`, `gas/sol` `36jQEj7ZbZsS1huRPZCZiKW4kijMJJWeDJdDoAJg5PRH`; the engine's own `bootstrap` stored the same three values (tx [8U2uUEzZ…](https://testnet.near.rocks/tx/8U2uUEzZs8ebKhDj3wZuNraeFr885SiKrmGf3jXexEFz)) |
| Sablier live triples | for 12 LL streams at block 54,178,044 (timestamp 1,793,757,477): `cast call 0xA65A…532e "getStartTime(uint256)" / getCliffTime / getEndTime / getGranularity / getUnlockAmounts / getDepositedAmount / "streamedAmountOf(uint256)(uint128)" <id> --block 54178044 --rpc-url https://sepolia.base.org` (commands inside `contracts/engine/tests/vectors/sablier_live.json`) | `cargo test -p rose-engine --test sablier_live`: 12 of 12 `streamedAmountOf` values reproduced exactly by `SablierLinearStream::streamed_amount` (9 strictly mid-stream, one before its cliff, one fully streamed); the collection over all 67 eligible LL streams at that block also matched 67 of 67 |
| SPL Token mint account layout | `spl-token` `Mint::LEN` (`state.rs`): `mint_authority: COption<Pubkey>` (4 + 32), `supply: u64` (8), `decimals: u8`, `is_initialized: bool`, `freeze_authority: COption<Pubkey>` (4 + 32); checked on the devnet mint `3q81mxTA7rricmjJQaiZk9HbZzF2Pt8aN5SJaJcXvZ4w` (`getAccountInfo`, 82 bytes, byte 44 = 6 = `decimals` of `getParsedAccountInfo`) | 82 bytes, `decimals` at offset 44, owner `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`; Token-2022 mints are refused (different owner) |

## MPC request rules read in the 3.18.0 source (2026-11-06)

The request rules the engine and the sandbox's mock MPC follow: the `near/mpc` source at tag `3.18.0`, the live contract and the engine's own tests.

| Fact | Command | Result |
|---|---|---|
| The live MPC contract is still 3.18.0 (the source the mock follows) | `near_view v1.signer-prod.testnet version` (`scripts/lib.sh`) | `"3.18.0"` |
| CKD requests: the domain must have the CKD purpose, and `AppPublicKeyPV` must pass a pairing check | `gh api "repos/near/mpc/contents/crates/contract/src/api/ckd.rs?ref=3.18.0"` and `…/crates/contract/src/primitives/ckd.rs?ref=3.18.0` | `check_request_preconditions(domain_id, DomainPurpose::CKD, …)`; `app_public_key_check`: `bls12381_p1_decompress(pk1)` / `p2_decompress(pk2)` (`expect("malformed BLS12-381 G1 point")`), then `bls12381_pairing_check(pk1, -G2, G1, pk2)`, `require!(…, "app public key check failed")`; the generator constants the mock copies, checked against arkworks by `the_pairing_constants_are_the_generators` |
| ForeignTx payload versions | `gh api "repos/near/mpc/contents/crates/near-mpc-contract-interface/src/types/foreign_chain.rs?ref=3.18.0"` | `enum ForeignTxPayloadVersion { V1 = 1 }` (`serde_repr`): any other number fails to deserialize |
| Eddsa payload cap | `gh api "repos/near/mpc/contents/crates/near-mpc-crypto-types/src/primitives.rs?ref=3.18.0"` | `EDDSA_PAYLOAD_SIZE_UPPER_BOUND_BYTES: usize = 1232`, `Payload::Eddsa(UpperBoundedVec<u8, 1232>)` |
| Cost of the CKD key check in `new` | `cargo test -p rose-ibe --features near master_key_check_costs` (`env::used_gas()` around `is_valid_master_key_host` on the mocked VM, host calls only) | 2.2 Tgas (asserted between 2.0 and 2.5): `bls12381_p2_decompress` and a one-term `bls12381_g2_multiexp` |
| `bls12381_p2_decompress` accepts a curve point outside the G2 subgroup, the multiexp refuses it | `master_key_check_refuses_points_outside_the_g2_subgroup` (a point from `G2Affine::get_point_from_x_unchecked` with `!is_in_correct_subgroup_assuming_on_curve()`) | decompression `Some`, `is_valid_master_key_host` `false`; also `false` for the point at infinity and 96 bytes `0xff` |

## Base Sepolia: Sablier Lockup v4

| Fact | Command | Result (2026-11-04) |
|---|---|---|
| Chain id | `cast chain-id --rpc-url https://sepolia.base.org` | `84532` |
| Lockup deployment is v4.0 | `gh search code "0xA65A1ecEf02C2B9BDc604951c6A6D02335D4532e"` | `sablier-labs/sdk` `src/evm/releases/lockup/v4.0/deployments.ts`: `SABLIER_LOCKUP` on Base Sepolia, deployed at block 38,985,887 (also `deployments/lockup/v4.0/broadcasts/base-sepolia.json`) |
| Source tag | `gh api repos/sablier-labs/lockup/releases` (redirects to `sablier-labs/evm-monorepo`); `gh api repos/sablier-labs/evm-monorepo/compare/93abe68...fae38dc --jq '[.files[].filename \| select(startswith("lockup/src"))] \| length'` | `lockup@v4.0.1` (2026-03-23, commit `fae38dc7e43c6cab6de8f97124c559f42ed5b77a`); `lockup@v4.0.0` (2026-03-21, commit `93abe6848b0dbb2efb293bf0f66a934a6bf76954`); `0` files changed under `lockup/src` between them (utils bump only), so the ABI and the math are identical |
| Identity | `cast call 0xA65A1ecEf02C2B9BDc604951c6A6D02335D4532e "name()(string)"` | `"Sablier Lockup NFT"`, symbol `SAB-LOCKUP` |
| Comptroller, NFT descriptor | `cast call 0xA65A…532e "comptroller()(address)"`, `"nftDescriptor()(address)"` | `0x0000008ABbFf7a84a2fE09f9A9b74D3BC2072399`, `0xCA2593027BA24856c292Fdcb5F987E0c25e755a4` (both match the SDK manifest) |
| Stream counter | `cast call 0xA65A…532e "nextStreamId()(uint256)"` | `82` before the vault spike, `84` after |
| Selectors used by rose exist | `cast code 0xA65A…532e`, grep `63<selector>` | present: `nextStreamId` 0x1e99d569, `getLockupModel` 0xe6c417eb, `isCancelable` 0x4857501f, `isTransferable` 0xb2564569, `getDepositedAmount` 0xa80fc071, `getWithdrawnAmount` 0xd511609f, `getRefundedAmount` 0xd4dbd20b, `getStartTime` 0xbc2be1be, `getCliffTime` 0x780a82c8, `getEndTime` 0x9067b677, `getGranularity` 0x5c61ce95, `getUnderlyingToken` 0xa4775772, `getUnlockAmounts` 0xdf2a848c, `withdrawableAmountOf` 0xd975dfed, `calculateMinFeeWei` 0xcca138e5, `withdrawMax` 0xea5ead19, `createWithTimestampsLL((address,address,uint128,address,bool,bool,(uint40,uint40),string),(uint128,uint128),uint40,uint40)` 0x253c6162, `wasCanceled` 0xf590c176, `isDepleted` 0x425d30dd, `ownerOf` 0x6352211e, `safeTransferFrom` 0x42842e0e, `getRecipient` 0x6d0cee75, `renounce` 0x7de6b1db, `statusOf` 0xad35efd4; absent: v3 `createWithTimestampsLL` 0x74d213e5 |
| Lockup withdrawal fee | `cast call 0x0000008ABbFf7a84a2fE09f9A9b74D3BC2072399 "calculateMinFeeWeiFor(uint8,address)(uint256)" <p> <sender>` for p = 0..3 | Airdrops 0, Flow 397465626552900 wei (about $0.90), Lockup (p = 2) `0`, Staking 0. Enum `Protocol {Airdrops, Flow, Lockup, Staking, Bob}` (`utils@v2.0.1`). Admin `0xb1bEF51ebCA01EB12001a639bDBbFF6eEcA12B9F` can switch the Lockup fee on at any time, and `SablierComptroller.sol:470` returns 0 when the oracle is stale (> 24 h), so RoseVault forwards `calculateMinFeeWei` read in the same transaction and refunds the rest |
| LL streamed amount | `lockup@v4.0.1` `lockup/src/libraries/LockupMath.sol` `calculateStreamedAmountLL` (lines ~127-235), dispatch `SablierLockup._streamedAmountOf` (~455), validation `LockupHelpers._checkTimestampsAndUnlockAmounts`, sentinel in `SablierLockupLinear.sol` ~114 | plain integer arithmetic (not UD60x18): `streamed = startUnlock + cliffUnlock + floor(floor(elapsed / g) * streamable * g / streamableDuration)`, elapsed counted from the cliff when set, else from the start; `granularity` 0 is stored as 1 |
| `withdraw` of zero reverts | same source | `SablierLockup_WithdrawAmountZero`, so RoseVault skips the call when nothing is withdrawable |
| `withdrawMax(id, recipient)` is callable by anyone | same source; fork test `test_fork_anyoneWithdrawsVaultStreamToVault` | reverts only when `to != recipient` and the caller is neither recipient nor approved; the fee check is `msg.value < minFeeWei → SablierLockup_InsufficientFeePayment` |
| Transfer side effects | `_update` in the same source | reverts on non-transferable streams, no automatic withdrawal; recipient hook only for allowlisted recipients when `msg.sender != recipient` |
| Real non-LL stream for the refusal test | `cast call 0xA65A…532e "getLockupModel(uint256)(uint8)" 61 -b 54150000` | `2` (Tranched) |
| ForeignTx `Log` extractor matches the block-level `logIndex` | `near/mpc` 3.18.0 `crates/foreign-chain-inspector/src/evm/inspector.rs:221-227` | `logs.iter().find(\|log\| log.log_index == target_index)` on the receipt logs |

## Sablier creation and status rules used by RoseVault

| Fact | Command | Result (2026-11-04) |
|---|---|---|
| `isCancelable` is false once a stream is SETTLED | `gh api "repos/sablier-labs/evm-monorepo/contents/lockup/src/abstracts/SablierLockupState.sol?ref=lockup@v4.0.1" --jq .content \| base64 -d` | lines 233-237 return the stored flag only when `_statusOf != SETTLED`; `_statusOf` at 266-281 |
| Stream creation mints without a receiver hook and charges no fee | `gh api -H "Accept: application/vnd.github.raw" "repos/sablier-labs/evm-monorepo/contents/lockup/src/SablierLockup.sol?ref=lockup@v4.0.1"` | `_create` (509-550) calls `_mint` at line 538, not `_safeMint`; the only `msg.value` read is in the withdrawal path (line 682) |
| Creation checks | `lockup/src/libraries/LockupHelpers.sol` at `lockup@v4.0.1` | `_checkCreateStream` (254-289) and `_checkTimestampsAndUnlockAmounts` (182-240): sender != 0, deposit > 0, start > 0, strict ordering, cliff unlock only with a cliff, granularity <= streamable range; no rule that the end is in the future (RoseVault adds one) |

## Base Sepolia: RoseVault spike (prototype, signer = spike key)

Spike EOA `0xFa76B8f304d2A87FCAee0c258A76118368d0d671`; prototype vault `0x3985dDBBE8477Dd42bd5E19F8726Aae7a339b5e0` (`eip712Domain()` = (0x0f, "RoseVault", "1", 84532, vault, 0, [])). Throwaway TestUSDC `0xf8F5a4c21d80993Fa2fc9fe649f95384AB6dEc57`, DemoToken `0x17E75069DD837EDA977AbEDF7a455aDda42868A9`, DemoStreamFaucet `0x958E8b3b9CD9E8CFEbc8f10A904c262d49e2f369`. Production contracts are redeployed with the engine's MPC-derived signer. `forge test` from the repo root: 73 tests in 5 suites, including 7 fork tests at pinned block 54,150,000.

| Step | Transaction | Gas | Note |
|---|---|---|---|
| faucet `mintPosition(Seed)` creates stream 82 | [0x861565a0…](https://sepolia.basescan.org/tx/0x861565a0768f763441dd44282567de7ab8d8a33ec94f1f15d15cef7d9ca3b916) | 321,762 | `createWithTimestampsLL` on the real Lockup, `granularity = 1` |
| faucet `mintPosition(Kol)` creates stream 83 | [0x595a08bd…](https://sepolia.basescan.org/tx/0x595a08bd63cdbc17182b458ef81a888685885f4d571480d1fb27bf173b1eb3c1) | 250,632 | partly vested at deposit time |
| `depositStream(82)`, nothing withdrawable (cliff in the future) | [0xcddf41ac…](https://sepolia.basescan.org/tx/0xcddf41ac9ba8c7b1a9053bc52e62c0edb4bbd4ab55752d817042aae34a35eeb2) | 146,130 | block 54159281, tx index 2, `StreamDeposited` at block-level log index 2 |
| `depositStream(83)`, partly vested: 3,479.49 tokens withdrawn to the holder first | [0x6afca0fb…](https://sepolia.basescan.org/tx/0x6afca0fb97bb7f5898ab948d780858457ae07a55d22fadd293231089e35abafc) | 193,137 | block 54159291, tx index 4, `StreamDeposited` at log index 10 (Sablier withdraw `Transfer` at 5) |
| `depositCash(tUSDC, 500e6, "rose-app.testnet", 1)` | [0x81a6dfc3…](https://sepolia.basescan.org/tx/0x81a6dfc3d749274b8710e21f1c2d17624076c5044c1e25e165e3d9e0b3497c65) | 65,285 | `CashDeposited` at log index 1 |
| `attest(82)` | [0x818841eb…](https://sepolia.basescan.org/tx/0x818841eb035a1043de1e5c7521d5fd8ba1e716698e7103a6786ef8e2b273b20e) | 82,588 | `StreamAttested` at log index 0 |
| `executeRelease(83)`: withdraws the vested balance to the vault, then transfers the NFT | [0x7ae5303a…](https://sepolia.basescan.org/tx/0x7ae5303a8bf4711e32040a008d4ac8078bd34ffdc9c6a3c995719e0eca30d001) | 202,229 | EIP-712 signature in MPC format (v = 27 + recovery id, low s); `withdrawnToVault` 9703196347031964 |
| `executeTransfer` of the withdrawn tokens | [0xca28787e…](https://sepolia.basescan.org/tx/0xca28787ed96ee18184a901dc9bf455e160884a81f78eecaafbba4355133f0a1b) | 46,787 | replay bit 2 set |

Final state (`cast call`): `ownerOf(82)` = vault, `ownerOf(83)` = spike EOA, `isAuthorizationUsed(1)` and `(2)` true, `(3)` false, vault tUSDC balance 500e6. `_pendingStreamId` is a Solidity `transient` variable: Cancun transient storage works on Base Sepolia (confirmed by the live deposits).

Decoded `StreamDeposited` of stream 82 (`cast receipt <hash> --json`, then `cast abi-decode "f()(string,address,address,uint128,uint128,uint40,uint40,uint40,uint40,uint128,uint128,bool,bool,uint40)" <data>`): nearAccount "rose-app.testnet", lockup 0xA65A…532e, token 0x17E7…68A9, deposited 100000e18, withdrawn 0, start 1778201663, cliff 1809737663, end 1872809663, granularity 1, startUnlock 0, cliffUnlock 25000e18, cancelable false, transferable true, timestamp 1793753725. Stream 83: deposited 20000e18, withdrawn 3479488584474885844748, start 1791161663, cliff 0, end 1822697663, granularity 1, startUnlock 2000e18, cliffUnlock 0.

EIP-712 known-answer vectors (viem 2.21.54 `hashTypedData`, chain 84532, verifyingContract `0x00000000000000000000000000000000000A11cE`), asserted in `test_digests_knownAnswerVectors`: `Transfer(0x036CbD53842c5426634e7929541eC2318f3dCF7e, 0x…b0b0, 1000000, 7)` → `0x652ed7c219938bcc420b0786454c4e4a58b5baeed9dd1cfdf3ba8c4b1e08ac01`; `Release(0xA65A…532e, 81, 0x…b0b0, 8)` → `0x87ab8e82a059a262d10be8885c9b5993c14f8bbe9ba38e33cc96179b5f5ee308`. Domain: name "RoseVault", version "1", chainId, verifyingContract, no salt; typehashes of `Transfer(address token,address to,uint256 amount,uint256 id)` and `Release(address lockup,uint256 streamId,address to,uint256 id)`.

`StreamDeposited` data layout as measured on the prototype (rebuilt byte by byte by the engine, checked by `test_depositStream_rawLogLayout`); the production vault inserts `uint8 decimals` right after `token` in both `StreamDeposited` and `StreamAttested` (read on-chain with `IERC20Metadata.decimals()`), which shifts every later word by one and changes the topic0 signatures, so the engine's layout and the known-answer test are regenerated from the production ABI. Prototype: topics `[keccak256("StreamDeposited(address,string,address,uint256,address,uint128,uint128,uint40,uint40,uint40,uint40,uint128,uint128,bool,bool,uint40)") = 0xbc9f6be2b2d56b1b3eaaa36bcb0977fbfde26085aec360190ffb1f6d3d198340, sender, streamId]`; data words: offset of `nearAccount` (0x1c0 = 14 × 32), lockup, token, deposited, withdrawn, start, cliff, end, granularity, startUnlock, cliffUnlock, cancelable, transferable, timestamp, then the string length and bytes padded to 32 (512 bytes for an account of at most 32 bytes, 544 for 33 to 64). `CashDeposited(address indexed sender, address indexed token, uint64 indexed roundId, string nearAccount, uint128 amount, uint40 timestamp)` topic0 `0xf23a8d2e80a8a5a05e52ad90ec55650523ddc14c511b18fb24db60589d767fb4`. `StreamAttested` topic0 `0x922faa766ac49e4392b108a2c3915737f8f51fbfc0533f78734f3e79d9374ee3` (data: lockup, token, deposited, withdrawn, withdrawable, start, cliff, end, granularity, startUnlock, cliffUnlock, cancelable, transferable, depleted, timestamp). `ReleaseExecuted` topic0 `0xbf4b05c820d12c6dde54005b325d29eb31b55c8c609d4dab22d62d676c2724fe`, `TransferExecuted` topic0 `0xeb669e0a01fff40cbe45de851f42334fe70673136abfd91399651b7ae199a07b`.

## RoseVault and EVM facts after the spike (2026-11-04 to 2026-11-14)

The production RoseVault's release type, events and selectors, and the Sablier and ERC-20 facts the vault, the SDK and the app rely on.

| Fact | Command | Result |
|---|---|---|
| The recipient of a Sablier stream may withdraw to any address (RoseVault, recipient of every vault stream, can send a refused stream's vested balance to the returnee) | `gh api -H "Accept: application/vnd.github.raw" "repos/sablier-labs/evm-monorepo/contents/lockup/src/SablierLockup.sol?ref=lockup@v4.0.1"`, `withdraw` (line 313) | `if (to != recipient && !_isCallerStreamRecipientOrApproved(streamId, recipient)) revert SablierLockup_WithdrawalAddressNotRecipient`; `withdrawMax(streamId, to)` (line 384) withdraws the withdrawable amount through the same path. Exercised against the live Lockup by `test_fork_returnSendsVestedToTheReturnee` (fork of Base Sepolia at block 54,150,000) |
| New `Release` type and digests | viem 2.57.16 `hashTypedData` (domain name "RoseVault", version "1", chain 84532, verifyingContract `0x00000000000000000000000000000000000A11cE`), `cast keccak` (Foundry 1.4.2) | typehash of `Release(address lockup,uint256 streamId,address to,bool vestedToRecipient,uint256 id)` = `0x3098792e9cb667f2d9003dce0f73187143b5c09805d689c3a7e0b9b2a95eceaa`; `Release(0xA65A…532e, 81, 0x…b0b0, false, 8)` → `0xab3684e318c5c016035a36f948f02e970040e271317ea09a327d2c59f6fef666`, with `true` → `0x1aa2f755fbde4c0062a5437278478f1b0f3820980c2ef5560ac419d7dc5eafe3`; asserted in Foundry `test_digests_knownAnswerVectors`, the engine `eip712_digests_match_the_known_answer_vectors` and the SDK `base.vault.test.ts`. `ReleaseExecuted(uint256,uint256,address,address,address,uint128)` topic0 `0xf1c0b9eef92221e67037e8d68af5c66badc8f31998ebb3efbb1c7208cd7d387d`. The recorded spike signatures of the four-field type still recover with the legacy digest |
| New `ReleaseExecuted` topic0 (RoseVault gains `vestedForwarded`) | `cast keccak "ReleaseExecuted(uint256,uint256,address,address,address,uint128,uint128)"` | `0x497d44848ca3d248e620c104aa9a3829f04a49b7655a71fed5b9c85a5dca5fe2` |
| Transfer EIP-712 known answer for the SDK test | `cast call --rpc-url https://sepolia.base.org 0x14c7f1f870ccb5569a01399013ceeeffc465e243 'hashTransfer((address,address,uint256,uint256))(bytes32)' '(0x036CbD53842c5426634e7929541eC2318f3dCF7e,0x000000000000000000000000000000000000b0b0,12345,7)'` | `0xe9dbe8f15bafc915d91ae21a03e5e125267a85d5d268d204ea42430e62817f73`, equal to viem `hashTypedData` (domain `RoseVault`, `1`, 84532, the vault) in `packages/sdk/test/chains/base.vault-calls.test.ts` |
| Identity of the Sablier Lockup that `deploy-base.sh` checks before broadcasting | `cast call --rpc-url https://sepolia.base.org 0xA65A1ecEf02C2B9BDc604951c6A6D02335D4532e 'name()(string)'`; `cast chain-id --rpc-url https://sepolia.base.org` | `"Sablier Lockup NFT"`; `84532` |
| Sablier's withdrawal fee is still 0 (the SDK's 0 fee margin default) | `cast call --rpc-url https://sepolia.base.org 0xA65A1ecEf02C2B9BDc604951c6A6D02335D4532e 'calculateMinFeeWei(uint256)(uint256)' 82` at block 55,225,196 | `0` |
| The address comparison in `depositStream` / `executeRelease` changes no code | `forge inspect RoseVault deployedBytecode` before and after `address(lockup) != address(LOCKUP)`, compared without the trailing CBOR metadata (its length in the last two bytes, 51) | identical; solc warning 9170 gone from `forge build --force` |
| Sablier's minimum fee of a cohort stream is the comptroller's fee for its sender, RoseVault (the Cohort tab estimate) | `curl -s "https://sourcify.dev/server/v2/contract/84532/0xA65A1ecEf02C2B9BDc604951c6A6D02335D4532e?fields=sources"` (`src/SablierLockup.sol`: `calculateMinFeeWei(streamId)` returns `comptroller.calculateMinFeeWeiFor({protocol: Lockup, user: _streams[streamId].sender})`); `cast call --rpc-url https://sepolia.base.org 0xA65A1ecEf02C2B9BDc604951c6A6D02335D4532e "comptroller()(address)"`; `cast call --rpc-url https://sepolia.base.org 0x0000008ABbFf7a84a2fE09f9A9b74D3BC2072399 "calculateMinFeeWeiFor(uint8,address)(uint256)" 2 0x62358c4f6fadb303f3a7d18ad34a1afcc1174d06` | comptroller `0x0000008ABbFf7a84a2fE09f9A9b74D3BC2072399`; fee `0` for Lockup (protocol 2) and RoseVault; `402471165443025` wei for Flow (protocol 1) |
| OpenZeppelin ERC-20 error selectors decoded by the web error classifier | viem `toFunctionSelector("ERC20InsufficientBalance(address,uint256,uint256)")`, `toFunctionSelector("ERC20InsufficientAllowance(address,uint256,uint256)")` | `0xe450d38c`, `0xfb8f41b2` |
| The two accepted Base cash venues have 6 decimals; any other Base cash token is formatted with its own `decimals()` | `eth_call` `decimals()` (`0x313ce567`) at `https://sepolia.base.org` on `0x69fa19ad79c1c890d37cbabaa6fe99d1aa54bc01` (rose tUSDC) and `0x036CbD53842c5426634e7929541eC2318f3dCF7e` (Circle USDC) | `0x…06` for both |

### Licence of the vendored Sablier interface, and RoseVault's bytecode

| Fact | Command | Result |
|---|---|---|
| Upstream licence of every file `contracts/evm/src/interfaces/ISablierLockup.sol` draws from | `gh api repos/sablier-labs/evm-monorepo/git/refs/tags/lockup@v4.0.1`; `curl -s https://raw.githubusercontent.com/sablier-labs/evm-monorepo/lockup%40v4.0.1/<file> \| head -1` for `lockup/src/types/Lockup.sol`, `lockup/src/types/LockupLinear.sol`, `lockup/src/interfaces/ISablierLockup.sol`, `ISablierLockupState.sol`, `ISablierLockupLinear.sol` | tag on commit `fae38dc7e43c6cab6de8f97124c559f42ed5b77a`; all five start with `// SPDX-License-Identifier: GPL-3.0-or-later`, so the vendored file carries that identifier again (it said MIT) |
| The deployed RoseVault is a build of this repository before that change | `cast code 0xb72a42bc59ec2423ed76b56ac82cd3457a6310fe --rpc-url https://sepolia.base.org` against `forge inspect RoseVault deployedBytecode` at `5328268` | 13,255 bytes each; they differ only in 21 immutable slots (the Lockup and signer addresses, the vault's own address and the cached EIP-712 values), and the trailing CBOR metadata is identical (`a2646970667358221220` `5bdec11066f0e57b948fedd6d7514bb076f94d614b75b003a0c6478a0e38fd3d` `64736f6c63430008260033`, solc 0.8.38) |
| The licence line changes RoseVault's metadata hash, not its code | `forge build`, then `forge inspect RoseVault deployedBytecode` after the change, compared without the trailing CBOR metadata (its length in the last two bytes, 51) | code identical; the metadata's IPFS hash becomes `dc96fb01b4893d3cb8ac3147b1507ccb9d5e03cc944a693db5b9c76de94458d2`, since solc hashes every source file's text. The deployed vault keeps `5bdec110…`: a build of `5328268` or any earlier commit reproduces it in full, a build of a later commit up to that hash |

## Solana custody v2: facts behind the two-phase protocol (2026-11-04)

| Fact | Value | Source or command |
|---|---|---|
| A durable-nonce transaction that fails during execution still advances its nonce and charges its fee | measured on devnet: nonce `6tAnpD2q…` before, `55g629NZ…` after a transaction failing with `InstructionError [1, Custom 1]` (transfer from an empty account), fee 10,000 lamports. So a signed payout is not final: the engine settles it only on a proof that the nonce advanced, reading the streams in the same proof | `scratchpad/v2/exp/nonce.mjs`: nonce account `3QmRHvcATNxwthZGT6oqQAorpggJxWMwqtFhN7tJfx6B` ([2BuGEKi4…](https://explorer.solana.com/tx/2BuGEKi4Nb47XePVrr8LtMtGZeedWcnTTke1xBzbJQGrwgkpX5d5PKF8Vf5RttiQWMqpxeRex83vBpbfZvvaA2Js?cluster=devnet)), failing transaction sent with `skipPreflight` ([5B9GDa7p…](https://explorer.solana.com/tx/5B9GDa7pLZuaJijpzgPD97iE4FWRtEgxhGGnoVg1V4AEfnaccaYtECEzKSRgxwrg6Nqscr5tedFPuB9FS7e7cLLS?cluster=devnet)), both read at `finalized` |
| One ForeignTx request carries at most 32 extractors | `MAX_EXTRACTORS_PER_REQUEST = 32` | `near/mpc` tag 3.18.0, `crates/near-mpc-contract-interface/src/types/foreign_chain.rs:37` (`UpperBoundedVec<SvmExtractor, MAX_EXTRACTORS_PER_REQUEST>` at line 259), README "A request may carry at most 32 extractors" |
| `AccountState` of a missing account fails the whole request | `AccountNotFound`, surfaced to the engine as a timeout | `crates/foreign-chain-inspector/src/svm/inspector.rs` at 3.18.0 (see "ForeignTx verification"): a payout proves the recipient's token account exists before anything is signed |
| SPL Token account layout, 165 bytes | `mint` 0..32, `owner` 32..64, `amount` 64..72, `state` 108 (1 initialized, 2 frozen) | `spl-token` 4.x `state::Account`; live: `getAccountInfo AvAE4aRt9ZfntapwvEGKovryHNtPEyLttQjpcd4tTJFu` (devnet, finalized) = owner Token program, 165 bytes, mint `xr59kT7UE5F3CyE9f2G2F7YSjLJVBBtLfj8TUaUwwK5`, owner `6uMy1iYd…`, amount 6,580,000,000, state 1 |
| Streamflow fee fields | `streamflow_fee_total` 305, `streamflow_fee_withdrawn` 313, `streamflow_fee_percent` (f32) 321, `partner_fee_total` 389, `partner_fee_withdrawn` 397, `partner_fee_percent` (f32) 405 | js-sdk 13.4.0 `streamLayout` (offsets of the table above); live stream `5PQ4pdPNb339LZT5PBV8psn9XqVMudH3hmPbUzeKWRXC` decodes all six as 0 |
| A fee-free Streamflow `withdraw` touches neither the treasury's nor the partner's token account: neither has to exist | simulated withdraw by the recipient with both accounts absent: `err null`, 33,474 CU, "Withdrawn: 3 … tokens" | `scratchpad/v2/exp/partner.mjs` (owner's scratchpad, @streamflow/stream 13.4.0): stream `GMoCccbAjPcXrmQRbRsYPmjbYEwuavfvVG8X7TFZezcD` created with partner = a fresh key ([msdxVcfk…](https://explorer.solana.com/tx/msdxVcfkt5RFbD6CxyGb46unJu48u5bvobao2Wr72cqUQwcZKXTpGokR7HDPiyTWxnqCxCggjSW2LQLcUmC2Bv8?cluster=devnet)), partner ATA closed ([4fyMi794…](https://explorer.solana.com/tx/4fyMi794PNzM2uFD9Wcb17F9deS31pY9S4NGJhQGjiX18GKHK9ou85WeWjmMTk3kWZBTZucXZP9gTS85zLfqk7Lk?cluster=devnet)), treasury ATA never created, then `simulateTransaction(sigVerify false)`; spend 0.0118 SOL. Live confirmation: the staging-2 payout [4kZgCJAf…](https://explorer.solana.com/tx/4kZgCJAfxG2kXDtncEnKWcoPtkiNArZjHMHDRVRieeNuHXrgofGfkQ4HsuDGd94h32eBxBhafbZXPa4TVKodKqNw?cluster=devnet) withdrew while the treasury ATA `Erk22kG4…` did not exist |
| Decision: only fee-free streams are accepted (`StreamflowError::Fees`); payouts create no account | a withdrawal then needs only the vault's token account (created by the deposit move) and the escrow; the partner, whoever it is, cannot make it fail; the js-sdk's default partner is the sender | js-sdk 13.4.0 `index.js` line 3568 (`partner ? new PublicKey(partner) : sender.publicKey`), `prepareWithdrawInstructions` line 4162 (creates the four ATAs only when asked to check them) |
| Streamflow `withdraw` and `transfer_recipient` accounts | `withdraw`: authority, recipient, `recipient_tokens` (must be initialized: `Account<TokenAccount>`), metadata, escrow, treasury, treasury tokens, partner, partner tokens (both "must match the contract metadata"), mint, token program; `transfer_recipient`: authority, new recipient, its token account (created at the signer's expense when missing), metadata, mint, rent, token, ATA and system programs | `streamflow-sdk` 0.15.0 `src/lib.rs` (`Withdraw` and `Transfer` account structs); the engine takes the withdraw accounts from the attested metadata and proves the new recipient's token account exists |
| A withdrawal that empties a Streamflow stream keeps its metadata account | after the full withdrawal: metadata `4Yc8T7kQBsRufFJjcYi3iN5MMU8nFeqUPiE3jrK4yD8s` still 1,104 bytes, `amount_withdrawn` = 10,000,000 (all of it), `closed` (671) = 1, escrow `FiNRA4mA…` closed. So a payout that empties a stream stays provable (`confirm_sol_payout` reads the metadata) | `scratchpad/v2/exp/empty.mjs` + `inspect.mjs`: stream created [2YnoyzPk…](https://explorer.solana.com/tx/2YnoyzPkA79M2xNeNwBKtadtCeTQwJNrSJ7nAmg3ZQKveC5scAZfaoFD6MtrDvEqcGLDvKd3bkFDd4B7jAKfU4Lq?cluster=devnet) (10 tokens over 10 s), withdrawn in full by the recipient, read at `confirmed` |
| `env::ecrecover` needs near-sdk's `unstable` feature | enabled for `submit_base_signature` and the check of every Base signature before it is stored | `near-sdk` 5.30.0 `src/environment/env.rs:591` (`#[cfg(feature = "unstable")] pub fn ecrecover`); `ed25519_verify` (line 684) is not gated |
| `engine-s1` derived keys (for the staging replay) | `vault/base` `secp256k1:5yxTg4vN…a7sTN`, `vault/sol` `ed25519:77DPmxot…AHad`, `gas/sol` `ed25519:36jQEj7Z…5PRH` | `derived_public_key {"path":…,"predecessor":"engine-s1.rose-app.testnet","domain_id":…}` on `v1.signer-prod.testnet`, block 276,155,629 (FastNEAR RPC); stored in `contracts/engine/tests/vectors/sandbox/staging/derived_keys.json` |

## Streamflow withdrawals, nonce seeds and mint checks (2026-11-04)

Probe: `scratchpad/v2fix/probe.mjs` (owner's scratchpad, `@solana/web3.js` 1.99.0, `@solana/spl-token`, `@streamflow/stream` 13.4.0, ops key `6uMy1iYd…gH7n`, devnet), output `probe-result.json`; devnet spend 0.0329 SOL.

| Fact | Value | Source or command |
|---|---|---|
| Streamflow `withdraw(amount)` withdraws exactly `amount` or fails | on a fresh fee-free stream (100 tokens, 0.1 token per second; about 2.2 tokens unlocked at the read): `withdraw(1,000,000)` succeeds and the simulated metadata shows `amount_withdrawn` = 1,000,000 exactly ("Withdrawn: 1 … tokens"); `withdraw(50,000,000)` and `withdraw(99,000,000)` fail with `InstructionError [0, Custom 115]`, log "Amount requested is larger than available". No clamp: a payout proof showing an amount between the proven one and the payout's is refused (`confirm_sol_payout`) | stream `EGutthZJk62W31LxXrCousdwvr5EVZPuBT6SnGQUUoKk` (mint `8y6cErJbewNF9MndgEX18ivDvrH89eVnkHxiGaUJGUWH`, recipient `HAejixYK…Dkup`) created by [2KNLyAvM…](https://explorer.solana.com/tx/2KNLyAvM7mbLrCHbwA8JRFJdNEQicRct6Q6MvDNWj17GxqmdERrtCAx2KyNXxSnydevPMqGsMnWh2guYWgMCRrTE?cluster=devnet); `simulateTransaction(sigVerify false, replaceRecentBlockhash true, accounts: [metadata])` of `withdrawStreamInstruction` by the recipient, slots 518,498,509 to 518,498,511 |
| Nonce accounts created with a seed | `SystemProgram.createNonceAccount({ fromPubkey, noncePubkey, basePubkey, seed, authorizedPubkey, lamports })` creates the account at `PublicKey.createWithSeed(base, seed, SystemProgram)` = `sha256(base \|\| seed \|\| 11111111111111111111111111111111)` (recomputed by hand, equal); 80 bytes, owner System, authority at 8..40. Base `6uMy1iYdq9EpL6W3EjsKdUZfrJ5G1shD1Da1QNe8gH7n`, seed `0123456789abcdef01234567probe001` gives `52gAaTfvLXp2WZMuK6KBkF3fj5K4mjqnJrSUDPwsMhaH`, reproduced by the engine's `create_with_seed` (`tests/foreign_solana.rs`) and the SDK's `payoutNonceAddress` | [2UuQMx7U…](https://explorer.solana.com/tx/2UuQMx7UNH4iYXVKU45zimdVXP87w9acmP9wksNqkDQ6LaAZpLyFFHwMG93ErsT3jqDZ7tfjQQDBjmAhHmcfV1LM?cluster=devnet); the seed of a payout nonce account starts with the first 24 hex characters of `sha256(NEAR account id)` (`nonce_seed_prefix_of`; `alice.testnet` gives `9a7068ee6434852cdaff3acb`, `python3 -c "import hashlib;print(hashlib.sha256(b'alice.testnet').hexdigest()[:24])"`) |
| SPL Token mint `freeze_authority` | `COption<Pubkey>` at offset 46: `u32` tag (0 none, 1 some), key at 50..82; `decimals` 44, `is_initialized` 45. Devnet USDC `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`: tag 1, key `CJtyoKSLrktozQzjERTiK3btQtiTK3nN4QrqGHLidyCT`, equal to `getParsedAccountInfo().freezeAuthority`; demo mint `3q81mxTA7rricmjJQaiZk9HbZzF2Pt8aN5SJaJcXvZ4w`: tag 0, parsed `null` (the seed scripts create mints with `freezeAuthority = null`) | `getAccountInfo` (base64) and `getParsedAccountInfo` at `finalized`, slot 518,501,161; bytes recorded in `tests/foreign_solana.rs::mint_accounts_parse_their_decimals_and_freeze_authority` |
| A mint without a freeze authority can never get one | `SetAuthority(FreezeAccount)` reads `mint.freeze_authority.ok_or(TokenError::MintCannotFreeze)` ("Once a mint's freeze authority is disabled, it cannot be re-enabled") | `curl -sL https://raw.githubusercontent.com/solana-program/token/main/program/src/processor.rs`, lines 494 to 499 |
| Gas the custody calls keep for their promise chains | `attribute_sol_deposit` 80 Tgas (80 attached fails "Attach more gas"), `move_sol_deposit` 70 Tgas (70 attached fails; 0.02 NEAR fails "Attach exactly 0.025 NEAR"), `register_sol_deposit` 50, `claim_sol_tokens` and Solana `redeem` 105, confirmations 50; the SDK attaches 120, 120, 80, 200, 100 | `require_gas_left` constants in `contracts/engine/src/custody` (15 Tgas per MPC call + 5 per receipt + 10 callback work); `ROSE_SANDBOX=1 cargo test -p rose-engine --test sandbox_lifecycle` asserts the two failures and the documented attachments; burnt live on `engine-s3`: 26.9, 29.0, 21.3, 45.1 Tgas |
| A sole holder's redeem was refused by one base unit on `engine-s3` ("takes 10000001 … you have 10000000") | the holding accrued a sum of floors (one per touch) while the redeem computes one floor: the holding now carries the fraction below one base unit between accruals, so its lifetime accrual is the floor of its exact accrual | reproduced by `tests::custody_solana::a_sole_holder_can_always_redeem_its_stream` (proptest over random schedules and claims: "owed 495684219 > claimable 495684218" without the carry); `tests::ledger` proptest `a_held_balance_accrues_the_floor_of_its_exact_accrual` |
| `get_events` failed on `engine-s3` with "Cannot deserialize element" | `PayoutCancelling` had been inserted before `PositionReleaseRequested` in `RoseEvent` between two builds deployed in place: Borsh stores the variant index. `RoseEvent`, `PayoutStatus` and `PositionState` now keep the `b10bba2` order with new variants appended; `tests::layout` pins every Borsh enum (docs/architecture.md, "Stored layouts") | `python3 scratchpad/v2fix/enums.py b10bba2` (variant order of every Borsh enum at `b10bba2` against the working tree) |

## Streamflow auto-claim and the receipt nonce (2026-11-04)

Streamflow empties every ended stream into its recipient's token account. Every fact the receipt-nonce
design relies on was measured on devnet with throwaway keys (scripts outside the repository, ops key
`6uMy1iYd…gH7n` paying), then the design was checked end to end on devnet with a sandbox engine whose
mock MPC keys sign real devnet transactions.

### The auto-claim, reproduced

A stream of 100 tokens (mint `6G4Yo5SS…bRk`, 6 decimals) from the ops key to a fresh keypair standing for the vault, 5 tokens per 10 s, `automatic_withdrawal` = 0, created by `@streamflow/stream` 13.4.0 `SolanaStreamClient.create` ([5yN1s4ca…](https://explorer.solana.com/tx/5yN1s4caWfMK96mXBCULG3V5aHgkwZ7BzqUC7hyHJEfvGsXaDPUhtvcUrmmH584PY5fmfABU6AhLyDAAwyvVUoGF?cluster=devnet), metadata `CJKLpJBy9dgFmyXCgP9y3X8DWnSGjF1sdzVKfxgciyHR`, `end_time` 1,793,801,148). Commands: `getAccountInfo(metadata, "confirmed")` every second across the end, `getSignaturesForAddress(metadata)`, `getTransaction(sig)` for signers, logs and token balances.

| Fact | Evidence | Result |
|---|---|---|
| The recipient withdrew 15 tokens before the end (the engine's payout analogue) | [gq46n87U…](https://explorer.solana.com/tx/gq46n87U8ZQqDm1NgDcVmL2UbspAiJtDw3HUEYzVTxHtiViL5QvDvJ4PRVRQbqt8cq2WqS9KDP4aPXPJeEtGhuz?cluster=devnet) | `amount_withdrawn` 15,000,000, `last_withdrawn_at` 1,793,800,993 |
| One second after the end, Streamflow's withdrawor emptied the stream | [2bhmfH6B…](https://explorer.solana.com/tx/2bhmfH6Bz2Aqqcku7FULyymjUwUffUSmAXqdS9h3odzkSPmfxM2Qwud2j2rXPNsF9GKYKjFsHtYrtp3EiMbc2sqE?cluster=devnet), block time 1,793,801,149 | only signer `wdrwhnCv4pzW8beKsbPa4S2UDZrXenjg16KJdKSpb5u`; Memo program "Auto-Claim"; Streamflow `Withdraw`, "Withdrawn: 85 … tokens", "Closing escrow SPL token account"; recipient token account 15,000,000 → 100,000,000, escrow 85,000,000 → closed |
| Metadata bytes the auto-claim changes | byte diff of the account before and after | 17..25 `amount_withdrawn` 15,000,000 → 100,000,000 (= `net_amount_deposited`); 41..49 `last_withdrawn_at` → 1,793,801,149 (`end_time + 1`); 671 `closed` 0 → 1; nothing else (fee and auto-claim fee fields unchanged; no further rewrite in the next 3 minutes) |
| A `withdraw` after the auto-claim fails, and its durable-nonce transaction still advances its nonce | `[AdvanceNonce, withdraw(5 tokens)]` signed before the end, broadcast after: [58NdiWwM…](https://explorer.solana.com/tx/58NdiWwMiXd2wt4s8QgmrhumFQWrfgMgB2w8EfDhbTvLxdeHnPZvNiffdtHaN2zkNhFhcFxU56vmA8cvDo5rRopM?cluster=devnet) | `InstructionError [1, Custom 3012]` ("AnchorError caused by account: escrow_tokens … AccountNotInitialized"); nonce value changed |
| A `transfer_recipient` after the auto-claim fails, nonce advanced | `[AdvanceNonce, transfer_recipient]` signed before the end, broadcast after: [3JQDp7d3…](https://explorer.solana.com/tx/3JQDp7d3SBui5t7dNx9j3RBVJRD7QohW6nJ2e4Z8QBVsoxToyLePoijUFZQ7zG8T12J3PU5fKQjXLW1F5Pvnq7FR?cluster=devnet) | `InstructionError [1, Custom 104]`, log "Stream closed"; nonce value changed |

### The receipt nonce, measured

Two nonce accounts with the same authority (created in [5RebzfWf…](https://explorer.solana.com/tx/5RebzfWfVtoJ4TzWffTaiWxDsiHmjV6sxRCoAY7dH6raKqRBUFTh3stSzBAyWTfvW7HTmptUbcSzh4CL6X4Fzhtz?cluster=devnet)): one used as the durable nonce, the other advanced by a regular `AdvanceNonceAccount` instruction, values read with `NonceAccount.fromAccountData` (`@solana/web3.js` 1.99.0) before and after.

| Transaction | Evidence | Result |
|---|---|---|
| `[AdvanceNonce(nonce), AdvanceNonce(receipt), withdraw on the closed escrow]`: fails | [8vpeGE2K…](https://explorer.solana.com/tx/8vpeGE2KKcowegCMRjS7i2136PEfiTUsCNDGbD1npFw7ucpj2K8NZQtA1MW56TytXpSNUYS3PwkXRdyvUbSea7t?cluster=devnet) | `InstructionError [2, Custom 3012]`; the durable nonce advanced, the receipt kept its value (its advance, executed before the failing instruction, was rolled back) |
| `[AdvanceNonce(nonce), TransferChecked, AdvanceNonce(receipt)]`: executes | [4ocdf8A3…](https://explorer.solana.com/tx/4ocdf8A3s2Bty2ruFd8eUdBuCW2abAeDrkeMSjJMXR2rSXU8ZCn8Y46rBYshMbVsHvgN7UnsAp9BpeqKHqPoKpzD?cluster=devnet) | both accounts hold the same new value `9vaHYy8f…982x` |
| `[AdvanceNonce(nonce)]` alone (a cancellation): executes | [1J3KKKNH…](https://explorer.solana.com/tx/1J3KKKNHj3ZGajy2ZTDRjHCT9R3RwD29AYdABHj96N1ba46uMb521pQXdGAEJzKcXdSYCEgyRWiWvr7R61pLxrJ?cluster=devnet) | the nonce moved, the receipt did not: the two differ |

### Other facts of the receipt-nonce design

| Fact | Command | Result |
|---|---|---|
| The WITHDRAWOR is a protocol constant of the official SDK | `grep -n WITHDRAWOR scripts/node_modules/@streamflow/stream/dist/esm/index.js` | `var WITHDRAWOR = "wdrwhnCv4pzW8beKsbPa4S2UDZrXenjg16KJdKSpb5u";` (13.4.0, line 270) |
| One event history entry occupies at most 431 bytes | `cargo test -p rose-engine --lib tests::events` (records a worst case of every variant, 64-character ids, texts cut at 192 bytes, and measures `storage_usage`) | largest 431 bytes; bound `EVENT_RECORD_MAX_BYTES` = 448, so the full history is at most 458,752 bytes (4.59 NEAR at 1e19 yoctoNEAR per byte) |
| New `ReleaseExecuted` topic0 (RoseVault gains `vestedForwarded`) | `cast keccak "ReleaseExecuted(uint256,uint256,address,address,address,uint128,uint128)"` | `0x497d44848ca3d248e620c104aa9a3829f04a49b7655a71fed5b9c85a5dca5fe2` |
| Reproducible build image | `curl -s "https://hub.docker.com/v2/repositories/sourcescan/cargo-near/tags?page_size=30&ordering=last_updated"`; `curl -s https://hub.docker.com/v2/repositories/sourcescan/cargo-near/tags/0.22.0-rust-1.97.0` | cargo-near 0.22.0 images exist for Rust 1.97.0, 1.97.1, 1.98.1, 1.99.0 and 1.99.1 (none for the pinned 1.95.0); `0.22.0-rust-1.97.0`: digest `sha256:b193c8640a27172f83136a0f0aab2a9bf9d09f6ba0e6afd187addfaa9b92bae0`, amd64 only, 503 MB, pushed 2026-07-15 |
| Reproducible engine wasm | Docker Desktop 29.5.3; a plain `git clone --branch fix/engine-streamflow-sweep` (cargo-near resolves a git worktree to its main checkout's HEAD, so it must run from a regular clone), then `cargo near build reproducible-wasm` in `contracts/engine` at commit `404122b` | pulled `sourcescan/cargo-near@sha256:b193c864…ae0` (2.02 GB unpacked); the container builds with `RUSTUP_TOOLCHAIN=1.97.0` (the image's toolchain overrides `rust-toolchain.toml`), "rustc 1.97.0 accepted (bulk-memory opcodes supported by nearcore VM)", then `wasm-opt`: 1,016,367 bytes, sha256 `f2e12f37123c7dce631fa10a8f22f5ef439002f1553c187766b732aa882f818e` (bs58 `HM6pPmbv…77Hf`), in 4 min 22 s. It differs from the local build (another Rust version), so a deployment meant to be checked by a third party deploys this artifact |

### The fixed engine against real devnet transactions

No staging engine could be funded at the time, so the engine wasm ran in a NEAR sandbox (near-workspaces 0.24, `near-sandbox` 2.14.0) with the mock MPC, whose derived `vault/sol` (`38mTGZ4H…ze7q1`) and `gas/sol` (`HL144RF5…kJL2`) keys acted on devnet. A helper created the stream and the claimant's accounts from the ops key, broadcast every engine-signed transaction as stored by the engine, and read the accounts at `finalized`; the mock attested exactly the bytes read, so every engine decision below was taken on real devnet state. The harness and helper were scratch code (`ROSE_DEVNET_LIVE=1`), not committed. Stream `8TfxJFeD…QN7K` (mint `8zgviqRQ…gWw1`, 7,500 tokens, 100 per minute, `end_time` 1,793,809,559, `automatic_withdrawal` = 0); nonce account `5LgRoF73…pGk` and receipt account `J54boViB…Q9y` (seeds `nonce_seed_prefix_of(holder)` + `a` and + `r`, authority = vault), recipient token account `G2KxoezN…gUo6`.

| Step | Transactions | Engine result |
|---|---|---|
| Stream created, `transfer_recipient` to the holder's deposit address, `attribute_sol_deposit`, engine-signed move to the vault, `register_sol_deposit` | [5sXnDHDV…](https://explorer.solana.com/tx/5sXnDHDVU74CDYtjietPVHnmeZZEUHBUGMfkhbyZvBXFci128QbY2pN6rVmbLDnBkdfz7mx6HCH23Ad9TqAsaeyy?cluster=devnet), [4iWUa9oL…](https://explorer.solana.com/tx/4iWUa9oLwYCsVQa4zvEmZPj4MERpsVqU8fktPt9kLjMPFdo4GmuetAYwaP8XuM4z4hkTeuULH5qBsvoidx6zvRJ?cluster=devnet), [nTgUrm3s…](https://explorer.solana.com/tx/nTgUrm3sLGjUt4SbNv5s1ejP3Am7uaN7z99XXYJCxUwoC78C64h9yu7BsRUe7oPqi3HY6KMGkPSBSNAywiP8B5W?cluster=devnet) | position 0 registered at the vault (the stream ends 75 minutes after its attribution, above the one-hour margin) |
| Nonce and receipt accounts created in one transaction | [4FLTypWU…](https://explorer.solana.com/tx/4FLTypWUjY61Uvmx5QrFgqQF4L1dHxJQapcQM3XANDuCwo5NtC5shoSk1VEjSXCDZWp7bhAb6aCMivSHYSomUC5V?cluster=devnet) | both proven with the recipient token account by `claim_sol_tokens` |
| Payout 1: a 99-token draw before the end, broadcast | [4cQB76dE…](https://explorer.solana.com/tx/4cQB76dEPid357Vw7yCif7FiB9cT7GPBeLsbV2X6tVr57brmga8gFVJtdrgotHqRrQ74nL8JcqwR6f6uGT4vWYgT?cluster=devnet) (executed) | nonce and receipt both read `B4v9GApc…rzwZ`; `confirm_sol_payout` → `Landed` |
| Payout 2: a 100-token draw signed 70 s later, held back past the end | | signed, `Signed` |
| Streamflow's auto-claim, one second after `end_time` | [4fp89tYR…](https://explorer.solana.com/tx/4fp89tYR8LqLQjjXVgfxuZkN9M85KSaydskaqnXvvEETVchYcDwQqCRicy2qaqtPwd5VBLayf55nKTnuJVupuVgn?cluster=devnet), block time 1,793,809,562 | signer `wdrwhnCv…pb5u`, memo "Auto-Claim"; the escrow's 7,401 tokens to the vault's token account `8pnvGt3c…D4u`; the stream reads `amount_withdrawn` 7,500,000,000 (= net), `closed` |
| `sync_sol_stream` while payout 2 is unsettled | | refused: "not confirmed yet" |
| Payout 2 broadcast after the auto-claim | [z5hgnFCa…](https://explorer.solana.com/tx/z5hgnFCaghnUETkNVMn24chPaHW1F1bVqziJyvViUTzvTH1nzT2iQRgqRr2zetbPp4McMruNogcA5uzZrZtP1hL?cluster=devnet) | `InstructionError [1, Custom 3012]` on `escrow_tokens`; the nonce moved to `59uunxBS…cfm`, the receipt stayed on `B4v9GApc…rzwZ`; two `confirm_sol_payout` proofs 200 blocks apart → `Failed { "the transaction did not execute" }`, the 100 tokens back in claimable (before the fix, the stream's `amount_withdrawn` = net would have been read as a landing and the claim destroyed) |
| `sync_sol_stream` of the swept stream | | `sol_stream_swept`; `get_sol_swept` `{balance: 7,401,000,000, pending: 0}`; the stream pruned |
| Payout 3: the holder's 7,401 claimable tokens from the swept balance, `TransferChecked` alone | [48RcsYff…](https://explorer.solana.com/tx/48RcsYff1LTPofxJQhyBT2RPMZrwVWPa4HrNz1ac5AFPKEB67niNkzvriDrepKp8iVLv78Q2gyFNdCApnWs2oLAB?cluster=devnet) (executed) | nonce and receipt both read `GYhtutaT…8SW`; `confirm_sol_payout` → `Landed`; recipient token account 992,599,000,000 → 1,000,000,000,000 base units; swept balance `{0, 0}` |

Gas burnt in the sandbox (the same wasm): `attribute_sol_deposit` 30.31 Tgas, `move_sol_deposit` 28.44, `register_sol_deposit` 24.77, `claim_sol_tokens` 47.95 (draw), 46.99 (swept balance), `confirm_sol_payout` 20.69 (executed), 19.72 and 20.84 (the two "did not execute" proofs), `sync_sol_stream` 22.15 (80 Tgas attached).

The NEAR sandbox suites ran on the same commit: `ROSE_SANDBOX=1 cargo test -p rose-engine --test sandbox_lifecycle --test sandbox_recorded -- --test-threads=1`: 7 and 1 passed (the Solana scenario covers the receipt verdict, a synced withdrawal and a swept-balance payout with the mock's own proofs).

## Streamflow automatic withdrawal after the deposit (2026-11-14)

Nothing was signed, sent or deployed: the Streamflow rows are `simulateTransaction` calls with
`sigVerify: false`, which need no key.

### A stream's sender can switch automatic withdrawal on after the deposit

The simulations build Streamflow's `update` instruction with the pinned `@streamflow/stream` 13.4.0
(`updateStreamInstruction({ id, ...params }, HqDGZjaVRXJ9MGRQEw7qDc2rAr6iH1n1kAQdCZaCMfMZ, { authority,
metadata, withdrawor: wdrwhnCv4pzW8beKsbPa4S2UDZrXenjg16KJdKSpb5u, systemProgram })`, loaded with
`createRequire("./scripts/package.json")`), put one or more of them in a transaction whose fee payer
is the authority, and call `simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true,
accounts: { encoding: "base64", addresses: [stream] } })` on `https://api.devnet.solana.com`; the
post-state is read at byte 457 (`cancelable_by_sender`), 459 (`automatic_withdrawal`), 460, 461 and
527 (`withdraw_frequency`). They ran at Unix time 1,794,618,393; the rows marked "re-run"
were run again later.

| Fact | Command | Result |
|---|---|---|
| The stream is a position of the deployed engine, at the vault | `call_function` `get_sol_deposit {"metadata":"Cg3hynP4CwMe7sTX1hSwiWXJoTFxPDAea8beTXvd7d8A"}` on `engine-v2.rose-app.testnet` (finality `final`, `https://near-testnet.drpc.org`); `getAccountInfo(stream, "finalized")` | `stage: { Registered: { position_id: "1" } }` (block 277,589,312); recipient `EqywuZpmf7i4ycvYqwzxEiDKTq94RifUSjH9pQX1SdWC` (the engine's `vault/sol`), sender `6uMy1iYdq9EpL6W3EjsKdUZfrJ5G1shD1Da1QNe8gH7n`, `automatic_withdrawal` 0, `cancelable_by_sender` 0, `transferable_by_sender` 0, `transferable_by_recipient` 1, period 2,592,000 |
| The sender can switch it on (re-run) | `update { enableAutomaticWithdrawal: true }`, authority = the sender | `err: null` (slot 522,018,900): post-state `automatic_withdrawal` 1, `withdraw_frequency` 2,592,000 (the period) |
| Not below the period | the same with `withdrawFrequency` 60, 3,600 or 86,400; then 2,592,000 | `InvalidArgument` for the three; `err: null` for 2,592,000 |
| Not back off (re-run) | `enableAutomaticWithdrawal: true` then `enableAutomaticWithdrawal: false` in one transaction | `InstructionError [1, "InvalidArgument"]`: the second instruction fails |
| Every other power the engine relies on stays off (re-run for the first) | `cancelableBySender: true`; `transferableBySender: true`; `transferableByRecipient: false` | `InstructionError [0, "InvalidArgument"]` each. Positive controls on other devnet streams: `cancelableBySender: false` on `1Ca8xDHP…YwgN` and `transferableBySender: false` on `12BasSQv…kChS` succeed, `transferableByRecipient: true` on `1NAPDn2u…WcZ` succeeds, and turning any of them back fails |
| Only the sender, and no rate change | `amountPerPeriod: 1` with the sender; a name-only update with another key (`HWx7jD36…n1Ng`) | error 131 "Authority does not have permission for this action" for both |
| Nothing was changed (re-run) | `getAccountInfo(stream, "finalized")` after the simulations | identical to the first row |
| Streamflow's withdrawor acts on the flag before a stream's end | `getProgramAccounts(HqDGZ…CMfMZ, { filters: [{ dataSize: 1104 }, { memcmp: { offset: 459, bytes: "2" } }, { memcmp: { offset: 671, bytes: "1" } }] })` (flag 1, `closed` 0), then `getSignaturesForAddress` and `getTransaction` for the signers | `12gyFvEd…ZRn4` (`end_time` 1,974,712,778, `last_withdrawn_at` 1,793,800,591): 5 of its last 6 transactions signed by `wdrwhnCv…pb5u`, e.g. [66986xnt…SrEw](https://explorer.solana.com/tx/66986xntn3pWrt1z8QkPSSq9Ypbrqs7dSHWv2z7xqTyNuWxxP486GN4nDJCRk7g4nfkXfDMXAzaQ4WzVNnKrSrEw?cluster=devnet); `6FnBaEnR…UbYe`: 6 of 6; `7b8FLsQV…dh4`: 3 of 5 |

What follows on the deployed engine (it checks the flag at attribution and registration only): the
withdrawor moves the stream's unlocked tokens into the vault's token account every
`withdraw_frequency` seconds (no shorter than the period), `engine_withdrawn` does not move, and a `redeem` prices the redeemer's payment from
`engine_withdrawn`, so a redeem made before a `sync_sol_stream` charges the redeemer for tokens
already in the vault, and after the release no sync can book them. The app and the SDK now check
the stream at `finalized` before a redeem (`solRedeemSafety`); `docs/security.md` gives the residual.

## Solana settlement facts the app relies on (2026-11-04)

| Fact | Value | Source or command |
|---|---|---|
| A failing durable-nonce transaction still lands and advances its nonce when sent without preflight | already measured (section "Solana custody v2"); the app now broadcasts every stored durable-nonce transaction with `skipPreflight: true` and re-broadcasts it every 10 s until the nonce reads advanced at `finalized` | `scratchpad/v2/exp/nonce.mjs` ([5B9GDa7p…](https://explorer.solana.com/tx/5B9GDa7pLZuaJijpzgPD97iE4FWRtEgxhGGnoVg1V4AEfnaccaYtECEzKSRgxwrg6Nqscr5tedFPuB9FS7e7cLLS?cluster=devnet)) |
| `confirm_sol_payout` / `confirm_sol_redeem` read the nonce at `finalized` and panic "The nonce has not advanced" otherwise; a "did not execute" verdict needs a second proof requested at least `CONFIRM_FAILURE_DELAY_BLOCKS` = 150 blocks after `not_executed_seen_at` | the app waits for the finalized nonce advance before any NEAR call and counts the 150 blocks down on the final NEAR head | `contracts/engine/src/custody/payouts.rs` (`advanced_nonce`, `not_executed_twice`), `custody/mod.rs:85` |
| web3.js 1.99.0: `Connection.isBlockhashValid(blockhash, { commitment })`, `getSignatureStatuses(sigs, { searchTransactionHistory: true })`, `VersionedMessage.deserialize(bytes).recentBlockhash` | used to read a deposit move or a return as executed, failed or expired (never offered for broadcast once its blockhash expired) | `node_modules/@solana/web3.js/lib/index.d.ts` (lines 3497, 3404, 1481) |
| spl-token 0.4.15: `getMint`, `createTransferCheckedInstruction(source, mint, destination, owner, amount, decimals)`, `createAssociatedTokenAccountIdempotentInstruction` | the faucet's `solana-demo-token` send | `node_modules/@solana/spl-token/lib/types/` (`state/mint.d.ts:48`, `instructions/transferChecked.d.ts:26`) |
| Sablier `withdrawMax` is payable with `calculateMinFeeWei(streamId)` | the Base claim forwards the fee read per stream, as `depositStream` does | spec 7.1, SDK `chains/base/sablier.ts` |
| Demo mint `2eWdSYbcryjZvA8UBmjTmEqjRqzY2LVUnHUby1gdDLNv` (CINDR on devnet) | 9 decimals, no freeze authority, mint authority = the ops key `6uMy1iYd…gH7n` | `getAccountInfo` jsonParsed at `finalized` |

Ops (devnet only): the faucet's Solana hot wallet `DJgWSMB3D8sKyJNoQJqsCKpD4H4c3tm2NhG9EXumnzxV` holds the demo-token treasury, its associated token account `4ecAUkGx3kWfXGSjbseN3zkL4KSw28vKQ4eUsCsXsEY7`, filled with 1,000,000 CINDR by `mintTo` from the ops key: [2umAEGuE…](https://explorer.solana.com/tx/2umAEGuEm8xtzqx7Ya2EwybyfpojsEYi868x5KUEgiynmxqBJJW5CVT5S51RVPyMZc6x4QUuArLjF7EACNij7oou?cluster=devnet) (1,000 requests of 1,000 tokens). The hot wallet never holds the mint authority. Refill the same way.

## Payout nonce seeds per engine (2026-11-06)

The app's payout nonce seed suffix is the first 6 characters of the engine's `vault/sol` address (the
receipt adds `r`), within the 8 characters spec 7.3 allows after `nonce_seed_prefix_of`, so a Solana
wallet gets separate nonce accounts per engine (unit test: `apps/web/src/lib/payouts.test.ts`,
"derives nonce seeds per engine"). Before this, a claim on `engine.rose-app.testnet` with the Solana
demo key used on `engine-s5` stopped before any transaction with "Nonce account in use": that
wallet's payout nonce account had `engine-s5`'s vault as its authority, and the seed did not name the
engine.

## NEAR storage, logs and token registration (2026-11-04 to 2026-11-06)

Storage prices, row sizes and log limits the engine charges and checks, and the tUSDC token facts the app uses.

| Fact | Command | Result |
|---|---|---|
| Storage price and record overhead | `curl -s https://rpc.testnet.fastnear.com -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"EXPERIMENTAL_protocol_config","params":{"finality":"final"}}' \| jq '.result.protocol_version, .result.runtime_config.storage_amount_per_byte, .result.runtime_config.transaction_costs.storage_usage_config.num_extra_bytes_record'` | protocol 88, `10000000000000000000` yoctoNEAR per byte, 40 extra bytes per trie record |
| Measured rows for a 64-character account id | `cargo test -p rose-engine --lib charged_rows_cover_their_measured_bytes_for_the_longest_account_ids` (mocked VM `storage_usage`, same 40-byte record overhead) | storage record 137 bytes, holding row 310 (242 for the row, 68 for the class's entry in the account's class list), cash row 172 (Base venue), lien share row 149; a 7-character id uses less of each. Registration minimum 619 bytes = 0.00619 NEAR |
| `get_portfolio` cost | `ROSE_SANDBOX=1 cargo test -p rose-engine --test sandbox_lifecycle -- portfolio_cost --nocapture` (called as a transaction to read its gas) | 3.01 Tgas for an account with 1 class, 7.87 Tgas with 20 classes (0.26 Tgas per class held), 7.87 Tgas again after another account created 40 more classes: the cost no longer depends on the engine's class count |
| tUSDC mint windows | `contracts/tusdc/src/lib.rs` `mint` and `contracts/evm/src/TestUSDC.sol` `mint` | both deployed tokens use a fixed 24-hour window starting at an address's first mint after the previous one expired, not a rolling one; the spec now says so (redeploying the keyless test tokens is not worth it for a demo faucet cap) |
| Storage price the app's row costs use | `curl -s https://rpc.testnet.near.org -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"EXPERIMENTAL_protocol_config","params":{"finality":"final"}}'`, `runtime_config.storage_amount_per_byte` | `10000000000000000000` (1e19 yoctoNEAR per byte, protocol 88): record 137 bytes, holding row 310, cash row 172, minimum 619 bytes = 0.00619 NEAR |
| The engine checks capacity even when no row is added | `contracts/engine/src/storage.rs` `require_storage_capacity` / `storage_shortfall`, called by `ft_on_transfer` and `check_row_capacity` with `extra_bytes = 0` for an existing row | the shortfall is `bytes_cost(used_bytes + extra) - deposit`, so an account registered by the engine with a zero deposit must top up its existing rows first; the app computes the same |
| tUSDC registration on the token (Get test funds copy) | `curl -s https://test.rpc.fastnear.com -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"call_function","finality":"final","account_id":"tusdc.rose-app.testnet","method_name":"storage_balance_bounds","args_base64":"e30="}}'` | `{"min":"1250000000000000000000","max":"1250000000000000000000"}` (0.00125 NEAR); the mint window is fixed (`MINT_WINDOW_NS`, `contracts/tusdc/src/lib.rs`), not rolling |
| One event history entry occupies at most 431 bytes | `cargo test -p rose-engine --lib tests::events` (records a worst case of every variant, 64-character ids, texts cut at 192 bytes, and measures `storage_usage`) | largest 431 bytes; bound `EVENT_RECORD_MAX_BYTES` = 448, so the full history is at most 458,752 bytes (4.59 NEAR at 1e19 yoctoNEAR per byte) |
| tUSDC is keyless and runs the recorded wasm (why its source is documented, not changed) | `query view_access_key_list` and `view_account` (finality `final`) on `tusdc.rose-app.testnet` at `https://test.rpc.fastnear.com` | `keys: []` (block 276,484,795); `code_hash` `7JHPYMQ1o7QVhVyMwmzzxS3vVhyqEkcWQrGJUcmubizP`, the deployment in "Deployed: rose tUSDC on NEAR testnet"; balance 3.0224 NEAR with 163,630 bytes stored (1.6363 NEAR locked, about 1.39 NEAR free for new minting accounts' rows) |
| near-contract-standards already logs the burn of a refused transfer whose sender unregistered | `~/.cargo/registry/src/*/near-contract-standards-5.30.0/src/fungible_token/core_impl.rs`, `internal_ft_resolve_transfer` | `FtBurn { owner_id: &receiver_id, amount, memo: Some("refund") }` before `return (amount, refund_amount)`; tUSDC's `ft_resolve_transfer` then emits its own `FtBurn` for `burned > 0` |

## Distribution cap, log limits and Solana polling (2026-11-06)

| Fact | Command | Result |
|---|---|---|
| NEAR's log limits apply to the sum of every log of one function call, not to each message | `near-vm-runner` 0.38.0 `src/logic/logic.rs` `checked_push_log` (adds each message to `total_log_length` and fails above `limit_config.max_total_log_length`) and `check_can_add_a_log_message` (`max_number_logs`); `near-parameters` 0.38.0 `src/vm.rs` ("Maximum total length in bytes of all log messages"); live: `curl -s https://rpc.testnet.near.org -d '{"jsonrpc":"2.0","id":1,"method":"EXPERIMENTAL_protocol_config","params":{"finality":"final"}}'`, `runtime_config.wasm_config.limit_config` | testnet protocol 88: `max_total_log_length` 16384, `max_number_logs` 100. Splitting the NEP-245 `mt_transfer` event into several `EVENT_JSON` messages would not help: the 16,384 bytes are shared by every log of the call |
| Worst-case log bytes of `distribute_units` | `cargo test -p rose-engine --lib distribute_units_at_the_cap` (mocked VM, which enforces the same `TotalLogLengthExceeded`): 64-character issuer, class id and receivers, every receiver unregistered, 38-digit amounts | one `storage_deposited` event (229 bytes) and one `mt_transfer` entry (300 bytes) per receiver, 81 bytes fixed: 1 receiver 610 bytes, 30 receivers 15,951 bytes in 31 logs, 31 receivers fail with `TotalLogLengthExceeded { length: 16480, limit: 16384 }`. `MAX_DISTRIBUTION_RECEIVERS` (and `get_limits().max_distribution_receivers`) lowered from 50 to 30, the measured maximum |
| `distribute_units` at the cap, real wasm | `ROSE_SANDBOX=1 cargo test -p rose-engine --test sandbox_lifecycle distribute_units_at_the_cap -- --nocapture --test-threads=1` (near-workspaces 0.24.0, protocol 88): issuer `iii…i.rose-app.testnet` (64 characters), 30 receivers of 64 characters, all registered by the call, 37-digit amounts | 31 receivers refused ("At most 30 receivers per call"); 30 land with 40 Tgas attached (the SDK's `distributeUnitsGas(30)`: 10 Tgas plus 1 per receiver), 27.87 Tgas burnt, 15,921 log bytes; every receiver holds its units |
| What the auto-claim changes in a Streamflow stream, which a late registration relies on | the auto-claim byte diff recorded above ("The auto-claim, reproduced"): only `amount_withdrawn` (to `net_amount_deposited`), `last_withdrawn_at` and `closed` (to 1) change | `StreamflowMetadata::auto_claimed` accepts exactly `closed` with `amount_withdrawn >= net_amount_deposited` and `canceled_at` 0; `cargo test -p rose-engine --test foreign_solana registration_accepts_only` applies that diff to the live devnet metadata `own_stream_finalized_expected` and checks the other closings stay refused |
| web3.js 1.99.0 polling API | `packages/sdk/node_modules/@solana/web3.js/package.json` (`1.99.0`), `lib/index.d.ts`: `getSignatureStatuses(signatures, config?: { searchTransactionHistory })` (line 3404), `getBlockHeight(commitmentOrConfig?)` (3547), `sendRawTransaction(rawTransaction, options?)` (3704), `TransactionConfirmationStatus = 'processed' \| 'confirmed' \| 'finalized'` (3170) | the SDK's `waitForSignature` uses only these HTTP methods; no `signatureSubscribe` |
| Devnet answers the polled methods | `curl -s https://api.devnet.solana.com -d '{"jsonrpc":"2.0","id":1,"method":"getSignatureStatuses","params":[["5Vq3kwhU…KukGwgfEi"],{"searchTransactionHistory":true}]}'` and `{"method":"getBlockHeight","params":[{"commitment":"confirmed"}]}` (2026-11-06) | `{"confirmationStatus":"finalized","err":null,"slot":518652019,"status":{"Ok":null}}` (apiVersion 4.4.0) for a `gas/sol` top-up of `engine-s5`; block height 506,431,928 |
| The SDK suite is hermetic | `npx vitest run test/chains/solana.nonce.test.ts` from `packages/sdk`: the test connection's HTTP and websocket endpoints are the local discard port `127.0.0.1:9` and every JSON-RPC call goes through the stubbed `fetch` | 11 passed in 226 ms; the confirmation tests assert that only `getSignatureStatuses` (with `searchTransactionHistory`) and `getBlockHeight` are called |
| The recorded live MPC vectors run in the default gate | `cargo test --workspace -- --list` lists the `foreign_mpc` live-vector tests; `live_vectors_reproduce_the_signed_payload_hash` now pins the count | 10 vectors (6 Base, 4 Solana) recorded from `v1.signer-prod.testnet` 3.18.0 |

## NEAR RPC endpoints (2026-11-14)

From the build machine (01:26 to 01:38 UTC), with other clients on the same IP. Endpoints from
the testnet table of https://docs.near.org/api/rpc/providers (FastNEAR, `archival-rpc.testnet.near.org`,
dRPC, Intear, ZAN; the other providers there publish no public endpoint) plus the two the app used.
`one.sh <url>` posts `{"jsonrpc":"2.0","id":"x","method":"query","params":{"request_type":"view_account","finality":"final","account_id":"rose-app.testnet"}}`
with `-H 'origin: https://rose-rounds.vercel.app' -D <headers>`.

| Check | Command | Result |
|---|---|---|
| Success answers carry CORS headers | `curl -sS -D - -X POST <url> -H 'content-type: application/json' -H 'origin: https://rose-rounds.vercel.app' -d '{"jsonrpc":"2.0","id":"x","method":"block","params":{"finality":"final"}}'` | `test.rpc.fastnear.com`, `rpc.testnet.fastnear.com`, `near-testnet.drpc.org`, `testnet-rpc.intea.rs` (1.5 s, body note "Requests without an API key are being slowed down for one second"), `archival-rpc.testnet.near.org` (3.1 s): HTTP 200 with `access-control-allow-origin` |
| Preflights | `curl -sS -X OPTIONS -D - -H 'Origin: https://rose-rounds.vercel.app' -H 'Access-Control-Request-Method: POST' -H 'Access-Control-Request-Headers: content-type' <url>` | FastNEAR 200 (`allow-origin: *`, `allow-headers: *`); dRPC 204 (`allow-origin` echoes the origin, `allow-headers: content-type`); Intear 200 (`allow-origin: *`, `allow-headers: content-type`) |
| The official RPC is deprecated and refused these requests | same `block` POST to `https://rpc.testnet.near.org` | HTTP 429, `retry-after: 13`, no `access-control-allow-origin`, body `-429` "WARNING! THIS ENDPOINT IS DEPRECATED! STOP USING IT NOW! Switch to https://fastnear.com …". Removed from the app's read chain. At 02:48 UTC the same endpoint answered 10 of 10 sequential requests (see "near-api-js retries and the official endpoint" below) |
| Other listed or known endpoints | same `block` / `status` POST | `api.zan.top/near-testnet` HTTP 429 on the first request (`-32003` "cu limit exceeded", with CORS); `rpc.testnet.pagoda.co` HTTP 403 "deprecated"; `near-testnet.lava.build` HTTP 410 "discontinued"; `near-testnet-rpc.publicnode.com` HTTP 404. None usable |
| FastNEAR's 429 has no CORS header | `seq 1 60 \| xargs -P 20 -I{} one.sh https://test.rpc.fastnear.com fa{}` at 01:27:59, then `seq 1 6 \| xargs -P 6 -I{} one.sh https://rpc.testnet.fastnear.com fb{}` | 22 × 200 (with CORS) and 38 × HTTP 429 without `access-control-allow-origin` (`retry-after: 0`, body `-429` "Rate limits exceeded"); the twin host then answered 1 × 200 and 5 × 429. A browser cannot read that 429, so it reports a CORS error and `NearRpc` sees a network failure |
| FastNEAR's limit varies | the same bursts at 01:37:21 (40 to `rpc.testnet.fastnear.com`, then 6 to `test.rpc.fastnear.com`) and 01:37:29 (80, then 6) | 132 × 200: the limit depends on the IP's recent traffic. `rpc.testnet.fastnear.com` is the same provider and was limited together with `test.rpc` once, so it is not a fallback |
| dRPC and Intear under a burst | `seq 1 80 \| xargs -P 20 -I{} one.sh https://near-testnet.drpc.org da{}`; `seq 1 20 \| xargs -P 10 -I{} one.sh https://testnet-rpc.intea.rs ia{}` | 80 × 200 and 20 × 200, all with CORS. A 429 from either was not observed, so its CORS behaviour on 429 is unknown; dRPC documents about 2,100 CU/s on its free tier |
| Which endpoints hold a transaction wait | `curl -sS -m 60 -X POST <url> -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":"x","method":"tx","params":{"tx_hash":"11111111111111111111111111111111","sender_account_id":"rose-app.testnet","wait_until":"EXECUTED"}}'` (an unknown hash makes the node wait for its own timeout) | FastNEAR: HTTP 408 after 10.1 s with the node's `TIMEOUT_ERROR` (the wait is held to the node's limit); `rpc.testnet.near.org`: the same after 13.1 s; dRPC: HTTP 408 after 2.1 s, `{"code":30,"message":"Request timeout on the free plan, please upgrade to paid plan"}`; Intear: no byte in 60 s. Only FastNEAR, among endpoints that are not deprecated, holds a `tx` wait. `send_tx` with `wait_until` was not sent (it needs a signed transaction); that it is held the same way is inferred from this `tx` result, not measured |
| How near-api-js sends | `node_modules/near-api-js/lib/index.js` 7.4.0, `fetchJsonRpc` and `retryConfig` | `JsonRpcProvider` retries 12 times (500 ms × 1.5ⁿ) on HTTP 500, 408, 503 and on a fetch that throws "Failed to fetch" (what Chromium reports for a 429 without CORS), on the same URL |
| A missing access key | `query` `view_access_key` of `rose-app.testnet` / `ed25519:11111111111111111111111111111111` on FastNEAR and dRPC | `result.error` = "access key ed25519:1111… does not exist while viewing" (a result, not a JSON-RPC error); a missing account answers `error.cause.name` `UNKNOWN_ACCOUNT` |
| The failover in a real browser | `failover.mjs` (session scratchpad): Playwright Chromium on a local production build of `fix/audit-web` (`pnpm exec next start --port 3400`), `context.route("https://test.rpc.fastnear.com/**", (route) => route.abort("failed"))`, then the same with dRPC aborted too; loads `/app/rounds`, `/app/rounds/4`, `/app/prices` and waits for a round card, the round page and the key stats | FastNEAR down: all three pages loaded (0.8 to 1.0 s each), 9 requests tried FastNEAR and 30 went to dRPC (the 10 s cooldown sends the rest of each page straight to dRPC). FastNEAR and dRPC down: all three loaded through Intear (3.8 to 6.9 s), 30 requests to Intear |

Decision: reads go FastNEAR, then dRPC, then Intear (`NEAR_READ_RPC_ENDPOINTS` in `apps/web/src/lib/deployment.ts`);
the demo wallet's reads (account check, balances, final head) use the same list, and its sends stay on
FastNEAR. `NearRpc` passes over an endpoint for 10 s after a 429, a 5xx, a non-JSON answer or a network
failure (`RPC_COOLDOWN_MS`), so one limited provider costs one failed request, not one per view.

### Endpoint behaviour on 2026-11-06

| Fact | Command | Result |
|---|---|---|
| A third public NEAR testnet endpoint answers browser reads with CORS (the app falls back to it for views only, after FastNEAR and `rpc.testnet.near.org`) | `curl -s -X OPTIONS -D - -H 'Origin: https://rose-rounds.vercel.app' -H 'Access-Control-Request-Method: POST' -H 'Access-Control-Request-Headers: content-type' https://near-testnet.drpc.org`; then POSTs of `query` `call_function` `get_limits` and `view_access_key_list` on `engine-s5.rose-app.testnet`, and 40 parallel `block` requests | preflight HTTP/2 204 with `access-control-allow-origin: https://rose-rounds.vercel.app`, `allow-methods: POST`, `allow-headers: content-type`; `get_limits` HTTP/2 200 with `access-control-allow-origin: *` (block 276477802); the key list answers one FullAccess key; 40 of 40 `block` requests 200 |
| The same endpoint is unfit for transactions, so wallets keep the two other endpoints | `tx` with `wait_until` `EXECUTED` on a made-up hash at `https://near-testnet.drpc.org` | `{"code":30,"message":"Request timeout on the free plan, please upgrade to paid plan"}` |
| Other candidate endpoints | `near-testnet.lava.build`, `rpc.testnet.pagoda.co`, `endpoints.omniatech.io/v1/near/testnet/public` | 410 (discontinued), 403 (deprecated), 521 |

### NEAR testnet RPC fallback

| Fact | Command | Result |
|---|---|---|
| The former SDK fallback is deprecated and refused this query (14 November, before 01:28 UTC; it answered again at 02:48 UTC, see "near-api-js retries and the official endpoint") | `curl -s https://rpc.testnet.near.org -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"call_function","finality":"final","account_id":"engine-v2.rose-app.testnet","method_name":"get_sol_deposit","args_base64":"<base64 of {\"metadata\":\"Cg3h…d7d8A\"}>"}}'` | HTTP 429, error -429 "WARNING! THIS ENDPOINT IS DEPRECATED! STOP USING IT NOW!" |
| FastNEAR's second host shares the primary's per-IP limit | 60 `view_account` of `engine-v2.rose-app.testnet` to `https://test.rpc.fastnear.com` (`seq 1 60 \| xargs -P 12 curl …`), then 10 to `https://rpc.testnet.fastnear.com`, then 5 to the first again | 32 × 200 and 28 × 429; then 2 × 200 and 8 × 429; then 5 × 429 |
| dRPC answers, with CORS, and is another provider | the `get_sol_deposit` query above at `https://near-testnet.drpc.org`; `curl -s -i -X OPTIONS -H 'Origin: https://rose-rounds.vercel.app' -H 'Access-Control-Request-Method: POST' -H 'Access-Control-Request-Headers: content-type' https://near-testnet.drpc.org` | the deposit record (block 277,589,302); HTTP/2 204 with `access-control-allow-origin: https://rose-rounds.vercel.app`. It is the SDK's fallback (`NEAR_TESTNET_RPC_FALLBACK`); its free plan times out long `tx` waits ("Endpoint behaviour on 2026-11-06" above), and staging deployment 3 already ran `e2e-solana-stream.mjs` through it |
| Lava's public NEAR testnet endpoints are gone | the same query at `https://neart.lava.build` and `https://near-testnet.lava.build` | HTTP 410 "This endpoint has been discontinued." |

### near-api-js retries and the official endpoint

| Fact | Command | Result |
|---|---|---|
| near-api-js 7.4.0 `JsonRpcProvider` counts attempts, not retries, and resends the same POST on its own | `grep -n "async function backOff" -A17 node_modules/near-api-js/lib/index.cjs` and `retryConfig`; then a `sendJsonRpc("send_tx", {})` through `new JsonRpcProvider({ url }, { retries })` with `globalThis.fetch` stubbed to answer HTTP 503, for `retries` 0, 1 and 3 | `backOff` loops `attempt <= numOfAttempts` with `numOfAttempts = retries`, retrying HTTP 500, 408, 503 and a fetch that throws "FetchError" or "Failed to fetch" (not 429, which `fetchJsonRpc` turns into an error that is not retried). Posts counted: `retries` 0 → 0 posts and "Exceeded 10 attempts"; 1 → 1 post; 3 → 3 posts. The scripts' send provider uses `retries: 1` (`singleSendProvider`, covered by `scripts/lib/near.test.ts`) |
| `rpc.testnet.near.org` answers again, slowly, an hour after it refused | `for i in $(seq 1 10); do curl -sS -m 20 -o body$i.txt -D hdr$i.txt -w "%{http_code} %{time_total}\n" -X POST https://rpc.testnet.near.org -H 'content-type: application/json' -H 'Origin: https://rose-rounds.vercel.app' -d '{"jsonrpc":"2.0","id":"x","method":"status","params":[]}'; done`, 02:48:04 to 02:48:36 UTC | 10 × HTTP 200, 3.10 to 3.23 s each, every answer with `access-control-allow-origin: *` (and `vary: origin`), `chain_id` `testnet`, protocol 88. With the refusals earlier that night (HTTP 429, error -429 "THIS ENDPOINT IS DEPRECATED", no CORS header: "The former SDK fallback …" before 01:28 UTC and "The official RPC is deprecated …" from 01:26 to 01:38 UTC, other clients on the IP) and of 2026-11-04 (after about 150 queries in a row): deprecated, refuses under load, not dead. The SDK and the app keep it out of their endpoint lists |

### Idempotent NEAR sends in the scripts

| Fact | Command | Result |
|---|---|---|
| A transaction the network does not know is told apart from a failed lookup | `curl -s <rpc> -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tx","params":{"tx_hash":"4uUzdXnzkMbzzxW2CfkQZYnPMrd1XGsmzzeb2LeU2JW6","sender_account_id":"rose-app.testnet","wait_until":"NONE"}}'` at `https://near-testnet.drpc.org` and `https://test.rpc.fastnear.com` | both answer at once with `error.cause.name` `UNKNOWN_TRANSACTION` ("Transaction … doesn't exist"); `scripts/lib/near.ts` resends a signed transaction only on that answer, after a rate limit or a transport failure, and returns the final outcome when the lookup finds the hash. A transaction older than the nodes' retention also reads `UNKNOWN_TRANSACTION` (the root account's creation, `66SvxXgw…`), so the lookup runs right after the failed send, not later |

## Explorers

| Explorer | Command | Result (2026-11-04) |
|---|---|---|
| NearBlocks testnet | `curl https://api-testnet.nearblocks.io/v1/blocks/latest?limit=1`; `/v1/txns/<hash>`; `curl -I https://testnet.nearblocks.io` | frozen: latest indexed block 270,420,307 (2026-09-27) while the RPC head is above 276,120,000; `{"txns":[]}` for every spike transaction; the site serves a Cloudflare challenge (403 to curl and headless Chromium) |
| `explorer.testnet.near.org/transactions/<hash>` | `curl -s -o /dev/null -w '%{http_code}'` | 200, but only an "Explorer Selector" page (offers Near Rocks, Near Validate, NearBlocks); near-cli-rs prints these links |
| `https://testnet.near.rocks/tx/<hash>` (FastNear) | `curl -s -o page.html -w '%{http_code} %{size_download}' -A 'Mozilla/5.0' https://testnet.near.rocks/tx/Dm5hBXUzRLGXd7XPfWQ7cJkgaV5MTQnttTZQACYBa8Pd` and the same for `8Pg3zu3R…yogf` | `200 1126` in 0.1 s (client-rendered shell, title "NEAR Rocks - NEAR explorer by FastNear"); in a browser it showed the IBE spike transactions within a minute (signer, 124.32 Tgas, 0.01241 NEAR burnt). **Primary explorer** (same provider as the app's RPC) |
| `https://nearvalidate.org/txns/<hash>?network=testnet` | same `curl` for both hashes | `200 32613` in 0.1 s (client-rendered, title "Near Transaction \| Near Validate", "Built by NearBlocks", RPC based); in a browser it showed `8Pg3zu…yogf` with block 276,123,296 and the receipt tree. **Fallback** |
| near.rocks account and block routes (re-checked 2026-11-04 15:00 UTC) | headless Chromium (Playwright 1.64.1) loading each URL, waiting 4 s, then `document.body.innerText` | `https://testnet.near.rocks/address/engine-s4.rose-app.testnet` renders 0 characters (empty page); `https://testnet.near.rocks/account/engine-s4.rose-app.testnet` renders the account (balance 12.93892 Ⓝ, 1.0 MB storage, 1 access key); `https://testnet.near.rocks/block/276204160` renders the block (hash `9MiZpjF4…QVAW6`). The app links accounts to `/account/<id>` and blocks to `/block/<height>` (`apps/web/src/lib/explorer.ts`, the one explorer helper) |
| Base Sepolia | `https://sepolia.basescan.org/tx/<hash>` | live in a browser (every Base link above); 403 to plain curl (bot protection) |
| Solana devnet | `https://explorer.solana.com/tx/<sig>?cluster=devnet` | live in a browser (every Solana link above); 429 to plain curl |

## Clearing and unlock math (`contracts/engine`, pure Rust)

| Fact | Command | Result (2026-11-04) |
|---|---|---|
| Sablier source pin | `gh api repos/sablier-labs/evm-monorepo/releases`; ported `lockup/src/libraries/LockupMath.sol` `calculateStreamedAmountLL` at commit `fae38dc7e43c6cab6de8f97124c559f42ed5b77a` (`lockup@v4.0.1`) | integer formula above; `SablierLinearStream::streamed_amount` is an exact port, validated constructors mirror `LockupHelpers._checkTimestampsAndUnlockAmounts` |
| Live check of the Sablier port | for every non-canceled, non-depleted LL stream (`getLockupModel == 0`) at blocks 54,159,642, 53,959,642 and 53,159,642: `cast call 0xA65A…532e "getStartTime(uint256)" / getCliffTime / getEndTime / getGranularity / getUnlockAmounts / getDepositedAmount / "streamedAmountOf(uint256)(uint128)" <id> --block <N> --rpc-url https://sepolia.base.org`, then the Rust port evaluated at each block's timestamp by a scratch binary depending on `rose-engine` | 197 of 197 (stream, block) pairs match exactly (67 + 65 + 65 rows, 109 of them strictly mid-stream), including cliffs and a stream with `granularity = 86400` |
| Class fraction margin | `cargo test -p rose-engine` property test; mutation (margin removed) fails it | Sablier floors per stream, so a class `f(t)` must be `max(u0, u0 + floor(1e18 * n*g*a / (d * total)) - ceil(1e18 / 10^decimals))` on the linear segment and positions below one whole token are refused; Streamflow is exactly proportional and needs no margin |
| Streamflow source pins | streamflow-finance/rust-sdk commit `63df7d7b831340daa27f31d007eec2a98380364c` `programs/streamflow-sdk/src/state.rs` (`effective_start_time`, `vested_available`, `cliff_available`, `available_to_claim`); js-sdk `v13.4.0` commit `fb236fff325ab02d7ff5d0ff5e393be8934cda9d` `packages/stream/solana/contractUtils.ts` `calculateUnlockedAmount` | `start = cliff if cliff > 0 else start_time`; `t < start → 0`; `t >= end_time → net_amount_deposited` (Rust SDK rule); else `min(cliff_amount + floor((t - start) / period) * amount_per_period, net_amount_deposited)`; the on-chain program source is not public |
| Exit and Advance fill rule | `contracts/engine/src/clearing/uniform.rs`; brute-force reference in `tests/clearing.rs`; vector "exit: midpoint of the tied interval" | whole price levels by priority while the cumulative fits `V(P*)`, first level that does not fit rationed by largest remainder (ties to the lower id), the rest unfilled; the tie interval is contiguous (asserted by the brute force); an Advance with one bid 50 @ 20 against reserve 10 clears at 15 |
| Tests | `cargo test -p rose-engine` | exit 0: 33 unit + 5 clearing proptests (brute-force reference over every tick, 2,000 cases each) + 7 unlock proptests (1,000 cases each) + 2 vector tests (`tests/vectors/clearing.json` 34 cases, `unlock.json` 15 Sablier, 12 Streamflow, 7 accrual) |
| Lint, format, wasm | `cargo clippy -p rose-engine --all-targets -- -D warnings`; `cargo fmt -p rose-engine -- --check`; `cargo build -p rose-engine --target wasm32-unknown-unknown --release` | all exit 0 |
| Mutations caught | midpoint rounding up, Hamilton ties to the higher id, Tender ties to the highest price, Sablier margin removed | each makes the property tests fail |
| Dependencies | `cargo search uint`, `proptest` | `uint` 0.10.2 (`default-features = false`), `proptest` 1.12.0, `serde_json` 1.0.154 |

## Sandbox integration tests and gas (2026-11-04)

Commands: `ROSE_SANDBOX=1 cargo test -p rose-engine --test sandbox_lifecycle -- --nocapture --test-threads=1`, then `--test sandbox_recorded` and `--test sandbox_staging` (near-workspaces 0.24.0, near-sandbox 0.4.0, `neard` 2.14.0 protocol 88; `contracts/mock-mpc` replays recorded live MPC responses; wasm `c377a125…0cf`, 966,845 bytes). Results: lifecycle 6/6 (247.8 s, including `clear_at_the_bid_cap` with 64 opened orders), recorded 1/1 (31.1 s), staging replay 1/1 (36.5 s); `ps aux | grep near-sandbox` counts 0 processes after each suite (every test owns its sandbox, killed on drop). Every measured user-facing call is asserted under 300 Tgas by `GasTable::ok`.

Rerun after the Solana custody v2 change (2026-11-04, final wasm `928d72ef…0e50`, 1,010,528 bytes): `contracts/mock-mpc` now derives every key from a fixed test seed and signs what it is asked to sign (secp256k1 low-s with recovery id, Ed25519), signs with its domain-3 key the payload hash a test registered for an exact ForeignTx request, and replays a recorded real response only for the payload or transaction it was recorded for (the staging replay keeps `engine-s1`'s real derived keys, `tests/vectors/sandbox/staging/derived_keys.json`). The engine verifies every signature it stores (`ecrecover` against `vault/base`, `ed25519_verify` against the authority and `gas/sol`), and the tests check them again against the bootstrapped keys. Results: lifecycle 6/6 (254.4 s; new scenario `solana_two_phase_payout_and_redeem`: attribute, move, register, claim drawing on the stream, redeem refused while the payout is unconfirmed, `confirm_sol_payout` landed, redeem, `confirm_sol_redeem` released; `key_timeout_cancel_waits_for_the_key_request`), recorded 1/1 (31.0 s), staging replay 1/1 (48.5 s); 0 `near-sandbox` processes left. Sandbox gas (Tgas): `claim_sol_tokens` 46.57, `redeem` (Solana) 46.57, `attribute_sol_deposit` 30.18, `move_sol_deposit` 28.12, `register_sol_deposit` 24.26, `bootstrap` 23.34, `register_base_deposit` 22.7, `redeem` (Base) 22.33, `confirm_sol_redeem` 21.35, `claim_base_tokens` 21.01, `confirm_sol_payout` 20.84, `close` (MPC failure) 11.97, `cancel_no_key` 3.12.

Per-method gas burnt per transaction (`total_gas_burnt`, all receipts), Tgas, over all scenarios:

| Method | Tgas (min - max) | n |
|---|---|---|
| `open_bid` | 131.69 - 131.87 | 71 |
| `claim_sol_tokens` | 24.97 | 1 |
| `close` | 22.69 - 22.76 | 7 |
| `attribute_sol_deposit` | 15.35 | 1 |
| `move_sol_deposit` | 14.16 | 1 |
| `register_sol_deposit` | 12.53 | 1 |
| `bootstrap` | 11.73 - 11.78 | 8 |
| `close (late callback)` | 11.76 | 1 |
| `close (MPC failure)` | 11.75 | 1 |
| `register_base_deposit` | 11.21 - 11.38 | 9 |
| `clear` | 3.59 - 11.08 | 4 |
| `redeem` | 10.76 | 1 |
| `claim_base_tokens` | 9.66 | 2 |
| `mt_transfer_call` | 9.29 | 1 |
| `withdraw_near_cash` | 8.29 | 1 |
| `ft_transfer_call (tUSDC -> ft_on_transfer)` | 7.18 - 7.29 | 72 |
| `settle_bid` | 4.68 - 6.96 | 71 |
| `distribute_units` | 5.06 | 1 |
| `place_ask` | 3.87 - 4.17 | 9 |
| `place_bid` | 3.85 - 3.90 | 65 |
| `storage_withdraw` | 3.80 | 1 |
| `storage_unregister` | 3.78 | 1 |
| `create_advance` | 3.63 | 1 |
| `mt_transfer` | 3.55 | 1 |
| `release_lien` | 3.55 | 1 |
| `create_tender` | 3.42 | 1 |
| `create_exit` | 3.18 - 3.20 | 8 |
| `cancel_no_key` | 3.08 | 1 |
| `cancel_no_key (key in flight)` | 3.04 | 1 |
| `storage_deposit` | 2.96 - 2.99 | 74 |
| `storage_deposit (for another account)` | 2.98 | 1 |

The mock's MPC receipts cost about 1 Tgas where the live MPC request and yield resume cost 8 to 15 Tgas, so the MPC-backed methods measure lower in the sandbox than live: compare the live column of the staging tables (`register_base_deposit`, `close`, `claim_base_tokens`, `attribute_sol_deposit`, `move_sol_deposit`, `register_sol_deposit`, `claim_sol_tokens`). The highest user-facing call live and in the sandbox is `open_bid` at about 132 Tgas (the in-contract IBE opening), below the 300 Tgas cap.

## Build notes

| Fact | Command | Result (2026-11-04) |
|---|---|---|
| tUSDC deployed wasm vs current build | `cargo near build non-reproducible-wasm` in `contracts/tusdc` | deployed wasm (bs58 `7JHPYMQ1o7QVhVyMwmzzxS3vVhyqEkcWQrGJUcmubizP`) was built with rustc 1.91.1 before the toolchain pin; builds under 1.95.0 give `HgPQd1QJ1rncPS2E8tYawonseJhJpM3RPfyF81QwFpaH`; the only source change between them is rustfmt and the removal of an unverified reproducible-build image tag |
| SDK toolchain | `npm view <pkg> version` and `peerDependencies` | typescript 6.0.3 (typescript-eslint 8.72.1 peers `<6.1.0`), typescript-eslint 8.72.1, eslint 10.14.0 for the SDK (9.39.5 in the web app, pinned by eslint-config-next peers), vitest 5.1.0, fast-check 4.10.2, @types/node 22.20.5; SDK built with plain `tsc` |

## IBE wasm build paths (2026-11-14)

- IBE wasm rebuilt with local paths remapped: `packages/ibe-wasm/build-wasm.sh` now passes
  `--remap-path-prefix` for the cargo home and the checkout, so the committed binary no longer embeds
  the builder's home directory in its panic locations. Check: `strings packages/ibe-wasm/pkg/rose_ibe_bg.wasm | grep -c /Users/`
  prints `0`. `rose_ibe_bg.wasm` is now 215,341 bytes (216,109 before); `pnpm --filter @rose/ibe-wasm test`
  (8 tests, live-key round trip) exit 0.

## Engine ABI snapshot for the SDK's binding check (2026-11-14)

| Fact | Command | Result |
|---|---|---|
| The engine source is the deployed one | `git diff --quiet 0524b33 HEAD -- contracts/engine/src ':!contracts/engine/src/tests' contracts/engine/Cargo.toml Cargo.lock` | exit 0 (only test files changed since `0524b33`, the commit deployed as `engine-v2.rose-app.testnet`) |
| The committed ABI is that engine's | `cargo near abi` in `contracts/engine` (cargo-near 0.22.0, Rust 1.95.0), then `cp target/near/rose_engine/rose_engine_abi.json packages/sdk/test/engine/` | 289,048 bytes, sha256 `b5a5a7f2413a857e4de24529fec4eb631cbf92fdf8682e3f62ad0e70cb6a08a7`, 105 functions, schema 0.4.0; its `body` equals the ABI of the 2026-11-06 `cargo near build` (which only adds `metadata.build` and `metadata.wasm_hash`) |
| The check runs on a clean clone | `pnpm --filter @rose/sdk exec vitest run test/engine/abi.test.ts` with and without `target/near/rose_engine/rose_engine_abi.json` | 5 passed with a local build (its body equals the snapshot's); 4 passed and the local-build comparison skipped without one |

## Keyless deployment path and script checks (2026-11-04)

The `--keyless` path of `scripts/deploy-engine.sh` (code hash checked before any key is deleted, every
key deleted in one transaction with the keychain's signing key last, `view_access_key_list` polled at
`final` for up to 60 s, `--role final` refused without `--keyless`, `--verify-only` recovery) was
rehearsed live on a throwaway account before the final deployment; the other rows are the key-handling
and vector facts the scripts rely on.

| Fact | Command | Result (2026-11-04) |
|---|---|---|
| near-cli-rs deletes several keys in one transaction | `near --version`; `near account delete-keys <account> public-keys --help` | near-cli-rs 0.30.1; `[PUBLIC_KEYS]  Enter the public keys you wish to delete (separated by comma)` |
| Keyless rehearsal on a throwaway sub-account | `scripts/rehearse-keyless.sh keyless-rehearsal-1793801863.rose-app.testnet` (default 34-byte wasm exporting `noop`, 0.02 NEAR) | create [5VmkFoH6…](https://testnet.near.rocks/tx/5VmkFoH6Zme4NqCYW54d15LBfrZA3nkGHdB4txyc3aii), deploy without init [BmL6RDDf…](https://testnet.near.rocks/tx/BmL6RDDfAwsuHcNZGNmDjkibQsQhyMCbemHaPpYHFME7), second full-access key nobody holds [14NCQiorF…](https://testnet.near.rocks/tx/14NCQiorFt3LNXQWQVhweKYYMnm96DdgxTvJNyEj6aM5), both keys deleted [LajMMx8z…](https://testnet.near.rocks/tx/LajMMx8zpF2HRvnYsDA4WMikPCnM75z52DBowXUSbTC); then `[]` at `final` on the first pass, and the second pass sent nothing. Record: `deployments/e2e/keyless-rehearsal-1793801863.rose-app.testnet.json` |
| The deletion is one transaction, signing key last | `curl -s https://test.rpc.fastnear.com -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"EXPERIMENTAL_tx_status","params":{"tx_hash":"LajMMx8zpF2HRvnYsDA4WMikPCnM75z52DBowXUSbTC","sender_account_id":"keyless-rehearsal-1793801863.rose-app.testnet","wait_until":"FINAL"}}' \| jq -c '{signer:.result.transaction.public_key, actions:.result.transaction.actions, status:.result.status}'` | signer `ed25519:GHcZejtEKHuSVFrjc5VQZryBUXd642zYcqXGAYEoCSMZ` (the keychain key); actions `DeleteKey ed25519:D9VEBP9sauteWCEGQABgbjBVm57HPp5rnwDMy4Rikdb3` (the extra key) then `DeleteKey ed25519:GHcZejtEKHuSVFrjc5VQZryBUXd642zYcqXGAYEoCSMZ` (the signing key); `SuccessValue ""` |
| The rehearsal account is keyless and runs the deployed code | `view_access_key_list` and `view_account` at `finality: "final"`, `call_function noop` | block 276,206,050: `keys: []`; `code_hash` `25BW6p7Dhpfyb4vcDq4QMVXa7U21baMgf5rQmwfQqjwj` = base58 of sha256 `0fede26edc2ac811e86a42fe36ccc187dbd3119ba77f5a4fa450ddb0a6cb7e7e` of the 34-byte module (checked by `near_require_code` before the deletion); `noop` returns an empty result; `storage_usage` 134 bytes |
| The code check reads the deployed engine correctly | `source scripts/lib.sh; near_code_sha256 engine-s4.rose-app.testnet; near_code_sha256 rose-app.testnet` | `41a514d6c18e074719678d6d3cd77640acaacd3531de7d14be6819bbb80f8fdf` (the engine-s4 wasm sha256 of the README); all zeros for an account without code |
| cast and forge read no private key from the environment | `cast --version`; `cast send --help`; `forge script --help` | cast 1.4.2: `--private-key <RAW_PRIVATE_KEY>` has no `[env: ...]`; `--keystore <PATH>` `[env: ETH_KEYSTORE=]`, `--password-file <PASSWORD_FILE>` `[env: ETH_PASSWORD=]`; forge script the same (`--keystore <PATHS>`, `--password-file <PATHS>`) |
| A keystore written by `scripts/evm-keystore.ts` opens in Foundry | `ROSE_CONFIG_DIR=<scratch dir> node scripts/evm-keystore.ts probe` with a published test key, then `cast wallet address --keystore <dir>/keystores/probe.json --password-file <dir>/keystores/probe.password` and `cast wallet sign --keystore … --password-file … rose` against the same commands with `--private-key` | same address `0x2c7536E3605D9C16a7a3D7b1898e529396a65c23`, same signature `0xdd89331f…aa7e1b`; files mode 600, directory 700 |
| forge broadcasts deployments from the keystore | `ROSE_VAULT_SIGNER=0x8a8b95399f00ba2aac6babdc56cf761b22ee3ad6 forge script contracts/evm/script/DeployRoseVault.s.sol --rpc-url https://sepolia.base.org --keystore ~/.config/rose/keystores/evm-deployer.json --password-file ~/.config/rose/keystores/evm-deployer.password --sender 0x7d4777cfc6ed48061b0bccae558d29919b412042` (no `--broadcast`) | `SIMULATION COMPLETE`; the dry-run file's CREATE of RoseVault is `from` the deployer `0x7d4777cf…2042`; nothing was broadcast |
| Transfer EIP-712 known answer for the SDK test | `cast call --rpc-url https://sepolia.base.org 0x14c7f1f870ccb5569a01399013ceeeffc465e243 'hashTransfer((address,address,uint256,uint256))(bytes32)' '(0x036CbD53842c5426634e7929541eC2318f3dCF7e,0x000000000000000000000000000000000000b0b0,12345,7)'` | `0xe9dbe8f15bafc915d91ae21a03e5e125267a85d5d268d204ea42430e62817f73`, equal to viem `hashTypedData` (domain `RoseVault`, `1`, 84532, the vault) in `packages/sdk/test/chains/base.vault-calls.test.ts` |
| Streamflow stream lookup used to resume stream creation | `SolanaStreamClient.searchStreams({ mint, sender, recipient })` (@streamflow/stream 13.4.0, devnet) for the CINDR mint `2eWdSYbc…DLNv` from the ops key | to Ines Marlow's holder key: 0 streams (hers was deposited); to the engine-s4 vault: `4rX9gu7z…rNc9` (300,000 CINDR) and `FejgqrGU…jtFm` (200,000 CINDR), names padded with NUL bytes (stripped before comparison) |
| The web3.js message vectors are reproducible from the repository | `node scripts/solana-vectors.ts --check` | `contracts/engine/tests/vectors/foreign/solana_web3js_messages.json: 5 messages identical`, `packages/sdk/test/chains/fixtures/solana_messages.json: 2 messages identical` (keys and ATA too), with @solana/web3.js 1.99.0, @solana/spl-token 0.4.15, @streamflow/stream 13.4.0; the inputs are the recorded vault and gas addresses, Circle's devnet USDC mint, `Keypair.fromSeed` of 32 bytes `0x01` to `0x05` and a nonce value of 32 bytes `0x42` |
| Who sent the engine-s4 openings | `EXPERIMENTAL_tx_status` of [FjA2x3Z2…](https://testnet.near.rocks/tx/FjA2x3Z28YfdjrDMnSnavS8aEmj47WTMyELEum3cZZMB); labels of the `open:*` steps of `deployments/e2e/engine-s4.rose-app.testnet.live.json` | signer `rose-app.testnet`, `open_bid` on `engine-s4.rose-app.testnet`; 9 of the 10 opening transactions are by `rose-app.testnet` (the tenth is the malformed bid's author's refused attempt); the three rounds were created by Cindral Foundation, Ines Marlow and Teodor Vance, so the opener placed no order and created no round |
| The recovery mode refuses an engine that keeps a key | `scripts/deploy-engine.sh engine-s4.rose-app.testnet --role final --verify-only`, then `scripts/deploy-engine.sh engine-s4.rose-app.testnet --role staging --keyless --verify-only` with the engine-s4 wasm in `target/near/rose_engine/` (no transaction is sent; the `deployments/testnet.json` changes of the run were discarded) | the first exits with "--role final requires --keyless"; the second passes the code check (`41a514d6…8fdf`) and the derived-address check, polls 60 s and exits non-zero with the engine's one FullAccess key `ed25519:2mj79igw…Jxat` still listed |
| near-cli-rs takes an exact yoctoNEAR deposit (the scripts no longer convert deposits through floating point) | `near contract call-function as-transaction tusdc.rose-app.testnet ft_metadata json-args '{}' prepaid-gas '30 Tgas' attached-deposit '16500000000000000000000 yoctoNEAR' sign-as rose-app.testnet network-config testnet sign-later` (near 0.30.1; stops at the signing prompt, nothing sent) | parsed as `deposit: 0.0165 NEAR` |

## Production dependency advisories (2026-11-14)

| Fact | Command | Result |
|---|---|---|
| What `pnpm audit` reports, and which fix fits | `pnpm audit --prod --json`; the declared ranges from each dependent's `package.json` under `node_modules/.pnpm` | 13 advisories before the change. `bn.js` 5.2.2, a direct dependency of `apps/web`, is fixed in 5.2.3 (same major; the scripts already pinned it): bumped. No other fix is in its dependent's range: `toml` `^3.0.0` (`@coral-xyz/anchor` 0.32.1) against 5.0.1, `stream-json` `^1.9.1` (`jayson` 4.3.0) against 3.6.0, `uuid` `^9.0.0` (`@solflare-wallet/sdk` 1.4.2) and `^8.3.2` (jayson) against 11.1.1, and `bigint-buffer` (`@solana/buffer-layout-utils` `^1.1.5`) has no fixed release. After the bump: 12 (7 high, 5 moderate), recorded as accepted in `docs/security.md` |
| Where the vulnerable code is reached | `grep` in the installed packages: `toml.parse(fs.readFileSync("Anchor.toml"))` in `@coral-xyz/anchor/dist/cjs/workspace.js`; `require('stream-json/…')` in `jayson/lib/utils.js`, used by `parseStream` of `lib/client/tcp.js` and `tls.js` only; `require('uuid').v4` in jayson and `import { v4 as uuidv4 } from 'uuid'` in Solflare's `adapters/iframe.js` | none of the vulnerable paths is on a path rose calls |

## Web app: toolchain, fonts and engine view errors

| Fact | Command | Result (2026-11-04) |
|---|---|---|
| Web package versions | `npm view <pkg> version` for next, react, react-dom, tailwindcss, @tailwindcss/postcss, three, @types/three, vitest, @playwright/test, eslint-config-next, geist | next 16.4.5, react 19.3.1, react-dom 19.3.1, tailwindcss 4.3.4, @tailwindcss/postcss 4.3.4, three 0.187.0, @types/three 0.187.0, vitest 5.1.0, @playwright/test 1.64.1, eslint-config-next 16.4.5, geist 1.9.0 |
| TypeScript pinned to 6.0.3 (latest is 7.0.2) | `npm view typescript-eslint peerDependencies` | `typescript: '>=4.8.4 <6.1.0'` (typescript-eslint 8.72.1, used by eslint-config-next) |
| ESLint pinned to 9.39.5 (latest is 10.14.0) | `npm view eslint-plugin-react peerDependencies`, same for `eslint-plugin-import`, `eslint-plugin-jsx-a11y` | peer ranges stop at ESLint 9 |
| `next lint` removed in Next 16 | `node_modules/next/dist/docs/01-app/03-api-reference/05-config/03-eslint.md` | "Starting with Next.js 16, `next lint` is removed"; lint runs `eslint .` with `eslint-config-next/core-web-vitals` and `/typescript` flat configs |
| Departure Mono font and license | `curl https://api.github.com/repos/rektdeckard/departure-mono/releases/latest`, LICENSE in `DepartureMono-1.500.zip` | v1.500, font files under SIL Open Font License 1.1 (repository code MIT) |
| Geist Sans and Geist Mono license | `npm view geist@1.9.0 license` | SIL Open Font License |
| View call on a missing account | `curl https://test.rpc.fastnear.com` `query`/`call_function` on `no-such-rose-engine-xyz.testnet` | JSON-RPC `error.cause.name = "UNKNOWN_ACCOUNT"`, `data = "account ... does not exist while viewing"` |
| View call on an account without contract | same on `rose-app.testnet`, method `stats` | `result.error = "wasm execution failed with error: CompilationError(CodeDoesNotExist { account_id: \"rose-app.testnet\" })"` |
| View call on a missing method | same on `v1.signer-prod.testnet`, method `stats` | `result.error = "wasm execution failed with error: MethodResolveError(MethodNotFound)"` |
| View call success shape | same on `v1.signer-prod.testnet`, method `version` | `result.result` = UTF-8 bytes of the JSON value (`"3.18.0"`), plus `block_height` |
| Explorers reachable from scripts | `curl -L -o /dev/null -w '%{http_code}'` | `explorer.testnet.near.org` 200; `testnet.nearblocks.io` and `sepolia.basescan.org` 403 (bot protection); `explorer.solana.com` 429. Not yet used by the web app |

## Web wallets, chain layer and faucet (2026-11-04)

| Fact | Command | Result |
|---|---|---|
| NEAR wallet connector: NEAR Connect is what docs.near.org recommends | `https://docs.near.org/web3-apps/concepts/web-login` (fetched live) | The page documents `@hot-labs/near-connect` (`new NearConnector({ network: "testnet" })`, `wallet.signAndSendTransaction({ receiverId, actions })`) and never names wallet-selector; `@near-wallet-selector/core` is at 10.1.4 (last publish 2025-12-04) while `@hot-labs/near-connect` is at 0.12.0 (2026-10-26). Decision: NEAR Connect |
| Wallets with testnet support in the NEAR Connect manifest | `gh api repos/hot-dao/near-selector/contents/repository/manifest.json` (raw), `features.testnet` per wallet | Meteor, Intear, Nightly, Ledger, Unity, WalletConnect, Ethereum Wallets and NEAR CLI are flagged `testnet: true`; HOT Wallet and MyNearWallet carry no testnet flag and `NearConnector.js:123` hides them on testnet. The app lists exactly what the connector shows |
| near-connect package contents | `npm pack @hot-labs/near-connect@0.12.0`, `build/NearConnector.d.ts`, `build/types/index.d.ts` | `NearConnectorOptions { network, features, footerBranding, autoConnect, ... }`, events `wallet:signIn` / `wallet:signOut`, `getConnectedWallet()`, `NearWalletBase.signAndSendTransaction(params)` with wallet-selector action format or near-api-js actions |
| near-api-js 7.4.0 API used by the demo wallet | `npm view near-api-js version dependencies`, `node_modules/near-api-js/lib/*.d.ts` | `new Account(accountId, new JsonRpcProvider({ url }), KeyPairSigner.fromSecretKey(key))`, `account.signAndSendTransaction({ receiverId, actions: [actions.functionCall(method, args, gas, deposit)], waitUntil, throwOnFailure })`, `KeyPair.fromRandom("ed25519")`; dependencies borsh 2.0.0, @noble/curves 2.2.0, @scure/base 2.2.0 |
| Other wallet packages | `npm view <pkg> version` | wagmi 3.7.11 (peer viem 2.x, @tanstack/react-query >=5, typescript >=5.9.3), viem 2.57.16, @tanstack/react-query 5.105.3, @solana/web3.js 1.99.0 (latest 3.1.1 is a different API; wallet-adapter-react 0.15.40 peers `^1.99.0`, Streamflow pins 1.98.4), @solana/wallet-adapter-react 0.15.40, -base 0.9.28, -phantom 0.9.30, -solflare 0.6.34, @solana/spl-token 0.4.15, @streamflow/stream 13.4.0, buffer 6.0.3 |
| NEAR testnet account helper used by near-cli-rs | `near config show-connections` (near-cli-rs 0.30.1) and `gh api repos/near/near-cli-rs/contents/src/commands/account/create_account/sponsor_by_faucet_service/mod.rs?ref=v0.30.1` | `faucet_url = "https://helper.nearprotocol.com/account"`, `POST` JSON `{ "newAccountId", "newAccountPublicKey" }`, response = RPC transaction outcome |
| Helper verified live | `curl -X POST https://helper.nearprotocol.com/account -H 'content-type: application/json' -d '{"newAccountId":"rose-faucet-check-1793758847.testnet","newAccountPublicKey":"ed25519:8bWAWmjS8VxkwUiGJKyjEFZesSxchRZQ1YF5K6Xq8vu9"}'` | HTTP 200, `FinalExecutionOutcome` with `transaction.hash` = [8PRxQzVK…](https://testnet.near.rocks/tx/8PRxQzVKKEiiAtvA3XTcC1NEbWiQUtNddyrARMdwEuoK), signer `testnet`, account funded with 10 NEAR (`view_account`); re-posting the same id returns an `AccountAlreadyExists` receipt failure; a malformed key returns HTTP 400 `Invalid newAccountPublicKey` |
| Explorer links of spec section 6 opened in a browser | Playwright (headless Chromium) for near.rocks, nearvalidate and explorer.solana.com; Chrome (headed) for Basescan | `https://testnet.near.rocks/tx/66SvxXgw…` 200, hash shown; `https://nearvalidate.org/txns/66SvxXgw…?network=testnet` 200, title "Near Transaction 66SvxXgw… \| Near Validate", success; `https://explorer.solana.com/tx/4CrVjw75…?cluster=devnet` 200, title "Transaction \| 4CrVjw75paRmX7Uo... \| Solana"; `https://sepolia.basescan.org/tx/0xcddf41ac…` serves a Cloudflare challenge to headless Chromium (403, "Just a moment...") and renders in headed Chrome: "Status: Success, Block 54159281, ERC-721 token 82 to 0x3985…b5e0" |
| IBE wasm build | `cargo rustc -p rose-ibe --lib --crate-type cdylib --target wasm32-unknown-unknown --release --no-default-features --features wasm && wasm-bindgen --target web --typescript --out-dir packages/ibe-wasm/pkg --out-name rose_ibe target/wasm32-unknown-unknown/release/rose_ibe.wasm` (wasm-bindgen-cli 0.2.130, `packages/ibe-wasm/build-wasm.sh`) | `rose_ibe_bg.wasm` 216,109 bytes; the wrapper's test unwraps the live round-1 CKD response to `bls12381g1:6znYwWzn…` and round-trips a sealed order with the live key |
| Engine ABI used by the bindings | `cargo near build non-reproducible-wasm` in `contracts/engine`, `target/near/rose_engine/rose_engine_abi.json` | 94 functions; `packages/sdk/test/engine/abi.test.ts` checks every view and call binding (names, parameter names, payability) and the fixture keys against the schema definitions when the file is present |
| Base receipt used as a fixture | `curl -s https://sepolia.base.org -d '{"jsonrpc":"2.0","id":1,"method":"eth_getTransactionReceipt","params":["0xcddf41ac9ba8c7b1a9053bc52e62c0edb4bbd4ab55752d817042aae34a35eeb2"]}'` and the same for `0x81a6dfc3…` | block 54159281, tx index 2, logs at block-level indices 0, 1 (Lockup) and 2 (vault); cash deposit block 54159306, `CashDeposited` at log index 1 (`packages/sdk/test/chains/fixtures/`) |
| Streamflow metadata used as a fixture | `curl -s https://api.devnet.solana.com -d '{"jsonrpc":"2.0","id":1,"method":"getAccountInfo","params":["J2MxwxkCVey1o7SQUgLh4VPuomnnhtYJbkzVbGf4jdPc",{"encoding":"base64","commitment":"finalized"}]}'` | owner `HqDGZ…CMfMZ`, 1,104 bytes, slot 518424157; every distinctive value of the spike decodes at the offsets of `foreign/solana.rs` |

## Web app: facts measured against a live engine (2026-11-04)

Read live while the app ran against the staging engine `engine-s2.rose-app.testnet`.

| Fact | Command or evidence | Result |
|---|---|---|
| The NEAR account helper rate limits per IP | `curl -X POST https://helper.nearprotocol.com/account -d '{"newAccountId":…,"newAccountPublicKey":…}'` from the build machine | HTTP 429 `Rate limit exceeded, retry in 7 hours.`; from Vercel the same route created `rose-demo-ab9p6g.testnet` with 10 NEAR ([3PcbqYxk…](https://testnet.near.rocks/tx/3PcbqYxk6swd4vEd7QAGis5QEYkzBpS83rfhDDswDsdr)) |
| A funded account can create a top-level `.testnet` account | `near account create-account fund-myself rose-faucet.testnet '6.5 NEAR' … sign-as rose-ftx-752857.testnet` reports "The `create_account` call to `<testnet>` … succeeded"; the faucet fallback calls `testnet.create_account({new_account_id, new_public_key})` with 30 Tgas and the funding attached | `SuccessValue` `true` ([C8JspwHy…](https://testnet.near.rocks/tx/C8JspwHyzjP2DEe811bHruKe3kwyiTxbxbmyqZqbYAuB), [FJi7SycC…](https://testnet.near.rocks/tx/FJi7SycCRxkuMeg41owtM4Zz2aJVF3pCYVZPe2peG2Rv)); `rose-faucet.testnet` funded with 6.5 + 3.5 + 4 + 1.2 NEAR from idle spike accounts ([8LB6agZ3…](https://testnet.near.rocks/tx/8LB6agZ3jd9551isUqrEqrVV83BGnEedbYAnZXyT1w9D), [7NjBqnxK…](https://testnet.near.rocks/tx/7NjBqnxKjruE2fUfQLbiihKwBEwzm8qVctgrFcxYmh6P), [31qbQm6B…](https://testnet.near.rocks/tx/31qbQm6BRuG3S6XvHc8QsZXPM8eF9eigivZA5oT3WDHr)) |
| Prepaid gas is charged up front at the pessimistic price | `clear` with 300 Tgas signed by an account holding 0.3005 NEAR (near-api-js 7.4.0); `gas_price` = 100,000,000 | `Not enough balance … (balance: 300510537078113799999997, cost: 300919012540415500000000)`: 300 Tgas needs 0.3009 NEAR of balance although `clear` burns 4 to 11 Tgas. The SDK now attaches 50 Tgas to `clear` (11.1 Tgas measured at the 64-bid cap) and 200 Tgas to `open_bid` (132 Tgas measured) |
| Public NEAR RPC limits per IP | 60 parallel `view_account` to `https://test.rpc.fastnear.com` and to `https://rpc.testnet.near.org` (`seq 1 60 \| xargs -P 6 curl …`); 50 requests at 5 per second to FastNEAR | 30 × 200 + 30 × 429 (FastNEAR), 27 × 200 + 33 × 429 (rpc.testnet.near.org); 33 × 200 + 17 × 429 at 5 per second. Neither 429 carries `Access-Control-Allow-Origin`, so browsers report a CORS error. `NearRpc` now keeps a per-endpoint budget (20, then 2.5 per second), at most 4 requests in flight and shares identical requests in flight |
| `sepolia.base.org` refuses `eth_fillTransaction` | Playwright response log while the demo wallet mints tUSDC (viem 2.57.16 `prepareTransactionRequest` tries it first) | HTTP 401, then viem falls back; the demo wallet's transport now refuses that method locally |
| `get_events` stores unit variants without `data` | `get_events {"from_seq":"0","limit":5}` on `engine-s2.rose-app.testnet` | `{"seq":"0",…,"event":"bootstrap_requested"}` with no `data` key; the activity feed and the status page crashed or refused the page before the fix |
| `testnet` gas price | `curl https://rpc.testnet.near.org -d '{"method":"gas_price","params":[null]}'` | `100000000` |

## Engine views the app reads (2026-11-04)

Read live from `engine-s4.rose-app.testnet` through `https://test.rpc.fastnear.com` (`query` `call_function`, or `block` / `tx`):

| Fact | Command | Result |
|---|---|---|
| `get_price_history.round_id` is a JSON number, `get_rounds.round_id` a string | `get_price_history {"class_id":"0d06a458…f894"}`; `get_rounds` | `{"round_id":0,"kind":"Tender","price":"36000",…}` and `{"round_id":6,"kind":"Exit","price":"25000",…}`; `get_rounds` gives `"round_id":"0"` with `"reference_price":"80000"`. The Prices page keys both with `String(...)` |
| Advance prices share a class with Exit and Tender prices | `get_price_history {"class_id":"c5b14256…8bba"}` | `{"round_id":2,"kind":"Advance","price":"37500",…}`: per claimed token, now its own series |
| `get_price_history` pages | `contracts/engine/src/views.rs` `get_price_history(class_id, from_index, limit)` | default limit 50, returns `total`; the page reads until `total` |
| Create Exit locked share, live CINDR class (cliff 0) | `get_class {"class_id":"c5b14256…8bba"}` at block 276204160 (timestamp `1793800797965951876`) | `fraction_now` `175108133561643834`; `fractionAt` of `lib/unlock-schedule` at 1793800797 s gives the same value (unit test), locked 82.48% (the removed local formula showed 10.00%) |
| `rounds_total` is the next round id | `stats` | `{"rounds_total":8,…}` for rounds 0 to 7; the list pages backwards from it |
| NEAR testnet block time (for the 250-block `cancel_no_key` guard) | `block` at heights 276194160, 276203160, 276204160 | 1,000 blocks in 586.96 s, 10,000 blocks in 5,773.4 s: 0.58 s per block; the app waits 250 blocks at 0.8 s (200 s) after the last `close` |
| Solana payout and redeem shown in the guided demo | `tx` `9HZ8GCwnmTTCJYgv9oUCvaMre6FcDJQZ7Zu5cATyJyHF` (sender `b1.rose-ckd-1793753433.testnet`); Solana `getSignatureStatuses` with `searchTransactionHistory` for `4PPo8oWz…grBc` and `44Jfunex…pq8R8` | `confirm_sol_payout`, `FINAL`, `SuccessValue` `true`; both Solana signatures `finalized`, `err: null` (slots 518536724 and 518536864). The manifest takes them from `deployments/e2e/engine-s4.rose-app.testnet.solana.json` |
| `close` and `cancel_no_key` refusals the app now anticipates | `contracts/engine/src/sealing.rs` | `close`: "Key timeout reached: the round can only be cancelled (cancel_no_key)" once `bid_count > 0` and `now >= closes_at + key_timeout`; `cancel_no_key`: "Key timeout not reached", and "A key request is in flight" for `KEY_REQUEST_FLIGHT_BLOCKS = 250` after the last `close` |
| `register_base_cash` returns the verdict | `contracts/engine/src/custody/base.rs` `on_base_cash_verified` | `false` on a mismatch or `PromiseError` (pending key cleared, nothing credited) and on a refusal (`refuse_cash`); the order form reads the value and the replay key before reporting a credit |

## Faucet limits and DAO funding (2026-11-04)

Faucet limits. No Vercel KV, Upstash or Edge Config is provisioned (`vercel integration list` answers "No resources found", `vercel env ls` lists only the hot-wallet keys, the cookie secret and the `NEXT_PUBLIC_*` addresses), so the durable limit store is each hot wallet's own chain history:

| Fact | Command | Result |
|---|---|---|
| Base Sepolia block time | `eth_getBlockByNumber` on `https://sepolia.base.org` for the head and head − 10,000 | 0.2 s per block (head 54,394,534); the faucet measures it on each request instead of assuming it |
| Base Sepolia serves the nonce at old blocks | `eth_getTransactionCount(0xe873…c59e, <block>)` at head, head − 1,800, head − 43,200, head − 432,000 (86,400 s ago) and head − 1,000,000 (200,000 s ago) | Every query answers (`0x2` back to 50,000 blocks, `0x0` before the wallet's first send), so "sends in the last hour / day" = pending nonce − nonce at the window's first block |
| NEAR testnet keeps access-key state for more than a day | `query view_access_key` for `rose-faucet.testnet` / `ed25519:2yRr…UAec` with `block_id` = head − 3,600, head − 90,000 and head − 200,000 on `https://rpc.testnet.near.org` | Answers at every height (0.577 s per block measured; the key, nonce `276151044000004`, did not exist yet at the two older heights and the RPC says "does not exist while viewing"), so the funder's sends per window = nonce now − nonce then, or − `floor(nonce / 1e6) × 1e6` (its creation nonce) when the key is younger than the window |
| Solana devnet signature history with block times | `getSignaturesForAddress(DJgW…mzxV, {limit: 20})` on `https://api.devnet.solana.com` | 3 signatures with `blockTime` and `err: null`; the faucet counts the hot wallet's signatures per window (refills included, which only tightens the cap) |
| A missing NEAR account | `query view_account` for an unused id | JSON-RPC error with `cause.name` = `UNKNOWN_ACCOUNT`; the faucet refuses an existing id before calling the helper |
| Cross-site simple requests to the faucet | `curl -X POST https://rose-rounds.vercel.app/api/faucet -H 'content-type: text/plain' -H 'origin: https://evil.example' -d '{"chain":"base","address":"0x1"}'` | HTTP 400 from the body validator, so the body was parsed; the route now answers 415 for a non-JSON type and 403 for a foreign or missing Origin before reading the body |
| viem 2.57.16 nonce manager and nonce errors | `node_modules/viem/_esm/utils/nonceManager.js`, `_esm/errors/node.js` | `nonceManager` (exported from `viem`) keeps the last nonce per address and chain and hands out `previous + 1` when the RPC's pending count lags; `NonceTooLowError` matches `/nonce too low\|transaction already imported\|already known/` and is reworded "lower than the current nonce", which the Base sender retries once after `nonceManager.reset` |
| `rpc.testnet.near.org` under load | the Sputnik probe below, about 150 `call_function` queries in a row | Later queries answer JSON-RPC error `-429` "WARNING! THIS ENDPOINT IS DEPRECATED! … Switch to https://fastnear.com", so the faucet's NEAR default is now `https://test.rpc.fastnear.com` |
| FastNEAR keeps the same history | `view_access_key` for `rose-faucet.testnet` at head − 3,600, − 90,000 and − 200,000, and `view_account` of a missing id, on `https://test.rpc.fastnear.com` | Same answers as above: nonce `276151044000004` at − 3,600, "does not exist while viewing" at the older heights, `UNKNOWN_ACCOUNT` for the missing id |

Run via DAO funding (Sputnik DAO v2, checked live 2026-11-04):

| Fact | Command | Result |
|---|---|---|
| Sputnik v2 source at HEAD | `curl -s https://api.github.com/repos/near-daos/sputnik-dao-contract/commits/main`, then `curl -s https://raw.githubusercontent.com/near-daos/sputnik-dao-contract/main/sputnikdao2/src/{proposals,types}.rs` | Commit `5434a59dec23ee0c49df8c8c4350c208a7e75b0b` (2026-05-27). `ProposalKind::FunctionCall { receiver_id, actions: Vec<ActionCall> }` executes one promise to `receiver_id` with each `function_call(method_name, args, deposit, gas)`; `ActionCall` has `#[serde(deny_unknown_fields)]` (`method_name`, `args` base64, `deposit`, `gas`). `ProposalKind::Transfer { token_id, receiver_id, amount, msg: Option<String> }` calls `ft_transfer_call` when `msg` is set, with a static `GAS_FOR_FT_TRANSFER` = 10 Tgas (`types.rs`), and the proposal description as `memo` |
| DAOs on the `sputnik-v2.testnet` factory | `call_function sputnik-v2.testnet get_dao_list {}` | 68 DAOs (`get_default_version` is not a method of this factory: `MethodNotFound`) |
| DAO-signed `ft_transfer_call` and `storage_deposit` proposals executed on testnet | `get_last_proposal_id` and `get_proposals {from_index, limit}` over the last 40 DAOs of the factory | `nearevents-community.sputnik-v2.testnet` proposals 1 and 4, `ne-dao-mvzdgxmb.sputnik-v2.testnet` proposal 1: `Approved` FunctionCall to `usdc-nearevents-11022103.testnet`, `method_name` `ft_transfer_call`, args `{"receiver_id","amount":"10000000","msg":…}`, `deposit` `"1"`, `gas` `"150000000000000"`. `probedao45849.sputnik-v2.testnet` proposal 0: `Approved` FunctionCall to `wrap.testnet` `storage_deposit` `{"account_id":<the DAO>,"registration_only":true}` with deposit `1250000000000000000000` |
| A live DAO's policy | `call_function nearevents-community.sputnik-v2.testnet version {}` and `get_policy {}` on `https://test.rpc.fastnear.com` | `"2.0.0"`; `proposal_bond` 1 NEAR; roles `all` (Everyone, `*:AddProposal`) and `council` (Group, `*:Finalize`, `*:AddProposal`, `*:VoteApprove`, `*:VoteReject`, `*:VoteRemove`) |
| Who the engine credits on `ft_transfer_call` | `contracts/engine/src/cash.rs` `ft_on_transfer` | Only the configured token, `msg` must be empty, the `sender_id` is credited after `require_storage_capacity(sender_id, cash row)`: the DAO itself must send the transfer, and its NEP-145 storage must cover the cash row first; `storage_deposit(account_id)` accepts any payer (`storage.rs`) |
| Who the engine credits on a Base cash deposit | `contracts/engine/src/custody/base.rs` `on_base_cash_verified` | The `nearAccount` of the `CashDeposited` log, with `pay_cash_row` (no prior storage needed): any member's Base wallet can fund the DAO's Base cash |

Decisions: the NEAR funding is a `FunctionCall` proposal calling `ft_transfer_call` with 60 Tgas (the app's `GAS.ftTransferCall`), not a `Transfer` proposal, because `Transfer` attaches a fixed 10 Tgas to `ft_transfer_call`, too little for the engine's `ft_on_transfer` and the token's resolve. The DAO's engine storage and, when the treasury holds too little tUSDC, the tUSDC itself are sent by the connected member (no vote needed); only the transfer into the engine needs the DAO's signature.

## Hosted app (2026-11-04)

- URL: https://rose-rounds.vercel.app (Vercel project `rose-rounds`, production). Before the project existed, `curl https://rose-rounds.vercel.app` answered 404 `DEPLOYMENT_NOT_FOUND` (subdomain free); it answers 200 now. Settings set through the Vercel API: root directory `apps/web`, framework Next.js, Node 22.x, files outside the root directory included; `apps/web/vercel.json` installs with `pnpm install --frozen-lockfile` and builds `pnpm --filter "@rose/web^..." build && pnpm run build` (the workspace packages `@rose/sdk` and `@rose/ibe-wasm` first). Build log: corepack pnpm 10.34.9, Next.js 16.4.5, "Build Completed in /vercel/output [1m]".
- Uploaded from the repository root, filtered by `.vercelignore` (workspace manifests, `apps/web`, `packages`; no `.env*`, `node_modules`, build outputs or Rust targets): 2.3 MB.
- Environment (production, `vercel env add`): the `NEXT_PUBLIC_*` addresses of `deployments/engine-s2.rose-app.testnet.env` plus `NEXT_PUBLIC_SOLANA_DEMO_MINT`, the faucet keys (`BASE_FAUCET_PRIVATE_KEY`, `SOLANA_FAUCET_SECRET_KEY`, `NEAR_FAUCET_ACCOUNT_ID`, `NEAR_FAUCET_PRIVATE_KEY`), `FAUCET_COOKIE_SECRET`, `ENABLE_EXPERIMENTAL_COREPACK=1`. `GET /api/faucet` on the deployment reports base, solana and near configured.
- Faucet hot wallets created for the deployment: Base Sepolia `0xe87366B9a546D8F1B30631a20F8F079eb85dc59e` funded with 0.05 ETH by the deployer ([0x0cf7f487…](https://sepolia.basescan.org/tx/0x0cf7f487c72d58684414b61b18ec341ced6f31c1ee89455e60726bcfe2473bc2)), Solana devnet `DJgWSMB3D8sKyJNoQJqsCKpD4H4c3tm2NhG9EXumnzxV` funded with 0.5 SOL by the ops key ([2fAatREk…](https://explorer.solana.com/tx/2fAatREkUt5CY4vJ3hoga6EaQscJDg99PJtZWaZT2kkB5GFjceVuVv52zohrm9C3DqgLwvwg2WLzS1DkQKSzC4jo?cluster=devnet)), NEAR funder `rose-faucet.testnet` (see the section above).
- The deployed faucet created `rose-demo-ab9p6g.testnet` through the NEAR helper (10 NEAR, [3PcbqYxk…](https://testnet.near.rocks/tx/3PcbqYxk6swd4vEd7QAGis5QEYkzBpS83rfhDDswDsdr)) and the app minted it 1,000 tUSDC ([GrRSKQUn…](https://testnet.near.rocks/tx/GrRSKQUnd7G12w1P8LPMf6zCnX7QRR9m2aNzHTKoJwLB)).

## Hosted demo: faucet capacity (2026-11-14)

| Change | Command | Result |
|---|---|---|
| Base faucet hot wallet | `cast send 0xe87366B9a546D8F1B30631a20F8F079eb85dc59e --value 0.25ether` from the deployer | [0x930a5feb…](https://sepolia.basescan.org/tx/0x930a5feb979d3b44f07aad4c3b18a612ce9b554c0c8183f74c312b3a33ce850a); 0.29 ETH |
| Solana faucet hot wallet | `SystemProgram.transfer` from the ops key to `DJgWSMB3D8sKyJNoQJqsCKpD4H4c3tm2NhG9EXumnzxV`, 2.5 then 2 SOL | 4GY2K3pY…, 4Mkfd9EQ…; 4.75 SOL and 998,000 CINDR |
| Shared hourly and daily caps | `vercel env add` on Production: `SOLANA_FAUCET_HOURLY_CAP=10`, `SOLANA_FAUCET_DAILY_CAP=24`, `BASE_FAUCET_HOURLY_CAP=10`, `BASE_FAUCET_DAILY_CAP=40`, `SOLANA_DEMO_TOKEN_FAUCET_HOURLY_CAP=10`, `SOLANA_DEMO_TOKEN_FAUCET_DAILY_CAP=30` | was 3/6 (Solana), 5/15 (Base), 3/6 (CINDR): a test run waited 57 minutes for a capped SOL send |

## Facts behind the user guides (2026-11-06)

| Fact | Command | Result |
|---|---|---|
| Close-to-key time and gas on the staging engines (sealed-rounds doc) | `EXPERIMENTAL_tx_status` (`wait_until` `FINAL`) at `https://archival-rpc.testnet.fastnear.com` for the three closes of staging deployment 5, gas burnt summed over the transaction and every receipt | `GpiGfPHZ…` 37.49 Tgas, `Fjacn1yn…` 37.41 Tgas, `GjXH9kGh…` 37.48 Tgas, all `SuccessValue`; with the closes of `engine-s4` (37.4 to 37.5 Tgas, keys 4.1 to 4.3 s) and `engine-s5` (keys 4.2 to 5.4 s), recorded in `deployments/e2e/engine-s4.rose-app.testnet.live.json` and `deployments/e2e/engine-s5.rose-app.testnet.live.json`, the doc says 4.1 to 5.4 s and 37.4 to 37.5 Tgas |
| Rent of a Streamflow stream (buyer guide, "Mint me a demo vesting position") | `curl https://api.devnet.solana.com` `getMinimumBalanceForRentExemption` of 1,104 bytes (the Streamflow metadata account) and 165 bytes (an SPL token account); `getTransaction` (`finalized`) of the stream creation [5VGqdaE6…](https://explorer.solana.com/tx/5VGqdaE691u7iFsKeYAryJABV7mmAuz3CQopfucu3zkaMsGL3YX6bUf1AyrscCPWQYonqTvPdcSFHwx5y1rGM5u6?cluster=devnet), balance deltas | 6,258,560 and 1,488,440 lamports. The creation: sender −9,245,540 lamports, metadata +6,258,660 (rent plus Streamflow's 100-lamport fee), escrow token account +1,488,440, the recipient's new token account +1,488,440, fee 10,000. A demo stream to the wallet itself reuses the wallet's existing token account, so it spends about 7,757,100 lamports (0.0078 SOL) of the 0.012 SOL the app requires |
| A swept-balance claim is made from the app (holder guide) | "Staging deployment 5: an ended stream synced from the app": payout 10 from the app (draws `[]`, `swept` 500,000,000), `Landed` | the guide now says "Claim" pays from the swept balance first |

## Issuer console: Sputnik DAO v2 and Trezu (2026-11-04)

| Fact | Command | Result |
|---|---|---|
| Sputnik DAO v2 factories on testnet | `curl -s -X POST https://rpc.testnet.near.org -d '{"jsonrpc":"2.0","id":"1","method":"query","params":{"request_type":"view_account","finality":"final","account_id":"<factory>"}}'` for `sputnik-v2.testnet` and `sputnikv2.testnet` | Both exist with code (`sputnikv2.testnet` code hash `77dkUJRC…`, 6.6 MB of storage; `sputnik-v2.testnet` code hash `D7dxhAZv…`). `get_dao_list` on `sputnikv2.testnet` lists `genesis.`, `test.`, `franklindao.`, … `.sputnikv2.testnet`; on `sputnik-v2.testnet` it lists `genesis.`, `dao.`, `simodao.`, … `.sputnik-v2.testnet`. `get_default_version` on `sputnikv2.testnet` returns `[3, 31]` |
| A live DAO's policy and version | `view test.sputnikv2.testnet get_policy '{}'`, `version '{}'`, `get_last_proposal_id '{}'` (same `call_function` query, args base64) | `version` = `"2.0.0"`, `proposal_bond` = `1000000000000000000000000` (1 NEAR), `proposal_period` 604800 s, roles `all` (`*:AddProposal`) and `council`; last proposal id 15 |
| `add_proposal` FunctionCall shape as stored on chain | `view test.sputnikv2.testnet get_proposals '{"from_index":0,"limit":200}'` | 5 FunctionCall proposals, e.g. id 0: `{"kind":{"FunctionCall":{"receiver_id":"hellovirtualworld.mintspace2.testnet","actions":[{"method_name":"mint_tokens","args":"<base64 JSON>","deposit":"1000000000000000000000000","gas":"150000000000000"}]}},"description":"I test mint",...}`. The console builds exactly `{"proposal":{"description","kind":{"FunctionCall":{"receiver_id":<engine>,"actions":[{"method_name":"create_tender","args":<base64 of the create_tender JSON args>,"deposit":"50000000000000000000000","gas":"30000000000000"}]}}}}` |
| `add_proposal` signature and bond rule | `https://raw.githubusercontent.com/near-daos/sputnik-dao-contract/main/sputnikdao2/src/proposals.rs` (fetched live) | `#[payable] pub fn add_proposal(&mut self, proposal: ProposalInput) -> u64` with `ProposalInput { description: String, kind: ProposalKind }`, `ProposalKind::FunctionCall { receiver_id: AccountId, actions: Vec<ActionCall> }`, `ActionCall { method_name: String, args: Base64VecU8, deposit: NearToken, gas: Gas }`; the attached deposit must equal `policy.proposal_bond` exactly (`assert_eq!`, "ERR_MIN_BOND"), so the console reads `get_policy().proposal_bond` from the DAO entered and attaches it |
| Sputnik / AstroDAO testnet web UIs | `curl -s -o /dev/null -m 12 -w "%{http_code}" -A Mozilla/5.0 <url>` for `https://testnet-v2.sputnik.fund/`, `https://testnet.app.astrodao.com/`, `https://app.astrodao.com/` | All three fail to resolve (curl exit 6 / HTTP 000) on 2026-11-04, so the console offers no deep link: the proposal is filed from the connected NEAR wallet (`add_proposal` with the bond) or with the generated near-cli-rs command |
| Trezu custom proposal templates | `gh api repos/NEAR-DevHub/trezu/commits/main` and `curl -s https://raw.githubusercontent.com/NEAR-DevHub/trezu/main/docs/CUSTOM_PROPOSAL_TEMPLATES.md` | Repository `NEAR-DevHub/trezu` ("Frontend and back-end for Trezu"), default branch `main` at `7b063ddbddc7b8202ab680b44cc8f461504aa869` (2026-10-30). The doc defines manifest DSL version `1`: `{ version: 1, id (slug [A-Za-z0-9_-]), title, description?, summary?, binding { receiver_id, method_name, deposit (yocto string), gas (string) }, fields [{ name, label, type: account\|token\|uint\|amount\|number\|text\|select\|bool\|json, required?, default?, help?, options?, validation? }], args { ... "{{placeholder}}" inside string values only } }`; filing produces one `FunctionCall` proposal with `description = "<title>\n\n[trezu-tmpl:<id>]"`; templates are pasted in the Code tab of `/<dao>/custom-templates/create`. `trezu.xyz` answers HTTP 200 only on `www.trezu.xyz`; the app runs on mainnet, so the generated manifest is verified against the DSL doc, not filed |

## Issuer console: amounts, stream ids and voting periods (2026-11-06 to 2026-11-14)

| Fact | Command | Result |
|---|---|---|
| Trezu custom proposal amounts are unscaled base units (the DAO panel passes digit strings through) | `curl -s https://raw.githubusercontent.com/NEAR-DevHub/trezu/7b063ddbddc7b8202ab680b44cc8f461504aa869/docs/CUSTOM_PROPOSAL_TEMPLATES.md` | line 87: "`amount` \| a whole-number string, u128-safe (base units — no decimals)"; lines 98-99: `uint` / `amount` values "stay digit strings end-to-end" |
| A Sablier stream id that was never minted reverts with OpenZeppelin's `ERC721NonexistentToken(uint256)` | `cast sig "ERC721NonexistentToken(uint256)"` | `0x7e273289`, the selector in the raw revert the console now turns into "Stream #N does not exist" |
| Sputnik DAO v2's default policy keeps a proposal open 7 days, and a DAO can set its own | `curl -s https://raw.githubusercontent.com/near-daos/sputnik-dao-contract/main/sputnikdao2/src/policy.rs`, `default_policy`; `call_function cindral-treasury.sputnikv2.testnet get_policy {}` and `version {}` on `https://near-testnet.drpc.org` | `proposal_period: U64::from(1_000_000_000 * 60 * 60 * 24 * 7)`; the live treasury answers `proposal_period` `86400000000000` (one day), bond 0.1 NEAR, version `"2.3.1"` (block 277,596,669). Run via DAO shows the read period |

## Demo identity: no collision with a real project

The demo issuer is the fictional **Cindral Foundation**, token **Cindral (CINDR)** (spec section 9).

| Check | Command | Result (2026-11-04) |
|---|---|---|
| CoinGecko | `curl "https://api.coingecko.com/api/v3/search?query=cindral"`, `curl https://api.coingecko.com/api/v3/coins/list` (22,750 coins) searched for `cindral` and `cindr` | no coin named Cindral, no ticker CINDR |
| CoinMarketCap | public coin map (10,500 coins) and currency slug pages | no match |
| DefiLlama | `curl https://api.llama.fi/protocols` (8,926 protocols) | no match |
| Web | searches `"Cindral" crypto`, `"CINDR" token` | no result |
| Nearest names | same sources | Cindrum (CIND, inactive), Cindicator (CND): neither name nor ticker shared. Rejected tickers: CNDL (DefiLlama "Candle"), CNDR (Solana "Condor"), CIND (Cindrum) |

## Demo identity, re-checked (2026-11-04 and 2026-11-06)

| Fact | Command | Result |
|---|---|---|
| Cindral / CINDR still unused | `curl "https://api.coingecko.com/api/v3/search?query=cindral"` and `?query=cindr`; `curl https://api.llama.fi/protocols` filtered on name or symbol `cindr`; `curl "https://api.dexscreener.com/latest/dex/search?q=CINDR"` filtered on base symbol `CINDR` | no coin, no exchange; 0 of 8,927 DefiLlama protocols; no DexScreener pair |
| Demo identity, DexScreener | `curl "https://api.dexscreener.com/latest/dex/search?q=cindral"`, `…?q=cindr`, `curl https://api.dexscreener.com/latest/dex/tokens/0xF4918b947b7e9819eB813dF276F54AD95D20417a` | `cindral`: 0 pairs. `cindr`: 1 pair, Ethereum Uniswap `0x40Bca4985Df93F71a72b9Ef9483b07025e549E62`, base token "CINDR" (`0xF4918b94…417a`), created 2023-08-29, market cap 8,542 USD, 24 h volume 11.91 USD. No project named Cindral; the ticker collides with that one inactive Ethereum token, not a notable token in the sense of spec 9 |
| Demo identity, CoinGecko re-checked | `curl "https://api.coingecko.com/api/v3/search?query=cindr"` and `…?query=cindral` | no coin for either |

## Sources the README quotes (2026-11-04)

The primary sources for the MPC domains are in "Primary sources for the MPC domains".

| Fact | Command | Result (2026-11-04) |
|---|---|---|
| Monad case (README problem) | `curl -sS -A 'Mozilla/5.0' https://monad.xyz/blog/early-investor-liquidity-program`, then `grep` | HTTP 200; "Nearly all holders approached declined to participate, and the program has now concluded."; "The program was capped at $60 million in aggregate purchase consideration."; `dateTime="2026-08-17…"`; offer "at a discount reflecting the applicable four-year lock-up" |
| Token unlocks and price pressure (README problem) | `curl -sS -A 'Mozilla/5.0' https://keyrock.com/from-locked-to-liquidity-what-16000-token-unlocks-teach-us/`, text of "Key takeaways" (2026-11-14) | HTTP 200; "What 16,000+ Token Unlocks Teach Us", "90% of unlocks create negative price pressure, regardless of size or type", "Token price impacts often start 30 days before the unlock event" |
| Sealwell already releases the batch key through CKD on the contract's request and checks every opening on chain (README, What is new here) | `gh api repos/Godwin-web3/sealwell/readme -q .content \| base64 -d` (2026-11-14) | "After the deadline the contract calls `request_app_private_key` on the MPC contract"; "Openings are checked deterministically on-chain"; `contracts/sealwell-auction`: "CKD call from the contract + on-chain key verification, NEAR bonds, on-chain opening check, slashing, uniform-price clearing" |

## Cash tokens

| Fact | Command | Result (2026-11-04) |
|---|---|---|
| Circle USDC on NEAR testnet | Circle docs (developers.circle.com/stablecoins/usdc-contract-addresses), then `view 3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af ft_metadata` | Exists (`USDC`, NEP-141) but is minted only through Circle's captcha-gated faucet, so the NEAR cash venue is rose tUSDC (spec 5.4, 7.3) |
| Circle USDC on Solana devnet | same Circle page | `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` |
| Circle USDC on Base Sepolia | same Circle page | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` (accepted by the engine as a Base cash token) |

## Test funds

| Fact | Command | Result (2026-11-04) |
|---|---|---|
| NEAR testnet faucet | `near account create-account sponsor-by-faucet-service rose-app.testnet autogenerate-new-keypair save-to-legacy-keychain network-config testnet create` | Account created with 10 NEAR, tx [66SvxXgw…](https://testnet.near.rocks/tx/66SvxXgw18sEvLMuNWDgFGqFcXJDDGXqutuNQFz6eUC4) |
| Solana devnet RPC airdrop | `curl https://api.devnet.solana.com -d '{"jsonrpc":"2.0","id":1,"method":"requestAirdrop","params":["<pubkey>",500000000]}'` | HTTP 410: "The RPC faucet is closed on this cluster. Request test SOL at https://faucet.solana.com", so `/api/faucet` sends devnet SOL from a server-side hot wallet (spec 6, 8.4) |
| Solana devnet PoW faucets | `devnet-pow get-all-faucets` (devnet-pow 0.1.4) | 24 faucets listed, none with a usable balance; `devnet-pow mine` also needs fee-payer SOL and its bootstrap airdrop fails |
| Durable nonce account rent on devnet | `getMinimumBalanceForRentExemption(80)` | 1,056,640 lamports (older docs' formula gives 1,447,680: always read it live) |

## Deployed: rose tUSDC on NEAR testnet

| Fact | Command | Result (2026-11-04) |
|---|---|---|
| Account created | `near account create-account fund-myself tusdc.rose-app.testnet '3 NEAR' ... sign-as rose-app.testnet` | tx [98iY6msS…](https://testnet.near.rocks/tx/98iY6msST3gE9CN1keAAF2wbYqp9AyzXgnH1R5Uxxn8b) |
| Code deployed and initialized | `near contract deploy tusdc.rose-app.testnet use-file target/near/rose_tusdc/rose_tusdc.wasm with-init-call new json-args '{}'` (wasm SHA-256 bs58 `7JHPYMQ1o7QVhVyMwmzzxS3vVhyqEkcWQrGJUcmubizP`, 160,452 bytes) | tx [CekG17rC…](https://testnet.near.rocks/tx/CekG17rCG6MQ1djNH4pnbHaFj3EoXLq8b6hApCwXVsUN) |
| Public mint works | `near contract call-function as-transaction tusdc.rose-app.testnet mint json-args '{"amount":"1000000000"}' attached-deposit '0.00125 NEAR' sign-as rose-app.testnet` | `ft_mint` event, tx [EUZEU5Rv…](https://testnet.near.rocks/tx/EUZEU5RvkvFfs6D4czq6uqAzBytLD49yy4cL61KDsLZB) |
| Keyless | `near account delete-keys tusdc.rose-app.testnet ...` (tx [EjiBFUNB…](https://testnet.near.rocks/tx/EjiBFUNB8CmiY8qTERPvaqYc8jFkBds51iTSAGShq1MG)), then `view_access_key_list` | `[]` |

## Demo assets (2026-11-04)

The demo token, its faucet and the Base test USDC were deployed once with the first staging engine and
are reused by every engine since (`scripts/deploy-base.sh --demo-assets-from`): they do not depend on
the engine, the DemoStreamFaucet schedules define the seeded classes, and positions or tUSDC that
testers already minted stay valid. Deployer `0x7d4777cfC6ed48061B0BcCae558D29919b412042`.

| Contract | Address | Transaction | Block |
|---|---|---|---|
| TestUSDC | `0x69fa19ad79c1c890d37cbabaa6fe99d1aa54bc01` | [0xb7dfe548…](https://sepolia.basescan.org/tx/0xb7dfe548dcd5ad2e79484cff19d1c0d8a6a777830ff2ab567969f63643d599f9) | 54,195,713 |
| DemoToken "Cindral" (CINDR) | `0x1250554fdbd8e63a75ea9ed0021f2dcae55d3f4b` | [0x9f02fedb…](https://sepolia.basescan.org/tx/0x9f02fedb507f317f9e6fe7834f3605371f1f76a8db99ff5b987d5fdcf39ed954) | 54,195,713 |
| DemoStreamFaucet | `0xf7b1302c20faab06ad5121981b3e949da24fd98d` | [0xb9c69f8c…](https://sepolia.basescan.org/tx/0xb9c69f8c83640e28e40e9be9036e2afa9b2275fc5b7da90434663abc27b397e5) | 54,195,713 |

| Fact | Command | Result (2026-11-04) |
|---|---|---|
| Demo account names free | `view_account` of `cindral-foundation`, `halden-ventures`, `tessaro-capital`, `ines-marlow`, `varick-partners`, `teodor-vance`, `nadia-solvik` `.rose-app.testnet` | `UNKNOWN_ACCOUNT` for all seven before creation |
| DemoStreamFaucet schedules (the seed cohorts reuse them so app-minted positions join the same classes) | `cast call 0xf7b1302c20faab06ad5121981b3e949da24fd98d 'scheduleOf(uint8)((uint40,uint40,uint40,uint128,uint128,uint128))' 0` and `1` | Seed: start 1,778,209,008, cliff 1,809,745,008 (2027-05-08), end 1,872,817,008, 100,000 CINDR, cliff unlock 25,000; KOL: start 1,791,169,008, no cliff, end 1,822,705,008, 20,000 CINDR, start unlock 2,000 |
| DemoToken | `cast call 0x1250554fdbd8e63a75ea9ed0021f2dcae55d3f4b 'name()(string)'`, `symbol()`, `decimals()` | "Cindral", "CINDR", 18 |
| Base tUSDC mint room of the issuer wallet | `cast call 0x69fa19ad79c1c890d37cbabaa6fe99d1aa54bc01 'mintableAmount(address)(uint256)' 0x7d4777cfC6ed48061B0BcCae558D29919b412042` | 10,000,000,000 (10,000 tUSDC) |
| Strategic Round on Solana | Streamflow `create` (js-sdk 13.4.0) of the devnet CINDR mint `2eWdSYbcryjZvA8UBmjTmEqjRqzY2LVUnHUby1gdDLNv` (9 decimals, mint authority = ops key): start = cliff = 2027-02-01T00:00Z, 10% at the cliff, 5% every 30 days, fee-free, transferable by the recipient only | both streams (Ines Marlow `BLvtumdt…NbfN` 300,000; Varick Partners `BXo3XNp6…1Ryu` 200,000) land in one class `f91b52ce…1a42` |

The devnet CINDR mint `2eWdSYbcryjZvA8UBmjTmEqjRqzY2LVUnHUby1gdDLNv` (9 decimals, mint authority the
ops key) was created by the seed: `createMint` [KvkQKDThFF…](https://explorer.solana.com/tx/KvkQKDThFFTmU44NmjK4Zkfz4zWC9CfnDW7mWFoTwck3GEZ9DvZLrtsXewJNbi6yPMvspJzUHG6wLYy5neqp7Lb?cluster=devnet).

| Fact | Command | Result (2026-11-04) |
|---|---|---|
| Demo CINDR mint on devnet has no freeze authority | `curl -s https://api.devnet.solana.com -d '{"jsonrpc":"2.0","id":1,"method":"getAccountInfo","params":["2eWdSYbcryjZvA8UBmjTmEqjRqzY2LVUnHUby1gdDLNv",{"encoding":"jsonParsed","commitment":"finalized"}]}'` | slot 518,508,433: owner `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`, decimals 9, `freezeAuthority` null, mint authority the ops key, supply 500,000 CINDR |

- Token labels: `eth_call` of `symbol()` (`0x95d89b41`) on Base Sepolia (`https://sepolia.base.org`) returns `tUSDC` for `0x69fa19ad79c1c890d37cbabaa6fe99d1aa54bc01` and `CINDR` for `0x1250554fdbd8e63a75ea9ed0021f2dcae55d3f4b`. The Solana demo mint `2eWdSYbcryjZvA8UBmjTmEqjRqzY2LVUnHUby1gdDLNv` is a plain SPL mint (`getAccountInfo` jsonParsed: owner `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`, 9 decimals) and its Metaplex metadata PDA `Hvn7Q37cG8Chu6ZgpvB75YjF8fZkrYiVeSGukjiKNXXG` (seeds `metadata`, `metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s`, mint) does not exist (`getAccountInfo` returns `null`), so the app labels it with the Base demo token's on-chain symbol, as declared by `NEXT_PUBLIC_SOLANA_DEMO_MINT`.

## Final deployment (2026-11-06)

The first final engine and its RoseVault, deployed once, keyless and immutable. It is superseded by `engine-v2.rose-app.testnet` (see "RoseVault for the second final engine").

| Step | Command | Result |
|---|---|---|
| RoseVault | `scripts/deploy-base.sh --engine engine.rose-app.testnet --role final --demo-assets-from engine-s5.rose-app.testnet` | `0x9b7182033d3f4bc017a8776c8bc55f6a261ac95f`, [0xb8703beb…](https://sepolia.basescan.org/tx/0xb8703beba725fd4b2ec3b6c56093467bed143373f04407271e882402eda20f68), block 55,234,214; read live: `SIGNER()` = `0x7ba1dee0d020927e7a748349433b095de7899384` (the engine's `vault/base`), `LOCKUP()` = `0xa65a1ecef02c2b9bdc604951c6a6d02335d4532e` |
| Reproducible build | `scripts/deploy-engine.sh engine.rose-app.testnet --role final --reproducible --keyless` (image `sourcescan/cargo-near:0.22.0-rust-1.97.0@sha256:b193c8640a27172f83136a0f0aab2a9bf9d09f6ba0e6afd187addfaa9b92bae0`, source `git+https://github.com/gamween/rose?rev=d5e1e0c2363d67aaa405c2d4324bc006a3992237`) | 1,018,652 bytes, sha256 `dad185788b68aa1a01dbad0f14cee2a514daa53e1defe9cbc48481ed4c87a7bb` (bs58 `FjBBS6dRJYuneJJXRx8e3YvFdKUCGxhWCA3bp3d4irSN`) |
| Account (17 NEAR) | same run | [3Uk9ZnfN…](https://testnet.near.rocks/tx/3Uk9ZnfNnxMpsAgWCTp9m2LNkzcB78f5JsG19a4AcWh3) |
| Deploy and `new` | same run | [Hqhv1Xon…](https://testnet.near.rocks/tx/Hqhv1XonsuSq1c56arUinGQH5S2yQBmjoobCTsK4p2va) |
| `bootstrap` | same run | [3834RY2f…](https://testnet.near.rocks/tx/3834RY2fT4SMF2TRTB8vPxKbGVwLazYBB9nvAGiitJNS); `vault_base` `0x7ba1dee0d020927e7a748349433b095de7899384`, `vault_sol` `GKharZus34WhG182v715Yzf411Akhdnsxxjo5u5C2RRq`, `gas_sol` `BE9yDmZ7QXDuwHxtThY527E9c5JSb7TMGdZx4crjFbAe`, each equal to the MPC's derivation |
| Checks before the key deletion | same run | code hash equals the artifact; `get_config` equals every init argument (CKD key re-read from `v1.signer-prod.testnet`); `SIGNER()` and `LOCKUP()` read live |
| Key deletion (one transaction) | same run | [47F3F4LA…](https://testnet.near.rocks/tx/47F3F4LAZwj5ByTcpFco3A75yCQmSKi2soBUT8LJP2e2) |
| Keyless check | `curl -s https://rpc.testnet.fastnear.com -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"view_access_key_list","finality":"final","account_id":"engine.rose-app.testnet"}}' \| jq -c .result.keys` | `[]`; `view_account`: `code_hash` `FjBBS6dRJYuneJJXRx8e3YvFdKUCGxhWCA3bp3d4irSN`, storage 1,019,995 B, 16.99 NEAR |

## Live end-to-end, final engine (2026-11-06)

Every flow of the seeded story and of the Solana custody run again on the final keyless engine
`engine.rose-app.testnet` and its RoseVault `0x9b7182033d3f4bc017a8776c8bc55f6a261ac95f`, with the
same scripts as on the staging engines. Full transaction tables: `deployments/e2e/engine.rose-app.testnet.{seed,live,solana,solana-ended}.json`
(`node scripts/e2e-live.ts report --env deployments/engine.rose-app.testnet.env` prints the seed and live table).

| Step | Command | Result |
|---|---|---|
| Seed | `node scripts/seed.ts all --env deployments/engine.rose-app.testnet.env --kol-wallet nadia-final` (a fresh KOL key: the DemoStreamFaucet allows one mint per address and class every 24 h) | exit 0, first run. Cast topped up from `rose-app.testnet` (e.g. [Fejcse3f…](https://testnet.near.rocks/tx/Fejcse3f8JQfZkGKCJV4cs1CSZvGjgbJi3bkFnmkGsm4)); Seed Round `createStreams` [0x4bfd967f…](https://sepolia.basescan.org/tx/0x4bfd967f6b53243cfa15515528637b389beb0ac183f76d53bf3ae0402bc22592), KOL Round [0xd308bcfe…](https://sepolia.basescan.org/tx/0xd308bcfe4f4e4c685524e01e9141ad7edbc941e5694bfd2a40ea81a5b2dff86b), Nadia's self-deposit [0x3314f46b…](https://sepolia.basescan.org/tx/0x3314f46bb5f32e81f4228da1ee8bbfa630e3daffb13d95c4c5402fb7eb60242b); streams 151 to 155 registered (151: [CbBF24Py…](https://testnet.near.rocks/tx/CbBF24Py8cJYQSWscHsokHdmagAv4E72TDggoXwC4KCb)); Strategic Round attributed [8oaGGxUp…](https://testnet.near.rocks/tx/8oaGGxUpddTz17KEcot19fszp9hLd9nZZLXe2VMt2pn2), moved [kdDmWnYc…](https://explorer.solana.com/tx/kdDmWnYcrgV9UaH9WKVeBijryYJHoCBxxvrJqFpG1iVKUQT1XdwXHYfFb3ESfXXqEnjPLZyJcZGfJmVCNo1a6ji?cluster=devnet), registered [D3Fsmj2m…](https://testnet.near.rocks/tx/D3Fsmj2mmRk4278zCoYabvxNwZFDHbqyJqwNBvRJfCGN); rounds 0 Tender [Gsbh4tow…](https://testnet.near.rocks/tx/Gsbh4towyptna6ycxJfz3He1EkjLLTL7kvc5E4Fc4jYc), 1 Exit [3F1XvCXU…](https://testnet.near.rocks/tx/3F1XvCXUSXZMBfD3S96w1wdGoSNMHXqvFS8LysczWTvj), 2 Advance [4C1J1L2m…](https://testnet.near.rocks/tx/4C1J1L2mEdt3CGKw3fSNrMEkctd432S8LEkynimcnqwL) with 10 sealed orders; demo mint `2eWdSYbcryjZvA8UBmjTmEqjRqzY2LVUnHUby1gdDLNv` (the cast's, reused) |
| No-key round | `node scripts/e2e-live.ts all --env deployments/engine.rose-app.testnet.env` | round 3: `close` refused after the 60 s timeout [CW1rCyXj…](https://testnet.near.rocks/tx/CW1rCyXjQhBsUhXVRkwzjYaJ1Jx5Xx1bbaL1M8eU5a1q) ("Key timeout reached"), `cancel_no_key` [EVpeZQkS…](https://testnet.near.rocks/tx/EVpeZQkSXQHQwKBET3Ew326CLic93dTfMs24p1fDCmGc), refund [8gct8dyP…](https://testnet.near.rocks/tx/8gct8dyPahKxZGGYEmKEnyBwZoz1US47RJnT4v38pWpi) |
| Key release after close | same run | Tender [EGrrdJ4C…](https://testnet.near.rocks/tx/EGrrdJ4CBCfJwN3kCcb2TkGVEnYJN8cVKcaDP8Q8JNRJ) 4.26 s, Exit [GZCSThNV…](https://testnet.near.rocks/tx/GZCSThNVwD7tXKXhNt4tGCMS4bcJBTFWfLPqqvPJrJX7) 4.22 s, Advance [GWHwfLV4…](https://testnet.near.rocks/tx/GWHwfLV4NiyPtXzvh6bQRHYPvQuc4FKJZzNnL4ppGRKk) 5.44 s; 37.4 Tgas each; key by callback, each equal to the offline unwrap of the MPC response |
| Openings | same run | 9 openings by `rose-app.testnet` at 132.09 to 132.13 Tgas (e.g. [6FPfUMAx…](https://testnet.near.rocks/tx/6FPfUMAxAgn214nnruSUs8CRFR5ChouEEFN5uZsK82nu)); the malformed bid cannot be decrypted and its author's own opening is refused [FLajwXe8…](https://testnet.near.rocks/tx/FLajwXe8XR32R7XwYy9vLYXkdD8MYkSUaNRKtsYTMXB8) ("Opening does not match the ciphertext", 131.3 Tgas) |
| Clearing = reference | same run | Tender [G4qLarju…](https://testnet.near.rocks/tx/G4qLarjuophMP6DpKPwX8AhLbPczYfxrohCe4iQxt98R) 0.036 tUSDC, volume 41,666.67 CINDR; Exit (Strategic Round, Solana positions) [Ercjm3oL…](https://testnet.near.rocks/tx/Ercjm3oL6wyFmpPumZ1AGpbLuQoGzzjbXaxsw8bFx4Re) 0.027, volume 70,000; Advance (KOL Round, Base) [7xZ38Uuj…](https://testnet.near.rocks/tx/7xZ38Uujdkn7KRytDNiF7k3mnehuLU34zrHL21QonrGM) 0.0375, 3,000 claimed tokens; every price and fill equal to `@rose/sdk` on the opened orders |
| Settlement | same run | 10 `settle_bid`; the malformed bid void (`Unopened`) and its 1 tUSDC bond slashed [Dh5i3YVQ…](https://testnet.near.rocks/tx/Dh5i3YVQsPVKsh7TKZZVWp6UxmkxtbNEM1L1qpMaFvUE) |
| NEAR USDC payout | same run | `withdraw_near_cash` [HJRBUucb…](https://testnet.near.rocks/tx/HJRBUucbSTTaUirP4MFYFPo3peRW36WrKagyj4vedJav): 1,732.3875 tUSDC to Ines Marlow |
| Base USDC payout | same run | `withdraw_base_cash` [CajaWK8z…](https://testnet.near.rocks/tx/CajaWK8zwZFUF9DQhxGn88Copq4S6yPmp6nonvrTm4HQ) + `executeTransfer` [0x23ac2dae…](https://sepolia.basescan.org/tx/0x23ac2dae8c7821af27df5ccb115ba362a41a584ee21a7ecb109d5c45f55d6a30): 1,460 tUSDC to Halden Ventures on Base |
| Base token payout (Advance repaid from unlocks) | same run | `withdrawMax` of stream 153 [0xa85e66de…](https://sepolia.basescan.org/tx/0xa85e66de0315d7c0cdf8fadbe8abe60d110cca5f3d6415d27e0a290ccf3fd785), `claim_base_tokens` [6kNhZ2Vf…](https://testnet.near.rocks/tx/6kNhZ2VfQkJLreKRjTqfZdTpJbiHuYSMa8V8eBU6N9Af), `executeTransfer` [0x8a446868…](https://sepolia.basescan.org/tx/0x8a446868c428236b4a4dee344ab7032998c9e7f97b3c8c0c5ebade7efbf5f4ad): 0.3748 CINDR to Varick Partners |
| In-kind redeem (Base) | same run | `redeem` of position 8 [318timqv…](https://testnet.near.rocks/tx/318timqvqX578vAbaSpWzqxKeS8j2Bj8n8mWfK2dFZ7y) + `executeRelease` [0xb5b1ebcb…](https://sepolia.basescan.org/tx/0xb5b1ebcbcf8f02f6b433130063a06d3c37177ad677165cabc1d127991c02b84a): Sablier stream 155 back to Nadia Solvik; `e2e-live.ts all` exit 0 on its first run |
| Solana stream, main case | `node scripts/e2e-solana-stream.mjs engine.rose-app.testnet all --holder b1.rose-ckd-1793753433.testnet` | exit 1 at `claim` ("nothing claimable yet", by design: started 3 min after the stream); attribute [24ajYirq…](https://testnet.near.rocks/tx/24ajYirqVfaELgkC3h1yJuN4gFfyMCdoTnYePUX2zTso), move [J2Pw79cg…](https://testnet.near.rocks/tx/J2Pw79cgcHWTikYXB71GYoPTKJTNffd9Viiw1m4PdVGG) + [5NKGrYnx…](https://explorer.solana.com/tx/5NKGrYnxAxApN1VoQCaxd1GMxnjSpWENCqw7TGLar3xQK1FwpT2TAiSwvpzq5yLrcrXH52B3ZkPxafqG5yMKFbLa?cluster=devnet), register [9sGmh9mH…](https://testnet.near.rocks/tx/9sGmh9mHQxo1m3Qku51VwVYkwLUQeSMcaBGFcZ72FyZd) (position 3) |
| | `… all` again | exit 1 at `transfer` (the step is not resumable and the stream already sat at the vault: Streamflow 103 in simulation, nothing sent) |
| | `… claim`, `… confirm` | exit 0, exit 0: receipt-nonce payout 4, `claim_sol_tokens` [9fsQ267s…](https://testnet.near.rocks/tx/9fsQ267sZE1GteYkFn6U84DGXPdz4SDY6EoB86TrUBzY), broadcast [26JUFvVS…](https://explorer.solana.com/tx/26JUFvVSWryUumiSDjSAQQQKgB4oSGSt7PuGMX7HtBBnr7CSXdGYKVHtQXUDgUNjCi8fWzemVbSP7qd7sNmEXFNF?cluster=devnet) (299.999999 tokens), `confirm_sol_payout` [EtFQK9LT…](https://testnet.near.rocks/tx/EtFQK9LTrWnnYLdzBdvkkyQvtaBDMfzZMfZptwoGsVFP): `Landed` |
| | `… redeem` | exit 1: [BvBEFW36…](https://testnet.near.rocks/tx/BvBEFW36WFKGq4ajFA38bqigauWvV8n4S8DtfsCRp5un) burned the units, but the MPC's `verify_foreign_transaction` receipt failed with "Request has timed out" and the engine refunded the burn in the same transaction (`mt_mint`, `payout_failed` "nonce or recipient attestation failed or mismatched"; position 3 `Held`, payout 5 failed). The engine behaved as specified; the script then read the null pending release as a payout id (fixed in `0ed1ea3`: it reports the refund) |
| | `… redeem`, `… confirm-redeem` | exit 0, exit 0: `redeem` [DoX3E2tL…](https://testnet.near.rocks/tx/DoX3E2tLUck3FCabne2Bsdmg4ocHPSK5Dh5RNY7XEwcW), `transfer_recipient` to the holder [whm2FXLz…](https://explorer.solana.com/tx/whm2FXLzAx7Rzscdu9XQycD8ntpKzUbcNK7Zwcb9djR9RmNySzz8fWhmefRNAahmvXQCirg5wpK2gwR2obENtsm?cluster=devnet), `confirm_sol_redeem` [3XWr1LBn…](https://testnet.near.rocks/tx/3XWr1LBnQD6VtpPUAnod5w5TyMEZkk2K6txR8GLsFSuj): position 3 `Released` |
| Solana stream, ended case | `node scripts/e2e-solana-stream.mjs engine.rose-app.testnet all --holder b1.rose-ckd-1793753433.testnet --case ended` (run first, the main case ran while it waited) | exit 0, first run, 65-minute stream `5wuxEdcs…`: attribute [9ZLsEBsJ…](https://testnet.near.rocks/tx/9ZLsEBsJwRtbuhHZnYHVtzXiPF3nkdoEEKqvdBUsCGBT), move [3WmNfTJB…](https://testnet.near.rocks/tx/3WmNfTJBFmNFyX77N6YFMji93uyZvEJjuK7rkBDc1x14) + [4nhbLJL2…](https://explorer.solana.com/tx/4nhbLJL2PBsscp2mfnF158Gs418csRYuo3UNtQR9WXTZqnv3kD5QZ6aFDEYs8KmrDdxC6FSS8GDpNTSknESRef9u?cluster=devnet), register [8zY1apBC…](https://testnet.near.rocks/tx/8zY1apBCnoWr5RdRdsFyUHrkJzhEfVxmCg1qposxUsZb) (position 1); Streamflow's auto-claim at the end [2mmp1Esu…](https://explorer.solana.com/tx/2mmp1Esurq6h3kFSrXokCPb2oDx1BojFbcoXdwgYmztTfVQsJ83a7hTqYbf12wHfq1ibpzUFLBXkRj2pfHZkcTFD?cluster=devnet) ("[10] Auto-Claim", 3,900 of 3,900 withdrawn); `sync_sol_stream` [Gcku9nnF…](https://testnet.near.rocks/tx/Gcku9nnFTbXCMNeLup42pmTz468u7MFwCfihqdrANLh1) booked 3,800 (an app claim drew 100 before the end), stream pruned; claim paid from the swept balance alone [Eb4v8qkp…](https://testnet.near.rocks/tx/Eb4v8qkp2g9WYaCcJvBQtLVnWniR2DhDPHH1Kh6gh2au) + [5shzwd1D…](https://explorer.solana.com/tx/5shzwd1DYxtjYbYJx5JqepcthD1Cz8Q4k3KbGNSv4ugrerq5ttFUweorxi5JoDBUNzx4bzUYU7KwRJqugbHHmcrc?cluster=devnet) (`TransferChecked`, 405 CU), `confirm_sol_payout` [CwqWxZZw…](https://testnet.near.rocks/tx/CwqWxZZwm1Prp9ffVYLBnpGBdBCR6dUgVXuoUZZkfTKt): payout 11 `Landed`, swept balance 0 |
| Demo manifest | `node scripts/demo-manifest.ts --env deployments/engine.rose-app.testnet.env` | exit 0: 4 rounds (#0 tender, #1 exit, #2 advance, #3 no-key), 35 steps, 116 transactions; the views recorded into `apps/web/e2e/fixtures/demo-engine.json` (161 events) |
| Round left open | `node scripts/seed.ts open-round --env deployments/engine.rose-app.testnet.env` | exit 0: Exit round 4 on the Seed Round, NEAR tUSDC, closes 2026-11-20T13:16:26Z, key timeout 7 d, reveal window 24 h [CsKU3E2G…](https://testnet.near.rocks/tx/CsKU3E2GDxGBQt8AHywRVNKrVN64XGfcP2YrvsQ9m5rC); Halden Ventures' sealed ask of 50,000 units [Aa4wLova…](https://testnet.near.rocks/tx/Aa4wLovaFQRsbc6FjaTurgA7PnWZxW1hoP6UWnzcPiBK) |
| gas/sol | `node topup-gas2.mjs BE9yDmZ7QXDuwHxtThY527E9c5JSb7TMGdZx4crjFbAe 0.2` (scratch script: one SystemProgram transfer from the ops key up to the target) | 0.0955 SOL ("gas low" below 0.1) topped up to 0.2 SOL [2YfsDenK…](https://explorer.solana.com/tx/2YfsDenK6jxixShSk3CMuitaMCSzq5jbnfxgfHerTbreYTZDN1EAfBRfXBJwXNbeUf8ahipKvBfYaD7husJDbdWs?cluster=devnet) |

## RoseVault for the second final engine (2026-11-06)

`engine.rose-app.testnet` is superseded (an Advance funder's lien share never left its account
index, fixed in `46358b2`; the keyless engine cannot be patched), and a RoseVault's `SIGNER()` is
immutable and bound to one engine account, so the next final engine `engine-v2.rose-app.testnet`
gets its own vault. The demo assets (TestUSDC, DemoToken, DemoStreamFaucet) are reused.

| Step | Command | Result |
|---|---|---|
| Derived addresses of the new account | `scripts/derive-vault-signer.sh engine-v2.rose-app.testnet --all` | `vault_base` `0xc345e592c6db18c162c6225bfb6f6c92b425b7cb`, `vault_sol` `EqywuZpmf7i4ycvYqwzxEiDKTq94RifUSjH9pQX1SdWC`, `gas_sol` `HWx7jD36pAzB1Bo83bCvRYtnW5SHLcfdEZw4x4Zdn1Ng` (MPC `derived_public_key`) |
| RoseVault | `scripts/deploy-base.sh --engine engine-v2.rose-app.testnet --role final --demo-assets-from engine.rose-app.testnet` | exit 0: `0xb72a42bc59ec2423ed76b56ac82cd3457a6310fe`, [0x301ce573…](https://sepolia.basescan.org/tx/0x301ce5737f288a40df02e48ff3da1049bf2c3a5d4fa6f008020bf9512addf126), block 55,280,887; the script read back `SIGNER()` and `LOCKUP()` |
| Independent read | `cast call --rpc-url https://sepolia.base.org 0xb72a42bc59ec2423ed76b56ac82cd3457a6310fe 'SIGNER()(address)'` and `'LOCKUP()(address)'` | `0xC345e592C6Db18c162c6225BFb6F6c92b425b7cb` (the engine's `vault/base`), `0xA65A1ecEf02C2B9BDc604951c6A6D02335D4532e` (Sablier Lockup); 13,255 bytes of code |
| Superseded record | `jq` on `deployments/testnet.json` | `engine.rose-app.testnet`: `role` `superseded`, `superseded_by` `engine-v2.rose-app.testnet`, `superseded_reason` (no script reads the role; `deploy-base.sh` and `deploy-engine.sh` only write their own engine's) |

## Second final deployment (2026-11-06)

| Step | Command | Result |
|---|---|---|
| Reproducible build | in a plain clone of `0524b33` (pushed, full gate exit 0): `cargo near build reproducible-wasm` in `contracts/engine` (the steps of `deploy-engine.sh --reproducible`, run first on their own so the artifact's size could be checked against the 17 NEAR before any account was created), kept as `target/near/reproducible/rose_engine-0524b3388f7bf512f39bf521e9af68736482ef9e.wasm`; the build image removed afterwards | exit 0: 1,019,188 bytes, sha256 `0a0a16ef9cec1916d59b963183eee9a20ded1206e4ec25bbaef759335ae8e46a` (bs58 `gC11tnmCzFJ6Bi2BjkQ6Y38Ff5Vttr2J2tKzNTiiuhK`); embedded `build_environment` `sourcescan/cargo-near:0.22.0-rust-1.97.0@sha256:b193c8640a27172f83136a0f0aab2a9bf9d09f6ba0e6afd187addfaa9b92bae0`, `source_code_snapshot` `git+https://github.com/gamween/rose?rev=0524b3388f7bf512f39bf521e9af68736482ef9e`. `new` needs about (1,019,188 + 2,000 + 458,752 bytes) x 1e19 yoctoNEAR + 0.5 NEAR = 15.3 NEAR |
| Deployment | `scripts/deploy-engine.sh engine-v2.rose-app.testnet --role final --wasm target/near/reproducible/rose_engine-0524b3388f7bf512f39bf521e9af68736482ef9e.wasm --keyless --rose-vault 0xb72a42bc59ec2423ed76b56ac82cd3457a6310fe` (`--role final` accepts the artifact only because it names the pinned image and a commit on `origin`) | exit 0, first run |
| Account (17 NEAR from `rose-app.testnet`) | same run | [AzUsL5Bb…](https://testnet.near.rocks/tx/AzUsL5BbbsG3C5s1rcfDqRPQK4YCMUMLVAMG15TRSD5R) |
| Deploy and `new` | same run | [5y42Nnqc…](https://testnet.near.rocks/tx/5y42Nnqcy58dypq5B6SqqVmfgtM1JsRXTjVeJVJX94Zp) |
| `bootstrap` | same run | [CfnCUcRC…](https://testnet.near.rocks/tx/CfnCUcRCXLHFLLtqhrmVmKBRKRvSnvuyobjW2eekmeaq); `vault_base`, `vault_sol` and `gas_sol` equal to the MPC's derivation above |
| Checks before the key deletion | same run | code hash equals the artifact; `get_config` equals every init argument (CKD key re-read from `v1.signer-prod.testnet`); the bound RoseVault's `SIGNER()` and `LOCKUP()` read live |
| Key deletion (one transaction) | same run | [2ctK442K…](https://testnet.near.rocks/tx/2ctK442K8PzHwALUsU9WzSZ2RYg4emwvSFwhXf2FjVJ3); `view_access_key_list` polled at `final` until `[]` |
| Keyless check | `curl -s https://rpc.testnet.fastnear.com -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"view_access_key_list","finality":"final","account_id":"engine-v2.rose-app.testnet"}}' \| jq -c .result.keys` | `[]` (block 276,503,426); `view_account`: `code_hash` `gC11tnmCzFJ6Bi2BjkQ6Y38Ff5Vttr2J2tKzNTiiuhK`, storage 1,020,537 B, 16.99 NEAR |
| Source metadata | `curl -s https://rpc.testnet.fastnear.com … "method_name":"contract_source_metadata" …` | link `https://github.com/gamween/rose/tree/0524b3388f7bf512f39bf521e9af68736482ef9e`, the pinned `build_environment`, `contract_path` `contracts/engine` |
| near-cli signing path after a config migration | `near tokens rose-app.testnet send-near rose-app.testnet '0.001 NEAR' network-config testnet sign-with-legacy-keychain send` (near-cli-rs 0.30.1 had just migrated its config from V4 to V5) | [Hs1JhYTU…](https://testnet.near.rocks/tx/Hs1JhYTU8VaMAhzgo4SFCUc48TsiWzSmXyTHatkAyh2n): the `Transaction ID:` line the scripts parse is unchanged |

## Live end-to-end, engine-v2 (2026-11-06)

Every flow of the seeded story and of the Solana custody run again on the final keyless engine
`engine-v2.rose-app.testnet` and its RoseVault `0xb72a42bc59ec2423ed76b56ac82cd3457a6310fe`, with
the same scripts as on the engines before it. Full transaction tables:
`deployments/e2e/engine-v2.rose-app.testnet.{seed,live,solana,solana-ended}.json`
(`node scripts/e2e-live.ts report --env deployments/engine-v2.rose-app.testnet.env` prints the seed
and live table).

| Step | Command | Result |
|---|---|---|
| Seed | `node scripts/seed.ts all --env deployments/engine-v2.rose-app.testnet.env --kol-wallet nadia-v2` | First run stopped by hand at the Base registrations: its process kept reading a Base safe head of 55,282,265 for over 20 minutes while a fresh process (`cast block safe`, and viem in a new Node process) read 55,283,214, so its HTTP connection was pinned to a lagging `sepolia.base.org` backend. The registration of stream 157 was already in flight when it stopped (position 3 registered at block 276,503,993; its hash is not in the journal). Second run, same command: exit 0, resuming from the journal. Cast topped up from `rose-app.testnet` (e.g. [A8kzVECg…](https://testnet.near.rocks/tx/A8kzVECg27vCHSSMnmSRpRKT2PyUKbV3wJRMxamKLBxZ)); Seed Round `createStreams` [0xc2cf7629…](https://sepolia.basescan.org/tx/0xc2cf76299e247fabcc8f167f312203a278e43111acea652c7b5f99ece3e2fb45) (streams 157 Halden Ventures, 158 Tessaro Capital), KOL Round [0x04826032…](https://sepolia.basescan.org/tx/0x04826032a57625150d51f339a2088bc8501399c872cc997d9024d9b790529163), Nadia's self-deposit [0x8454f0cf…](https://sepolia.basescan.org/tx/0x8454f0cf75ca5298a0c9fffa98b36597bbf34003872b74186439d5b8896751c8); `register_base_deposit` of stream 158 [3B4xGvii…](https://testnet.near.rocks/tx/3B4xGviiUP7aA4KKa9GRPeMJ519S8zWi7TvHeQcZMvvi), 159 (first attempt [KQTRFPN1…](https://testnet.near.rocks/tx/KQTRFPN1t1hExZmP8KQvTj2BKw38bycU3Qtk6H3XYdV) not attested, the status page's one failed ForeignTx; retry [6g1YFNqB…](https://testnet.near.rocks/tx/6g1YFNqB13PNoevvhd3HYZKe7kBr4d3E71tGHr8YAEyF)), 160 [AWEapohT…](https://testnet.near.rocks/tx/AWEapohTuAwznqqhLGn26Y2RUFUYQBmWcqvPWEvYY4kx), 161 [FX3smDbE…](https://testnet.near.rocks/tx/FX3smDbEdS2Pqq4sTzR6rx6RoWtRyqsndGNQjpC2KHTs); Strategic Round attributed [149ZdeKg…](https://testnet.near.rocks/tx/149ZdeKgSz5wofm9fNWXKZ9fW6cNKPSuMNrg8WPTnoLG), moved [4xBFUiy1…](https://explorer.solana.com/tx/4xBFUiy1ARwnU4rZnWNjfMVHHR2guLPA1FAJkfAajVmxoQJqRDURS2bH9ssJaVfCSmR6Xjh3ooGXKuFhTFkreaAU?cluster=devnet), registered [FnTRaGhi…](https://testnet.near.rocks/tx/FnTRaGhixi42tKbYjGyJ3KhPqLke6vpBc9JTJ8dmhhik); rounds 0 Tender [9CB4AN7f…](https://testnet.near.rocks/tx/9CB4AN7f63h6onD2GrakwxRFwF27VH5REuWUcofe9zbN), 1 Exit [6id5iHD1…](https://testnet.near.rocks/tx/6id5iHD167Z6SCf9zHyMd44DmcenKhEQ9ARwh6bpvQPD), 2 Advance [FxcVyrVU…](https://testnet.near.rocks/tx/FxcVyrVUtfMbWgR5m8Xw8gHm7yesWE3m5mAdUEvC4MSQ) with 10 sealed orders; demo mint `2eWdSYbcryjZvA8UBmjTmEqjRqzY2LVUnHUby1gdDLNv` (the cast's, reused) |
| No-key round | `node scripts/e2e-live.ts all --env deployments/engine-v2.rose-app.testnet.env` | round 3: `close` refused after the 60 s timeout [EYSv5djd…](https://testnet.near.rocks/tx/EYSv5djd3wmH72cC4TRxtJmywErjZEdGbGdeFU8Akb3T) ("Key timeout reached"), `cancel_no_key` [GuA2xPAB…](https://testnet.near.rocks/tx/GuA2xPAB5ifbzwjAqv6LbfmHzSMnqPmvrQdvLaWsWj8e), refund [7w8kTEDA…](https://testnet.near.rocks/tx/7w8kTEDApo1rDY4jPBrWHrHqLYxVepdTsBrEV2Vdx8Bn) |
| Key release after close | same run | Tender [82iWCcCj…](https://testnet.near.rocks/tx/82iWCcCjj1Jb9CBNiR4vtsv5Si9tkQRPsB8fv47Ck377) 4.76 s, Exit [9D31fRAL…](https://testnet.near.rocks/tx/9D31fRALyropD1cFjAVZduN8cSXrgWR5PHHHfkYM819Y) 4.23 s, Advance [EvYijsfB…](https://testnet.near.rocks/tx/EvYijsfBSK1rsCtAG3NQeqmRv1nFADSdTBJs8dkPTR7j) 4.87 s; 37.4 to 37.5 Tgas; key by callback, each equal to the offline unwrap of the MPC response |
| Openings | same run | 9 openings by `rose-app.testnet` at 132.10 to 132.15 Tgas (e.g. [Eqq9Cwqy…](https://testnet.near.rocks/tx/Eqq9CwqytozdU8jv4G526aC3gNtPYTs8Sz9LhST8eJTD)); the malformed bid's own opening refused [CnvMqSd2…](https://testnet.near.rocks/tx/CnvMqSd25evQwrSRmHezWhQf3mXTX6ME2TSVe1JNFYwk) ("Opening does not match the ciphertext", 131.3 Tgas) |
| Clearing = reference | same run, then once more | Tender [2cvvExqG…](https://testnet.near.rocks/tx/2cvvExqGXGTMwunyC4xYN9YigCCxduytVDLNZxhetqDn) 0.036 tUSDC, volume 41,666.67 CINDR; Exit (Strategic Round, Solana positions) [GFhakKKW…](https://testnet.near.rocks/tx/GFhakKKWK2oZWR8xw3CiTetdZqxnhsr65aXmDDTXAAyu) 0.027, volume 70,000; Advance (KOL Round, Base) [26xm8LXQ…](https://testnet.near.rocks/tx/26xm8LXQH4FAUBiMQ3hraYFgckuRzPUJ17RDKpbmRo6r) 0.0375, 3,000 claimed tokens; every price and fill equal to `@rose/sdk` on the opened orders. The first run then stopped with exit 1 at the Tender's first `settle_bid`: `-429` from `rpc.testnet.fastnear.com`, caused by a block scan sent from the same address at the same time (stopped); the second run of the same command exited 0, resuming from the journal |
| Settlement | second run | 10 `settle_bid`; the malformed bid void (`Unopened`) and its 1 tUSDC bond slashed [93F56CBa…](https://testnet.near.rocks/tx/93F56CBaDPUZrdcuUjvccnDb9qDVKKamMyDVz7nyfFJu) |
| NEAR USDC payout | same run | `withdraw_near_cash` [FswYgYh7…](https://testnet.near.rocks/tx/FswYgYh7PC715bmwLNCmseUy9JA7o1g7gw5WqYjw3xfG): 1,732.3875 tUSDC to Ines Marlow |
| Base USDC payout | same run | `withdraw_base_cash` [9BESbgMJ…](https://testnet.near.rocks/tx/9BESbgMJ85ixAdGiY8XQ1R5rRRFX4wDimkrng9C5cWEu) + `executeTransfer` [0xb403f62a…](https://sepolia.basescan.org/tx/0xb403f62afe5728f748cdbe80a630e3aab7b7d2705eb953e81d2d878117edd432): 1,460 tUSDC to Halden Ventures on Base |
| Base token payout (Advance repaid from unlocks) | same run | `withdrawMax` of stream 159 [0xcbe7b057…](https://sepolia.basescan.org/tx/0xcbe7b05790f81def67601e73de7ca7abd36504441485edac85514f63877aba28), `claim_base_tokens` [7SsvHCs3…](https://testnet.near.rocks/tx/7SsvHCs3gMQrNUmaKHc9BZK65B23EW4VtNpvNsHgnwB1), `executeTransfer` [0x578ccbcd…](https://sepolia.basescan.org/tx/0x578ccbcd74ddc1d806f386562dab8bbd02f1168f19a9f320b0a040ddfa1db571): 0.9189 CINDR to Varick Partners |
| In-kind redeem (Base) | same run | `redeem` of position 8 [3eTP42S7…](https://testnet.near.rocks/tx/3eTP42S7QcqX3yx5TSaPBAx1Hd9dahYqMzxpq4QWrz99) + `executeRelease` [0x59e6facd…](https://sepolia.basescan.org/tx/0x59e6facd04330c6d15a9a11559eb2ccd76e1787976e0bee0ab79a1e88e02d2c6): Sablier stream 161 back to Nadia Solvik |
| Solana stream, main case | `node scripts/e2e-solana-stream.mjs engine-v2.rose-app.testnet all --holder b1.rose-ckd-1793753433.testnet` | exit 1 at `claim` ("nothing claimable yet", by design: the stream starts a few minutes after its creation); attribute [FARYkkRk…](https://testnet.near.rocks/tx/FARYkkRkDtW3ET4sAL7MNz99AVo2bCGfJj8cWC9rN2YC), move [2EcxR4tu…](https://testnet.near.rocks/tx/2EcxR4tufh8GhseKimJfboVLgLfvq3oqejDCacK6EzF4) + [5YRsRaSc…](https://explorer.solana.com/tx/5YRsRaScTMa2TMYTRPv9cuUGLsaNMjVEMyANeuKXVKZYj1S4QuLq18KfHyFsEj3xaq6Vk12bW8X91xj8ikCKZ1pa?cluster=devnet), register [BbfHakRW…](https://testnet.near.rocks/tx/BbfHakRWU2gtRiNdvY8yrckh2EvaCz7apX1CR2WJzCy5) (position 5) |
| | `… claim` (38 s after the stream's start, then 3 min later) | exit 1 ("nothing claimable yet"), then exit 0: receipt-nonce payout 4, `claim_sol_tokens` [86wtZg82…](https://testnet.near.rocks/tx/86wtZg822RMxqXMPGVUFHsEB6dqfzehq34g5eVkaE76V), broadcast [46ZF74WS…](https://explorer.solana.com/tx/46ZF74WSUihFctEX5YYQcTEiBbfUC6dxUXpq6eHFUbf9Hd5zj6ybgd9etxFWCsNqVhy4g18yeeS2LJZHNgxRV4U6?cluster=devnet) (180 tokens) |
| | `… confirm`, `… redeem`, `… confirm-redeem` | exit 0 each, first run: `confirm_sol_payout` [Bv9RZpax…](https://testnet.near.rocks/tx/Bv9RZpaxVzX2G9CZqAM8LvpRZoB9QXunYFpCoJ7yji4K) (`Landed`), `redeem` [5erw3mkz…](https://testnet.near.rocks/tx/5erw3mkzPLi6GNoE3bNmmoD4xmg47ebpue3Hs3VRvdwq), `transfer_recipient` to the holder [4SjvN2x7…](https://explorer.solana.com/tx/4SjvN2x7MZH9yy3MCDCZiteBbDm7RiMKQVdTosUmHSu3Q7nKcB7zhuapm7MgNjE4Q2sGDooTKJRBLydeGYkSuecT?cluster=devnet), `confirm_sol_redeem` [4Vpy2Ywg…](https://testnet.near.rocks/tx/4Vpy2YwgSE6Nbr6gTzCt3HfBoFqpGQWNHtH4SsvsyXG2): position 5 `Released` |
| Solana stream, ended case | `node scripts/e2e-solana-stream.mjs engine-v2.rose-app.testnet all --holder b1.rose-ckd-1793753433.testnet --case ended` (started during the seed; the main case ran while it waited) | exit 0, first run, 65-minute stream `SCrDSoL2…`: attribute [5KLWPJoV…](https://testnet.near.rocks/tx/5KLWPJoVchnFyJYDAw5yMV69LQCvJnXrWTWrod3ZKo96), move [51gZdyRa…](https://testnet.near.rocks/tx/51gZdyRaESMH5weuzh22FnExShNobHHngcrhi9pXkCgp) + [3SBmduyT…](https://explorer.solana.com/tx/3SBmduyTRrZzXqY8exCMX5AUDVh9nA86B1kvkCwNnVuSGf3AxRV5Btvh1fLcjwVZK81bZ7oyDeq2GGMEuEkTzuK1?cluster=devnet), register [BvWWGwhw…](https://testnet.near.rocks/tx/BvWWGwhwDve63j8yqhVbmcycaCJQvU2ovBk8iVFg33bo) (position 2); Streamflow's auto-claim at the end [2j4ftDid…](https://explorer.solana.com/tx/2j4ftDidWY3NMZHm3dhdNx3rcz4tKb7PknvgtnSVd4jP8pNY4yarKHJkpeZu3X9diKt57VTguNhUYZeNGZeq244e?cluster=devnet) ("[10] Auto-Claim", 3,900 of 3,900 withdrawn); `sync_sol_stream` [GyDe3pdE…](https://testnet.near.rocks/tx/GyDe3pdEt6WntUJtZvgqxgEKNtXJuj8K4xVHM3en2DDN) booked 3,800 (the app's claim below drew 100 before the end), stream pruned; claim paid from the swept balance alone [3TPw2vCR…](https://testnet.near.rocks/tx/3TPw2vCRxKo4GTXDhEdP4jMpmeLfLwt9cPpG878qGCUm) + [38189Ckk…](https://explorer.solana.com/tx/38189CkkpiF9cbQVGubqAv3um6suGs5MxH5yJzvcfaeJpsHGJq2pqEstiHbfHffcvsNqyd6nhwx3T29EqNc56i5p?cluster=devnet) (`TransferChecked`, 405 CU), `confirm_sol_payout` [R4KvtgBH…](https://testnet.near.rocks/tx/R4KvtgBHzAvo2CnBLJefcGHpAjR3SFXf3mwtkoQvd7U): payout 10 `Landed`, swept balance 0 |
| Demo manifest | `node scripts/demo-manifest.ts --env deployments/engine-v2.rose-app.testnet.env` | exit 0: 4 rounds (#0 tender, #1 exit, #2 advance, #3 no-key), 35 steps, 116 transactions; the views recorded into `apps/web/e2e/fixtures/demo-engine.json` (157 events); `engine-s5`'s manifest and recording removed (reclaimed), `engine.rose-app.testnet`'s kept as `demo-engine-v1.json`. Local `playwright test e2e/demo.spec.ts e2e/docs.spec.ts` on an engine-v2 build: exit 0, 22 passed |
| Round left open | `node scripts/seed.ts open-round --env deployments/engine-v2.rose-app.testnet.env` | exit 0: Exit round 4 on the Seed Round, NEAR tUSDC, closes 2026-11-20T16:05:24Z, key timeout 7 d, reveal window 24 h [5PuzdAAa…](https://testnet.near.rocks/tx/5PuzdAAadD1MUkDN4uVEv3bqEe5tnSfBXfXVJvfK4w6Z); Halden Ventures' sealed ask of 50,000 units [8QtBKsve…](https://testnet.near.rocks/tx/8QtBKsveSR2x23sBuaCwgHZLLuGJaupheCcLFQ7njmLJ) |
| gas/sol | `node topup-gas2.mjs HWx7jD36pAzB1Bo83bCvRYtnW5SHLcfdEZw4x4Zdn1Ng 0.2` (scratch script: one SystemProgram transfer from the ops key up to the target) | 0.0955 SOL topped up to 0.2 SOL [3yhmcg2t…](https://explorer.solana.com/tx/3yhmcg2tF8Wm1ugifWC2W7Qo7r7ZzEG5yekDDBbxYJdwE4paVwymVcpS2WrwRT9mTd5vkUPx5MeeDfsWibRQPWPJ?cluster=devnet) |

### Production switch to engine-v2

- `vercel env rm <name> production --yes` then `vercel env add <name> production` (value on stdin)
  for the eight `NEXT_PUBLIC_*` of `deployments/engine-v2.rose-app.testnet.env`: 16 commands, exit 0.
  `vercel env pull --environment=production` then a sorted diff of the eight lines against the env
  file: identical (the pulled file deleted).
- `vercel deploy --prod --yes` (repo root, `3287317`): exit 0, deployment `DW9C6mZQaejHz1woLEyMtAU6weww`,
  aliased to https://rose-rounds.vercel.app. `/status`: "Keyless", account
  `engine-v2.rose-app.testnet`, keyless check "None", engine wasm `gC11tnmCzFJ6Bi2BjkQ6Y38Ff5Vttr2J2tKzNTiiuhK`,
  MPC latency of rounds 0 to 2 (4.8, 4.2, 4.9 s), RoseVault `0xb72a42bc…` "Signer matches engine",
  `gas/sol` "Gas funded"; 0 px horizontal overflow at 1470 and 375 px.

### Live click-through on engine-v2 (real UI on production, demo wallets)

- Get test funds with fresh demo wallets (`rose-demo-e1v9wh.testnet`, `0x7650…98C9`): account
  created with 10 NEAR [EDHkVYgE…](https://testnet.near.rocks/tx/EDHkVYgEySG9a5F2k32xsK4unNcK4go3VqiiKxVFWrdN),
  1,000 tUSDC on NEAR [G5nNjjuR…](https://testnet.near.rocks/tx/G5nNjjuR7MLsgathZkuyw9PhnZgx5jdvAD9V6BoDjjxb),
  0.002 ETH [0xa7d07926…](https://sepolia.basescan.org/tx/0xa7d079265cb152f413caa33b74d73e5aaea0427b1dcbf89610c18a5600753e1a),
  1,000 tUSDC on Base [0x69224110…](https://sepolia.basescan.org/tx/0x69224110ba8180c006cf67a2f953d5460c165a892f0d5aac1486bf2442d2feb0),
  demo vesting position, Sablier stream 162 [0x24dc4449…](https://sepolia.basescan.org/tx/0x24dc4449c691a6a22ac4493c6e43886026eae59a3cc73542afb3b32173893dc3).
- Deposit of stream 162 from the deposit wizard, about 3 minutes: approve
  [0xa081f221…](https://sepolia.basescan.org/tx/0xa081f2216f685d0cb109f1c09536d8284a7da3a9616088edefd6cced3719c46c),
  `depositStream` [0x9756c7f9…](https://sepolia.basescan.org/tx/0x9756c7f96ff46a05fd6b778fd78120ae467ab8ab2f48b1082d9b43fbbe069323),
  safe head wait, `register_base_deposit`
  [AVaMqXA4…](https://testnet.near.rocks/tx/AVaMqXA48fwGVLNoUoZmKVhkQruqksAcRejPaieektP8):
  100,000 units of the Seed Round class minted.
- Sealed bid on round 4: "Deposit cash" `ft_transfer_call` of 41.12 tUSDC
  [6k9azSdh…](https://testnet.near.rocks/tx/6k9azSdhjDAfkbx7oburPsYAGC9vSmViCmDUWoyvvo4u), then
  "Seal and place bid" (1,000 units at 0.04, escrow 40.12, bond 1.00)
  [FogbeL6E…](https://testnet.near.rocks/tx/FogbeL6EGCZeH5jDZ48CpoeMSML3Pudjjro7J2UcsTVf): bid #1,
  shown sealed in the book with "My orders" keeping the plaintext in the browser. The driving
  script's first attempt waited for a toast reading "deposited" while the app's success toast
  reads "credited to your cash" (a script bug; the cash was credited, `get_cash` 41.12 tUSDC).
- Guided demo (`/app/demo`) live on engine-v2: the Tender's openings at 132.1 Tgas, the Exit to its
  last step, 0 px overflow at 375 px.
- Solana claim with confirm, 100 tokens of the ended-case class before its draws stopped, with
  `b1`'s NEAR key and a fresh Solana demo key `H4sSHegW…EEhv` funded 0.05 SOL
  [4UzADJ5n…](https://explorer.solana.com/tx/4UzADJ5nzQSCyYTLHT5ToiCCFM9EAgzoHQJ3Gf6bRydpEBGq81X5T9CYbi14QmVAuMRfcMy7rPJBi8dxhN6Zt93R?cluster=devnet),
  60 s: nonce and receipt accounts [3deArM8Q…](https://explorer.solana.com/tx/3deArM8Qs9LNcofDcX82414CVyYwqR16TfUzkYCazrKZgCuNfmAQr6z4yPtunySXV8tJYTEnHf5yXEMnyxwxVoFP?cluster=devnet),
  request [HWFtWrxi…](https://testnet.near.rocks/tx/HWFtWrxiiVQwgGE3o4BQYX16bKcjEMrRgcugnuqE8eJ),
  broadcast [5mfhsBW8…](https://explorer.solana.com/tx/5mfhsBW8CeBSmtwgqgDrZU5YMxvbhseqhwNJVnkr9c95uxLVqFubBtxARbS3wMgo2NEFSPTEF9y1PjPAwtVnNKvj?cluster=devnet),
  `confirm_sol_payout` [F8Yg1PxD…](https://testnet.near.rocks/tx/F8Yg1PxDohv5C8vQo42MgN2YKCwxEk4NpKtTTPGDvZTW):
  payout 9 `Landed`.
- Pages reviewed on that deployment at 1470 and 375 px (`/`, `/app`, `/app/rounds`,
  `/app/rounds/4`, `/app/demo`, `/status`, `/docs/contracts-and-addresses`,
  `/docs/trust-and-security`, `/app/prices`, `/app/issuer`): 0 px horizontal overflow on each.

## Final proofs on `3a99e6e` (2026-11-06)

- Full gate: `pnpm -r typecheck && pnpm -r lint && pnpm -r test && pnpm -r build && cargo test --workspace && forge test`, exit 0 (engine 175 tests, SDK 215, web 409, ibe-wasm 8, forge 140).
- Production `vercel deploy --prod --yes`, exit 0: `dpl_7j36nRVDGwVB8ZPt1LiyjTDSzstP`, aliased to https://rose-rounds.vercel.app (includes `3044a44`, the Base safe-head stall error).
- Keyless: `curl -s https://rpc.testnet.fastnear.com -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"view_access_key_list","finality":"final","account_id":"engine-v2.rose-app.testnet"}}' | jq -c .result.keys` returns `[]`.

## Sputnik DAO run and judging rounds (2026-11-14)

New Sputnik DAOs on testnet are created by the factory `sputnikv2.testnet` and run DAO contract
version 2.3.1 (the DAO `test.sputnikv2.testnet` recorded above runs 2.0.0). The run below was a
one-off: a script outside the repository imported the issuer console's builders (`dao.ts`,
`tender-form.ts`, `@rose/sdk` `EngineCalls`) and filed what they built from the DAO's two council
accounts; it is not one of the recorded scripts under `deployments/`, so this table is its record.

### Issuer console: a Sputnik DAO v2 runs a Tender end to end (2026-11-14, engine-v2)

The issuer console's own builders (`dao.ts` `sputnikProposal`, `daoNearFundingCall`, `ftTransferCall`; `tender-form.ts` `tenderArgsFromForm`; `EngineCalls.createTender`), called in the order `TenderTab.tsx` and `DaoPanel.tsx` use them, against a DAO created for the purpose. Round 7 of `engine-v2.rose-app.testnet` has the DAO as its creator.

| Fact | Command | Result |
|---|---|---|
| Live Sputnik factory2 on testnet | `call_function sputnikv2.testnet get_number_daos / get_default_code_hash / get_default_version / get_contracts_metadata {}` | 5,666 DAOs; default code `AA4nA45vauiac3jdVwJTzSdUP3oj2r1fDaPAb2mHdgcH`, version `[3,31]`, commit `7764926cfd3c47f62b5fcde231c251f3c3892887`; `sputnik-v2.testnet` answers `MethodNotFound` to these (older factory) |
| `create` signature | `curl -s https://raw.githubusercontent.com/near-daos/sputnik-dao-contract/main/sputnikdao-factory2/src/lib.rs` | `#[payable] create(name: AccountId, args: Base64VecU8)`: deploys the default code to `<name>.sputnikv2.testnet`, calls `new(args)`, `on_create` returns `true` or refunds the deposit |
| DAO created | `sputnikv2.testnet.create {"name":"cindral-treasury","args":<base64 of {config, policy}>}`, 7 NEAR, 300 Tgas, from a helper-funded council account | [F5ghEw2q…](https://testnet.near.rocks/tx/F5ghEw2qVuvTNfS3xgWUHdpnAZ1j4QvayNNtira2jzTq) (88.98 Tgas): `cindral-treasury.sputnikv2.testnet`, code `AA4nA45v…`, `version` "2.3.1", council of two (`cindral-council-a-011346.testnet`, `cindral-council-b-011346.testnet`), threshold 1/2 by role weight (both votes), bond 0.1 NEAR |
| Proposal outcome is reported | `sputnikdao2/src/proposals.rs` at `7764926` | a FunctionCall proposal executes as a promise followed by `on_proposal_callback`, which sets `Failed` when the call failed; so `get_proposal(id).status` = `Approved` proves the DAO's call succeeded |
| Funding proposal (DAO's own `ft_transfer_call` into the engine) | member: engine `storage_deposit` for the DAO [9mYVaXRX…](https://testnet.near.rocks/tx/9mYVaXRXSLQegNcFovri4iPYyMWuVSo6PGoE6XMaNGGQ), tUSDC `storage_deposit` for the DAO [AiBVMckx…](https://testnet.near.rocks/tx/AiBVMckxzqmTACnVsEUA4wE3bMtZ52SpiBai7mN4kR9x), `ft_transfer` 100.30 tUSDC to the DAO [HVfEqFvH…](https://testnet.near.rocks/tx/HVfEqFvHNYwkLdoCuxBZu9BXvJeVHcgd6ASq1VRuwTqV); `add_proposal` [2utQ7Cv9…](https://testnet.near.rocks/tx/2utQ7Cv94ym8HpYDHpip2yrd9vuX4nhDYfTm7Xst4y6R), votes [G2YLK3Tn…](https://testnet.near.rocks/tx/G2YLK3TnZ3v851y43VSrQyNLgiXaNad1rx4eQiNgtm8n), [7HJzxCFc…](https://testnet.near.rocks/tx/7HJzxCFc6rubKhTczsX9fFbaRPrP8WgmvQY1LXEjAP2C) | proposal 0 `Approved` (FunctionCall `ft_transfer_call`, 60 Tgas, 1 yocto), DAO engine cash 0 → 100.30 tUSDC (budget + 30 bps) |
| Tender proposal (DAO `create_tender`) | `add_proposal` [H7tG5GjZ…](https://testnet.near.rocks/tx/H7tG5GjZTrXAzHwYoRFuXaXakcLZdQ68WDUwDh72C1wy) with the bond read from `get_policy`, votes [9K5zADCh…](https://testnet.near.rocks/tx/9K5zADCh18RAwk8NMQNyPL24HkyHiMpmws3ympsMvCnu), [CxcrHTMZ…](https://testnet.near.rocks/tx/CxcrHTMZkcqWdVfqLf46iYV6xhVYR1uRLc1U2ssnfHPd) | proposal 1 `Approved` (FunctionCall `create_tender`, 30 Tgas, 0.05 NEAR), no receipt failure; round 7: Tender, Seed Round, NEAR tUSDC, budget 100 tUSDC, max 0.04, `creator` `cindral-treasury.sputnikv2.testnet`, `retire_to` `0x763726327e9f8da47d2e7432dc6e8f72f2121e0b` |
| Sealed asks | Halden Ventures moves 5,000 Seed units to Nadia Solvik (`distribute_units`) [FH8VF5DZ…](https://testnet.near.rocks/tx/FH8VF5DZyzpfDSG9pzktggN2CJvjvPfpDxqZsVvepUWT); `place_ask` Halden 1,000 at 0.030 [ERvMnDuz…](https://testnet.near.rocks/tx/ERvMnDuziGa661CyYqqk2GD3phKL6h8t3jmLWctstS1j), Nadia 1,000 at 0.036 [CfNcFYWk…](https://testnet.near.rocks/tx/CfNcFYWkwWhMVSu8rM9Hkc1Bgsq4u3iNPw7BiP55vkoQ) | two ciphertexts sealed with `scripts/lib/sealed.ts` to the live CKD key |
| Key release and openings | `close` [FBb23wTh…](https://testnet.near.rocks/tx/FBb23wThJpKLhhj7GgaMhYBwxpx6YhrZPCWju3unQ18s) (38.19 Tgas); `open_bid` [BcgMvFyk…](https://testnet.near.rocks/tx/BcgMvFykaWM7Y3trghSLWRo37a6PjUE7qe2UeUdTSKmM), [EqTmcDwe…](https://testnet.near.rocks/tx/EqTmcDwea3cYhyyCdmccpk9Y2o65M5cu8rZuVfEASqHL) (132.1 Tgas each) | key by callback 4.36 s after the request, equal to the offline unwrap of `(big_y, big_c)`; both openings equal the sealed values |
| Clearing = reference | `clear` [ESarBAbY…](https://testnet.near.rocks/tx/ESarBAbYgU7BraxenYXjTmx3rcFWFuGjZAFVqAL3mugp) | `Settled`, 0.036 tUSDC, 2,000 units, notional 72, fee 0.216, fills 1,000 / 1,000: equal to `@rose/sdk` `tender()` on every field |
| Settlement and retirement | `settle_bid` [2w8qdwp8…](https://testnet.near.rocks/tx/2w8qdwp8KpUVSawZ29PqjLNM6ypxVQUsJMaXK5pqJ5WA), [457c7mHt…](https://testnet.near.rocks/tx/457c7mHtqPifbmHRn2mf8NU3DHApcFErR8hVxbJHWXtB); `get_retired_lot {"round_id":"7"}` | 36 tUSDC to each seller, bonds refunded; retired lot 2,000 units payable only to `0x7637…1e0b`, `claimable` 0 until the Seed Round cliff (2027-05-08); the DAO's unspent 28.084 tUSDC back in its engine cash |
| Unspent escrow back to the treasury | `add_proposal` wrapping `withdraw_near_cash(28084000)` with `sputnikProposal` [A2XZjREw…](https://testnet.near.rocks/tx/A2XZjREwtoj1YNpMyvSRBFVEcRLE4zafrhQz3vJH5ibh), votes [Dqqp1eoD…](https://testnet.near.rocks/tx/Dqqp1eoDaMGZ81dr4KP2YsEsSnSpb8FZWPSTSzBo6pxr), [6eSfCbVN…](https://testnet.near.rocks/tx/6eSfCbVNrZv4dZ6JhHKjCaxEm7vf5WQAvLUaDvMgjhTf) | proposal 2 `Approved`; DAO engine cash 0, DAO tUSDC wallet 0 → 28.084 |

### Rounds left open for judging (2026-11-14)

| Round | Command | Result |
|---|---|---|
| 8 | `create_exit` by Halden Ventures [9tyRWSug…](https://testnet.near.rocks/tx/9tyRWSugaPhXvrbzTTeNbdT12ti55q1GYiMThY8MvkvF), sealed ask [8bB44rLK…](https://testnet.near.rocks/tx/8bB44rLKxztzgEwYZtnursqu9NP2fP9TQuQzEBBBvHbc) | Exit, Seed Round, NEAR tUSDC, max 0.05, closes 2026-11-16T15:00:00Z, key timeout 72 h, reveal 10 min; 10,000 units asked at 0.002 |
| 10 | `create_exit` by Nadia Solvik [9FT6iEia…](https://testnet.near.rocks/tx/9FT6iEiaBLb95BWbMtzFpySbDpBD8AKZH8Quzkxpum1S), sealed ask [8MVL88us…](https://testnet.near.rocks/tx/8MVL88usy4zF6WwJHNwsY7YPsEP4VtEvC3htqNB2isAL) | Exit, KOL Round, NEAR tUSDC, max 0.05, closes 2026-11-17T15:00:00Z, key timeout 72 h, reveal 10 min; 5,000 units asked at 0.002 |
| 4 | seeded by `node scripts/seed.ts open-round` on 2026-11-06 (see "Live end-to-end, engine-v2") and read with `get_round {"round_id":"4"}` on 2026-11-14 | Exit, Seed Round, created by Halden Ventures, closes 2026-11-20T16:05Z, reveal window 24 h, key timeout 168 h |

## Paths not produced live

No cheap refusal exists on Base: RoseVault's `depositStream` already reverts on every condition the engine's `admit_base_stream` checks (`WrongLockup`, `StreamCancelable`, `StreamNotTransferable`, `StreamDepleted`, `InvalidNearAccount` with the same NEAR account-id rules, the one-token minimum), and the engine's remaining checks are Sablier's own creation rules, which a live Sablier stream always satisfies. The return path stays covered by `forge test` (`test_executeRelease_vestedToRecipient_sendsVestedToTheReturnee`, the fork test `test_fork_returnSendsVestedToTheReturnee` against the live Sablier Lockup) and the engine unit tests (`every_spelling_of_a_refused_stream_records_the_canonical_return`).

The "did not execute" refund path (second proof after 150 blocks) is covered by unit tests on the flow (`components/portfolio/flows.test.ts`) and not produced live: making an engine-built payout fail on chain needs a stream state the engine refuses to sign against.

## Staging engines (2026-11-04 to 2026-11-06)

Before the final deployment, staging engines ran the same scripts under `engine-s<N>.rose-app.testnet`
with `--role staging`: each keeps the team's full-access key, unlike the final engines. Their runs are
recorded transaction by transaction in `deployments/e2e/engine-s*.json` and replayed by test fixtures
(the sandbox replay of `engine-s1`, the demo manifest builder's `engine-s3` fixture). Once retired, each
had its code replaced by a no-op wasm and its free balance swept to `rose-app.testnet`.

| Engine | RoseVault | `vault/base` (MPC-derived signer) |
|---|---|---|
| `engine-s1.rose-app.testnet` | `0xc8db15e81bba899f375b20724553dbd3b446da0f` | `0x80ce2541602e7be22664f23931fe1118e86e1f09` |
| `engine-s2.rose-app.testnet` | `0x650691ee1f6e8c1a4fc3547351fd50de7b1ffb14` | `0xfe0a38fb2c5da2414d4570417488de4fd1a24af8` |
| `engine-s3.rose-app.testnet` | `0xc12a2896c37616a12284c44c41c2ce925910e44b` | `0x45dea02fe29f0b40884e9057b55a4ad4dee7c05e` |
| `engine-s4.rose-app.testnet` | `0x14c7f1f870ccb5569a01399013ceeeffc465e243` | `0x8a8b95399f00ba2aac6babdc56cf761b22ee3ad6` |
| `engine-s5.rose-app.testnet` | `0x62358c4f6fadb303f3a7d18ad34a1afcc1174d06` | `0x89caef524792109c4b6c8e6373bcf54d84acffc6` |

| Fact | Command | Result |
|---|---|---|
| Staging engine keeps its key; Test USDC is keyless | `curl -s https://rpc.testnet.near.org -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"view_access_key_list","finality":"final","account_id":"<account>"}}'` | `engine-s3.rose-app.testnet`: 1 key, `FullAccess` (block 276,166,938); `tusdc.rose-app.testnet`: `[]` (block 276,166,944) |

### Staging deployment 1: the run the sandbox replays (engine-s1)

`contracts/engine/tests/sandbox_staging.rs` replays the Base part of this run in a local sandbox (the
`register_base_deposit` with its real ForeignTx response, the CKD keys of rounds 0 and 1, the
`claim_base_tokens` digest and signature) from `contracts/engine/tests/vectors/sandbox/staging/`; every
MPC response of the run is stored as `mpc_responses` in `deployments/e2e/engine-s1.rose-app.testnet.json`
and `deployments/e2e/engine-s1.rose-app.testnet.solana.json`.

#### NEAR testnet

| Step | Transaction | Gas |
|---|---|---|
| Account created with 13 NEAR | [5M7Ni2My…](https://testnet.near.rocks/tx/5M7Ni2My7FKbEpBrUWB9bPtpAvCnHPbndA6s2vkzUqZU) | |
| Deploy + `new` (wasm 962,494 bytes, sha256 recorded in `deployments/testnet.json`) | [E6b48iN8…](https://testnet.near.rocks/tx/E6b48iN8nVx1XHRzh2VspPXAYepXkv5aAEfqDXvY5jRa) | 70.9 Tgas (first deployment) |
| `bootstrap` (three `derived_public_key` calls + callback) | [8U2uUEzZ…](https://testnet.near.rocks/tx/8U2uUEzZs8ebKhDj3wZuNraeFr885SiKrmGf3jXexEFz) | 24.1 Tgas |

#### Base stream deposit, Tender round, payout (`e2e-base-tender.sh`)

Holder `b1.rose-ckd-1793753433.testnet` (EVM holder = the deployer EOA), issuer `rose-app.testnet`, class `c5b14256b68d40d7825a58992ec16d7881ecd8e6bf988e6c83f2f51117b58bba` (CINDR, 18 decimals, KOL schedule).

| Step | Transaction | Gas | Note |
|---|---|---|---|
| `DemoStreamFaucet.mintPosition(Kol)` creates stream 84 | [0xca915151…](https://sepolia.basescan.org/tx/0xca915151f47603d8032699e33a29d44b198cf5a24b0bdc2a986770d9813d047a) | 302,947 | 20,000 CINDR, start 1791169008, end 1822705008, startUnlock 2,000, granularity 1 |
| `approve` + `depositStream(84, "b1.rose-ckd-1793753433.testnet")` | [0x80cc9049…](https://sepolia.basescan.org/tx/0x80cc90496275f0907e64f5c8082ad615453ff4413ce748c876f2bbc9d60895e2) | 222,558 | block 54,196,506, tx index 3, block-level `logIndex` 20; 3,479.54 CINDR vested were withdrawn to the holder first |
| `register_base_deposit` (real `verify_foreign_transaction`, `Log` at `Safe`, after the safe head passed the block) | [D6i2aCSE…](https://testnet.near.rocks/tx/D6i2aCSEK3Y5t3hiQYDdSrj7v38uihx6ii7bBQEyhYoB) | 18.6 Tgas | attested `payload_hash` `70336aed…9598` equal to the engine's recomputation; class created, 20,000e18 units minted (full allocation, checkpoint `f(timestamp)`), key `BaseLog` consumed |
| tUSDC `ft_transfer_call` (issuer 20, holder 2) | [3FuRrwCY…](https://testnet.near.rocks/tx/3FuRrwCY84DGj46bi73EWKmgp8HcThw6ahuY1vnXCVcb), [2e1erDSd…](https://testnet.near.rocks/tx/2e1erDSdhriRCmTYdpf4fWRqBN5NGjQQ5LVyxPvyViKN) | 7.6 Tgas | NEAR venue cash |
| Round 0: `create_tender` (budget 10 tUSDC, max 0.01 tUSDC per locked token) | [2KunbTYg…](https://testnet.near.rocks/tx/2KunbTYgyt1jya9X6jzSXmyD9u25w6A2Utsfu45Y6ypc) | 3.7 Tgas | escrow 10.03 tUSDC |
| Round 0: `place_ask` (1,000 CINDR at 0.005 tUSDC, sealed with the wasm build) | [8siTNLse…](https://testnet.near.rocks/tx/8siTNLse8hDfWA96zxxubAPiETkjrf5VoQs9qmKxS6zb) | 4.6 Tgas | bond 1 tUSDC |
| Round 0: `close` (real CKD) | [CZ2T4KGf…](https://testnet.near.rocks/tx/CZ2T4KGf9RzsjUR1VxLayfH51NR7dUUSykb6B6QYzyhm) | 37.3 Tgas | key `bls12381g1:76ge4d68…Gp9` stored by the callback, equal to the offline unwrap of the recorded `(big_y, big_c)` |
| Round 0: `clear` with the ask unopened (a script bug lost the ciphertext), `settle_bid` | [ESekGAKm…](https://testnet.near.rocks/tx/ESekGAKm2bkCjVdTmcyjTV1HX3ERYkmuhtHzPvS244uK), [5iz1ngr7…](https://testnet.near.rocks/tx/5iz1ngr7DUBEcd4pg3hchTE94f2hJm2X74jPFdshYVac) | 3.6, 5.2 Tgas | `Cancelled(NoCrossing)`; the unopened ask is void and its 1 tUSDC bond slashed, the 1,000 units unlocked, the issuer's 10.03 tUSDC escrow refunded: the no-crossing path exercised live |
| Round 1: `create_tender`, `place_ask` | [3Dm4cJn3…](https://testnet.near.rocks/tx/3Dm4cJn3tvQgkE8J4YN7JEGToXrjZtY2WLYqH13iC3Mf), [HAoS879U…](https://testnet.near.rocks/tx/HAoS879Uc7TjrBzrrGEqQD88Bb7cAwjm2XoPCDCPJaKW) | 3.7, 4.5 Tgas | same terms |
| Round 1: `close` (real CKD) | [DXA7PZRH…](https://testnet.near.rocks/tx/DXA7PZRHWeUtDFf1VHZ2rdyjKLA4J5FjiXHc7dEMzhvo) | 37.3 Tgas | key `bls12381g1:7a7AJSCy…Hh1f`, 8 blocks after the request |
| Round 1: `open_bid` by the issuer (third party) with the holder's `(plaintext, sigma)` decrypted off chain with the public key | [DioKGz7d…](https://testnet.near.rocks/tx/DioKGz7diMoQhe86KJKzNEEhxp33CXbFGZEaNZr71hKE) | 132.0 Tgas | fully verified opening: quantity 1,000e18, price 5,000 |
| Round 1: `clear` | [J2y5znVC…](https://testnet.near.rocks/tx/J2y5znVCqNVpFUMr3TRh8o9bc1LVMjsNE45ve1w4VWih) | 4.0 Tgas | price 5,000 per locked token, volume 1,000e18 units, notional 4,129,857 (per-unit price `5000 * (1 - f(ts))`), fee 12,390, issuer charged 4,129,857, refund 5,887,753 |
| Round 1: `settle_bid` | [8mBkK7rx…](https://testnet.near.rocks/tx/8mBkK7rxK8ncuLxMrXCdqPYUwDBqX1hXStbEWPxRQqpj) | 5.4 Tgas | holder paid 4.129857 tUSDC + bond back; 1,000 units retired to the Tender's lot |
| `claim_base_tokens(Holding, 1.102254566210002 CINDR, deployer EOA)` (real domain-0 `sign`) | [CsqsDdQR…](https://testnet.near.rocks/tx/CsqsDdQRNKyix3sizYjcMEgkE3VCthuRvTfGyCZyBaed) | 16.6 Tgas | digest `d7ed4be1…3b67`, signature r `3dbb3ffe…fed0`, s `0606f9c8…9836`, v 27 stored in payout 0 |
| Sablier `withdrawMax(84, vault)` by the claimant | [0xbe033d54…](https://sepolia.basescan.org/tx/0xbe033d54665c4af5809a2405832a2316e2186e9efe28e59d4abee4f872279080) | 102,530 | the vested balance moves to RoseVault |
| `RoseVault.executeTransfer(Transfer(CINDR, EOA, 1102254566210002000, 0), 27, r, s)` | [0x4e3741e8…](https://sepolia.basescan.org/tx/0x4e3741e8ffbe6555a8e8eab0bde502566f331c5d825f965d57d90db8211de7ab) | 68,853 | status 1, `isAuthorizationUsed(0) = true`, the MPC-signed authorization accepted by the immutable vault |

#### Solana stream deposit and payout (`e2e-solana-stream.mjs`)

Devnet test token: mint `3q81mxTA7rricmjJQaiZk9HbZzF2Pt8aN5SJaJcXvZ4w` (6 decimals, ops key as mint authority); holder key generated into `~/.config/rose/solana-holder.json`; NEAR account `b1.rose-ckd-1793753433.testnet`; `gas/sol` funded with 0.2 SOL ([PmVd8vPG…](https://explorer.solana.com/tx/PmVd8vPGUXvNhJoRtnSyA1a5pp1oQeNoCmqZiYmkS3VKUL46YefrGqv98QeyUAdF97vdfAfxtTMo6v9N2CDuN3a?cluster=devnet)). Total devnet spend about 0.3 SOL.

| Step | Transaction | Gas | Note |
|---|---|---|---|
| Streamflow stream `EhaUNf8fKGHdvWjRVsypT4tnmWaXMtpm9QpRety6tQXU` created (3,600 tokens, 60 per minute over an hour from 1793763759, no cliff, transferable by recipient only, no top-up, pause, rate update or automatic withdrawal) | [5jRXaJ2P…](https://explorer.solana.com/tx/5jRXaJ2PqLWuqjrRhvViPrk1ZrSpHYiEcSJaWzvDYEfxN3oEuHA4ggkd7WtgJBQLkvnbS65fQWTXYyczbfkTSErn?cluster=devnet) | | `@streamflow/stream` 13.4.0 |
| holder `transfer_recipient` to the deposit address `HB7JyaT9w7HzRGQaQ5aRhRdgYbSgCvWFYam1QjkGh2HC` (`dep/b1.rose-ckd-1793753433.testnet/a13aada1…2fa36`) | [3Ewu1h7g…](https://explorer.solana.com/tx/3Ewu1h7gcozC617kf5igUMzt6FkBGsfiHSaa7HPNPfmvwmVCiwSfjeZ9EMXDYBq9k5ioLrgrB88rP5CfnU1mZtDc?cluster=devnet) | | class id computed before the class existed (`compute_sol_class_id`) |
| `attribute_sol_deposit` (`derived_public_key` + real `AccountState` proof of the metadata and mint accounts at `Finalized`) | [B3GqeGyW…](https://testnet.near.rocks/tx/B3GqeGyWvVh3mwaCc5s8taeD4KfhSdHiYrsgARj5zheS) | 26.7 Tgas | stage `Attributed`; the first deposit of its class |
| `move_sol_deposit` (two joined `sign` on domain 1: deposit key and `gas/sol`) and broadcast | [HfkExkn8…](https://testnet.near.rocks/tx/HfkExkn8hCRt2Hj2kRXHJzDrwKAnZentdmGcfT3B5mnd), Solana [63ubPyCh…](https://explorer.solana.com/tx/63ubPyChP7Ri7hjqrVfepQGQwhsjbVu5Q6teHxzduiz3bfvhDobCEa2Sgoq13MDgK92BuZ5omvJvHjhzbvTerCmB?cluster=devnet) | 28.3 Tgas | fee 10,000 lamports paid by `gas/sol`, 24,097 CU; the stream's recipient is now the vault `77DPmxot…AHad` (an earlier move signed for the same stream, [DJmgAAsQ…](https://testnet.near.rocks/tx/DJmgAAsQ6bTYypAeubQUWRCEBiBS8U32MSYK73xbYLwh), was superseded by a second attribution and never broadcast) |
| `register_sol_deposit` (real `AccountState` proof of the metadata at the vault) | [GhFTEzaA…](https://testnet.near.rocks/tx/GhFTEzaAQrdvHBdoJ6idTZKGhtossEryPDEz7JG1DVS3) | 20.8 Tgas | position 1, 3,600,000,000 units minted, `engine_withdrawn` 0 |
| nonce account `GP2FeaDQ9oH2NAFXWc7jPKLP8iWGNLyWgwKqHvB5UTZZ` created by the claimant (authority = vault) | [2vUspHXz…](https://explorer.solana.com/tx/2vUspHXzAfmWMpYHJPfeTnsXB7U43mB2NXmYXukqM7Q9JVi2KSxaPLhjavPQDyN8D82npNZvrHxRXZVCWXM1ZrRw?cluster=devnet) | | rent 1,056,640 lamports; nonce value `J5XmxYRQ…hCWu` proven and consumed as the replay key |
| `claim_sol_tokens(Holding, 360 tokens, ops wallet, nonce proof)` (real `AccountState` proof of the nonce, two joined `sign`) and broadcast | [5vZt2Mkk…](https://testnet.near.rocks/tx/5vZt2MkkcyodLhyppLgyKvGRqRoFp9tW4UjiQMRxa6nW), Solana [5QM6Gd65…](https://explorer.solana.com/tx/5QM6Gd65UYU2qkiJqt2bVVSok71RCju7Pzj7QRoi3FN1w6ybPn4TyvewNwKZjwasGP3BWrCSndi9t3HhS72sd6qT?cluster=devnet) | 45.4 Tgas | the engine-built transaction: `AdvanceNonceAccount`, Streamflow `withdraw(360000000)`, `create_associated_token_account_idempotent`, `TransferChecked(360000000)`; 39,737 CU; recipient balance 6,400,000,000 to 6,760,000,000; stream `amount_withdrawn` 360,000,000 = `engine_withdrawn` |

### Staging deployment 3: proofs cited by the security model

`engine-s3` was first deployed with an earlier build (wasm `b79dd589…355e`, 1,008,149 bytes), then updated
in place with a later one (wasm sha256 `928d72ef1f8d34b38d0b045083e5c268f6cbcdd66f65b1ea0fb9137ba2e90e50`,
1,010,528 bytes, on-chain code hash `As5d5aiU2Fs7KPTjGhA9WKPRsjujYHUR3tn3REuuWQ3R` checked with `view_account`,
[C9jehnsZ…](https://testnet.near.rocks/tx/C9jehnsZ1RuoLd7ecdhkqTSx11RgPJC6WAcbhHFPWQ4s)): deleting and recreating an
account with large state is refused by the network ("Delete account whose state is large is temporarily
banned"). The later build adds two fields to the Solana payout record, so payout records 0 to 2 (written by
the first build) do not decode with it; every other record does.

Issuer Cindral Foundation (`cindral-foundation.rose-app.testnet`, Base treasury = deployer `0x7d47…2042`, Solana treasury = ops key `6uMy…gH7n`). Classes: Seed Round `0d06a458…f894` (Base, Sablier, `createStreams`: Halden Ventures 400,000 stream 90, Tessaro Capital 250,000 stream 91), KOL Round `c5b14256…8bba` (Base: Teodor Vance 60,000 stream 92 and Nadia Solvik 20,000 stream 93 by `createStreams`, Nadia Solvik's own DemoStreamFaucet stream 94 self-deposited with `depositStream`), Strategic Round `f91b52ce…1a42` (Solana, Streamflow: Ines Marlow position 4, Varick Partners position 5). Holder EVM payout addresses: Halden `0x7f62…9aD3`, Varick `0xace8…032F`, Nadia `0x9f1a…6049`.

| Proof | Result | Transactions |
|---|---|---|
| Tender (round 1, Seed Round, Base tUSDC venue, budget 1,500, max 0.04, declared reference 0.08) | sealed asks Halden 40,000 @ 0.030 and Tessaro 30,000 @ 0.036; clears at 0.036000 tUSDC per locked CINDR, 41,666.67 CINDR bought (Halden filled, Tessaro rationed to 1,666.67), issuer charged 1,500 tUSDC plus a 4.5 fee; equal to `@rose/sdk` `tender()` on the opened asks | close [AEmbLjSh…](https://testnet.near.rocks/tx/AEmbLjSh63d5u7G3fgGpcyfjYN6iUxhnkjfJYi9m6oMn), clear [8pNWktzo…](https://testnet.near.rocks/tx/8pNWktzoM4ZDe5oVVHUeKf7ijNkTkJitzXLUbpWAxg5p) |
| Exit on Solana positions (round 2, Strategic Round, NEAR tUSDC) | sealed asks Ines 60,000 @ 0.020, Varick 50,000 @ 0.026; bids Halden 70,000 @ 0.028, Tessaro 40,000 @ 0.022, Nadia malformed; clears at 0.027000, volume 70,000 (Halden filled, Ines filled, Varick rationed to 10,000, Tessaro unfilled), notional 1,890 tUSDC, fee 5.67; equal to `exit()` | close [2ZrRx5cx…](https://testnet.near.rocks/tx/2ZrRx5cx93GxHHxjZcM4H7oYdFcDQodd9bDkGBkzHp5T), clear [6QKNsWcC…](https://testnet.near.rocks/tx/6QKNsWcCSJnSDM3p8aqaQ8wTs5zVnKUhwjXMfWToU8gm) |
| Advance on a Base position (round 3, KOL Round, Teodor Vance encumbers 50,000 units, claim 3,000 CINDR, min fill 1,500, sealed reserve 0.035) | funders Varick 2,000 @ 0.045, Ines 2,000 @ 0.040; clears at 0.037500 per claimed token (midpoint of [0.035, 0.040]), Varick 2,000, Ines rationed to 1,000; lien 0 created; equal to `advance()` | close [99ivgchD…](https://testnet.near.rocks/tx/99ivgchDQarJnR6KuzCm6nFEDboTE9e2myfhoRmhnXkQ), clear [7WDuM2JP…](https://testnet.near.rocks/tx/7WDuM2JPpXuxFN9FrhxsJVjxq8Esst9psky3p77SsM2m) |
| Real CKD key release after close | `key_source` Callback for all three; key stored 4.1 s, 4.3 s and 6.2 s after `close` (37.4 Tgas each); each key equal to the offline unwrap of the MPC response (`big_y`, `big_c`) with `@rose/ibe-wasm` | close transactions above |
| Third-party openings | every well-formed order decrypted with the released key and opened by `rose-app.testnet` (132.1 to 132.2 Tgas each); every opened value equal to what the bidder sealed | 9 `open_bid` transactions, recorded in `deployments/e2e/engine-s3.rose-app.testnet.live.json` |
| Malformed bid unopenable and slashed | Nadia Solvik's bid (one byte of `V` flipped) fails decryption ("decryption failed"); her own true opening is refused on chain ("Opening does not match the ciphertext", 131.3 Tgas); `clear` marks it `Unopened`, `settle_bid` slashes its 1 tUSDC bond (`bond_refunded: false`) | [5cy62YfE…](https://testnet.near.rocks/tx/5cy62YfEpE4MioY1txbjGSGWWGAgqRNK2kzQZxSC4LEs) (refused), settle [3mMoWJc4…](https://testnet.near.rocks/tx/3mMoWJc42KYSES6Vx4wpBk8dXHgcifyZgweV8Wanjr9H) |
| `cancel_no_key` on the live engine | Exit round 4 created with `key_timeout` 60 s, one sealed bid (escrow 10 tUSDC), never closed; after `closes_at + key_timeout` `close` is refused ("Key timeout reached: the round can only be cancelled (cancel_no_key)"), `cancel_no_key` cancels it (reason `NoKey`, no key ever requested), `settle_bid` refunds escrow and bond (Halden's NEAR cash 64.34 tUSDC before the bid and after the refund) | create [2qYgQrj6…](https://testnet.near.rocks/tx/2qYgQrj6qQmZAa2cWwaJNmzwPW2vamBHV72JQk6XETAi), refused close [DCb8yQt5…](https://testnet.near.rocks/tx/DCb8yQt5CsnNdUh7VDJzL9n7SUR3qxxbx8vqg5cdMnHF), cancel [4CszxtfB…](https://testnet.near.rocks/tx/4CszxtfbVfadaWgWZv7tF1eUt2NYbXVw16hQi3tNazk7), refund [A1LojEZZ…](https://testnet.near.rocks/tx/A1LojEZZ4YuXY6RdTFvHv4qEsjd3RYFsEZcPcQg8h1zW) |
| NEAR USDC payout | Ines Marlow `withdraw_near_cash` 1,732.3875 tUSDC (Exit proceeds 1,620 + refunded bond and Advance escrow); her `tusdc.rose-app.testnet` balance 0 to 1,732,387,500 | [AGEXJZc7…](https://testnet.near.rocks/tx/AGEXJZc7f4DCnDf1buEzgja8UUBkhNRYoDgg2yYdpuj7) |
| Base USDC payout | Halden Ventures `withdraw_base_cash` 1,460 tUSDC (Tender proceeds 1,440 + bond 16 + 4 unused), payout 12 signed by the MPC, `executeTransfer` to `0x7f62…9aD3` (balance 0 to 1,460,000,000) | [HE2H2wpB…](https://testnet.near.rocks/tx/HE2H2wpBjwJpG9Lz85NWfhU7XA9ANLNhwmomeWT9eJ9A), [0x3e6fa1d8…](https://sepolia.basescan.org/tx/0x3e6fa1d87de796b5577535866ddaff4b94051f03bac9daaf646fff253eba1949) |
| Advance repayment from unlocks (Base tokens) | `withdrawMax(92, RoseVault)`, then Varick Partners `claim_base_tokens({LienShare: 0})` of 0.3149 CINDR (lien delivered 0.4723 of 3,000 CINDR at that time; Varick holds 2/3 of the claim), payout 13, `executeTransfer` of CINDR to `0xace8…032F` | [0x381ab970…](https://sepolia.basescan.org/tx/0x381ab97017540a09710faf1961f293ac097d49cee731e4dc452d53651a02ec60), [6hgSgqMU…](https://testnet.near.rocks/tx/6hgSgqMU7RGqYWutEkLhFNqMYv8jjoAZXbwny28MtQcH), [0x407e89d5…](https://sepolia.basescan.org/tx/0x407e89d5c60b9257d64c2fd47a9ce1ccf56716f1c396636416b9a6e660cb46c8) |
| Base in-kind redeem | Nadia Solvik `redeem(position 11)` burns 20,000 units, payout 14 signed, `executeRelease` returns stream 94 to `0x9f1a…6049` (`ownerOf(94)` checked), position `Released` | [BYxzmETK…](https://testnet.near.rocks/tx/BYxzmETKB4HS6JCVUfLdksFifurtK8QVK5VrydomiNry), [0x51b430b2…](https://sepolia.basescan.org/tx/0x51b430b29e8a9c965920c0a868bf6864292658bf70d8ad5f32e4dfce5343a744) |

Gas measured live (Tgas): `open_bid` 132.1 to 132.2, refused malformed opening 131.3, `close` with CKD 37.4 to 37.5, `attribute_sol_deposit` 26.6 to 26.9, `move_sol_deposit` 29.0, `register_sol_deposit` 21.7 to 22.0, `register_base_deposit` 18.9 to 19.1, `claim_base_tokens` 17.4, `redeem` (Base) 18.8, `withdraw_base_cash` 16.8, `register_base_cash` 16.4, `withdraw_near_cash` 8.8, `settle_bid` 5.1 to 5.9, `clear` 4.3 to 5.1, `place_ask` / `place_bid` 4.3 to 4.7, `create_tender` / `create_exit` / `create_advance` 3.5 to 4.0.

### Staging deployment 5: an ended stream synced from the app

`node scripts/e2e-solana-stream.mjs engine-s5.rose-app.testnet <step> --holder b1.rose-ckd-1793753433.testnet --case ended`. Stream `21FP57CG…c7Bq` of mint `7VHniAAW…UQFh`, 3,900 tokens, 60 per minute, `end_time` 1793814995 (65 minutes after its start, so attribution came about 64 minutes before the end, past the one-hour refusal). Steps `setup` to `register` exit 0 within `all`; the `all` run was then stopped on purpose during `wait-end` (exit 144, nothing in flight) so the app could make the sync; `wait-end` exit 0, then `sync`, `claim-swept`, `confirm` exit 0.

| Step | Transaction | Gas | Note |
|---|---|---|---|
| Stream created, `transfer_recipient` to the deposit address | [5VGqdaE6…](https://explorer.solana.com/tx/5VGqdaE691u7iFsKeYAryJABV7mmAuz3CQopfucu3zkaMsGL3YX6bUf1AyrscCPWQYonqTvPdcSFHwx5y1rGM5u6?cluster=devnet), [3PMZt2ay…](https://explorer.solana.com/tx/3PMZt2ayUXVYn523nbsbzSULbz1BDDhxXwVQybRgkRQau5xR3t7Q7No72HxaVv8BXzJvckoBF7W5MeBTMdJkd57g?cluster=devnet) | | |
| `attribute_sol_deposit`, `move_sol_deposit` + broadcast, `register_sol_deposit` | [A73shHiH…](https://testnet.near.rocks/tx/A73shHiHP8XLgcY54byKSv5yF9P322gj5CY8PZWjvMXH), [F1VsceuV…](https://testnet.near.rocks/tx/F1VsceuvoV3tGVjjypkgkwHD2MdqczUww6VJsZds1rns), [5YdRkjGc…](https://explorer.solana.com/tx/5YdRkjGcpU6XTwfo26hKBEra8hnEtTJrgTweTaBsVxGdizD28jALSbTpmx5HDxm4A1S8oLLZuEPAdKzaJGY9ECBM?cluster=devnet), [96RdsDN4…](https://testnet.near.rocks/tx/96RdsDN4jsSrovDgDanjTe9eeuPCL28TTgpB7JEDAc3h) | 26.9, 28.7, 21.3 Tgas | position 7 |
| A draw before the end, from the app: payout 9, 100 tokens | | | `engine_withdrawn` 100,000,000 |
| From `end_time - 300`: no draw | the app's portfolio at 17:52 UTC: the stream badge "No draws: ends soon", `get_sol_streams` withdrawable 0 | | |
| Streamflow's auto-claim, read at finality by `wait-end` | [3KHqQvJW…](https://explorer.solana.com/tx/3KHqQvJWv7CCiGExdgKNQaS7jEQKtuQfPYmm2DyheRFv77yNAJ6YHbwhm4njxL3mjE3SAv2519hfysivwiKaoeqz?cluster=devnet) | | memo "[10] Auto-Claim"; `amount_withdrawn` 3,900,000,000 of 3,900,000,000 |
| `sync_sol_stream` from the app's Sync button (account `b1`) | [3TAmMgNc…](https://testnet.near.rocks/tx/3TAmMgNcvBbyiU6ZXQwuCUGi17DRWXbe1C3tSedCpbfw) | | anchored on the auto-claim; `sol_stream_swept` (event seq 159, block 276229276) books 3,800,000,000; the stream is pruned; the script's `sync` step found the booking and recorded it |
| A swept-only claim from the app: payout 10, 500 tokens (draws `[]`, `swept` 500,000,000) | request [7JkB5rnh…](https://testnet.near.rocks/tx/7JkB5rnhdLfDWe42Ga9Lnso5HrLN1WKM3HQEts6ZG1bP), broadcast [2vWYSr98…](https://explorer.solana.com/tx/2vWYSr98pw85YDxdSvmkB2CT2dgYeQ2RxxPhx79VLZaLmPbUfNhgwPFTAy7U9z8SFyZev4sHW2bVqezBXUZRa1ox?cluster=devnet), confirm [Fu1WH6B1…](https://testnet.near.rocks/tx/Fu1WH6B1AfZs94N1t1MxTietcuMNWwkg4KvJq8CFZnaX) | | `Landed` |
| `claim-swept`: payout 11, 3,300 tokens from the swept balance alone (nonce `9sARC5Qv…qUwRE` and receipt `5LZnARr2…GHe` created in [VsdDjFte…](https://explorer.solana.com/tx/VsdDjFteNQtvGCo2W67Z3gKsYs9n2GKWPjJuNqoshuQ9boY4SwWDaonsVCv7U9Lb7b4mXfbv6LSyp8AFm8xn7V2?cluster=devnet)) | [E6xcrwU9…](https://testnet.near.rocks/tx/E6xcrwU9FzswnNGGse2oPerpvQPfcQjwy1Nv8izyygv8), [2ShT3TqZ…](https://explorer.solana.com/tx/2ShT3TqZKJvYF9xhVvkg8bBrTVrcUxP3wgmtb1QpQxBfHykftBHD5zAAz6iM36o3iz7psHUdPRFhRD4pSy5Xzzrd?cluster=devnet) | 43.3 Tgas | the stored payout has no draw and `swept` 3,300,000,000; `get_sol_swept` `pending` 3,300,000,000 while it is signed; recipient 0 to 3,300,000,000 |
| `confirm`: `confirm_sol_payout` on the receipt | [EhLjMXGH…](https://testnet.near.rocks/tx/EhLjMXGH8ogMmnpQuBzpHEhHnnxgCHZursmrpxCwQNJs) | 16.9 Tgas | payout 11 `Landed`; `get_sol_swept` balance 0, pending 0 |

## One-command live check and CI (2026-11-14)

`node scripts/verify.ts` (also `pnpm verify`) reads the live deployment and compares it with the values
the README states. These are the facts it relies on beyond those recorded above, each checked live.

| Fact | Command | Result |
|---|---|---|
| PublicNode serves Base Sepolia, as the verifier's second Base endpoint | `curl -s https://base-sepolia-rpc.publicnode.com -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'` | `0x14a34` (84532) |
| The RoseVault getters the verifier calls by raw `eth_call` | `cast sig 'SIGNER()'`, `cast sig 'LOCKUP()'` | `0x582abd12`, `0x845aef4b` |
| The MPC network derives engine-v2's Solana vault and fee payer | `call_function v1.signer-prod.testnet derived_public_key {"path":"vault/sol","predecessor":"engine-v2.rose-app.testnet","domain_id":1}`, then `"gas/sol"` | `ed25519:EqywuZpmf7i4ycvYqwzxEiDKTq94RifUSjH9pQX1SdWC` and `ed25519:HWx7jD36pAzB1Bo83bCvRYtnW5SHLcfdEZw4x4Zdn1Ng`, the `vault_sol` and `gas_sol` of `get_config` |
| engine-v2 names its source and build image (NEP-330) | `call_function engine-v2.rose-app.testnet contract_source_metadata {}` | commit `0524b3388f7bf512f39bf521e9af68736482ef9e`, image `sourcescan/cargo-near:0.22.0-rust-1.97.0@sha256:b193c8640a27172f83136a0f0aab2a9bf9d09f6ba0e6afd187addfaa9b92bae0` |
| `https://sepolia.base.org` and PublicNode both answer JSON-RPC batch requests | a two-call batch (`eth_chainId`, `eth_call`) to each | an array of two results from each |
| An absent account lists no access key either, so a keyless check alone proves nothing about it | `view_access_key_list` on `this-account-does-not-exist-zzzq.rose-app.testnet` at dRPC and FastNEAR | `"keys":[]` from both; the verifier therefore also reads `view_account` and requires the recorded code hash (engine `gC11tnmCzFJ6Bi2BjkQ6Y38Ff5Vttr2J2tKzNTiiuhK`, tUSDC `7JHPYMQ1o7QVhVyMwmzzxS3vVhyqEkcWQrGJUcmubizP`), and exits 1 when the account does not exist |
| The verifier runs with nothing installed | a fresh `git clone`, then `node scripts/verify.ts` on Node 22.18.0 and 22.20.0, and `pnpm verify` on pnpm 10.34.9 | 10 of 10 checks passed in about 1.5 s, no `node_modules` created; with each expected value deliberately wrong, or the endpoints unreachable, it exits 1 with a FAIL line |
| CI runs the same gate as Getting started | `.github/workflows/ci.yml` on the pull request (#8) and on `main` | runs 43621698154, 43622060603 and 43622328139: success; cargo 280, forge 140, scripts 30 tests passed in the logs |
