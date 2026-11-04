---
title: Trust and security
description: Who you trust when you use rose, threat by threat, and what is not covered on testnet.
order: 6
section: Mechanism
---

## Trust model

Plainly:

- **NEAR MPC network.** Threshold signing and Confidential Key Derivation run in TEEs across the MPC nodes. Collusion of a threshold of nodes breaks custody (they could sign for the vaults) and sealing (they could derive a round key early). Foreign state is trusted to the MPC nodes' RPC quorum.
- **rose-engine.** Keyless after init: `view_access_key_list` on the engine account returns `[]`, which anyone can check on the [status page](/status). No upgrade or migrate method, no delete-account path, no generic call or execute method. The CKD request exists in one function guarded by the round deadline. New versions deploy to new accounts.
- **RoseVault.** Immutable: no owner, no pause, no upgrade, no `receive`; the Sablier lockup and the signer are fixed in the constructor. A stream sent to it with a plain `transferFrom` (bypassing `depositStream`) is unattributed: no units are minted and it can only leave through a `Release` authorization.
- **Tokens.** On Base, an ERC-20 whose issuer keeps pause or blacklist powers can freeze RoseVault's balance or its transfers to a claimant. That is a trust assumption on the token issuer, which rose cannot remove. On Solana, mints with a freeze authority are refused at deposit (a mint without one can never gain one), so no third party can freeze the vault's token account, and Token-2022 mints are refused. Fee-on-transfer and rebasing tokens are unsupported.
- **Gas.** Every user-facing method stays under 300 Tgas, the wallet cap, so no action depends on a privileged sender with a larger gas budget. The 1 PGas protocol limit is used only by scripts and the in-app demo wallet.
- **Nobody else.** No other party can move funds, see bids early or stop a round.

## Threats

### The operator

The people who deploy rose hold no key that matters after deployment. The engine account has no access keys, RoseVault has no owner, the Solana vault is an MPC-derived address. The operator cannot read a bid before close, cannot sign a payout, cannot freeze or cancel a round after its first bid, and cannot upgrade the contract in place. A new version is a new account that users would have to opt into.

What the operator does control: the web app. A malicious frontend could show wrong numbers or craft wrong transactions. Mitigations: every transaction is signed by the user's wallet with its arguments visible, every result links to an explorer, the "Verify" panel recomputes clearing in the browser from on-chain data, and the SDK lets anyone bypass the app entirely.

### MPC collusion

If a threshold of MPC nodes collude, they can derive a round key before `closes_at` (breaking sealing) or sign for the vault addresses (breaking custody). This is the same assumption as every application built on NEAR Chain Signatures. Node code runs in TEEs, which raises the bar for a node operator but does not make collusion impossible. rose does not add any trust beyond this.

### Foreign state

The engine learns about Base and Solana through ForeignTx verification. A quorum of MPC nodes reads the foreign chain through their own RPCs and signs over the payload. A single compromised RPC cannot fake a deposit; a quorum of compromised RPCs could. The engine never trusts the caller's description of a foreign event: it sends each request without `expected_payload_hash` (with that field a mismatch is silent and only times out after 200 blocks, about 2 minutes), lets the nodes sign the values they actually read, and recomputes the payload hash from the caller's values in the callback. A wrong or inconsistent response is rejected rather than acted on.

### Front-running and information leakage

Bids are encrypted in the browser before they touch the chain; nobody, including the operator and the MPC nodes individually, can read them until the round key is released after `closes_at`. What is public during the round: the number of bids, each bid's escrow or locked amount, and ciphertext hashes. A buyer's escrow is an upper bound on their notional, not their price. A seller's locked units are an upper bound on their quantity. Participants who want to hide even these bounds can over-collateralize.

Known property (ePrint 2025/2048): anything encrypted to a round identity, including ciphertexts never submitted, is readable after close. Do not share an encrypted bid you do not submit.

### Griefing with unopenable bids

A bidder might try to submit a malformed ciphertext, watch the book open, and then decide whether to "reveal". This does not work: openings are fully verified, so a ciphertext with an inconsistent `V` can be opened by nobody, including its author. Unopened bids are void after the reveal window and their bond is slashed: `max(1 USDC, 1% of the escrow or of the locked units at the round's max price)`. Opened bids whose quantity exceeds their collateral are also void and slashed. The remaining cost of a malformed bid to the honest side is a slot in the book that cleared without it.

### Censorship of bids and openings

Submitting a bid is an ordinary NEAR transaction: rose has no allowlist, no operator relay and no gatekeeper, so there is no rose-specific party that can refuse a bid. Opening is permissionless and symmetric: once the key is public anyone can open any bid, and every participant's browser can decrypt the full book locally. A bidder who wants their bid counted can open it themselves. There is no party whose cooperation is required.

### Key never released

If the MPC network does not return the key within `key_timeout` after `closes_at` (default 1 h), anyone calls `cancel_no_key` once no key request is in flight (250 blocks after the last `close`, past the MPC's 200-block yield): the round is `Cancelled` and every escrow, bond and locked unit is refundable. `close` is refused after the timeout, so nobody can keep a request in flight to block the cancellation. If the key was returned to a lost callback, anyone holding it can `submit_key`; the contract verifies it with a pairing check, so a wrong key is rejected.

The key of a cancelled round can still become public: MPC nodes that answer after the yield timeout publish `(big_y, big_c)` in their failed `respond_ckd` transaction, which anyone unwraps with the round's public scalar, and a response whose callback failed is public while the round waits in `KeyRequested`. The sealed orders of a cancelled round can therefore become readable after the fact. No funds move after `Cancelled`, so the consequence is privacy only; it is the same property as the non-inclusion one above.

### Griefing a payout

Payouts are pull-based and idempotent. The authorization for Base is stored on NEAR and has no deadline; RoseVault's replay bitmap prevents double use, so re-submission is safe. A caller cannot make the engine sign arbitrary bytes; the engine builds every message itself.

On Solana a payout is two-phase, because a durable-nonce transaction that fails on chain still advances its nonce and only the chain can say whether it executed. The signed transaction (fee payer `gas/sol`, the claimant's durable nonce account with authority = vault) is stored on NEAR, anyone can broadcast it, and it stays `Signed` until anyone calls `confirm_sol_payout` with a ForeignTx proof that the nonce advanced and of every drawn stream. One stream read as paid proves it landed. The claim is refunded only when every stream reads exactly unchanged, on two proofs, the second requested at least 150 blocks after the first one was answered, so a lagging read right after a landing cannot pass for "did not execute". A signed payout nobody broadcasts and confirms blocks only the streams it draws on, and anyone can broadcast and confirm it. A payout nonce account's address is derived with a seed that starts with a prefix of the claimant's NEAR account hash (`nonce_seed_prefix_of`), so nobody can spend or front-run another claimant's nonce values.

The debit happens before the signature request, and a signature request never refunds: a failed request does not prove that no signature will ever surface (an MPC response arriving after the yield timeout is public in its failed transaction). A Base authorization is retried until it is signed. A Solana action whose authority signature failed is cancelled on chain instead: the engine signs a transaction that only advances the same nonce, at most one of the two can execute, and the confirmation settles whichever did. Only a proof that failed before anything was signed, or a confirmation that the transaction did not execute, refunds. An attacker therefore cannot obtain both a refund and a valid signature.

### Running out of foreign gas

`gas/sol` must hold devnet SOL for Solana payouts to be broadcastable; its balance is shown on the [status page](/status). On Base the claimant pays the gas, so no shared balance is needed.

### Rounds that never advance

Every lifecycle step is a public method, so a round only stalls if nobody calls the next step. The app shows the next action to anyone looking at a round. The economic incentive is with the participants: the opener pays about 0.0132 NEAR of gas per bid and is usually a winner who wants to claim.

## Testnet caveats

- Everything runs on NEAR testnet, Base Sepolia and Solana devnet. Tokens have no value. Test USDC is mintable by anyone.
- The MPC testnet network's liveness and latency are those of a test deployment. Measured CKD latency was 4.2 to 4.8 s from the close transaction to the stored key (Sealwell measured 4.3 to 6.1 s).
- Staging engines are not keyless: the staging deployments keep a full-access key held by the team, and one was updated in place. Treat every staging engine as a test deployment; only the final engine is deployed keyless, and the [status page](/status) shows the live access key check.
- Demo helpers are not part of the protocol: the `/api/faucet` route sends a little gas from a server-side testnet wallet, and the in-app demo wallets hold keys in the browser. Do not reuse demo keys anywhere.
- Default windows are short in the demo (10 min reveal window). In production a 24 h reveal window is suggested. Every creator-chosen duration is bounded at creation (`closes_at` at most 30 days away, `key_timeout` 1 min to 7 d, `reveal_window` 5 min to 7 d), so no creator can freeze a round forever or slash every bond with a window too short to land an opening.

## Unaudited

The engine, the IBE crate, RoseVault and the web app have not been audited. The code has unit, property and integration tests and independent review passes, but that is not an audit. Do not use this code with assets of value.
