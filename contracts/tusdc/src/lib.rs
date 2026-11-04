//! Test USDC for rose on NEAR testnet.
//!
//! A standard NEP-141 token with 6 decimals, clearly labeled "Test USDC", and a public
//! mint capped per account and per 24 hours so anyone can get funds for the demo
//! without a captcha-gated faucet. It has no owner and no admin method.

use near_contract_standards::fungible_token::metadata::{
    FungibleTokenMetadata, FungibleTokenMetadataProvider, FT_METADATA_SPEC,
};
use near_contract_standards::fungible_token::{
    FungibleToken, FungibleTokenCore, FungibleTokenResolver,
};
use near_contract_standards::storage_management::{
    StorageBalance, StorageBalanceBounds, StorageManagement,
};
use near_sdk::json_types::U128;
use near_sdk::store::LookupMap;
use near_sdk::{
    env, near, require, AccountId, BorshStorageKey, NearToken, PanicOnDefault, Promise,
    PromiseOrValue,
};

/// One tUSDC in base units (6 decimals).
pub const ONE_TUSDC: u128 = 1_000_000;
/// Maximum amount one account can mint per window.
pub const MINT_CAP: u128 = 10_000 * ONE_TUSDC;
/// Length of the mint window.
pub const MINT_WINDOW_NS: u64 = 24 * 60 * 60 * 1_000_000_000;

const ICON: &str = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='16' fill='%23e8590c'/%3E%3Ctext x='16' y='21' font-family='monospace' font-size='12' text-anchor='middle' fill='%23fff'%3Et$%3C/text%3E%3C/svg%3E";

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Token,
    Minted,
}

#[near(serializers = [borsh])]
#[derive(Clone, Copy)]
struct MintWindow {
    started_at: u64,
    minted: u128,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    token: FungibleToken,
    minted: LookupMap<AccountId, MintWindow>,
}

#[near]
impl Contract {
    #[init]
    pub fn new() -> Self {
        Self {
            token: FungibleToken::new(StorageKey::Token),
            minted: LookupMap::new(StorageKey::Minted),
        }
    }

    /// Mints `amount` to the caller, up to `MINT_CAP` per account per 24 hours.
    /// An unregistered caller must attach the storage deposit; any excess is refunded.
    #[payable]
    pub fn mint(&mut self, amount: U128) {
        let account = env::predecessor_account_id();
        require!(amount.0 > 0, "Amount must be positive");
        let now = env::block_timestamp();
        let window = match self.minted.get(&account).copied() {
            Some(w) if now < w.started_at + MINT_WINDOW_NS => w,
            _ => MintWindow {
                started_at: now,
                minted: 0,
            },
        };
        let minted = window.minted.saturating_add(amount.0);
        require!(
            minted <= MINT_CAP,
            "Mint cap reached: 10,000 tUSDC per account per 24 hours"
        );
        self.minted.insert(
            account.clone(),
            MintWindow {
                started_at: window.started_at,
                minted,
            },
        );

        let mut refund = env::attached_deposit();
        if !self.token.accounts.contains_key(&account) {
            let cost = self.storage_balance_bounds().min;
            require!(
                refund >= cost,
                format!(
                    "Attach {} yoctoNEAR to register the account",
                    cost.as_yoctonear()
                )
            );
            self.token.internal_register_account(&account);
            refund = refund.saturating_sub(cost);
        }
        self.token.internal_deposit(&account, amount.0);
        near_contract_standards::fungible_token::events::FtMint {
            owner_id: &account,
            amount,
            memo: Some("public test mint"),
        }
        .emit();
        if !refund.is_zero() {
            Promise::new(account).transfer(refund).detach();
        }
    }

    /// Amount the account can still mint in its current window.
    pub fn mint_allowance(&self, account_id: AccountId) -> U128 {
        let now = env::block_timestamp();
        let used = match self.minted.get(&account_id) {
            Some(w) if now < w.started_at + MINT_WINDOW_NS => w.minted,
            _ => 0,
        };
        U128(MINT_CAP - used)
    }
}

#[near]
impl FungibleTokenCore for Contract {
    #[payable]
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        self.token.ft_transfer(receiver_id, amount, memo)
    }

    #[payable]
    fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<U128> {
        self.token.ft_transfer_call(receiver_id, amount, memo, msg)
    }

    fn ft_total_supply(&self) -> U128 {
        self.token.ft_total_supply()
    }

    fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        self.token.ft_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenResolver for Contract {
    #[private]
    fn ft_resolve_transfer(
        &mut self,
        sender_id: AccountId,
        receiver_id: AccountId,
        amount: U128,
    ) -> U128 {
        let (used, burned) =
            self.token
                .internal_ft_resolve_transfer(&sender_id, receiver_id, amount);
        if burned > 0 {
            near_contract_standards::fungible_token::events::FtBurn {
                owner_id: &sender_id,
                amount: U128(burned),
                memo: Some("receiver closed its account during transfer"),
            }
            .emit();
        }
        used.into()
    }
}

#[near]
impl StorageManagement for Contract {
    #[payable]
    fn storage_deposit(
        &mut self,
        account_id: Option<AccountId>,
        registration_only: Option<bool>,
    ) -> StorageBalance {
        self.token.storage_deposit(account_id, registration_only)
    }

    #[payable]
    fn storage_withdraw(&mut self, amount: Option<NearToken>) -> StorageBalance {
        self.token.storage_withdraw(amount)
    }

    #[payable]
    fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        self.token.storage_unregister(force)
    }

    fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        self.token.storage_balance_bounds()
    }

    fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.token.storage_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenMetadataProvider for Contract {
    fn ft_metadata(&self) -> FungibleTokenMetadata {
        FungibleTokenMetadata {
            spec: FT_METADATA_SPEC.to_string(),
            name: "Test USDC".to_string(),
            symbol: "tUSDC".to_string(),
            icon: Some(ICON.to_string()),
            reference: None,
            reference_hash: None,
            decimals: 6,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{accounts, VMContextBuilder};
    use near_sdk::testing_env;

    fn context(predecessor: AccountId, deposit: NearToken, now: u64) {
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id(predecessor)
            .attached_deposit(deposit)
            .block_timestamp(now)
            .build());
    }

    fn registration_cost(c: &Contract) -> NearToken {
        c.storage_balance_bounds().min
    }

    #[test]
    fn mint_registers_and_credits() {
        context(accounts(0), NearToken::from_yoctonear(0), 0);
        let mut c = Contract::new();
        let cost = registration_cost(&c);
        context(accounts(1), cost, 1);
        c.mint(U128(500 * ONE_TUSDC));
        assert_eq!(c.ft_balance_of(accounts(1)).0, 500 * ONE_TUSDC);
        assert_eq!(c.ft_total_supply().0, 500 * ONE_TUSDC);
        assert_eq!(c.mint_allowance(accounts(1)).0, MINT_CAP - 500 * ONE_TUSDC);
    }

    #[test]
    #[should_panic(expected = "Attach")]
    fn unregistered_mint_needs_deposit() {
        context(accounts(0), NearToken::from_yoctonear(0), 0);
        let mut c = Contract::new();
        context(accounts(1), NearToken::from_yoctonear(0), 1);
        c.mint(U128(ONE_TUSDC));
    }

    #[test]
    #[should_panic(expected = "Mint cap reached")]
    fn cap_is_enforced_within_window() {
        context(accounts(0), NearToken::from_yoctonear(0), 0);
        let mut c = Contract::new();
        let cost = registration_cost(&c);
        context(accounts(1), cost, 1);
        c.mint(U128(MINT_CAP));
        context(accounts(1), NearToken::from_yoctonear(0), 2);
        c.mint(U128(1));
    }

    #[test]
    fn cap_resets_after_window() {
        context(accounts(0), NearToken::from_yoctonear(0), 0);
        let mut c = Contract::new();
        let cost = registration_cost(&c);
        context(accounts(1), cost, 1);
        c.mint(U128(MINT_CAP));
        context(
            accounts(1),
            NearToken::from_yoctonear(0),
            1 + MINT_WINDOW_NS,
        );
        c.mint(U128(MINT_CAP));
        assert_eq!(c.ft_balance_of(accounts(1)).0, 2 * MINT_CAP);
    }

    #[test]
    fn metadata_is_labeled_test() {
        context(accounts(0), NearToken::from_yoctonear(0), 0);
        let c = Contract::new();
        let m = c.ft_metadata();
        assert_eq!(m.name, "Test USDC");
        assert_eq!(m.symbol, "tUSDC");
        assert_eq!(m.decimals, 6);
    }
}
