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
