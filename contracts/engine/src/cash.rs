//! Cash ledger per `(account, venue)`.
//!
//! The `Near` venue is funded by `ft_transfer_call` of the configured NEP-141 token and emptied by
//! `withdraw_near_cash`. Base venues are funded by RoseVault `depositCash` proofs and emptied by
//! RoseVault authorizations (foreign wiring), through `credit_cash` and `debit_cash`.

use near_sdk::json_types::U128;
use near_sdk::{
    env, ext_contract, near, require, AccountId, Gas, NearToken, Promise, PromiseError,
    PromiseOrValue,
};

use crate::types::Venue;
use crate::{Contract, ContractExt, RoseEvent};

/// Gas for the NEP-141 `ft_transfer` of a withdrawal.
const GAS_FOR_FT_TRANSFER: Gas = Gas::from_tgas(10);
/// Gas for the withdrawal callback.
const GAS_FOR_WITHDRAW_CALLBACK: Gas = Gas::from_tgas(5);

#[ext_contract(ext_ft)]
pub trait FungibleToken {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
}

#[near]
impl Contract {
    /// NEP-141 receiver: credits `amount` of the configured NEAR cash token to `sender_id`'s
    /// `Near` venue. Only the cash token may call it; `msg` must be empty. Returns `0` (nothing
    /// is refunded).
    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        require!(
            env::predecessor_account_id() == self.config.near_cash_token,
            "Only the configured cash token is accepted"
        );
        require!(msg.is_empty(), "msg must be empty");
        require!(amount.0 > 0, "Amount must be positive");
        self.credit_cash(&sender_id, &Venue::Near, amount.0);
        self.emit(RoseEvent::CashDeposited {
            account: sender_id,
            venue: Venue::Near,
            amount,
        });
        PromiseOrValue::Value(U128(0))
    }

    /// Withdraws `amount` of the caller's `Near` cash to its account through `ft_transfer`. The
    /// caller must be registered on the cash token; a failed transfer is credited back by the
    /// callback. Anyone with cash; requires exactly 1 yoctoNEAR (forwarded to the token).
    #[payable]
    pub fn withdraw_near_cash(&mut self, amount: U128) -> Promise {
        crate::assert_one_yocto();
        require!(amount.0 > 0, "Amount must be positive");
        let account = env::predecessor_account_id();
        self.debit_cash(&account, &Venue::Near, amount.0);
        ext_ft::ext(self.config.near_cash_token.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_FOR_FT_TRANSFER)
            .ft_transfer(
                account.clone(),
                amount,
                Some("rose cash withdrawal".to_string()),
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_WITHDRAW_CALLBACK)
                    .on_near_cash_withdrawn(account, amount),
            )
    }

    /// Callback of `withdraw_near_cash`: credits the amount back when the transfer failed.
    /// Called by the contract itself.
    #[private]
    pub fn on_near_cash_withdrawn(
        &mut self,
        account: AccountId,
        amount: U128,
        #[callback_result] result: Result<(), PromiseError>,
    ) -> bool {
        match result {
            Ok(()) => {
                self.emit(RoseEvent::CashWithdrawn {
                    account,
                    venue: Venue::Near,
                    amount,
                });
                true
            }
            Err(_) => {
                self.credit_cash(&account, &Venue::Near, amount.0);
                self.emit(RoseEvent::CashWithdrawalFailed {
                    account,
                    venue: Venue::Near,
                    amount,
                });
                false
            }
        }
    }
}

impl Contract {
    /// Free cash of `account` in `venue`.
    pub fn cash_of(&self, account: &AccountId, venue: &Venue) -> u128 {
        self.cash
            .get(&(account.clone(), venue.clone()))
            .copied()
            .unwrap_or(0)
    }

    /// Adds `amount` to `account`'s free cash in `venue`. Internal API for Base cash deposits,
    /// refunds and proceeds. A zero amount is a no-op.
    pub fn credit_cash(&mut self, account: &AccountId, venue: &Venue, amount: u128) {
        if amount == 0 {
            return;
        }
        let key = (account.clone(), venue.clone());
        let balance = self.cash.get(&key).copied().unwrap_or(0);
        let balance = balance
            .checked_add(amount)
            .unwrap_or_else(|| env::panic_str("Cash overflow"));
        self.cash.insert(key, balance);
    }

    /// Removes `amount` from `account`'s free cash in `venue`, or panics with
    /// "Insufficient cash". Internal API for escrows, bonds and payouts.
    pub fn debit_cash(&mut self, account: &AccountId, venue: &Venue, amount: u128) {
        if amount == 0 {
            return;
        }
        let key = (account.clone(), venue.clone());
        let balance = self.cash.get(&key).copied().unwrap_or(0);
        let balance = balance
            .checked_sub(amount)
            .unwrap_or_else(|| env::panic_str("Insufficient cash"));
        if balance == 0 {
            self.cash.remove(&key);
        } else {
            self.cash.insert(key, balance);
        }
    }
}
