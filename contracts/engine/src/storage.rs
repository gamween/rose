//! NEP-145 storage management for unit holders.
//!
//! Every holding row (one per account and class) costs [`HOLDING_ROW_BYTES`] of contract storage,
//! and every cash row (one per account and venue with a balance) [`CASH_ROW_BYTES`]; both are
//! paid by their owner: an account registers once with `storage_deposit` and tops up when it
//! holds more classes or venues. Receiving units (mint, transfer, settlement, distribution) or
//! depositing NEAR cash requires the receiver to be registered with enough deposit;
//! `distribute_units` can register its receivers from the NEAR attached to the call, and a Base
//! cash registration pays its row from its record deposit. Bids and rounds carry their own
//! deposits (see `rounds.rs`).
//!
//! The byte figures are the trie records as NEAR charges them (key, value and 40 bytes of record
//! overhead) for the longest account id (64 characters), measured in `tests::storage`; shorter
//! ids pay the same, so the engine never pays for a row it charged.

use borsh::{BorshDeserialize, BorshSerialize};
use near_sdk::json_types::U128;
use near_sdk::{env, near, require, AccountId, NearToken, Promise};

use crate::types::{ClassId, Venue};
use crate::{assert_one_yocto, Contract, ContractExt, RoseEvent};

/// Longest NEAR account id, in bytes.
const MAX_ACCOUNT_LEN: u64 = 64;
/// Borsh length of a class id (`u32` length prefix and 64 hex characters).
const CLASS_ID_LEN: u64 = 4 + 64;
/// Overhead NEAR charges per trie record on top of its key and value.
const RECORD_OVERHEAD: u64 = 40;
/// Bytes of the storage account record itself: key (map prefix, account id) and the
/// [`StorageAccount`] value with an empty class list.
pub const STORAGE_ACCOUNT_BYTES: u64 = RECORD_OVERHEAD + (1 + 4 + MAX_ACCOUNT_LEN) + (16 + 8 + 4);
/// Bytes of one holding row: key (map prefix, `Holder::Account` tag, account id, class id), the
/// 64-byte `Holding`, and the class id it adds to its owner's class list (see
/// [`StorageAccount::classes`]).
pub const HOLDING_ROW_BYTES: u64 =
    RECORD_OVERHEAD + (1 + 1 + 4 + MAX_ACCOUNT_LEN + CLASS_ID_LEN) + 64 + CLASS_ID_LEN;
/// Bytes of one cash row: key (map prefix, account id, `Venue::Base` with its 42-character
/// token, the longest venue) and the `u128` balance.
pub const CASH_ROW_BYTES: u64 = RECORD_OVERHEAD + (1 + 4 + MAX_ACCOUNT_LEN + 1 + 4 + 42) + 16;
/// Bytes a Base cash venue outside the accepted list adds on top of its cash row: its entry in
/// the account's list of such venues, charged as a whole one-entry record (key: map prefix and
/// account id; value: the list with one 42-character token), so the record itself is paid
/// whichever entry creates it.
pub const OTHER_VENUE_ENTRY_BYTES: u64 = RECORD_OVERHEAD + (1 + 4 + MAX_ACCOUNT_LEN) + 4 + (4 + 42);
/// Bytes of one lien share row: key (map prefix, lien id, account id) and the 32-byte
/// `LienShare`. Paid from the funder's bid deposit.
pub const LIEN_SHARE_ROW_BYTES: u64 = RECORD_OVERHEAD + (1 + 8 + 4 + MAX_ACCOUNT_LEN) + 32;

/// Storage deposit and usage of an account.
#[derive(Clone, Debug, Default, BorshSerialize, BorshDeserialize)]
pub struct StorageAccount {
    /// NEAR deposited, yoctoNEAR.
    pub deposit: u128,
    /// Bytes charged to the account (the record itself plus its holding and cash rows).
    pub used_bytes: u64,
    /// Classes the account has a holding row of, in the order it got them: the portfolio view
    /// reads these rather than every class of the engine. Each entry is paid with its row.
    pub classes: Vec<ClassId>,
}

/// NEP-145 balance.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StorageBalance {
    pub total: U128,
    pub available: U128,
}

/// NEP-145 bounds.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StorageBalanceBounds {
    /// Deposit of a registration: the account record plus one holding row.
    pub min: U128,
    /// Unbounded: an account pays one holding row per class it holds.
    pub max: Option<U128>,
}

#[near]
impl Contract {
    /// NEP-145: registers `account_id` (default: the caller) or tops up its deposit with the
    /// attached NEAR. With `registration_only`, only the minimum is kept and the rest refunded.
    /// Anyone.
    #[payable]
    pub fn storage_deposit(
        &mut self,
        account_id: Option<AccountId>,
        registration_only: Option<bool>,
    ) -> StorageBalance {
        let account = account_id.unwrap_or_else(env::predecessor_account_id);
        let attached = env::attached_deposit().as_yoctonear();
        let registration_only = registration_only.unwrap_or(false);
        let min = self.min_storage_deposit();
        let refund = match self.storage_accounts.get(&account).cloned() {
            Some(_) if registration_only || attached == 0 => attached,
            Some(mut existing) => {
                existing.deposit = existing
                    .deposit
                    .checked_add(attached)
                    .unwrap_or_else(|| env::panic_str("Deposit overflow"));
                let total = existing.deposit;
                self.storage_accounts.insert(account.clone(), existing);
                self.emit(RoseEvent::StorageDeposited {
                    account: account.clone(),
                    amount: U128(attached),
                    total: U128(total),
                });
                0
            }
            None => {
                require!(
                    attached >= min,
                    "Attach at least the minimum storage deposit (storage_balance_bounds)"
                );
                let deposit = if registration_only { min } else { attached };
                self.register(&account, deposit);
                attached - deposit
            }
        };
        if refund > 0 {
            Promise::new(env::predecessor_account_id())
                .transfer(NearToken::from_yoctonear(refund))
                .detach();
        }
        self.storage_balance_of(account).expect("registered above")
    }

    /// NEP-145: withdraws `amount` (default: everything available) of the caller's unused
    /// storage deposit; the registration minimum always stays (see `storage_balance_of`).
    /// Requires exactly 1 yoctoNEAR.
    #[payable]
    pub fn storage_withdraw(&mut self, amount: Option<U128>) -> StorageBalance {
        assert_one_yocto();
        let account = env::predecessor_account_id();
        require!(
            !self.has_obligations(&account),
            "Storage cannot be withdrawn while the account has live bids, locked units, liens or custody actions in flight"
        );
        let mut record = self
            .storage_accounts
            .get(&account)
            .cloned()
            .unwrap_or_else(|| env::panic_str("Account is not registered"));
        let available = available_of(&record, self.min_storage_deposit());
        let amount = amount.map_or(available, |a| a.0);
        require!(
            amount <= available,
            "Amount exceeds the available storage balance"
        );
        if amount > 0 {
            record.deposit -= amount;
            self.storage_accounts.insert(account.clone(), record);
            Promise::new(account.clone())
                .transfer(NearToken::from_yoctonear(amount))
                .detach();
            self.emit(RoseEvent::StorageWithdrawn {
                account: account.clone(),
                amount: U128(amount),
            });
        }
        self.storage_balance_of(account).expect("registered")
    }

    /// NEP-145: unregisters the caller and refunds its whole deposit. Only an account holding no
    /// units and no claimable tokens can unregister; `force` cannot override that (units are not
    /// burnable here). Requires exactly 1 yoctoNEAR. Returns `false` when not registered.
    #[payable]
    pub fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        assert_one_yocto();
        let account = env::predecessor_account_id();
        let Some(record) = self.storage_accounts.get(&account).cloned() else {
            return false;
        };
        require!(
            !self.has_obligations(&account),
            "Storage cannot be withdrawn while the account has live bids, locked units, liens or custody actions in flight"
        );
        if record.used_bytes > STORAGE_ACCOUNT_BYTES {
            let mut held: Vec<String> = record
                .classes
                .iter()
                .map(|class_id| format!("class {class_id} (units or claimable tokens)"))
                .collect();
            held.extend(
                self.get_cash(account.clone())
                    .into_iter()
                    .filter(|cash| cash.amount.0 > 0)
                    .map(|cash| match cash.venue {
                        Venue::Near => "NEAR cash".to_string(),
                        Venue::Base { token } => format!("Base cash in {token}"),
                    }),
            );
            env::panic_str(&format!(
                "{}: {}; withdraw or transfer it first",
                if force.unwrap_or(false) {
                    "Cannot force-unregister an account holding units, claimable tokens or cash"
                } else {
                    "Account still holds units, claimable tokens or cash"
                },
                held.join(", ")
            ));
        }
        self.storage_accounts.remove(&account);
        if record.deposit > 0 {
            Promise::new(account.clone())
                .transfer(NearToken::from_yoctonear(record.deposit))
                .detach();
        }
        self.emit(RoseEvent::StorageUnregistered {
            account,
            refund: U128(record.deposit),
        });
        true
    }

    /// NEP-145 bounds: the minimum covers the account record, one holding row and one cash row.
    pub fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        StorageBalanceBounds {
            min: U128(self.min_storage_deposit()),
            max: None,
        }
    }

    /// NEP-145 balance of `account_id`, or `None` when not registered.
    pub fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        let min = self.min_storage_deposit();
        self.storage_accounts
            .get(&account_id)
            .map(|record| StorageBalance {
                total: U128(record.deposit),
                available: U128(available_of(record, min)),
            })
    }
}

impl Contract {
    /// Registers `account` with the minimum deposit taken from `attached` when it is not
    /// registered yet, and returns what is left of `attached`. Internal API for every method
    /// that mints or credits units to an account chosen by the caller (deposit registration,
    /// `distribute_units`): call it before `mint_units` / `credit_holding`, then refund the
    /// remainder. Panics "Attach the storage deposit for <account>" when `attached` is short.
    pub fn ensure_registered(&mut self, account: &AccountId, attached: u128) -> u128 {
        if self.storage_accounts.contains_key(account) {
            return attached;
        }
        let min = self.min_storage_deposit();
        require!(
            attached >= min,
            format!("Attach the storage deposit for {account}: {min} yoctoNEAR")
        );
        self.register_with_budget(account, attached)
    }

    /// `ensure_registered` for callbacks: registers an unregistered account with whatever
    /// `attached` covers of the minimum (the engine pays the rest) and returns the remainder.
    pub fn register_with_budget(&mut self, account: &AccountId, attached: u128) -> u128 {
        if self.storage_accounts.contains_key(account) {
            return attached;
        }
        let deposit = self.min_storage_deposit().min(attached);
        self.register(account, deposit);
        attached - deposit
    }

    /// True while the engine may still have to credit `account`: live bids or asks, units
    /// locked in an Advance, liens held or funded, payouts or deposit registrations in flight.
    /// While it is true the account's storage deposit cannot leave the engine, so an owed
    /// credit never lands on an unfunded account.
    pub(crate) fn has_obligations(&self, account: &AccountId) -> bool {
        let indexed = self.account_index.get(account).is_some_and(|index| {
            !(index.bids.is_empty()
                && index.advances.is_empty()
                && index.liens_held.is_empty()
                && index.lien_shares.is_empty())
        });
        indexed || self.has_pending_custody(account)
    }

    /// True when `account` has a storage account.
    pub fn is_registered(&self, account: &AccountId) -> bool {
        self.storage_accounts.contains_key(account)
    }

    /// Registration deposit: the account record, one holding row and one cash row, so a
    /// registered account can always hold one class and one cash venue.
    pub fn min_storage_deposit(&self) -> u128 {
        bytes_cost(STORAGE_ACCOUNT_BYTES + HOLDING_ROW_BYTES + CASH_ROW_BYTES)
    }

    /// Charges `bytes` to `account`'s storage usage (a new holding row). An owed credit can land
    /// on an account that is not registered (it unregistered meanwhile, or never registered):
    /// the account is then registered with a zero deposit, the engine paying its bytes, so its
    /// rows stay accounted for and `storage_unregister` keeps refusing while it holds them.
    pub(crate) fn charge_storage(&mut self, account: &AccountId, bytes: u64) {
        if !self.storage_accounts.contains_key(account) {
            self.register(account, 0);
        }
        let record = self
            .storage_accounts
            .get_mut(account)
            .expect("registered above");
        record.used_bytes = record.used_bytes.saturating_add(bytes);
    }

    /// Adds or removes `class_id` in `account`'s class list as its holding row appears or goes
    /// (the row's bytes, the entry's included, are charged by the caller).
    pub(crate) fn track_class(&mut self, account: &AccountId, class_id: &ClassId, held: bool) {
        if let Some(record) = self.storage_accounts.get_mut(account) {
            if held {
                if !record.classes.contains(class_id) {
                    record.classes.push(class_id.clone());
                }
            } else {
                record.classes.retain(|class| class != class_id);
            }
        }
    }

    /// Classes `account` has a holding row of.
    pub(crate) fn classes_held(&self, account: &AccountId) -> Vec<ClassId> {
        self.storage_accounts
            .get(account)
            .map(|record| record.classes.clone())
            .unwrap_or_default()
    }

    /// Releases `bytes` from `account`'s storage usage (a removed holding or cash row).
    pub(crate) fn release_storage(&mut self, account: &AccountId, bytes: u64) {
        if let Some(record) = self.storage_accounts.get_mut(account) {
            record.used_bytes = record
                .used_bytes
                .saturating_sub(bytes)
                .max(STORAGE_ACCOUNT_BYTES);
        }
    }

    /// YoctoNEAR missing from `account`'s deposit to cover its storage usage plus `extra_bytes`,
    /// or a panic when the account is not registered at all.
    pub(crate) fn storage_shortfall(&self, account: &AccountId, extra_bytes: u64) -> u128 {
        let record = self.storage_accounts.get(account).unwrap_or_else(|| {
            env::panic_str(&format!(
                "Account {account} is not registered: call storage_deposit first"
            ))
        });
        bytes_cost(record.used_bytes.saturating_add(extra_bytes)).saturating_sub(record.deposit)
    }

    /// Panics unless `account` is registered with a deposit covering its usage plus
    /// `extra_bytes`. Checked before any state change, so a short account changes nothing.
    pub(crate) fn require_storage_capacity(&self, account: &AccountId, extra_bytes: u64) {
        let shortfall = self.storage_shortfall(account, extra_bytes);
        require!(
            shortfall == 0,
            format!("Insufficient storage deposit for {account}: top up with storage_deposit")
        );
    }

    /// Adds `amount` to `account`'s deposit (covering a shortfall from a third party's budget).
    pub(crate) fn top_up_storage(&mut self, account: &AccountId, amount: u128) {
        if let Some(record) = self.storage_accounts.get_mut(account) {
            record.deposit = record
                .deposit
                .checked_add(amount)
                .unwrap_or_else(|| env::panic_str("Deposit overflow"));
        }
    }

    fn register(&mut self, account: &AccountId, deposit: u128) {
        self.storage_accounts.insert(
            account.clone(),
            StorageAccount {
                deposit,
                used_bytes: STORAGE_ACCOUNT_BYTES,
                classes: Vec::new(),
            },
        );
        self.emit(RoseEvent::StorageDeposited {
            account: account.clone(),
            amount: U128(deposit),
            total: U128(deposit),
        });
    }
}

/// Cost of `bytes` of storage at the current byte price.
pub(crate) fn bytes_cost(bytes: u64) -> u128 {
    env::storage_byte_cost()
        .as_yoctonear()
        .saturating_mul(u128::from(bytes))
}

/// Withdrawable part of a deposit: what exceeds both the bytes in use and the registration
/// minimum, so a registered account always keeps the deposit `storage_balance_bounds().min`
/// promises (room for its record, one holding row and one cash row) unless it unregisters.
fn available_of(record: &StorageAccount, min: u128) -> u128 {
    record
        .deposit
        .saturating_sub(bytes_cost(record.used_bytes).max(min))
}
