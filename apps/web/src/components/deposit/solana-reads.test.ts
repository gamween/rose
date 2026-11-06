import type { EngineViews, ReplayStateView, SolDepositView } from "@rose/sdk";
import { Keypair, type Connection } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitForReplay } from "./base-reads";
import { pendingStatus, readSolanaStreamRow, streamLocation, waitForStage } from "./solana-reads";

const MINT = Keypair.generate().publicKey;
vi.mock("@rose/sdk", async (original) => ({ ...(await original<typeof import("@rose/sdk")>()), readStreamflowStream: () => Promise.resolve({ metadata: { mint: MINT }, raw: new Uint8Array(), slot: 1 }) }));

describe("resuming a Solana deposit", () => {
  it("fails with a retryable error when the mint read misses, instead of doing nothing", async () => {
    const connection = { getAccountInfo: () => Promise.resolve(null) } as unknown as Connection;
    await expect(readSolanaStreamRow(connection, Keypair.generate().publicKey, "c".repeat(64))).rejects.toMatchObject({ kind: "rpc", title: "Could not read the mint", retryable: true });
  });
  it("returns the row with its mint bytes when the mint reads", async () => {
    const data = new Uint8Array(82);
    data[44] = 9;
    const connection = { getAccountInfo: () => Promise.resolve({ owner: Keypair.generate().publicKey, data }) } as unknown as Connection;
    const row = await readSolanaStreamRow(connection, Keypair.generate().publicKey, "c".repeat(64));
    expect(row.mint.decimals).toBe(9);
  });
});

function views(deposits: (SolDepositView | null)[], replays: (ReplayStateView | null)[] = []): EngineViews {
  let deposit = 0;
  let replay = 0;
  return {
    raw: {
      getSolDeposit: () => Promise.resolve(deposits[Math.min(deposit++, deposits.length - 1)] ?? null),
      getReplay: () => Promise.resolve(replays[Math.min(replay++, replays.length - 1)] ?? null),
    },
  } as unknown as EngineViews;
}

const attributed = { stage: "Attributed" } as SolDepositView;

describe("interrupted Solana deposits", () => {
  it("knows where the stream sits and what comes next", () => {
    expect(streamLocation("w", "w", "d", "v")).toBe("wallet");
    expect(streamLocation("v", "w", "d", "v")).toBe("vault");
    expect(streamLocation("d", "w", "d", "v")).toBe("deposit_address");
    expect(streamLocation("x", "w", "d", "v")).toBe("elsewhere");
    expect(pendingStatus(null, "deposit_address")).toBe("At your deposit address, not attributed yet: attribution is next.");
    expect(pendingStatus(null, "wallet")).toBeNull();
    expect(pendingStatus("Attributed", "deposit_address")).toBe("Attributed to you: the move into the vault is next.");
    expect(pendingStatus("MoveSigned", "deposit_address")).toBe("Attributed, and the engine signed the move into the vault: the broadcast is next.");
    expect(pendingStatus("MoveSigned", "vault")).toBe("In the engine's vault: the registration (MPC proof) is next.");
    expect(pendingStatus("Registered", "vault")).toBeNull();
    expect(pendingStatus("Refused", "deposit_address")).toBeNull();
  });
});

describe("proof polls after this tab's own call", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** Settles `promise` within one poll interval of fake time: the answer comes after one re-poll, never after the 2.5-minute wait. */
  async function withinOnePoll<T>(promise: Promise<T>): Promise<T> {
    promise.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(3_000);
    return promise;
  }

  it("fails at once when the attribution left no record (the callback already ran)", async () => {
    await expect(withinOnePoll(waitForStage(views([null]), "m", ["Attributed", "MoveSigned", "Registered"], { sentNow: true }))).rejects.toMatchObject({ title: "Attribution proof did not match", retryable: true });
    await expect(withinOnePoll(waitForStage(views([attributed]), "m", ["Registered"], { sentNow: true }))).rejects.toMatchObject({ title: "Registration proof did not match" });
    await expect(withinOnePoll(waitForStage(views([attributed]), "m", ["Attributed"], { sentNow: true }))).resolves.toBe(attributed);
  });

  it("reports a cleared Base replay key at once instead of waiting 2.5 minutes", async () => {
    await expect(withinOnePoll(waitForReplay(views([], [null]), { BaseLog: { tx_hash: "ab", log_index: 1 } }, { sentNow: true }))).resolves.toBe("cleared");
    await expect(withinOnePoll(waitForReplay(views([], ["Consumed"]), { BaseLog: { tx_hash: "ab", log_index: 1 } }, { sentNow: true }))).resolves.toBe("consumed");
  });
});
