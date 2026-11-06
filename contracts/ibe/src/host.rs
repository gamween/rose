//! NEAR backend (feature `near`): BLS12-381 operations routed through NEAR host functions
//! (NEP-488) instead of in-wasm arkworks arithmetic. Only the target-group pairing of the
//! opening check runs in wasm, because the host exposes a pairing check but no pairing value.
//!
//! Host encodings are the ZCash big-endian formats, which are also arkworks' encodings, and
//! scalars are 32 bytes little-endian.
//!
//! Subgroup checks (NEP-488): `bls12381_p1_decompress` and `bls12381_p2_decompress` check that a
//! point is on the curve but not that it is in the prime-order subgroup. `bls12381_g1_multiexp`,
//! `bls12381_g2_multiexp` and `bls12381_pairing_check` do reject points outside the subgroup, and
//! every untrusted point in this module goes through one of them before it is relied on.

use alloc::vec::Vec;

use ark_bls12_381::{Fq, Fr, G1Affine, G2Affine};
use ark_ec::AffineRepr;
use ark_ff::{BigInteger, PrimeField};
use ark_serialize::{CanonicalDeserialize, CanonicalSerialize};
use near_sdk::env;
use sha2::{Digest, Sha256};

use crate::{
    check_v_w, g1_to_bytes, g2_to_bytes, AppId, AssociatedData, Plaintext, CIPHERTEXT_LEN, G1_LEN,
    G2_LEN, NEAR_CKD_DST, SIGMA_LEN,
};

const G1_UNCOMPRESSED_LEN: usize = 96;
const G2_UNCOMPRESSED_LEN: usize = 192;

fn g1_uncompressed(p: &G1Affine) -> [u8; G1_UNCOMPRESSED_LEN] {
    let mut out = [0u8; G1_UNCOMPRESSED_LEN];
    p.serialize_uncompressed(&mut out[..])
        .expect("a G1 point serializes to 96 bytes");
    out
}

fn g2_uncompressed(p: &G2Affine) -> [u8; G2_UNCOMPRESSED_LEN] {
    let mut out = [0u8; G2_UNCOMPRESSED_LEN];
    p.serialize_uncompressed(&mut out[..])
        .expect("a G2 point serializes to 192 bytes");
    out
}

/// Host outputs are valid curve points, so arkworks' expensive checks are skipped.
fn g1_from_host(b: &[u8]) -> G1Affine {
    G1Affine::deserialize_uncompressed_unchecked(b).expect("host returns a G1 point")
}

fn g2_from_host(b: &[u8]) -> G2Affine {
    G2Affine::deserialize_uncompressed_unchecked(b).expect("host returns a G2 point")
}

fn scalar_le(s: &Fr) -> Vec<u8> {
    s.into_bigint().to_bytes_le()
}

/// Decompress a 48-byte G1 point on the host. Curve checked, not subgroup checked.
pub fn g1_decompress(b: &[u8; G1_LEN]) -> Option<G1Affine> {
    env::bls12381_p1_decompress(b).map(|p| g1_from_host(&p))
}

/// Decompress a 96-byte G2 point on the host. Curve checked, not subgroup checked.
pub fn g2_decompress(b: &[u8; G2_LEN]) -> Option<G2Affine> {
    env::bls12381_p2_decompress(b).map(|p| g2_from_host(&p))
}

/// `sum(s_i * P_i)` in G1, `None` if a point is outside the G1 subgroup.
pub fn g1_msm(terms: &[(G1Affine, Fr)]) -> Option<G1Affine> {
    let mut input = Vec::with_capacity(terms.len() * (G1_UNCOMPRESSED_LEN + 32));
    for (p, s) in terms {
        input.extend_from_slice(&g1_uncompressed(p));
        input.extend(scalar_le(s));
    }
    env::bls12381_g1_multiexp(&input).map(|p| g1_from_host(&p))
}

/// `sum(s_i * P_i)` in G2, `None` if a point is outside the G2 subgroup.
pub fn g2_msm(terms: &[(G2Affine, Fr)]) -> Option<G2Affine> {
    let mut input = Vec::with_capacity(terms.len() * (G2_UNCOMPRESSED_LEN + 32));
    for (p, s) in terms {
        input.extend_from_slice(&g2_uncompressed(p));
        input.extend(scalar_le(s));
    }
    env::bls12381_g2_multiexp(&input).map(|p| g2_from_host(&p))
}

/// RFC 9380 `expand_message_xmd` with SHA-256.
fn expand_message_xmd(msg: &[u8], dst: &[u8], len: usize) -> Vec<u8> {
    let ell = len.div_ceil(32);
    let mut dst_prime = dst.to_vec();
    dst_prime.push(dst.len() as u8);
    let mut h = Sha256::new();
    h.update([0u8; 64]);
    h.update(msg);
    h.update((len as u16).to_be_bytes());
    h.update([0u8]);
    h.update(&dst_prime);
    let b0: [u8; 32] = h.finalize().into();
    let mut h = Sha256::new();
    h.update(b0);
    h.update([1u8]);
    h.update(&dst_prime);
    let mut bi: [u8; 32] = h.finalize().into();
    let mut out = bi.to_vec();
    for i in 2..=ell {
        let x: [u8; 32] = core::array::from_fn(|j| b0[j] ^ bi[j]);
        let mut h = Sha256::new();
        h.update(x);
        h.update([i as u8]);
        h.update(&dst_prime);
        bi = h.finalize().into();
        out.extend_from_slice(&bi);
    }
    out.truncate(len);
    out
}

/// RFC 9380 `BLS12381G1_XMD:SHA-256_SSWU_RO_` with the NEAR CKD DST: field hashing in wasm,
/// then `map_fp_to_g1` (map and cofactor clearing) and the final addition on the host.
pub fn hash_to_g1(msg: &[u8]) -> G1Affine {
    let uniform = expand_message_xmd(msg, NEAR_CKD_DST, 128);
    let mut fps = Vec::with_capacity(96);
    for chunk in uniform.chunks(64) {
        fps.extend(
            Fq::from_be_bytes_mod_order(chunk)
                .into_bigint()
                .to_bytes_be(),
        );
    }
    let points = env::bls12381_map_fp_to_g1(&fps).expect("canonical Fp elements map to G1");
    let mut sum_input = Vec::with_capacity(2 * (1 + G1_UNCOMPRESSED_LEN));
    sum_input.push(0);
    sum_input.extend_from_slice(&points[..G1_UNCOMPRESSED_LEN]);
    sum_input.push(0);
    sum_input.extend_from_slice(&points[G1_UNCOMPRESSED_LEN..]);
    g1_from_host(&env::bls12381_p1_sum(&sum_input).expect("sum of mapped points"))
}

/// CKD identity point `H = hash_to_g1(mpk || app_id)` from the compressed master public key.
pub fn identity_point(mpk: &[u8; G2_LEN], app_id: &AppId) -> G1Affine {
    let mut input = Vec::with_capacity(G2_LEN + 32);
    input.extend_from_slice(mpk);
    input.extend_from_slice(app_id);
    hash_to_g1(&input)
}

/// Checks a compressed CKD master public key: a valid encoding of a non-zero G2 point in the
/// prime-order subgroup. The host decompression checks the curve, a one-term `g2_multiexp` the
/// subgroup. The live MPC key always passes; a key that fails could never verify a round key
/// ([`verify_key_host`] pairs it), so the engine refuses it once, at init.
pub fn is_valid_master_key_host(mpk: &[u8; G2_LEN]) -> bool {
    let Some(point) = g2_decompress(mpk) else {
        return false;
    };
    !point.is_zero() && g2_msm(&[(point, Fr::from(1u64))]).is_some()
}

/// `(pk1, pk2) = (a * G1, a * G2)` for an `AppPublicKeyPV` request, computed on the host.
pub fn app_public_key_pv_host(a: &Fr) -> (G1Affine, G2Affine) {
    (
        g1_msm(&[(G1Affine::generator(), *a)]).expect("the generator is in G1"),
        g2_msm(&[(G2Affine::generator(), *a)]).expect("the generator is in G2"),
    )
}

/// A round key that passed [`verify_key_host`] for its round: the only key type
/// [`verify_opening_host`] accepts, so an unverified key cannot open a bid.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct VerifiedKey([u8; G1_LEN]);

impl VerifiedKey {
    /// The compressed key bytes, for storage and display.
    pub fn as_bytes(&self) -> &[u8; G1_LEN] {
        &self.0
    }

    /// Wraps key bytes the caller stored after a successful [`verify_key_host`] of the same
    /// round. Only for bytes that came out of that check: wrapping anything else makes the
    /// opening check meaningless.
    pub fn from_stored(bytes: [u8; G1_LEN]) -> Self {
        Self(bytes)
    }
}

/// Check an identity key with one host pairing check: the key is a non-zero G1 subgroup point
/// and `e(key, -G2) * e(H(mpk, app_id), mpk) == 1`. `mpk` is the compressed master public key.
/// Returns the key as a [`VerifiedKey`] when it verifies.
pub fn verify_key_host(
    mpk: &[u8; G2_LEN],
    app_id: &AppId,
    key: &[u8; G1_LEN],
) -> Option<VerifiedKey> {
    let key_point = g1_decompress(key)?;
    if key_point.is_zero() {
        return None;
    }
    let mpk_point = g2_decompress(mpk)?;
    let h = identity_point(mpk, app_id);
    let mut input = Vec::with_capacity(2 * (G1_UNCOMPRESSED_LEN + G2_UNCOMPRESSED_LEN));
    input.extend_from_slice(&g1_uncompressed(&key_point));
    input.extend_from_slice(&g2_uncompressed(&-G2Affine::generator()));
    input.extend_from_slice(&g1_uncompressed(&h));
    input.extend_from_slice(&g2_uncompressed(&mpk_point));
    (env::bls12381_pairing_check(&input) == Some(true)).then_some(VerifiedKey(*key))
}

/// Unwrap a CKD output `(Y, C)` (compressed G1) with the app scalar `a`: `key = C - a * Y`.
/// Returns the compressed key, or `None` if `Y` or `C` is not a G1 subgroup point.
/// The result still has to pass [`verify_key_host`].
pub fn ckd_unwrap_host(a: &Fr, big_y: &[u8; G1_LEN], big_c: &[u8; G1_LEN]) -> Option<[u8; G1_LEN]> {
    let y = g1_decompress(big_y)?;
    let c = g1_decompress(big_c)?;
    g1_msm(&[(c, Fr::from(1u64)), (y, -*a)]).map(|k| g1_to_bytes(&k))
}

/// Full opening check of a ciphertext with the round key:
/// `U == H3(app_id, ad, sigma, M) * G2` through a host multiexp, then
/// `V XOR H2(U, e(key, U)) == sigma` (one pairing in wasm) and the AEAD opens `W` to `M` under
/// `ad`. `key` is a [`VerifiedKey`] of `app_id`.
pub fn verify_opening_host(
    app_id: &AppId,
    key: &VerifiedKey,
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
    let r = crate::h3(app_id, &ad, sigma, &msg);
    let u = g2_msm(&[(G2Affine::generator(), r)]).expect("the generator is in G2");
    if g2_to_bytes(&u)[..] != ct[..G2_LEN] {
        return false;
    }
    let Some(key_point) = g1_decompress(&key.0) else {
        return false;
    };
    check_v_w(app_id, &key_point, &u, ct, &ad, &msg, sigma)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        app_public_key_pv, app_scalar, ckd_unwrap, encrypt, round_app_id, verify_key,
        verify_opening, Ciphertext, SALT_LEN,
    };
    use ark_ec::CurveGroup;
    use ark_ff::UniformRand;
    use rand::{rngs::StdRng, SeedableRng};

    const ENGINE: &str = "engine.rose-app.testnet";

    fn setup() -> (Fr, G2Affine, AppId, G1Affine) {
        let mut rng = StdRng::seed_from_u64(11);
        let msk = Fr::rand(&mut rng);
        let mpk = (G2Affine::generator() * msk).into_affine();
        let app_id = round_app_id(ENGINE, 5);
        let key = (crate::identity_point(&mpk, &app_id) * msk).into_affine();
        (msk, mpk, app_id, key)
    }

    #[test]
    fn hash_to_curve_matches_pure_backend() {
        let (_, mpk, app_id, _) = setup();
        assert_eq!(
            identity_point(&g2_to_bytes(&mpk), &app_id),
            crate::identity_point(&mpk, &app_id)
        );
        for msg in [&b""[..], b"abc", &[7u8; 200]] {
            assert_eq!(hash_to_g1(msg), crate::hash_to_g1(msg));
        }
    }

    #[test]
    fn group_operations_match_pure_backend() {
        let (_, mpk, _, key) = setup();
        let a = app_scalar(ENGINE, 5);
        assert_eq!(app_public_key_pv_host(&a), app_public_key_pv(&a));
        assert_eq!(g2_decompress(&g2_to_bytes(&mpk)), Some(mpk));
        assert_eq!(g1_decompress(&g1_to_bytes(&key)), Some(key));
        assert_eq!(g1_decompress(&[0xffu8; G1_LEN]), None);
    }

    /// A G2 curve point outside the prime-order subgroup (the cofactor of G2 is not 1).
    fn g2_outside_subgroup() -> G2Affine {
        use ark_bls12_381::Fq2;
        (1u64..)
            .find_map(|x| {
                G2Affine::get_point_from_x_unchecked(Fq2::new(Fq::from(x), Fq::from(0u64)), false)
                    .filter(|p| !p.is_in_correct_subgroup_assuming_on_curve())
            })
            .expect("a small x gives a curve point outside the subgroup")
    }

    #[test]
    fn master_key_check_refuses_points_outside_the_g2_subgroup() {
        let (_, mpk, _, _) = setup();
        assert!(is_valid_master_key_host(&g2_to_bytes(&mpk)));
        let outside = g2_outside_subgroup();
        assert!(outside.is_on_curve());
        assert!(
            g2_decompress(&g2_to_bytes(&outside)).is_some(),
            "on the curve: decompression alone accepts it"
        );
        assert!(!is_valid_master_key_host(&g2_to_bytes(&outside)));
        assert!(!is_valid_master_key_host(&g2_to_bytes(&G2Affine::zero())));
        assert!(!is_valid_master_key_host(&[0xffu8; G2_LEN]));
    }

    #[test]
    fn master_key_check_costs_the_engine_init_about_two_tgas() {
        let (_, mpk, _, _) = setup();
        let before = env::used_gas();
        assert!(is_valid_master_key_host(&g2_to_bytes(&mpk)));
        let host_gas = env::used_gas().as_gas() - before.as_gas();
        assert!(
            (2_000_000_000_000..2_500_000_000_000).contains(&host_gas),
            "{host_gas} gas of host calls (decompression and one-term multiexp)"
        );
    }

    #[test]
    fn key_check_matches_pure_backend() {
        let (msk, mpk, app_id, key) = setup();
        let mpk_bytes = g2_to_bytes(&mpk);
        let verified = verify_key_host(&mpk_bytes, &app_id, &g1_to_bytes(&key)).unwrap();
        assert_eq!(verified.as_bytes(), &g1_to_bytes(&key));
        assert_eq!(VerifiedKey::from_stored(g1_to_bytes(&key)), verified);
        assert!(verify_key(&mpk, &app_id, &key));
        let other = round_app_id(ENGINE, 6);
        assert!(verify_key_host(&mpk_bytes, &other, &g1_to_bytes(&key)).is_none());
        let wrong = (crate::identity_point(&mpk, &app_id) * (msk + Fr::from(1u64))).into_affine();
        assert!(verify_key_host(&mpk_bytes, &app_id, &g1_to_bytes(&wrong)).is_none());
        assert!(verify_key_host(&mpk_bytes, &app_id, &g1_to_bytes(&G1Affine::zero())).is_none());
        assert!(verify_key_host(&mpk_bytes, &app_id, &[0xffu8; G1_LEN]).is_none());
    }

    #[test]
    fn ckd_unwrap_matches_pure_backend() {
        let (msk, mpk, app_id, key) = setup();
        let mut rng = StdRng::seed_from_u64(12);
        let a = app_scalar(ENGINE, 5);
        let (pk1, _) = app_public_key_pv(&a);
        let y = Fr::rand(&mut rng);
        let big_y = (G1Affine::generator() * y).into_affine();
        let big_c = ((crate::identity_point(&mpk, &app_id) * msk) + pk1 * y).into_affine();
        let unwrapped = ckd_unwrap_host(&a, &g1_to_bytes(&big_y), &g1_to_bytes(&big_c)).unwrap();
        assert_eq!(unwrapped, g1_to_bytes(&ckd_unwrap(&a, &big_y, &big_c)));
        assert_eq!(unwrapped, g1_to_bytes(&key));
        assert_eq!(
            ckd_unwrap_host(&a, &[0xffu8; G1_LEN], &g1_to_bytes(&big_c)),
            None
        );
    }

    #[test]
    fn opening_check_matches_pure_backend() {
        let (_, mpk, app_id, key) = setup();
        let key_bytes = verify_key_host(&g2_to_bytes(&mpk), &app_id, &g1_to_bytes(&key)).unwrap();
        let ad = AssociatedData {
            round_id: 5,
            bidder: "bob.testnet",
            side: 1,
        };
        let pt = Plaintext {
            quantity: 42,
            limit_price: 1_234_567,
            salt: [1u8; SALT_LEN],
        };
        let mut rng = StdRng::seed_from_u64(13);
        let (ct, sigma) = encrypt(&mut rng, &mpk, &app_id, &ad, &pt);
        let good = ct.to_bytes();

        let mut bad_u = ct.clone();
        bad_u.u = (G2Affine::generator() * Fr::from(3u64)).into_affine();
        let mut bad_v = good;
        bad_v[G2_LEN] ^= 1;
        let mut bad_w = good;
        bad_w[CIPHERTEXT_LEN - 1] ^= 1;
        let cases: [(&[u8], AssociatedData<'_>, Plaintext); 8] = [
            (&good, ad, pt),
            (&bad_u.to_bytes(), ad, pt),
            (&bad_v, ad, pt),
            (&bad_w, ad, pt),
            (&good, AssociatedData { round_id: 6, ..ad }, pt),
            (
                &good,
                AssociatedData {
                    bidder: "eve.testnet",
                    ..ad
                },
                pt,
            ),
            (&good, AssociatedData { side: 0, ..ad }, pt),
            (
                &good,
                ad,
                Plaintext {
                    limit_price: 1,
                    ..pt
                },
            ),
        ];
        for (i, (ct_bytes, case_ad, case_pt)) in cases.iter().enumerate() {
            let host = verify_opening_host(&app_id, &key_bytes, ct_bytes, case_ad, case_pt, &sigma);
            let pure = verify_opening(&app_id, &key, ct_bytes, case_ad, case_pt, &sigma);
            assert_eq!(host, pure, "case {i}");
            assert_eq!(host, i == 0, "case {i}");
        }
        assert!(!verify_opening_host(
            &app_id,
            &key_bytes,
            &good[..100],
            &ad,
            &pt,
            &sigma
        ));
        assert!(Ciphertext::from_bytes(&good).is_ok());
    }
}
