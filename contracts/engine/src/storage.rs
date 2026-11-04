//! NEP-145 storage management for unit holders.
//!
//! Every holding row (one per account and class) costs [`HOLDING_ROW_BYTES`] of contract storage
//! and is paid by its owner: an account registers once with `storage_deposit` and tops up when it
//! holds more classes. Receiving units (mint, transfer, settlement, distribution) requires the
//! receiver to be registered with enough deposit; `distribute_units` can register its receivers
//! from the NEAR attached to the call. Bids and rounds carry their own deposits (see `rounds.rs`).

use borsh::{BorshDeserialize, BorshSerialize};
use near_sdk::json_types::U128;
use near_sdk::{env, near, require, AccountId, NearToken, Promise};

use crate::{assert_one_yocto, Contract, ContractExt, RoseEvent};

/// Bytes of one holding row: a 32-byte hashed key, the 48-byte `Holding` and the 40-byte record
/// overhead of the NEAR trie.
pub const HOLDING_ROW_BYTES: u64 = 32 + 48 + 40;
/// Bytes of the storage account record itself.
pub const STORAGE_ACCOUNT_BYTES: u64 = 32 + 24 + 40;

/// Storage deposit and usage of an account.
#[derive(Clone, Copy, Debug, Default, BorshSerialize, BorshDeserialize)]
pub struct StorageAccount {
    /// NEAR deposited, yoctoNEAR.
    pub deposit: u128,
    /// Bytes charged to the account (the record itself plus its holding rows).
    pub used_bytes: u64,
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
        let refund = match self.storage_accounts.get(&account).copied() {
            Some(existing) if registration_only => {
                self.storage_accounts.insert(account.clone(), existing);
                attached
            }
            Some(mut existing) => {
                existing.deposit = existing
                    .deposit
                    .checked_add(attached)
                    .unwrap_or_else(|| env::panic_str("Deposit overflow"));
                self.storage_accounts.insert(account.clone(), existing);
                self.emit(RoseEvent::StorageDeposited {
                    account: account.clone(),
                    amount: U128(attached),
                    total: U128(existing.deposit),
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
    /// storage deposit. Requires exactly 1 yoctoNEAR.
    #[payable]
    pub fn storage_withdraw(&mut self, amount: Option<U128>) -> StorageBalance {
        assert_one_yocto();
        let account = env::predecessor_account_id();
        let mut record = self
            .storage_accounts
            .get(&account)
            .copied()
            .unwrap_or_else(|| env::panic_str("Account is not registered"));
        let available = available_of(&record);
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
        let Some(record) = self.storage_accounts.get(&account).copied() else {
            return false;
        };
        require!(
            record.used_bytes <= STORAGE_ACCOUNT_BYTES,
            if force.unwrap_or(false) {
                "Cannot force-unregister an account holding units or claimable tokens"
            } else {
                "Account still holds units or claimable tokens"
            }
        );
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

    /// NEP-145 bounds: the minimum covers the account record and one holding row.
    pub fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        StorageBalanceBounds {
            min: U128(self.min_storage_deposit()),
            max: None,
        }
    }

    /// NEP-145 balance of `account_id`, or `None` when not registered.
    pub fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.storage_accounts
            .get(&account_id)
            .map(|record| StorageBalance {
                total: U128(record.deposit),
                available: U128(available_of(record)),
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
        self.register(account, min);
        attached - min
    }

    /// True when `account` has a storage account.
    pub fn is_registered(&self, account: &AccountId) -> bool {
        self.storage_accounts.contains_key(account)
    }

    /// Registration deposit: the account record plus one holding row.
    pub fn min_storage_deposit(&self) -> u128 {
        bytes_cost(STORAGE_ACCOUNT_BYTES + HOLDING_ROW_BYTES)
    }

    /// Charges `bytes` to `account`'s storage usage (a new holding row).
    pub(crate) fn charge_storage(&mut self, account: &AccountId, bytes: u64) {
        if let Some(record) = self.storage_accounts.get_mut(account) {
            record.used_bytes = record.used_bytes.saturating_add(bytes);
        }
    }

    /// Releases `bytes` from `account`'s storage usage (a removed holding row).
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

fn available_of(record: &StorageAccount) -> u128 {
    record.deposit.saturating_sub(bytes_cost(record.used_bytes))
}
