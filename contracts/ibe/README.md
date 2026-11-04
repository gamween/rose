# rose-ibe

Boneh-Franklin identity-based encryption (FullIdent, Fujisaki-Okamoto transform) over BLS12-381 for rose sealed bids. Bids are encrypted in the browser to a round identity whose private key only the NEAR MPC network can produce, through Confidential Key Derivation (CKD, domain 2 of `v1.signer-prod.testnet`). The engine requests that key after the round closes, checks it with one pairing check, and verifies every opening on chain.

The same crate compiles to the browser (wasm-bindgen) and into the NEAR contract (host functions), so encryption and verification share one implementation.

Testnet only.

## Features

| Feature | Default | Purpose |
|---|---|---|
| `std` | yes | Standard library. Without it the crate is `no_std` + `alloc`. |
| `near` | no | `rose_ibe::host`: BLS12-381 through NEAR host functions (NEP-488): `verify_key_host`, `ckd_unwrap_host`, `verify_opening_host`, `app_public_key_pv_host`. |
| `wasm` | no | `rose_ibe::wasm`: browser API built with wasm-bindgen; randomness from `crypto.getRandomValues`. |

The engine depends on it with `default-features = false, features = ["near"]`.

## Build and test

The workspace pins Rust 1.95.0 (`rust-toolchain.toml`, required by near-sdk 5.30).

```sh
cargo test -p rose-ibe                  # pure backend and live testnet vectors
cargo test -p rose-ibe --all-features   # adds the host-function backend tests
cargo clippy -p rose-ibe --all-targets --all-features -- -D warnings

# Contract backend
cargo build -p rose-ibe --target wasm32-unknown-unknown --release --no-default-features --features near

# Browser package (wasm-bindgen-cli must match the wasm-bindgen crate version, 0.2.130)
cargo install wasm-bindgen-cli --version 0.2.130 --locked
cargo rustc -p rose-ibe --lib --crate-type cdylib --target wasm32-unknown-unknown --release \
  --no-default-features --features wasm
wasm-bindgen --target web --out-dir <out> target/wasm32-unknown-unknown/release/rose_ibe.wasm
```

The browser module is 216 KB (83 KB gzipped).

## Browser API (`wasm`)

Points are NEAR strings (`bls12381g1:<base58>`, `bls12381g2:<base58>`), ciphertexts are `Uint8Array`, amounts are u128 decimal strings, salts and `sigma` are lowercase hex. `round_id` is a `bigint`, `side` a number.

| Function | Returns |
|---|---|
| `derive_app_id_hex(engine_account, round_id)` | hex of the round `app_id` |
| `encrypt_bid(mpk, engine_account, round_id, bidder, side, quantity, limit_price)` | `{ ciphertext, salt }` |
| `decrypt_bid(mpk, engine_account, round_id, key, ciphertext, bidder, side)` | `{ quantity, limit_price, salt, sigma }`, after checking `key` against `mpk` |
| `verify_key(mpk, engine_account, round_id, key)` | `boolean` |
| `ckd_unwrap(engine_account, round_id, big_y, big_c)` | round key as `bls12381g1:<base58>` |

`(plaintext, sigma)` returned by `decrypt_bid` is exactly what the engine's opening method verifies.

## Byte layouts

All hashes are SHA-256 unless stated. `||` is concatenation, `LE` little-endian.

- **Round identity**: `app_id = SHA3-256("near-mpc v0.1.0 app_id derivation:" || engine_account || "," || "round/" || decimal(round_id))`, identical to near/mpc `derive_app_id(predecessor, path)` with the engine as predecessor and `round/<id>` as derivation path.
- **Identity point**: `H = hash_to_curve_G1(compress(mpk) || app_id)`, RFC 9380 `BLS12381G1_XMD:SHA-256_SSWU_RO_` with DST `NEAR BLS12381G1_XMD:SHA-256_SSWU_RO_`, where `compress(mpk)` is the 96-byte compressed domain 2 key.
- **Round key**: `sk = msk * H` (compressed G1, 48 bytes), valid iff `sk != 0` and `e(sk, G2) = e(H, mpk)`.
- **App scalar** (public, for the `AppPublicKeyPV` request): `a = LE(SHA-256("rose-ibe/v1/app-scalar" || 0x00 || engine_account || "," || round_id u64 LE) || SHA-256("rose-ibe/v1/app-scalar" || 0x01 || ...)) mod r`; the request carries `pk1 = a * G1`, `pk2 = a * G2`. The CKD response `(Y, C)` unwraps to `sk = C - a * Y`. Because `a` is public, anyone can unwrap the response, which is the point: the key is public once released.
- **Plaintext** (48 bytes): `quantity u128 LE (16) || limit_price u128 LE (16) || salt (16)`.
- **Associated data** `ad`: Borsh encoding of `(round_id: u64, bidder: String, side: u8)`, that is `round_id u64 LE || len(bidder) u32 LE || bidder UTF-8 || side u8`.
- **Ciphertext** (192 bytes, constant): `U (96, compressed G2) || V (32) || W (64)`, where
  - `sigma` is 32 random bytes,
  - `r = LE(SHA-256("rose-ibe/v1/H3-r" || i || app_id || len(ad) u32 LE || ad || sigma || plaintext) for i in 0x00, 0x01) mod r` (64 bytes reduced),
  - `U = r * G2`,
  - `V = sigma XOR SHA-256("rose-ibe/v1/H2-mask" || U || gt)`, with `gt` the arkworks compressed serialization (576 bytes) of `e(H, mpk)^r = e(H, r * mpk)`: the Fq12 element `c0 + c1 * w` written as `c0 || c1`, each Fq6 as `c0 || c1 || c2`, each Fq2 as `c0 || c1`, and each Fq as 48 bytes little-endian (arkworks `CanonicalSerialize` of a field extension: coefficients in ascending order, no compression flags since Fq12 is not a curve point),
  - `W = ChaCha20-Poly1305(key = SHA-256("rose-ibe/v1/H4-aead-key" || sigma), nonce = 0^12, aad = "rose-ibe/v1/aad" || U || V || app_id || ad, plaintext)` (48 bytes + 16-byte tag).
- **Opening**: `(plaintext, sigma)`. It is valid iff `U = r * G2` for `r` recomputed from `(app_id, ad, sigma, plaintext)`, `V XOR SHA-256("rose-ibe/v1/H2-mask" || U || e(sk, U)) = sigma`, and the AEAD opens `W` to `plaintext` under `ad`. This is the FO check of decryption, so a ciphertext that does not decrypt (for example an inconsistent `V`) has no valid opening, and a ciphertext copied to another bidder, side or round has none either (`ad` enters both `r` and the AAD).

## Contract usage (`near`)

- `verify_key_host(mpk, app_id, key) -> Option<VerifiedKey>`: one `bls12381_pairing_check`; use it in the CKD callback and in an open `submit_key`. `VerifiedKey` is the only key type the opening check takes; `VerifiedKey::from_stored` wraps bytes the contract stored after that check.
- `ckd_unwrap_host(a, big_y, big_c)`: `C - a * Y` through `bls12381_g1_multiexp`; the result must still pass `verify_key_host`.
- `verify_opening_host(app_id, &VerifiedKey, ct, ad, plaintext, sigma)`: the `U` check through `bls12381_g2_multiexp`, then one pairing in wasm for `V`, then the AEAD.
- NEP-488 decompression (`bls12381_p1_decompress`, `bls12381_p2_decompress`) checks the curve but not the subgroup. Every untrusted point is therefore passed through a multiexp or the pairing check, which do reject points outside the subgroup, before it is relied on.

Measured on NEAR testnet on 2026-11-04 with a throwaway contract using this crate (`v1.signer-prod.testnet` 3.18.0):

| Step | Gas |
|---|---|
| `request_app_private_key` attachment | 19 Tgas minimum (15 and 18 fail with the live config: 15 Tgas requirement plus 7 Tgas reserved for the yield return); use at least 25 |
| Close: request + MPC + callback (unwrap 2.5, pairing check 8.0) | 35.0 Tgas total, callback 12.4 Tgas |
| `submit_key` (pairing check 8.0) | 10.2 Tgas |
| Opening, fully verified | 124.3 to 124.4 Tgas (0.0124 NEAR) |
| Rejected opening of a malformed ciphertext | 124.0 Tgas |
| Rejected opening of a copied ciphertext (fails at `U`) | 4.4 Tgas |

CKD latency: 2.9 to 3.8 s from the request receipt to the MPC response, 4.2 to 4.8 s from the close transaction to the stored key (block timestamps).

`tests/testnet_vectors.rs` replays the live round: the domain 2 key, a real CKD output, ciphertexts encrypted in Node and in headless Chromium, a malformed ciphertext and a key recovered through `submit_key` after a lost callback, with the transaction hashes.

## Third-party code

This crate is a port of `sealwell-ibe` from [Godwin-web3/sealwell](https://github.com/Godwin-web3/sealwell) (commit `66667c06956e7dc5f1f63a62861ca81f8a54a5d1`), licensed MIT OR Apache-2.0 and used here under the MIT license. The host-function backend is ported from `contracts/sealwell-auction/src/host.rs` of the same repository.

Changes from upstream:

- Fixed-size binary plaintext (`quantity`, `limit_price`, `salt`, 48 bytes) instead of padded JSON, so every ciphertext is 192 bytes.
- Associated data `(round_id, bidder, side)` bound into both the FO scalar `r` and the AEAD associated data.
- Domain tags under `rose-ibe/v1/`; the AEAD associated data starts with its own tag.
- Per-round identities (`round/<id>` under the engine account) and a deterministic public app scalar per (engine, round).
- Full opening check (`verify_opening`, `verify_opening_host`) over the raw 192-byte ciphertext, with the same semantics in the pure and host backends.
- Host backend updated to near-sdk 5.30, whose BLS12-381 functions return `Option`; invalid points yield `false` or `None` instead of aborting, and the subgroup caveat of NEP-488 decompression is handled explicitly.
- `no_std` support, a browser API returning `sigma` for openings, and test vectors regenerated against the live domain 2 key.

Upstream notice:

```
MIT License

Copyright (c) 2026 Godwin-web3

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
