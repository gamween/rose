import { bytesToBase64, payoutNonceSeed, type PayoutView, type SignerClient } from "@rose/sdk";
import { Keypair } from "@solana/web3.js";
import { baseEncode } from "near-api-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  blockhashActionState,
  broadcastBlockhashAction,
  broadcastDurableNonceTransaction,
  confirmationAnchor,
  latestSuccessfulSignature,
  PayoutRefusedError,
  payoutExplorerLink,
  payoutMessageBlockhash,
  payoutSeedSuffixes,
  secondProofBlock,
  sleep,
  solPayoutSignature,
  submitBasePayout,
  waitForFinalizedNonce,
} from "./payouts";
import { ADVANCED_NONCE, FakeSolana, moveSignature, NONCE_ACCOUNT, nonceAccountData, SIGNED_NONCE, solTransferPayout, status } from "./solana-fake.test-support";

function payoutWith(transaction: string | null): PayoutView {
  return {
    id: "4",
    chain: "Solana",
    kind: { SolTransfer: { mint: "m", to_owner: "o", amount: "1" } },
    debit: null,
    requester: "a.testnet",
    status: "Signed",
    created_at: "0",
    updated_at: "0",
    requested_block: "1",
    sign_requests: 1,
    solana: transaction === null ? null : { message: "", draws: [], swept: "0", authority_path: "vault/sol", authority: "v", cancel: false, transaction },
  };
}

describe("solPayoutSignature", () => {
  it("reads the transaction id (first signature) from the base64 wire bytes", () => {
    const gas = Uint8Array.from({ length: 64 }, (_, index) => index + 1);
    const wire = new Uint8Array([2, ...gas, ...new Uint8Array(64).fill(9), 1, 2, 3]);
    expect(solPayoutSignature(payoutWith(bytesToBase64(wire)))).toBe(baseEncode(gas));
  });

  it("is null before both signatures are stored", () => {
    expect(solPayoutSignature(payoutWith(null))).toBeNull();
  });
});

describe("submitBasePayout", () => {
  function release(vestedToRecipient: boolean): PayoutView {
    return {
      id: "12",
      chain: "Base",
      kind: { BaseRelease: { lockup: "0xa65a1ecef02c2b9bdc604951c6a6d02335d4532e", stream_id: 94, to: "0x00000000000000000000000000000000000000b0", vested_to_recipient: vestedToRecipient } },
      debit: null,
      requester: "a.testnet",
      status: "Signed",
      created_at: "0",
      updated_at: "0",
      requested_block: "1",
      sign_requests: 1,
      base: { v: 27, r: "11".repeat(32), s: "22".repeat(32) },
    } as PayoutView;
  }

  it.each([true, false])("signs the Release with vestedToRecipient = %s, as the engine authorized it", async (vested) => {
    const sent: unknown[] = [];
    const wallet = { writeContract: (request: { functionName: string; args: unknown[] }) => (sent.push(request), Promise.resolve("0xabc")) } as unknown as SignerClient;
    await submitBasePayout(wallet, "0x1111111111111111111111111111111111111111", release(vested));
    expect(sent).toMatchObject([{ functionName: "executeRelease", args: [{ lockup: "0xa65a1ecef02c2b9bdc604951c6a6d02335d4532e", streamId: 94n, to: "0x00000000000000000000000000000000000000b0", vestedToRecipient: vested, id: 12n }, 27, `0x${"11".repeat(32)}`, `0x${"22".repeat(32)}`] }]);
  });
});

/** Runs fake timers forward until `promise` settles. */
async function settle<T>(promise: Promise<T>, steps = 60): Promise<T> {
  let done = false;
  const tracked = promise.finally(() => {
    done = true;
  });
  tracked.catch(() => undefined);
  for (let i = 0; i < steps && !done; i += 1) await vi.advanceTimersByTimeAsync(2_000);
  return tracked;
}

describe("Solana durable-nonce broadcast", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("sends without preflight and returns only once the transaction and the advanced nonce are finalized", async () => {
    const chain = new FakeSolana();
    const payout = solTransferPayout();
    const signature = solPayoutSignature(payout)!;
    chain.setAccount(NONCE_ACCOUNT, nonceAccountData(SIGNED_NONCE));
    chain.onSend = () => {
      chain.statuses.set(signature, status("confirmed"));
      chain.setAccount(NONCE_ACCOUNT, nonceAccountData(ADVANCED_NONCE), "confirmed");
    };
    const progress: string[] = [];
    const result = settle(
      broadcastDurableNonceTransaction(chain.connection(), payout, {
        onProgress: (text) => {
          progress.push(text);
          if (progress.length === 3) {
            chain.statuses.set(signature, status("finalized"));
            chain.setAccount(NONCE_ACCOUNT, nonceAccountData(ADVANCED_NONCE), "finalized");
          }
        },
      }),
    );
    await expect(result).resolves.toEqual({ signature, failedOnChain: false });
    expect(chain.sent).toEqual([{ skipPreflight: true }]);
    expect(progress.filter((text) => text.includes("Landed (confirmed)"))).toHaveLength(2);
  });

  it("lands a failing transaction too: it advances the nonce, and the result says it failed on chain", async () => {
    const chain = new FakeSolana();
    const payout = solTransferPayout();
    const signature = solPayoutSignature(payout)!;
    chain.setAccount(NONCE_ACCOUNT, nonceAccountData(SIGNED_NONCE));
    chain.onSend = () => {
      chain.statuses.set(signature, status("finalized", { InstructionError: [1, { Custom: 115 }] }));
      chain.setAccount(NONCE_ACCOUNT, nonceAccountData(ADVANCED_NONCE));
    };
    await expect(settle(broadcastDurableNonceTransaction(chain.connection(), payout))).resolves.toEqual({ signature, failedOnChain: true });
  });

  it("re-broadcasts a dropped transaction every 10 s and never sends one whose nonce already advanced", async () => {
    const chain = new FakeSolana();
    const payout = solTransferPayout();
    chain.setAccount(NONCE_ACCOUNT, nonceAccountData(SIGNED_NONCE));
    chain.onSend = () => {
      if (chain.sent.length === 2) chain.setAccount(NONCE_ACCOUNT, nonceAccountData(ADVANCED_NONCE));
    };
    await settle(broadcastDurableNonceTransaction(chain.connection(), payout));
    expect(chain.sent).toHaveLength(2);
    const already = new FakeSolana();
    already.setAccount(NONCE_ACCOUNT, nonceAccountData(ADVANCED_NONCE));
    await settle(broadcastDurableNonceTransaction(already.connection(), payout));
    expect(already.sent).toEqual([]);
  });

  it("waits for the finalized nonce before a confirmation and anchors on a successful finalized transaction", async () => {
    const chain = new FakeSolana();
    const payout = solTransferPayout();
    const own = solPayoutSignature(payout)!;
    chain.setAccount(NONCE_ACCOUNT, nonceAccountData(ADVANCED_NONCE), "confirmed");
    chain.setAccount(NONCE_ACCOUNT, nonceAccountData(SIGNED_NONCE), "finalized");
    const polls: string[] = [];
    const waiting = settle(
      waitForFinalizedNonce(chain.connection(), NONCE_ACCOUNT.toBase58(), SIGNED_NONCE, {
        onProgress: (text) => {
          polls.push(text);
          if (polls.length === 2) chain.setAccount(NONCE_ACCOUNT, nonceAccountData(ADVANCED_NONCE), "finalized");
        },
      }),
    );
    await expect(waiting).resolves.toBeUndefined();
    expect(polls).toHaveLength(2);
    chain.statuses.set(own, status("finalized"));
    await expect(confirmationAnchor(chain.connection(), payout)).resolves.toBe(own);
    chain.statuses.set(own, status("finalized", { InstructionError: [1, { Custom: 1 }] }));
    chain.history.set(NONCE_ACCOUNT.toBase58(), [
      { signature: own, err: { InstructionError: [1, { Custom: 1 }] } },
      { signature: "earlierSuccess", err: null },
    ]);
    await expect(confirmationAnchor(chain.connection(), payout)).resolves.toBe("earlierSuccess");
  });

  it("pages back to the newest successful signature of an address", async () => {
    const chain = new FakeSolana();
    const failed = Array.from({ length: 60 }, (_, index) => ({ signature: `failed${String(index)}`, err: { InstructionError: [0, "x"] } }));
    chain.history.set(NONCE_ACCOUNT.toBase58(), [...failed, { signature: "ok", err: null }]);
    await expect(latestSuccessfulSignature(chain.connection(), NONCE_ACCOUNT)).resolves.toBe("ok");
    chain.history.set(NONCE_ACCOUNT.toBase58(), failed);
    await expect(latestSuccessfulSignature(chain.connection(), NONCE_ACCOUNT)).resolves.toBeNull();
  });
});

describe("Solana blockhash actions (deposit moves, returns)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("reads executed, failed, expired and pending from the chain", async () => {
    const blockhash = Keypair.generate().publicKey.toBase58();
    const { payout, signature } = moveSignature(blockhash);
    expect(payoutMessageBlockhash(payout)).toBe(blockhash);
    const chain = new FakeSolana();
    await expect(blockhashActionState(chain.connection(), payout)).resolves.toBe("expired");
    chain.validBlockhashes.add(blockhash);
    await expect(blockhashActionState(chain.connection(), payout)).resolves.toBe("pending");
    chain.statuses.set(signature, status("finalized"));
    await expect(blockhashActionState(chain.connection(), payout)).resolves.toBe("executed");
    chain.statuses.set(signature, status("confirmed", { InstructionError: [1, { Custom: 6 }] }));
    await expect(blockhashActionState(chain.connection(), payout)).resolves.toBe("failed");
  });

  it("never re-sends an executed action and turns an expired one into the retry path", async () => {
    const blockhash = Keypair.generate().publicKey.toBase58();
    const { payout, signature } = moveSignature(blockhash);
    const done = new FakeSolana();
    done.statuses.set(signature, status("finalized"));
    await expect(broadcastBlockhashAction(done.connection(), payout)).resolves.toBe(signature);
    expect(done.sent).toEqual([]);
    const expired = new FakeSolana();
    await expect(broadcastBlockhashAction(expired.connection(), payout)).rejects.toMatchObject({ kind: "expired_blockhash", retryable: true });
    expect(expired.sent).toEqual([]);
    const live = new FakeSolana();
    live.validBlockhashes.add(blockhash);
    live.onSend = () => live.statuses.set(signature, status("finalized"));
    await expect(settle(broadcastBlockhashAction(live.connection(), payout))).resolves.toBe(signature);
    expect(live.sent).toEqual([{ skipPreflight: false }]);
  });
});

describe("payout helpers", () => {
  it("says a refused move debited nothing and a refused claim was refunded", () => {
    expect(new PayoutRefusedError(moveSignature(Keypair.generate().publicKey.toBase58()).payout, "authority signature failed").message).toBe("authority signature failed. Nothing was debited; retry requests a new one.");
    expect(new PayoutRefusedError(solTransferPayout(), "proof failed").message).toBe("proof failed. Your balance was refunded; retry requests a new one.");
  });

  it("derives nonce seeds per engine so one wallet can claim against several engines", async () => {
    const final = payoutSeedSuffixes("GKharZus34WhG182v715Yzf411Akhdnsxxjo5u5C2RRq");
    const staging = payoutSeedSuffixes("6uMy1iYdq9EpL6W3EjsKdUZfrJ5G1shD1Da1QNe8gH7n");
    expect(final).toEqual({ nonce: "GKharZ", receipt: "GKharZr" });
    expect(staging.nonce).not.toBe(final.nonce);
    const seed = await payoutNonceSeed("alice.testnet", final.receipt);
    expect(seed).toBe("9a7068ee6434852cdaff3acbGKharZr");
    expect(seed.length).toBeLessThanOrEqual(32);
  });

  it("knows when the second non-execution proof may be requested", () => {
    expect(secondProofBlock(solTransferPayout())).toBeNull();
    expect(secondProofBlock(solTransferPayout({}, { not_executed_seen_at: "1000" }))).toBe(1150n);
  });

  it("links a payout to its own chain", () => {
    const payout = solTransferPayout();
    expect(payoutExplorerLink(payout, null)).toEqual({ href: `https://explorer.solana.com/tx/${solPayoutSignature(payout)!}?cluster=devnet`, label: "Solana transaction ↗" });
    const base: PayoutView = { ...payout, chain: "Base", kind: { BaseTransfer: { token: "0x1", to: "0x2", amount: "1" } }, status: "Landed", solana: null };
    expect(payoutExplorerLink(base, "0x14c7f1f870ccb5569a01399013ceeeffc465e243")?.href).toBe("https://sepolia.basescan.org/address/0x14c7f1f870ccb5569a01399013ceeeffc465e243#events");
    expect(payoutExplorerLink({ ...base, status: { Failed: { reason: "x" } } }, "0x14c7f1f870ccb5569a01399013ceeeffc465e243")).toBeNull();
  });

  it("stops waiting at once when aborted and leaves no listener behind", async () => {
    const controller = new AbortController();
    const removed = vi.spyOn(controller.signal, "removeEventListener");
    await sleep(1, controller.signal);
    expect(removed).toHaveBeenCalledTimes(1);
    const waiting = sleep(60_000, controller.signal);
    controller.abort();
    await expect(waiting).rejects.toThrow("aborted");
  });
});
