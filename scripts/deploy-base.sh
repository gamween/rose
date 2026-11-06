#!/usr/bin/env bash
# Deploys rose's Base Sepolia contracts for one engine account: TestUSDC, DemoToken ("Cindral",
# "CINDR"), DemoStreamFaucet (DeployDemoAssets.s.sol) and RoseVault (DeployRoseVault.s.sol) with
# ROSE_VAULT_SIGNER = the engine's MPC-derived vault/base address. The vault is immutable, so the
# script refuses to broadcast unless the signer it is about to use equals what
# scripts/derive-vault-signer.sh computes for the engine account, and unless the Sablier Lockup of
# scripts/lib.sh (SABLIER_LOCKUP, the one source of the address: both forge scripts read it from
# the environment) answers as the Sablier Lockup. After the deployment it reads SIGNER() and
# LOCKUP() back from the vault and dies unless they are that signer and that Lockup.
#
# Usage: scripts/deploy-base.sh --engine <engine account> [--role staging|final]
#                               [--signer <0x address>] [--demo-assets-from <engine account>]
# --demo-assets-from reuses the TestUSDC, DemoToken and DemoStreamFaucet recorded for another
# engine (they do not depend on the engine) and deploys only the RoseVault.
# Keys: EVM_DEPLOYER_PRIVATE_KEY from ~/.config/rose/evm-deployer.env, handed to forge and cast
# through its encrypted keystore (scripts/evm-keystore.ts), never printed or put on a command line.
# Output: deployments/testnet.json (addresses, tx hashes, block numbers) and the web app's
# NEXT_PUBLIC_* snippet in deployments/<engine account>.env.

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_tools forge cast jq curl python3 node

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

evm_signer evm-deployer
deployer="$(cast wallet address "${EVM_WALLET_ARGS[@]}")"
[[ "$(tr '[:upper:]' '[:lower:]' <<<"$deployer")" == "$EVM_ADDRESS" ]] || die "the keystore of evm-deployer.env opens to $deployer, not $EVM_ADDRESS"

require_base_chain
require_sablier_lockup

derived="$("$ROSE_ROOT/scripts/derive-vault-signer.sh" "$engine")"
if [[ -z "$signer" ]]; then
  signer="$derived"
fi
signer="$(lowercase "$signer")"
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
    "${EVM_WALLET_ARGS[@]}" --sender "$deployer" >&2
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
  run="$(forge_run DeployDemoAssets DEMO_TOKEN_NAME=Cindral DEMO_TOKEN_SYMBOL=CINDR SABLIER_LOCKUP="$SABLIER_LOCKUP")"
  record_contract "$engine" test_usdc TestUSDC "$run"
  record_contract "$engine" demo_token DemoToken "$run"
  record_contract "$engine" demo_stream_faucet DemoStreamFaucet "$run"
fi

run="$(forge_run DeployRoseVault ROSE_VAULT_SIGNER="$signer" SABLIER_LOCKUP="$SABLIER_LOCKUP")"
record_contract "$engine" rose_vault RoseVault "$run"
vault="$(deployments_value "$engine" ".base.rose_vault.address")"
[[ "$vault" =~ ^0x[0-9a-f]{40}$ ]] || die "no RoseVault address recorded for $engine"
require_rose_vault "$vault" "$signer"
deployments_set "$engine" ".base.rose_vault.signer" "\"$signer\""
deployments_set "$engine" ".base.accepted_cash_tokens" "$(jq -cn --arg t "$(deployments_value "$engine" ".base.test_usdc.address")" --arg c "$CIRCLE_USDC_BASE_SEPOLIA" '[$t, $c] | map(select(. != ""))')"

env_snippet "$engine" >"$ROSE_ROOT/deployments/$engine.env"
log "recorded in $DEPLOYMENTS_FILE; web app variables in deployments/$engine.env"
