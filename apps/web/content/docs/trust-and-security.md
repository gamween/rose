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
- **RoseVault.** Immutable, no owner, signer fixed in the constructor.
- **Gas.** Every user-facing method stays under 300 Tgas, the wallet cap, so no action depends on a privileged sender with a larger gas budget. The 1 PGas protocol limit is used only by scripts and the in-app demo wallet.
- **Nobody else.** No other party can move funds, see bids early or stop a round.

## Threats

### The operator

The people who deploy rose hold no key that matters after deployment. The engine account has no access keys, RoseVault has no owner, the Solana vault is an MPC-derived address. The operator cannot read a bid before close, cannot sign a payout, cannot freeze or cancel a round after its first bid, and cannot upgrade the contract in place. A new version is a new account that users would have to opt into.

What the operator does control: the web app. A malicious frontend could show wrong numbers or craft wrong transactions. Mitigations: every transaction is signed by the user's wallet with its arguments visible, every result links to an explorer, the "Verify" panel recomputes clearing in the browser from on-chain data, and the SDK lets anyone bypass the app entirely.

### MPC collusion

If a threshold of MPC nodes collude, they can derive a round key before `closes_at` (breaking sealing) or sign for the vault addresses (breaking custody). This is the same assumption as every application built on NEAR Chain Signatures. Node code runs in TEEs, which raises the bar for a node operator but does not make collusion impossible. rose does not add any trust beyond this.

### Foreign state

The engine learns about Base and Solana through ForeignTx verification. A quorum of MPC nodes reads the foreign chain through their own RPCs and signs over the payload. A single compromised RPC cannot fake a deposit; a quorum of compromised RPCs could. The engine sends `expected_payload_hash` with each request and recomputes the hash in the callback, so a wrong or inconsistent response is rejected rather than acted on.

### Front-running and information leakage

Bids are encrypted in the browser before they touch the chain; nobody, including the operator and the MPC nodes individually, can read them until the round key is released after `closes_at`. What is public during the round: the number of bids, each bid's escrow or locked amount, and ciphertext hashes. A buyer's escrow is an upper bound on their notional, not their price. A seller's locked units are an upper bound on their quantity. Participants who want to hide even these bounds can over-collateralize.

Known property (ePrint 2025/2048): anything encrypted to a round identity, including ciphertexts never submitted, is readable after close. Do not share an encrypted bid you do not submit.

### Griefing with unopenable bids

A bidder might try to submit a malformed ciphertext, watch the book open, and then decide whether to "reveal". This does not work: openings are fully verified, so a ciphertext with an inconsistent `V` can be opened by nobody, including its author. Unopened bids are void after the reveal window and their bond is slashed: `max(1 USDC, 1% of the escrow or of the locked units at the round's max price)`. Opened bids whose quantity exceeds their collateral are also void and slashed. The remaining cost of a malformed bid to the honest side is a slot in the book that cleared without it.

### Censorship of bids and openings

Submitting a bid is an ordinary NEAR transaction: rose has no allowlist, no operator relay and no gatekeeper, so there is no rose-specific party that can refuse a bid. Opening is permissionless and symmetric: once the key is public anyone can open any bid, and every participant's browser can decrypt the full book locally. A bidder who wants their bid counted can open it themselves. There is no party whose cooperation is required.

### Key never released

If the MPC network does not return the key within `key_timeout` after `closes_at` (default 1 h), anyone calls `cancel_no_key`: the round is `Cancelled` and every escrow, bond and locked unit is refundable. No bid is opened. If the key was returned to a lost callback, anyone holding it can `submit_key`; the contract verifies it with a pairing check, so a wrong key is rejected.

### Griefing a payout

Payouts are pull-based and idempotent. The authorization for Base is stored on NEAR and has no deadline; RoseVault's replay bitmap prevents double use, so re-submission is safe. On Solana, each payout uses its own durable nonce (authority = vault), fee payer `gas/sol`: a payout nobody broadcasts blocks only its own nonce. A caller cannot make the engine sign arbitrary bytes; the engine builds every message itself. The debit happens before the signature request, and the callback refunds only when no signature was produced, so an attacker cannot obtain both a refund and a valid signature.

### Running out of foreign gas

`gas/sol` must hold devnet SOL for Solana payouts to be broadcastable; its balance is shown on the [status page](/status). On Base the claimant pays the gas, so no shared balance is needed.

### Rounds that never advance

Every lifecycle step is a public method, so a round only stalls if nobody calls the next step. The app shows the next action to anyone looking at a round. The economic incentive is with the participants: the opener pays about 0.012 NEAR per bid and is usually a winner who wants to claim.

## Testnet caveats

- Everything runs on NEAR testnet, Base Sepolia and Solana devnet. Tokens have no value. Test USDC is mintable by anyone.
- The MPC testnet network's liveness and latency are those of a test deployment. Measured CKD latency was 4.3 to 6.1 s.
- Demo helpers are not part of the protocol: the `/api/faucet` route sends a little gas from a server-side testnet wallet, and the in-app demo wallets hold keys in the browser. Do not reuse demo keys anywhere.
- Default windows are short in the demo (10 min reveal window). In production a 24 h reveal window is suggested.

## Unaudited

The engine, the IBE crate, RoseVault and the web app have not been audited. The code has unit, property and integration tests and independent review passes, but that is not an audit. Do not use this code with assets of value.
