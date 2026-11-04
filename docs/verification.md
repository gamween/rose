# Verification log

Every external fact rose relies on (address, version, method name, byte layout, gas) is verified live and recorded here with the command used and the result. Dates are UTC. RPC endpoints: NEAR testnet `https://test.rpc.fastnear.com`, Base Sepolia `https://sepolia.base.org`, Solana devnet `https://api.devnet.solana.com`.

A helper used below for NEAR view calls:

```bash
view() { curl -s https://test.rpc.fastnear.com -H 'content-type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"call_function\",\"finality\":\"final\",\"account_id\":\"$1\",\"method_name\":\"$2\",\"args_base64\":\"$(printf '%s' "${3:-{\}}" | base64)\"}}" \
  | python3 -c 'import json,sys;print(bytes(json.load(sys.stdin)["result"]["result"]).decode())'; }
```

## NEAR MPC network

| Fact | Command | Result (2026-11-04) |
|---|---|---|
| MPC contract version | `view v1.signer-prod.testnet version` | `"3.18.0"` |
| Domains | `view v1.signer-prod.testnet state` | 0: Sign, CaitSith (secp256k1); 1: Sign, Frost (Ed25519); 2: ConfidentialKeyDerivation (BLS12-381); 3: ForeignTx, CaitSith (secp256k1); threshold 11 |
| CKD master public key (domain 2) | same | `bls12381g2:xeYho48G2Sr9oJz4gw9sLGZGspeeKpHZvMDAwWvoNTRnVMFJH96GxX98TT2MRhTtsot1wcGR1Ti2Xh8PCsbYJ2enbLNdJXDvTYSK8aTE3nJ5NZXU7Kt1F6mFtReWs5pR4kj` |
| Foreign chains served | `view v1.signer-prod.testnet get_available_foreign_chains` | `["Solana","Base","Bnb","Arbitrum","Abstract","Starknet","Polygon","HyperEvm","Aptos","Sui","Avalanche","Fogo"]` |
| Request deposit and gas | `near/mpc` tag `3.18.0`, `crates/contract/README.md` | `sign`, `request_app_private_key`, `verify_foreign_transaction` need at least 1 yoctoNEAR and 10 Tgas; excess deposit refunded |

## Cash tokens

| Fact | Command | Result (2026-11-04) |
|---|---|---|
| Circle USDC on NEAR testnet | Circle docs (developers.circle.com/stablecoins/usdc-contract-addresses), then `view 3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af ft_metadata` | Exists (`USDC`, NEP-141) but is minted only through Circle's captcha-gated faucet, so the NEAR cash venue is rose tUSDC (spec 7.3) |
| Circle USDC on Solana devnet | same Circle page | `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` |

## Test funds

| Fact | Command | Result (2026-11-04) |
|---|---|---|
| NEAR testnet faucet | `near account create-account sponsor-by-faucet-service rose-app.testnet autogenerate-new-keypair save-to-legacy-keychain network-config testnet create` | Account created with 10 NEAR, tx `66SvxXgw18sEvLMuNWDgFGqFcXJDDGXqutuNQFz6eUC4` |
| Solana devnet RPC airdrop | `curl https://api.devnet.solana.com -d '{"jsonrpc":"2.0","id":1,"method":"requestAirdrop","params":["<pubkey>",500000000]}'` | HTTP 410: "The RPC faucet is closed on this cluster. Request test SOL at https://faucet.solana.com" |
| Solana devnet PoW faucets | `devnet-pow get-all-faucets` (devnet-pow 0.1.4) | 24 faucets listed, none with a usable balance; `devnet-pow mine` also needs fee-payer SOL and its bootstrap airdrop fails |

## Deployed: rose tUSDC on NEAR testnet

| Fact | Command | Result (2026-11-04) |
|---|---|---|
| Account created | `near account create-account fund-myself tusdc.rose-app.testnet '3 NEAR' ... sign-as rose-app.testnet` | tx `98iY6msST3gE9CN1keAAF2wbYqp9AyzXgnH1R5Uxxn8b` |
| Code deployed and initialized | `near contract deploy tusdc.rose-app.testnet use-file target/near/rose_tusdc/rose_tusdc.wasm with-init-call new json-args '{}'` (wasm SHA-256 bs58 `7JHPYMQ1o7QVhVyMwmzzxS3vVhyqEkcWQrGJUcmubizP`, 160,452 bytes) | tx `CekG17rCG6MQ1djNH4pnbHaFj3EoXLq8b6hApCwXVsUN` |
| Public mint works | `near contract call-function as-transaction tusdc.rose-app.testnet mint json-args '{"amount":"1000000000"}' attached-deposit '0.00125 NEAR' sign-as rose-app.testnet` | `ft_mint` event, tx `EUZEU5RvkvFfs6D4czq6uqAzBytLD49yy4cL61KDsLZB` |
| Keyless | `near account delete-keys tusdc.rose-app.testnet ...` (tx `EjiBFUNB8CmiY8qTERPvaqYc8jFkBds51iTSAGShq1MG`), then `view_access_key_list` | `[]` |

## Base Sepolia: Sablier Lockup v4

| Fact | Command | Result (2026-11-04) |
|---|---|---|
| Chain id | `cast chain-id --rpc-url https://sepolia.base.org` | `84532` |
| Lockup deployment is v4.0 | `gh search code "0xA65A1ecEf02C2B9BDc604951c6A6D02335D4532e"` | `sablier-labs/sdk` `src/evm/releases/lockup/v4.0/deployments.ts`: `SABLIER_LOCKUP` on Base Sepolia, deployed at block 38,985,887 |
| Source tag | `gh api repos/sablier-labs/lockup/releases`, `gh api repos/sablier-labs/lockup/compare/lockup@v4.0.0...lockup@v4.0.1` | `lockup@v4.0.1`, no change under `lockup/src` from v4.0.0 |
| Identity | `cast call 0xA65A1ecEf02C2B9BDc604951c6A6D02335D4532e "name()(string)"` | `"Sablier Lockup NFT"`, symbol `SAB-LOCKUP` |
| Comptroller | `cast call 0xA65A…532e "comptroller()(address)"` | `0x0000008ABbFf7a84a2fE09f9A9b74D3BC2072399` |
| Selectors used by rose exist | `cast code 0xA65A…532e`, grep `63<selector>` | present: `getLockupModel`, `isCancelable`, `isTransferable`, `getDepositedAmount`, `getWithdrawnAmount`, `getRefundedAmount`, `getStartTime`, `getCliffTime`, `getEndTime`, `getGranularity`, `getUnderlyingToken`, `getUnlockAmounts`, `withdrawableAmountOf`, `calculateMinFeeWei`, `withdrawMax`, `createWithTimestampsLL` (v4, `0x253c6162`), `wasCanceled`, `isDepleted`, `ownerOf`; absent: v3 `createWithTimestampsLL` `0x74d213e5` |
| Lockup withdrawal fee | `cast call 0x0000008ABbFf7a84a2fE09f9A9b74D3BC2072399 "calculateMinFeeWeiFor(uint8,address)(uint256)" 2 <sender>` | `0` today; admin-controlled and oracle-based, so RoseVault forwards `calculateMinFeeWei` read in the same transaction and refunds the rest |
| LL granularity | `lockup@v4.0.1` `SablierLockup.sol` | streamed = `unlockSum + floor((t - from) / g) * g * streamable / (end - from)`, `from` = cliff or start; g = 0 is stored as 1 |
| `withdraw` of zero reverts | same source | `SablierLockup_WithdrawAmountZero`, so RoseVault skips the call when nothing is withdrawable |
| ForeignTx `Log` extractor matches the block-level `logIndex` | `near/mpc` 3.18.0 `crates/foreign-chain-inspector/src/evm/inspector.rs:221-227` | `logs.iter().find(\|log\| log.log_index == target_index)` on the receipt logs |

## Base Sepolia: RoseVault spike (prototype, signer = spike key)

Spike EOA `0xFa76B8f304d2A87FCAee0c258A76118368d0d671`; prototype vault `0x3985dDBBE8477Dd42bd5E19F8726Aae7a339b5e0`. Production contracts are redeployed with the engine's MPC-derived signer.

| Step | Transaction | Gas | Note |
|---|---|---|---|
| `depositStream(82)`, nothing withdrawable (cliff in the future) | [0xcddf41ac…](https://sepolia.basescan.org/tx/0xcddf41ac9ba8c7b1a9053bc52e62c0edb4bbd4ab55752d817042aae34a35eeb2) | 146,130 | `StreamDeposited` at block-level log index 2 |
| `depositStream(83)`, partly vested: 3,479.49 tokens withdrawn to the holder first | [0x6afca0fb…](https://sepolia.basescan.org/tx/0x6afca0fb97bb7f5898ab948d780858457ae07a55d22fadd293231089e35abafc) | 193,137 | `StreamDeposited` at log index 10 |
| `depositCash(tUSDC, 500e6, "rose-app.testnet", 1)` | [0x81a6dfc3…](https://sepolia.basescan.org/tx/0x81a6dfc3d749274b8710e21f1c2d17624076c5044c1e25e165e3d9e0b3497c65) | 65,285 | `CashDeposited` |
| `attest(82)` | [0x818841eb…](https://sepolia.basescan.org/tx/0x818841eb035a1043de1e5c7521d5fd8ba1e716698e7103a6786ef8e2b273b20e) | 82,588 | `StreamAttested` |
| `executeRelease(83)`: withdraws the vested balance to the vault, then transfers the NFT | [0x7ae5303a…](https://sepolia.basescan.org/tx/0x7ae5303a8bf4711e32040a008d4ac8078bd34ffdc9c6a3c995719e0eca30d001) | 202,229 | EIP-712 signature in MPC format (v = 27 + recovery id, low s) |
| `executeTransfer` of the withdrawn tokens | [0xca28787e…](https://sepolia.basescan.org/tx/0xca28787ed96ee18184a901dc9bf455e160884a81f78eecaafbba4355133f0a1b) | 46,787 | replay bit 2 set |

EIP-712 known-answer vectors (viem 2.21.54 `hashTypedData`, chain 84532, verifyingContract `0x00000000000000000000000000000000000A11cE`), asserted in `test_digests_knownAnswerVectors`: `Transfer(0x036CbD53842c5426634e7929541eC2318f3dCF7e, 0x…b0b0, 1000000, 7)` → `0x652ed7c219938bcc420b0786454c4e4a58b5baeed9dd1cfdf3ba8c4b1e08ac01`; `Release(0xA65A…532e, 81, 0x…b0b0, 8)` → `0x87ab8e82a059a262d10be8885c9b5993c14f8bbe9ba38e33cc96179b5f5ee308`.

`StreamDeposited` data layout (rebuilt byte by byte by the engine): topics `[keccak256("StreamDeposited(address,string,address,uint256,address,uint128,uint128,uint40,uint40,uint40,uint40,uint128,uint128,bool,bool,uint40)") = 0xbc9f6be2…8340, sender, streamId]`; data words: offset of `nearAccount` (0x1c0), lockup, token, deposited, withdrawn, start, cliff, end, granularity, startUnlock, cliffUnlock, cancelable, transferable, timestamp, then the string length and bytes padded to 32.

## NEAR MPC `sign` (domains 0 and 1), measured from a contract

Spike contract `c.rose-sign-1793752785.testnet` (throwaway, outside the repo). Hashes checked with RPC `EXPERIMENTAL_tx_status`.

| Fact | Evidence | Result (2026-11-04) |
|---|---|---|
| `sign` gas floor | `view v1.signer-prod.testnet config`; call with 14 Tgas, tx `AJowwtnxEwTxSmeZLjswrPjjMA7fy98HPYNqe31CWRfH` | `sign_call_gas_attachment_requirement_tera_gas: 15` (README says 10); 14 Tgas panics `Provided gas is lower than required` |
| ECDSA payload bound | payload n+1, tx `AzXGcUjGgaj2EcuMVqE7ywC2W9tizaRwUXb4L35GLqxe`; `crates/contract/src/api/sign.rs:47-50` at 3.18.0 | Must be below the group order n (README says field size p): `Ecdsa payload cannot be converted to Scalar` |
| Domain 0 signature recovers to the derived address | tx `57TzcvbHbkBrZioL6Dg2jLnTxGGbYEYBY7oACbXv87MT`, Foundry `ecrecover`, `cast wallet verify` | EIP-712 digest signed for path `vault/base` recovers to `0x556e29bce7c6ab74a8B36b3c754D3Ac2842223b5` = address of `derived_public_key("vault/base", c.rose-sign-1793752785.testnet, 0)`; mapping r = big_R.x, v = 27 + recovery_id |
| Low s | 10 live signatures | all low-s; recovery_id does not follow big_R parity, so v is always taken from recovery_id |
| Domain 0 cost and latency | 10 transactions | about 12.7 Tgas burnt; 21 Tgas prepaid works, 20 fails; median 4.87 s (3.73 to 6.04 s) |
| Two `sign` promises joined (domain 1, paths `vault/sol` and `gas/sol`) | tx `DiXxwbXDzWJg8g1tqsKi394foDAQWqHwSkFvyBMXSYN6` | about 22.8 Tgas burnt, 38 Tgas prepaid works; 4.3 to 4.9 s |
| Refund only on `PromiseError` | txs `BToSjfQNBoj5Nev73VpGJvpJTWvTvSQAUhWPKgEKmqaf`, `AJowwtnxEwTxSmeZLjswrPjjMA7fy98HPYNqe31CWRfH` | the callback receives `PromiseError` about 1.2 s after a failed request |
| Durable-nonce payout signed by the MPC and broadcast | NEAR tx `2EnjBoZADxx2GoBng8XHRq4LDbagHjKwB1exhasZtgxH`; Solana [4CrVjw75…](https://explorer.solana.com/tx/4CrVjw75paRmX7Uopaoeyfv1D83oLKpyJBLM6AbNziMkuPGQ4ykxgUBGT3TZ8vxZeajR7XqsAvnEMtutNBuTL9Wy?cluster=devnet) | landed 534 slots after the nonce value was read; fee payer = `gas/sol`; replay rejected (`BlockhashNotFound`) |
| Solana legacy message serialization | Rust builder vs web3.js 1.98.4 `TransactionMessage.compileToLegacyMessage()` on 5 messages | byte-for-byte identical |
| ATA derivation inside a NEAR contract | txs `5WJAQJh3tTvc6zWogCbc6KKe7WERsN1LxgPXuittNGHt`, `4reqx9ehTvunZohW4kWV7xCKcNAMGi82gjxDXcv13jDm` | 0.35 to 0.85 Tgas, results equal spl-token |
| Durable nonce account rent on devnet | `getMinimumBalanceForRentExemption(80)` | 1,056,640 lamports |
| Streamflow `withdraw` / `transfer_recipient` encodings | `@streamflow/stream` 13.4.0 (commit `fb236fff`), `streamflow-sdk` 0.15.0 (commit `63df7d7b`, `programs/streamflow-sdk/src/lib.rs` lines 804-846 and 902-928) | Rust encoders equal the js-sdk bytes; treasury `5SEpbdjFK5FxwTvfsGMXVQTD2v4M2c5tyRTxhdsPkgDw` |
| NEAR testnet explorers | NearBlocks API `/v1/blocks/latest`; `explorer.testnet.near.org` | NearBlocks testnet frozen at block 270,420,307 (RPC head 276.1M); `explorer.testnet.near.org` serves an explorer selector page. Live explorer still to confirm in a browser |

## Demo identity: no collision with a real project

The demo issuer is the fictional **Cindral Foundation**, token **Cindral (CINDR)** (spec section 9).

| Check | Command | Result (2026-11-04) |
|---|---|---|
| CoinGecko | `curl "https://api.coingecko.com/api/v3/search?query=cindral"`, `curl https://api.coingecko.com/api/v3/coins/list` (22,750 coins) searched for `cindral` and `cindr` | no coin named Cindral, no ticker CINDR |
| CoinMarketCap | public coin map (10,500 coins) and currency slug pages | no match |
| DefiLlama | `curl https://api.llama.fi/protocols` (8,926 protocols) | no match |
| Web | searches `"Cindral" crypto`, `"CINDR" token` | no result |
| Nearest names | same sources | Cindrum (CIND, inactive), Cindicator (CND): neither name nor ticker shared. Rejected tickers: CNDL (DefiLlama "Candle"), CNDR (Solana "Condor"), CIND (Cindrum) |
