#!/usr/bin/env bash
# shellcheck disable=SC2034 # the constants and EVM_* variables are read by the sourcing scripts
# Shared helpers of the rose deployment scripts. Sourced, never executed. Testnet only.
#
# Conventions: every script is bash + near-cli-rs (NEAR), forge/cast (Base) and jq; python3 is used
# only to decode base58. Keys are read from ~/.config/rose/*.env and ~/.near-credentials and never
# printed or passed on a command line (EVM keys go to cast and forge through an encrypted keystore
# and a password file, see evm_signer). Every deployment is recorded in deployments/testnet.json
# (addresses, transaction hashes, block numbers: no secrets).

set -euo pipefail

ROSE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROSE_CONFIG_DIR="${ROSE_CONFIG_DIR:-$HOME/.config/rose}"
DEPLOYMENTS_FILE="$ROSE_ROOT/deployments/testnet.json"

NEAR_NETWORK="testnet"
# Parent of the demo accounts and default funder (ROSE_ROOT_ACCOUNT; its key must be in the legacy keychain).
ROSE_ROOT_ACCOUNT="${ROSE_ROOT_ACCOUNT:-rose-app.testnet}"
NEAR_RPC_URL="${NEAR_RPC_URL:-https://test.rpc.fastnear.com}"
NEAR_EXPLORER_TX="https://testnet.near.rocks/tx"
BASE_RPC_URL="${BASE_SEPOLIA_RPC_URL:-https://sepolia.base.org}"
BASE_CHAIN_ID=84532
BASE_EXPLORER_TX="https://sepolia.basescan.org/tx"

MPC_ACCOUNT="v1.signer-prod.testnet"
MPC_DOMAIN_SECP256K1=0
MPC_DOMAIN_ED25519=1
MPC_DOMAIN_CKD=2

SABLIER_LOCKUP="0xa65a1ecef02c2b9bdc604951c6a6d02335d4532e"
CIRCLE_USDC_BASE_SEPOLIA="0x036cbd53842c5426634e7929541ec2318f3dcf7e"
STREAMFLOW_PROGRAM="HqDGZjaVRXJ9MGRQEw7qDc2rAr6iH1n1kAQdCZaCMfMZ"
NEAR_CASH_TOKEN="tusdc.rose-app.testnet"

log() { printf '%s\n' "$*" >&2; }
die() { log "error: $*"; exit 1; }

require_tools() {
  local tool
  for tool in "$@"; do
    command -v "$tool" >/dev/null 2>&1 || die "$tool is required (see scripts/README.md)"
  done
}

# evm_signer <name>: signs with the EVM key of ~/.config/rose/<name>.env (EVM_PRIVATE_KEY or
# EVM_DEPLOYER_PRIVATE_KEY) through its encrypted keystore, which scripts/evm-keystore.ts writes
# once, so the key never appears on a command line. Sets EVM_ADDRESS and EVM_WALLET_ARGS, the
# cast and forge flags `--keystore <file> --password-file <file>` (both files mode 600).
evm_signer() {
  local out keystore password_file
  out="$(node "$ROSE_ROOT/scripts/evm-keystore.ts" "$1")" || die "cannot open the EVM key of $1.env"
  keystore="$(sed -n 's/^keystore=//p' <<<"$out")"
  password_file="$(sed -n 's/^password_file=//p' <<<"$out")"
  EVM_ADDRESS="$(sed -n 's/^address=//p' <<<"$out")"
  EVM_WALLET_ARGS=(--keystore "$keystore" --password-file "$password_file")
}

# near_view <account> <method> [json args]: a view call through the RPC, printing the JSON result.
near_view() {
  local account="$1" method="$2" args="${3:-{\}}"
  local args_b64
  args_b64="$(printf '%s' "$args" | base64 | tr -d '\n')"
  curl -sS "$NEAR_RPC_URL" -H 'content-type: application/json' -d "$(jq -cn \
    --arg account "$account" --arg method "$method" --arg args "$args_b64" \
    '{jsonrpc:"2.0",id:1,method:"query",params:{request_type:"call_function",finality:"final",account_id:$account,method_name:$method,args_base64:$args}}')" \
    | jq 'if .result.result then (.result.result | implode | fromjson) else error(.result.error // .error | tostring) end'
}

# near_account_exists <account>: exit 0 when the account exists on testnet.
near_account_exists() {
  curl -sS "$NEAR_RPC_URL" -H 'content-type: application/json' -d "$(jq -cn --arg account "$1" \
    '{jsonrpc:"2.0",id:1,method:"query",params:{request_type:"view_account",finality:"final",account_id:$account}}')" \
    | jq -e '.result.amount' >/dev/null 2>&1
}

# near_access_keys <account>: the account's access key list at `final`, as compact JSON.
near_access_keys() {
  curl -sS "$NEAR_RPC_URL" -H 'content-type: application/json' -d "$(jq -cn --arg account "$1" \
    '{jsonrpc:"2.0",id:1,method:"query",params:{request_type:"view_access_key_list",finality:"final",account_id:$account}}')" \
    | jq -ce '.result.keys'
}

# near_code_sha256 <account>: lowercase hex sha256 of the deployed code (view_account `code_hash`
# at `final`, base58-decoded and left-padded to 32 bytes; all zeros when no code is deployed).
near_code_sha256() {
  local code_hash hex
  code_hash="$(curl -sS "$NEAR_RPC_URL" -H 'content-type: application/json' -d "$(jq -cn --arg account "$1" \
    '{jsonrpc:"2.0",id:1,method:"query",params:{request_type:"view_account",finality:"final",account_id:$account}}')" \
    | jq -er '.result.code_hash')" || die "view_account $1 failed"
  hex="$(b58_to_hex "$code_hash")"
  while [[ ${#hex} -lt 64 ]]; do hex="0$hex"; done
  printf '%s\n' "$hex"
}

# near_require_code <account> <wasm file>: dies unless the code deployed on <account> is exactly
# <wasm file> (on-chain code hash == local sha256). Run it before deleting any key: a keyless
# account can never be redeployed.
near_require_code() {
  local expected actual
  expected="$(shasum -a 256 "$2" | awk '{print $1}')"
  actual="$(near_code_sha256 "$1")"
  [[ "$actual" == "$expected" ]] || die "the code on $1 (sha256 $actual) is not $2 (sha256 $expected): refusing to continue"
  log "code on $1 equals $(basename "$2"): sha256 $expected"
}

# near_keychain_public_keys <account>: the public keys of <account> held in the legacy keychain
# (<account>.json and <account>/*.json), sorted, one per line.
near_keychain_public_keys() {
  local dir="$HOME/.near-credentials/$NEAR_NETWORK" file
  {
    if [[ -f "$dir/$1.json" ]]; then jq -r '.public_key' "$dir/$1.json"; fi
    for file in "$dir/$1"/*.json; do
      if [[ -f "$file" ]]; then jq -r '.public_key' "$file"; fi
    done
  } | sort -u
}

# near_delete_all_keys <account>: deletes every access key of <account> in ONE transaction signed
# with a legacy keychain key, the keychain keys listed last, and prints the transaction hash.
# Prints nothing when the account has no key left. The actions of one transaction apply together
# or not at all, so a failure leaves every key in place and the call can simply be repeated.
near_delete_all_keys() {
  local account="$1" listed on_chain signing others keys out hash
  listed="$(near_access_keys "$account")" || die "view_access_key_list $account failed"
  on_chain="$(jq -r '.[].public_key' <<<"$listed" | sort -u)"
  [[ -n "$on_chain" ]] || return 0
  signing="$(comm -12 <(printf '%s\n' "$on_chain") <(near_keychain_public_keys "$account"))"
  [[ -n "$signing" ]] || die "no access key of $account is in the legacy keychain: nothing can sign the deletion"
  others="$(comm -23 <(printf '%s\n' "$on_chain") <(printf '%s\n' "$signing"))"
  keys="$(printf '%s\n%s\n' "$others" "$signing" | sed '/^$/d' | paste -sd, -)"
  log "deleting $(jq 'length' <<<"$listed") access key(s) of $account in one transaction: $keys"
  out="$(near account delete-keys "$account" public-keys "$keys" network-config "$NEAR_NETWORK" \
    sign-with-legacy-keychain send 2>&1)" || { log "$out"; die "deleting the access keys of $account failed"; }
  hash="$(near_tx_hash "$out")"
  [[ -n "$hash" ]] || { log "$out"; die "no transaction id in the near-cli output"; }
  printf '%s\n' "$hash"
}

# near_wait_keyless <account> [seconds, default 60]: polls view_access_key_list at `final` until
# it returns []. near-cli-rs returns once the transaction executed optimistically, a few blocks
# before `final`, so a single read right after the deletion can still list the keys.
near_wait_keyless() {
  local account="$1" deadline=$((SECONDS + ${2:-60})) keys last="(no answer from $NEAR_RPC_URL)"
  while :; do
    # A failed read (rate limit, timeout) is retried; only a successful one is reported.
    if keys="$(near_access_keys "$account" 2>/dev/null)"; then
      [[ "$keys" == "[]" ]] && return 0
      last="$keys"
    fi
    if [[ $SECONDS -ge $deadline ]]; then
      log "view_access_key_list $account at final still returns $last"
      return 1
    fi
    sleep 3
  done
}

# near_secure_keychain <account>: mode 600 on the account's legacy keychain files and 700 on its
# key directory (near-cli-rs writes them world-readable).
near_secure_keychain() {
  local dir="$HOME/.near-credentials/$NEAR_NETWORK"
  if [[ -f "$dir/$1.json" ]]; then chmod 600 "$dir/$1.json"; fi
  if [[ -d "$dir/$1" ]]; then
    chmod 700 "$dir/$1"
    find "$dir/$1" -type f -name '*.json' -exec chmod 600 {} +
  fi
}

# near_tx_hash <near-cli output>: the transaction id printed by near-cli-rs.
near_tx_hash() {
  { grep -oE 'Transaction ID: [1-9A-HJ-NP-Za-km-z]+' <<<"$1" || true; } | head -1 | awk '{print $3}'
}

# near_tx_status <hash> <sender>: the final execution outcome (EXPERIMENTAL_tx_status) as JSON.
near_tx_status() {
  curl -sS "$NEAR_RPC_URL" -H 'content-type: application/json' -d "$(jq -cn --arg hash "$1" --arg sender "$2" \
    '{jsonrpc:"2.0",id:1,method:"EXPERIMENTAL_tx_status",params:{tx_hash:$hash,sender_account_id:$sender,wait_until:"FINAL"}}')" \
    | jq -e '.result'
}

# near_tx_gas <tx status json>: total gas burnt by the transaction and all its receipts, in Tgas.
near_tx_gas() {
  jq -r '([.transaction_outcome.outcome.gas_burnt] + [.receipts_outcome[].outcome.gas_burnt]) | add / 1e12 | . * 100 | round / 100' <<<"$1"
}

# near_tx_logs <tx status json>: every log line of the transaction's receipts.
near_tx_logs() {
  jq -r '.receipts_outcome[].outcome.logs[]' <<<"$1"
}

# near_call <signer> <contract> <method> <json args> <gas, e.g. "50 Tgas"> <deposit, e.g. "0.02 NEAR">:
# sends a function call with the signer's legacy keychain key and prints the transaction hash.
near_call() {
  local signer="$1" contract="$2" method="$3" args="$4" gas="$5" deposit="$6" out
  out="$(near contract call-function as-transaction "$contract" "$method" json-args "$args" \
    prepaid-gas "$gas" attached-deposit "$deposit" sign-as "$signer" \
    network-config "$NEAR_NETWORK" sign-with-legacy-keychain send 2>&1)" || {
    log "$out"
    die "near call $contract.$method failed"
  }
  local hash
  hash="$(near_tx_hash "$out")"
  [[ -n "$hash" ]] || { log "$out"; die "no transaction id in the near-cli output"; }
  printf '%s\n' "$hash"
}

# b58_to_hex <base58>: hex of the decoded bytes (NEAR public keys, Solana addresses).
b58_to_hex() {
  python3 -c '
import sys
A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
s = sys.argv[1]
n = 0
for c in s:
    n = n * 58 + A.index(c)
raw = n.to_bytes((n.bit_length() + 7) // 8, "big") if n else b""
pad = len(s) - len(s.lstrip("1"))
print((b"\x00" * pad + raw).hex())
' "$1"
}

# evm_address_of_near_secp256k1 <secp256k1:...>: lowercase 0x address of a NEAR secp256k1 public
# key (64 uncompressed bytes, keccak-256, last 20 bytes), as the engine computes it.
evm_address_of_near_secp256k1() {
  local key="${1#secp256k1:}" raw
  raw="$(b58_to_hex "$key")"
  [[ ${#raw} -eq 128 ]] || die "unexpected secp256k1 key length: ${#raw} hex characters"
  local digest
  digest="$(cast keccak "0x$raw")"
  printf '0x%s\n' "${digest: -40}"
}

# mpc_derived_key <path> <predecessor> <domain id>: the MPC contract's derived_public_key view.
mpc_derived_key() {
  near_view "$MPC_ACCOUNT" derived_public_key "$(jq -cn --arg p "$1" --arg a "$2" --argjson d "$3" \
    '{path:$p,predecessor:$a,domain_id:$d}')" | jq -r .
}

# deployments_init: creates deployments/testnet.json when missing.
deployments_init() {
  mkdir -p "$(dirname "$DEPLOYMENTS_FILE")"
  if [[ ! -f "$DEPLOYMENTS_FILE" ]]; then
    jq -n '{networks:{near:"testnet",base:{name:"Base Sepolia",chain_id:84532},solana:"devnet"},explorers:{near:"https://testnet.near.rocks/tx/<hash>",base:"https://sepolia.basescan.org/tx/<hash>",solana:"https://explorer.solana.com/tx/<sig>?cluster=devnet"},deployments:{}}' \
      >"$DEPLOYMENTS_FILE"
  fi
}

# deployments_set <engine account> <jq path under the deployment, e.g. .base.rose_vault> <json value>
deployments_set() {
  deployments_init
  local tmp
  tmp="$(mktemp)"
  jq --arg engine "$1" --argjson value "$3" ".deployments[\$engine]$2 = \$value" "$DEPLOYMENTS_FILE" >"$tmp"
  mv "$tmp" "$DEPLOYMENTS_FILE"
}

# deployments_get <engine account> <jq path under the deployment>: the recorded JSON value; exits
# non-zero when it is absent or null.
deployments_get() {
  [[ -f "$DEPLOYMENTS_FILE" ]] || return 1
  jq -e --arg engine "$1" ".deployments[\$engine]$2" "$DEPLOYMENTS_FILE"
}

# deployments_value <engine account> <jq path under the deployment>: the recorded value as raw
# text, or an empty string when it is absent or null (never the string "null").
deployments_value() {
  [[ -f "$DEPLOYMENTS_FILE" ]] || return 0
  jq -r --arg engine "$1" "(.deployments[\$engine]$2) // empty" "$DEPLOYMENTS_FILE"
}

# env_snippet <engine account>: NEXT_PUBLIC_* lines for the web app from the deployments file.
env_snippet() {
  local engine="$1"
  jq -r --arg engine "$engine" '.deployments[$engine] |
    "NEXT_PUBLIC_ENGINE_ACCOUNT=\($engine)",
    "NEXT_PUBLIC_ROSE_VAULT_ADDRESS=\(.base.rose_vault.address // "")",
    "NEXT_PUBLIC_BASE_TUSDC_ADDRESS=\(.base.test_usdc.address // "")",
    "NEXT_PUBLIC_DEMO_TOKEN_ADDRESS=\(.base.demo_token.address // "")",
    "NEXT_PUBLIC_DEMO_STREAM_FAUCET_ADDRESS=\(.base.demo_stream_faucet.address // "")",
    "NEXT_PUBLIC_SOLANA_VAULT_ADDRESS=\(.near.derived.vault_sol // "")",
    "NEXT_PUBLIC_SOLANA_GAS_PAYER_ADDRESS=\(.near.derived.gas_sol // "")",
    "NEXT_PUBLIC_SOLANA_DEMO_MINT=\(.solana.demo_mint // "")"' "$DEPLOYMENTS_FILE"
}
