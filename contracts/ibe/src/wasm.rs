//! Browser API (feature `wasm`, built with wasm-bindgen).
//!
//! Points use NEAR strings (`bls12381g1:<base58>`, `bls12381g2:<base58>`), ciphertexts are
//! `Uint8Array`s, amounts are decimal strings (u128), salts and `sigma` are lowercase hex.
//! Randomness (salt and `sigma`) comes from the browser CSPRNG (`crypto.getRandomValues`).

use alloc::string::{String, ToString};
use core::fmt::Display;

use js_sys::{Object, Reflect, Uint8Array};
use rand_core::{OsRng, RngCore};
use wasm_bindgen::prelude::*;

use crate::{AssociatedData, Ciphertext, Plaintext, SALT_LEN};

fn js_err(e: impl Display) -> JsError {
    JsError::new(&e.to_string())
}

fn set(obj: &Object, key: &str, value: JsValue) -> Result<(), JsError> {
    Reflect::set(obj, &JsValue::from_str(key), &value)
        .map(|_| ())
        .map_err(|_| JsError::new("cannot build result object"))
}

fn parse_amount(s: &str, what: &str) -> Result<u128, JsError> {
    if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
        return Err(JsError::new(&alloc::format!(
            "{what} must be a decimal integer"
        )));
    }
    s.parse::<u128>()
        .map_err(|_| JsError::new(&alloc::format!("{what} does not fit in u128")))
}

/// Hex of the round identity `app_id` (for display and cross-checks).
#[wasm_bindgen]
pub fn derive_app_id_hex(engine_account: &str, round_id: u64) -> String {
    hex::encode(crate::round_app_id(engine_account, round_id))
}

/// Seal an order for `(round_id, bidder, side)` under the CKD master public key `mpk`.
/// Returns `{ ciphertext: Uint8Array (192 bytes), salt: hex }`.
#[wasm_bindgen]
pub fn encrypt_bid(
    mpk: &str,
    engine_account: &str,
    round_id: u64,
    bidder: &str,
    side: u8,
    quantity: &str,
    limit_price: &str,
) -> Result<JsValue, JsError> {
    let mpk = crate::parse_near_g2(mpk).map_err(js_err)?;
    let mut salt = [0u8; SALT_LEN];
    OsRng.fill_bytes(&mut salt);
    let pt = Plaintext {
        quantity: parse_amount(quantity, "quantity")?,
        limit_price: parse_amount(limit_price, "limit_price")?,
        salt,
    };
    let ad = AssociatedData {
        round_id,
        bidder,
        side,
    };
    let app_id = crate::round_app_id(engine_account, round_id);
    let (ct, _) = crate::encrypt(&mut OsRng, &mpk, &app_id, &ad, &pt);
    let out = Object::new();
    set(
        &out,
        "ciphertext",
        Uint8Array::from(&ct.to_bytes()[..]).into(),
    )?;
    set(&out, "salt", JsValue::from_str(&hex::encode(salt)))?;
    Ok(out.into())
}

/// Decrypt a sealed order with the released round key (verified against `mpk` first).
/// Returns `{ quantity, limit_price, salt, sigma }`; `(plaintext, sigma)` is the opening the
/// engine verifies.
#[wasm_bindgen]
pub fn decrypt_bid(
    mpk: &str,
    engine_account: &str,
    round_id: u64,
    key: &str,
    ciphertext: &[u8],
    bidder: &str,
    side: u8,
) -> Result<JsValue, JsError> {
    let mpk = crate::parse_near_g2(mpk).map_err(js_err)?;
    let key = crate::parse_near_g1(key).map_err(js_err)?;
    let ct = Ciphertext::from_bytes(ciphertext).map_err(js_err)?;
    let ad = AssociatedData {
        round_id,
        bidder,
        side,
    };
    let app_id = crate::round_app_id(engine_account, round_id);
    let (pt, sigma) = crate::decrypt_checked(&mpk, &app_id, &key, &ct, &ad).map_err(js_err)?;
    let out = Object::new();
    set(
        &out,
        "quantity",
        JsValue::from_str(&pt.quantity.to_string()),
    )?;
    set(
        &out,
        "limit_price",
        JsValue::from_str(&pt.limit_price.to_string()),
    )?;
    set(&out, "salt", JsValue::from_str(&hex::encode(pt.salt)))?;
    set(&out, "sigma", JsValue::from_str(&hex::encode(sigma)))?;
    Ok(out.into())
}

/// Check a round key against the CKD master public key and the round identity.
#[wasm_bindgen]
pub fn verify_key(
    mpk: &str,
    engine_account: &str,
    round_id: u64,
    key: &str,
) -> Result<bool, JsError> {
    let mpk = crate::parse_near_g2(mpk).map_err(js_err)?;
    let key = crate::parse_near_g1(key).map_err(js_err)?;
    Ok(crate::verify_key(
        &mpk,
        &crate::round_app_id(engine_account, round_id),
        &key,
    ))
}

/// Unwrap a CKD response `(big_y, big_c)` for a round with its public app scalar.
/// Returns the round key as `bls12381g1:<base58>`; check it with [`verify_key`].
#[wasm_bindgen]
pub fn ckd_unwrap(
    engine_account: &str,
    round_id: u64,
    big_y: &str,
    big_c: &str,
) -> Result<String, JsError> {
    let a = crate::app_scalar(engine_account, round_id);
    let y = crate::parse_near_g1(big_y).map_err(js_err)?;
    let c = crate::parse_near_g1(big_c).map_err(js_err)?;
    Ok(crate::format_near_g1(&crate::ckd_unwrap(&a, &y, &c)))
}
