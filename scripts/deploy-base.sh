#!/usr/bin/env bash
# Deploys rose's Base Sepolia contracts for one engine account: TestUSDC, DemoToken ("Cindral",
# "CINDR"), DemoStreamFaucet (DeployDemoAssets.s.sol) and RoseVault (DeployRoseVault.s.sol) with
# ROSE_VAULT_SIGNER = the engine's MPC-derived vault/base address. The vault is immutable, so the
# script refuses to broadcast unless the signer it is about to use equals what
# scripts/derive-vault-signer.sh computes for the engine account.
#
# Usage: scripts/deploy-base.sh --engine <engine account> [--role staging|final]
#                               [--signer <0x address>] [--demo-assets-from <engine account>]
# --demo-assets-from reuses the TestUSDC, DemoToken and DemoStreamFaucet recorded for another
# engine (they do not depend on the engine) and deploys only the RoseVault.
# Keys: EVM_DEPLOYER_PRIVATE_KEY from ~/.config/rose/evm-deployer.env (never printed).
# Output: deployments/testnet.json (addresses, tx hashes, block numbers) and the web app's
# NEXT_PUBLIC_* snippet in deployments/<engine account>.env.

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_tools forge cast jq curl python3

engine="" role="staging" signer="" demo_assets_from=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --engine) engine="$2"; shift 2 ;;
    --role) role="$2"; shift 2 ;;
    --signer) signer="$2"; shift 2 ;;
    --demo-assets-from) demo_assets_from="$2"; shift 2 ;;
    *) die "unknown argument $1" ;;
  esac
done
[[ -n "$engine" ]] || die "usage: $0 --engine <engine account> [--role staging|final] [--signer 0x...]"
[[ "$role" == "staging" || "$role" == "final" ]] || die "--role must be staging or final"

load_env evm-deployer
[[ -n "${EVM_DEPLOYER_PRIVATE_KEY:-}" ]] || die "EVM_DEPLOYER_PRIVATE_KEY is not set in evm-deployer.env"
deployer="$(cast wallet address --private-key "$EVM_DEPLOYER_PRIVATE_KEY")"

chain_id="$(cast chain-id --rpc-url "$BASE_RPC_URL")"
[[ "$chain_id" == "$BASE_CHAIN_ID" ]] || die "RPC $BASE_RPC_URL is chain $chain_id, not Base Sepolia ($BASE_CHAIN_ID)"

derived="$("$ROSE_ROOT/scripts/derive-vault-signer.sh" "$engine")"
if [[ -z "$signer" ]]; then
  signer="$derived"
fi
signer="$(tr '[:upper:]' '[:lower:]' <<<"$signer")"
if [[ "$signer" != "$derived" ]]; then
  die "refusing to broadcast: signer $signer is not the derived vault/base address $derived of $engine"
fi

balance="$(cast balance --rpc-url "$BASE_RPC_URL" "$deployer" --ether)"
log "deployer $deployer, balance $balance ETH, engine $engine ($role), RoseVault signer $signer"

cd "$ROSE_ROOT"

# forge_run <script name> <env assignments...>: broadcasts the script and prints the run file.
forge_run() {
  local script="$1"; shift
  env "$@" forge script "contracts/evm/script/$script.s.sol" --rpc-url "$BASE_RPC_URL" --broadcast \
    --private-key "$EVM_DEPLOYER_PRIVATE_KEY" >&2
  printf '%s\n' "$ROSE_ROOT/broadcast/$script.s.sol/$BASE_CHAIN_ID/run-latest.json"
}

# record_contract <engine> <key> <contract name> <run file>: stores address, tx hash and block.
record_contract() {
  local key="$2" name="$3" run="$4" tx hash block address
  tx="$(jq -c --arg name "$name" '[.transactions[] | select(.transactionType == "CREATE" and .contractName == $name)][0]' "$run")"
  [[ "$tx" != "null" ]] || die "no CREATE transaction of $name in $run"
  hash="$(jq -r '.hash' <<<"$tx")"
  address="$(jq -r '.contractAddress | ascii_downcase' <<<"$tx")"
  block="$(jq -r --arg hash "$hash" '[.receipts[] | select(.transactionHash == $hash)][0].blockNumber' "$run")"
  block="$(cast to-dec "$block")"
  deployments_set "$1" ".base.$key" "$(jq -cn --arg a "$address" --arg h "$hash" --argjson b "$block" --arg n "$name" \
    '{contract:$n,address:$a,tx:$h,block:$b}')"
  log "$name at $address (tx $BASE_EXPLORER_TX/$hash, block $block)"
}

deployments_set "$engine" ".role" "\"$role\""
deployments_set "$engine" ".base.chain_id" "$BASE_CHAIN_ID"
deployments_set "$engine" ".base.deployer" "\"$(tr '[:upper:]' '[:lower:]' <<<"$deployer")\""
deployments_set "$engine" ".base.sablier_lockup" "\"$SABLIER_LOCKUP\""

if [[ -n "$demo_assets_from" ]]; then
  for key in test_usdc demo_token demo_stream_faucet; do
    record="$(deployments_get "$demo_assets_from" ".base.$key")" || die "no $key recorded for $demo_assets_from"
    [[ "$(jq -r '.address // empty' <<<"$record")" =~ ^0x[0-9a-f]{40}$ ]] || die "no $key recorded for $demo_assets_from"
    deployments_set "$engine" ".base.$key" "$(jq -c . <<<"$record")"
    log "reusing $key of $demo_assets_from at $(jq -r .address <<<"$record")"
  done
else
  run="$(forge_run DeployDemoAssets DEMO_TOKEN_NAME=Cindral DEMO_TOKEN_SYMBOL=CINDR)"
  record_contract "$engine" test_usdc TestUSDC "$run"
  record_contract "$engine" demo_token DemoToken "$run"
  record_contract "$engine" demo_stream_faucet DemoStreamFaucet "$run"
fi

run="$(forge_run DeployRoseVault ROSE_VAULT_SIGNER="$signer")"
record_contract "$engine" rose_vault RoseVault "$run"
vault="$(deployments_get "$engine" ".base.rose_vault.address" | jq -r .)"
on_chain_signer="$(cast call --rpc-url "$BASE_RPC_URL" "$vault" 'SIGNER()(address)' | tr '[:upper:]' '[:lower:]')"
[[ "$on_chain_signer" == "$signer" ]] || die "deployed RoseVault signer $on_chain_signer differs from $signer"
deployments_set "$engine" ".base.rose_vault.signer" "\"$signer\""
deployments_set "$engine" ".base.accepted_cash_tokens" "$(jq -cn --arg t "$(deployments_get "$engine" ".base.test_usdc.address" 2>/dev/null | jq -r . || true)" --arg c "$CIRCLE_USDC_BASE_SEPOLIA" '[$t, $c] | map(select(. != ""))')"

env_snippet "$engine" >"$ROSE_ROOT/deployments/$engine.env"
log "recorded in $DEPLOYMENTS_FILE; web app variables in deployments/$engine.env"
