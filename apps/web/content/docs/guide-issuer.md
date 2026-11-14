---
title: Issuer guide
description: Create a class, distribute units, launch and fund a Tender, run it through a DAO, and report.
order: 8
section: Guides
---

This guide is for a foundation, project treasury or DAO that wants to buy back locked allocations from its insiders at one fair, public price. Every step names what to do and what you should see.

## Before you start

- Connect a NEAR testnet wallet (top bar, "Connect"). Visitors can use the in-app demo wallet.
- Open the wallet menu and use "Get test funds" to get NEAR, test USDC (tUSDC on NEAR or on Base Sepolia) and Base Sepolia gas. See [Buyer guide](/docs/guide-buyer#get-test-funds) for details.
- Decide the cash venue of your Tender: NEAR tUSDC, or a Base ERC-20 the engine accepts (rose Base tUSDC or Circle USDC), held by RoseVault. A round has exactly one venue and every escrow, fee and payout of that round lives there.

## 1. Create a class

Go to `/app/issuer` and choose "Create a class".

1. Pick the chain and the source: an existing stream (Sablier v4 on Base Sepolia, Streamflow on Solana devnet) or a schedule (start, cliff, end and the deposited amount, plus start unlock, cliff unlock and granularity on Base, or cliff amount and period on Solana).
2. The console shows the normalized schedule and the resulting unlock function `f(t)`.
3. You see the class id (the hash of the chain, token, decimals and normalized schedule) and the unlock timeline. Computing it costs nothing: the engine writes the class record with the first registered deposit of the class.

A class whose schedule already exists maps to the existing class: the class id is deterministic.

## 2. Create the cohort's positions and distribute units

Most team and investor vestings are not transferable, so the recommended path is to create the streams yourself directly in custody, or to move your own transferable streams in.

1. On Base, choose "Cohort streams" and paste the list of `(near_account, amount)` for the cohort. RoseVault `createStreams` pulls the tokens and creates one non-cancelable, transferable Lockup Linear stream per holder with the vault as recipient, in one transaction; each `StreamDeposited` event names the NEAR account that receives the units. The console then registers each stream on the engine once Base's safe head has passed the transaction (a few minutes), and the units are minted to each holder. You can also deposit transferable streams you hold through `/app/deposit`, naming your own NEAR account (see the [Holder guide](/docs/guide-holder#deposit-on-base)).
2. To pass units you hold to the cohort, choose "Distribute units" and paste the list of `(near_account, units)`. The console calls `distribute_units`, a bounded batch (up to 30 receivers per call, the engine's `MAX_DISTRIBUTION_RECEIVERS`) that emits NEP-245 events, and your wallet signs it.
3. You see the transactions with explorer links and, in each holder's portfolio (`/app`), their units with locked and claimable amounts.

Accrual follows the units: a holder's unlocked tokens accrue from the moment they hold the units.

## 3. Launch a Tender

On `/app/issuer`, choose "Launch Tender".

1. Select the class.
2. Set the budget in the cash token, and either a max price per locked token or a max discount to a reference price you declare. If you declare a reference price, the Prices page labels the resulting discount as "to the issuer-declared reference".
3. Set the window (`opens_at`, `closes_at`, at most 30 days after creation), the `key_timeout` (1 min to 7 d, default 1 h) and the `reveal_window` (5 min to 7 d, default 10 min in the demo, 24 h suggested in production). The form checks each bound as you type; the engine reports them in `get_limits`.
4. Set where the retired units' unlocked tokens go: an address you choose or a burn address (RoseVault and the engine's own addresses are refused).
5. The preview shows the escrow: budget plus 30 bps.
6. Confirm. You see the round at `/app/rounds/[id]` in state `Scheduled` or `Open`, with the public parameters, a countdown and an empty sealed book.

## 4. Fund it

If the venue is NEAR tUSDC, the escrow is taken from your NEAR cash balance when you create the round. If it is Base USDC, the console walks you through `depositCash(token, amount, nearAccount, roundId)` on RoseVault with your EVM wallet, then registers the deposit on NEAR with `register_base_cash` and a ForeignTx proof. You see the proof progress and then the round funded.

## 5. Run via DAO

Treasuries that need an on-chain vote set "Signed by" to "A DAO" in the "Launch Tender" step instead of signing themselves; the "Run via DAO" panel then builds the proposal.

1. Enter the Sputnik DAO account. The console builds a function-call proposal that creates and funds the Tender with the same parameters. A Trezu custom template is also produced for treasuries that use it.
2. Submit the proposal to the DAO from your wallet. You see the proposal link.
3. When the DAO approves, the proposal executes and the round appears in `/app/rounds`.

## 6. During the round

Holders see the Tender in `/app/rounds` and place sealed asks. You see the number of sealed asks and the units each has locked, nothing else. You cannot cancel after the first ask.

## 7. Close, finalize, settle

1. After `closes_at`, anyone can click "Close round" on `/app/rounds/[id]`. The engine requests the round key from the MPC network; you see the key release event when it arrives (typically a few seconds).
2. Click "Open every order" in the round's action card. The app opens every ask (one transaction each) and, when the reveal window ends, calls `clear`. The supply curve animates into the clearing price.
3. You see `P*`, the volume bought, the fills table, the fee and your refund.
4. The refund of unspent budget is credited to your cash balance when the round clears; "Claim" in your portfolio pulls it to your wallet (a DAO files the withdrawal proposal from the Results tab). Sellers settle their asks from the round's action card ("Settle my order", or "Settle every order", which anyone can run) and claim their proceeds.

## 8. Report

On the results page of the Tender, export the tender report as a CSV or a printable page. It contains: parameters, the sealed book as it was before close (counts and collateral), every opened ask, the candidate price table (`S(P)`, affordable quantity, `Q(P)`), `P*`, fills, fee, refund, and transaction links on NEAR and on the foreign chain. Your community can recompute the price from the same data with the "Verify" panel.

## If something goes wrong

- No key within 1 h of close: once no key request is in flight, the round page offers `cancel_no_key` to anyone; the round is `Cancelled` and your escrow is refundable.
- No ask at or below the max price: the round is `Cancelled` after clearing, escrow refundable.
- MPC timeout or an expired transaction: the action shows a retry button; retries are safe because every step is idempotent.
