#!/usr/bin/env bash
# Deploys the rose engine on NEAR testnet: creates <account> as a sub-account of its parent (the
# parent signs with its legacy keychain key), deploys target/near/rose_engine/rose_engine.wasm
# with the `new` init call, calls `bootstrap` (the MPC-derived vault addresses), waits for it and
# checks the derived addresses against the MPC view. Then it checks that the code on chain is
# exactly the local wasm (view_account code hash == sha256 of the file).
#
# With --keyless (the final deployment: no upgrade is possible afterwards), and only once the code
# check passed, every access key of the engine is deleted in one transaction (the keychain key that
# signs it listed last), and view_access_key_list is polled at `final` for up to 60 s until it
# returns []. `--role final` refuses to run without --keyless.
#
# Usage: scripts/deploy-engine.sh <engine account> [--role staging|final] [--balance "12 NEAR"]
#                                 [--rose-vault <0x address>] [--keyless] [--skip-create]
#                                 [--verify-only]
#   --skip-create  the account already exists; the deployment and the bootstrap are skipped when
#                  they are already done on chain, so a run that stopped half way resumes with it.
#   --verify-only  sends no transaction: checks the code, the derived addresses and the RoseVault
#                  signer, waits for view_access_key_list to return [] when --keyless is given,
#                  then records the result. It recovers a run that stopped after the key deletion.
# The RoseVault address defaults to the one recorded for <engine account> in deployments/testnet.json
# by scripts/deploy-base.sh (the vault must be deployed first: its signer is derived from the
# engine account name). The CKD master public key is read live from the MPC contract (domain 2).
# Keys: ~/.near-credentials/testnet/<parent>.json and <engine>.json (legacy keychain, set to mode
# 600); nothing is printed. Output: deployments/testnet.json (`.near.engine.keyless` is read from
# the live access key list) and the web app's NEXT_PUBLIC_* snippet in deployments/<engine>.env.

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_tools near curl jq shasum python3 comm paste

engine="" role="staging" balance="12 NEAR" rose_vault="" keyless=0 skip_create=0 verify_only=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --role) role="$2"; shift 2 ;;
    --balance) balance="$2"; shift 2 ;;
    --rose-vault) rose_vault="$2"; shift 2 ;;
    --keyless) keyless=1; shift ;;
    --skip-create) skip_create=1; shift ;;
    --verify-only) verify_only=1; shift ;;
    -*) die "unknown argument $1" ;;
    *) engine="$1"; shift ;;
  esac
done
[[ -n "$engine" ]] || die "usage: $0 <engine account> [--role staging|final] [--keyless] [--skip-create] [--verify-only]"
[[ "$role" == "staging" || "$role" == "final" ]] || die "--role must be staging or final"
[[ "$role" != "final" || "$keyless" -eq 1 ]] || die "--role final requires --keyless: a final engine keeps no access key"
[[ "$engine" == *.*.testnet ]] || die "testnet only: the engine must be a sub-account like engine.rose-app.testnet"
parent="${engine#*.}"

wasm="$ROSE_ROOT/target/near/rose_engine/rose_engine.wasm"
[[ -f "$wasm" ]] || die "build the engine first: cd contracts/engine && cargo near build non-reproducible-wasm"
wasm_sha256="$(shasum -a 256 "$wasm" | awk '{print $1}')"
wasm_bytes="$(wc -c <"$wasm" | tr -d ' ')"

# deploy: creates the account (unless --skip-create), deploys with `new` and bootstraps, skipping
# each step already done on chain.
deploy() {
  [[ -f "$HOME/.near-credentials/$NEAR_NETWORK/$parent.json" ]] || die "no legacy keychain key for $parent"
  if [[ -z "$rose_vault" ]]; then
    rose_vault="$(deployments_value "$engine" ".base.rose_vault.address")"
  fi
  [[ "$rose_vault" =~ ^0x[0-9a-f]{40}$ ]] || die "RoseVault address missing: run scripts/deploy-base.sh --engine $engine first or pass --rose-vault"
  local test_usdc base_cash_tokens ckd_public_key init_args out
  test_usdc="$(deployments_value "$engine" ".base.test_usdc.address")"
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

  if [[ "$skip_create" -eq 0 ]]; then
    if near_account_exists "$engine"; then
      die "$engine already exists (pass --skip-create to deploy on it or resume a stopped run)"
    fi
    out="$(near account create-account fund-myself "$engine" "$balance" autogenerate-new-keypair \
      save-to-legacy-keychain sign-as "$parent" network-config "$NEAR_NETWORK" sign-with-legacy-keychain send 2>&1)" \
      || { log "$out"; die "account creation failed"; }
    near_secure_keychain "$engine"
    local create_tx
    create_tx="$(near_tx_hash "$out")"
    [[ -n "$create_tx" ]] || { log "$out"; die "no transaction id in the near-cli output"; }
    log "created $engine with $balance: $NEAR_EXPLORER_TX/$create_tx"
    deployments_set "$engine" ".near.engine.create_tx" "\"$create_tx\""
  else
    near_account_exists "$engine" || die "$engine does not exist (drop --skip-create)"
  fi

  local on_chain_code
  on_chain_code="$(near_code_sha256 "$engine")"
  if [[ "$on_chain_code" == "$wasm_sha256" ]]; then
    log "the code on $engine is already $wasm_sha256: deployment skipped"
  else
    log "init args: $init_args"
    deployments_set "$engine" ".near.engine.init_args" "$(jq -c .args <<<"$init_args")"
    out="$(near contract deploy "$engine" use-file "$wasm" with-init-call new json-args "$init_args" \
      prepaid-gas '100 Tgas' attached-deposit '0 NEAR' network-config "$NEAR_NETWORK" sign-with-legacy-keychain send 2>&1)" \
      || { log "$out"; die "deployment failed"; }
    local deploy_tx
    deploy_tx="$(near_tx_hash "$out")"
    [[ -n "$deploy_tx" ]] || { log "$out"; die "no transaction id in the near-cli output"; }
    log "deployed and initialized: $NEAR_EXPLORER_TX/$deploy_tx"
    deployments_set "$engine" ".near.engine.deploy_tx" "\"$deploy_tx\""
  fi

  local derived
  derived="$(near_view "$engine" get_config | jq -c '.derived_addresses')"
  if [[ "$derived" != "null" ]]; then
    log "already bootstrapped: bootstrap skipped"
    return
  fi
  local bootstrap_tx
  bootstrap_tx="$(near_call "$engine" "$engine" bootstrap '{}' '80 Tgas' '0 NEAR')"
  log "bootstrap: $NEAR_EXPLORER_TX/$bootstrap_tx"
  deployments_set "$engine" ".near.engine.bootstrap_tx" "\"$bootstrap_tx\""
}

deployments_set "$engine" ".role" "\"$role\""
deployments_set "$engine" ".near.engine.account" "\"$engine\""
deployments_set "$engine" ".near.engine.wasm" "$(jq -cn --arg s "$wasm_sha256" --argjson b "$wasm_bytes" '{sha256:$s,bytes:$b}')"

if [[ "$verify_only" -eq 1 ]]; then
  near_account_exists "$engine" || die "$engine does not exist"
else
  deploy
fi

# Checks, in order, before any key is deleted: the exact code, the bootstrapped addresses, the
# RoseVault signer.
near_require_code "$engine" "$wasm"
deployments_set "$engine" ".near.engine.code_sha256" "\"$wasm_sha256\""

derived="null"
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

vault_signer="$(deployments_value "$engine" ".base.rose_vault.signer")"
if [[ -n "$vault_signer" && "$vault_signer" != "$(jq -r .vault_base <<<"$derived")" ]]; then
  die "RoseVault signer $vault_signer is not the engine's vault/base address: the vault must be redeployed"
fi

if [[ "$keyless" -eq 1 ]]; then
  if [[ "$verify_only" -eq 0 ]]; then
    delete_tx="$(near_delete_all_keys "$engine")"
    if [[ -n "$delete_tx" ]]; then
      log "keys deleted: $NEAR_EXPLORER_TX/$delete_tx"
      deployments_set "$engine" ".near.engine.delete_keys_tx" "\"$delete_tx\""
    fi
  fi
  near_wait_keyless "$engine" 60 \
    || die "access keys remain at final; once the deletion is final, run: $0 $engine --role $role --keyless --verify-only"
  log "keyless: view_access_key_list($engine) at final == []"
fi

access_keys="$(near_access_keys "$engine")" || die "view_access_key_list $engine failed"
deployments_set "$engine" ".near.engine.keyless" "$([[ "$access_keys" == "[]" ]] && echo true || echo false)"
deployments_set "$engine" ".near.engine.access_keys_checked_at" "\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\""

env_snippet "$engine" >"$ROSE_ROOT/deployments/$engine.env"
log "recorded in $DEPLOYMENTS_FILE (keyless: $([[ "$access_keys" == "[]" ]] && echo true || echo false)); web app variables in deployments/$engine.env"
