#!/usr/bin/env sh
# Builds contracts/ibe with the `wasm` feature and runs wasm-bindgen (0.2.130, pinned to the crate's
# wasm-bindgen version) into pkg/. Runs from any directory (it changes to the repository root);
# needs the wasm32-unknown-unknown target.
set -eu
cd "$(dirname "$0")/../.."
cargo rustc -p rose-ibe --lib --crate-type cdylib --target wasm32-unknown-unknown --release \
  --no-default-features --features wasm
wasm-bindgen --target web --typescript --out-dir packages/ibe-wasm/pkg --out-name rose_ibe \
  target/wasm32-unknown-unknown/release/rose_ibe.wasm
rm -f packages/ibe-wasm/pkg/.gitignore packages/ibe-wasm/pkg/package.json
