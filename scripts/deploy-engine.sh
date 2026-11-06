#!/usr/bin/env bash
# Deploys the rose engine on NEAR testnet: creates <account> as a sub-account of its parent (the
# parent signs with its legacy keychain key), deploys the engine wasm with the `new` init call,
# calls `bootstrap` (the MPC-derived vault addresses), waits for it and
# checks the derived addresses against the MPC view. Then it checks that the code on chain is
# exactly the local wasm (view_account code hash == sha256 of the file). The balance pays the
# code, the full event history (1,024 entries of at most 448 bytes, which no caller pays for:
# `new` refuses to initialize without it) and the 0.5 NEAR MPC reserve: about 15.4 NEAR with a
# 1.03 MB wasm, hence the 17 NEAR default.
#
# With --keyless (the final deployment: no upgrade is possible afterwards), and only once the code
# check passed, every access key of the engine is deleted in one transaction (the keychain key that
# signs it listed last), and view_access_key_list is polled at `final` for up to 60 s until it
# returns []. `--role final` refuses to run without --keyless.
#
# The wasm is target/near/rose_engine/rose_engine.wasm (`cargo near build non-reproducible-wasm`)
# unless one of these names another artifact:
#   --wasm <file>    deploys <file>, for example a reproducible build made earlier.
#   --reproducible   builds the artifact now with `cargo near build reproducible-wasm` in a plain
#                    clone of HEAD (cargo-near resolves a git worktree to its main checkout, so it
#                    never builds in place), inside the Docker image pinned in
#                    contracts/engine/Cargo.toml, keeps it as
#                    target/near/reproducible/rose_engine-<commit>.wasm, then removes the clone and
#                    the image (about 2 GB). Uncommitted changes under contracts/ are refused: the
#                    artifact is built from HEAD only.
# An artifact is reproducible when its NEP-330 source metadata (`contract_source_metadata`, embedded
# in the wasm) names that pinned image as `build_environment`; `--role final` refuses any other, so
# anyone can rebuild the final engine from its commit and compare the sha256. The artifact's sha256
# and size are recorded before anything is sent, and the on-chain code hash must equal that sha256
# before any key is deleted.
#
# Usage: scripts/deploy-engine.sh <engine account> [--role staging|final] [--balance "17 NEAR"]
#                                 [--rose-vault <0x address>] [--wasm <file> | --reproducible]
#                                 [--keyless] [--skip-create] [--verify-only]
#   --skip-create  the account already exists; the deployment and the bootstrap are skipped when
#                  they are already done on chain, so a run that stopped half way resumes with it.
#   --verify-only  sends no transaction: runs every check below, waits for view_access_key_list
#                  to return [] when --keyless is given, then records the result. It recovers a run
#                  that stopped after the key deletion.
# The RoseVault address defaults to the one recorded for <engine account> in deployments/testnet.json
# by scripts/deploy-base.sh (the vault must be deployed first: its signer is derived from the
# engine account name). The CKD master public key is read live from the MPC contract (domain 2).
#
# Checks, run on every path (--skip-create and --verify-only included) and before any key is
# deleted, each read live and never skipped: the code on chain is the artifact; get_config equals
# the init arguments (the MPC account and domains, the CKD master public key read again from the
# MPC, the fee recipient, the cash tokens, the RoseVault, the Base chain id, the Sablier Lockup,
# the Streamflow program); the bootstrapped addresses equal the MPC's derivation; the RPC serves
# Base Sepolia; the RoseVault the engine is bound to answers SIGNER() == the engine's vault/base
# address and LOCKUP() == the Sablier Lockup.
# Keys: ~/.near-credentials/testnet/<parent>.json and <engine>.json (legacy keychain, set to mode
# 600); nothing is printed. Output: deployments/testnet.json (`.near.engine.keyless` is read from
# the live access key list) and the web app's NEXT_PUBLIC_* snippet in deployments/<engine>.env.

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_tools near curl jq shasum python3 comm paste cast

engine="" role="staging" balance="17 NEAR" rose_vault="" keyless=0 skip_create=0 verify_only=0 wasm="" reproducible=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --role) role="$2"; shift 2 ;;
    --wasm) wasm="$2"; shift 2 ;;
    --reproducible) reproducible=1; shift ;;
    --balance) balance="$2"; shift 2 ;;
    --rose-vault) rose_vault="$(lowercase "$2")"; shift 2 ;;
    --keyless) keyless=1; shift ;;
    --skip-create) skip_create=1; shift ;;
    --verify-only) verify_only=1; shift ;;
    -*) die "unknown argument $1" ;;
    *) engine="$1"; shift ;;
  esac
done
[[ -n "$engine" ]] || die "usage: $0 <engine account> [--role staging|final] [--wasm <file> | --reproducible] [--keyless] [--skip-create] [--verify-only]"
[[ "$role" == "staging" || "$role" == "final" ]] || die "--role must be staging or final"
[[ "$role" != "final" || "$keyless" -eq 1 ]] || die "--role final requires --keyless: a final engine keeps no access key"
[[ "$engine" == *.*.testnet ]] || die "testnet only: the engine must be a sub-account like engine.rose-app.testnet"
parent="${engine#*.}"

[[ -z "$wasm" || "$reproducible" -eq 0 ]] || die "--wasm and --reproducible are exclusive"

engine_manifest="$ROSE_ROOT/contracts/engine/Cargo.toml"
build_image="$(sed -n 's/^image = "\(.*\)"$/\1/p' "$engine_manifest")"
build_digest="$(sed -n 's/^image_digest = "\(.*\)"$/\1/p' "$engine_manifest")"
[[ -n "$build_image" && "$build_digest" == sha256:* ]] || die "no reproducible build image pinned in $engine_manifest"

# reproducible_build: builds the engine at HEAD with `cargo near build reproducible-wasm` in a
# plain clone, keeps the artifact under target/near/reproducible/ and prints its path; the clone
# and the Docker image are removed whether the build succeeds or not.
reproducible_build() {
  require_tools git docker cargo
  docker info >/dev/null 2>&1 || die "Docker is not running: start it for the reproducible build"
  local commit artifact built status=0
  image_present=0
  commit="$(git -C "$ROSE_ROOT" rev-parse HEAD)"
  [[ -z "$(git -C "$ROSE_ROOT" status --porcelain -- contracts Cargo.toml Cargo.lock rust-toolchain.toml)" ]] \
    || die "uncommitted changes under contracts/: the reproducible build uses HEAD ($commit) only, commit them first"
  docker image inspect "$build_image@$build_digest" >/dev/null 2>&1 && image_present=1
  work="$(mktemp -d "${TMPDIR:-/tmp}/rose-reproducible.XXXXXX")"
  # The function runs in a $(...) subshell: this trap cleans up after an interrupt too.
  trap 'rm -rf "$work"; if [[ $image_present -eq 0 ]]; then docker image rm "$build_image@$build_digest" >/dev/null 2>&1 || log "warning: could not remove the build image $build_image"; fi' EXIT
  log "reproducible build of $commit in $work (image $build_image@$build_digest)"
  git clone --quiet --no-hardlinks "$ROSE_ROOT" "$work/rose" && git -C "$work/rose" checkout --quiet --detach "$commit" \
    && (cd "$work/rose/contracts/engine" && cargo near build reproducible-wasm >&2) || status=$?
  artifact="$ROSE_ROOT/target/near/reproducible/rose_engine-$commit.wasm"
  built="$work/rose/target/near/rose_engine/rose_engine.wasm"
  if [[ "$status" -eq 0 ]]; then
    mkdir -p "$(dirname "$artifact")"
    if [[ -f "$built" ]]; then cp "$built" "$artifact" || status=$?; else status=1; fi
  fi
  [[ "$status" -eq 0 ]] || die "cargo near build reproducible-wasm failed (exit $status)"
  printf '%s\n' "$artifact"
}

# wasm_build_environment <wasm>: the `build_environment` of the NEP-330 metadata embedded in the
# wasm (the Docker image of a reproducible build), or nothing for a local build.
wasm_build_environment() {
  { LC_ALL=C grep -aoE '"build_environment":"[^"]*"' "$1" || true; } | head -n 1 | sed 's/^"build_environment":"//; s/"$//'
}

if [[ "$reproducible" -eq 1 ]]; then
  [[ "$verify_only" -eq 0 ]] || die "--verify-only checks an artifact already built: pass it with --wasm"
  # The artifact embeds the HEAD commit, so a rebuild after any new commit differs from the code a
  # stopped run deployed: a resume names that run's artifact instead.
  [[ "$skip_create" -eq 0 ]] || die "--skip-create resumes a stopped run: pass its artifact with --wasm target/near/reproducible/rose_engine-<commit>.wasm"
  wasm="$(reproducible_build)"
fi
wasm="${wasm:-$ROSE_ROOT/target/near/rose_engine/rose_engine.wasm}"
[[ -f "$wasm" ]] || die "no wasm at $wasm: build it (cd contracts/engine && cargo near build non-reproducible-wasm) or pass --reproducible"
wasm_sha256="$(shasum -a 256 "$wasm" | awk '{print $1}')"
wasm_bytes="$(wc -c <"$wasm" | tr -d ' ')"
build_environment="$(wasm_build_environment "$wasm")"
source_snapshot="$({ LC_ALL=C grep -aoE '"source_code_snapshot":"[^"]*"' "$wasm" || true; } | head -n 1 | sed 's/^"source_code_snapshot":"//; s/"$//')"
if [[ "$build_environment" == "$build_image@$build_digest" ]]; then
  log "reproducible artifact $wasm: $wasm_bytes bytes, sha256 $wasm_sha256, built in $build_environment from $source_snapshot"
  log "$(artifact_revision_note "$source_snapshot" "$(git -C "$ROSE_ROOT" rev-parse HEAD)")"
  if [[ "$role" == "final" ]]; then
    # Anyone must be able to rebuild it: the commit it names has to be on the remote.
    source_rev="${source_snapshot##*rev=}"
    git -C "$ROSE_ROOT" fetch --quiet origin || die "git fetch origin failed: cannot check that $source_rev is pushed"
    [[ -n "$(git -C "$ROSE_ROOT" branch -r --contains "$source_rev" 2>/dev/null)" ]] || die "commit $source_rev of the artifact is not on the remote: push it first"
  fi
else
  [[ "$role" != "final" ]] || die "--role final deploys a reproducible build only (pass --reproducible, or --wasm with one): $wasm names build environment '${build_environment:-none}'"
  log "local build $wasm: $wasm_bytes bytes, sha256 $wasm_sha256 (not reproducible)"
fi

if [[ -z "$rose_vault" ]]; then
  rose_vault="$(deployments_value "$engine" ".base.rose_vault.address")"
fi
[[ "$rose_vault" =~ ^0x[0-9a-f]{40}$ ]] || die "RoseVault address missing: run scripts/deploy-base.sh --engine $engine first or pass --rose-vault"
require_recorded_vault "$engine" "$rose_vault"

# expected_init_args: the init arguments of `new`, as JSON, with the CKD master public key read
# live from the MPC contract (domain 2). The deployment sends them and the checks compare
# get_config with a fresh read of them.
expected_init_args() {
  local test_usdc base_cash_tokens ckd_public_key
  test_usdc="$(deployments_value "$engine" ".base.test_usdc.address")"
  base_cash_tokens="$(jq -cn --arg t "$test_usdc" --arg c "$CIRCLE_USDC_BASE_SEPOLIA" '[$t, $c] | map(select(. != ""))')"
  ckd_public_key="$(near_view "$MPC_ACCOUNT" public_key "{\"domain_id\":$MPC_DOMAIN_CKD}" | jq -r .)" \
    || die "cannot read the CKD public key of $MPC_ACCOUNT"
  [[ "$ckd_public_key" == bls12381g2:* ]] || die "unexpected CKD public key $ckd_public_key"
  jq -cn \
    --arg mpc "$MPC_ACCOUNT" --arg ckd "$ckd_public_key" --arg fee "$parent" --arg cash "$NEAR_CASH_TOKEN" \
    --argjson tokens "$base_cash_tokens" --arg vault "$rose_vault" --arg lockup "$SABLIER_LOCKUP" \
    --arg streamflow "$STREAMFLOW_PROGRAM" --argjson chain "$BASE_CHAIN_ID" \
    --argjson secp "$MPC_DOMAIN_SECP256K1" --argjson ed "$MPC_DOMAIN_ED25519" --argjson ckd_domain "$MPC_DOMAIN_CKD" \
    --argjson foreign "$MPC_DOMAIN_FOREIGN_TX" \
    '{mpc_account:$mpc,sign_secp256k1_domain:$secp,sign_ed25519_domain:$ed,ckd_domain:$ckd_domain,foreign_tx_domain:$foreign,
      ckd_public_key:$ckd,fee_recipient:$fee,near_cash_token:$cash,base_cash_tokens:$tokens,rose_vault:$vault,
      base_chain_id:$chain,sablier_lockup:$lockup,streamflow_program:$streamflow,
      default_key_timeout:null,default_reveal_window:null}'
}

# deploy: creates the account (unless --skip-create), deploys with `new` and bootstraps, skipping
# each step already done on chain.
deploy() {
  [[ -f "$HOME/.near-credentials/$NEAR_NETWORK/$parent.json" ]] || die "no legacy keychain key for $parent"
  local init_args out
  init_args="$(expected_init_args)"
  init_args="$(jq -cn --argjson args "$init_args" '{args:$args}')"

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

# record_engine: the role and the artifact, written once the artifact is known to be on chain.
record_engine() {
  deployments_set "$engine" ".role" "\"$role\""
  deployments_set "$engine" ".near.engine.account" "\"$engine\""
  deployments_set "$engine" ".near.engine.wasm" "$(jq -cn --arg s "$wasm_sha256" --argjson b "$wasm_bytes" --arg e "$build_environment" \
    --arg pinned "$build_image@$build_digest" --arg src "$source_snapshot" \
    '{sha256:$s,bytes:$b,reproducible:($e == $pinned),build_environment:(if $e == "" then null else $e end),source_code_snapshot:(if $src == "" then null else $src end)}')"
}

if [[ "$verify_only" -eq 1 ]]; then
  near_account_exists "$engine" || die "$engine does not exist"
else
  # `new` binds the engine to the vault once and for all: refuse a wrong vault before the account
  # name is spent on it.
  require_base_chain
  require_rose_vault "$rose_vault" "$("$ROSE_ROOT/scripts/derive-vault-signer.sh" "$engine" --all | grep '^vault_base=' | cut -d= -f2)"
  deploy
fi

# Checks, in order, before any key is deleted (see the header): the exact code, the configuration,
# the bootstrapped addresses, the RoseVault.
near_require_code "$engine" "$wasm"
record_engine
deployments_set "$engine" ".near.engine.code_sha256" "\"$wasm_sha256\""

expected_config="$(expected_init_args)"
require_engine_config "$engine" "$expected_config"

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

require_base_chain
bound_vault="$(near_view "$engine" get_config | jq -r .rose_vault)" || die "get_config $engine failed"
require_rose_vault "$bound_vault" "$(jq -r .vault_base <<<"$derived")"
require_recorded_vault "$engine" "$bound_vault"
deployments_set "$engine" ".base.rose_vault.address" "\"$bound_vault\""

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
