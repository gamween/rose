//! Vectors recorded on NEAR testnet on 2026-11-04 against `v1.signer-prod.testnet` 3.18.0,
//! domain 2 (CKD, BLS12-381), from a throwaway engine contract deployed at
//! `rose-ckd-1793753433.testnet` that depends on this crate with the `near` feature.
//!
//! * Round 1 key: `close` tx `2hL3YiPRnVyw7thp6CjwJjT8187bUpV9F25WXpdoa7yM` (CKD with 20 Tgas),
//!   unwrapped and pairing-checked in the callback.
//! * Bid A: encrypted in Node, submitted by `b1.rose-ckd-1793753433.testnet` (side 0) in tx
//!   `GWs6mEUuc4khq6TKSnMnP5QaJiUzrSvyTyE1799dNhU5`, opened in tx
//!   `Dm5hBXUzRLGXd7XPfWQ7cJkgaV5MTQnttTZQACYBa8Pd` (124.40 Tgas).
//! * Bid B: encrypted in headless Chromium, submitted by `b2.rose-ckd-1793753433.testnet`
//!   (side 1) in tx `9skS8jJcwDuVdZ434hBvJk3cGLL6DpyxcCfqCGahvvFD`, opened in tx
//!   `2odkYzVzthtqjVWuAvQisuAYmz55Q3CZbEcUE5M7Bccx` (124.38 Tgas).
//! * Bid C: built with an inconsistent `V` by its author `b1` (side 1), submitted in tx
//!   `D6ooxm7MgdwZAdheJmcvmWFide9ndNhCyRGcvvwpafTJ`; opening with the author's own `sigma` failed
//!   on chain in tx `DogWVE6EoKfed3fGGatzsVT2rWioArhey42DzugQXdN5`.
//! * Round 3 key: the callback of `close` tx `HqfzMbWuxVLvdZ4ncWkZj826pFzshhE8zxAyciFeZ2EY` ran
//!   out of gas on purpose; the CKD output was unwrapped off-chain and accepted by `submit_key`
//!   in tx `DXHJDWw5obEKBgHMNGMSV7DCs2djxK2KL5iG6ZNZeY2V`.

use rose_ibe::*;

const MPK: &str = "bls12381g2:xeYho48G2Sr9oJz4gw9sLGZGspeeKpHZvMDAwWvoNTRnVMFJH96GxX98TT2MRhTtsot1wcGR1Ti2Xh8PCsbYJ2enbLNdJXDvTYSK8aTE3nJ5NZXU7Kt1F6mFtReWs5pR4kj";
const ENGINE: &str = "rose-ckd-1793753433.testnet";
const B1: &str = "b1.rose-ckd-1793753433.testnet";
const B2: &str = "b2.rose-ckd-1793753433.testnet";

const ROUND1_APP_ID: &str = "305bd2a108c0772db82c2d803d5eea87ba669442b9abcf6bd45b28b8926aa8f5";
/// `pk1` and `pk2` of the round 1 `AppPublicKeyPV` request, as logged by the MPC contract.
const ROUND1_PK1: &str = "b3cb5d4f077591f741cc12b03e26971745cef6b9dee6943921d58b131deae7a1029319a68573fb0e4676657f21e5e87f";
const ROUND1_PK2: &str = "a2127f0d822a253a4fe42bb1a3740e075be8c487612318894bf2b69b159f2acffa0c1896de9cab137180a1443071246b043bf34fd0c67321395cb137dbe7f487fb6af7cacfb41cc5795fe103cea6f008257e7d457743c7277504acb915d764d5";
const ROUND1_BIG_Y: &str =
    "bls12381g1:6JsKyncUXqmVX4RcTD83LCcSL25iVYoi1ShPZxFE2hBoo27Lh2nXDNHu3JnA3Paara";
const ROUND1_BIG_C: &str =
    "bls12381g1:5jQ5mhW68mDqLQGxgnDiFShQy87sFxrDrQ1QLoYibyyZWDUsaJ19nVCaYr38FnqBbF";
const ROUND1_KEY: &str =
    "bls12381g1:6znYwWzn6SVgzXFKy7zEmZA6CR2aS317nJXuWKAmmeEdnrc3Qp6dX7EfE26GZBA889";

const ROUND3_BIG_Y: &str =
    "bls12381g1:7fj8iXDeUs9MQU1WT3iodL4GurRDiVE5WPDYK91JATgy33riUn2PJKWzLjaRGNHbVE";
const ROUND3_BIG_C: &str =
    "bls12381g1:5xgz4VyoK6JpceFXkoWdhPUcdsVvXueUsdSCS4nSYF86ZVHdZ7zwvLy6pMAGLxJrWZ";
const ROUND3_KEY: &str =
    "bls12381g1:7KUB3YJyD2SdDtLWzNsnPEiWRtSigsAZVoVXLjnj9HHKic9TP1AbWjqoshCMk1HhGL";

struct LiveBid {
    ct: &'static str,
    bidder: &'static str,
    side: u8,
    quantity: u128,
    limit_price: u128,
    salt: &'static str,
    sigma: &'static str,
}

const BID_A: LiveBid = LiveBid {
    ct: "94611e3d34b118e206201c9bbffac6f980374ec7731e66dc3da07e8853c9c228664157141518058169ab691caa9042c004c1fdc59e1ccd1798abf86fba082d059bcd3a833ca5e4a8f5a97fa07e5ce6361416fed8012e1e9353288c5b12f1fa81af475b2cacc23f7f6f8bd575659240f4adde543cc3175299ec03c187a03aeb3fcac04d17c9749370498116d7573c721507730868ec3e45d4c2cbca2000c3a147a9616444459189c83d0ab0187ffbe3a4a0da7f214f8dd1017b2785986c2f3c2b",
    bidder: B1,
    side: 0,
    quantity: 1_000_000,
    limit_price: 2_500_000,
    salt: "f4a9415f63849de829438e93341c9e1c",
    sigma: "07098833504cec854d8845e7f5abe3fd48e21536a979c14326595297b097f4e5",
};

const BID_B: LiveBid = LiveBid {
    ct: "916b168bf1c232dcf9721c2d2ce06d9260b81bff1fa5e55f22f4bd0ce26a088d57eda9683e10579bf1156c0307b4bc60127f92759941fd086f2e40c0781b2d37d0015c6163c210f0a0f1bba2fbd8f83ab5e33d23df630a095391b2225b196282a3cd96493761e5a3c3840dbf616a2c3f1eff9413b8a0571c98e7c4daf6f6cd616fd3504a7f45654ef6c3a21413c9e5735be7d9b248b2c7e069923797586f8f317d82f4f312fd78623b39c679d3803c7de45d187332cab5d296237378da884dc5",
    bidder: B2,
    side: 1,
    quantity: 400_000,
    limit_price: 2_100_000,
    salt: "32cdaad19bda4a266b84229499e47946",
    sigma: "f53f02524ea07788448816a16d6408cb835ff4d0e38648675d89b88ffc5d059d",
};

/// Malformed on purpose: honest `U` and `W` for `sigma`, but `V` does not encrypt `sigma`.
const BID_C: LiveBid = LiveBid {
    ct: "90a002d090d187cf966df50907ac52c9e84a6aa8a59c9f05fd32efe2600ba872d58c81997f33d2b4d4f23fdf5dd5dd450b32599d7f5fcb290b7c0256d8a78553d3d8d701a33965ad0923841843a7b34c556b859eaa88bb17b4e25d1e177eb2522474edf3b3dedde47ef80ac307b80b36b7f17511ab39b660f30210190d32b78bb05a00bd696e147ddc541a155775d9bdcc9a5edd46fbd14b7867cb637eaf1c1703d3b3e0f12e528a9bc972436daa6ffb7ff81fd13aeda50494d2fc5bf4b57f3c",
    bidder: B1,
    side: 1,
    quantity: 77,
    limit_price: 9_000_000,
    salt: "cdd29eff9dc3155723b227451d658a3c",
    sigma: "95986f74a1ff02e62c0caa09991654dfd1f3648011fbd35dc941189bfe61c672",
};

impl LiveBid {
    fn ct(&self) -> Vec<u8> {
        hex::decode(self.ct).unwrap()
    }
    fn ad(&self) -> AssociatedData<'static> {
        AssociatedData {
            round_id: 1,
            bidder: self.bidder,
            side: self.side,
        }
    }
    fn plaintext(&self) -> Plaintext {
        Plaintext {
            quantity: self.quantity,
            limit_price: self.limit_price,
            salt: hex::decode(self.salt).unwrap().try_into().unwrap(),
        }
    }
    fn sigma(&self) -> [u8; SIGMA_LEN] {
        hex::decode(self.sigma).unwrap().try_into().unwrap()
    }
}

fn mpk() -> G2Affine {
    parse_near_g2(MPK).unwrap()
}

#[test]
fn round_identity_matches_live_engine() {
    assert_eq!(hex::encode(round_app_id(ENGINE, 1)), ROUND1_APP_ID);
}

#[test]
fn app_public_key_matches_live_request() {
    let (pk1, pk2) = app_public_key_pv(&app_scalar(ENGINE, 1));
    assert_eq!(hex::encode(g1_to_bytes(&pk1)), ROUND1_PK1);
    assert_eq!(hex::encode(g2_to_bytes(&pk2)), ROUND1_PK2);
}

#[test]
fn live_ckd_output_unwraps_to_a_verifying_key() {
    let key = ckd_unwrap(
        &app_scalar(ENGINE, 1),
        &parse_near_g1(ROUND1_BIG_Y).unwrap(),
        &parse_near_g1(ROUND1_BIG_C).unwrap(),
    );
    assert_eq!(format_near_g1(&key), ROUND1_KEY);
    assert!(verify_key(&mpk(), &round_app_id(ENGINE, 1), &key));
    assert!(!verify_key(&mpk(), &round_app_id(ENGINE, 2), &key));
}

#[test]
fn fallback_key_from_a_lost_callback_verifies() {
    let key = ckd_unwrap(
        &app_scalar(ENGINE, 3),
        &parse_near_g1(ROUND3_BIG_Y).unwrap(),
        &parse_near_g1(ROUND3_BIG_C).unwrap(),
    );
    assert_eq!(format_near_g1(&key), ROUND3_KEY);
    assert!(verify_key(&mpk(), &round_app_id(ENGINE, 3), &key));
}

#[test]
fn live_bids_decrypt_and_open_with_the_released_key() {
    let key = parse_near_g1(ROUND1_KEY).unwrap();
    let app_id = round_app_id(ENGINE, 1);
    for bid in [BID_A, BID_B] {
        let ct = Ciphertext::from_bytes(&bid.ct()).unwrap();
        let (pt, sigma) = decrypt_checked(&mpk(), &app_id, &key, &ct, &bid.ad()).unwrap();
        assert_eq!(pt, bid.plaintext());
        assert_eq!(sigma, bid.sigma());
        assert!(verify_opening(
            &app_id,
            &key,
            &bid.ct(),
            &bid.ad(),
            &pt,
            &sigma
        ));
    }
}

#[test]
fn live_malformed_bid_is_unopenable() {
    let key = parse_near_g1(ROUND1_KEY).unwrap();
    let app_id = round_app_id(ENGINE, 1);
    let ct = Ciphertext::from_bytes(&BID_C.ct()).unwrap();
    assert!(decrypt(&app_id, &key, &ct, &BID_C.ad()).is_err());
    assert!(!verify_opening(
        &app_id,
        &key,
        &BID_C.ct(),
        &BID_C.ad(),
        &BID_C.plaintext(),
        &BID_C.sigma()
    ));
}

#[test]
fn live_bid_copied_by_another_bidder_is_unopenable() {
    let key = parse_near_g1(ROUND1_KEY).unwrap();
    let app_id = round_app_id(ENGINE, 1);
    let copied = AssociatedData {
        bidder: B2,
        ..BID_A.ad()
    };
    let ct = Ciphertext::from_bytes(&BID_A.ct()).unwrap();
    assert_eq!(decrypt(&app_id, &key, &ct, &copied), Err(Error::Decrypt));
    assert!(!verify_opening(
        &app_id,
        &key,
        &BID_A.ct(),
        &copied,
        &BID_A.plaintext(),
        &BID_A.sigma()
    ));
}
