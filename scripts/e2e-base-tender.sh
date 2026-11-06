#!/usr/bin/env bash
# End-to-end flow on real testnets (spec 10): a Sablier position minted by DemoStreamFaucet and
# deposited into RoseVault on Base Sepolia, registered on the engine through a real ForeignTx
# attestation, sold in a Tender round sealed with the rose-ibe wasm build and opened with the key
# released by the real MPC (CKD), cleared and settled on NEAR, then a Base payout authorization
# signed by the MPC and executed on RoseVault.
#
# Usage: scripts/e2e-base-tender.sh <engine account> <step> [--holder <near account>]
#        [--issuer <near account>] [--stream <sablier stream id>] [--receipt <cast receipt json>]
#        [--evm-env <name>] [--record <step> <near tx hash>]
# --stream deposits an existing stream of the EVM holder instead of minting one; with --receipt
# (the `cast send --json` receipt of an earlier depositStream) the deposit step only records it.
# `record --record <step> <near tx hash>` stores a transaction sent by hand under a step name.
# Steps, in order: deposit, register, fund, tender, ask, close, open, clear, settle, claim, execute,
# or `all`. Every transaction hash and its gas is appended to deployments/e2e/<engine>.json so
# the run is reproducible and documented. The holder is the NEAR account the deposit credits (its
# key must be in the legacy keychain; required on the first run, then read from the state file),
# the issuer the NEAR account that funds the Tender and opens the ask (default $ROSE_ROOT_ACCOUNT,
# rose-app.testnet). --evm-env names the ~/.config/rose/<name>.env holding the EVM holder's key
# (EVM_PRIVATE_KEY, or EVM_DEPLOYER_PRIVATE_KEY for the default evm-deployer); DemoStreamFaucet
# lets one address mint one KOL position per day, so a second run the same day uses another EVM
# holder. Keys: ~/.config/rose/<evm env>.env, signed through its encrypted keystore
# (scripts/evm-keystore.ts) so the key never appears on a command line, and ~/.near-credentials.

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_tools near cast jq curl node python3

engine="${1:-}" step="${2:-}"
shift 2 || true
holder="" issuer="" stream_id="" receipt_file="" record_step="" record_hash="" evm_env="evm-deployer"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --holder) holder="$2"; shift 2 ;;
    --issuer) issuer="$2"; shift 2 ;;
    --stream) stream_id="$2"; shift 2 ;;
    --receipt) receipt_file="$2"; shift 2 ;;
    --record) record_step="$2"; record_hash="$3"; shift 3 ;;
    --evm-env) evm_env="$2"; shift 2 ;;
    *) die "unknown argument $1" ;;
  esac
done
[[ -n "$engine" && -n "$step" ]] || die "usage: $0 <engine account> <step|all|record> [--holder a] [--issuer b] [--stream id] [--receipt file] [--evm-env name] [--record <step> <near tx hash>]"

STATE="$ROSE_ROOT/deployments/e2e/$engine.json"
mkdir -p "$(dirname "$STATE")"
if [[ -f "$STATE" ]]; then
  [[ -n "$holder" ]] || holder="$(jq -r '.holder // empty' "$STATE")"
  [[ -n "$issuer" ]] || issuer="$(jq -r '.issuer // empty' "$STATE")"
fi
[[ -n "$holder" ]] || die "--holder <near account> is required on the first run (its key must be in the legacy keychain)"
[[ -n "$issuer" ]] || issuer="$ROSE_ROOT_ACCOUNT"
[[ -f "$STATE" ]] || jq -n --arg e "$engine" --arg h "$holder" --arg i "$issuer" '{engine:$e,holder:$h,issuer:$i,steps:{}}' >"$STATE"

state_get() { jq -r "$1" "$STATE"; }
state_set() {
  local tmp
  tmp="$(mktemp)"
  jq --argjson value "$2" "$1 = \$value" "$STATE" >"$tmp" && mv "$tmp" "$STATE"
}
# state_merge <jq path> <json object>: merges an object into the object at the path.
state_merge() {
  local tmp
  tmp="$(mktemp)"
  jq --argjson value "$2" "$1 = (($1) // {}) + \$value" "$STATE" >"$tmp" && mv "$tmp" "$STATE"
}
# record_near <step> <tx hash> [extra json]: stores the hash, its gas and its link.
record_near() {
  local status gas extra="${3:-null}" record
  status="$(near_tx_status "$2" "$engine")" || status="$(near_tx_status "$2" "$holder")" || status="$(near_tx_status "$2" "$issuer")"
  gas="$(near_tx_gas "$status")"
  record="$(jq -cn --arg h "$2" --argjson g "$gas" --argjson extra "$extra" \
    '{near_tx: $h, link: ("https://testnet.near.rocks/tx/" + $h), gas_tgas: $g} + ($extra // {})')"
  state_merge ".steps[\"$1\"]" "$record"
  log "$1: $NEAR_EXPLORER_TX/$2 ($gas Tgas)"
  printf '%s\n' "$status"
}

vault="$(deployments_value "$engine" ".base.rose_vault.address")"
faucet="$(deployments_value "$engine" ".base.demo_stream_faucet.address")"
token="$(deployments_value "$engine" ".base.demo_token.address")"
deployer="$(deployments_value "$engine" ".base.deployer")"
for address in "$vault" "$faucet" "$token" "$deployer"; do
  [[ "$address" =~ ^0x[0-9a-f]{40}$ ]] || die "deployments/testnet.json lacks the Base contracts of $engine (run scripts/deploy-base.sh)"
done
config="$(near_view "$engine" get_config)"
mpk="$(jq -r .ckd_public_key <<<"$config")"

# payout_id_of <tx status json>: the id in the transaction's own `payout_requested` event (the
# engine is shared, so the global payout counter can already count someone else's request).
payout_id_of() {
  near_tx_logs "$1" | sed -n 's/^EVENT_JSON://p' | jq -r 'select(.standard == "rose" and .event == "payout_requested") | .data.payout_id' | head -1
}

step_deposit() {
  if [[ -n "$receipt_file" ]]; then
    [[ -n "$stream_id" ]] || die "--receipt needs --stream"
    save_deposit_receipt "$(cat "$receipt_file")" "$stream_id"
    return
  fi
  local r="$BASE_RPC_URL"
  evm_signer "$evm_env"
  # A stream minted by an earlier run that stopped before its deposit is deposited, not minted again.
  [[ -n "$stream_id" ]] || stream_id="$(state_get 'if .steps.deposit == null then (.steps.mint.stream_id // empty) else empty end')"
  if [[ -z "$stream_id" ]]; then
    local mint minted_topic
    mint="$(cast send --rpc-url "$r" "${EVM_WALLET_ARGS[@]}" "$faucet" 'mintPosition(uint8)' 1 --json)"
    # The stream id is the third indexed topic of the faucet's own PositionMinted log in this
    # receipt (Sablier's nextStreamId is shared with every other user of the Lockup).
    minted_topic="$(cast sig-event 'PositionMinted(address,uint8,uint256)')"
    stream_id="$(jq -r --arg f "$faucet" --arg t "$minted_topic" \
      '[.logs[] | select((.address | ascii_downcase) == $f and .topics[0] == $t)][0].topics[3] // empty' <<<"$mint")"
    [[ -n "$stream_id" ]] || die "no PositionMinted log in $(jq -r .transactionHash <<<"$mint")"
    stream_id="$(cast to-dec "$stream_id")"
    state_set '.steps.mint' "$(jq -cn --argjson s "$stream_id" --arg h "$(jq -r .transactionHash <<<"$mint")" \
      '{stream_id:$s,base_tx:$h,link:("https://sepolia.basescan.org/tx/"+$h)}')"
    log "minted KOL demo stream $stream_id"
  fi
  if [[ "$(cast call --rpc-url "$r" "$SABLIER_LOCKUP" 'getApproved(uint256)(address)' "$stream_id" | tr '[:upper:]' '[:lower:]')" != "$vault" ]]; then
    cast send --rpc-url "$r" "${EVM_WALLET_ARGS[@]}" "$SABLIER_LOCKUP" 'approve(address,uint256)' "$vault" "$stream_id" --json >/dev/null
  fi
  local fee receipt
  fee="$(cast call --rpc-url "$r" "$SABLIER_LOCKUP" 'calculateMinFeeWei(uint256)(uint256)' "$stream_id")"
  receipt="$(cast send --rpc-url "$r" "${EVM_WALLET_ARGS[@]}" "$vault" 'depositStream(address,uint256,string)' \
    "$SABLIER_LOCKUP" "$stream_id" "$holder" --value "$fee" --json)"
  save_deposit_receipt "$receipt" "$stream_id"
}

# save_deposit_receipt <receipt json> <stream id>: extracts the StreamDeposited log for the engine.
save_deposit_receipt() {
  local receipt="$1" log_entry decoded
  log_entry="$(jq -c --arg v "$vault" '.logs[] | select(.address == $v)' <<<"$receipt")"
  decoded="$(cast abi-decode "f()(string,address,address,uint8,uint128,uint128,uint40,uint40,uint40,uint40,uint128,uint128,bool,bool,uint40)" "$(jq -r .data <<<"$log_entry")" | sed -E 's/ \[.*\]$//')"
  local fields
  fields="$(python3 - "$log_entry" "$decoded" "$2" <<'EOF'
import json, sys
log = json.loads(sys.argv[1]); lines = sys.argv[2].splitlines(); stream_id = int(sys.argv[3])
addr = lambda t: "0x" + t[-40:].lower()
print(json.dumps({
  "location": {"tx_hash": log["transactionHash"], "block_hash": log["blockHash"],
               "block_number": int(log["blockNumber"], 16), "transaction_index": int(log["transactionIndex"], 16),
               "log_index": int(log["logIndex"], 16)},
  "fields": {"sender": addr(log["topics"][1]), "stream_id": stream_id, "near_account": lines[0].strip('"'),
             "lockup": lines[1].lower(), "token": lines[2].lower(), "decimals": int(lines[3]),
             "deposited": lines[4], "withdrawn": lines[5], "start": int(lines[6]), "cliff": int(lines[7]),
             "end": int(lines[8]), "granularity": int(lines[9]), "start_unlock": lines[10], "cliff_unlock": lines[11],
             "cancelable": lines[12] == "true", "transferable": lines[13] == "true", "timestamp": int(lines[14])}}))
EOF
)"
  state_set '.steps.deposit' "$(jq -cn --argjson f "$fields" --arg h "$(jq -r .transactionHash <<<"$receipt")" \
    --argjson g "$(cast to-dec "$(jq -r .gasUsed <<<"$receipt")")" \
    '$f + {base_tx:$h,link:("https://sepolia.basescan.org/tx/"+$h),gas_used:$g}')"
  log "deposited stream $2 for $holder: $BASE_EXPLORER_TX/$(jq -r .transactionHash <<<"$receipt")"
}

step_register() {
  local args block safe
  args="$(jq -c '.steps.deposit | {location, fields}' "$STATE")"
  block="$(jq -r .location.block_number <<<"$args")"
  while :; do
    safe="$(cast block safe --rpc-url "$BASE_RPC_URL" -f number)"
    [[ "$safe" -ge "$block" ]] && break
    log "waiting for the Base safe head ($safe) to pass block $block"
    sleep 30
  done
  local f class deposit
  f="$(jq -c .fields <<<"$args")"
  class="$(near_view "$engine" compute_base_class_id "$(jq -c '{token, decimals, schedule:{start, cliff, end, granularity, start_unlock, cliff_unlock, deposited}}' <<<"$f")" | jq -r .)"
  deposit="$(near_view "$engine" registration_deposit_for "$(jq -cn --arg a "$holder" --arg c "$class" '{account:$a,class_id:$c}')" | jq -r .)"
  log "class $class, registration deposit $deposit yoctoNEAR"
  local hash status
  hash="$(near_call "$issuer" "$engine" register_base_deposit "$args" '80 Tgas' "$deposit yoctoNEAR")"
  status="$(record_near register "$hash" "$(jq -cn --arg c "$class" '{class_id:$c}')")"
  near_tx_logs "$status" | grep -o '"event":"[a-z_]*"' | tr '\n' ' ' >&2; echo >&2
  local replay
  replay="$(near_view "$engine" get_replay "$(jq -cn --arg t "${f:+$(jq -r .location.tx_hash <<<"$args" | sed 's/^0x//')}" --argjson i "$(jq -r .location.log_index <<<"$args")" '{key:{BaseLog:{tx_hash:$t,log_index:$i}}}')")"
  [[ "$replay" == '"Consumed"' ]] || die "deposit not registered: replay state $replay"
  local units
  units="$(near_view "$engine" mt_balance_of "$(jq -cn --arg a "$holder" --arg c "$class" '{account_id:$a,token_id:$c}')" | jq -r .)"
  state_set '.steps.register.units' "\"$units\""
  log "$holder holds $units units of $class"
}

# fund_near_cash <account> <amount in tUSDC base units>: mints tUSDC and deposits it as cash.
fund_near_cash() {
  local account="$1" amount="$2" registered
  registered="$(near_view "$NEAR_CASH_TOKEN" storage_balance_of "$(jq -cn --arg a "$account" '{account_id:$a}')")"
  local deposit='0 NEAR'
  [[ "$registered" == "null" ]] && deposit='0.00125 NEAR'
  near_call "$account" "$NEAR_CASH_TOKEN" mint "$(jq -cn --arg a "$amount" '{amount:$a}')" '30 Tgas' "$deposit" >/dev/null
  # The engine refuses a NEAR cash deposit without room for its cash row (172 bytes): register
  # with the minimum, or top up one row for an account already registered.
  local engine_storage='0.00172 NEAR'
  [[ "$(near_view "$engine" storage_balance_of "$(jq -cn --arg a "$account" '{account_id:$a}')")" == "null" ]] \
    && engine_storage="$(near_view "$engine" storage_balance_bounds '{}' | jq -r '.min') yoctoNEAR"
  near_call "$account" "$engine" storage_deposit '{"account_id":null,"registration_only":false}' '30 Tgas' "$engine_storage" >/dev/null
  near_call "$account" "$NEAR_CASH_TOKEN" ft_transfer_call "$(jq -cn --arg e "$engine" --arg a "$amount" '{receiver_id:$e,amount:$a,msg:""}')" '60 Tgas' '1 yoctoNEAR'
}

step_fund() {
  local engine_registered
  engine_registered="$(near_view "$NEAR_CASH_TOKEN" storage_balance_of "$(jq -cn --arg a "$engine" '{account_id:$a}')")"
  if [[ "$engine_registered" == "null" ]]; then
    near_call "$issuer" "$NEAR_CASH_TOKEN" storage_deposit "$(jq -cn --arg a "$engine" '{account_id:$a,registration_only:true}')" '30 Tgas' '0.00125 NEAR' >/dev/null
  fi
  local hash
  hash="$(fund_near_cash "$issuer" 20000000)"
  record_near fund_issuer "$hash" '{"amount":"20000000"}' >/dev/null
  hash="$(fund_near_cash "$holder" 2000000)"
  record_near fund_holder "$hash" '{"amount":"2000000"}' >/dev/null
  log "issuer cash $(near_view "$engine" get_cash "$(jq -cn --arg a "$issuer" '{account:$a}')" | jq -c .), holder cash $(near_view "$engine" get_cash "$(jq -cn --arg a "$holder" '{account:$a}')" | jq -c .)"
}

step_tender() {
  local class now closes
  class="$(state_get .steps.register.class_id)"
  now="$(date +%s)"
  closes=$(((now + 150) * 1000000000))
  local params hash status round
  params="$(jq -cn --arg c "$class" --arg r "$deployer" --arg closes "$closes" \
    '{params:{class_id:$c,venue:"Near",budget:"10000000",max_price:"10000",reference_price:"20000",retire_to:$r,window:{closes_at:$closes,reveal_window:"300000000000"}}}')"
  hash="$(near_call "$issuer" "$engine" create_tender "$params" '30 Tgas' '0.05 NEAR')"
  status="$(record_near tender "$hash")"
  round="$(jq -r '.status.SuccessValue' <<<"$status" | base64 -d | tr -d '"')"
  state_set '.steps.tender.round_id' "\"$round\""
  state_set '.steps.tender.closes_at' "\"$closes\""
  log "tender round $round closes at $((closes / 1000000000)) (budget 10 tUSDC, max price 0.01 tUSDC per locked CINDR)"
}

step_ask() {
  local round class sealed hash
  round="$(state_get .steps.tender.round_id)"
  class="$(state_get .steps.register.class_id)"
  sealed="$(node "$ROSE_ROOT/scripts/ibe.mjs" encrypt "$mpk" "$engine" "$round" "$holder" 1 1000000000000000000000 5000)"
  state_set '.steps.ask.sealed' "$sealed"
  hash="$(near_call "$holder" "$engine" place_ask "$(jq -cn --arg r "$round" --arg ct "$(jq -r .ciphertext_hex <<<"$sealed")" \
    '{round_id:$r,ciphertext_hex:$ct,units:"1000000000000000000000"}')" '30 Tgas' '0.02 NEAR')"
  local status bid
  status="$(record_near ask "$hash" '{"quantity":"1000000000000000000000","price":"5000"}')"
  bid="$(jq -r '.status.SuccessValue' <<<"$status" | base64 -d)"
  state_set '.steps.ask.bid_id' "$bid"
  log "sealed ask $bid placed: 1,000 CINDR at 0.005 tUSDC per locked token (hidden until the key is released)"
}

# Gas: this script signs with funded full-access keys, so it attaches its own limits instead of the
# SDK's GAS table (packages/sdk/src/engine/calls.ts), which keeps prepaid gas low for small demo
# wallets: close 60 Tgas (SDK 80, burns about 37.5), open_bid 300 Tgas (SDK 200, burns about 132),
# clear 100 Tgas (SDK 50, burns about 5). Unused prepaid gas is refunded.
step_close() {
  local round closes now hash status
  round="$(state_get .steps.tender.round_id)"
  closes=$(($(state_get .steps.tender.closes_at) / 1000000000))
  now="$(date +%s)"
  if [[ "$now" -lt "$closes" ]]; then
    log "waiting $((closes - now + 2)) s for the round to close"
    sleep $((closes - now + 2))
  fi
  hash="$(near_call "$issuer" "$engine" close "$(jq -cn --arg r "$round" '{round_id:$r}')" '60 Tgas' '0 NEAR')"
  status="$(record_near close "$hash")"
  local ckd key
  ckd="$(jq -r '[.receipts_outcome[] | select(.outcome.executor_id == "v1.signer-prod.testnet") | .outcome.status.SuccessValue // empty][0]' <<<"$status" | base64 -d)"
  key="$(near_view "$engine" get_round "$(jq -cn --arg r "$round" '{round_id:$r}')" | jq -r .key)"
  [[ "$key" == bls12381g1:* ]] || die "no key stored after close: $key"
  state_set '.steps.close.ckd_response' "$ckd"
  state_set '.steps.close.key' "\"$key\""
  state_set '.steps.close.unwrapped_offline' "\"$(node "$ROSE_ROOT/scripts/ibe.mjs" unwrap "$engine" "$round" "$(jq -r .big_y <<<"$ckd")" "$(jq -r .big_c <<<"$ckd")")\""
  log "round key $key (CKD response big_y/big_c recorded)"
}

step_open() {
  local round bid key sealed opened plaintext hash
  round="$(state_get .steps.tender.round_id)"
  bid="$(state_get .steps.ask.bid_id)"
  key="$(state_get .steps.close.key)"
  sealed="$(jq -c .steps.ask.sealed "$STATE")"
  opened="$(node "$ROSE_ROOT/scripts/ibe.mjs" decrypt "$mpk" "$engine" "$round" "$key" "$(jq -r .ciphertext_hex <<<"$sealed")" "$holder" 1)"
  plaintext="$(node "$ROSE_ROOT/scripts/ibe.mjs" plaintext "$(jq -r .quantity <<<"$opened")" "$(jq -r .limit_price <<<"$opened")" "$(jq -r .salt <<<"$opened")")"
  hash="$(near_call "$issuer" "$engine" open_bid "$(jq -cn --arg r "$round" --argjson b "$bid" --arg p "$plaintext" --arg s "$(jq -r .sigma <<<"$opened")" \
    '{round_id:$r,bid_id:$b,plaintext_hex:$p,sigma_hex:$s}')" '300 Tgas' '0 NEAR')"
  record_near open "$hash" >/dev/null
  local view
  view="$(near_view "$engine" get_bid "$(jq -cn --arg r "$round" --argjson b "$bid" '{round_id:$r,bid_id:$b}')")"
  log "opened by $issuer, not the bidder $holder: $(jq -c '.opened' <<<"$view")"
}

step_clear() {
  local round view ends now hash
  round="$(state_get .steps.tender.round_id)"
  view="$(near_view "$engine" get_round "$(jq -cn --arg r "$round" '{round_id:$r}')")"
  ends=$(($(jq -r .reveal_ends_at <<<"$view") / 1000000000))
  now="$(date +%s)"
  if [[ "$now" -lt "$ends" ]]; then
    log "waiting $((ends - now + 2)) s for the reveal window"
    sleep $((ends - now + 2))
  fi
  hash="$(near_call "$issuer" "$engine" clear "$(jq -cn --arg r "$round" '{round_id:$r}')" '100 Tgas' '0 NEAR')"
  record_near clear "$hash" >/dev/null
  local result
  result="$(near_view "$engine" get_round_result "$(jq -cn --arg r "$round" '{round_id:$r}')")"
  state_set '.steps.clear.result' "$(jq -c '{price, volume, notional, fee, issuer_charged, issuer_refund}' <<<"$result")"
  log "cleared: $(jq -c '{price, volume, notional, fee, issuer_refund}' <<<"$result")"
}

step_settle() {
  local round bid hash
  round="$(state_get .steps.tender.round_id)"
  bid="$(state_get .steps.ask.bid_id)"
  hash="$(near_call "$issuer" "$engine" settle_bid "$(jq -cn --arg r "$round" --argjson b "$bid" '{round_id:$r,bid_id:$b}')" '50 Tgas' '0 NEAR')"
  record_near settle "$hash" >/dev/null
  log "holder cash after settlement: $(near_view "$engine" get_cash "$(jq -cn --arg a "$holder" '{account:$a}')" | jq -c .)"
}

step_claim() {
  local class claimable hash status payout_id payout
  class="$(state_get .steps.register.class_id)"
  hash="$(state_get '.steps.claim.near_tx // empty')"
  if [[ -n "$hash" ]]; then
    # An earlier run sent the claim and stopped before storing its authorization: resume it.
    log "claim already sent: $NEAR_EXPLORER_TX/$hash"
    status="$(near_tx_status "$hash" "$holder")"
  else
    claimable="$(near_view "$engine" get_claimable "$(jq -cn --arg a "$holder" --arg c "$class" '{account:$a,class_id:$c}')" | jq -r .)"
    [[ "$claimable" != "0" ]] || die "nothing claimable yet (the stream unlocks continuously: wait a little)"
    hash="$(near_call "$holder" "$engine" claim_base_tokens "$(jq -cn --arg c "$class" --arg a "$claimable" --arg t "$deployer" \
      '{source:{Holding:{class_id:$c}},amount:$a,to:$t}')" '80 Tgas' '0.025 NEAR')"
    status="$(record_near claim "$hash" "$(jq -cn --arg a "$claimable" --arg t "$deployer" '{amount:$a,to:$t}')")"
  fi
  payout_id="$(payout_id_of "$status")"
  [[ -n "$payout_id" ]] || die "no payout_requested event in $hash"
  for _ in $(seq 1 30); do
    payout="$(near_view "$engine" get_payout "$(jq -cn --arg id "$payout_id" '{payout_id:$id}')")"
    [[ "$(jq -r '.status | tostring' <<<"$payout")" == "Signed" || "$(jq -r '.status | type' <<<"$payout")" == "object" ]] && break
    sleep 3
  done
  [[ "$(jq -r .status <<<"$payout")" == "Signed" ]] || die "payout $payout_id not signed: $(jq -c .status <<<"$payout")"
  state_set '.steps.claim.payout' "$(jq -c '{id, kind, digest, base}' <<<"$payout")"
  log "authorization signed: $(jq -c '{id, base}' <<<"$payout")"
}

step_execute() {
  local r="$BASE_RPC_URL" payout stream
  evm_signer "$evm_env"
  payout="$(jq -c .steps.claim.payout "$STATE")"
  stream="$(state_get .steps.deposit.fields.stream_id)"
  # Anyone may withdraw the stream's vested balance to its recipient (the vault); Sablier
  # reverts on a zero withdrawal, so skip it when nothing has vested since the last one.
  if [[ "$(cast call --rpc-url "$r" "$SABLIER_LOCKUP" 'withdrawableAmountOf(uint256)(uint128)' "$stream" | awk '{print $1}')" != "0" ]]; then
    local withdraw fee
    # Sablier's withdrawal fee is admin-controlled (spec 6): pay what the Lockup asks for now.
    fee="$(cast call --rpc-url "$r" "$SABLIER_LOCKUP" 'calculateMinFeeWei(uint256)(uint256)' "$stream" | awk '{print $1}')"
    withdraw="$(cast send --rpc-url "$r" "${EVM_WALLET_ARGS[@]}" "$SABLIER_LOCKUP" 'withdrawMax(uint256,address)' "$stream" "$vault" --value "$fee" --json)"
    state_set '.steps.withdraw_max' "$(jq -c '{base_tx:.transactionHash,link:("https://sepolia.basescan.org/tx/"+.transactionHash),gas_used:.gasUsed}' <<<"$withdraw")"
    log "withdrawMax($stream, vault): $BASE_EXPLORER_TX/$(jq -r .transactionHash <<<"$withdraw")"
  fi
  local id amount to v rr ss receipt
  id="$(jq -r .id <<<"$payout")"
  amount="$(jq -r .kind.BaseTransfer.amount <<<"$payout")"
  to="$(jq -r .kind.BaseTransfer.to <<<"$payout")"
  v="$(jq -r .base.v <<<"$payout")"; rr="0x$(jq -r .base.r <<<"$payout")"; ss="0x$(jq -r .base.s <<<"$payout")"
  receipt="$(cast send --rpc-url "$r" "${EVM_WALLET_ARGS[@]}" "$vault" \
    'executeTransfer((address,address,uint256,uint256),uint8,bytes32,bytes32)' "($token,$to,$amount,$id)" "$v" "$rr" "$ss" --json)"
  state_set '.steps.execute' "$(jq -c '{base_tx:.transactionHash,link:("https://sepolia.basescan.org/tx/"+.transactionHash),status:.status,gas_used:.gasUsed}' <<<"$receipt")"
  log "executeTransfer: $BASE_EXPLORER_TX/$(jq -r .transactionHash <<<"$receipt") status $(jq -r .status <<<"$receipt")"
  log "used($id) = $(cast call --rpc-url "$r" "$vault" 'isAuthorizationUsed(uint256)(bool)' "$id"), recipient balance $(cast call --rpc-url "$r" "$token" 'balanceOf(address)(uint256)' "$to")"
}

run_step() {
  case "$1" in
    record) record_near "$record_step" "$record_hash" >/dev/null ;;
    deposit) step_deposit ;;
    register) step_register ;;
    fund) step_fund ;;
    tender) step_tender ;;
    ask) step_ask ;;
    close) step_close ;;
    open) step_open ;;
    clear) step_clear ;;
    settle) step_settle ;;
    claim) step_claim ;;
    execute) step_execute ;;
    *) die "unknown step $1" ;;
  esac
}

if [[ "$step" == "all" ]]; then
  for s in deposit register fund tender ask close open clear settle claim execute; do run_step "$s"; done
else
  run_step "$step"
fi
