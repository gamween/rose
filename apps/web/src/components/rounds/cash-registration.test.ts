import type { FinalExecutionOutcome, RefusedDepositView, ReplayKey, ReplayStateView } from "@rose/sdk";
import { describe, expect, it, vi } from "vitest";
import { RoseActionError } from "@/lib/errors";
import { registerCashDeposit, type SendRegistration } from "./cash-registration";

const KEY: ReplayKey = { BaseLog: { tx_hash: "ab".repeat(32), log_index: 3 } };

function outcome(value: unknown): FinalExecutionOutcome {
  return { status: { SuccessValue: Buffer.from(JSON.stringify(value)).toString("base64") }, transaction: { hash: "H" }, transaction_outcome: {}, receipts_outcome: [] } as unknown as FinalExecutionOutcome;
}

/** A fake engine whose replay key goes through `states` (one per `get_replay`), with an optional refusal. */
function engine(states: (ReplayStateView | null)[], refused: RefusedDepositView | null = null) {
  const queue = [...states];
  const getReplay = vi.fn(async () => (queue.length > 1 ? queue.shift() : queue[0]) ?? null);
  const getRefusedDeposit = vi.fn(async () => refused);
  return { views: { raw: { getReplay, getRefusedDeposit } } as never, getReplay };
}

const fast = { sleep: async () => undefined };

describe("register_base_cash from the order form", () => {
  it("credits only once the engine consumed the log", async () => {
    const send = vi.fn<SendRegistration>(async () => ({ ok: true, outcome: outcome(true), hash: "H" }));
    const fake = engine([null, "Consumed"]);
    await expect(registerCashDeposit(fake.views, KEY, send, fast)).resolves.toEqual({ hash: "H" });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("reports a failed MPC verification when the callback returned false, retryable without a new deposit", async () => {
    const send = vi.fn<SendRegistration>(async () => ({ ok: true, outcome: outcome(false), hash: "H" }));
    const error = await registerCashDeposit(engine([null]).views, KEY, send, fast).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RoseActionError);
    expect(error).toMatchObject({ kind: "mpc_timeout", retryable: true });
    expect((error as Error).message).toContain("nothing was credited");
    expect((error as Error).message).toContain("not sent again");
  });

  it("names the engine's refusal instead of a timeout", async () => {
    const send = vi.fn<SendRegistration>(async () => ({ ok: true, outcome: outcome(false), hash: "H" }));
    const refused = { reason: "amount is zero" } as RefusedDepositView;
    await expect(registerCashDeposit(engine([null, "Consumed"], refused).views, KEY, send, fast)).rejects.toMatchObject({ kind: "contract", title: "Deposit refused by the engine" });
  });

  it("retrying a log the engine already consumed sends nothing", async () => {
    const send = vi.fn<SendRegistration>();
    await expect(registerCashDeposit(engine(["Consumed"]).views, KEY, send, fast)).resolves.toEqual({ hash: null });
    expect(send).not.toHaveBeenCalled();
  });

  it("waits for a verification already in flight, then fails when the pending key is cleared", async () => {
    const send = vi.fn<SendRegistration>();
    const pending: ReplayStateView = { Pending: { since_block: 1 } };
    await expect(registerCashDeposit(engine([pending, pending, "Consumed"]).views, KEY, send, fast)).resolves.toEqual({ hash: null });
    await expect(registerCashDeposit(engine([pending, null]).views, KEY, send, fast)).rejects.toMatchObject({ kind: "mpc_timeout", retryable: true });
    expect(send).not.toHaveBeenCalled();
  });

  it("gives up after 150 s of a pending verification with a retryable timeout", async () => {
    let clock = 0;
    const pending: ReplayStateView = { Pending: { since_block: 1 } };
    const options = { sleep: async () => void (clock += 3_000), now: () => clock };
    await expect(registerCashDeposit(engine([pending]).views, KEY, vi.fn<SendRegistration>(), options)).rejects.toMatchObject({ kind: "mpc_timeout" });
  });

  it("passes a wallet rejection through", async () => {
    const send = vi.fn<SendRegistration>(async () => ({ ok: false, error: { kind: "rejected", title: "Rejected in the wallet", message: "Nothing was sent.", retryable: true } }));
    await expect(registerCashDeposit(engine([null]).views, KEY, send, fast)).rejects.toMatchObject({ kind: "rejected" });
  });
});
