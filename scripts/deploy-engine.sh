#!/usr/bin/env bash
# Deploys the rose engine on NEAR testnet: creates <account> as a sub-account of its parent (the
# parent signs with its legacy keychain key), deploys target/near/rose_engine/rose_engine.wasm
# with the `new` init call, calls `bootstrap` (the MPC-derived vault addresses), waits for it and
# prints the derived addresses. With --keyless, every access key of the engine is deleted and
# `view_access_key_list` is checked to be empty (the final deployment: no upgrade is possible
# afterwards).
#
# Usage: scripts/deploy-engine.sh <engine account> [--role staging|final] [--balance "12 NEAR"]
#                                 [--rose-vault <0x address>] [--keyless] [--skip-create]
# The RoseVault address defaults to the one recorded for <engine account> in deployments/testnet.json
# by scripts/deploy-base.sh (the vault must be deployed first: its signer is derived from the
# engine account name). The CKD master public key is read live from the MPC contract (domain 2).
# Keys: ~/.near-credentials/testnet/<parent>.json (legacy keychain); nothing is printed.

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_tools near curl jq shasum

engine="" role="staging" balance="12 NEAR" rose_vault="" keyless=0 skip_create=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --role) role="$2"; shift 2 ;;
    --balance) balance="$2"; shift 2 ;;
    --rose-vault) rose_vault="$2"; shift 2 ;;
    --keyless) keyless=1; shift ;;
    --skip-create) skip_create=1; shift ;;
    -*) die "unknown argument $1" ;;
    *) engine="$1"; shift ;;
  esac
done
[[ -n "$engine" ]] || die "usage: $0 <engine account> [--role staging|final] [--keyless]"
[[ "$engine" == *.*.testnet ]] || die "testnet only: the engine must be a sub-account like engine.rose-app.testnet"
parent="${engine#*.}"
[[ -f "$HOME/.near-credentials/$NEAR_NETWORK/$parent.json" ]] || die "no legacy keychain key for $parent"

wasm="$ROSE_ROOT/target/near/rose_engine/rose_engine.wasm"
[[ -f "$wasm" ]] || die "build the engine first: cd contracts/engine && cargo near build non-reproducible-wasm"
wasm_sha256="$(shasum -a 256 "$wasm" | awk '{print $1}')"
wasm_bytes="$(wc -c <"$wasm" | tr -d ' ')"

if [[ -z "$rose_vault" ]]; then
  rose_vault="$(deployments_get "$engine" ".base.rose_vault.address" 2>/dev/null | jq -r . || true)"
fi
[[ "$rose_vault" =~ ^0x[0-9a-f]{40}$ ]] || die "RoseVault address missing: run scripts/deploy-base.sh --engine $engine first or pass --rose-vault"
test_usdc="$(deployments_get "$engine" ".base.test_usdc.address" 2>/dev/null | jq -r . || true)"
base_cash_tokens="$(jq -cn --arg t "$test_usdc" --arg c "$CIRCLE_USDC_BASE_SEPOLIA" '[$t, $c] | map(select(. != ""))')"

ckd_public_key="$(near_view "$MPC_ACCOUNT" public_key "{\"domain_id\":$MPC_DOMAIN_CKD}" | jq -r .)"
[[ "$ckd_public_key" == bls12381g2:* ]] || die "unexpected CKD public key $ckd_public_key"

init_args="$(jq -cn \
  --arg mpc "$MPC_ACCOUNT" --arg ckd "$ckd_public_key" --arg fee "$parent" --arg cash "$NEAR_CASH_TOKEN" \
  --argjson tokens "$base_cash_tokens" --arg vault "$rose_vault" --arg lockup "$SABLIER_LOCKUP" \
  --arg streamflow "$STREAMFLOW_PROGRAM" --argjson chain "$BASE_CHAIN_ID" \
  '{args:{mpc_account:$mpc,sign_secp256k1_domain:0,sign_ed25519_domain:1,ckd_domain:2,foreign_tx_domain:3,
    ckd_public_key:$ckd,fee_recipient:$fee,near_cash_token:$cash,base_cash_tokens:$tokens,rose_vault:$vault,
    base_chain_id:$chain,sablier_lockup:$lockup,streamflow_program:$streamflow,
    default_key_timeout:null,default_reveal_window:null}}')"
log "init args: $init_args"

deployments_set "$engine" ".role" "\"$role\""
deployments_set "$engine" ".near.engine.account" "\"$engine\""
deployments_set "$engine" ".near.engine.wasm" "$(jq -cn --arg s "$wasm_sha256" --argjson b "$wasm_bytes" '{sha256:$s,bytes:$b}')"
deployments_set "$engine" ".near.engine.init_args" "$(jq -c .args <<<"$init_args")"

if [[ "$skip_create" -eq 0 ]]; then
  if near_account_exists "$engine"; then
    die "$engine already exists (pass --skip-create to deploy on an existing empty account)"
  fi
  out="$(near account create-account fund-myself "$engine" "$balance" autogenerate-new-keypair \
    save-to-legacy-keychain sign-as "$parent" network-config "$NEAR_NETWORK" sign-with-legacy-keychain send 2>&1)" \
    || { log "$out"; die "account creation failed"; }
  create_tx="$(near_tx_hash "$out")"
  [[ -n "$create_tx" ]] || { log "$out"; die "no transaction id in the near-cli output"; }
  log "created $engine with $balance: $NEAR_EXPLORER_TX/$create_tx"
  deployments_set "$engine" ".near.engine.create_tx" "\"$create_tx\""
fi

out="$(near contract deploy "$engine" use-file "$wasm" with-init-call new json-args "$init_args" \
  prepaid-gas '100 Tgas' attached-deposit '0 NEAR' network-config "$NEAR_NETWORK" sign-with-legacy-keychain send 2>&1)" \
  || { log "$out"; die "deployment failed"; }
deploy_tx="$(near_tx_hash "$out")"
[[ -n "$deploy_tx" ]] || { log "$out"; die "no transaction id in the near-cli output"; }
log "deployed and initialized: $NEAR_EXPLORER_TX/$deploy_tx"
deployments_set "$engine" ".near.engine.deploy_tx" "\"$deploy_tx\""

bootstrap_tx="$(near_call "$engine" "$engine" bootstrap '{}' '80 Tgas' '0 NEAR')"
log "bootstrap: $NEAR_EXPLORER_TX/$bootstrap_tx"
deployments_set "$engine" ".near.engine.bootstrap_tx" "\"$bootstrap_tx\""
for _ in $(seq 1 30); do
  derived="$(near_view "$engine" get_config | jq -c '.derived_addresses')"
  [[ "$derived" != "null" ]] && break
  sleep 2
done
[[ "$derived" != "null" ]] || die "bootstrap did not store the derived addresses (retry: near call $engine bootstrap)"
expected="$("$ROSE_ROOT/scripts/derive-vault-signer.sh" "$engine" --all)"
[[ "$(jq -r .vault_base <<<"$derived")" == "$(grep '^vault_base=' <<<"$expected" | cut -d= -f2)" ]] || die "bootstrapped vault_base differs from the MPC view"
[[ "$(jq -r .vault_sol <<<"$derived")" == "$(grep '^vault_sol=' <<<"$expected" | cut -d= -f2)" ]] || die "bootstrapped vault_sol differs from the MPC view"
[[ "$(jq -r .gas_sol <<<"$derived")" == "$(grep '^gas_sol=' <<<"$expected" | cut -d= -f2)" ]] || die "bootstrapped gas_sol differs from the MPC view"
deployments_set "$engine" ".near.derived" "$derived"
log "derived addresses: $derived"

vault_signer="$(deployments_get "$engine" ".base.rose_vault.signer" 2>/dev/null | jq -r . || true)"
if [[ -n "$vault_signer" && "$vault_signer" != "$(jq -r .vault_base <<<"$derived")" ]]; then
  die "RoseVault signer $vault_signer is not the engine's vault/base address: the vault must be redeployed"
fi

if [[ "$keyless" -eq 1 ]]; then
  for key in $(near_access_keys "$engine" | jq -r '.[].public_key'); do
    out="$(near account delete-keys "$engine" public-keys "$key" network-config "$NEAR_NETWORK" \
      sign-with-legacy-keychain send 2>&1)" || { log "$out"; die "deleting key $key failed"; }
    log "deleted $key: $NEAR_EXPLORER_TX/$(near_tx_hash "$out")"
    deployments_set "$engine" ".near.engine.delete_keys_tx" "\"$(near_tx_hash "$out")\""
  done
  keys="$(near_access_keys "$engine")"
  [[ "$keys" == "[]" ]] || die "access keys remain: $keys"
  log "keyless: view_access_key_list == []"
fi
deployments_set "$engine" ".near.engine.keyless" "$([[ "$keyless" -eq 1 ]] && echo true || echo false)"

env_snippet "$engine" >"$ROSE_ROOT/deployments/$engine.env"
log "recorded in $DEPLOYMENTS_FILE; web app variables in deployments/$engine.env"
