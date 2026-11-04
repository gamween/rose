/**
 * Foreign-chain side of the engine's payouts (spec 7.3): submitting a stored EIP-712
 * authorization to RoseVault, creating and proving a Solana durable nonce with the recipient's
 * token account, broadcasting a stored engine-signed transaction until it is final, and reading
 * the accounts that settle it. The engine never pushes; the claimant's browser does.
 */

import {
  base64ToBytes,
  bytesToHex,
  classifySolanaError,
  confirmSignature,
  createNonceAccountTransaction,
  decodeEventLogs,
  executeRelease,
  executeTransfer,
  nonceRent,
  outcomeLogs,
  payoutNonceAddress,
  payoutNonceSeed,
  readNonceAccount,
  type EngineViews,
  type FinalExecutionOutcome,
  type PayoutView,
  type SignerClient,
  type SolNonceProof,
} from "@rose/sdk";
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { baseEncode } from "near-api-js";
import { PublicKey, Transaction, VersionedMessage, type Connection, type SignatureStatus } from "@solana/web3.js";
import type { Address, Hex } from "viem";
import { RoseActionError } from "./errors";
import { baseAddressUrl, solanaTxUrl } from "./explorer";
import type { SolanaSigner } from "@/components/wallet/WalletProvider";

/** Resolves after `ms`, or rejects as soon as `signal` aborts; the abort listener never outlives the wait. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** The payout id announced by the `payout_requested` event of a NEAR outcome. */
export function payoutIdFromOutcome(outcome: FinalExecutionOutcome): bigint | null {
  for (const decoded of decodeEventLogs(outcomeLogs(outcome))) {
    if (decoded.standard !== "rose" || decoded.event.event !== "payout_requested") continue;
    const data = decoded.event.data as { payout_id?: string };
    if (typeof data.payout_id === "string") return BigInt(data.payout_id);
  }
  return null;
}

/** `(v, r, s)` of a signed Base payout, typed for viem. */
export function baseSignatureOf(payout: PayoutView): { v: number; r: Hex; s: Hex } {
  const signature = payout.base;
  if (!signature) throw new RoseActionError("contract", "Not signed yet", "The engine has not stored the MPC signature of this authorization yet.");
  const hex = (value: string): Hex => (value.startsWith("0x") ? value : `0x${value}`) as Hex;
  return { v: signature.v, r: hex(signature.r), s: hex(signature.s) };
}

/** Submits a signed Base payout (`Transfer` or `Release`) to RoseVault; the caller pays the gas. */
export async function submitBasePayout(wallet: SignerClient, vault: Address, payout: PayoutView): Promise<Hex> {
  const signature = baseSignatureOf(payout);
  const id = BigInt(payout.id);
  if ("BaseTransfer" in payout.kind) {
    const kind = payout.kind.BaseTransfer;
    return executeTransfer(wallet, { vault, authorization: { token: kind.token as Address, to: kind.to as Address, amount: BigInt(kind.amount), id }, ...signature });
  }
  if ("BaseRelease" in payout.kind) {
    const kind = payout.kind.BaseRelease;
    return executeRelease(wallet, { vault, authorization: { lockup: kind.lockup as Address, streamId: BigInt(kind.stream_id), to: kind.to as Address, vestedToRecipient: kind.vested_to_recipient, id }, ...signature });
  }
  throw new RoseActionError("contract", "Not a Base payout", "This payout is not a RoseVault authorization.");
}

export function payoutFailureReason(payout: PayoutView): string | null {
  return typeof payout.status === "object" && "Failed" in payout.status ? payout.status.Failed.reason : null;
}

/** A deposit move or the return of a refused deposit: signed against a recent blockhash, nothing debited. */
export function isBlockhashAction(payout: PayoutView): boolean {
  return "SolMove" in payout.kind || "SolReturn" in payout.kind;
}

/**
 * The engine marked the payout failed before anything executed: a claim or redeem is refunded
 * (the debit comes back), a deposit move or a return debited nothing. Retrying requests a new one.
 */
export class PayoutRefusedError extends RoseActionError {
  constructor(payout: PayoutView, reason: string) {
    super("mpc_timeout", "The MPC produced no signature", `${reason}. ${isBlockhashAction(payout) ? "Nothing was debited" : "Your balance was refunded"}; retry requests a new one.`, true);
    this.name = "PayoutRefusedError";
  }
}

const MPC_WAIT_MS = 150_000;
const MPC_POLL_MS = 3_000;

/**
 * Polls the payout until the MPC callback ran (`Signed`, `AwaitingGasSignature` or `Failed`).
 * The measured sign round trip is about 5 s; a verification that never answers surfaces as a
 * `PromiseError` after about 2 min, so the wait gives up a little later with a retryable error.
 */
export async function waitForPayout(views: EngineViews, payoutId: bigint, options: { signal?: AbortSignal; onPoll?: (elapsedMs: number) => void } = {}): Promise<PayoutView> {
  const started = Date.now();
  for (;;) {
    const payout = await views.getPayout(payoutId, { signal: options.signal });
    if (payout && payout.status !== "Requested") {
      const reason = payoutFailureReason(payout);
      if (reason !== null) throw new PayoutRefusedError(payout, reason);
      return payout;
    }
    const elapsed = Date.now() - started;
    options.onPoll?.(elapsed);
    if (elapsed > MPC_WAIT_MS) {
      throw new RoseActionError("mpc_timeout", "MPC signature timed out", "The engine has not received the MPC signature after 2.5 minutes. The request stays recorded; retry from your portfolio once it is signed, or retry the signature request.", true);
    }
    await sleep(MPC_POLL_MS, options.signal);
  }
}

const SIGNATURE_PAGE = 50;
const SIGNATURE_PAGES = 4;

/**
 * The newest finalized transaction touching `address` that succeeded: the anchor of an
 * `AccountState` proof must be a successful finalized transaction not newer than the reads
 * (spec 7.2, 7.3), so failed ones (a payout that landed and failed, for example) are skipped.
 */
export async function latestSuccessfulSignature(connection: Connection, address: PublicKey): Promise<string | null> {
  let before: string | undefined;
  for (let page = 0; page < SIGNATURE_PAGES; page += 1) {
    const signatures = await connection.getSignaturesForAddress(address, { limit: SIGNATURE_PAGE, before }, "finalized");
    const success = signatures.find((entry) => entry.err === null);
    if (success) return success.signature;
    if (signatures.length < SIGNATURE_PAGE) return null;
    before = signatures[signatures.length - 1]!.signature;
  }
  return null;
}

export type CreatedNonce = { proof: SolNonceProof; nonceAccount: PublicKey; signature: string; nonceValue: string; slot: number };

/**
 * The payout's durable nonce account of `nearAccount` (spec 7.3): created from the claimant's
 * Solana wallet with a seed bound to the NEAR account (`createWithSeed(wallet, payoutNonceSeed)`,
 * authority = the engine's vault; the wallet is the base and the only signer), or reused when it
 * already exists, together with the recipient's associated token account for the mint
 * (idempotent). After finality it reads back the exact bytes the engine proves: the nonce account
 * and the recipient's token account, anchored on a successful finalized transaction not newer
 * than the reads.
 */
export async function createPayoutNonce(
  signer: SolanaSigner,
  connection: Connection,
  vaultSol: string,
  nearAccount: string,
  recipient: { owner: PublicKey; mint: PublicKey },
  onProgress?: (text: string) => void,
): Promise<CreatedNonce> {
  const authority = new PublicKey(vaultSol);
  const seed = await payoutNonceSeed(nearAccount);
  const nonceAccount = await payoutNonceAddress(signer.publicKey, seed);
  const recipientTokens = getAssociatedTokenAddressSync(recipient.mint, recipient.owner, true);
  const [existingNonce, existingTokens] = await Promise.all([connection.getAccountInfo(nonceAccount, "finalized"), connection.getAccountInfo(recipientTokens, "finalized")]);
  if (existingNonce) {
    const state = await readNonceAccount(connection, nonceAccount, "finalized");
    if (!state.authority.equals(authority)) throw new RoseActionError("contract", "Nonce account in use", `The nonce account ${nonceAccount.toBase58()} of this wallet has another authority than the engine's vault.`);
  }
  let signature: string | null = null;
  if (!existingNonce || !existingTokens) {
    const lamports = await nonceRent(connection);
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
    const transaction = existingNonce
      ? new Transaction({ blockhash, lastValidBlockHeight, feePayer: signer.publicKey })
      : createNonceAccountTransaction({ payer: signer.publicKey, nonceAccount, seed, authority, lamports, blockhash, lastValidBlockHeight });
    transaction.add(createAssociatedTokenAccountIdempotentInstruction(signer.publicKey, recipientTokens, recipient.owner, recipient.mint));
    const signed = await signer.signTransaction(transaction);
    onProgress?.(existingNonce ? "Creating the recipient's token account…" : "Sending the nonce account creation…");
    signature = await connection.sendRawTransaction(signed.serialize());
    onProgress?.("Waiting for finality (about 15 s)…");
    await confirmSignature(connection, signature, { strategy: "blockhash", blockhash, lastValidBlockHeight, commitment: "finalized" });
  } else {
    onProgress?.("Reusing this wallet's nonce account…");
    signature = await latestSuccessfulSignature(connection, nonceAccount);
    if (!signature) throw new RoseActionError("contract", "No anchor", `No successful finalized transaction touches the nonce account ${nonceAccount.toBase58()} yet; retry in a few seconds.`, true);
  }
  const [state, tokens] = await Promise.all([readNonceAccount(connection, nonceAccount, "finalized"), connection.getAccountInfo(recipientTokens, "finalized")]);
  if (!tokens) throw new RoseActionError("contract", "No token account", `The recipient's token account ${recipientTokens.toBase58()} is not readable at finality yet; retry.`, true);
  return {
    proof: { account: nonceAccount.toBase58(), base: signer.publicKey.toBase58(), seed, anchor_tx: signature, data: bytesToHex(state.raw), recipient_tokens_data: bytesToHex(Uint8Array.from(tokens.data)) },
    nonceAccount,
    signature,
    nonceValue: state.nonce,
    slot: state.slot,
  };
}

/**
 * The Solana signature (base58) of a payout's stored transaction: the first signature of the
 * wire bytes (`[count] || sig(gas) || sig(authority) || message`), which is the transaction id.
 */
export function solPayoutSignature(payout: PayoutView): string | null {
  const wire = payout.solana?.transaction;
  if (!wire) return null;
  const bytes = base64ToBytes(wire);
  return bytes.length >= 65 && bytes[0]! >= 1 ? baseEncode(bytes.slice(1, 65)) : null;
}

/** The recent blockhash (or durable nonce value) the stored message was signed against. */
export function payoutMessageBlockhash(payout: PayoutView): string | null {
  const message = payout.solana?.message;
  if (!message) return null;
  try {
    return VersionedMessage.deserialize(base64ToBytes(message)).recentBlockhash;
  } catch {
    return null;
  }
}

async function signatureStatus(connection: Connection, signature: string): Promise<SignatureStatus | null> {
  const { value } = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
  return value[0] ?? null;
}

function landedText(status: SignatureStatus | null): string {
  if (!status) return "not seen yet";
  return status.confirmationStatus ?? "processed";
}

const SOL_POLL_MS = 2_000;
const SOL_RESEND_MS = 10_000;
const SOL_FINAL_WAIT_MS = 180_000;

function notFinalError(): RoseActionError {
  return new RoseActionError("rpc", "Not final on Solana yet", "The transaction is not finalized after 3 minutes (devnet congestion or a lagging RPC). Retry: the stored transaction can be broadcast again at any time.", true);
}

export type DurableBroadcast = { signature: string; failedOnChain: boolean };

/**
 * Broadcasts an engine-signed durable-nonce transaction (a claim, a redeem or their
 * cancellation) without preflight, so a transaction that fails at execution still lands and
 * advances its nonce (measured on devnet, docs/verification.md), and waits until the
 * transaction is finalized and the nonce reads advanced at `finalized`: only then can the
 * engine's `confirm_sol_*` proof succeed. Re-broadcasts every 10 s while it has not landed.
 */
export async function broadcastDurableNonceTransaction(connection: Connection, payout: PayoutView, options: { signal?: AbortSignal; onProgress?: (text: string) => void } = {}): Promise<DurableBroadcast> {
  const solana = payout.solana;
  const signature = solPayoutSignature(payout);
  if (!solana?.transaction || !signature) throw new RoseActionError("contract", "Not signed yet", "The engine has not stored both signatures of this transaction yet.");
  if (!solana.nonce_account || !solana.nonce_value) throw new RoseActionError("contract", "No durable nonce", "This action is signed against a recent blockhash, not a durable nonce.");
  const wire = base64ToBytes(solana.transaction);
  const nonceAccount = new PublicKey(solana.nonce_account);
  const started = Date.now();
  let sentAt: number | null = null;
  for (;;) {
    const [status, nonce] = await Promise.all([signatureStatus(connection, signature), readNonceAccount(connection, nonceAccount, "finalized")]);
    const advanced = nonce.nonce !== solana.nonce_value;
    if (advanced && (status === null || status.confirmationStatus === "finalized")) return { signature, failedOnChain: status !== null && status.err !== null };
    if (status === null && !advanced && (sentAt === null || Date.now() - sentAt >= SOL_RESEND_MS)) {
      try {
        await connection.sendRawTransaction(wire, { skipPreflight: true });
      } catch (error) {
        if (classifySolanaError(error).kind !== "already_processed") throw error;
      }
      sentAt = Date.now();
    }
    const elapsed = Math.round((Date.now() - started) / 1000);
    options.onProgress?.(
      status === null
        ? `Sent without preflight (fee paid by gas/sol); waiting for it to land… ${String(elapsed)} s`
        : `Landed (${landedText(status)}${status.err !== null ? ", failed on chain" : ""}); waiting for finality and the finalized nonce, about 15 s… ${String(elapsed)} s`,
    );
    if (Date.now() - started > SOL_FINAL_WAIT_MS) throw notFinalError();
    await sleep(SOL_POLL_MS, options.signal);
  }
}

/**
 * Polls the nonce account at `finalized` until its value differs from the signed one: the
 * engine's `confirm_sol_*` panics on an unadvanced nonce, so no NEAR gas is spent before.
 */
export async function waitForFinalizedNonce(connection: Connection, nonceAccount: string, signedValue: string, options: { signal?: AbortSignal; onProgress?: (text: string) => void } = {}): Promise<void> {
  const started = Date.now();
  for (;;) {
    const state = await readNonceAccount(connection, new PublicKey(nonceAccount), "finalized");
    if (state.nonce !== signedValue) return;
    const elapsed = Date.now() - started;
    if (elapsed > SOL_FINAL_WAIT_MS) {
      throw new RoseActionError("contract", "Nonce not advanced", "The durable nonce has not advanced at finality: the stored transaction has not landed yet. Broadcast it first (anyone can), then confirm.", true);
    }
    options.onProgress?.(`Waiting until the nonce advance is finalized on Solana… ${String(Math.round(elapsed / 1000))} s`);
    await sleep(SOL_POLL_MS, options.signal);
  }
}

/**
 * The anchor of a confirmation proof: the payout's own transaction when it succeeded at
 * `finalized`, otherwise (it failed on chain, or only its cancellation landed) the newest
 * successful finalized transaction touching the nonce account.
 */
export async function confirmationAnchor(connection: Connection, payout: PayoutView): Promise<string> {
  const own = solPayoutSignature(payout);
  if (own) {
    const status = await signatureStatus(connection, own);
    if (status && status.err === null && status.confirmationStatus === "finalized") return own;
  }
  const nonceAccount = payout.solana?.nonce_account;
  const fallback = nonceAccount ? await latestSuccessfulSignature(connection, new PublicKey(nonceAccount)) : null;
  if (!fallback) throw new RoseActionError("contract", "No anchor", "No successful finalized transaction touches the nonce account yet; retry in a few seconds.", true);
  return fallback;
}

export type BlockhashActionState = "executed" | "failed" | "expired" | "pending";

/**
 * Where a blockhash-signed action (deposit move, return of a refused deposit) stands on
 * Solana: `executed` or `failed` once it landed (from the signature status, history included),
 * `expired` when it never landed and its blockhash is no longer valid (it can never execute:
 * the engine signs a new one), `pending` while it can still be broadcast.
 */
export async function blockhashActionState(connection: Connection, payout: PayoutView): Promise<BlockhashActionState> {
  const signature = solPayoutSignature(payout);
  const blockhash = payoutMessageBlockhash(payout);
  if (!signature || !blockhash) return "pending";
  const status = await signatureStatus(connection, signature);
  if (status && status.confirmationStatus !== "processed") return status.err === null ? "executed" : "failed";
  if (status) return "pending";
  const { value: valid } = await connection.isBlockhashValid(blockhash, { commitment: "processed" });
  return valid ? "pending" : "expired";
}

function expiredError(): RoseActionError {
  return new RoseActionError("expired_blockhash", "Blockhash expired", "The engine-signed transaction's blockhash expired before it landed. Nothing was debited; retry asks the engine to sign it again with a fresh blockhash.", true);
}

/**
 * Broadcasts an engine-signed blockhash action with preflight (an expired blockhash or a failing
 * transfer is refused before it costs a fee) and waits until it is finalized. An action that
 * already landed is not sent again; an expired one leads to the retry path.
 */
export async function broadcastBlockhashAction(connection: Connection, payout: PayoutView, options: { signal?: AbortSignal; onProgress?: (text: string) => void } = {}): Promise<string> {
  const solana = payout.solana;
  const signature = solPayoutSignature(payout);
  if (!solana?.transaction || !signature) throw new RoseActionError("contract", "Not signed yet", "The engine has not stored both signatures of this transaction yet.");
  const before = await blockhashActionState(connection, payout);
  if (before === "expired") throw expiredError();
  if (before === "failed") throw new RoseActionError("contract", "Failed on Solana", "The transaction landed and failed on chain; check the explorer link. Retry asks the engine to sign it again.", true);
  if (before === "pending") {
    try {
      await connection.sendRawTransaction(base64ToBytes(solana.transaction), { skipPreflight: false });
    } catch (error) {
      const kind = classifySolanaError(error).kind;
      if (kind === "expired_blockhash") throw expiredError();
      if (kind !== "already_processed") throw error;
    }
  }
  const started = Date.now();
  for (;;) {
    const status = await signatureStatus(connection, signature);
    if (status?.err) throw new RoseActionError("contract", "Failed on Solana", `The transaction failed on chain: ${JSON.stringify(status.err).slice(0, 160)}. Retry asks the engine to sign it again.`, true);
    if (status?.confirmationStatus === "finalized") return signature;
    if (!status && (await blockhashActionState(connection, payout)) === "expired") throw expiredError();
    const elapsed = Math.round((Date.now() - started) / 1000);
    options.onProgress?.(`Landed: ${landedText(status)}; waiting for finality, about 15 s… ${String(elapsed)} s`);
    if (Date.now() - started > SOL_FINAL_WAIT_MS) throw notFinalError();
    await sleep(SOL_POLL_MS, options.signal);
  }
}

/**
 * The finalized account bytes that settle a broadcast payout or redeem (`confirm_sol_payout`,
 * `confirm_sol_redeem`): the nonce account (advanced) and the metadata of each drawn stream.
 */
export async function readSolConfirmation(connection: Connection, nonceAccount: string, streams: readonly string[]): Promise<{ nonceData: string; streamData: string[] }> {
  const accounts = await connection.getMultipleAccountsInfo([new PublicKey(nonceAccount), ...streams.map((stream) => new PublicKey(stream))], "finalized");
  const missing = accounts.findIndex((account) => account === null);
  if (missing !== -1) throw new RoseActionError("contract", "Account not final yet", `${missing === 0 ? "The nonce account" : "A drawn stream"} is not readable at finality yet; retry in a few seconds.`, true);
  const data = accounts.map((account) => bytesToHex(Uint8Array.from(account!.data)));
  return { nonceData: data[0]!, streamData: data.slice(1) };
}

/** The NEAR block from which a second "did not execute" proof settles a payout (spec 7.3), or null before the first one. */
export function secondProofBlock(payout: PayoutView, delayBlocks = 150n): bigint | null {
  const seen = payout.solana?.not_executed_seen_at;
  return seen === undefined || seen === null ? null : BigInt(seen) + delayBlocks;
}

/** One line describing what a payout does, for lists and toasts. */
export function describePayout(payout: PayoutView, decimalsOf: (token: string) => number | null, format: (amount: bigint, decimals: number) => string): string {
  const kind = payout.kind;
  if ("BaseTransfer" in kind) {
    const decimals = decimalsOf(kind.BaseTransfer.token);
    const amount = decimals === null ? kind.BaseTransfer.amount : format(BigInt(kind.BaseTransfer.amount), decimals);
    return `Transfer ${amount} on Base to ${kind.BaseTransfer.to.slice(0, 6)}…${kind.BaseTransfer.to.slice(-4)}`;
  }
  if ("BaseRelease" in kind) return `Release Sablier stream #${String(kind.BaseRelease.stream_id)} on Base`;
  if ("SolTransfer" in kind) {
    const decimals = decimalsOf(kind.SolTransfer.mint);
    const amount = decimals === null ? kind.SolTransfer.amount : format(BigInt(kind.SolTransfer.amount), decimals);
    return `Transfer ${amount} on Solana to ${kind.SolTransfer.to_owner.slice(0, 4)}…${kind.SolTransfer.to_owner.slice(-4)}`;
  }
  if ("SolRelease" in kind) return `Release Streamflow stream ${kind.SolRelease.metadata.slice(0, 4)}…${kind.SolRelease.metadata.slice(-4)}`;
  if ("SolMove" in kind) return `Move Streamflow stream ${kind.SolMove.metadata.slice(0, 4)}…${kind.SolMove.metadata.slice(-4)} into the vault`;
  return `Return Streamflow stream ${kind.SolReturn.metadata.slice(0, 4)}…${kind.SolReturn.metadata.slice(-4)}`;
}

/**
 * Where a payout can be checked on its own chain: the Solana transaction itself (its id is the
 * first signature of the stored wire bytes), or RoseVault's event log on Basescan for a Base
 * authorization (the engine stores no Base transaction hash; `TransferExecuted` and
 * `ReleaseExecuted` carry the payout id).
 */
export function payoutExplorerLink(payout: PayoutView, vault: string | null): { href: string; label: string } | null {
  if (payout.chain === "Solana") {
    const signature = solPayoutSignature(payout);
    return signature ? { href: solanaTxUrl(signature), label: "Solana transaction ↗" } : null;
  }
  if (!vault || (payout.status !== "Landed" && payout.status !== "Signed")) return null;
  return { href: `${baseAddressUrl(vault)}#events`, label: `RoseVault events (id ${payout.id}) ↗` };
}
