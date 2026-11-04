# Verification log

Every external fact rose relies on (address, version, method name, byte layout, gas) is verified live and recorded here with the command used and the result. Dates are UTC. RPC endpoints: NEAR testnet `https://test.rpc.fastnear.com`, Base Sepolia `https://sepolia.base.org`, Solana devnet `https://api.devnet.solana.com`.

NEAR transaction hashes link to `https://testnet.near.rocks/tx/<hash>` (see "Explorers" at the end for why), Base hashes to `https://sepolia.basescan.org/tx/<hash>`, Solana signatures to `https://explorer.solana.com/tx/<sig>?cluster=devnet`. Spike accounts and contracts are throwaway and live outside the repo (scratchpad); only the facts are kept here.

A helper used below for NEAR view calls:

```bash
view() { curl -s https://test.rpc.fastnear.com -H 'content-type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"call_function\",\"finality\":\"final\",\"account_id\":\"$1\",\"method_name\":\"$2\",\"args_base64\":\"$(printf '%s' "${3:-{\}}" | base64)\"}}" \
  | python3 -c 'import json,sys;print(bytes(json.load(sys.stdin)["result"]["result"]).decode())'; }
```

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
| CKD hash-to-curve | `crates/contract/src/primitives/ckd.rs`; confirmed by live key verification | `H = hash_to_curve_G1(compressed_mpk(96) || app_id)`, DST `NEAR BLS12381G1_XMD:SHA-256_SSWU_RO_` |
| CKD response format | receipts of the CKD transactions below | `{"big_y":"bls12381g1:...","big_c":"bls12381g1:..."}`, key = `C - a * Y` |
| `sign` response formats | `crates/near-mpc-crypto-types/src/primitives.rs`, live callbacks | `{"scheme":"Secp256k1","big_r":{"affine_point":"<33B hex>"},"s":{"scalar":"<32B hex>"},"recovery_id":0\|1}` and `{"scheme":"Ed25519","signature":[64 numbers]}`; both deserialize with `#[callback_result]` in near-sdk 5.30 |
| near-sdk 5.30 BLS host functions | `~/.cargo/registry/src/*/near-sdk-5.30.0/src/environment/env.rs` lines 1036-1165 | every `env::bls12381_*` returns `Option`; `bls12381_p1/p2_decompress` do not check subgroup membership (NEP-488), `multiexp` and `pairing_check` do |
| Toolchain | `cargo test` with rustc 1.91.1: `near-sdk@5.30.0 requires rustc 1.95` | Rust 1.95.0 pinned in `rust-toolchain.toml`; cargo-near 0.22.0, near-cli-rs 0.30.1 |

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

## Demo identity: no collision with a real project

The demo issuer is the fictional **Cindral Foundation**, token **Cindral (CINDR)** (spec section 9).

| Check | Command | Result (2026-11-04) |
|---|---|---|
| CoinGecko | `curl "https://api.coingecko.com/api/v3/search?query=cindral"`, `curl https://api.coingecko.com/api/v3/coins/list` (22,750 coins) searched for `cindral` and `cindr` | no coin named Cindral, no ticker CINDR |
| CoinMarketCap | public coin map (10,500 coins) and currency slug pages | no match |
| DefiLlama | `curl https://api.llama.fi/protocols` (8,926 protocols) | no match |
| Web | searches `"Cindral" crypto`, `"CINDR" token` | no result |
| Nearest names | same sources | Cindrum (CIND, inactive), Cindicator (CND): neither name nor ticker shared. Rejected tickers: CNDL (DefiLlama "Candle"), CNDR (Solana "Condor"), CIND (Cindrum) |

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

## Explorers

| Explorer | Command | Result (2026-11-04) |
|---|---|---|
| NearBlocks testnet | `curl https://api-testnet.nearblocks.io/v1/blocks/latest?limit=1`; `/v1/txns/<hash>`; `curl -I https://testnet.nearblocks.io` | frozen: latest indexed block 270,420,307 (2026-09-27) while the RPC head is above 276,120,000; `{"txns":[]}` for every spike transaction; the site serves a Cloudflare challenge (403 to curl and headless Chromium) |
| `explorer.testnet.near.org/transactions/<hash>` | `curl -s -o /dev/null -w '%{http_code}'` | 200, but only an "Explorer Selector" page (offers Near Rocks, Near Validate, NearBlocks); near-cli-rs prints these links |
| `https://testnet.near.rocks/tx/<hash>` (FastNear) | `curl -s -o page.html -w '%{http_code} %{size_download}' -A 'Mozilla/5.0' https://testnet.near.rocks/tx/Dm5hBXUzRLGXd7XPfWQ7cJkgaV5MTQnttTZQACYBa8Pd` and the same for `8Pg3zu3R…yogf` | `200 1126` in 0.1 s (client-rendered shell, title "NEAR Rocks - NEAR explorer by FastNear"); in a browser it showed the IBE spike transactions within a minute (signer, 124.32 Tgas, 0.01241 NEAR burnt). **Primary explorer** (same provider as the app's RPC) |
| `https://nearvalidate.org/txns/<hash>?network=testnet` | same `curl` for both hashes | `200 32613` in 0.1 s (client-rendered, title "Near Transaction \| Near Validate", "Built by NearBlocks", RPC based); in a browser it showed `8Pg3zu…yogf` with block 276,123,296 and the receipt tree. **Fallback** |
| Base Sepolia | `https://sepolia.basescan.org/tx/<hash>` | live in a browser (every Base link above); 403 to plain curl (bot protection) |
| Solana devnet | `https://explorer.solana.com/tx/<sig>?cluster=devnet` | live in a browser (every Solana link above); 429 to plain curl |
