#!/usr/bin/env sh
# Builds contracts/ibe with the `wasm` feature and runs wasm-bindgen (0.2.130, pinned to the crate's
# wasm-bindgen version) into pkg/. Runs from any directory (it changes to the repository root);
# needs the wasm32-unknown-unknown target.
set -eu
cd "$(dirname "$0")/../.."
# Strip local paths (home directory, cargo registry, checkout) from the panic locations the
# committed binary embeds, so the output does not depend on who built it or where.
RUSTFLAGS="${RUSTFLAGS:-} --remap-path-prefix=${CARGO_HOME:-$HOME/.cargo}=/cargo --remap-path-prefix=$(pwd)=/rose"
export RUSTFLAGS
cargo rustc -p rose-ibe --lib --crate-type cdylib --target wasm32-unknown-unknown --release \
  --no-default-features --features wasm
wasm-bindgen --target web --typescript --out-dir packages/ibe-wasm/pkg --out-name rose_ibe \
  target/wasm32-unknown-unknown/release/rose_ibe.wasm
rm -f packages/ibe-wasm/pkg/.gitignore packages/ibe-wasm/pkg/package.json
