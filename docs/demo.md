# Demo script

The script of the 3-minute demo video, scene by scene: what is on screen, what to click, what to
say, and which explorer link to open. It follows the seeded story of spec section 9: the fictional
**Cindral Foundation** and its token **Cindral (CINDR)**, whose cohorts, holders and rounds were
created on the real testnets by `scripts/seed.ts` and driven to settlement by `scripts/e2e-live.ts`
against the staging engine `engine-s3.rose-app.testnet`. Every transaction named below is listed in
[`verification.md`](./verification.md), section "Demo seed and live end-to-end, engine-s3".

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
| Halden Ventures | Seed investor: sells in the Tender, buys in the Exit | Seed Round, Base (Sablier stream 90, 400,000 CINDR) |
| Tessaro Capital | Seed investor: sells in the Tender, bids in the Exit | Seed Round, Base (stream 91, 250,000 CINDR) |
| Ines Marlow | Strategic investor: sells in the Exit, funds the Advance | Strategic Round, Solana (Streamflow, 300,000 CINDR) |
| Varick Partners | Strategic investor: sells in the Exit, funds the Advance | Strategic Round, Solana (Streamflow, 200,000 CINDR) |
| Teodor Vance | KOL: sells an Advance on his first unlocks | KOL Round, Base (stream 92, 60,000 CINDR) |
| Nadia Solvik | KOL: places a malformed bid, then redeems her position in kind | KOL Round, Base (streams 93 and 94) |

The rounds: **round 1** Tender on the Seed Round (Base tUSDC), **round 2** Exit on the Strategic
Round's Solana positions (NEAR tUSDC), **round 3** Advance on Teodor Vance's KOL units (NEAR tUSDC),
**round 4** an Exit nobody closed, cancelled by `cancel_no_key`.

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

- **Click:** "Launch app", then `/app/rounds`; filter nothing, show the four Cindral rounds.
- **Screen:** the round cards with their classes (Seed Round, Strategic Round, KOL Round) and
  venues; then the Seed Round class on `/app/prices` or the round page's unlock timeline.
- **Say:** "Cindral Foundation is a made-up issuer. Its cohorts are not: the Seed and KOL rounds are
  Sablier streams the foundation created straight into rose's vault on Base, the Strategic round is
  Streamflow streams on Solana. Every deposit was attested to the NEAR contract by the MPC network's
  foreign transaction verification."
- **Explorer:** `createStreams` of the Seed Round,
  [0x2f0cf0c4…](https://sepolia.basescan.org/tx/0x2f0cf0c454a2119d05cfc359ff921d075fd6feb8ece502ef7b27540b05945ff3),
  then its registration on NEAR,
  [GaPZiJzS…](https://testnet.near.rocks/tx/GaPZiJzSCvS1VoggFtvBR7So9oB8cmL8P3Wi8GKxwbAK).

### 4. Watch a full round: the Tender (0:55 to 1:45)

- **Click:** `/app/demo`, "Watch a full round" on round 1. The guided mode steps through the
  pre-seeded round with its real transactions; click "Next" at each step.
- **Step "Sealed":** the book shows two sealed asks, their locked units and ciphertext hashes, and
  nothing else. **Say:** "The foundation offers fifteen hundred test dollars at most four cents per
  locked token. Two seed investors answer with sealed asks. On chain you see that two asks exist and
  how many units each locked. Not one price."
- **Step "Key released":** **Say:** "After the deadline anyone closes the round. The contract asks
  the NEAR MPC network for the round's key, and the network can only release it now. It arrived
  4.1 seconds after the close." **Explorer:**
  [close, AEmbLjSh…](https://testnet.near.rocks/tx/AEmbLjSh63d5u7G3fgGpcyfjYN6iUxhnkjfJYi9m6oMn).
- **Step "Opened":** **Say:** "Anyone can now open any ask, and the contract verifies every opening
  in full." **Explorer:**
  [open_bid, B9jZyKqw…](https://testnet.near.rocks/tx/B9jZyKqw8VM3W4UFkg55fkEYdoirZeViVBZhiryFJMhz).
- **Step "Cleared":** the supply curve meets the budget line at 0.036. **Say:** "One price for
  everyone: 3.6 cents. Halden sold all forty thousand tokens it asked at three cents, and was paid
  3.6. Tessaro, at the margin, was rationed. The foundation bought about forty-one thousand seven
  hundred locked tokens for exactly its budget." **Explorer:**
  [clear, 8pNWktzo…](https://testnet.near.rocks/tx/8pNWktzoM4ZDe5oVVHUeKf7ijNkTkJitzXLUbpWAxg5p).
- **Click:** "Verify" on the round page. **Say:** "And your browser recomputes the same price from
  the opened asks."

### 5. A bid nobody can open (1:45 to 2:10)

- **Click:** `/app/rounds/2`, the Exit on the Strategic Round's Solana positions.
- **Say:** "This Exit had five sealed orders. Nadia's bid was malformed on purpose. She cannot open
  it herself, even with her own plaintext: the contract refuses it. So nobody can wait, look at the
  book, and then decide to reveal. After the window her bond is slashed, and the round clears without
  her at 2.7 cents."
- **Explorer:** her refused opening
  [5cy62YfE…](https://testnet.near.rocks/tx/5cy62YfEpE4MioY1txbjGSGWWGAgqRNK2kzQZxSC4LEs), the slash at
  settlement [3mMoWJc4…](https://testnet.near.rocks/tx/3mMoWJc42KYSES6Vx4wpBk8dXHgcifyZgweV8Wanjr9H),
  the clearing [6QKNsWcC…](https://testnet.near.rocks/tx/6QKNsWcCSJnSDM3p8aqaQ8wTs5zVnKUhwjXMfWToU8gm).

### 6. Paid on the chain where the position lives (2:10 to 2:40)

- **Screen:** split view, NEAR transaction on the left, foreign transaction on the right.
- **Say:** "Settlement happens in one ledger on NEAR, and payouts land on the chain where the
  position lives. Halden's Tender proceeds: the MPC signs an authorization, and the vault on Base
  pays. Varick funded Teodor's Advance and is repaid from Teodor's unlocks, in CINDR, on Base. Nadia
  takes her whole stream back. And on Solana, a payout counts only once the chain proves it landed."
- **Explorer, in order:**
  1. Halden, 1,460 tUSDC on Base: `withdraw_base_cash`
     [HE2H2wpB…](https://testnet.near.rocks/tx/HE2H2wpBjwJpG9Lz85NWfhU7XA9ANLNhwmomeWT9eJ9A), then
     `executeTransfer`
     [0x3e6fa1d8…](https://sepolia.basescan.org/tx/0x3e6fa1d87de796b5577535866ddaff4b94051f03bac9daaf646fff253eba1949).
  2. Varick's Advance repayment in CINDR: `claim_base_tokens`
     [6hgSgqMU…](https://testnet.near.rocks/tx/6hgSgqMU7RGqYWutEkLhFNqMYv8jjoAZXbwny28MtQcH), then
     `executeTransfer`
     [0x407e89d5…](https://sepolia.basescan.org/tx/0x407e89d5c60b9257d64c2fd47a9ce1ccf56716f1c396636416b9a6e660cb46c8).
  3. Nadia's redeem in kind: `executeRelease` of stream 94
     [0x51b430b2…](https://sepolia.basescan.org/tx/0x51b430b29e8a9c965920c0a868bf6864292658bf70d8ad5f32e4dfce5343a744).
  4. A Solana claim made in the app with a demo wallet: the engine-built transaction
     [NkXBT57X…](https://explorer.solana.com/tx/NkXBT57X4y4DD2MVy6dh3omzc7dM6XjevnKz7MHtv8EYEPF6BPTx8sowH1qHtKg1RWa634Mqby3Ts2nKmisuo46?cluster=devnet),
     then `confirm_sol_payout` proving it landed
     [AW7nZvw5…](https://testnet.near.rocks/tx/AW7nZvw5pwQQQFnf8vWMreX7StkF2aqX8d97DUVGZVgS).

### 7. Nobody to trust with the keys (2:40 to 2:55)

- **Click:** `/status`.
- **Screen:** the keyless check (the raw `view_access_key_list` result), the MPC version, the
  key-release latency of recent rounds, the RoseVault signer check.
- **Say:** "The final engine has no access key and no upgrade method. If the network never releases
  a key, anyone cancels the round and everyone is refunded. That is round four."
- **Explorer:** [cancel_no_key, 4CszxtfB…](https://testnet.near.rocks/tx/4CszxtfbVfadaWgWZv7tF1eUt2NYbXVw16hQi3tNazk7).
- If the deployed engine is still a staging engine, say instead: "The production engine is deployed
  with no access key and no upgrade method; this staging one still has one, and the status page says
  so."

### 8. Close (2:55 to 3:00)

- **Screen:** "What was locked, rose." with the app URL and the repository URL.
- **Say:** "rose. Sealed rounds for locked tokens, settled on NEAR. Try it on testnet."

## Draft X thread (for the owner to post)

**Draft only.** The owner reviews, edits and posts it from their own account once the repository is
public and the video is uploaded; nothing here is posted by an agent. The links are the deployed
app, the public repository and the video the owner attaches.

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
> 4.1 s after close, every opening is verified on chain, and it clears at one price, recomputed in
> your browser. A malformed bid can't be opened by anyone, its author included, and its bond is
> slashed.

> 5/ Everything is on testnet with real transactions and explorer links, and every claim in the
> README points to the transaction that proves it.
> App: https://rose-rounds.vercel.app
> Code: https://github.com/gamween/rose
>
> If you have run an OTC buyback or sold a locked allocation: what would make you use a sealed round
> instead? @NearLegion @NearBuilders
