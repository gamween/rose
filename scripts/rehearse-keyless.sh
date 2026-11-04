#!/usr/bin/env bash
# Rehearses the keyless step of deploy-engine.sh on a throwaway sub-account, with the same lib.sh
# helpers the final deployment runs: creates <account> with a small balance, deploys a wasm
# without init call (by default a 34-byte module exporting one empty function `noop`), adds a
# second full-access key that is not in the keychain, checks the on-chain code hash against the
# file (near_require_code), deletes both keys in one transaction with the signing key last
# (near_delete_all_keys), polls view_access_key_list at `final` until it returns []
# (near_wait_keyless), then runs the same checks again to show that a repeated run sends nothing.
# The account's balance stays locked forever, so keep it small.
#
# Usage: scripts/rehearse-keyless.sh <keyless-rehearsal-*.<parent>.testnet> [--wasm <file>]
#                                    [--balance "0.02 NEAR"]
# Keys: ~/.near-credentials/testnet/<parent>.json (legacy keychain); the throwaway key is written
# to the keychain with mode 600 and is useless once deleted on chain. Record:
# deployments/e2e/<account>.json (transaction hashes and the final access key list).

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_tools near curl jq shasum python3 comm paste

account="${1:-}"
shift || true
wasm="" balance="0.02 NEAR"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --wasm) wasm="$2"; shift 2 ;;
    --balance) balance="$2"; shift 2 ;;
    *) die "unknown argument $1" ;;
  esac
done
[[ "$account" == keyless-rehearsal-*.*.testnet ]] || die "usage: $0 <keyless-rehearsal-<suffix>.<parent>.testnet> [--wasm file] [--balance \"0.02 NEAR\"]"
parent="${account#*.}"
[[ -f "$HOME/.near-credentials/$NEAR_NETWORK/$parent.json" ]] || die "no legacy keychain key for $parent"
near_account_exists "$account" && die "$account already exists: pick a new name"

if [[ -z "$wasm" ]]; then
  wasm="$(mktemp)"
  trap 'rm -f "$wasm"' EXIT
  # (module (type (func)) (func (type 0)) (export "noop" (func 0)))
  printf '\x00\x61\x73\x6d\x01\x00\x00\x00\x01\x04\x01\x60\x00\x00\x03\x02\x01\x00\x07\x08\x01\x04\x6e\x6f\x6f\x70\x00\x00\x0a\x04\x01\x02\x00\x0b' >"$wasm"
fi
[[ -f "$wasm" ]] || die "no wasm at $wasm"

record="$ROSE_ROOT/deployments/e2e/$account.json"
mkdir -p "$(dirname "$record")"
jq -n --arg a "$account" --arg s "$(shasum -a 256 "$wasm" | awk '{print $1}')" --argjson b "$(wc -c <"$wasm" | tr -d ' ')" \
  '{account:$a,wasm:{sha256:$s,bytes:$b},steps:{}}' >"$record"
# note <step> <near tx hash>: records the hash and its explorer link.
note() {
  local tmp
  tmp="$(mktemp)"
  jq --arg s "$1" --arg h "$2" '.steps[$s] = {near_tx:$h, link:("https://testnet.near.rocks/tx/" + $h)}' "$record" >"$tmp" && mv "$tmp" "$record"
  log "$1: $NEAR_EXPLORER_TX/$2"
}

out="$(near account create-account fund-myself "$account" "$balance" autogenerate-new-keypair \
  save-to-legacy-keychain sign-as "$parent" network-config "$NEAR_NETWORK" sign-with-legacy-keychain send 2>&1)" \
  || { log "$out"; die "account creation failed"; }
near_secure_keychain "$account"
note create "$(near_tx_hash "$out")"

out="$(near contract deploy "$account" use-file "$wasm" without-init-call network-config "$NEAR_NETWORK" \
  sign-with-legacy-keychain send 2>&1)" || { log "$out"; die "deployment failed"; }
note deploy "$(near_tx_hash "$out")"

# A second full-access key whose secret nobody holds: the deletion must remove keys the keychain
# cannot sign with, in the same transaction as the signing key.
extra_key="ed25519:$(python3 -c '
import os
A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
raw = os.urandom(32)
n = int.from_bytes(raw, "big")
s = ""
while n:
    n, r = divmod(n, 58)
    s = A[r] + s
print("1" * (len(raw) - len(raw.lstrip(b"\0"))) + s)
')"
out="$(near account add-key "$account" grant-full-access use-manually-provided-public-key "$extra_key" \
  network-config "$NEAR_NETWORK" sign-with-legacy-keychain send 2>&1)" || { log "$out"; die "add-key failed"; }
note add_key "$(near_tx_hash "$out")"

for _ in $(seq 1 20); do
  [[ "$(near_access_keys "$account" | jq 'length')" == "2" ]] && break
  sleep 3
done
before="$(near_access_keys "$account")"
[[ "$(jq 'length' <<<"$before")" == "2" ]] || die "expected two access keys at final, got $before"
log "access keys at final before the deletion: $before"

near_require_code "$account" "$wasm"
delete_tx="$(near_delete_all_keys "$account")"
[[ -n "$delete_tx" ]] || die "no deletion was sent"
note delete_keys "$delete_tx"
near_wait_keyless "$account" 60 || die "access keys remain at final after 60 s"
log "first pass: view_access_key_list($account) at final == []"

near_require_code "$account" "$wasm"
[[ -z "$(near_delete_all_keys "$account")" ]] || die "the second pass sent a deletion"
near_wait_keyless "$account" 5 || die "the second pass found keys"
log "second pass: nothing sent, still []"

after="$(near_access_keys "$account")"
tmp="$(mktemp)"
jq --argjson b "$before" --argjson a "$after" --arg t "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '.access_keys_before = ($b | map(.public_key)) | .access_keys_final = $a | .checked_at = $t' "$record" >"$tmp" && mv "$tmp" "$record"
log "recorded in deployments/e2e/$account.json"
