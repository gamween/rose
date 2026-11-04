import { PublicKey } from "@solana/web3.js";
import { baseDecode } from "near-api-js";
import { isAddress } from "viem";

export type FaucetChain = "base" | "solana" | "near";

export const FAUCET_CHAINS: readonly FaucetChain[] = ["base", "solana", "near"];

export type FaucetRequest =
  | { chain: "base"; address: `0x${string}` }
  | { chain: "solana"; address: string }
  | { chain: "near"; accountId: string; publicKey: string };

export type ParseResult = { ok: true; request: FaucetRequest } | { ok: false; message: string };

const NEAR_TESTNET_ACCOUNT = /^[a-z0-9_-]+\.testnet$/;

/**
 * A top-level NEAR testnet account id: lowercase, one label plus `.testnet`, 2 to 64 characters
 * in total (nearcore rules), with no leading, trailing or doubled separators in the label.
 */
export function isValidNearTestnetAccountId(value: string): boolean {
  if (value.length < 2 || value.length > 64) return false;
  if (!NEAR_TESTNET_ACCOUNT.test(value)) return false;
  const label = value.slice(0, -".testnet".length);
  if (label.length === 0) return false;
  if (/^[_-]|[_-]$|[_-]{2}/.test(label)) return false;
  return true;
}

/** `ed25519:<base58>` decoding to exactly 32 bytes. */
export function isValidNearEd25519Key(value: string): boolean {
  if (!value.startsWith("ed25519:")) return false;
  const encoded = value.slice("ed25519:".length);
  if (!/^[1-9A-HJ-NP-Za-km-z]+$/.test(encoded)) return false;
  try {
    return baseDecode(encoded).length === 32;
  } catch {
    return false;
  }
}

/** A base58 Solana public key (32 bytes). */
export function isValidSolanaAddress(value: string): boolean {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) return false;
  try {
    return new PublicKey(value).toBytes().length === 32;
  } catch {
    return false;
  }
}

function field(body: Record<string, unknown>, name: string): string | null {
  const value = body[name];
  return typeof value === "string" ? value.trim() : null;
}

/** Validates the JSON body of `POST /api/faucet`; every failure is a human-readable message. */
export function parseFaucetRequest(body: unknown): ParseResult {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, message: "The request body must be a JSON object." };
  }
  const record = body as Record<string, unknown>;
  const chainField = field(record, "chain");
  const chain = FAUCET_CHAINS.find((candidate) => candidate === chainField);
  if (chain === undefined) {
    return { ok: false, message: 'chain must be "base", "solana" or "near".' };
  }
  if (chain === "near") {
    const accountId = field(record, "accountId");
    const publicKey = field(record, "publicKey");
    if (accountId === null || !isValidNearTestnetAccountId(accountId)) {
      return { ok: false, message: "accountId must be a lowercase NEAR testnet account id such as alice-demo.testnet." };
    }
    if (publicKey === null || !isValidNearEd25519Key(publicKey)) {
      return { ok: false, message: "publicKey must be an ed25519 NEAR public key (ed25519:<base58>)." };
    }
    return { ok: true, request: { chain, accountId, publicKey } };
  }
  const address = field(record, "address");
  if (chain === "base") {
    if (address === null || !isAddress(address)) {
      return { ok: false, message: "address must be a 0x-prefixed Ethereum address." };
    }
    return { ok: true, request: { chain, address } };
  }
  if (address === null || !isValidSolanaAddress(address)) {
    return { ok: false, message: "address must be a base58 Solana public key." };
  }
  return { ok: true, request: { chain, address } };
}

/** The subject a request is rate limited on: the funded address or account id. */
export function requestSubject(request: FaucetRequest): string {
  return request.chain === "near" ? request.accountId : request.address.toLowerCase();
}
