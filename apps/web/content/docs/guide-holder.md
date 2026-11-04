---
title: Holder guide
description: Deposit a locked position on Base or Solana, sell in a Tender or Exit, sell an Advance, claim and redeem.
order: 9
section: Guides
---

This guide is for anyone who holds a transferable locked position (a VC, an angel, a KOL, a sale participant) or who received units from an issuer. Every step names what to do and what you should see.

## Before you start

- Connect a NEAR testnet wallet, and the wallet of the chain where your position lives: an EVM wallet on Base Sepolia or a Solana wallet (Phantom, Solflare) on devnet. The in-app demo wallets work for all three.
- Use "Get test funds" in the testnet banner for NEAR, gas and, if you have no position yet, "Mint me a demo vesting position" (a Sablier stream of the demo token on Base, or a Streamflow stream on Solana).

## Deposit on Base

Go to `/app/deposit` and choose Base.

1. The wizard lists your Sablier v4 streams and flags each as eligible or not. Ineligible reasons are explained: not Lockup Linear, cancelable, not transferable, depleted, or a token or schedule that does not match an existing class and cannot create one.
2. Approve RoseVault for the stream NFT. You see the approval transaction and its explorer link.
3. Deposit. RoseVault first withdraws any already vested balance to your EVM address, then takes the NFT and emits `StreamDeposited`. You see the deposit transaction and your withdrawn balance, if any.
4. The wizard registers the deposit on NEAR: it calls the engine, which asks the MPC network to verify the Base transaction. You see the proof progress (MPC verification) and then "units minted": `D` units of the class, where `D` is the stream's deposited amount, with a checkpoint at the deposit time.
5. Your portfolio (`/app`) now shows the class, your units, the locked and claimable amounts, and the unlock timeline.

## Deposit on Solana

Go to `/app/deposit` and choose Solana.

1. The wizard lists your Streamflow streams and flags eligibility (the recipient can transfer the stream, non-cancelable by the sender, schedule matching a class).
2. The app derives your deposit address for the class (`dep/<near_account>/<class>`). Call `transfer_recipient` to it from your Solana wallet. You see the transaction.
3. The engine signs a second `transfer_recipient` from the deposit address to the vault; the app broadcasts it (fees paid by the engine's `gas/sol`). You see the transaction.
4. The wizard proves the stream's metadata account to the engine (ForeignTx `AccountState`). You see the proof progress and then "units minted".
5. Your portfolio shows the class and your units.

## Sell in a Tender

1. Open `/app/rounds`, filter by type Tender and your class, and open the round. You see the issuer's public budget, max price, window, cash venue and the sealed book (number of asks and their locked units).
2. Click "Place ask". Enter the units to lock and, sealed, your minimum price per locked token and the quantity you actually sell (at most the locked units). The form shows the bond (`max(1 USDC, 1% of your locked units at the max price)`) and the venue.
3. Sign. Your units are locked in the round and keep accruing to you until `closes_at`. Your ask is encrypted in the browser; the round page lists it under "my bids" with its ciphertext hash.
4. After close, anyone can click "Close round", then "Finalize". If you are first, you pay about 0.012 NEAR per opened bid.
5. The round settles. You see `P*` and your fill. If your minimum was at or below `P*` you sold at `P*` (never at your minimum). Unsold units return with their accrual.
6. Click "Claim" to pull your proceeds in the round's venue, your bond and any unsold units.

## Sell in an Exit

Same as the Tender, from an Exit round: there is no single buyer, so `P*` is where sealed demand meets sealed supply. An Exit round for a class can be created by any account; other holders of the class join it with their own sealed asks, buyers with sealed bids.

## Sell an Advance on your first unlocks

An Advance sells a senior claim on the first `K` tokens that will unlock from `X` of your units, without selling the units.

1. Go to `/app/advance` and choose "Create an Advance".
2. Select the class and the units to encumber (`X`). Set `K`, at most `X * (1 - f(ts))` at the round's settlement time. Set your sealed reserve price per claimed token, your public minimum fill, and the window.
3. Confirm. The encumbered units become non-transferable and cannot enter other rounds until the lien is repaid. Funders browse the Advance and place sealed bids.
4. After close and finalization, you see `P*`, the filled part of `K`, and your proceeds. If the filled volume was below your minimum fill, the round is `Cancelled` and your units are free again.
5. Click "Claim" to pull the cash. From then on, the accruals of the encumbered units flow to the lien holders until the filled claim is delivered; your portfolio shows the lien, the delivered amount and the remaining claim. When it is repaid the encumbrance ends.

There is no oracle and no liquidation. The claim is repaid by the schedule.

## Claim unlocked tokens

Your portfolio (`/app`) shows the claimable tokens per class and chain.

- Base: click "Claim". The app calls Sablier `withdrawMax(streamId, RoseVault)` if needed, then asks the engine for a `Transfer` authorization signed by the MPC, then submits `executeTransfer` to RoseVault from your EVM wallet (you pay the Base gas). You see three explorer links.
- Solana: click "Claim". You create the payout's durable nonce account, the engine builds and signs the withdrawal, and the app broadcasts it. You see the NEAR and Solana links.
- Cash: click "Claim" next to your cash balance in the venue where it lives (NEAR tUSDC or Base USDC).

An authorization that was signed but not submitted stays in your portfolio until you submit it; it never expires and cannot be used twice.

## Redeem in kind

If you hold at least `D_p` units of a class, where `D_p` is the allocation of a position in that class, you can take the position itself back out.

1. In your portfolio, choose to redeem the position (`redeem(position_id)`). The engine burns `D_p` units from your account.
2. On Base, the engine authorizes an ERC-721 `Release`; any withdrawable balance is first withdrawn to the vault so accrued tokens stay with unit holders. Submit `executeRelease` from your EVM wallet. You see the stream NFT in your wallet.
3. On Solana, the engine builds `withdraw` then `transfer_recipient`; the app broadcasts it. You see the stream with your address as recipient.

Units locked in a round and encumbered units cannot be redeemed.
