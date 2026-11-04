# Security model

rose is testnet software (NEAR testnet, Base Sepolia, Solana devnet) and has **not been audited**.
This document says who you trust when you use it, what each flow defends against, what it does not
defend against, and which reviews the code went through. The normative short form is
[spec section 7.4](./spec.md#74-trust-model-readme-must-state-it-plainly); the mechanisms it refers
to are in [spec sections 5 and 7](./spec.md#5-mechanism), and every live fact below (gas, latency,
addresses, byte layouts) is recorded with its command in [`verification.md`](./verification.md).

## Contents

- [Trust model](#trust-model)
- [Threat model per flow](#threat-model-per-flow)
- [Known limitations](#known-limitations)
- [Review history](#review-history)
- [Tests behind the claims](#tests-behind-the-claims)

## Trust model

| Party | Trusted for | A malicious or failing party can | It cannot |
|---|---|---|---|
| **NEAR MPC network** (`v1.signer-prod.testnet`, contract 3.18.0, reconstruction threshold 11) | Signing for the engine's derived keys (domain 0 `vault/base`; domain 1 `vault/sol`, `gas/sol`, the per-holder deposit keys), releasing a round key through Confidential Key Derivation (domain 2) only when the engine asks, attesting Base logs and Solana accounts through ForeignTx (domain 3), each provider of a node's quorum having to return the same verdict | With a threshold of colluding nodes: sign any RoseVault authorization or Solana transaction (drain custody), derive a round key before the deadline (read sealed bids early), attest a deposit that never happened (mint units against nothing). Without a threshold but by withholding: delay deposits (a failed proof surfaces after about 2 minutes), stall a round until `cancel_no_key` refunds it, delay payouts (every `Requested` state has a retry) | Change the engine's code, change a clearing result computed on chain from opened bids, or move funds below the threshold. A key it returns is checked by a pairing check before the engine stores it; every signature it returns is checked (`ecrecover` against `vault/base`, `ed25519_verify` against the derived key) before it is stored |
| **TEE nodes** | The MPC nodes run threshold signing and CKD in TEEs (spec 7.4) | A TEE compromise on enough nodes is the threshold case above | rose treats TEEs as defense in depth that raises the cost of collusion; the threshold assumption is the one that matters |
| **rose-engine code** | Implementing the specification correctly. The engine has no upgrade, migrate, delete-account or generic call method, and the CKD request is reachable only after the deadline; the final deployment deletes every access key after init (`scripts/deploy-engine.sh --role final --keyless`, after which `view_access_key_list` returns `[]`), so a new version deploys to a new account | A bug is not mitigated by anyone: the code is unaudited | Be changed after a keyless deployment. **Staging engines are not keyless:** `engine-s1`, `engine-s2`, `engine-s3` and `engine-s4` keep a full-access key held by the team, `engine-s3` was updated in place once (verification log, "Staging deployment 3") and `engine-s1` now runs an empty contract (its code storage was reclaimed, "Staging deployment 4"). Treat every staging engine as a test deployment |
| **The team that deploys rose** | Running the web app, the demo faucet route and its testnet hot wallets; the fee recipient is fixed at init | Serve a frontend that shows wrong numbers or builds wrong transactions; stop funding the faucet | After a keyless deployment: read a bid early, sign a payout, cancel a round after its first bid, or upgrade the engine. Wallets show every call's arguments, every result links to an explorer, the round page's Verify panel recomputes clearing in the browser from on-chain data, and `@rose/sdk` reaches the engine without the app |
| **RoseVault** (Base Sepolia) | Correct code. Immutable: no owner, no pause, no upgrade, no `receive`; Sablier Lockup and the signer are fixed in the constructor | A bug in it is not mitigated by anyone (unaudited) | Release a stream or a token without an EIP-712 authorization recovering to the engine's `vault/base` address (`v` exactly 27 or 28, low `s`, one shared replay bitmap; the id is consumed before any external call) |
| **The issuer** (whoever runs a Tender or creates a cohort's streams) | Naming the NEAR account that receives each stream in `createStreams`, and `distribute_units` to its holders: holders trust the issuer for their allocation exactly as they do for their vesting today. Choosing the Tender's `retire_to` address | Credit the wrong accounts when it creates the cohort; retire bought units to an address of its choice | Pay less than it promised: the budget plus the 30 bps fee are escrowed at creation. Read asks before close, change the budget or the max price after creation, or cancel once the first ask is placed |
| **Sablier Lockup v4** (`0xA65A…532e`) | Stream custody and unlock math; rose ports `calculateStreamedAmountLL` of `lockup@v4.0.1` and matched 197 of 197 live `streamedAmountOf` reads | Its comptroller admin can switch on a withdrawal fee at any time (0 today, oracle-based); RoseVault forwards `calculateMinFeeWei` read in the same transaction, so withdrawals keep working and the caller pays | Withdraw a vault stream's tokens anywhere but RoseVault: a third party's `withdrawMax` must pay the recipient |
| **Streamflow** (`HqDGZ…CMfMZ`) | Stream custody, the 1,104-byte metadata layout and `withdraw` semantics the engine verified on devnet, and its auto-claim: one second after a stream's end its withdrawor (`wdrwh…pb5u`, memo "Auto-Claim") withdraws the remainder into the recipient's token account and closes the escrow, even with `automatic_withdrawal` = 0 (reproduced on devnet). rose books it with `sync_sol_stream` and relies on it for an ended stream's last tranche | The program is upgradeable (BPFLoaderUpgradeable) and its on-chain source is not public: an upgrade could change any behavior rose relies on. If the auto-claim stopped, an ended stream's last tranche would stay in its escrow (draws stop five minutes before the end) | Under its current code, move a vault stream or pay its tokens anywhere but the vault's token account: the sender powers that would allow it (cancel, transfer, pause, rate update, top-up, automatic withdrawal) are refused at deposit, and the auto-claim pays the recipient's own token account. Make a payout look executed or not: verdicts read only the claimant's two nonce accounts (below) |
| **Token issuers** | The tokens rose holds and pays | On Base, an ERC-20 with pause or blacklist powers can freeze RoseVault's balance or its transfers to a claimant: a trust assumption rose cannot remove. On either chain a mint authority can inflate supply (a price risk, not a custody one) | Freeze the vault's Solana token account: mints with a freeze authority are refused at deposit, and a mint without one can never gain one. Token-2022 mints are refused. Fee-on-transfer and rebasing tokens are unsupported; RoseVault refuses a cash deposit or a cohort funding that does not deliver exactly the amount pulled |
| **RPC providers** | Serving the app's reads | Mislead what the app displays | Feed the engine: foreign facts reach it only through MPC attestations, never through an RPC the app chose |

No other party can move funds, see bids early or stop a round.

## Threat model per flow

### Sealing

- **What is protected:** every price and every exact quantity until the round's key is released.
  Public during the round: the number of orders, each order's escrow or locked units, and the
  ciphertext hashes. Collateral is an upper bound only; a participant can over-collateralize to hide
  it.
- **Encryption:** Boneh-Franklin IBE over BLS12-381 against the MPC's CKD domain 2 key, in the
  browser (12 to 17 ms per bid, 192-byte ciphertexts). The identity is derived by the contract from
  the round id, never from an argument.
- **Copying another bid:** the associated data binds `(round_id, bidder, side)`, so a byte-for-byte
  copy fails at the `U` check (4.36 Tgas, measured live).
- **Book filling:** a round accepts at most 64 orders and one order per side per account. Each order
  attaches 0.02 NEAR of storage and a bond (`max(1 USDC, 1%` of its collateral)), refunded on a valid
  opening. An actor willing to lock 64 bonds can fill a round; the remedy is a new round.
- **Residual:** anything encrypted to a round identity, including a ciphertext that was never
  submitted, is readable after the key is public (ePrint 2025/2048). Do not share a sealed order you
  do not place.

### Key release

- `close` is the only path to the CKD request and is guarded by `closes_at <= now < closes_at +
  key_timeout`; a round without orders is cancelled instead.
- Every duration a creator chooses is bounded at creation: `closes_at` at most 30 days ahead,
  `key_timeout` between 1 minute and 7 days, `reveal_window` between 5 minutes and 7 days. A
  creator therefore cannot freeze a round's escrows forever with an endless reveal window, nor
  slash every bond with a window too short to land an opening.
- The key is pairing-checked before it is stored, by the callback and by `submit_key`, which anyone
  can call with the key unwrapped from the MPC's public response: a lost callback never freezes a
  round, and a wrong key is refused (9.87 Tgas, measured live).
- If no key arrives within `key_timeout` (default 1 h), anyone calls `cancel_no_key` once no request
  is in flight (250 blocks after the last `close`, past the MPC's 200-block yield), and every escrow,
  bond and locked unit is refundable. `close` is refused after the timeout, so nobody can keep a
  request in flight to block the cancellation. Exercised live on `engine-s3`
  ([cancel_no_key](https://testnet.near.rocks/tx/4CszxtfbVfadaWgWZv7tF1eUt2NYbXVw16hQi3tNazk7),
  [refund](https://testnet.near.rocks/tx/A1LojEZZ4YuXY6RdTFvHv4qEsjd3RYFsEZcPcQg8h1zW)).
- **Residual:** a cancelled round's key can still become public. MPC nodes that answer after the
  yield timeout publish `(big_y, big_c)` in their failed transaction, which anyone unwraps with the
  round's public scalar, and a response whose callback failed is public while the round waits.
  No funds move after `Cancelled`, so the consequence is privacy only (spec 5.6).

### Openings

- Opening is fully verified on chain: the engine recomputes `V` with one pairing and checks `U`, `V`
  and `W` (about 132 Tgas, under the 300 Tgas wallet cap). A ciphertext with an inconsistent `V` can
  be opened by nobody, its author included, so there is no free option to reveal or withhold after
  seeing the book, and no challenge window.
- Opening is permissionless: once the key is public anyone can open any order, and every
  participant's browser decrypts the whole book. No party's cooperation is needed for an order to
  count.
- After the reveal window, unopened orders are void and their bond slashed; an opened order whose
  `limit * quantity` exceeds its escrow, whose buy quantity exceeds the round's `max_buy_quantity`
  (fixed at creation, so a later redeem never voids a covered bid), or whose quantity exceeds its
  locked units, is void and slashed too. Shown live: a malformed bid's author's own opening refused
  ([5cy62YfE…](https://testnet.near.rocks/tx/5cy62YfEpE4MioY1txbjGSGWWGAgqRNK2kzQZxSC4LEs)) and its
  bond slashed at settlement
  ([3mMoWJc4…](https://testnet.near.rocks/tx/3mMoWJc42KYSES6Vx4wpBk8dXHgcifyZgweV8Wanjr9H)).

### Clearing

- One bounded `clear` per round (at most 64 orders, 4 to 11 Tgas) computes the price and every fill
  from opened orders, with deterministic ties and rounding that favors the pool; settlement is one
  idempotent `settle_bid` per order, callable by anyone.
- The rules (spec 5.4) are property-tested against a brute-force reference over every tick, and the
  three seeded rounds cleared on chain at exactly the price and fills of the `@rose/sdk` reference
  run on the opened orders. The Verify panel repeats that recomputation in any browser.
- **Residual:** a sealed uniform-price round removes reaction to the book, not identities. rose has
  no sybil resistance: one party can place orders from several accounts, and nothing stops a party
  from trading with itself (it pays the fee).

### Custody on Base

- **Deposit:** `depositStream` requires the caller to own the stream (an approval is not consent to
  a NEAR account). The engine asks ForeignTx to attest the `StreamDeposited` log at `Safe` finality,
  without `expected_payload_hash` (with it, a mismatch is a silent 2-minute timeout), recomputes the
  payload hash itself, then checks the emitter, the canonical Lockup, non-cancelability,
  transferability and the schedule built from the attested `decimals`. The replay key
  `(tx_hash, log_index)` is consumed only on a match. A genuine log the engine refuses is recorded
  and returnable; its return (`Release` with `vestedToRecipient`) withdraws what vested meanwhile to
  the returnee, not to the vault.
- **Address spellings:** every EVM address the engine receives (log fields, recipients, venue
  tokens, `retire_to`, the init configuration) is canonicalized to `0x` plus lowercase hex before
  it is hashed, stored, compared or keyed. A third party who registers someone else's log with a
  bare or mixed-case spelling registers exactly what the canonical spelling would; it cannot move
  the cash into a venue nobody can withdraw from, nor split a stream into another class.
- **Recipients:** RoseVault and the engine's `vault/base` address are refused as the `to` of every
  Base payout and redeem, and with the zero address as a Tender's `retire_to`.
- **Unattributed streams:** a stream sent to RoseVault with a plain `transferFrom` mints nothing and
  can only leave through a `Release` authorization.
- **Payout:** the engine debits first, asks the MPC for the EIP-712 signature, checks that it
  recovers to the vault address (normalizing a high `s`) and stores it on NEAR; anyone submits it to
  RoseVault, which has no deadline and a replay bitmap. A failed signature request is retried, never
  refunded: a late MPC response may be public, and an authorization stays executable forever.
- **Third-party withdrawals:** anyone may call Sablier `withdrawMax(streamId, RoseVault)` on a vault
  stream. For a registered position that only moves unit holders' tokens into the vault early. For
  a refused stream awaiting its return, RoseVault records the withdrawn amount when the stream
  enters and its return also sends the returnee what was withdrawn to the vault since then
  (`vestedForwarded`), so nobody can strand the vested part of someone else's refused stream. The
  release reads Sablier's withdrawal fee in the same flow and sends it, so a fee switched on by
  Sablier's admin does not block releases.
- **Residual:** `Safe` is not `Finalized`; a Base reorg deeper than the safe head is outside the
  model. ERC-20 issuer powers (above).

### Custody on Solana

- **Deposit in three calls** (spec 7.2): `attribute_sol_deposit` proves, before anything is
  recorded, that the stream sits at the caller's own deposit address `dep/<account>/<class>`; a
  request-only record could be front-run, and `transfer_recipient` leaves no trace of the previous
  recipient. `move_sol_deposit` has the engine build and sign the move to the vault itself (it never
  signs caller bytes). `register_sol_deposit` proves the stream at the vault with ForeignTx
  `AccountState` at `Finalized` and mints the units. A proof showing the stream anywhere else
  changes nothing.
- **Eligibility:** non-cancelable, not transferable by the sender, not pausable, no rate updates, no
  top-ups, no automatic withdrawal, transferable by the recipient, fee-free, at least one whole
  token, classic SPL Token mint without a freeze authority, and an `end_time` more than an hour
  after its attribution (Streamflow's auto-claim would otherwise empty a stream still at its
  deposit address, or refused at the vault, into a token account no engine path reaches). One
  registration per stream, ever; a stream refused at the vault is never attributed again.
- **Residual:** a stream left at its deposit address, or refused at the vault and not returned,
  until its end is emptied by the auto-claim into that address's token account and stays there.
  The depositor has at least an hour to complete or return it (both permissionless, about a
  minute each).
- **Residual:** `AccountState` signs the account as the nodes read it at request time, so the app
  passes bytes read at `finalized` right before the call; a stream that changed in flight fails the
  hash comparison (about 7 s) and the app retries.

### Payouts (two-phase on Solana)

- A durable-nonce transaction that fails on chain still advances its nonce (measured on devnet), so
  a signed Solana payout is not final. `claim_sol_tokens` draws on streams the claimant names and
  on its class's swept balance, proves the claimant's nonce account, its receipt nonce account and
  its existing token account in one ForeignTx request, and has `vault/sol` and `gas/sol` sign
  `[AdvanceNonce] + withdraw per stream + TransferChecked(sum) + [AdvanceNonce(receipt)]`. The
  payout stays `Signed`, broadcastable by anyone, until `confirm_sol_payout` proves the nonce
  advanced and reads the receipt.
- **The witness is the receipt, nothing else.** A failed durable-nonce transaction advances its
  nonce and rolls back every other instruction, the receipt's advance included; an executed one
  leaves both accounts on the same new value (both measured on devnet,
  [`verification.md`](./verification.md)). So the receipt equal to the nonce's new value lands the
  payout, and the receipt behind it refunds it, on two proofs whose reads are at least 150 blocks
  apart (the nodes read each account separately; a lagging read of the receipt right after a
  landing must not pass for "did not execute").
- **Why it holds against an adversary:**
  - *Lagging reads:* a stale read can only show the receipt behind (the "did not execute"
    direction), which needs the second, later proof; a stale read of the nonce shows the signed
    value and is refused. A stale read of the receipt at request time does not matter: the
    verdict compares it with the nonce's new value, not with its old one.
  - *Donations and the claimant's own token account:* neither takes part in any verdict. Sending
    tokens to the vault's token account, or emptying the recipient's account after a landing,
    changes no nonce account.
  - *Moving the nonce accounts:* only a vault signature advances them, the engine signs the
    receipt's advance only inside this payout's message, and both accounts are reserved to the
    payout (any other action naming either is refused) until it is settled. Without that
    reservation a claimant could land a payout, then advance its nonce again with a second action
    so that the receipt looks behind and the first payout is refunded; the reservation is tested.
  - *Late broadcast and cancellation:* a payout signed before a stream's end and broadcast after
    Streamflow's auto-claim fails on the closed escrow (Anchor error 3012, measured) and is
    refunded; a nonce-only cancellation leaves the receipt behind and is refunded; a late
    signature of the original that executed first moves the receipt and lands it.
  - *Streamflow's auto-claim:* it empties every ended stream into the vault's token account
    whether or not a payout drew on it, so the stream's `amount_withdrawn` cannot tell (that was
    the pre-deployment blocker: such reads were taken for landings, destroying claims).
    `sync_sol_stream` books what it took in the class's swept balance from the stream's metadata
    (at the vault, paying the vault's token account, more withdrawn than accounted for), refused
    while a payout drawing on the stream or its release is unsettled, and re-checked in its
    callback. A lagging read books less and a later sync the rest; a donation books nothing. The
    swept balance is paid by `TransferChecked` alone, each payout reserving what it takes, so the
    vault's token account always holds at least every class's available swept balance; and draws
    and redeems stop five minutes before a stream's end, so a payout is not built on a stream
    about to be emptied.
- A nonce account's seed starts with a prefix of the claimant's NEAR account hash, so nobody can
  spend or front-run another claimant's nonce values (spec 7.3).
- Shown live: payout signed and broadcast
  ([BXfMqQpC…](https://testnet.near.rocks/tx/BXfMqQpCMiwPJjBgwR7avPni5XQzS2KTa3qhWHRyQnfH),
  [5jAM8UFK…](https://explorer.solana.com/tx/5jAM8UFKZdGerAxMfKWsjsGCDudJFrCXTXYhXJi8BbPQzY3AGPEjEyKyLutvtXGchQhpTxkUdUk5mdV7kv4vA4w2?cluster=devnet)),
  then confirmed `Landed`
  ([4N7426Wa…](https://testnet.near.rocks/tx/4N7426Wa6yc1PdJyB4v3xHEZdoLVb3rqWFCt4Q1yy4wJ)), on a
  staging engine before the receipt; the receipt verdict, the auto-claim, its sync and a payout
  from the swept balance on devnet transactions in [`verification.md`](./verification.md)
  ("Streamflow auto-claim").

### Redeem in kind

- `redeem` burns the position's whole allocation of units from the caller's free units (liens and
  units locked in rounds cannot be redeemed; one release per position at a time).
- **Base:** the authorization releases the stream, withdrawing any unlocked balance to the vault
  first so accrued tokens stay with unit holders; final once signed.
- **Solana:** the stream must carry no unconfirmed payout and be more than five minutes from its
  end, and the redeemer pays from its own claimable what the stream still owes the unit holders.
  The transaction advances the redeemer's receipt nonce last; the position is `Releasing` until
  `confirm_sol_redeem` settles it on the receipt, like a payout: final when the receipt holds the
  nonce's new value, the units and the paid claimable back when it stays behind on two proofs 150
  blocks apart. The stream's own state takes no part: the new recipient could send the stream back
  to the vault, and Streamflow's auto-claim closes it at its end either way. A release broadcast
  after the auto-claim fails ("Stream closed", error 104, measured), so an executed release always
  moved the stream before its end, and the auto-claim then paid its new owner.

### Storage and gas griefing

- Every record is paid by the caller who creates it: NEP-145 registration for unit holders and cash
  holders, 0.02 NEAR per order, 0.05 NEAR per round, 0.025 NEAR per signed action (its two nonce
  account reservations included), 0.015 NEAR per deposit attribution, registration or Base cash
  registration. A Base cash token outside the accepted list also charges its entry in the
  account's list of such venues with its row, and an Exit bid reserves the buyer's holding row
  until it settles, so units received meanwhile cannot take the same bytes.
- **The event history is the one record nobody pays for.** It is bounded in bytes: free texts are
  cut at 192 bytes, so every entry fits 448 bytes (measured over every variant with 64-character
  ids) and the full 1,024-entry history at most 458,752 bytes (4.59 NEAR). `new` refuses to
  initialize an engine whose balance does not cover its code and state, that history and the
  0.5 NEAR MPC reserve (about 15.4 NEAR with a 1.03 MB wasm; the deployment script funds 17 NEAR), so
  filling the history can never eat the reserve, and a zero-deposit `storage_deposit` top-up
  records nothing (before the fix, about 600 free calls pushed a 12 NEAR engine below its
  reserve). Holding, cash and lien share rows are
  charged at their measured size for the longest account id (310, 172 and 149 bytes; 137 for the
  account record), so a stranger distributing dust to many long account ids pays every byte it
  creates; a NEAR cash deposit needs room for its row, and an Exit buyer room for the units it buys.
- Credits the engine owes always land (an unregistered account is registered with a zero deposit),
  and an account cannot withdraw or unregister its storage while it has live orders, locked units,
  liens or custody actions in flight, so nobody can make a refund fail by emptying their own storage.
- The engine keeps 0.5 NEAR free before any MPC request; every callback has static gas for what it
  attaches and every user call checks it has that much left; every user-facing method stays under
  300 Tgas (the highest, `open_bid`, burns about 132). The event history is a bounded ring buffer of
  1,024 entries funded at init (above).
- `gas/sol` pays the fees of every engine-built Solana transaction, so a signed transaction that
  fails on chain costs it 10,000 lamports, and a refused deposit's return pays the return address's
  token account rent once. An attacker pays more in NEAR deposits than it makes `gas/sol` spend; the
  balance is shown on the status page.

## Known limitations

- **Unaudited.** The engine, the IBE crate, RoseVault and the web app have tests and the review
  passes below, not an audit. Do not use this code with assets of value.
- **Testnet only.** NEAR testnet, Base Sepolia, Solana devnet; the MPC testnet network's liveness and
  latency are those of a test deployment.
- **Staging engines keep a key** (see the trust model). Only the final engine is deployed keyless.
- **A cancelled round's key can become public** through a late MPC response, and anything encrypted
  to a round identity is readable after its key is public (ePrint 2025/2048).
- **Public collateral** bounds each order's size; hiding it costs over-collateralization.
- **64 orders per round**, and no sybil resistance.
- **Supported positions:** Sablier Lockup v4 Linear streams on Base (transferable, non-cancelable,
  at least one whole token) and fee-free Streamflow streams on Solana. Dynamic, Tranched and
  Price-Gated Sablier streams, cancelable positions, Token-2022 mints and mints with a freeze
  authority are refused.
- **Token issuer powers:** ERC-20 pause or blacklist powers on Base are a trust assumption; fee-on-
  transfer and rebasing tokens are unsupported.
- **Third-party programs:** Sablier's withdrawal fee is admin-controlled; Streamflow is upgradeable and
  its on-chain source is not public.
- **Liveness is the participants' job.** There is no keeper: a round advances when someone calls the
  next step, and a signed Solana payout blocks the streams it draws on until someone broadcasts and
  confirms it (anyone can).
- **Staging data:** on `engine-s3`, updated in place with a build that changed stored layouts, Solana
  payout records 0 to 2 and one event history entry no longer decode; the app skips the unreadable
  entry. The final engine is never updated in place.
- **Demo conveniences are not part of the protocol:** `/api/faucet` sends testnet gas from
  server-side hot wallets, and the in-app demo wallets keep their keys in the browser.

## Review history

The contracts and the engine went through independent review passes by a model other than the one
that wrote the code (Fable 5.1 and Opus 5.5), focused on correctness, hallucinated APIs and drift
from the specification. Counts are as each pass reported them; blockers and majors were fixed before the next
milestone unless stated.

| # | Scope | Reviewer | Verdict | Outcome |
|---|---|---|---|---|
| 1 | EVM contracts (RoseVault, TestUSDC, DemoToken, DemoStreamFaucet) | Fable 5.1 | 0 blockers, 2 majors (both specification items: the log fields the payload hash covers, Sablier `granularity`) | Specification updated, minors fixed |
| 2 | RoseVault | Opus 5.5 | 0 blockers, 5 majors | Fixed before deployment (the vault is immutable): balance-invariance check in `createStreams` (fee-on-transfer drain), `decimals` read on chain and emitted, streams below one whole token refused, vested tokens withdrawn to the issuer and reported as `withdrawn`, units minted equal to the full allocation at checkpoint `f(timestamp)` |
| 3 | RoseVault, after the fixes | Fable 5.1 | 0 blockers, 0 majors | |
| 4 | RoseVault, final pass | Opus 5.5 | Deploy (0 blockers, 0 majors) | Reentrancy guard on `attest`, solc 0.8.38; 125 Foundry tests |
| 5 | `rose-ibe`, clearing and unlock math | Fable 5.1 | Pass (0 blockers, 0 majors) | Preconditions moved into the engine: one sealed order per side, associated data from the stored order, over-escrowed orders void before clearing, no round on a fully unlocked class, key verified before it is stored |
| 6 | Engine core | Fable 5.1 | 1 blocker (a late CKD callback could revive a cancelled round), 2 majors (lien rounding, unpaid storage drain), 5 minors | Fixed: late callbacks ignored, cumulative lien accounting, NEP-145 storage |
| 7 | Full engine with custody (`8fdb5bf`) | Fable 5.1 | 2 blockers (the first Solana deposit of a class was impossible; an Advance holder could freeze funders' escrow by unregistering its storage), 2 majors (a Solana payout could be stranded by the vault token account's balance; `transferable_by_recipient` unchecked) | Fixed; the Streamflow flow exercised live on staging. The fixes were then verified with tests by Opus 5.5, which added a storage floor, zero-deposit registration for owed credits, and a guard so a late Base callback after a retry can never double-pay |
| 8 | Engine custody (`b10bba2`) | Opus 5.5 | Do not deploy: 2 blockers, 9 majors (a signed Solana durable-nonce payout was treated as landed) | Solana custody redesigned around proof of landing: two-phase payouts and redeems, no vault pool, recipient token account proven, every stored signature verified |
| 9 | That redesign | Opus 5.5 (Fable was rate-limited) | 0 blockers, 2 majors (a stale read could produce a "did not execute" verdict; refunds on a failed request although a late MPC response is public), 3 minors, 3 nits | All fixed: two proofs 150 blocks apart for a negative verdict, signature requests never refund, Solana actions cancelled by a nonce-only transaction |
| 10 | Solana custody v2 (`b10bba2..d05f542`) and every value-moving custody path | Opus 5.5 | 0 blockers, 1 major (a redeem confirmation could be finalized by a stale lower read), 8 minors, 5 nits | Fixed in `f1a8ba5`, each with a test that fails before the fix: monotone redeem verdict, request-height spacing of the two proofs, exact "unchanged" reading (Streamflow `withdraw` verified exact-or-fail on devnet), payout nonce accounts derived with a seed bound to the claimant's NEAR account, freeze-authority mints refused, Tender `retire_to` checks, u64 amounts as strings, accrual remainder kept so a sole holder can always redeem, stored enum order pinned. `engine-s3` runs the reviewed build, without these fixes |
| 11 | Full engine, RoseVault, tUSDC and the SDK bindings (`f1a8ba5`) | Opus 5.5 | 1 blocker (a bare-hex address spelling let a stranger strand someone's Base cash), 3 majors (unbounded round windows, under-charged storage rows, client ABI drift), 4 minors, 10 nits | Fixed, each with a test that fails before the fix: canonical EVM addresses at every entry point, bounded round windows, rows charged at their measured worst case (cash rows included), per-account class list behind the portfolio view, buy quantities measured against the supply at creation, a refused stream's return keeps its vested tokens (RoseVault `Release` gains `vestedToRecipient`, so the vault is redeployed), custody addresses refused as Base recipients |
| 12 | Contracts before deployment (`cd00318`) | Opus 5.5 | 1 blocker (Streamflow's auto-claim of ended streams read as a landed payout: claims destroyed, tokens stranded), 1 major (the free event history could push the engine below its MPC reserve), 4 minors, 6 nits | Fixed: verdicts on a receipt nonce account, `sync_sol_stream` and the swept balance, draws and redeems stop five minutes before a stream's end, attribution refuses streams ending within an hour; event history bounded in bytes and funded at init; non-accepted Base cash listed; Exit bids reserve the buyer's row; RoseVault forwards third-party withdrawals of a returned stream; release fees sent by the SDK |

The web app was also exercised live through its demo wallets against the staging engines; 18 bugs
found that way were fixed (event history decoding, a deposit resume after a reload, prepaid gas that
locked out small accounts, public RPC rate limits, among others).

## Tests behind the claims

- `cargo test --workspace`: unit and property tests of the pure modules (clearing against a
  brute-force reference over every tick, unlock math, accrual), contract tests on the mocked VM, and
  recorded live vectors (Sablier `streamedAmountOf`, ForeignTx round trips, MPC signatures, web3.js
  messages).
- `ROSE_SANDBOX=1 cargo test -p rose-engine --test 'sandbox_*' -- --test-threads=1`: the real engine wasm in a NEAR
  sandbox with a signing mock MPC, including a round at the 64-order cap, the two-phase Solana payout
  and redeem settled on receipts, a synced Streamflow withdrawal paid from the swept balance, and a replay of real staging transactions; every user-facing call asserted under
  300 Tgas.
- `forge test`: RoseVault and the demo contracts (139 tests, fork tests against the live Sablier
  Lockup).
- `pnpm -r test`: the SDK (bindings checked against the engine ABI, clearing reference bit for bit
  with the Rust vectors) and the web app; Playwright against the deployed app.
- `node scripts/seed.ts all` and `node scripts/e2e-live.ts all`: the demo story on the real testnets,
  every transaction recorded in [`verification.md`](./verification.md).
