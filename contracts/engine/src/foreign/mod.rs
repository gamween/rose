//! Cross-chain byte layouts the engine relies on, as pure code.
//!
//! Nothing here touches NEAR state or makes a call. The modules build and parse the exact bytes
//! exchanged with the NEAR MPC contract (`v1.signer-prod.testnet`, near/mpc 3.18.0), with
//! RoseVault on Base Sepolia and with the Solana devnet runtime, so every layout can be checked
//! natively against recorded fixtures and then compiled unchanged to wasm.
//!
//! - [`mpc`]: the `verify_foreign_transaction` and `sign` wire formats, the ForeignTx payload hash
//!   (`sha256(borsh(ForeignTxSignPayload::V1))`) and the response shapes.
//! - [`evm`]: RoseVault `StreamDeposited` and `CashDeposited` logs rebuilt byte for byte from
//!   typed fields, EIP-712 digests of the `Transfer` and `Release` authorizations, and the mapping
//!   of an MPC secp256k1 response to an Ethereum `(v, r, s)` signature.
//! - [`solana`]: legacy message compilation identical to `@solana/web3.js`, the System, SPL Token,
//!   Associated Token Account and Streamflow instructions the engine signs, program-derived
//!   addresses, and the parsers of nonce accounts and Streamflow stream metadata.
//!
//! # What is proven where
//!
//! Each module carries the source (repository, tag or commit, file and line) of every external
//! layout in its doc comments. The integration tests in `tests/foreign_*.rs` replay recorded
//! facts rather than self-consistency: live MPC responses whose `payload_hash` the engine must
//! reproduce, RoseVault receipts from Base Sepolia whose logs must be rebuilt bit for bit, messages
//! compiled by `@solana/web3.js` that must match byte for byte, the transaction broadcast on Solana
//! devnet, and the Streamflow account created with distinctive values. The fixtures live in
//! `tests/vectors/foreign/`.
//!
//! # Trust boundary
//!
//! The engine never verifies a foreign chain itself. What it checks is that the bytes it is about
//! to act on are exactly the bytes the MPC network attested or will sign:
//!
//! - Deposits: the caller supplies typed values; the engine rebuilds the log or account state,
//!   hashes it into the ForeignTx payload and compares that hash with the one the MPC nodes signed
//!   after reading their own RPC quorum. The MPC contract verifies the nodes' signature before it
//!   resumes the engine's callback, so the engine trusts the hash in the response and only has to
//!   recompute its own side. The attested bytes are then decoded and validated here before any
//!   unit is minted.
//! - Payouts: the engine builds the message itself (an EIP-712 digest or a Solana legacy message)
//!   from ledger state, never from caller-supplied bytes, and asks the MPC to sign that exact
//!   payload. A valid response is a public, replayable authorization, which is why the contract
//!   debits before the request and refunds only when no signature was produced.

pub mod evm;
pub mod mpc;
pub mod solana;
