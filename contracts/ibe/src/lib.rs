//! # rose-ibe
//!
//! Boneh-Franklin identity-based encryption (FullIdent, Fujisaki-Okamoto transform) for rose
//! sealed bids, keyed to identities whose private keys are released by the NEAR MPC network's
//! Confidential Key Derivation (CKD, domain 2, BLS12-381).
//!
//! Ported from `sealwell-ibe` (<https://github.com/Godwin-web3/sealwell>, MIT OR Apache-2.0,
//! Copyright (c) 2026 Godwin-web3). The changes are listed in this crate's README
//! ("Third-party code"): fixed-size binary plaintext, associated data binding
//! `(round_id, bidder, side)`, `rose-ibe/v1/` domain tags, per-round identities and app
//! scalars, a NEAR host-function backend (`near` feature) and a browser API (`wasm` feature).
//!
//! * Identity: `app_id = SHA3-256("near-mpc v0.1.0 app_id derivation:" || engine || "," || "round/<id>")`.
//! * Identity point: `H = hash_to_curve_G1(compress(mpk) || app_id)`, RFC 9380 with the NEAR CKD DST.
//! * Identity key (released by CKD): `sk = msk * H`, checked by `e(sk, G2) == e(H, mpk)`.
//! * Ciphertext: `U = r * G2`, `V = sigma XOR H2(U, e(H, mpk)^r)`, `W = AEAD_{H4(sigma)}(M)` with
//!   `r = H3(app_id, ad, sigma, M)`.
//!
//! Byte layouts are documented in the crate README. Testnet only.

#![cfg_attr(not(feature = "std"), no_std)]
#![forbid(unsafe_code)]

extern crate alloc;

use alloc::{string::String, vec::Vec};
use core::fmt;

use ark_bls12_381::{g1, Bls12_381, G1Projective};
/// Curve types used by this crate's API (arkworks BLS12-381).
pub use ark_bls12_381::{Fr, G1Affine, G2Affine};
use ark_ec::{
    hashing::{curve_maps::wb::WBMap, map_to_curve_hasher::MapToCurveBasedHasher, HashToCurve},
    pairing::Pairing,
    AffineRepr, CurveGroup,
};
use ark_ff::{field_hashers::DefaultFieldHasher, PrimeField};
use ark_serialize::{CanonicalDeserialize, CanonicalSerialize};
use chacha20poly1305::{
    aead::{Aead, KeyInit, Payload},
    ChaCha20Poly1305, Nonce,
};
use rand_core::{CryptoRng, RngCore};
use sha2::{Digest, Sha256};
use sha3::Sha3_256;

#[cfg(feature = "near")]
pub mod host;
#[cfg(feature = "wasm")]
pub mod wasm;

/// Prefix used by near/mpc `kdf::derive_app_id`.
pub const APP_ID_DERIVATION_PREFIX: &str = "near-mpc v0.1.0 app_id derivation:";
/// Hash-to-curve DST used by the NEAR MPC contract for CKD identity points.
pub const NEAR_CKD_DST: &[u8] = b"NEAR BLS12381G1_XMD:SHA-256_SSWU_RO_";

/// Length of the FO randomness `sigma`.
pub const SIGMA_LEN: usize = 32;
/// Length of the plaintext salt.
pub const SALT_LEN: usize = 16;
/// Length of an encoded plaintext: `quantity (16) || limit_price (16) || salt (16)`.
pub const PLAINTEXT_LEN: usize = 16 + 16 + SALT_LEN;
/// Length of a compressed G1 point.
pub const G1_LEN: usize = 48;
/// Length of a compressed G2 point.
pub const G2_LEN: usize = 96;
/// Length of the Poly1305 tag.
pub const TAG_LEN: usize = 16;
/// Length of `W`: encrypted plaintext and tag.
pub const W_LEN: usize = PLAINTEXT_LEN + TAG_LEN;
/// Length of every ciphertext: `U (96) || V (32) || W (64)`.
pub const CIPHERTEXT_LEN: usize = G2_LEN + SIGMA_LEN + W_LEN;

const TAG_H2: &[u8] = b"rose-ibe/v1/H2-mask";
const TAG_H3: &[u8] = b"rose-ibe/v1/H3-r";
const TAG_H4: &[u8] = b"rose-ibe/v1/H4-aead-key";
const TAG_AAD: &[u8] = b"rose-ibe/v1/aad";
const TAG_APP_SCALAR: &[u8] = b"rose-ibe/v1/app-scalar";

/// Errors returned by parsing and decryption.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Error {
    /// A value is not correctly encoded.
    Encoding(&'static str),
    /// The identity key does not verify against the master public key and identity.
    BadKey,
    /// The AEAD rejected the ciphertext (wrong key, wrong associated data or tampering).
    Decrypt,
    /// The ciphertext fails the Fujisaki-Okamoto consistency check.
    NotWellFormed,
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Encoding(what) => write!(f, "invalid encoding: {what}"),
            Error::BadKey => f.write_str("identity key does not verify against mpk and identity"),
            Error::Decrypt => f.write_str("decryption failed"),
            Error::NotWellFormed => f.write_str("ciphertext fails the FO consistency check"),
        }
    }
}

#[cfg(feature = "std")]
impl std::error::Error for Error {}

/// Result alias for this crate.
pub type Result<T> = core::result::Result<T, Error>;

/// 32-byte CKD application id.
pub type AppId = [u8; 32];

/// `app_id = SHA3-256(prefix || account || "," || path)`, identical to near/mpc `derive_app_id`.
pub fn derive_app_id(account_id: &str, derivation_path: &str) -> AppId {
    let mut h = Sha3_256::new();
    h.update(APP_ID_DERIVATION_PREFIX.as_bytes());
    h.update(account_id.as_bytes());
    h.update(b",");
    h.update(derivation_path.as_bytes());
    h.finalize().into()
}

/// CKD derivation path of a round: `round/<id>`.
pub fn round_path(round_id: u64) -> String {
    alloc::format!("round/{round_id}")
}

/// Identity of a round of the engine deployed at `engine_account`.
pub fn round_app_id(engine_account: &str, round_id: u64) -> AppId {
    derive_app_id(engine_account, &round_path(round_id))
}

/// Public app scalar `a` of the `AppPublicKeyPV` request for a round:
/// `a = LE(SHA-256(tag || 0 || engine || "," || round_id_le) || SHA-256(tag || 1 || ...)) mod r`.
///
/// It is public on purpose: with a public `a`, anyone can unwrap the CKD output `(Y, C)` into the
/// round key, which is exactly what a sealed-bid reveal needs.
pub fn app_scalar(engine_account: &str, round_id: u64) -> Fr {
    let mut wide = [0u8; 64];
    for (i, chunk) in wide.chunks_mut(32).enumerate() {
        let mut h = Sha256::new();
        h.update(TAG_APP_SCALAR);
        h.update([i as u8]);
        h.update(engine_account.as_bytes());
        h.update(b",");
        h.update(round_id.to_le_bytes());
        chunk.copy_from_slice(&h.finalize());
    }
    Fr::from_le_bytes_mod_order(&wide)
}

/// The public pair `(pk1, pk2) = (a * G1, a * G2)` of an `AppPublicKeyPV` request.
pub fn app_public_key_pv(a: &Fr) -> (G1Affine, G2Affine) {
    (
        (G1Affine::generator() * a).into_affine(),
        (G2Affine::generator() * a).into_affine(),
    )
}

/// Compressed (ZCash format) encoding of a G1 point.
pub fn g1_to_bytes(p: &G1Affine) -> [u8; G1_LEN] {
    let mut out = [0u8; G1_LEN];
    p.serialize_compressed(&mut out[..])
        .expect("a G1 point compresses to 48 bytes");
    out
}

/// Compressed (ZCash format) encoding of a G2 point.
pub fn g2_to_bytes(p: &G2Affine) -> [u8; G2_LEN] {
    let mut out = [0u8; G2_LEN];
    p.serialize_compressed(&mut out[..])
        .expect("a G2 point compresses to 96 bytes");
    out
}

/// Decode a compressed G1 point (curve and subgroup checked).
pub fn g1_from_bytes(b: &[u8]) -> Result<G1Affine> {
    G1Affine::deserialize_compressed(b).map_err(|_| Error::Encoding("G1 point"))
}

/// Decode a compressed G2 point (curve and subgroup checked).
pub fn g2_from_bytes(b: &[u8]) -> Result<G2Affine> {
    G2Affine::deserialize_compressed(b).map_err(|_| Error::Encoding("G2 point"))
}

fn strip_b58<const N: usize>(s: &str, prefix: &str) -> Result<[u8; N]> {
    let body = s
        .strip_prefix(prefix)
        .ok_or(Error::Encoding("missing curve prefix"))?;
    let bytes = bs58::decode(body)
        .into_vec()
        .map_err(|_| Error::Encoding("base58"))?;
    bytes
        .try_into()
        .map_err(|_| Error::Encoding("point length"))
}

/// Bytes of a NEAR `bls12381g1:<base58>` string, without decompressing the point.
pub fn parse_near_g1_bytes(s: &str) -> Result<[u8; G1_LEN]> {
    strip_b58(s, "bls12381g1:")
}

/// Bytes of a NEAR `bls12381g2:<base58>` string, without decompressing the point.
pub fn parse_near_g2_bytes(s: &str) -> Result<[u8; G2_LEN]> {
    strip_b58(s, "bls12381g2:")
}

/// Parse a NEAR `bls12381g1:<base58>` string into a checked point.
pub fn parse_near_g1(s: &str) -> Result<G1Affine> {
    g1_from_bytes(&parse_near_g1_bytes(s)?)
}

/// Parse a NEAR `bls12381g2:<base58>` string into a checked point.
pub fn parse_near_g2(s: &str) -> Result<G2Affine> {
    g2_from_bytes(&parse_near_g2_bytes(s)?)
}

/// Format compressed G1 bytes as a NEAR `bls12381g1:<base58>` string.
pub fn format_near_g1_bytes(b: &[u8; G1_LEN]) -> String {
    alloc::format!("bls12381g1:{}", bs58::encode(b).into_string())
}

/// Format compressed G2 bytes as a NEAR `bls12381g2:<base58>` string.
pub fn format_near_g2_bytes(b: &[u8; G2_LEN]) -> String {
    alloc::format!("bls12381g2:{}", bs58::encode(b).into_string())
}

/// Format a G1 point as a NEAR `bls12381g1:<base58>` string.
pub fn format_near_g1(p: &G1Affine) -> String {
    format_near_g1_bytes(&g1_to_bytes(p))
}

/// Format a G2 point as a NEAR `bls12381g2:<base58>` string.
pub fn format_near_g2(p: &G2Affine) -> String {
    format_near_g2_bytes(&g2_to_bytes(p))
}

/// RFC 9380 `BLS12381G1_XMD:SHA-256_SSWU_RO_` with the NEAR CKD DST.
pub fn hash_to_g1(msg: &[u8]) -> G1Affine {
    MapToCurveBasedHasher::<G1Projective, DefaultFieldHasher<Sha256, 128>, WBMap<g1::Config>>::new(
        NEAR_CKD_DST,
    )
    .expect("the NEAR CKD DST is a valid DST")
    .hash(msg)
    .expect("hash_to_curve is total")
}

/// CKD identity point `H = hash_to_g1(compress(mpk) || app_id)`.
pub fn identity_point(mpk: &G2Affine, app_id: &AppId) -> G1Affine {
    let mut input = Vec::with_capacity(G2_LEN + 32);
    input.extend_from_slice(&g2_to_bytes(mpk));
    input.extend_from_slice(app_id);
    hash_to_g1(&input)
}

/// Check an identity key: `key != 0` and `e(key, G2) == e(H(mpk, app_id), mpk)`.
pub fn verify_key(mpk: &G2Affine, app_id: &AppId, key: &G1Affine) -> bool {
    if key.is_zero() {
        return false;
    }
    let h = identity_point(mpk, app_id);
    Bls12_381::pairing(*key, G2Affine::generator()) == Bls12_381::pairing(h, *mpk)
}

/// Unwrap a CKD output `(Y, C)` with the app scalar `a`: `key = C - a * Y`.
pub fn ckd_unwrap(a: &Fr, big_y: &G1Affine, big_c: &G1Affine) -> G1Affine {
    (G1Projective::from(*big_c) - *big_y * a).into_affine()
}

/// A sealed order: `quantity: u128 LE || limit_price: u128 LE || salt: [u8; 16]`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Plaintext {
    /// Quantity of units (smallest denomination).
    pub quantity: u128,
    /// Limit price per locked token (smallest cash denomination).
    pub limit_price: u128,
    /// Random salt so equal orders give unrelated plaintexts.
    pub salt: [u8; SALT_LEN],
}

impl Plaintext {
    /// Encode as 48 bytes.
    pub fn to_bytes(&self) -> [u8; PLAINTEXT_LEN] {
        let mut out = [0u8; PLAINTEXT_LEN];
        out[..16].copy_from_slice(&self.quantity.to_le_bytes());
        out[16..32].copy_from_slice(&self.limit_price.to_le_bytes());
        out[32..].copy_from_slice(&self.salt);
        out
    }

    /// Decode 48 bytes.
    pub fn from_bytes(b: &[u8; PLAINTEXT_LEN]) -> Self {
        let mut q = [0u8; 16];
        let mut p = [0u8; 16];
        let mut salt = [0u8; SALT_LEN];
        q.copy_from_slice(&b[..16]);
        p.copy_from_slice(&b[16..32]);
        salt.copy_from_slice(&b[32..]);
        Self {
            quantity: u128::from_le_bytes(q),
            limit_price: u128::from_le_bytes(p),
            salt,
        }
    }
}

/// Context a ciphertext is bound to. A ciphertext only opens under the exact
/// `(round_id, bidder, side)` it was created for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AssociatedData<'a> {
    /// Round id.
    pub round_id: u64,
    /// NEAR account id of the bidder.
    pub bidder: &'a str,
    /// Side of the order, as numbered by the engine.
    pub side: u8,
}

impl AssociatedData<'_> {
    /// Borsh encoding of the tuple `(u64, String, u8)`:
    /// `round_id u64 LE || len(bidder) u32 LE || bidder UTF-8 || side u8`.
    pub fn encode(&self) -> Vec<u8> {
        let bidder = self.bidder.as_bytes();
        let mut out = Vec::with_capacity(8 + 4 + bidder.len() + 1);
        out.extend_from_slice(&self.round_id.to_le_bytes());
        out.extend_from_slice(&(bidder.len() as u32).to_le_bytes());
        out.extend_from_slice(bidder);
        out.push(self.side);
        out
    }
}

/// Boneh-Franklin FullIdent ciphertext.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Ciphertext {
    /// `U = r * G2`.
    pub u: G2Affine,
    /// `V = sigma XOR H2(U, g^r)`.
    pub v: [u8; SIGMA_LEN],
    /// `W = ChaCha20-Poly1305_{H4(sigma)}(M)` with AAD `tag || U || V || app_id || ad`.
    pub w: [u8; W_LEN],
}

impl Ciphertext {
    /// Encode as `U (96, compressed) || V (32) || W (64)`.
    pub fn to_bytes(&self) -> [u8; CIPHERTEXT_LEN] {
        let mut out = [0u8; CIPHERTEXT_LEN];
        out[..G2_LEN].copy_from_slice(&g2_to_bytes(&self.u));
        out[G2_LEN..G2_LEN + SIGMA_LEN].copy_from_slice(&self.v);
        out[G2_LEN + SIGMA_LEN..].copy_from_slice(&self.w);
        out
    }

    /// Decode exactly `CIPHERTEXT_LEN` bytes (U is curve and subgroup checked).
    pub fn from_bytes(b: &[u8]) -> Result<Self> {
        if b.len() != CIPHERTEXT_LEN {
            return Err(Error::Encoding("ciphertext length"));
        }
        let (u, v, w) = split_ciphertext(b);
        Ok(Self {
            u: g2_from_bytes(u)?,
            v: *v,
            w: *w,
        })
    }
}

/// Split a `CIPHERTEXT_LEN`-byte ciphertext into its `U`, `V` and `W` parts.
pub(crate) fn split_ciphertext(b: &[u8]) -> (&[u8; G2_LEN], &[u8; SIGMA_LEN], &[u8; W_LEN]) {
    let u = b[..G2_LEN].try_into().expect("checked length");
    let v = b[G2_LEN..G2_LEN + SIGMA_LEN]
        .try_into()
        .expect("checked length");
    let w = b[G2_LEN + SIGMA_LEN..].try_into().expect("checked length");
    (u, v, w)
}

fn gt_bytes(g: &<Bls12_381 as Pairing>::TargetField) -> Vec<u8> {
    let mut out = Vec::with_capacity(576);
    g.serialize_compressed(&mut out)
        .expect("a target-group element serializes");
    out
}

fn h2(u: &[u8; G2_LEN], gt: &[u8]) -> [u8; SIGMA_LEN] {
    let mut h = Sha256::new();
    h.update(TAG_H2);
    h.update(u);
    h.update(gt);
    h.finalize().into()
}

fn h3(app_id: &AppId, ad: &[u8], sigma: &[u8; SIGMA_LEN], msg: &[u8; PLAINTEXT_LEN]) -> Fr {
    let mut wide = [0u8; 64];
    for (i, chunk) in wide.chunks_mut(32).enumerate() {
        let mut h = Sha256::new();
        h.update(TAG_H3);
        h.update([i as u8]);
        h.update(app_id);
        h.update((ad.len() as u32).to_le_bytes());
        h.update(ad);
        h.update(sigma);
        h.update(msg);
        chunk.copy_from_slice(&h.finalize());
    }
    Fr::from_le_bytes_mod_order(&wide)
}

fn h4(sigma: &[u8; SIGMA_LEN]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(TAG_H4);
    h.update(sigma);
    h.finalize().into()
}

fn aad(u: &[u8; G2_LEN], v: &[u8; SIGMA_LEN], app_id: &AppId, ad: &[u8]) -> Vec<u8> {
    let mut a = Vec::with_capacity(TAG_AAD.len() + G2_LEN + SIGMA_LEN + 32 + ad.len());
    a.extend_from_slice(TAG_AAD);
    a.extend_from_slice(u);
    a.extend_from_slice(v);
    a.extend_from_slice(app_id);
    a.extend_from_slice(ad);
    a
}

fn aead_open(sigma: &[u8; SIGMA_LEN], w: &[u8; W_LEN], aad: &[u8]) -> Option<[u8; PLAINTEXT_LEN]> {
    let cipher = ChaCha20Poly1305::new((&h4(sigma)).into());
    let m = cipher
        .decrypt(Nonce::from_slice(&[0u8; 12]), Payload { msg: w, aad })
        .ok()?;
    m.try_into().ok()
}

fn xor(a: &[u8; SIGMA_LEN], b: &[u8; SIGMA_LEN]) -> [u8; SIGMA_LEN] {
    core::array::from_fn(|i| a[i] ^ b[i])
}

/// The FO scalar `r = H3(app_id, ad, sigma, M)`. A valid ciphertext has `U = r * G2`.
pub fn opening_scalar(
    app_id: &AppId,
    ad: &AssociatedData<'_>,
    pt: &Plaintext,
    sigma: &[u8; SIGMA_LEN],
) -> Fr {
    h3(app_id, &ad.encode(), sigma, &pt.to_bytes())
}

/// Deterministic encryption given `sigma`. Crate-private: reusing a `sigma` across two
/// plaintexts under the same identity reuses the AEAD key and nonce, so callers always go
/// through [`encrypt`], which draws a fresh `sigma`.
pub(crate) fn encrypt_with_sigma(
    mpk: &G2Affine,
    app_id: &AppId,
    ad: &AssociatedData<'_>,
    pt: &Plaintext,
    sigma: &[u8; SIGMA_LEN],
) -> Ciphertext {
    let ad = ad.encode();
    let msg = pt.to_bytes();
    let r = h3(app_id, &ad, sigma, &msg);
    let u = (G2Affine::generator() * r).into_affine();
    let u_bytes = g2_to_bytes(&u);
    let h = identity_point(mpk, app_id);
    let g = Bls12_381::pairing(h, (*mpk * r).into_affine());
    let v = xor(sigma, &h2(&u_bytes, &gt_bytes(&g.0)));
    let cipher = ChaCha20Poly1305::new((&h4(sigma)).into());
    let w = cipher
        .encrypt(
            Nonce::from_slice(&[0u8; 12]),
            Payload {
                msg: &msg,
                aad: &aad(&u_bytes, &v, app_id, &ad),
            },
        )
        .expect("ChaCha20-Poly1305 encrypts 48 bytes")
        .try_into()
        .expect("W is plaintext plus tag");
    Ciphertext { u, v, w }
}

/// Encrypt `pt` to the identity `app_id` under the CKD master public key `mpk`, bound to `ad`.
/// Returns the ciphertext and `sigma` (which opens it; keep it secret until the key is public).
pub fn encrypt<R: RngCore + CryptoRng>(
    rng: &mut R,
    mpk: &G2Affine,
    app_id: &AppId,
    ad: &AssociatedData<'_>,
    pt: &Plaintext,
) -> (Ciphertext, [u8; SIGMA_LEN]) {
    let mut sigma = [0u8; SIGMA_LEN];
    rng.fill_bytes(&mut sigma);
    (encrypt_with_sigma(mpk, app_id, ad, pt, &sigma), sigma)
}

/// Decrypt with the identity key and run the FO re-encryption check, so a malformed ciphertext
/// is rejected. Returns the plaintext and `sigma`, the public opening of the ciphertext.
pub fn decrypt(
    app_id: &AppId,
    key: &G1Affine,
    ct: &Ciphertext,
    ad: &AssociatedData<'_>,
) -> Result<(Plaintext, [u8; SIGMA_LEN])> {
    let ad = ad.encode();
    let u_bytes = g2_to_bytes(&ct.u);
    let g = Bls12_381::pairing(*key, ct.u);
    let sigma = xor(&ct.v, &h2(&u_bytes, &gt_bytes(&g.0)));
    let msg = aead_open(&sigma, &ct.w, &aad(&u_bytes, &ct.v, app_id, &ad)).ok_or(Error::Decrypt)?;
    let r = h3(app_id, &ad, &sigma, &msg);
    if (G2Affine::generator() * r).into_affine() != ct.u {
        return Err(Error::NotWellFormed);
    }
    Ok((Plaintext::from_bytes(&msg), sigma))
}

/// Verify the identity key against `mpk`, then decrypt.
pub fn decrypt_checked(
    mpk: &G2Affine,
    app_id: &AppId,
    key: &G1Affine,
    ct: &Ciphertext,
    ad: &AssociatedData<'_>,
) -> Result<(Plaintext, [u8; SIGMA_LEN])> {
    if !verify_key(mpk, app_id, key) {
        return Err(Error::BadKey);
    }
    decrypt(app_id, key, ct, ad)
}

/// The `V` and `W` part of an opening check, shared by both backends: with the identity key,
/// `V XOR H2(U, e(key, U)) == sigma` and the AEAD opens `W` to exactly `pt`.
/// `ct` is `CIPHERTEXT_LEN` bytes and `u` is the point its first 96 bytes encode.
pub(crate) fn check_v_w(
    app_id: &AppId,
    key: &G1Affine,
    u: &G2Affine,
    ct: &[u8],
    ad: &[u8],
    pt: &[u8; PLAINTEXT_LEN],
    sigma: &[u8; SIGMA_LEN],
) -> bool {
    let (u_bytes, v, w) = split_ciphertext(ct);
    let g = Bls12_381::pairing(*key, *u);
    if xor(v, &h2(u_bytes, &gt_bytes(&g.0))) != *sigma {
        return false;
    }
    aead_open(sigma, w, &aad(u_bytes, v, app_id, ad)).as_ref() == Some(pt)
}

/// Full opening check with a verified identity key: `U == H3(app_id, ad, sigma, M) * G2`,
/// `V XOR H2(U, e(key, U)) == sigma` and the AEAD opens `W` to `M` under `ad`. This is the FO
/// check performed by [`decrypt`], so a ciphertext that cannot be decrypted cannot be opened.
pub fn verify_opening(
    app_id: &AppId,
    key: &G1Affine,
    ct: &[u8],
    ad: &AssociatedData<'_>,
    pt: &Plaintext,
    sigma: &[u8; SIGMA_LEN],
) -> bool {
    if ct.len() != CIPHERTEXT_LEN {
        return false;
    }
    let ad = ad.encode();
    let msg = pt.to_bytes();
    let u = (G2Affine::generator() * h3(app_id, &ad, sigma, &msg)).into_affine();
    if g2_to_bytes(&u)[..] != ct[..G2_LEN] {
        return false;
    }
    check_v_w(app_id, key, &u, ct, &ad, &msg, sigma)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ark_ff::UniformRand;
    use rand::{rngs::StdRng, SeedableRng};

    const ENGINE: &str = "engine.rose-app.testnet";

    struct Setup {
        msk: Fr,
        mpk: G2Affine,
        app_id: AppId,
        key: G1Affine,
    }

    fn setup(round_id: u64) -> Setup {
        let mut rng = StdRng::seed_from_u64(7);
        let msk = Fr::rand(&mut rng);
        let mpk = (G2Affine::generator() * msk).into_affine();
        let app_id = round_app_id(ENGINE, round_id);
        let key = (identity_point(&mpk, &app_id) * msk).into_affine();
        Setup {
            msk,
            mpk,
            app_id,
            key,
        }
    }

    fn order() -> Plaintext {
        Plaintext {
            quantity: 1_000_000,
            limit_price: 2_500_000,
            salt: [9u8; SALT_LEN],
        }
    }

    const AD: AssociatedData<'static> = AssociatedData {
        round_id: 3,
        bidder: "alice.testnet",
        side: 0,
    };

    #[test]
    fn app_id_matches_near_mpc_layout() {
        assert_eq!(round_path(42), "round/42");
        assert_eq!(round_app_id(ENGINE, 42), derive_app_id(ENGINE, "round/42"));
        assert_ne!(round_app_id(ENGINE, 1), round_app_id(ENGINE, 2));
        assert_ne!(round_app_id("a.testnet", 1), round_app_id("b.testnet", 1));
    }

    #[test]
    fn app_scalar_is_per_engine_and_round() {
        assert_eq!(app_scalar(ENGINE, 1), app_scalar(ENGINE, 1));
        assert_ne!(app_scalar(ENGINE, 1), app_scalar(ENGINE, 2));
        assert_ne!(app_scalar("a.testnet", 1), app_scalar("b.testnet", 1));
    }

    #[test]
    fn plaintext_and_ad_layouts() {
        let pt = Plaintext {
            quantity: 1,
            limit_price: 2,
            salt: [3u8; SALT_LEN],
        };
        let b = pt.to_bytes();
        assert_eq!(b[0], 1);
        assert_eq!(b[16], 2);
        assert_eq!(&b[32..], &[3u8; SALT_LEN]);
        assert_eq!(Plaintext::from_bytes(&b), pt);
        let ad = AssociatedData {
            round_id: 0x0102,
            bidder: "ab",
            side: 1,
        }
        .encode();
        assert_eq!(ad, [2, 1, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, b'a', b'b', 1]);
    }

    #[test]
    fn key_verifies_and_wrong_key_fails() {
        let s = setup(3);
        assert!(verify_key(&s.mpk, &s.app_id, &s.key));
        assert!(!verify_key(&s.mpk, &round_app_id(ENGINE, 4), &s.key));
        assert!(!verify_key(&s.mpk, &s.app_id, &G1Affine::zero()));
    }

    #[test]
    fn roundtrip_and_opening() {
        let s = setup(3);
        let mut rng = StdRng::seed_from_u64(1);
        let (ct, sigma) = encrypt(&mut rng, &s.mpk, &s.app_id, &AD, &order());
        let bytes = ct.to_bytes();
        let parsed = Ciphertext::from_bytes(&bytes).unwrap();
        let (pt, opened_sigma) = decrypt_checked(&s.mpk, &s.app_id, &s.key, &parsed, &AD).unwrap();
        assert_eq!(pt, order());
        assert_eq!(opened_sigma, sigma);
        assert!(verify_opening(&s.app_id, &s.key, &bytes, &AD, &pt, &sigma));
        let other = Plaintext {
            quantity: 2,
            ..order()
        };
        assert!(!verify_opening(
            &s.app_id, &s.key, &bytes, &AD, &other, &sigma
        ));
        assert!(!verify_opening(
            &s.app_id,
            &s.key,
            &bytes,
            &AD,
            &pt,
            &[0u8; SIGMA_LEN]
        ));
        assert!(!verify_opening(
            &s.app_id,
            &s.key,
            &bytes[..191],
            &AD,
            &pt,
            &sigma
        ));
    }

    #[test]
    fn ciphertext_length_is_constant() {
        let s = setup(3);
        let mut rng = StdRng::seed_from_u64(2);
        for (q, p) in [
            (0u128, 0u128),
            (1, 1),
            (u128::MAX, u128::MAX),
            (7, u128::MAX / 3),
        ] {
            let pt = Plaintext {
                quantity: q,
                limit_price: p,
                salt: [0u8; SALT_LEN],
            };
            let (ct, _) = encrypt(&mut rng, &s.mpk, &s.app_id, &AD, &pt);
            assert_eq!(ct.to_bytes().len(), CIPHERTEXT_LEN);
        }
        assert_eq!(CIPHERTEXT_LEN, 192);
        assert_eq!(
            Ciphertext::from_bytes(&[0u8; CIPHERTEXT_LEN - 1]),
            Err(Error::Encoding("ciphertext length"))
        );
    }

    #[test]
    fn wrong_round_identity_cannot_decrypt() {
        let s = setup(3);
        let other_id = round_app_id(ENGINE, 4);
        let other_key = (identity_point(&s.mpk, &other_id) * s.msk).into_affine();
        let mut rng = StdRng::seed_from_u64(3);
        let (ct, sigma) = encrypt(&mut rng, &s.mpk, &s.app_id, &AD, &order());
        assert!(decrypt(&s.app_id, &other_key, &ct, &AD).is_err());
        assert!(decrypt(&other_id, &other_key, &ct, &AD).is_err());
        assert_eq!(
            decrypt_checked(&s.mpk, &s.app_id, &other_key, &ct, &AD),
            Err(Error::BadKey)
        );
        assert!(!verify_opening(
            &other_id,
            &other_key,
            &ct.to_bytes(),
            &AD,
            &order(),
            &sigma
        ));
    }

    #[test]
    fn ad_swaps_cannot_open() {
        let s = setup(3);
        let mut rng = StdRng::seed_from_u64(4);
        let (ct, sigma) = encrypt(&mut rng, &s.mpk, &s.app_id, &AD, &order());
        let bytes = ct.to_bytes();
        let swaps = [
            AssociatedData { round_id: 4, ..AD },
            AssociatedData {
                bidder: "mallory.testnet",
                ..AD
            },
            AssociatedData { side: 1, ..AD },
        ];
        for ad in swaps {
            assert_eq!(decrypt(&s.app_id, &s.key, &ct, &ad), Err(Error::Decrypt));
            assert!(!verify_opening(
                &s.app_id,
                &s.key,
                &bytes,
                &ad,
                &order(),
                &sigma
            ));
        }
    }

    #[test]
    fn tampering_is_rejected() {
        let s = setup(3);
        let mut rng = StdRng::seed_from_u64(5);
        let (ct, sigma) = encrypt(&mut rng, &s.mpk, &s.app_id, &AD, &order());

        let mut bad = ct.clone();
        bad.w[0] ^= 1;
        assert_eq!(decrypt(&s.app_id, &s.key, &bad, &AD), Err(Error::Decrypt));
        assert!(!verify_opening(
            &s.app_id,
            &s.key,
            &bad.to_bytes(),
            &AD,
            &order(),
            &sigma
        ));

        let mut bad = ct.clone();
        bad.v[0] ^= 1;
        assert!(decrypt(&s.app_id, &s.key, &bad, &AD).is_err());
        assert!(!verify_opening(
            &s.app_id,
            &s.key,
            &bad.to_bytes(),
            &AD,
            &order(),
            &sigma
        ));

        let mut bad = ct.clone();
        bad.u = (G2Affine::generator() * Fr::from(5u64)).into_affine();
        assert!(decrypt(&s.app_id, &s.key, &bad, &AD).is_err());
        assert!(!verify_opening(
            &s.app_id,
            &s.key,
            &bad.to_bytes(),
            &AD,
            &order(),
            &sigma
        ));
    }

    /// A ciphertext whose `V` does not encrypt the `sigma` used for `U` and `W` (built on
    /// purpose by a dishonest bidder) can be opened by nobody, including its author who knows
    /// `sigma` and the plaintext.
    #[test]
    fn inconsistent_v_is_unopenable() {
        let s = setup(3);
        let mut rng = StdRng::seed_from_u64(6);
        let (ct, sigma) = encrypt(&mut rng, &s.mpk, &s.app_id, &AD, &order());
        let mut bad = ct.to_bytes();
        bad[G2_LEN] ^= 0x80;
        let parsed = Ciphertext::from_bytes(&bad).unwrap();
        assert!(decrypt(&s.app_id, &s.key, &parsed, &AD).is_err());
        assert!(!verify_opening(
            &s.app_id,
            &s.key,
            &bad,
            &AD,
            &order(),
            &sigma
        ));
        let mut shifted_sigma = sigma;
        shifted_sigma[0] ^= 0x80;
        assert!(!verify_opening(
            &s.app_id,
            &s.key,
            &bad,
            &AD,
            &order(),
            &shifted_sigma
        ));
    }

    #[test]
    fn ckd_unwrap_roundtrip() {
        let s = setup(3);
        let mut rng = StdRng::seed_from_u64(8);
        let a = app_scalar(ENGINE, 3);
        let y = Fr::rand(&mut rng);
        let (pk1, pk2) = app_public_key_pv(&a);
        assert_eq!(
            Bls12_381::pairing(pk1, G2Affine::generator()),
            Bls12_381::pairing(G1Affine::generator(), pk2)
        );
        let big_y = (G1Affine::generator() * y).into_affine();
        let big_c = ((identity_point(&s.mpk, &s.app_id) * s.msk) + pk1 * y).into_affine();
        assert_eq!(ckd_unwrap(&a, &big_y, &big_c), s.key);
    }

    #[test]
    fn near_string_encoding_roundtrip() {
        let s = setup(3);
        assert_eq!(parse_near_g2(&format_near_g2(&s.mpk)).unwrap(), s.mpk);
        assert_eq!(parse_near_g1(&format_near_g1(&s.key)).unwrap(), s.key);
        assert!(parse_near_g1("ed25519:abc").is_err());
        assert_eq!(
            parse_near_g1_bytes("bls12381g1:11"),
            Err(Error::Encoding("point length"))
        );
    }
}
