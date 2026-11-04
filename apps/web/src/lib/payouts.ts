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
  readNonceAccount,
  type EngineViews,
  type PayoutView,
  type SignerClient,
  type SolNonceProof,
} from "@rose/sdk";
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { baseEncode } from "near-api-js";
import { Keypair, PublicKey, type Connection } from "@solana/web3.js";
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
    return executeRelease(wallet, { vault, authorization: { lockup: kind.lockup as Address, streamId: BigInt(kind.stream_id), to: kind.to as Address, id }, ...signature });
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
 * Creates the payout's durable nonce account from the claimant's Solana wallet (authority =
 * the engine's vault) and, in the same transaction, the recipient's associated token account for
 * the mint when it does not exist yet (idempotent). After finality it reads back the exact bytes
 * the engine proves: the nonce account and the recipient's token account.
 */
export async function createPayoutNonce(
  signer: SolanaSigner,
  connection: Connection,
  vaultSol: string,
  recipient: { owner: PublicKey; mint: PublicKey },
  onProgress?: (text: string) => void,
): Promise<CreatedNonce> {
  const nonceKeypair = Keypair.generate();
  const lamports = await nonceRent(connection);
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const transaction = createNonceAccountTransaction({ payer: signer.publicKey, nonceAccount: nonceKeypair.publicKey, authority: new PublicKey(vaultSol), lamports, blockhash, lastValidBlockHeight });
  const recipientTokens = getAssociatedTokenAddressSync(recipient.mint, recipient.owner, true);
  transaction.add(createAssociatedTokenAccountIdempotentInstruction(signer.publicKey, recipientTokens, recipient.owner, recipient.mint));
  transaction.partialSign(nonceKeypair);
  const signed = await signer.signTransaction(transaction);
  onProgress?.("Sending the nonce account creation…");
  const signature = await connection.sendRawTransaction(signed.serialize());
  onProgress?.("Waiting for finality (about 15 s)…");
  await confirmSignature(connection, signature, { strategy: "blockhash", blockhash, lastValidBlockHeight, commitment: "finalized" });
  const [state, tokens] = await Promise.all([readNonceAccount(connection, nonceKeypair.publicKey, "finalized"), connection.getAccountInfo(recipientTokens, "finalized")]);
  if (!tokens) throw new RoseActionError("contract", "No token account", `The recipient's token account ${recipientTokens.toBase58()} is not readable at finality yet; retry.`, true);
  return {
    proof: { account: nonceKeypair.publicKey.toBase58(), anchor_tx: signature, data: bytesToHex(state.raw), recipient_tokens_data: bytesToHex(Uint8Array.from(tokens.data)) },
    nonceAccount: nonceKeypair.publicKey,
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
