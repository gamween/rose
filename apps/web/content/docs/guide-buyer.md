---
title: Buyer guide
description: Get test funds, bid sealed in an Exit or Advance, claim your units and unlocked tokens.
order: 10
section: Guides
---

This guide is for a fund, an OTC desk or a long-term holder who wants to buy locked supply at a discount and hold the lock. Every step names what to do and what you should see.

## Get test funds

Everything runs on testnets. Open the testnet banner and use "Get test funds":

- NEAR: a testnet account and NEAR for gas. The in-app demo wallet creates one for you.
- Test USDC: minted on-chain by anyone, on NEAR testnet (`tusdc.rose-app.testnet`) and on Base Sepolia. The mint is capped at 10,000 tUSDC per account per rolling 24 h, and the token is labeled "Test USDC". Circle's Base Sepolia USDC is also accepted as a Base cash token when you already have it.
- Base Sepolia gas: a little ETH from the `/api/faucet` route (a demo convenience, not part of the protocol).
- Solana devnet SOL, for the Solana deposit flow.
- "Mint me a demo vesting position": a Sablier stream of the demo token on Base, or a Streamflow stream on Solana, if you want to try the holder side too.

You see each balance in the top bar next to the connected wallet.

## Choose a round

Open `/app/rounds` and filter by type (Exit or Advance), class and status. Each card shows the class, the cash venue, the countdown and the sealed book: the number of bids and their public collateral.

Open the round. You see the public parameters, the unlock timeline of the class, the remaining lock duration at settlement, and the "Learn more" links. In an Exit you are buying units that inherit the exact schedule. In an Advance you are buying a senior claim on the first tokens that unlock from the holder's units; see [Concepts](/docs/concepts#advance).

Check the venue: your escrow, bond and, if you win, your refund live there. Fund your cash balance in that venue first if needed: on NEAR, deposit tUSDC into your engine cash balance; on Base, `depositCash` to RoseVault, which the app then registers on NEAR with `register_base_cash` and a ForeignTx proof.

## Bid sealed

1. Click "Place bid".
2. Enter your escrow (public): the cash you lock for the bid. Then, sealed, your limit price per locked token (per claimed token in an Advance) and your quantity. The sealed `limit * quantity` plus its 30 bps fee must not exceed your escrow, or the bid is void and its bond is slashed at clearing.
3. The form shows the live fee (30 bps of the notional, on top of the price), the bond (`max(1 USDC, 1% of the escrow)`), the venue and the total collateral.
4. Sign. In an Exit you receive units, so your account needs a NEP-145 storage registration on the engine first (`storage_deposit`, about 0.00216 NEAR minimum; the form offers it). Each order also attaches 0.02 NEAR of storage, refunded at settlement net of the bytes kept for its outcome. Your bid is encrypted in the browser against the round's identity before it leaves your machine. The round page lists it under "my bids" with its ciphertext hash. Nobody can read the limit or the quantity before the round closes, not the operator and not the MPC nodes individually.

You cannot change or withdraw a bid once placed.

## After close

1. After `closes_at`, anyone can click "Close round"; the engine requests the round key from the MPC network. You see the key release event.
2. Click "Finalize". The app opens every bid and ask; your browser can also decrypt the full book locally. After the reveal window, `clear` runs and the supply and demand curves animate into `P*`.
3. You see your fill: full if your price level fit entirely in the traded volume, pro rata if your level was the marginal one (which can be above `P*`), none if your limit was below `P*` or your level came after the marginal one. You pay `P*`, never your limit.

## Claim

Click "Claim" on the round or in your portfolio.

- Exit: you receive the units, accruing to you from `ts = closes_at`. Your unused escrow and your bond are refunded in the venue.
- Advance: you receive lien shares. Accruals of the encumbered units flow to you in proportion to your share until the claim is delivered.

Your portfolio (`/app`) shows the units, the locked and claimable amounts, the liens as funder, and the history with explorer links.

## Claim unlocked tokens

As the schedule unlocks, your claimable tokens grow. Click "Claim" per class and chain:

- Base: the app withdraws from Sablier to RoseVault if needed, the engine debits your claimable balance and asks the MPC for a `Transfer` authorization, and you submit `executeTransfer` to RoseVault from your EVM wallet. You pay the Base gas.
- Solana: the first time, you create your payout nonce account from your Solana wallet (derived with a seed tied to your NEAR account, reused for later claims); the engine builds and signs the transaction, the app broadcasts it, then confirms on NEAR that it landed (`confirm_sol_payout`).

Each step has a loading, success and failure state with an explorer link and a retry.

## Verify the result

On any settled round, the "Verify" panel recomputes `P*` and the fills in your browser from the opened bids stored on-chain, using the same rules as the contract ([Clearing rules](/docs/clearing-rules)). The numbers must match. If you prefer not to trust the app at all, the SDK exposes the same clearing reference.
