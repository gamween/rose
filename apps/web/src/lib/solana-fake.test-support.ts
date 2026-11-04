/**
 * An in-memory stand-in for the web3.js `Connection` methods the payout code calls, so the
 * broadcast, finality and confirmation logic is tested without a network: accounts per
 * commitment, signature statuses, signature history per address and the sent transactions.
 */

import { bytesToBase64, type PayoutView } from "@rose/sdk";
import { Keypair, PublicKey, SystemProgram, TransactionMessage, type Connection, type SignatureStatus } from "@solana/web3.js";
import { baseEncode } from "near-api-js";

export const VAULT = Keypair.generate().publicKey;
export const NONCE_ACCOUNT = Keypair.generate().publicKey;

/** 80 bytes of an initialized nonce account (`NonceAccountLayout`) with `authority` and `nonce`. */
export function nonceAccountData(nonce: string, authority: PublicKey = VAULT): Buffer {
  const data = Buffer.alloc(80);
  data.writeUInt32LE(0, 0);
  data.writeUInt32LE(1, 4);
  authority.toBuffer().copy(data, 8);
  new PublicKey(nonce).toBuffer().copy(data, 40);
  data.writeBigUInt64LE(5000n, 72);
  return data;
}

export const SIGNED_NONCE = Keypair.generate().publicKey.toBase58();
export const ADVANCED_NONCE = Keypair.generate().publicKey.toBase58();

/** A stored engine transaction: `[2] || sig(gas) || sig(authority) || message` built on `blockhash`. */
export function storedTransaction(blockhash: string, gasSignatureByte: number): { wire: string; message: string; signature: string } {
  const payer = Keypair.generate().publicKey;
  const message = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: [SystemProgram.transfer({ fromPubkey: payer, toPubkey: VAULT, lamports: 1 })] }).compileToLegacyMessage().serialize();
  const gas = new Uint8Array(64).fill(gasSignatureByte);
  const wire = new Uint8Array([2, ...gas, ...new Uint8Array(64).fill(7), ...message]);
  return { wire: bytesToBase64(wire), message: bytesToBase64(Uint8Array.from(message)), signature: baseEncode(gas) };
}

export function solTransferPayout(overrides: Partial<PayoutView> = {}, solana: Partial<NonNullable<PayoutView["solana"]>> = {}): PayoutView {
  const stored = storedTransaction(SIGNED_NONCE, 3);
  return {
    id: "21",
    chain: "Solana",
    kind: { SolTransfer: { mint: "m", to_owner: "o", amount: "1" } },
    debit: null,
    requester: "a.testnet",
    status: "Signed",
    created_at: "0",
    updated_at: "0",
    requested_block: "100",
    sign_requests: 1,
    solana: { message: stored.message, draws: [{ position_id: "4", amount: "1", expected_withdrawn: "1" }], authority_path: "vault/sol", authority: VAULT.toBase58(), cancel: false, nonce_account: NONCE_ACCOUNT.toBase58(), nonce_value: SIGNED_NONCE, transaction: stored.wire, ...solana },
    ...overrides,
  };
}

export function moveSignature(blockhash: string): { payout: PayoutView; signature: string } {
  const stored = storedTransaction(blockhash, 4);
  return {
    signature: stored.signature,
    payout: {
      id: "30",
      chain: "Solana",
      kind: { SolMove: { metadata: "m", from: "f", to_owner: "o" } },
      debit: null,
      requester: "a.testnet",
      status: "Signed",
      created_at: "0",
      updated_at: "0",
      requested_block: "100",
      sign_requests: 1,
      solana: { message: stored.message, draws: [], authority_path: "dep/a", authority: "x", cancel: false, transaction: stored.wire },
    },
  };
}

type Commitment = "processed" | "confirmed" | "finalized";

export class FakeSolana {
  /** Account data per base58 address and commitment (a missing commitment falls back to `confirmed`). */
  accounts = new Map<string, Partial<Record<Commitment, Buffer | null>>>();
  statuses = new Map<string, SignatureStatus | null>();
  history = new Map<string, { signature: string; err: unknown }[]>();
  validBlockhashes = new Set<string>();
  sent: { skipPreflight: boolean | undefined }[] = [];
  /** What `sendRawTransaction` does: lands the transaction, throws, or nothing (dropped). */
  onSend: (() => void) | null = null;

  setAccount(address: PublicKey, data: Buffer | null, commitment: Commitment | "all" = "all"): void {
    const entry = this.accounts.get(address.toBase58()) ?? {};
    if (commitment === "all") {
      entry.processed = data;
      entry.confirmed = data;
      entry.finalized = data;
    } else entry[commitment] = data;
    this.accounts.set(address.toBase58(), entry);
  }

  private read(address: PublicKey, commitment: Commitment): Buffer | null {
    const entry = this.accounts.get(address.toBase58());
    if (!entry) return null;
    return (commitment in entry ? entry[commitment] : entry.confirmed) ?? null;
  }

  connection(): Connection {
    const fake = {
      getAccountInfoAndContext: (address: PublicKey, commitment: Commitment) => {
        const data = this.read(address, commitment);
        return Promise.resolve({ context: { slot: 10 }, value: data ? { data, owner: SystemProgram.programId, lamports: 1, executable: false } : null });
      },
      getMultipleAccountsInfo: (addresses: PublicKey[], commitment: Commitment) => Promise.resolve(addresses.map((address) => {
        const data = this.read(address, commitment);
        return data ? { data, owner: SystemProgram.programId, lamports: 1, executable: false } : null;
      })),
      getSignatureStatuses: (signatures: string[]) => Promise.resolve({ context: { slot: 10 }, value: signatures.map((signature) => this.statuses.get(signature) ?? null) }),
      getSignaturesForAddress: (address: PublicKey, options: { limit: number; before?: string }) => {
        const all = this.history.get(address.toBase58()) ?? [];
        const start = options.before ? all.findIndex((entry) => entry.signature === options.before) + 1 : 0;
        return Promise.resolve(all.slice(start, start + options.limit));
      },
      isBlockhashValid: (blockhash: string) => Promise.resolve({ context: { slot: 10 }, value: this.validBlockhashes.has(blockhash) }),
      sendRawTransaction: (_wire: Uint8Array, options: { skipPreflight?: boolean }) => {
        this.sent.push({ skipPreflight: options.skipPreflight });
        this.onSend?.();
        return Promise.resolve("sent");
      },
    };
    return fake as unknown as Connection;
  }
}

/** A finalized, successful (or failed) signature status. */
export function status(confirmationStatus: Commitment, err: unknown = null): SignatureStatus {
  return { slot: 10, confirmations: null, err: err as SignatureStatus["err"], confirmationStatus };
}
