---
title: Holder guide
description: Deposit a locked position on Base or Solana, sell in a Tender or Exit, sell an Advance, claim and redeem.
order: 9
section: Guides
---

This guide is for anyone who holds a transferable locked position (a VC, an angel, a KOL, a sale participant) or who received units from an issuer. Every step names what to do and what you should see.

## Before you start

- Connect a NEAR testnet wallet, and the wallet of the chain where your position lives: an EVM wallet on Base Sepolia or a Solana wallet (Phantom, Solflare) on devnet. The in-app demo wallets work for all three.
- Use "Get test funds" in the wallet menu for NEAR, gas and, if you have no position yet, "Mint me a demo vesting position" (a Sablier stream of the demo token on Base, or a Streamflow stream on Solana).

## Deposit on Base

Go to `/app/deposit` and choose Base.

1. The wizard lists your Sablier v4 streams and flags each as eligible or not. Ineligible reasons are explained: not Lockup Linear, cancelable, not transferable, canceled, depleted, less than one whole token left to lock, or a token or schedule that does not match an existing class and cannot create one.
2. Approve RoseVault for the stream NFT. You see the approval transaction and its explorer link.
3. Deposit. RoseVault first withdraws any already vested balance to your EVM address, then takes the NFT and emits `StreamDeposited`. You see the deposit transaction and your withdrawn balance, if any.
4. The wizard waits until Base's safe head has passed your deposit (about 3 minutes), then registers the deposit on NEAR: it calls the engine, which asks the MPC network to verify the Base transaction. You see the proof progress (MPC verification) and then "units minted": `D` units of the class, where `D` is the stream's deposited amount, with a checkpoint at the fraction already withdrawn to you (never below the unlock at the deposit time, never above the unlock now), so what vested before the deposit is not counted twice. In the rare case where more was withdrawn than has unlocked by registration, you receive fewer units instead, exactly as many as the stream still pays. If the engine refuses the stream instead, the wizard lists it under refused deposits with a "Return my stream" action: the engine signs a `Release` with `vestedToRecipient = true` and `executeRelease` sends the stream back to your address together with what vested while the vault held it.
5. Your portfolio (`/app`) now shows the class, your units, the locked and claimable amounts, and the unlock timeline.

## Deposit on Solana

Go to `/app/deposit` and choose Solana.

1. The wizard lists your Streamflow streams and flags eligibility (the recipient can transfer the stream; not cancelable or transferable by the sender, not pausable, no rate updates, no top-ups, no automatic withdrawal, no Streamflow or partner fee; at least one whole token left to lock; an end more than one hour away, since Streamflow's auto-claim empties a stream at its end; a classic SPL Token mint without a freeze authority).
2. The app derives your deposit address for the class (`dep/<near_account>/<class>`). Call `transfer_recipient` to it from your Solana wallet. You see the transaction.
3. The wizard attributes the stream to your NEAR account (`attribute_sol_deposit`): the engine proves with ForeignTx `AccountState` that the stream sits at your deposit address. An ineligible stream is recorded as refused and can be returned to your Solana address.
4. The engine builds and signs the move from the deposit address to the vault (`move_sol_deposit`); the app broadcasts it (fees paid by the engine's `gas/sol`). You see the transaction.
5. The wizard proves the stream at the vault to the engine (`register_sol_deposit`, ForeignTx `AccountState`). You see the proof progress and then "units minted".
6. Your portfolio shows the class and your units.

## Sell in a Tender

1. Open `/app/rounds`, filter by type Tender and your class, and open the round. You see the issuer's public budget, max price, window, cash venue and the sealed book (number of asks and their locked units).
2. Click "Place ask". Enter the units to lock and, sealed, your minimum price per locked token and the quantity you actually sell (at most the locked units). The form shows the bond (`max(1 USDC, 1% of your locked units at the max price)`) and the venue.
3. Sign. Your units are locked in the round and keep accruing to you until `closes_at`. Your ask is encrypted in the browser; the round page lists it under "my bids" with its ciphertext hash.
4. After close, anyone can click "Close round", then "Open every order". If you are first, you pay about 0.0132 NEAR of gas per opened bid.
5. The round settles. You see `P*` and your fill. If your minimum was at or below `P*` you sold at `P*` (never at your minimum). Unsold units return with their accrual.
6. Click "Settle my order" in the round's action card: your proceeds in the round's venue, your bond and any unsold units come back to your NEAR ledger. Then "Claim" in your portfolio pulls the cash out.

## Sell in an Exit

Same as the Tender, from an Exit round: there is no single buyer, so `P*` is where sealed demand meets sealed supply. An Exit round for a class can be created by any account; other holders of the class join it with their own sealed asks, buyers with sealed bids.

## Sell an Advance on your first unlocks

An Advance sells a senior claim on the first `K` tokens that will unlock from `X` of your units, without selling the units.

1. Go to `/app/advance` and choose "Create an Advance".
2. Select the class and the units to encumber (`X`). Set `K`, at most `X * (1 - f(ts))` at the round's settlement time. Set your sealed reserve price per claimed token, your public minimum fill, and the window.
3. Confirm. The encumbered units become non-transferable and cannot enter other rounds until the lien is repaid. Funders browse the Advance and place sealed bids.
4. After close and finalization, you see `P*`, the filled part of `K`, and your proceeds. If the filled volume was below your minimum fill, the round is `Cancelled` and your units are free again.
5. Click "Settle my order" in the round's action card, then "Claim" in your portfolio to pull the cash. From then on, the accruals of the encumbered units flow to the lien holders until the filled claim is delivered; your portfolio shows the lien, the delivered amount and the remaining claim. When it is repaid the encumbrance ends.

There is no oracle and no liquidation. The claim is repaid by the schedule.

## Claim unlocked tokens

Your portfolio (`/app`) shows the claimable tokens per class and chain.

- Base: click "Claim". The app calls Sablier `withdrawMax(streamId, RoseVault)` if needed, then asks the engine for a `Transfer` authorization signed by the MPC, then submits `executeTransfer` to RoseVault from your EVM wallet (you pay the Base gas). You see three explorer links.
- Solana: click "Claim". The first time, you create your two payout nonce accounts from your Solana wallet in one transaction (the durable nonce and the receipt, derived with seeds tied to your NEAR account, authority = the engine's vault; both are reused for later claims). The engine proves them and your token account, builds and signs the withdrawal, the app broadcasts it, then confirms on NEAR that it landed (`confirm_sol_payout`, which reads the receipt). You see the NEAR and Solana links. A stream takes no new draw from five minutes before its end; Streamflow's auto-claim then moves its remainder into the vault's token account; once anyone books it with `sync_sol_stream` (the portfolio's "Sync" button on the ended stream), "Claim" pays from the class's swept balance first (`swept` in `claim_sol_tokens`), then from the streams.
- Cash: click "Claim" next to your cash balance in the venue where it lives (NEAR tUSDC or Base USDC).

An authorization that was signed but not submitted stays in your portfolio until you submit it; it never expires and cannot be used twice. A signed Solana payout likewise stays until it is broadcast and confirmed; it is refunded only if the engine proves, twice and 150 blocks apart, that its receipt stayed behind, so it did not execute.

## Redeem in kind

If you hold at least `D_p` units of a class, where `D_p` is the allocation of a position in that class, you can take the position itself back out.

1. In your portfolio, choose to redeem the position (`redeem(position_id, to)`). The engine burns `D_p` units from your free units.
2. On Base, the engine authorizes an ERC-721 `Release` with `vestedToRecipient = false`: any withdrawable balance is first withdrawn to the vault so accrued tokens stay with unit holders. Submit `executeRelease` from your EVM wallet. You see the stream NFT in your wallet.
3. On Solana, the stream must carry no unconfirmed payout and be more than five minutes from its end, and you also pay, from your claimable tokens of the class, what the stream still owes the unit holders. The engine builds `AdvanceNonceAccount`, `transfer_recipient` from the vault to your address, then the receipt's `AdvanceNonceAccount`; the app broadcasts it, then confirms it on NEAR (`confirm_sol_redeem`, which reads the receipt). You see the stream with your address as recipient.

Units locked in a round and encumbered units cannot be redeemed.
