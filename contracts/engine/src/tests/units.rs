//! NEP-245 units: accrual across transfers, batch distribution, events and transfer calls.

use near_sdk::json_types::U128;
use near_sdk::mock::MockAction;
use near_sdk::test_utils::{accounts, get_created_receipts};
use near_sdk::{Gas, NearToken, PromiseResult};
use serde_json::json;

use super::*;
use crate::math::ONE;
use crate::types::Holder;
use crate::MAX_DISTRIBUTION_RECEIVERS;

#[test]
fn transfers_accrue_to_whoever_held_the_units() {
    let mut contract = init();
    let class = stepped_class(&mut contract, 6);
    let (alice, bob) = (accounts(1), accounts(2));
    mint(&mut contract, &class, &alice, 1_000_000, ts(1_000));
    assert_eq!(
        contract.mt_balance_of(alice.clone(), class.clone()).0,
        1_000_000
    );
    assert_eq!(contract.mt_supply(class.clone()), Some(U128(1_000_000)));

    env(&alice, one_yocto(), ts(3_000));
    panics_with(
        "Account charlie is not registered: call storage_deposit first",
        || contract.mt_transfer(bob.clone(), class.clone(), U128(400_000), None, None),
    );
    register(&mut contract, &bob, ts(3_000));
    env(&alice, one_yocto(), ts(3_000));
    contract.mt_transfer(
        bob.clone(),
        class.clone(),
        U128(400_000),
        None,
        Some("hi".into()),
    );
    let a = contract.holding(&Holder::Account(alice.clone()), &class);
    let b = contract.holding(&Holder::Account(bob.clone()), &class);
    assert_eq!(
        (a.balance, a.claimable, a.checkpoint),
        (600_000, 200_000, ONE / 5)
    );
    assert_eq!(
        (b.balance, b.claimable, b.checkpoint),
        (400_000, 0, ONE / 5)
    );

    env_at(&alice, ts(5_000));
    assert_eq!(
        contract.get_claimable(alice.clone(), class.clone()).0,
        320_000
    );
    assert_eq!(contract.get_claimable(bob.clone(), class.clone()).0, 80_000);
    assert_eq!(
        contract.mt_batch_balance_of(alice.clone(), vec![class.clone(), "nope".into()]),
        vec![U128(600_000), U128(0)]
    );
    assert_eq!(
        contract.mt_batch_supply(vec![class.clone(), "nope".into()]),
        vec![Some(U128(1_000_000)), None]
    );
    let tokens = contract.mt_token(vec![class.clone(), "nope".into()]);
    assert_eq!(
        tokens[0]
            .as_ref()
            .map(|t| (t.token_id.clone(), t.owner_id.clone())),
        Some((class.clone(), None))
    );
    assert!(tokens[1].is_none());

    env(&alice, one_yocto(), ts(5_000));
    contract.burn_units(&class, &alice, 600_000);
    let a = contract.holding(&Holder::Account(alice.clone()), &class);
    assert_eq!((a.balance, a.claimable), (0, 320_000));
    assert_eq!(contract.mt_supply(class.clone()), Some(U128(400_000)));
}

#[test]
fn nep245_events_have_the_standard_shape() {
    let mut contract = init();
    let class = stepped_class(&mut contract, 6);
    let (alice, bob) = (accounts(1), accounts(2));
    mint(&mut contract, &class, &alice, 1_000, ts(1_000));
    register(&mut contract, &bob, ts(1_000));
    let minted = events("nep245");
    assert_eq!(
        minted.last().unwrap(),
        &json!({
            "standard": "nep245",
            "version": "1.0.0",
            "event": "mt_mint",
            "data": [{ "owner_id": alice, "token_ids": [class], "amounts": ["1000"] }]
        })
    );

    env(&alice, one_yocto(), ts(1_000));
    contract.mt_transfer(
        bob.clone(),
        class.clone(),
        U128(10),
        None,
        Some("gift".into()),
    );
    assert_eq!(
        events("nep245").last().unwrap(),
        &json!({
            "standard": "nep245",
            "version": "1.0.0",
            "event": "mt_transfer",
            "data": [{
                "old_owner_id": alice,
                "new_owner_id": bob,
                "token_ids": [class],
                "amounts": ["10"],
                "memo": "gift"
            }]
        })
    );

    env(&alice, one_yocto(), ts(1_000));
    contract.mt_batch_transfer(
        bob.clone(),
        vec![class.clone()],
        vec![U128(5)],
        Some(vec![None]),
        None,
    );
    let transfer = events("nep245").last().unwrap().clone();
    assert_eq!(transfer["data"][0]["amounts"], json!(["5"]));
    assert!(transfer["data"][0].get("memo").is_none());

    env_at(&engine(), ts(1_000));
    contract.burn_units(&class, &bob, 15);
    assert_eq!(
        events("nep245").last().unwrap(),
        &json!({
            "standard": "nep245",
            "version": "1.0.0",
            "event": "mt_burn",
            "data": [{ "owner_id": bob, "token_ids": [class], "amounts": ["15"] }]
        })
    );
}

#[test]
fn distribute_units_moves_one_class_to_many_holders_in_one_event() {
    let mut contract = init();
    let class = stepped_class(&mut contract, 6);
    let issuer = accounts(0);
    mint(&mut contract, &class, &issuer, 1_000_000, ts(1_000));
    let receivers: Vec<(AccountId, U128)> = (1..=3)
        .map(|i| (accounts(i), U128(100_000 * i as u128)))
        .collect();
    let min = contract.storage_balance_bounds().min.0;
    env(&issuer, one_yocto(), ts(3_000));
    panics_with("Attach the storage deposit for bob", || {
        contract.distribute_units(class.clone(), receivers.clone())
    });
    // Three unregistered receivers: three registrations paid by the issuer, the rest refunded.
    env(&issuer, NearToken::from_yoctonear(3 * min + 7), ts(3_000));
    contract.distribute_units(class.clone(), receivers.clone());
    assert_eq!(transferred_to(&issuer), 7);
    for (receiver, _) in &receivers {
        let balance = contract.storage_balance_of(receiver.clone()).unwrap();
        assert_eq!(balance.total, U128(min));
        assert_eq!(balance.available, U128(0));
    }
    assert_eq!(
        contract.mt_balance_of(issuer.clone(), class.clone()).0,
        400_000
    );
    for (receiver, amount) in &receivers {
        let holding = contract.holding(&Holder::Account(receiver.clone()), &class);
        assert_eq!((holding.balance, holding.checkpoint), (amount.0, ONE / 5));
    }
    let issuer_holding = contract.holding(&Holder::Account(issuer.clone()), &class);
    assert_eq!(issuer_holding.claimable, 200_000);
    let transfer = events("nep245").last().unwrap().clone();
    assert_eq!(transfer["event"], "mt_transfer");
    assert_eq!(transfer["data"].as_array().unwrap().len(), 3);
    assert_eq!(transfer["data"][2]["new_owner_id"], accounts(3).as_str());
    assert_eq!(transfer["data"][2]["amounts"], json!(["300000"]));

    let too_many: Vec<(AccountId, U128)> = (0..=MAX_DISTRIBUTION_RECEIVERS)
        .map(|i| (format!("h{i}.testnet").parse().unwrap(), U128(1)))
        .collect();
    env(&issuer, one_yocto(), ts(3_000));
    panics_with("At most 30 receivers per call", || {
        contract.distribute_units(class.clone(), too_many)
    });
    env(&issuer, one_yocto(), ts(3_000));
    panics_with("Cannot transfer to self", || {
        contract.distribute_units(class.clone(), vec![(issuer.clone(), U128(1))])
    });
    register(&mut contract, &accounts(4), ts(3_000));
    env(&issuer, one_yocto(), ts(3_000));
    panics_with("not enough units", || {
        contract.distribute_units(class.clone(), vec![(accounts(4), U128(400_001))])
    });
    env_at(&issuer, ts(3_000));
    panics_with(
        "Requires an attached deposit of at least 1 yoctoNEAR",
        || contract.distribute_units(class.clone(), vec![(accounts(4), U128(1))]),
    );
}

/// NEAR's `max_total_log_length`: every log of one function call together.
const MAX_TOTAL_LOG_BYTES: usize = 16_384;

/// The logs `distribute_units` writes for `count` receivers in the worst case: a 64-character
/// sender, 64-character receivers that all need a registration, 38-digit amounts. Returns the
/// call's logs (the mocked VM enforces NEAR's total log limit, as the runtime does).
fn worst_case_distribution_logs(count: usize) -> Vec<String> {
    let mut contract = init();
    let class = stepped_class(&mut contract, 6);
    assert_eq!(class.len(), 64);
    let issuer: AccountId = "f".repeat(64).parse().unwrap();
    let amount = 10u128.pow(37);
    mint(
        &mut contract,
        &class,
        &issuer,
        amount * count as u128,
        ts(1_000),
    );
    let receivers: Vec<(AccountId, U128)> = (0..count)
        .map(|i| {
            (
                format!("{i:02}{}", "a".repeat(62)).parse().unwrap(),
                U128(amount),
            )
        })
        .collect();
    let min = contract.storage_balance_bounds().min.0;
    env(
        &issuer,
        NearToken::from_yoctonear(count as u128 * min),
        ts(3_000),
    );
    contract.distribute_units(class.clone(), receivers);
    for i in 0..count {
        let receiver: AccountId = format!("{i:02}{}", "a".repeat(62)).parse().unwrap();
        assert_eq!(contract.mt_balance_of(receiver, class.clone()).0, amount);
    }
    near_sdk::test_utils::get_logs()
}

#[test]
fn distribute_units_at_the_cap_fits_the_log_limit_with_the_longest_ids() {
    let logs = worst_case_distribution_logs(MAX_DISTRIBUTION_RECEIVERS);
    let total: usize = logs.iter().map(String::len).sum();
    // One registration event per receiver and one NEP-245 event listing every transfer.
    assert_eq!(logs.len(), MAX_DISTRIBUTION_RECEIVERS + 1);
    assert_eq!(total, 15_951);
    assert!(total <= MAX_TOTAL_LOG_BYTES);
    let transfer = events("nep245").last().unwrap().clone();
    assert_eq!(transfer["event"], "mt_transfer");
    assert_eq!(
        transfer["data"].as_array().unwrap().len(),
        MAX_DISTRIBUTION_RECEIVERS
    );
    // One receiver more would not fit: the bound is the measured maximum.
    let per_receiver = (total
        - worst_case_distribution_logs(1)
            .iter()
            .map(String::len)
            .sum::<usize>())
        / (MAX_DISTRIBUTION_RECEIVERS - 1);
    assert!(total + per_receiver > MAX_TOTAL_LOG_BYTES);
}

#[test]
fn transfer_guards() {
    let mut contract = init();
    let class = stepped_class(&mut contract, 6);
    let (alice, bob) = (accounts(1), accounts(2));
    mint(&mut contract, &class, &alice, 1_000, ts(1_000));
    register(&mut contract, &bob, ts(1_000));
    env_at(&alice, ts(1_000));
    panics_with("exactly 1 yoctoNEAR", || {
        contract.mt_transfer(bob.clone(), class.clone(), U128(1), None, None)
    });
    env(&alice, one_yocto(), ts(1_000));
    panics_with("Approvals are not supported", || {
        contract.mt_transfer(
            bob.clone(),
            class.clone(),
            U128(1),
            Some((bob.clone(), 1)),
            None,
        )
    });
    env(&alice, one_yocto(), ts(1_000));
    panics_with("Cannot transfer to self", || {
        contract.mt_transfer(alice.clone(), class.clone(), U128(1), None, None)
    });
    env(&alice, one_yocto(), ts(1_000));
    panics_with("not enough units", || {
        contract.mt_transfer(bob.clone(), class.clone(), U128(1_001), None, None)
    });
    env(&alice, one_yocto(), ts(1_000));
    panics_with("Amount must be positive", || {
        contract.mt_transfer(bob.clone(), class.clone(), U128(0), None, None)
    });
    env(&alice, one_yocto(), ts(1_000));
    panics_with("Unknown class", || {
        contract.mt_transfer(bob.clone(), "nope".into(), U128(1), None, None)
    });
}

#[test]
fn transfer_call_refunds_the_unused_amount() {
    let mut contract = init();
    let class = stepped_class(&mut contract, 6);
    let (alice, receiver) = (accounts(1), accounts(2));
    mint(&mut contract, &class, &alice, 1_000_000, ts(1_000));
    register(&mut contract, &receiver, ts(1_000));

    env(&alice, one_yocto(), ts(3_000));
    let result = contract.mt_transfer_call(
        receiver.clone(),
        class.clone(),
        U128(500_000),
        None,
        None,
        "msg".into(),
    );
    assert!(matches!(result, near_sdk::PromiseOrValue::Promise(_)));
    result.detach();
    let calls: Vec<String> = get_created_receipts()
        .iter()
        .flat_map(|r| r.actions.iter())
        .filter_map(|a| match a {
            MockAction::FunctionCallWeight { method_name, .. } => {
                Some(String::from_utf8(method_name.clone()).unwrap())
            }
            _ => None,
        })
        .collect();
    assert_eq!(calls, vec!["mt_on_transfer", "mt_resolve_transfer"]);
    assert_eq!(
        contract.mt_balance_of(receiver.clone(), class.clone()).0,
        500_000
    );

    env_with_result(
        ts(5_000),
        PromiseResult::Successful(serde_json::to_vec(&vec![U128(200_000)]).unwrap()),
    );
    let used = contract.mt_resolve_transfer(
        vec![alice.clone()],
        receiver.clone(),
        vec![class.clone()],
        vec![U128(500_000)],
        None,
    );
    assert_eq!(used, vec![U128(300_000)]);
    let a = contract.holding(&Holder::Account(alice.clone()), &class);
    let r = contract.holding(&Holder::Account(receiver.clone()), &class);
    // Alice: 1M units from 0 to 0.2, then 500k to 0.4, plus 200k refunded at 0.4; the receiver kept
    // the accrual of the 500k it held between 0.2 and 0.4.
    assert_eq!((a.balance, a.claimable), (700_000, 300_000));
    assert_eq!((r.balance, r.claimable), (300_000, 100_000));

    env_with_result(ts(5_000), PromiseResult::Failed);
    let used = contract.mt_resolve_transfer(
        vec![alice.clone()],
        receiver.clone(),
        vec![class.clone()],
        vec![U128(500_000)],
        None,
    );
    assert_eq!(
        used,
        vec![U128(200_000)],
        "a failed call refunds what the receiver still holds"
    );
    assert_eq!(contract.mt_balance_of(receiver, class).0, 0);

    let context = VMContextBuilder::new()
        .current_account_id(engine())
        .predecessor_account_id(alice.clone())
        .attached_deposit(one_yocto())
        .prepaid_gas(Gas::from_tgas(30))
        .block_timestamp(ts(5_000))
        .build();
    testing_env!(context);
    panics_with("At least 40 Tgas", || {
        contract
            .mt_transfer_call(accounts(3), "x".into(), U128(1), None, None, String::new())
            .detach()
    });
}

#[test]
fn batch_transfer_call_moves_several_classes_and_refunds_each_unused_amount() {
    let mut contract = init();
    let first = stepped_class(&mut contract, 6);
    let second = stepped_class(&mut contract, 2);
    let (alice, receiver) = (accounts(1), accounts(2));
    // Two holding rows each: the minimum deposit pays one, the top-up the other.
    for account in [&alice, &receiver] {
        register(&mut contract, account, ts(1_000));
        env(account, NearToken::from_millinear(10), ts(1_000));
        contract.storage_deposit(None, None);
    }
    mint(&mut contract, &first, &alice, 1_000_000, ts(1_000));
    mint(&mut contract, &second, &alice, 1_000, ts(1_000));
    let classes = vec![first.clone(), second.clone()];

    env(&alice, one_yocto(), ts(3_000));
    panics_with("Approvals are not supported", || {
        contract
            .mt_batch_transfer_call(
                receiver.clone(),
                classes.clone(),
                vec![U128(1), U128(1)],
                Some(vec![None, Some((receiver.clone(), 1))]),
                None,
                String::new(),
            )
            .detach()
    });
    env(&alice, one_yocto(), ts(3_000));
    panics_with("same non-zero length", || {
        contract
            .mt_batch_transfer_call(
                receiver.clone(),
                classes.clone(),
                vec![U128(1)],
                None,
                None,
                String::new(),
            )
            .detach()
    });
    env(&alice, one_yocto(), ts(3_000));
    panics_with("same non-zero length", || {
        contract
            .mt_batch_transfer_call(receiver.clone(), vec![], vec![], None, None, String::new())
            .detach()
    });

    env(&alice, one_yocto(), ts(3_000));
    let result = contract.mt_batch_transfer_call(
        receiver.clone(),
        classes.clone(),
        vec![U128(500_000), U128(400)],
        Some(vec![None, None]),
        None,
        "msg".into(),
    );
    assert!(matches!(result, near_sdk::PromiseOrValue::Promise(_)));
    result.detach();
    let call = last_call_args("mt_on_transfer");
    assert_eq!(call["sender_id"], json!(alice));
    assert_eq!(call["previous_owner_ids"], json!([alice, alice]));
    assert_eq!(call["token_ids"], json!(classes));
    assert_eq!(call["amounts"], json!(["500000", "400"]));
    assert_eq!(call["msg"], "msg");
    assert_eq!(
        contract.mt_batch_balance_of(receiver.clone(), classes.clone()),
        vec![U128(500_000), U128(400)]
    );

    env_with_result(
        ts(5_000),
        PromiseResult::Successful(serde_json::to_vec(&vec![U128(200_000), U128(0)]).unwrap()),
    );
    let used = contract.mt_resolve_transfer(
        vec![alice.clone(), alice.clone()],
        receiver.clone(),
        classes.clone(),
        vec![U128(500_000), U128(400)],
        None,
    );
    assert_eq!(used, vec![U128(300_000), U128(400)]);
    assert_eq!(
        contract.mt_batch_balance_of(alice.clone(), classes.clone()),
        vec![U128(700_000), U128(600)]
    );
    assert_eq!(
        contract.mt_batch_balance_of(receiver, classes),
        vec![U128(300_000), U128(400)]
    );
}
