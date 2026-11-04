#!/usr/bin/env bash
# Prints the EVM address of the rose engine's Base vault key: derived_public_key("vault/base",
# <engine account>, domain 0) read from the MPC contract, mapped to an address exactly as the
# engine does (keccak-256 of the 64 uncompressed key bytes, last 20 bytes). The engine account does
# not need to exist yet: the derivation only depends on its name, which is how RoseVault can be
# deployed with the right signer before the engine.
#
# Usage: scripts/derive-vault-signer.sh <engine account> [--all]
#   --all also prints the Solana vault (vault/sol) and gas payer (gas/sol) addresses, one per line
#   as `name=value`.

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_tools curl jq cast python3

engine="${1:-}"
[[ -n "$engine" ]] || die "usage: $0 <engine account> [--all]"
[[ "$engine" == *.testnet ]] || die "testnet only: the engine account must end with .testnet"

vault_base_key="$(mpc_derived_key vault/base "$engine" "$MPC_DOMAIN_SECP256K1")"
vault_base="$(evm_address_of_near_secp256k1 "$vault_base_key")"

if [[ "${2:-}" == "--all" ]]; then
  vault_sol="$(mpc_derived_key vault/sol "$engine" "$MPC_DOMAIN_ED25519")"
  gas_sol="$(mpc_derived_key gas/sol "$engine" "$MPC_DOMAIN_ED25519")"
  printf 'vault_base=%s\nvault_base_key=%s\nvault_sol=%s\ngas_sol=%s\n' \
    "$vault_base" "$vault_base_key" "${vault_sol#ed25519:}" "${gas_sol#ed25519:}"
else
  printf '%s\n' "$vault_base"
fi
