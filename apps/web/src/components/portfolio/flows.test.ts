import type { EngineCalls, EngineViews, FinalExecutionOutcome, FunctionCall, PayoutView, Position } from "@rose/sdk";
import type { PublicClient } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StepContext, StepDefinition } from "@/lib/use-action";
import { ADVANCED_NONCE, FakeSolana, NONCE_ACCOUNT, nonceAccountData, SIGNED_NONCE, solTransferPayout, status } from "@/lib/solana-fake.test-support";
import { solPayoutSignature } from "@/lib/payouts";

const VAULT = "0x14c7f1f870ccb5569a01399013ceeeffc465e243";
const sdk = vi.hoisted(() => ({ withdrawMax: vi.fn(), readStream: vi.fn(), tokenBalance: vi.fn(), calculateMinFeeWei: vi.fn(), isAuthorizationUsed: vi.fn() }));

vi.mock("@/lib/deployment", async (original) => ({ ...(await original<typeof import("@/lib/deployment")>()), deployedAddress: () => VAULT }));
vi.mock("@rose/sdk", async (original) => ({ ...(await original<typeof import("@rose/sdk")>()), ...sdk }));

const { claimBaseTokensSteps, classBaseStreams, confirmPayoutSteps, finishPayoutSteps, withdrawBaseCashSteps } = await import("./flows");
type FlowDeps = Parameters<typeof confirmPayoutSteps>[0];

function context(): StepContext & { details: string[]; links: string[] } {
  const details: string[] = [];
  const links: string[] = [];
  return { details, links, setDetail: (text) => details.push(text), addLinks: (items) => links.push(...items.map((item) => item.href)), signal: new AbortController().signal };
}

function outcome(hash: string, logs: string[] = []): FinalExecutionOutcome {
  return { transaction: { hash }, transaction_outcome: { outcome: { logs, status: { SuccessValue: "" } } }, receipts_outcome: [{ outcome: { logs, status: { SuccessValue: "" } } }], status: { SuccessValue: "" } } as unknown as FinalExecutionOutcome;
}

function position(id: bigint, classId: string, streamId: bigint): Position {
  return { positionId: id, classId, source: { kind: "BaseStream", lockup: "0xa65a1ecef02c2b9bdc604951c6a6d02335d4532e", streamId }, allocation: 1n, depositor: "other.testnet", depositedAt: 0n, state: "Held" } as Position;
}

function deps({ calls, payouts, height, ...overrides }: Omit<Partial<FlowDeps>, "calls"> & { payouts?: () => PayoutView | null; calls?: Partial<EngineCalls>; height?: () => bigint } = {}): FlowDeps & { sent: FunctionCall[] } {
  const sent: FunctionCall[] = [];
  const call = (methodName: string) => () => ({ receiverId: "engine", methodName, args: {}, gas: 1n, deposit: 0n }) as FunctionCall;
  const views = {
    getPayout: () => Promise.resolve(payouts?.() ?? null),
    getPosition: () => Promise.resolve({ source: { kind: "SolanaStream", metadata: NONCE_ACCOUNT.toBase58() } }),
    getPositions: () => Promise.resolve([]),
    getSolStreams: () => Promise.resolve([]),
  } as unknown as EngineViews;
  return {
    account: "a.testnet",
    views,
    calls: { confirmSolPayout: call("confirm_sol_payout"), confirmSolRedeem: call("confirm_sol_redeem"), claimBaseTokens: call("claim_base_tokens"), claimSolTokens: call("claim_sol_tokens"), ...calls } as unknown as EngineCalls,
    sendNearCall: (request) => {
      sent.push(request);
      return Promise.resolve(outcome(`near${String(sent.length)}`));
    },
    getEvmWalletClient: () => Promise.resolve({} as never),
    getSolanaSigner: () => ({}) as never,
    vaultSol: "vault",
    base: { waitForTransactionReceipt: () => Promise.resolve({ status: "success" }) } as unknown as PublicClient,
    solana: new FakeSolana().connection(),
    finalBlockHeight: () => Promise.resolve(height?.() ?? 0n),
    ...overrides,
    sent,
  };
}

async function run(step: StepDefinition, ctx = context()): Promise<{ message?: string; ctx: ReturnType<typeof context> }> {
  let done = false;
  const result = step.run(ctx).finally(() => {
    done = true;
  });
  result.catch(() => undefined);
  for (let i = 0; i < 200 && !done; i += 1) await vi.advanceTimersByTimeAsync(3_000);
  const value = await result;
  return { message: value?.message, ctx };
}

describe("Solana confirmation", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("spends no NEAR gas before the nonce advance is finalized, then confirms a landed payout in one click", async () => {
    const chain = new FakeSolana();
    const payout = solTransferPayout();
    chain.setAccount(NONCE_ACCOUNT, nonceAccountData(SIGNED_NONCE), "finalized");
    chain.setAccount(NONCE_ACCOUNT, nonceAccountData(ADVANCED_NONCE), "confirmed");
    chain.statuses.set(solPayoutSignature(payout)!, status("finalized"));
    let current: PayoutView = payout;
    const flow = deps({ solana: chain.connection(), payouts: () => current });
    setTimeout(() => chain.setAccount(NONCE_ACCOUNT, nonceAccountData(ADVANCED_NONCE), "finalized"), 13_000);
    const sendNearCall = flow.sendNearCall;
    flow.sendNearCall = (request) => {
      expect(chain.accounts.get(NONCE_ACCOUNT.toBase58())?.finalized).toEqual(nonceAccountData(ADVANCED_NONCE));
      current = { ...payout, status: "Landed" };
      return sendNearCall(request);
    };
    const [confirm] = confirmPayoutSteps(flow, payout);
    const { message, ctx } = await run(confirm!);
    expect(message).toBe("Payout #21 confirmed as landed");
    expect(flow.sent.map((request) => request.methodName)).toEqual(["confirm_sol_payout"]);
    expect(ctx.details.some((text) => text.startsWith("Waiting until the nonce advance is finalized"))).toBe(true);
  });

  it("anchors a failed transaction's proof on a successful one, waits 150 blocks with a countdown and sends the second proof", async () => {
    const chain = new FakeSolana();
    const payout = solTransferPayout();
    const own = solPayoutSignature(payout)!;
    chain.setAccount(NONCE_ACCOUNT, nonceAccountData(ADVANCED_NONCE));
    chain.statuses.set(own, status("finalized", { InstructionError: [1, { Custom: 115 }] }));
    chain.history.set(NONCE_ACCOUNT.toBase58(), [
      { signature: own, err: { InstructionError: [1, { Custom: 115 }] } },
      { signature: "nonceCreation", err: null },
    ]);
    const anchors: string[] = [];
    let current: PayoutView = payout;
    let height = 5_000n;
    const flow = deps({
      solana: chain.connection(),
      payouts: () => current,
      height: () => {
        height += 10n;
        return height;
      },
      calls: {
        confirmSolPayout: (_id: bigint, anchor: string) => {
          anchors.push(anchor);
          current = anchors.length === 1 ? solTransferPayout({}, { not_executed_seen_at: "5005" }) : { ...payout, status: { Failed: { reason: "the payout transaction did not execute" } } };
          return { receiverId: "engine", methodName: "confirm_sol_payout", args: {}, gas: 1n, deposit: 0n } as FunctionCall;
        },
      } as Partial<EngineCalls>,
    });
    const [confirm] = confirmPayoutSteps(flow, payout);
    const ctx = context();
    await expect(run(confirm!, ctx)).rejects.toMatchObject({ title: "Did not execute on Solana", message: expect.stringContaining("refunded the claim") });
    expect(anchors).toEqual(["nonceCreation", "nonceCreation"]);
    expect(height).toBeGreaterThanOrEqual(5_155n);
    expect(ctx.details.some((text) => text.includes("second proof requested at least 150 blocks later") && text.includes("blocks left"))).toBe(true);
  });

  it("broadcasts a stored payout without preflight, then confirms it", async () => {
    const chain = new FakeSolana();
    const payout = solTransferPayout();
    const signature = solPayoutSignature(payout)!;
    chain.setAccount(NONCE_ACCOUNT, nonceAccountData(SIGNED_NONCE));
    chain.onSend = () => {
      chain.statuses.set(signature, status("finalized"));
      chain.setAccount(NONCE_ACCOUNT, nonceAccountData(ADVANCED_NONCE));
    };
    let current: PayoutView = payout;
    const flow = deps({ solana: chain.connection(), payouts: () => current });
    const sendNearCall = flow.sendNearCall;
    flow.sendNearCall = (request) => {
      current = { ...payout, status: "Landed" };
      return sendNearCall(request);
    };
    const [broadcast, confirm] = finishPayoutSteps(flow, payout);
    expect((await run(broadcast!)).message).toBe("Landed and finalized on Solana devnet; the nonce advanced");
    expect(chain.sent).toEqual([{ skipPreflight: true }]);
    expect((await run(confirm!)).message).toBe("Payout #21 confirmed as landed");
  });
});

describe("claims", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    Object.values(sdk).forEach((mock) => mock.mockReset());
  });

  it("fills RoseVault from every held stream of the class, for a claimant who holds none of it, forwarding Sablier's fee", async () => {
    const classId = "c".repeat(64);
    const flow = deps();
    flow.views.getPositions = vi.fn((from?: bigint) => Promise.resolve(from === 0n ? [position(1n, classId, 82n), position(2n, "d".repeat(64), 83n), position(3n, classId, 84n)] : [])) as never;
    let vaultBalance = 0n;
    sdk.tokenBalance.mockImplementation(() => Promise.resolve(vaultBalance));
    sdk.readStream.mockImplementation((_client: unknown, streamId: bigint) => Promise.resolve({ withdrawable: streamId === 82n ? 0n : 5n }));
    sdk.calculateMinFeeWei.mockResolvedValue(7n);
    sdk.withdrawMax.mockImplementation(() => {
      vaultBalance = 5n;
      return Promise.resolve("0xwithdraw");
    });
    expect(await classBaseStreams(flow.views, classId)).toHaveLength(2);
    const [withdraw] = claimBaseTokensSteps(flow, { kind: "lienShare", lienId: 9n, classId, amount: 5n, label: "Lien #9 share" }, "0xtoken", 0, "0xto");
    const { message } = await run(withdraw!);
    expect(message).toBe("RoseVault holds 5");
    expect(sdk.withdrawMax).toHaveBeenCalledTimes(1);
    expect(sdk.withdrawMax.mock.calls[0]!.slice(1)).toEqual([84n, VAULT, { lockup: "0xa65a1ecef02c2b9bdc604951c6a6d02335d4532e", value: 7n }]);
  });

  it("does not submit an authorization RoseVault already executed", async () => {
    const payoutLog = `EVENT_JSON:${JSON.stringify({ standard: "rose", version: "1.0.0", event: "payout_requested", data: { payout_id: "12" } })}`;
    const flow = deps({ payouts: () => ({ ...solTransferPayout(), status: "Signed" }) });
    flow.sendNearCall = () => Promise.resolve(outcome("near1", [payoutLog]));
    sdk.tokenBalance.mockResolvedValue(10n);
    sdk.isAuthorizationUsed.mockResolvedValue(true);
    const steps = claimBaseTokensSteps(flow, { kind: "holding", classId: "c".repeat(64), amount: 5n, label: "Units" }, "0xtoken", 0, "0xto");
    for (const step of steps.slice(0, 2)) await run(step);
    const submit = steps.find((step) => step.id === "submit")!;
    expect((await run(submit)).message).toBe("Authorization #12 already executed on Base");
  });

  it("requests a new payout after the engine refunded the first one, instead of polling the failed one forever", async () => {
    const requests: string[] = [];
    let latest: PayoutView | null = null;
    const flow = deps({ payouts: () => latest, calls: { withdrawBaseCash: () => ({ receiverId: "engine", methodName: "withdraw_base_cash", args: {}, gas: 1n, deposit: 0n }) as FunctionCall } as Partial<EngineCalls> });
    flow.sendNearCall = (request) => {
      const id = String(requests.length + 30);
      requests.push(request.methodName);
      latest = { ...solTransferPayout({ id, chain: "Base" }), status: requests.length === 1 ? { Failed: { reason: "the authority signature failed" } } : "Signed" };
      return Promise.resolve(outcome(`near${id}`, [`EVENT_JSON:${JSON.stringify({ standard: "rose", version: "1.0.0", event: "payout_requested", data: { payout_id: id } })}`]));
    };
    const [request, sign] = withdrawBaseCashSteps(flow, "0xtoken", 5n, "0xto");
    await run(request!);
    await expect(run(sign!)).rejects.toMatchObject({ message: "the authority signature failed. Your balance was refunded; retry requests a new one.", retryable: true });
    expect((await run(sign!)).message).toBe("Payout #31 signed by the MPC");
    expect(requests).toEqual(["withdraw_base_cash", "withdraw_base_cash"]);
  });
});
