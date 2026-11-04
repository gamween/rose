//! NEP-245 multi-token units with accrual accounting (spec section 4).
//!
//! Token id = class id. Every balance change first accrues the holding up to `f(now)`, so
//! unlocked tokens always stay with whoever held the units while they unlocked. Approvals are not
//! supported: every `approval` argument must be `None`.
//!
//! Holding rows are paid by their owner through NEP-145 (`storage.rs`): receiving units requires
//! a registered account whose deposit covers its rows; `distribute_units` registers its
//! receivers from the NEAR attached to the call.

use near_sdk::json_types::U128;
use near_sdk::serde::Serialize;
use near_sdk::{env, ext_contract, near, require, AccountId, Gas, PromiseOrValue};

use crate::events::log_event;
use crate::ledger::Holding;
use crate::types::{ClassId, Holder};
use crate::{
    assert_one_yocto, Contract, ContractExt, RoseEvent, HOLDING_ROW_BYTES,
    MAX_DISTRIBUTION_RECEIVERS,
};

/// Gas reserved for `mt_resolve_transfer`.
const GAS_FOR_RESOLVE_TRANSFER: Gas = Gas::from_tgas(15);
/// Smallest prepaid gas of a transfer call: the receiver gets what is left after the resolver.
const GAS_FOR_MT_TRANSFER_CALL: Gas = Gas::from_tgas(40);

/// Longest `mt_on_transfer` result the resolver reads.
const MAX_RESOLVE_RESULT_LEN: usize = 4096;

const NEP245_STANDARD: &str = "nep245";
const NEP245_VERSION: &str = "1.0.0";

/// NEP-245 token descriptor.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct Token {
    pub token_id: ClassId,
    /// Always `None`: units are fungible within a class.
    pub owner_id: Option<AccountId>,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct MtMintLog<'a> {
    owner_id: &'a AccountId,
    token_ids: [&'a str; 1],
    amounts: [String; 1],
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct MtBurnLog<'a> {
    owner_id: &'a AccountId,
    token_ids: [&'a str; 1],
    amounts: [String; 1],
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct MtTransferLog<'a> {
    old_owner_id: &'a AccountId,
    new_owner_id: &'a AccountId,
    token_ids: Vec<&'a str>,
    amounts: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    memo: Option<&'a str>,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct MtEventBody<'a, T: Serialize> {
    event: &'a str,
    data: &'a [T],
}

fn log_mt<T: Serialize>(event: &str, data: &[T]) {
    log_event(NEP245_STANDARD, NEP245_VERSION, MtEventBody { event, data });
}

#[ext_contract(ext_mt_receiver)]
pub trait MtReceiver {
    fn mt_on_transfer(
        &mut self,
        sender_id: AccountId,
        previous_owner_ids: Vec<AccountId>,
        token_ids: Vec<ClassId>,
        amounts: Vec<U128>,
        msg: String,
    ) -> PromiseOrValue<Vec<U128>>;
}

#[near]
impl Contract {
    /// NEP-245: transfers `amount` units of `token_id` from the caller to `receiver_id`.
    /// Anyone holding units; requires exactly 1 yoctoNEAR; `approval` must be `None`.
    #[payable]
    pub fn mt_transfer(
        &mut self,
        receiver_id: AccountId,
        token_id: ClassId,
        amount: U128,
        approval: Option<(AccountId, u64)>,
        memo: Option<String>,
    ) {
        assert_one_yocto();
        require!(approval.is_none(), "Approvals are not supported");
        let sender = env::predecessor_account_id();
        self.transfer_units(&sender, &receiver_id, &token_id, amount.0, memo.as_deref());
    }

    /// NEP-245: transfers several classes to one receiver. Anyone holding units; requires exactly
    /// 1 yoctoNEAR; `approvals` must be `None` or all `None`.
    #[payable]
    pub fn mt_batch_transfer(
        &mut self,
        receiver_id: AccountId,
        token_ids: Vec<ClassId>,
        amounts: Vec<U128>,
        approvals: Option<Vec<Option<(AccountId, u64)>>>,
        memo: Option<String>,
    ) {
        assert_one_yocto();
        require!(
            approvals.is_none_or(|a| a.iter().all(Option::is_none)),
            "Approvals are not supported"
        );
        require!(
            token_ids.len() == amounts.len() && !token_ids.is_empty(),
            "token_ids and amounts must have the same non-zero length"
        );
        let sender = env::predecessor_account_id();
        self.batch_transfer_units(&sender, &receiver_id, &token_ids, &amounts, memo.as_deref());
    }

    /// NEP-245: transfers units then calls `mt_on_transfer` on the receiver, which returns the
    /// unused amounts to refund. Until the resolver ran, the sender cannot withdraw its storage
    /// deposit or unregister (the refund may need its holding row). Anyone holding units;
    /// requires exactly 1 yoctoNEAR and at least 40 Tgas.
    #[payable]
    pub fn mt_transfer_call(
        &mut self,
        receiver_id: AccountId,
        token_id: ClassId,
        amount: U128,
        approval: Option<(AccountId, u64)>,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<Vec<U128>> {
        assert_one_yocto();
        require!(approval.is_none(), "Approvals are not supported");
        self.transfer_call(receiver_id, vec![token_id], vec![amount], memo, msg)
    }

    /// NEP-245: batch form of `mt_transfer_call`. Anyone holding units; requires exactly
    /// 1 yoctoNEAR and at least 40 Tgas.
    #[payable]
    pub fn mt_batch_transfer_call(
        &mut self,
        receiver_id: AccountId,
        token_ids: Vec<ClassId>,
        amounts: Vec<U128>,
        approvals: Option<Vec<Option<(AccountId, u64)>>>,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<Vec<U128>> {
        assert_one_yocto();
        require!(
            approvals.is_none_or(|a| a.iter().all(Option::is_none)),
            "Approvals are not supported"
        );
        require!(
            token_ids.len() == amounts.len() && !token_ids.is_empty(),
            "token_ids and amounts must have the same non-zero length"
        );
        self.transfer_call(receiver_id, token_ids, amounts, memo, msg)
    }

    /// NEP-245 resolver: refunds the amounts the receiver did not use (or everything when its
    /// call failed) and returns the amounts actually transferred. Called by the contract itself.
    #[private]
    pub fn mt_resolve_transfer(
        &mut self,
        previous_owner_ids: Vec<AccountId>,
        receiver_id: AccountId,
        token_ids: Vec<ClassId>,
        amounts: Vec<U128>,
        approvals: Option<Vec<Option<(AccountId, u64, U128)>>>,
    ) -> Vec<U128> {
        require!(approvals.is_none(), "Approvals are not supported");
        let unused: Vec<u128> = env::promise_result_checked(0, MAX_RESOLVE_RESULT_LEN)
            .ok()
            .and_then(|value| near_sdk::serde_json::from_slice::<Vec<U128>>(&value).ok())
            .filter(|v| v.len() == amounts.len())
            .map_or_else(
                || amounts.iter().map(|a| a.0).collect(),
                |v| v.into_iter().map(|a| a.0).collect(),
            );
        let sender = &previous_owner_ids[0];
        self.release_hold(sender);
        let mut used = Vec::with_capacity(amounts.len());
        for ((token_id, amount), unused) in token_ids.iter().zip(&amounts).zip(unused) {
            let refund = unused.min(amount.0);
            let refunded = if refund == 0 {
                0
            } else {
                let f_now = self.fraction_now(token_id);
                let receiver_balance = self
                    .holding(&Holder::Account(receiver_id.clone()), token_id)
                    .balance;
                let refund = refund.min(receiver_balance);
                if refund > 0 {
                    self.return_units(&receiver_id, sender, token_id, refund, f_now);
                    log_mt(
                        "mt_transfer",
                        &[MtTransferLog {
                            old_owner_id: &receiver_id,
                            new_owner_id: sender,
                            token_ids: vec![token_id],
                            amounts: vec![refund.to_string()],
                            memo: Some("refund"),
                        }],
                    );
                    self.record(RoseEvent::UnitsTransferred {
                        class_id: token_id.clone(),
                        from: receiver_id.clone(),
                        to: sender.clone(),
                        units: U128(refund),
                    });
                }
                refund
            };
            used.push(U128(amount.0 - refunded));
        }
        used
    }

    /// Transfers one class to up to 50 receivers in one call (issuer distribution, spec
    /// sections 2 and 8.3). Anyone holding units; requires at least 1 yoctoNEAR. The attached
    /// NEAR registers the receivers that have no storage account (`storage_balance_bounds().min`
    /// each) and covers their new holding row when their deposit is short; what is left is
    /// refunded. Emits one NEP-245 `mt_transfer` event listing every transfer.
    #[payable]
    pub fn distribute_units(&mut self, token_id: ClassId, receivers: Vec<(AccountId, U128)>) {
        require!(
            env::attached_deposit() >= near_sdk::NearToken::from_yoctonear(1),
            "Requires an attached deposit of at least 1 yoctoNEAR"
        );
        let mut budget = env::attached_deposit().as_yoctonear();
        require!(!receivers.is_empty(), "No receivers");
        require!(
            receivers.len() <= MAX_DISTRIBUTION_RECEIVERS,
            "At most 50 receivers per call"
        );
        let sender = env::predecessor_account_id();
        let f_now = self.fraction_now(&token_id);
        let mut total = 0u128;
        for (receiver, amount) in &receivers {
            require!(amount.0 > 0, "Amount must be positive");
            require!(receiver != &sender, "Cannot transfer to self");
            total = total
                .checked_add(amount.0)
                .unwrap_or_else(|| env::panic_str("Amount overflow"));
        }
        for (receiver, _) in &receivers {
            self.cover_row_from_budget(receiver, &token_id, &mut budget);
        }
        self.debit_holding(&Holder::Account(sender.clone()), &token_id, total, f_now);
        for (receiver, amount) in &receivers {
            self.credit_holding(
                &Holder::Account(receiver.clone()),
                &token_id,
                amount.0,
                f_now,
                f_now,
            );
            self.record(RoseEvent::UnitsTransferred {
                class_id: token_id.clone(),
                from: sender.clone(),
                to: receiver.clone(),
                units: *amount,
            });
        }
        let logs: Vec<MtTransferLog<'_>> = receivers
            .iter()
            .map(|(receiver, amount)| MtTransferLog {
                old_owner_id: &sender,
                new_owner_id: receiver,
                token_ids: vec![token_id.as_str()],
                amounts: vec![amount.0.to_string()],
                memo: None,
            })
            .collect();
        log_mt("mt_transfer", &logs);
        if budget > 0 {
            near_sdk::Promise::new(sender)
                .transfer(near_sdk::NearToken::from_yoctonear(budget))
                .detach();
        }
    }

    /// NEP-245: free units of `account_id` in `token_id` (locked and encumbered units excluded).
    pub fn mt_balance_of(&self, account_id: AccountId, token_id: ClassId) -> U128 {
        U128(
            self.holding(&Holder::Account(account_id), &token_id)
                .balance,
        )
    }

    /// NEP-245: free units of `account_id` in each of `token_ids`.
    pub fn mt_batch_balance_of(&self, account_id: AccountId, token_ids: Vec<ClassId>) -> Vec<U128> {
        let holder = Holder::Account(account_id);
        token_ids
            .iter()
            .map(|token_id| U128(self.holding(&holder, token_id).balance))
            .collect()
    }

    /// NEP-245: units outstanding in `token_id` (free, locked, encumbered and retired), or
    /// `None` for an unknown class.
    pub fn mt_supply(&self, token_id: ClassId) -> Option<U128> {
        self.classes
            .get(&token_id)
            .map(|class| U128(class.total_units))
    }

    /// NEP-245: `mt_supply` of each of `token_ids`.
    pub fn mt_batch_supply(&self, token_ids: Vec<ClassId>) -> Vec<Option<U128>> {
        token_ids
            .into_iter()
            .map(|token_id| self.mt_supply(token_id))
            .collect()
    }

    /// NEP-245: token descriptors of `token_ids` (`None` for unknown classes).
    pub fn mt_token(&self, token_ids: Vec<ClassId>) -> Vec<Option<Token>> {
        token_ids
            .into_iter()
            .map(|token_id| {
                self.classes.contains_key(&token_id).then_some(Token {
                    token_id,
                    owner_id: None,
                })
            })
            .collect()
    }
}

impl Contract {
    /// Holding of `holder` in `class_id`, empty when absent.
    pub(crate) fn holding(&self, holder: &Holder, class_id: &ClassId) -> Holding {
        self.holdings
            .get(&(holder.clone(), class_id.clone()))
            .copied()
            .unwrap_or_default()
    }

    /// Stores a holding, dropping the row when it is empty. Rows of accounts are charged to (or
    /// released from) the account's storage usage; retired lots are paid by their round.
    pub(crate) fn put_holding(&mut self, holder: &Holder, class_id: &ClassId, holding: Holding) {
        let key = (holder.clone(), class_id.clone());
        let existed = self.holdings.contains_key(&key);
        if holding.is_empty() {
            self.holdings.remove(&key);
        } else {
            self.holdings.insert(key, holding);
        }
        if let Holder::Account(account) = holder {
            match (existed, holding.is_empty()) {
                (false, false) => {
                    self.charge_storage(account, HOLDING_ROW_BYTES);
                    self.track_class(account, class_id, true);
                }
                (true, true) => {
                    self.release_storage(account, HOLDING_ROW_BYTES);
                    self.track_class(account, class_id, false);
                }
                _ => {}
            }
        }
    }

    /// Bytes a new row of `class_id` would add to `account`: `HOLDING_ROW_BYTES` when it holds
    /// nothing of the class yet, `0` otherwise.
    pub(crate) fn row_bytes_needed(&self, account: &AccountId, class_id: &ClassId) -> u64 {
        if self
            .holdings
            .contains_key(&(Holder::Account(account.clone()), class_id.clone()))
        {
            0
        } else {
            HOLDING_ROW_BYTES
        }
    }

    /// Panics unless `account` is registered and its deposit covers a row of `class_id`.
    /// Called before any state change of a transfer, mint or settlement.
    pub(crate) fn check_row_capacity(&self, account: &AccountId, class_id: &ClassId) {
        self.require_storage_capacity(account, self.row_bytes_needed(account, class_id));
    }

    /// Adds `units` to a holding, accruing from `f_from` (`<= f_now`). Never checks the NEP-145
    /// capacity: every caller either checked it first (a voluntary receipt: `mint_units`,
    /// `move_units`, `distribute_units`) or credits what the engine owes the account (returned
    /// or settled units, lien releases, refunds), which must never fail because the account
    /// withdrew its storage deposit; a missing row is then paid by the engine.
    pub(crate) fn credit_holding(
        &mut self,
        holder: &Holder,
        class_id: &ClassId,
        units: u128,
        f_now: u128,
        f_from: u128,
    ) {
        let mut holding = self.holding(holder, class_id);
        holding
            .credit_since(f_now, units, f_from)
            .unwrap_or_else(|e| env::panic_str(&e.to_string()));
        self.put_holding(holder, class_id, holding);
    }

    /// Takes from `budget` (a third party's attached NEAR) what `account` lacks to hold one more
    /// row of `class_id`, registering it first when needed.
    fn cover_row_from_budget(
        &mut self,
        account: &AccountId,
        class_id: &ClassId,
        budget: &mut u128,
    ) {
        *budget = self.ensure_registered(account, *budget);
        let shortfall = self.storage_shortfall(account, self.row_bytes_needed(account, class_id));
        if shortfall > 0 {
            require!(
                *budget >= shortfall,
                format!("Attach the storage deposit for {account}: {shortfall} yoctoNEAR more")
            );
            *budget -= shortfall;
            self.top_up_storage(account, shortfall);
        }
    }

    /// Removes `units` from a holding after accruing it up to `f_now`.
    pub(crate) fn debit_holding(
        &mut self,
        holder: &Holder,
        class_id: &ClassId,
        units: u128,
        f_now: u128,
    ) {
        let mut holding = self.holding(holder, class_id);
        holding
            .debit(f_now, units)
            .unwrap_or_else(|e| env::panic_str(&e.to_string()));
        self.put_holding(holder, class_id, holding);
    }

    /// Adds already unlocked tokens to a holding's claimable balance (always owed by the engine:
    /// no capacity check, see `credit_holding`).
    pub(crate) fn add_claimable(&mut self, holder: &Holder, class_id: &ClassId, tokens: u128) {
        if tokens == 0 {
            return;
        }
        let mut holding = self.holding(holder, class_id);
        holding
            .add_claimable(tokens)
            .unwrap_or_else(|e| env::panic_str(&e.to_string()));
        self.put_holding(holder, class_id, holding);
    }

    /// Mints `units` of `class_id` to `account`, accruing from the class fraction `f_from` (the
    /// fraction at the foreign deposit time, so tokens unlocked between the deposit and its
    /// registration belong to the depositor). Internal API for the deposit wiring: the account
    /// must be registered (`ensure_registered`) with a deposit covering one more holding row.
    /// Logs the NEP-245 `mt_mint` event.
    pub fn mint_units(
        &mut self,
        class_id: &ClassId,
        account: &AccountId,
        units: u128,
        f_from: u128,
    ) {
        self.check_row_capacity(account, class_id);
        self.mint_units_owed(class_id, account, units, f_from);
    }

    /// `mint_units` without the capacity check: for units the engine owes back (a redeem whose
    /// release produced no signature).
    pub fn mint_units_owed(
        &mut self,
        class_id: &ClassId,
        account: &AccountId,
        units: u128,
        f_from: u128,
    ) {
        require!(units > 0, "Cannot mint zero units");
        let f_now = self.fraction_now(class_id);
        require!(f_from <= f_now, "Mint checkpoint is in the future");
        let class = self.classes.get_mut(class_id).expect("class exists");
        class.total_units = class
            .total_units
            .checked_add(units)
            .unwrap_or_else(|| env::panic_str("Supply overflow"));
        self.credit_holding(
            &Holder::Account(account.clone()),
            class_id,
            units,
            f_now,
            f_from,
        );
        log_mt(
            "mt_mint",
            &[MtMintLog {
                owner_id: account,
                token_ids: [class_id.as_str()],
                amounts: [units.to_string()],
            }],
        );
        self.record(RoseEvent::UnitsMinted {
            class_id: class_id.clone(),
            account: account.clone(),
            units: U128(units),
        });
    }

    /// Burns `units` of `class_id` from `account`'s free units (its accrued claimable tokens
    /// stay). Internal API for `redeem`. Logs the NEP-245 `mt_burn` event.
    pub fn burn_units(&mut self, class_id: &ClassId, account: &AccountId, units: u128) {
        require!(units > 0, "Cannot burn zero units");
        let f_now = self.fraction_now(class_id);
        self.debit_holding(&Holder::Account(account.clone()), class_id, units, f_now);
        let class = self.classes.get_mut(class_id).expect("class exists");
        class.total_units = class
            .total_units
            .checked_sub(units)
            .unwrap_or_else(|| env::panic_str("Supply underflow"));
        log_mt(
            "mt_burn",
            &[MtBurnLog {
                owner_id: account,
                token_ids: [class_id.as_str()],
                amounts: [units.to_string()],
            }],
        );
        self.record(RoseEvent::UnitsBurned {
            class_id: class_id.clone(),
            account: account.clone(),
            units: U128(units),
        });
    }

    /// A voluntary transfer: the receiver must have the capacity for the row.
    fn move_units(
        &mut self,
        from: &AccountId,
        to: &AccountId,
        class_id: &ClassId,
        units: u128,
        f_now: u128,
    ) {
        self.check_row_capacity(to, class_id);
        self.return_units(from, to, class_id, units, f_now);
    }

    /// Units going back to an account the engine owes them to (a `mt_transfer_call` refund):
    /// no capacity check, see `credit_holding`.
    fn return_units(
        &mut self,
        from: &AccountId,
        to: &AccountId,
        class_id: &ClassId,
        units: u128,
        f_now: u128,
    ) {
        self.debit_holding(&Holder::Account(from.clone()), class_id, units, f_now);
        self.credit_holding(&Holder::Account(to.clone()), class_id, units, f_now, f_now);
    }

    fn transfer_units(
        &mut self,
        sender: &AccountId,
        receiver: &AccountId,
        class_id: &ClassId,
        units: u128,
        memo: Option<&str>,
    ) {
        require!(units > 0, "Amount must be positive");
        require!(sender != receiver, "Cannot transfer to self");
        let f_now = self.fraction_now(class_id);
        self.move_units(sender, receiver, class_id, units, f_now);
        log_mt(
            "mt_transfer",
            &[MtTransferLog {
                old_owner_id: sender,
                new_owner_id: receiver,
                token_ids: vec![class_id.as_str()],
                amounts: vec![units.to_string()],
                memo,
            }],
        );
        self.record(RoseEvent::UnitsTransferred {
            class_id: class_id.clone(),
            from: sender.clone(),
            to: receiver.clone(),
            units: U128(units),
        });
    }

    fn batch_transfer_units(
        &mut self,
        sender: &AccountId,
        receiver: &AccountId,
        token_ids: &[ClassId],
        amounts: &[U128],
        memo: Option<&str>,
    ) {
        require!(sender != receiver, "Cannot transfer to self");
        for (class_id, amount) in token_ids.iter().zip(amounts) {
            require!(amount.0 > 0, "Amount must be positive");
            let f_now = self.fraction_now(class_id);
            self.move_units(sender, receiver, class_id, amount.0, f_now);
            self.record(RoseEvent::UnitsTransferred {
                class_id: class_id.clone(),
                from: sender.clone(),
                to: receiver.clone(),
                units: *amount,
            });
        }
        log_mt(
            "mt_transfer",
            &[MtTransferLog {
                old_owner_id: sender,
                new_owner_id: receiver,
                token_ids: token_ids.iter().map(String::as_str).collect(),
                amounts: amounts.iter().map(|a| a.0.to_string()).collect(),
                memo,
            }],
        );
    }

    fn transfer_call(
        &mut self,
        receiver: AccountId,
        token_ids: Vec<ClassId>,
        amounts: Vec<U128>,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<Vec<U128>> {
        require!(
            env::prepaid_gas() >= GAS_FOR_MT_TRANSFER_CALL,
            "At least 40 Tgas are required for a transfer call"
        );
        let sender = env::predecessor_account_id();
        self.batch_transfer_units(&sender, &receiver, &token_ids, &amounts, memo.as_deref());
        self.hold(&sender);
        let previous_owners = vec![sender.clone(); token_ids.len()];
        ext_mt_receiver::ext(receiver.clone())
            .mt_on_transfer(
                sender,
                previous_owners.clone(),
                token_ids.clone(),
                amounts.clone(),
                msg,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_RESOLVE_TRANSFER)
                    .mt_resolve_transfer(previous_owners, receiver, token_ids, amounts, None),
            )
            .into()
    }
}
