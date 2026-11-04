---
title: FAQ
description: Short answers on the product, the mechanism, the chains and what rose does not do.
order: 13
section: Reference
---

## Product

### What does rose do in one sentence?

It runs sealed, uniform-price liquidity rounds for locked token allocations: a project buys back its insiders' locked tokens without guessing a price, holders of the same allocation exit together without dumping, and nobody can read a bid before the round closes.

### Who is it for?

Issuers (foundations, project treasuries, DAOs) buying back locked allocations before a cliff; holders (VCs, angels, KOLs, sale participants, ex-team with a transferable position) who want liquidity without dumping at unlock; buyers (funds, OTC desks, long-term holders) who want locked supply at a discount and are willing to hold the lock. The issuer is the primary user.

### Why not just make a fixed-price offer?

Because holders value the lock differently and a single price only finds the few sellers whose reservation price is below it. Monad's fixed-price offer was declined by "nearly all" approached holders. A sealed uniform-price round discovers the price that buys the most volume within the budget and pays every seller the same price.

### Why sealed?

With an open book, bidders wait and shade their bids against what they see, and the issuer's own insiders front-run it. Sealed asks give the issuer a true reservation-price curve. Sealed bids protect buyers from being picked off. The price is still public after the fact, with every fill.

### Is this a buyback tool or a secondary market?

Both. A Tender is the issuer buying back. An Exit is holders selling to buyers. An Advance is a holder selling the first unlocks of their units to funders without selling the units.

### Where does rose add nothing?

Finding buyers is a cold-start problem that a blockchain does not solve. The clearing algorithm is ordinary and runs fine off-chain in traditional finance. rose does not pretend otherwise.

## Why NEAR

### Why is any of this on a blockchain?

Four load-bearing reasons.

1. Delivery versus payment across chains without an escrow agent. A seller is paid only if the position actually changes hands, and the position lives on Base or Solana. The NEAR engine controls a vault on each chain through Chain Signatures and proves foreign state through the MPC network's foreign transaction verification. On EVM-only stacks this needs a custodian or a bridge.
2. Bids nobody can read early, including the operator. Bids are encrypted to an identity whose key the NEAR MPC network releases (Confidential Key Derivation, domain 2) only when the round contract asks for it, and the contract can only ask after the deadline.
3. A public, verifiable result. The clearing price, allocations and fills are computed on-chain from opened bids. An issuer buying from its own insiders can show its community exactly what happened.
4. One ledger for positions on several chains. Units of a class are NEP-245 multi-tokens on NEAR, transferable and composable, while the underlying stream never moves.

### Why NEAR specifically?

Because NEAR's MPC network gives a contract all three primitives rose needs, each from a single contract call: Chain Signatures (threshold signing for Base and Solana addresses), Confidential Key Derivation (the key release that seals bids until the deadline) and foreign transaction verification. On EVM-only stacks, delivery versus payment across chains needs a custodian or a bridge, and the sealing would need a trusted party.

## Concepts

### What is a class?

A set of positions that are economically identical: same chain, protocol, token and normalized unlock schedule, non-cancelable. Usually one cohort of one sale. Positions in a class are fungible, which is what allows many sellers against many buyers at one price.

### What is a unit?

One allocation unit of a class: a claim on one base unit of the class token under the class schedule. Depositing a position with allocation `D` (in base units) mints `D` units. Units are NEP-245 tokens with the class id as token id; holding them requires a NEP-145 storage registration on the engine.

### What is the unlock function?

`f(t)` in `[0, 1]`: the fraction of the allocation unlocked at time `t`, an exact port of the protocol's own unlock math over the attested schedule, 1e18 fixed point, and a lower bound of what every stream of the class has unlocked. Locked tokens per unit are `1 - f(t)`. A unit's entitlement between two times is `f(t2) - f(t1)` tokens.

### How do unlocked tokens reach me?

Every account holds `(balance, checkpoint, claimable, carry)` per class. Every balance change first accrues `balance * (f(now) - checkpoint)` into `claimable`. You pull your claimable tokens from the vault on the foreign chain with an engine-signed authorization. See [Cross-chain custody](/docs/cross-chain-custody).

### Who gets the accrual of units that are locked in a round?

The seller, until `ts = closes_at`. Sold units accrue to the buyer from `ts`. Unsold units return to the seller with their accrual.

### What positions are supported?

Sablier Lockup v4 streams on Base Sepolia (Lockup Linear only, created `transferable = true`, non-cancelable or renounced, not canceled or depleted, at least one whole token left to lock) and fee-free Streamflow streams on Solana devnet (`transfer_recipient` allowed for the recipient, no sender power left, a classic SPL Token mint without a freeze authority). Cancelable positions, Token-2022 mints and mints with a freeze authority are refused.

### My team vesting is not transferable. Can I use rose?

Not by self-deposit. The intended path is the issuer path: the issuer calls RoseVault `createStreams`, which creates the cohort's streams directly in custody, each naming the NEAR account that receives its units, and can distribute units with `distribute_units`, a bounded batch that emits NEP-245 events.

### What is an Advance?

A holder sells a senior claim on the first `K` tokens that will unlock from `X` of their units (`K <= X * (1 - f(ts))`). Funders bid sealed, per claimed token. Winners receive lien shares; the accruals of the encumbered units flow to them until `K` tokens are delivered, then the encumbrance ends. Encumbered units are non-transferable and cannot enter other rounds. No oracle, no liquidation.

### What is a cash venue?

The place where a round's cash lives: NEAR tUSDC, or Base USDC held by RoseVault. Each round declares exactly one at creation; every escrow, bond, fee and seller proceed of that round is claimable only there.

## Mechanism

### What is hidden during a round, and what is public?

Hidden until close: every price and every exact quantity. Public: the number of bids, each bid's escrow or locked units, and ciphertext hashes.

### Can the operator read bids?

No. Bids are encrypted to a per-round identity. Its key is derived by the NEAR MPC network only when the engine contract asks, and the only function that asks is guarded by `now >= closes_at`. The engine is keyless and has no upgrade path, so that guard cannot be removed.

### Who opens the bids after close?

Anyone. Once the key is public, every participant's browser can decrypt the book locally; the app opens all remaining bids in sequence for whoever clicks "Finalize". Each opening is one transaction of about 0.0132 NEAR in gas, fully verified by the contract.

### What if I submit garbage as a bid?

Nobody can open it, including you, because the contract verifies the ciphertext structure when opening. After the reveal window it is void and your bond is slashed. There is no way to decide after seeing the book.

### What if the MPC network never returns the key?

After `closes_at + key_timeout` (default 1 h), once no key request is in flight, anyone can call `cancel_no_key`. The round is `Cancelled` and every escrow, bond and locked unit is refundable. No bid is opened on chain, but the key may still become public through a late MPC response, so the sealed orders of a cancelled round can become readable after the fact. No funds move after `Cancelled`: the consequence is privacy only.

### What is the bond?

`max(1 USDC, 1% of the bid's escrow or of its locked units valued at the round's max price)`, posted in the round's cash token with each bid and refunded on a valid opening.

### How is the clearing price computed?

On-chain, from the opened bids, with deterministic tie rules. Tender: the ask price (at or below the max price) that maximizes the volume bought within the budget, ties to the lowest price. Exit: the price that maximizes `min(demand, supply)`, ties to the smallest imbalance, then the midpoint of the tied interval. Advance: the Exit rule with the holder's reserve as the single ask. See [Clearing rules](/docs/clearing-rules) for worked examples.

### What does a seller receive?

The clearing price `P*` per locked token, never their own minimum. Buyers pay `P*`, never their own limit.

### What are ticks?

Prices move in steps of 0.000001 USDC. Cash is computed per fill with buyers rounded up and sellers rounded down to the tick; the dust stays in the pool.

### What are the fees?

30 bps of settled notional, charged to the buying side on top of the price, shown before every bid and in every receipt. Sellers pay nothing. See [Fees](/docs/fees).

### Is there a keeper or a relayer?

No. Every lifecycle transition is a public method callable by anyone; the app shows the next action to whoever looks at the round. Foreign-chain transactions are broadcast by the beneficiary's browser. There is no database and no indexer: the contract keeps a bounded event history in state.

### Why are payouts "pull-based"?

Because pushing a payout to a foreign chain would need a relayer. Instead the engine debits your balance, stores an MPC-signed authorization (or a signed Solana transaction) on NEAR, and you submit it yourself. It never expires, cannot be used twice, and anyone can submit it for you. A Solana payout is then confirmed on NEAR (`confirm_sol_payout`) with a proof that it landed; it is refunded only on two proofs, 150 blocks apart, that it did not execute.

## Chains

### Which networks?

NEAR testnet, Base Sepolia and Solana devnet only. Nothing on mainnet.

### How do I get test funds?

The testnet banner's "Get test funds": a NEAR testnet account and NEAR, test USDC minted on-chain (NEAR and Base Sepolia, public capped mint), Base Sepolia gas through `/api/faucet`, Solana devnet SOL, and "Mint me a demo vesting position". See the [Buyer guide](/docs/guide-buyer#get-test-funds).

### Is `/api/faucet` part of the protocol?

No. It is a demo convenience that sends a little testnet gas from a server-side wallet and is rate-limited. The protocol has no off-chain component.

### Which wallets?

NEAR Wallet Selector wallets on testnet; injected EVM wallets on Base Sepolia; Phantom and Solflare on Solana devnet; plus an in-app demo wallet for each chain, for judges.

### Can I sell a position from the vault and keep nothing on NEAR?

Yes, in two ways. Sell your units in a round and claim the cash in the round's venue. Or `redeem` a position in kind: burn its allocation in units and take the stream back to your own address.

## Trust

### Who do I trust?

The NEAR MPC network (a threshold of nodes could break custody and sealing; foreign state is trusted to their RPC quorum), the keyless engine code, and the immutable RoseVault. For the tokens themselves, their issuers: on Base, an ERC-20 with pause or blacklist powers can freeze RoseVault's balance (on Solana, mints with a freeze authority are refused). Nobody else can move funds, see bids early or stop a round. See [Trust and security](/docs/trust-and-security).

### Is it audited?

No. Testnet only, no assets of value.

### Where are the addresses?

[Contracts and addresses](/docs/contracts-and-addresses) and the [status page](/status), which also checks live that the engine has no access keys.
