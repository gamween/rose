/**
 * Foreign-chain side of the engine's payouts (spec 7.3): submitting a stored EIP-712
 * authorization to RoseVault, creating and proving a Solana durable nonce with the recipient's
 * token account, broadcasting a stored durable-nonce transaction and reading the accounts that
 * confirm it landed. The engine never pushes; the claimant's browser does.
 */

import {
  base64ToBytes,
  bytesToHex,
  confirmSignature,
  createNonceAccountTransaction,
  executeRelease,
  executeTransfer,
  nonceRent,
  payoutNonceAddress,
  payoutNonceSeed,
  readNonceAccount,
  type EngineViews,
  type PayoutView,
  type SignerClient,
  type SolNonceProof,
} from "@rose/sdk";
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { baseEncode } from "near-api-js";
import { PublicKey, Transaction, type Connection } from "@solana/web3.js";
import type { Address, Hex } from "viem";
import { RoseActionError } from "./errors";
import type { SolanaSigner } from "@/components/wallet/WalletProvider";

export type PayoutChain = "base" | "solana";

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

/** Whether the payout's signature exists and nothing else is pending on the engine side. */
export function payoutIsSigned(payout: PayoutView): boolean {
  return payout.status === "Signed";
}

export function payoutFailureReason(payout: PayoutView): string | null {
  return typeof payout.status === "object" && "Failed" in payout.status ? payout.status.Failed.reason : null;
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
      if (reason !== null) throw new RoseActionError("mpc_timeout", "The MPC produced no signature", `${reason}. Your balance was refunded; retry.`, true);
      return payout;
    }
    const elapsed = Date.now() - started;
    options.onPoll?.(elapsed);
    if (elapsed > MPC_WAIT_MS) {
      throw new RoseActionError("mpc_timeout", "MPC signature timed out", "The engine has not received the MPC signature after 2.5 minutes. The request stays recorded; retry from your portfolio once it is signed, or retry the signature request.", true);
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, MPC_POLL_MS);
      options.signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(new Error("aborted"));
        },
        { once: true },
      );
    });
  }
}

export type CreatedNonce = { proof: SolNonceProof; nonceAccount: PublicKey; signature: string; nonceValue: string; slot: number };

/**
 * The payout's durable nonce account of `nearAccount` (spec 7.3): created from the claimant's
 * Solana wallet with a seed bound to the NEAR account (`createWithSeed(wallet, payoutNonceSeed)`,
 * authority = the engine's vault; the wallet is the base and the only signer), or reused when it
 * already exists, together with the recipient's associated token account for the mint
 * (idempotent). After finality it reads back the exact bytes the engine proves: the nonce account
 * and the recipient's token account, anchored on a finalized transaction not newer than the reads.
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
    const [latest] = await connection.getSignaturesForAddress(nonceAccount, { limit: 1 }, "finalized");
    if (!latest || latest.err !== null) throw new RoseActionError("contract", "No anchor", `No finalized successful transaction touches the nonce account ${nonceAccount.toBase58()} yet; retry.`, true);
    signature = latest.signature;
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

/** Broadcasts the engine-signed durable-nonce transaction (base64 wire bytes) stored in a payout and waits for confirmation. */
export async function broadcastSolPayout(connection: Connection, payout: PayoutView): Promise<string> {
  const solana = payout.solana;
  if (!solana?.transaction) throw new RoseActionError("contract", "Not signed yet", "The engine has not stored both signatures of this transaction yet.");
  const wire = base64ToBytes(solana.transaction);
  const slot = await connection.getSlot("confirmed");
  const signature = await connection.sendRawTransaction(wire, { skipPreflight: false });
  if (solana.nonce_account && solana.nonce_value) {
    await confirmSignature(connection, signature, { strategy: "durable-nonce", nonceAccount: new PublicKey(solana.nonce_account), nonceValue: solana.nonce_value, minContextSlot: slot });
  } else {
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
    await confirmSignature(connection, signature, { strategy: "blockhash", blockhash, lastValidBlockHeight });
  }
  return signature;
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

export function payoutChain(payout: PayoutView): PayoutChain {
  return payout.chain === "Base" ? "base" : "solana";
}
