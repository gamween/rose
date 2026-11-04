import { readFileSync } from "node:fs";
import { Keypair, Message, PublicKey, SendTransactionError, SystemProgram } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { broadcastSignedTransaction, classifySolanaError, confirmSignature, SolanaTransactionError } from "../../src/chains/solana/broadcast.js";
import { must } from "./must.js";
import { stubConnection } from "./rpc.js";
import { accountStateArgs, createNonceAccountTransaction, NONCE_ACCOUNT_LEN, nonceAccountStateArgs, nonceRent, readNonceAccount } from "../../src/chains/solana/nonce.js";

interface MessagesFixture {
  keys: Record<string, string>;
  messages: Record<string, string>;
}
/** A real devnet signature (the payout broadcast of the sign spike, docs/verification.md). */
const SIGNATURE = "4CrVjw75paRmX7Uopaoeyfv1D83oLKpyJBLM6AbNziMkuPGQ4ykxgUBGT3TZ8vxZeajR7XqsAvnEMtutNBuTL9Wy";
const messages = JSON.parse(readFileSync(new URL("./fixtures/solana_messages.json", import.meta.url), "utf8")) as MessagesFixture;

/** System nonce account bytes: version u32 LE (1), state u32 LE (1 = initialized), authority, nonce, lamports per signature u64 LE. */
function nonceBytes(authority: PublicKey, nonce: PublicKey, lamportsPerSignature: number): Uint8Array {
  const bytes = new Uint8Array(NONCE_ACCOUNT_LEN);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 1, true);
  view.setUint32(4, 1, true);
  bytes.set(authority.toBytes(), 8);
  bytes.set(nonce.toBytes(), 40);
  view.setBigUint64(72, BigInt(lamportsPerSignature), true);
  return bytes;
}

describe("nonce accounts", () => {
  it("compiles createNonceAccount to the engine's web3.js vector", () => {
    const payer = new PublicKey(must(messages.keys["gas"]));
    const transaction = createNonceAccountTransaction({
      payer,
      nonceAccount: new PublicKey(must(messages.keys["nonce"])),
      authority: new PublicKey(must(messages.keys["vault"])),
      lamports: 1_447_680,
      blockhash: new PublicKey(Buffer.alloc(32, 0x42)).toBase58(),
      lastValidBlockHeight: 1,
    });
    const expected = Message.from(Buffer.from(must(messages.messages["create_nonce_account"]), "hex"));
    const compiled = transaction.compileMessage();
    expect(compiled.accountKeys.map((key) => key.toBase58())).toEqual(expected.accountKeys.map((key) => key.toBase58()));
    expect(compiled.instructions).toEqual(expected.instructions);
    expect(compiled.header).toEqual(expected.header);
    expect(compiled.serialize().toString("hex")).toBe(messages.messages["create_nonce_account"]);
  });

  it("reads the rent, decodes a nonce account and encodes the AccountState proof", async () => {
    const authority = new PublicKey(must(messages.keys["vault"]));
    const nonce = new PublicKey(must(messages.keys["nonceValue"]));
    const bytes = nonceBytes(authority, nonce, 5000);
    const connection = stubConnection((method) =>
      method === "getMinimumBalanceForRentExemption"
        ? 1_056_640
        : { context: { slot: 518404430 }, value: { data: [Buffer.from(bytes).toString("base64"), "base64"], executable: false, lamports: 1_056_640, owner: SystemProgram.programId.toBase58(), rentEpoch: 0, space: 80 } },
    );
    expect(await nonceRent(connection)).toBe(1_056_640);
    const state = await readNonceAccount(connection, new PublicKey(must(messages.keys["nonce"])));
    expect(state.authority.equals(authority)).toBe(true);
    expect(state.nonce).toBe(nonce.toBase58());
    expect(state.feeCalculator.lamportsPerSignature).toBe(5000);
    expect(state.slot).toBe(518404430);
    expect(state.owner.equals(SystemProgram.programId)).toBe(true);
    const args = nonceAccountStateArgs(state);
    expect(args.owner).toBe("0".repeat(64));
    expect(args.data).toBe(Buffer.from(bytes).toString("hex"));
    expect(args.data.slice(16, 80)).toBe(Buffer.from(authority.toBytes()).toString("hex"));
    expect(accountStateArgs(new PublicKey(must(messages.keys["vault"])), new Uint8Array([1, 255])).data).toBe("01ff");
  });

  it("refuses a missing or oddly sized nonce account", async () => {
    const missing = stubConnection(() => ({ context: { slot: 1 }, value: null }));
    await expect(readNonceAccount(missing, Keypair.generate().publicKey)).rejects.toThrow("does not exist");
    const short = stubConnection(() => ({ context: { slot: 1 }, value: { data: [Buffer.alloc(10).toString("base64"), "base64"], executable: false, lamports: 1, owner: SystemProgram.programId.toBase58(), rentEpoch: 0, space: 10 } }));
    await expect(readNonceAccount(short, Keypair.generate().publicKey)).rejects.toThrow("expected 80");
  });
});

describe("broadcast", () => {
  it("sends wire bytes or base64 with preflight and confirms by nonce or blockhash", async () => {
    const sent: unknown[][] = [];
    const connection = stubConnection((method, params) => {
      if (method === "sendTransaction") {
        sent.push(params);
        return SIGNATURE;
      }
      if (method === "getSignatureStatuses") return { context: { slot: 2 }, value: [{ slot: 1, confirmations: 1, err: null, confirmationStatus: "confirmed" }] };
      if (method === "getBlockHeight") return 1;
      if (method === "getAccountInfo") return { context: { slot: 2 }, value: null };
      return null;
    });
    const wire = new Uint8Array([2, 1, 2, 3]);
    const signature = await broadcastSignedTransaction(connection, wire);
    expect(signature).toBe(SIGNATURE);
    const first = must(sent[0]);
    expect(first[0]).toBe(Buffer.from(wire).toString("base64"));
    expect((first[1] as { skipPreflight?: boolean }).skipPreflight).toBeFalsy();
    await broadcastSignedTransaction(connection, Buffer.from(wire).toString("base64"), { skipPreflight: true });
    expect((must(sent[1])[1] as { skipPreflight?: boolean }).skipPreflight).toBe(true);
    await expect(confirmSignature(connection, signature, { strategy: "blockhash", blockhash: new PublicKey(Buffer.alloc(32, 1)).toBase58(), lastValidBlockHeight: 10 })).resolves.toBeUndefined();
  });

  it("surfaces an on-chain failure as SolanaTransactionError", async () => {
    const connection = stubConnection((method) => (method === "getSignatureStatuses" ? { context: { slot: 2 }, value: [{ slot: 1, confirmations: 1, err: { InstructionError: [0, "Custom"] }, confirmationStatus: "confirmed" }] } : 1));
    await expect(confirmSignature(connection, SIGNATURE, { strategy: "blockhash", blockhash: new PublicKey(Buffer.alloc(32, 1)).toBase58(), lastValidBlockHeight: 10 })).rejects.toBeInstanceOf(SolanaTransactionError);
  });

  it("classifies errors the UI acts on", () => {
    expect(classifySolanaError(new Error("User rejected the request")).kind).toBe("rejected");
    expect(classifySolanaError(new Error("Blockhash not found")).kind).toBe("expired_blockhash");
    expect(classifySolanaError(new Error("TransactionExpiredBlockheightExceededError: block height exceeded")).kind).toBe("expired_blockhash");
    expect(classifySolanaError(new Error("Transfer: insufficient lamports 0, need 1056640")).kind).toBe("insufficient_funds");
    expect(classifySolanaError(new Error("This transaction has already been processed")).kind).toBe("already_processed");
    const send = new SendTransactionError({ action: "send", signature: "sig", transactionMessage: "Attempt to debit an account but found no record of a prior credit." });
    expect(classifySolanaError(send).kind).toBe("insufficient_funds");
    expect(classifySolanaError(new SolanaTransactionError("sig", "BlockhashNotFound")).kind).toBe("expired_blockhash");
    expect(classifySolanaError(42)).toEqual({ kind: "unknown", message: "Unknown Solana error." });
  });
});
