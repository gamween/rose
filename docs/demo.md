# Demo script

The script of the 3-minute demo video, scene by scene: what is on screen, what to click, what to
say, and which explorer link to open. It follows the seeded story of spec section 9: the fictional
**Cindral Foundation** and its token **Cindral (CINDR)**, whose cohorts, holders and rounds were
created on the real testnets by `scripts/seed.ts` and driven to settlement by `scripts/e2e-live.ts`
against the staging engine `engine-s5.rose-app.testnet`. Every transaction named below is listed in
[`verification.md`](./verification.md), section "Staging deployment 5".

The Monad case in scene 1 is a sourced public fact, shown as a citation card. The video never uses
Monad's name as a character, its logo or its branding, and never presents Cindral as a real project
(the name was checked against CoinGecko, CoinMarketCap, DefiLlama and DexScreener: no match).

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
| Halden Ventures | Seed investor: sells in the Tender, buys in the Exit | Seed Round, Base (Sablier stream 101, 400,000 CINDR) |
| Tessaro Capital | Seed investor: sells in the Tender, bids in the Exit | Seed Round, Base (stream 102, 250,000 CINDR) |
| Ines Marlow | Strategic investor: sells in the Exit, funds the Advance | Strategic Round, Solana (Streamflow, 300,000 CINDR) |
| Varick Partners | Strategic investor: sells in the Exit, funds the Advance | Strategic Round, Solana (Streamflow, 200,000 CINDR) |
| Teodor Vance | KOL: sells an Advance on his first unlocks | KOL Round, Base (stream 103, 60,000 CINDR) |
| Nadia Solvik | KOL: places a malformed bid, then redeems her position in kind | KOL Round, Base (streams 104 and 105) |

The rounds: **round 0** Tender on the Seed Round (Base tUSDC), **round 1** Exit on the Strategic
Round's Solana positions (NEAR tUSDC), **round 2** Advance on Teodor Vance's KOL units (NEAR tUSDC),
**round 3** an Exit nobody closed, cancelled by `cancel_no_key`.

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
  [0xb87e1f42…](https://sepolia.basescan.org/tx/0xb87e1f4256248d13fe5d893985a48f3e11dfb69cf6f66b7b52291999549ec985),
  then its registration on NEAR,
  [H5NLXune…](https://testnet.near.rocks/tx/H5NLXuneb9WgEUtPQ4ppC8Ku592YpVCcb3wBUbc6imoG).

### 4. Watch a full round: the Tender (0:55 to 1:45)

- **Click:** `/app/demo`, "Watch a full round" on round 0. The guided mode steps through the
  pre-seeded round with its real transactions; click "Next" at each step.
- **Step "Sealed":** the book shows two sealed asks, their locked units and ciphertext hashes, and
  nothing else. **Say:** "The foundation offers fifteen hundred test dollars at most four cents per
  locked token. Two seed investors answer with sealed asks. On chain you see that two asks exist and
  how many units each locked. Not one price."
- **Step "Key released":** **Say:** "After the deadline anyone closes the round. The contract asks
  the NEAR MPC network for the round's key, and the network can only release it now. It arrived
  5.4 seconds after the close." **Explorer:**
  [close, GpiGfPHZ…](https://testnet.near.rocks/tx/GpiGfPHZZtCeLb1kE7r6rSCBLZ7Qbpg9Xrhb1Bnk7E4u).
- **Step "Opened":** **Say:** "Anyone can now open any ask, and the contract verifies every opening
  in full. Here the openings come from rose's deployment account, which placed no order and created
  no round." **Explorer:**
  [open_bid, 9JKcYjKZ…](https://testnet.near.rocks/tx/9JKcYjKZqsiSrFX5pmk6tpEmnVxXwpmaYUoeU91bcWKB),
  sent by `rose-app.testnet`.
- **Step "Cleared":** the supply curve meets the budget line at 0.036. **Say:** "One price for
  everyone: 3.6 cents. Halden sold all forty thousand tokens it asked at three cents, and was paid
  3.6. Tessaro, at the margin, was rationed. The foundation bought about forty-one thousand seven
  hundred locked tokens for exactly its budget." **Explorer:**
  [clear, CR1hxSV9…](https://testnet.near.rocks/tx/CR1hxSV9LS5LkyTA8spn5gp1PH7rCipg3hg4YbZxUJgT).
- **Click:** "Verify" on the round page. **Say:** "And your browser recomputes the same price from
  the opened asks."

### 5. A bid nobody can open (1:45 to 2:10)

- **Click:** `/app/rounds/1`, the Exit on the Strategic Round's Solana positions.
- **Say:** "This Exit had five sealed orders. Nadia's bid was malformed on purpose. She cannot open
  it herself, even with her own plaintext: the contract refuses it. So nobody can wait, look at the
  book, and then decide to reveal. After the window her bond is slashed, and the round clears without
  her at 2.7 cents."
- **Explorer:** her refused opening
  [EE9vC4QR…](https://testnet.near.rocks/tx/EE9vC4QRDFPWp4VzwtA3TTGRuiWKxh9Aqnnoo5XgkUsq), the slash at
  settlement [Gq2uLUZu…](https://testnet.near.rocks/tx/Gq2uLUZu9QVo97LqnxpnxAZUgw1A3azqXf4gDWc1TJJw),
  the clearing [5ZeCEuJd…](https://testnet.near.rocks/tx/5ZeCEuJdnbJdKq9Rnhjkd3EFtjss54qGEjA6tT5WiTrD).

### 6. Paid on the chain where the position lives (2:10 to 2:40)

- **Screen:** split view, NEAR transaction on the left, foreign transaction on the right.
- **Say:** "Settlement happens in one ledger on NEAR, and payouts land on the chain where the
  position lives. Halden's Tender proceeds: the MPC signs an authorization, and the vault on Base
  pays. Varick funded Teodor's Advance and is repaid from Teodor's unlocks, in CINDR, on Base. Nadia
  takes her whole stream back. And on Solana, a payout counts only once the chain proves it landed."
- **Explorer, in order:**
  1. Halden, 1,460 tUSDC on Base: `withdraw_base_cash`
     [HxgYaFiD…](https://testnet.near.rocks/tx/HxgYaFiDSboF5JrpdANb7qaV7YdhKymABaHAEfifizGJ), then
     `executeTransfer`
     [0x75a38f07…](https://sepolia.basescan.org/tx/0x75a38f070d031326c6d6bd6e265b0d48e3a5e4dde749aaf8618db2dc3b010dba).
  2. Varick's Advance repayment in CINDR: `claim_base_tokens`
     [4iBThtxz…](https://testnet.near.rocks/tx/4iBThtxza5rpVL1TMcPji4eS8tbbhEQNQi2j96VpZf25), then
     `executeTransfer`
     [0x7add0744…](https://sepolia.basescan.org/tx/0x7add0744d85a77472356d5b5829dfba6492e983d0f967568e94e3999f93b4345).
  3. Nadia's redeem in kind: `executeRelease` of stream 105
     [0xc759e819…](https://sepolia.basescan.org/tx/0xc759e819ca69d013693d187bfa628bd7f53edf21788b0a0196ddf8991cf6e500).
  4. A Solana claim from a Streamflow position: the engine-built transaction
     [4vwuRBBJ…](https://explorer.solana.com/tx/4vwuRBBJZVVux348EB1g316t12wZBtJYkmNRHa887VGqupoSQoiHv3KX62q5dcC1jVowu1ZD26Qmep2EEsYu9eTD?cluster=devnet),
     then `confirm_sol_payout` proving it landed
     [BRV8Voje…](https://testnet.near.rocks/tx/BRV8VojeGDC2hXjYMiiMjGoTaRyhG7gUk1HWH4mjNE85).

### 7. Nobody to trust with the keys (2:40 to 2:55)

- **Click:** `/status`.
- **Screen:** the keyless check (the raw `view_access_key_list` result), the MPC version, the
  key-release latency of recent rounds, the RoseVault signer check.
- **Say**, if `/status` shows `view_access_key_list` returning `[]` (the final, keyless engine):
  "This engine has no access key and no upgrade method." While the app still runs a staging engine,
  say instead: "The engine has no upgrade method, and its final deployment deletes every access key;
  this staging one still has a key, and the status page says so."
- **Say:** "If the network never releases a key, anyone cancels the round and everyone is refunded.
  That is round three."
- **Explorer:** [cancel_no_key, FzHeiPW7…](https://testnet.near.rocks/tx/FzHeiPW7YnZ4sgyuUz8TFbfEzf2jYghT4wNVp713cB7H).

### 8. Close (2:55 to 3:00)

- **Screen:** "What was locked, rose." with the app URL and the repository URL.
- **Say:** "rose. Sealed rounds for locked tokens, settled on NEAR. Try it on testnet."

## DRAFT, not posted: X thread for the owner

> **Status: draft, not posted.** This text is a proposal for the owner. Only the owner reviews,
> edits and posts it, from their own account, once the repository is public and the video is
> uploaded. No agent or script posts it, schedules it or sends it anywhere. The links are the
> deployed app, the public repository and the video the owner attaches.

> 1/ In August 2026 a foundation offered to buy its early investors' locked tokens at a price it set.
> Its own post: "Nearly all holders approached declined."
> One fixed price only finds the few sellers who value their lock below it.
>
> We built rose at NEAR HACKATHON to fix that. 🌹 @NEARProtocol #NEARHackathon

> 2/ rose runs sealed, uniform-price rounds for locked token allocations.
> A project buys back its insiders' locked tokens without guessing a price. Holders of the same
> allocation exit together instead of dumping at the unlock. One clearing price for everyone.

> 3/ What NEAR does here, concretely:
> - Bids are encrypted to a key the NEAR MPC network releases only after the deadline (Confidential
>   Key Derivation). Nobody, not even us, reads a bid early.
> - The positions stay on Base (Sablier) and Solana (Streamflow); a NEAR contract holds them
>   through Chain Signatures and pays out on each chain.

> 4/ In the video: a fictional issuer runs a buyback against two seed investors. The key arrives
> 5.4 s after close, every opening is verified on chain, and it clears at one price, recomputed in
> your browser. A malformed bid can't be opened by anyone, its author included, and its bond is
> slashed.

> 5/ Everything is on testnet with real transactions and explorer links, and every claim in the
> README points to the transaction that proves it.
> App: https://rose-rounds.vercel.app
> Code: https://github.com/gamween/rose
>
> If you have run an OTC buyback or sold a locked allocation: what would make you use a sealed round
> instead? @NearLegion @NearBuilders

End of the draft. Not posted.
