# Demo script

The script of the 3-minute demo video, scene by scene: what is on screen, what to click, what to
say, and which explorer link to open. It follows the seeded story of spec section 9: the fictional
**Cindral Foundation** and its token **Cindral (CINDR)**, whose cohorts, holders and rounds were
created on the real testnets by `scripts/seed.ts` and driven to settlement by `scripts/e2e-live.ts`
against the final, keyless engine `engine-v2.rose-app.testnet`. Every transaction named below is listed in
[`verification.md`](./verification.md), section "Live end-to-end, engine-v2".

The Monad case in scene 1 is a sourced public fact, shown as a citation card. The video never uses
Monad's name as a character, its logo or its branding, and never presents Cindral as a real project
(the name was checked against CoinGecko, CoinMarketCap, DefiLlama and DexScreener: no project
named Cindral. DexScreener lists one unrelated Ethereum token whose ticker is also CINDR, a single
Uniswap pair with about 8,500 USD of market cap; the video therefore always shows the ticker next
to the name Cindral).

## Before recording

- App: https://rose-rounds.vercel.app, running against the engine the README's address table names.
  Browser at 1470 px wide, dark system theme, no extensions in view.
- Open in tabs, in this order: the landing page, `/app/demo` ("Watch a full round"), `/app/rounds`,
  `/app/rounds/1`, `/app/rounds/2`, `/app` (portfolio), `/status`, and the explorer links of each
  scene below (NEAR on `testnet.near.rocks`, Base on `sepolia.basescan.org`, Solana on
  `explorer.solana.com` with `?cluster=devnet`). Basescan shows a Cloudflare check to a fresh
  browser: open its tabs once before recording.
- Narration is read at about 150 words per minute; each scene's text fits its time slot.

## The cast

| Who | Role in the story | Positions |
|---|---|---|
| Cindral Foundation | Issuer: runs the buyback (Tender) | Treasury on Base and Solana |
| Halden Ventures | Seed investor: sells in the Tender, buys in the Exit | Seed Round, Base (Sablier stream 157, 400,000 CINDR) |
| Tessaro Capital | Seed investor: sells in the Tender, bids in the Exit | Seed Round, Base (stream 158, 250,000 CINDR) |
| Ines Marlow | Strategic investor: sells in the Exit, funds the Advance | Strategic Round, Solana (Streamflow, 300,000 CINDR) |
| Varick Partners | Strategic investor: sells in the Exit, funds the Advance | Strategic Round, Solana (Streamflow, 200,000 CINDR) |
| Teodor Vance | KOL: sells an Advance on his first unlocks | KOL Round, Base (stream 159, 60,000 CINDR) |
| Nadia Solvik | KOL: places a malformed bid, then redeems her position in kind | KOL Round, Base (streams 160 and 161) |

The rounds: **round 0** Tender on the Seed Round (Base tUSDC), **round 1** Exit on the Strategic
Round's Solana positions (NEAR tUSDC), **round 2** Advance on Teodor Vance's KOL units (NEAR tUSDC),
**round 3** an Exit nobody closed, cancelled by `cancel_no_key`. **Round 4** is an Exit on the Seed
Round left open until 20 November 2026 with Halden Ventures' sealed ask, so viewers can place their
own sealed bid from the app.

## Scenes

### 1. The problem (0:00 to 0:20)

- **Screen:** a black card with the quote and its source, then a second card with the 2025-2026
  bilateral buybacks (Omni, LayerZero, Ethena, Monad) and their source links from spec section 1.
- **Say:** "In August 2026 a foundation offered to buy its early investors' locked tokens, up to
  sixty million dollars, at a discount it set itself. Its own announcement says: nearly all holders
  approached declined. One fixed price only finds the few sellers who value their lock below it.
  Corporate finance solved this decades ago: sealed asks, one uniform price. Crypto still does
  these deals one investor at a time."
- **Source on screen:** https://monad.xyz/blog/early-investor-liquidity-program ("Nearly all holders
  approached declined to participate", capped at $60 million, published 17 August 2026).

### 2. What rose is (0:20 to 0:35)

- **Screen:** the landing page; scroll through the dragon sequence until "What was locked, rose."
  lights up, then hover the dragon to reveal "Launch app".
- **Say:** "rose runs sealed, uniform-price rounds for locked token allocations. The positions stay
  where they live, Sablier streams on Base and Streamflow streams on Solana. NEAR holds them through
  Chain Signatures, and nobody, not even us, can read a bid before the round closes."

### 3. A fictional issuer, real positions (0:35 to 0:55)

- **Click:** "Launch app", then `/app/rounds`; filter nothing, show the Cindral rounds.
- **Screen:** the round cards with their classes (Seed Round, Strategic Round, KOL Round) and
  venues; then the Seed Round class on `/app/prices` or the round page's unlock timeline.
- **Say:** "Cindral Foundation is a made-up issuer. Its cohorts are not: the Seed and KOL rounds are
  Sablier streams the foundation created straight into rose's vault on Base, the Strategic round is
  Streamflow streams on Solana. Every deposit was attested to the NEAR contract by the MPC network's
  foreign transaction verification."
- **Explorer:** `createStreams` of the Seed Round,
  [0xc2cf7629…](https://sepolia.basescan.org/tx/0xc2cf76299e247fabcc8f167f312203a278e43111acea652c7b5f99ece3e2fb45),
  then the registration of Tessaro Capital's stream 158 on NEAR,
  [3B4xGvii…](https://testnet.near.rocks/tx/3B4xGviiUP7aA4KKa9GRPeMJ519S8zWi7TvHeQcZMvvi).

### 4. Watch a full round: the Tender (0:55 to 1:45)

- **Click:** `/app/demo`, "Watch a full round" on round 0. The guided mode steps through the
  pre-seeded round with its real transactions; click "Next" at each step.
- **Step "Sealed":** the book shows two sealed asks, their locked units and ciphertext hashes, and
  nothing else. **Say:** "The foundation offers fifteen hundred test dollars at most four cents per
  locked token. Two seed investors answer with sealed asks. On chain you see that two asks exist and
  how many units each locked. Not one price."
- **Step "Key released":** **Say:** "After the deadline anyone closes the round. The contract asks
  the NEAR MPC network for the round's key, and the network can only release it now. It arrived
  4.8 seconds after the close." **Explorer:**
  [close, 82iWCcCj…](https://testnet.near.rocks/tx/82iWCcCjj1Jb9CBNiR4vtsv5Si9tkQRPsB8fv47Ck377).
- **Step "Opened":** **Say:** "Anyone can now open any ask, and the contract verifies every opening
  in full. Here the openings come from rose's deployment account, which placed no order and created
  no round." **Explorer:**
  [open_bid, Eqq9Cwqy…](https://testnet.near.rocks/tx/Eqq9CwqytozdU8jv4G526aC3gNtPYTs8Sz9LhST8eJTD),
  sent by `rose-app.testnet`.
- **Step "Cleared":** the supply curve meets the budget line at 0.036. **Say:** "One price for
  everyone: 3.6 cents. Halden sold all forty thousand tokens it asked at three cents, and was paid
  3.6. Tessaro, at the margin, was rationed. The foundation bought about forty-one thousand seven
  hundred locked tokens for exactly its budget." **Explorer:**
  [clear, 2cvvExqG…](https://testnet.near.rocks/tx/2cvvExqGXGTMwunyC4xYN9YigCCxduytVDLNZxhetqDn).
- **Click:** "Verify" on the round page. **Say:** "And your browser recomputes the same price from
  the opened asks."

### 5. A bid nobody can open (1:45 to 2:10)

- **Click:** `/app/rounds/1`, the Exit on the Strategic Round's Solana positions.
- **Say:** "This Exit had five sealed orders. Nadia's bid was malformed on purpose. She cannot open
  it herself, even with her own plaintext: the contract refuses it. So nobody can wait, look at the
  book, and then decide to reveal. After the window her bond is slashed, and the round clears without
  her at 2.7 cents."
- **Explorer:** her refused opening
  [CnvMqSd2…](https://testnet.near.rocks/tx/CnvMqSd25evQwrSRmHezWhQf3mXTX6ME2TSVe1JNFYwk), the slash at
  settlement [93F56CBa…](https://testnet.near.rocks/tx/93F56CBaDPUZrdcuUjvccnDb9qDVKKamMyDVz7nyfFJu),
  the clearing [GFhakKKW…](https://testnet.near.rocks/tx/GFhakKKWK2oZWR8xw3CiTetdZqxnhsr65aXmDDTXAAyu).

### 6. Paid on the chain where the position lives (2:10 to 2:40)

- **Screen:** split view, NEAR transaction on the left, foreign transaction on the right.
- **Say:** "Settlement happens in one ledger on NEAR, and payouts land on the chain where the
  position lives. Halden's Tender proceeds: the MPC signs an authorization, and the vault on Base
  pays. Varick funded Teodor's Advance and is repaid from Teodor's unlocks, in CINDR, on Base. Nadia
  takes her whole stream back. And on Solana, a payout counts only once the chain proves it landed."
- **Explorer, in order:**
  1. Halden, 1,460 tUSDC on Base: `withdraw_base_cash`
     [9BESbgMJ…](https://testnet.near.rocks/tx/9BESbgMJ85ixAdGiY8XQ1R5rRRFX4wDimkrng9C5cWEu), then
     `executeTransfer`
     [0xb403f62a…](https://sepolia.basescan.org/tx/0xb403f62afe5728f748cdbe80a630e3aab7b7d2705eb953e81d2d878117edd432).
  2. Varick's Advance repayment in CINDR: `claim_base_tokens`
     [7SsvHCs3…](https://testnet.near.rocks/tx/7SsvHCs3gMQrNUmaKHc9BZK65B23EW4VtNpvNsHgnwB1), then
     `executeTransfer`
     [0x578ccbcd…](https://sepolia.basescan.org/tx/0x578ccbcd74ddc1d806f386562dab8bbd02f1168f19a9f320b0a040ddfa1db571).
  3. Nadia's redeem in kind: `executeRelease` of stream 161
     [0x59e6facd…](https://sepolia.basescan.org/tx/0x59e6facd04330c6d15a9a11559eb2ccd76e1787976e0bee0ab79a1e88e02d2c6).
  4. A Solana claim from a Streamflow position: the engine-built transaction
     [46ZF74WS…](https://explorer.solana.com/tx/46ZF74WSUihFctEX5YYQcTEiBbfUC6dxUXpq6eHFUbf9Hd5zj6ybgd9etxFWCsNqVhy4g18yeeS2LJZHNgxRV4U6?cluster=devnet),
     then `confirm_sol_payout` proving it landed
     [Bv9RZpax…](https://testnet.near.rocks/tx/Bv9RZpaxVzX2G9CZqAM8LvpRZoB9QXunYFpCoJ7yji4K).

### 7. Nobody to trust with the keys (2:40 to 2:55)

- **Click:** `/status`.
- **Screen:** the keyless check (the raw `view_access_key_list` result), the MPC version, the
  key-release latency of recent rounds, the RoseVault signer check.
- **Say**, with `/status` showing `view_access_key_list` returning `[]` for `engine-v2.rose-app.testnet`:
  "This engine has no access key and no upgrade method. Its keys were deleted right after it was
  deployed from a reproducible build, so nobody, us included, can change it."
- **Say:** "If the network never releases a key, anyone cancels the round and everyone is refunded.
  That is round three."
- **Explorer:** [cancel_no_key, GuA2xPAB…](https://testnet.near.rocks/tx/GuA2xPAB5ifbzwjAqv6LbfmHzSMnqPmvrQdvLaWsWj8e).

### 8. Close (2:55 to 3:00)

- **Screen:** "What was locked, rose." with the app URL and the repository URL.
- **Say:** "rose. Sealed rounds for locked tokens, settled on NEAR. Try it on testnet."

## The demo post

The author posted the demo video on X on 14 November 2026:
https://x.com/dvb_fianso/status/2121674689114444258
