//! Claimable tokens of holdings and lien shares through the payout API.

use near_sdk::json_types::{U128, U64};
use near_sdk::test_utils::accounts;

use super::*;
use crate::types::{ClaimSource, Holder};

#[test]
fn holding_claims_include_the_pending_lien_excess() {
    let mut contract = init();
    let class = stepped_class(&mut contract, 6);
    let (holder, funder) = (accounts(1), accounts(2));
    mint(&mut contract, &class, &holder, 4_000_000, ts(1_000));
    fund(&mut contract, &holder, USDC, ts(1_000));
    fund(&mut contract, &funder, 3_000_000, ts(1_000));
    // X = 4M units, K = 1M tokens, one funder bids the whole claim.
    let round = create_advance(
        &mut contract,
        &holder,
        &class,
        AdvanceSpec {
            units: 4_000_000,
            claim: 1_000_000,
            min_fill: 0,
            max_price: 2_000_000,
        },
        ts(2_500),
        ts(6_000),
    );
    let (ask, ask_sealed) = place_ask(
        &mut contract,
        round,
        &holder,
        1_000_000,
        1_000_000,
        1_000_000,
        ts(3_000),
    );
    let (bid, bid_sealed) = place_bid(
        &mut contract,
        round,
        &funder,
        1_000_000,
        1_000_000,
        1_500_000,
        ts(3_500),
    );
    let received = close_and_release(&mut contract, round, ts(6_000));
    open(&mut contract, round, ask, &ask_sealed, received + NS);
    open(&mut contract, round, bid, &bid_sealed, received + NS);
    clear(&mut contract, round, received + REVEAL_WINDOW);
    settle(&mut contract, round, ask, ts(7_000));
    settle(&mut contract, round, bid, ts(7_000));

    // f = 0.9: lien earned 4M * 0.4 = 1.6M, delivered 1M, excess 600k pending for the holder.
    env_at(&engine(), ts(10_000));
    let source = ClaimSource::Holding {
        account: holder.clone(),
        class_id: class.clone(),
    };
    // 4M units from 0 to 0.1 at creation, then the lock from 0.1 to 0.5.
    let lock_accrual = 4_000_000 / 10 + 4_000_000 * 4 / 10;
    assert_eq!(contract.claimable_of(&source), lock_accrual + 600_000);
    assert_eq!(
        contract.get_lien(U64(0)).unwrap().pending_excess,
        U128(600_000)
    );
    let receipt = contract.take_claimable(&source, lock_accrual + 600_000);
    assert_eq!(receipt.chain, crate::types::Chain::Solana);
    assert_eq!(contract.claimable_of(&source), 0);
    assert_eq!(contract.get_lien(U64(0)).unwrap().pending_excess, U128(0));
    contract.refund_claimable(&source, 7);
    assert_eq!(
        contract
            .holding(&Holder::Account(holder.clone()), &class)
            .claimable,
        7
    );

    let share = ClaimSource::LienShare {
        lien_id: 0,
        funder: funder.clone(),
    };
    assert_eq!(contract.claimable_of(&share), 1_000_000);
    contract.take_claimable(&share, 400_000);
    contract.refund_claimable(&share, 100_000);
    assert_eq!(contract.claimable_of(&share), 700_000);
    assert_eq!(
        contract.get_portfolio(funder.clone()).lien_shares[0].claimed,
        U128(300_000)
    );
    assert_eq!(
        contract.claimable_of(&ClaimSource::LienShare {
            lien_id: 9,
            funder: funder.clone()
        }),
        0
    );
    panics_with("Unknown lien", || {
        contract.take_claimable(
            &ClaimSource::LienShare {
                lien_id: 9,
                funder: funder.clone(),
            },
            1,
        );
    });
    panics_with("Amount must be positive", || {
        contract.take_claimable(&share, 0);
    });
    env_at(&engine(), ts(10_000));
    panics_with("Unknown lien", || contract.release_lien(U64(9)));
}
