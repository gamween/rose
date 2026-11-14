import type { EngineCalls, EngineViews, FinalExecutionOutcome, FunctionCall, PayoutView, Position } from "@rose/sdk";
import type { PublicClient } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StepContext, StepDefinition } from "@/lib/use-action";
import { Keypair, type PublicKey } from "@solana/web3.js";
import { ADVANCED_NONCE, FakeSolana, NONCE_ACCOUNT, nonceAccountData, SIGNED_NONCE, solTransferPayout, status, VAULT as SOL_VAULT } from "@/lib/solana-fake.test-support";
import { solPayoutSignature } from "@/lib/payouts";

const VAULT = "0x14c7f1f870ccb5569a01399013ceeeffc465e243";
const sdk = vi.hoisted(() => ({ withdrawMax: vi.fn(), readStream: vi.fn(), tokenBalance: vi.fn(), calculateMinFeeWei: vi.fn(), isAuthorizationUsed: vi.fn() }));

vi.mock("@/lib/deployment", async (original) => ({ ...(await original<typeof import("@/lib/deployment")>()), deployedAddress: () => VAULT }));
vi.mock("@rose/sdk", async (original) => ({ ...(await original<typeof import("@rose/sdk")>()), ...sdk }));

const { claimBaseTokensSteps, claimSolTokensSteps, classBaseStreams, confirmPayoutSteps, finishPayoutSteps, redeemSteps, syncSolStreamSteps, withdrawBaseCashSteps, withdrawNearCashSteps } = await import("./flows");
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
    getSolSwept: () => Promise.resolve({ balance: 0n, pending: 0n, available: 0n }),
  } as unknown as EngineViews;
  return {
    account: "a.testnet",
    views,
    calls: { confirmSolPayout: call("confirm_sol_payout"), confirmSolRedeem: call("confirm_sol_redeem"), claimBaseTokens: call("claim_base_tokens"), claimSolTokens: call("claim_sol_tokens"), syncSolStream: call("sync_sol_stream"), ...calls } as unknown as EngineCalls,
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

  it("waits for a lagging view to show the signed transaction instead of failing the broadcast", async () => {
    const chain = new FakeSolana();
    const payout = solTransferPayout();
    const signature = solPayoutSignature(payout)!;
    chain.setAccount(NONCE_ACCOUNT, nonceAccountData(SIGNED_NONCE));
    chain.onSend = () => {
      chain.statuses.set(signature, status("finalized"));
      chain.setAccount(NONCE_ACCOUNT, nonceAccountData(ADVANCED_NONCE));
    };
    let reads = 0;
    const lagging: PayoutView = { ...payout, status: "Requested", solana: { ...payout.solana!, transaction: null } };
    const flow = deps({ solana: chain.connection(), payouts: () => (++reads < 3 ? lagging : payout) });
    const [broadcast] = finishPayoutSteps(flow, payout);
    const { message, ctx } = await run(broadcast!);
    expect(message).toBe("Landed and finalized on Solana devnet; the nonce advanced");
    expect(ctx.details.some((text) => text.startsWith("Waiting for the RPC to show the signed payout"))).toBe(true);
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

  it("keeps the NEAR explorer link of a tUSDC withdrawal the token refused", async () => {
    const flow = deps({ calls: { withdrawNearCash: () => ({ receiverId: "engine", methodName: "withdraw_near_cash", args: {}, gas: 1n, deposit: 0n }) as FunctionCall } as Partial<EngineCalls> });
    flow.sendNearCall = () => Promise.resolve(outcome("nearRefused", [`EVENT_JSON:${JSON.stringify({ standard: "rose", version: "1.0.0", event: "cash_withdrawal_failed", data: {} })}`]));
    const [withdraw] = withdrawNearCashSteps(flow, 5n);
    const step = context();
    await expect(withdraw!.run(step)).rejects.toMatchObject({ title: "tUSDC transfer refused", retryable: true });
    expect(step.links).toEqual(["https://testnet.near.rocks/tx/nearRefused", "https://nearvalidate.org/txns/nearRefused?network=testnet"]);
  });
});

/** 1,104 metadata bytes of a stream paying `recipient` with `withdrawn` base units withdrawn so far, its `automatic_withdrawal` flag (459) set when `automatic`. */
function metadataBytes(recipient: PublicKey, withdrawn: bigint, automatic = false): Buffer {
  const data = Buffer.alloc(1104);
  data.writeBigUInt64LE(withdrawn, 17);
  recipient.toBuffer().copy(data, 113);
  data[459] = automatic ? 1 : 0;
  return data;
}

const sweptLog = (amount: string) => `EVENT_JSON:${JSON.stringify({ standard: "rose", version: "1.0.0", event: "sol_stream_swept", data: { position_id: "4", class_id: "c".repeat(64), amount } })}`;

describe("ended Solana streams", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  const metadata = Keypair.generate().publicKey;
  const entry = { position_id: "4", withdrawable: "0", redeem_claimable: "0", stream: { metadata: metadata.toBase58(), engine_withdrawn: "400", net_amount_deposited: "1000", end_time: 1 } } as never;

  function chainWithAutoClaim(withdrawn: bigint): FakeSolana {
    const chain = new FakeSolana();
    chain.setAccount(metadata, metadataBytes(SOL_VAULT, withdrawn));
    chain.history.set(metadata.toBase58(), [{ signature: "autoClaim", err: null }]);
    return chain;
  }

  it("reads the auto-claim at finality, anchors on it and books it with sync_sol_stream", async () => {
    const flow = deps({ solana: chainWithAutoClaim(1000n).connection(), vaultSol: SOL_VAULT.toBase58() });
    flow.sendNearCall = (request) => {
      flow.sent.push(request);
      return Promise.resolve(outcome("nearSync", [sweptLog("600")]));
    };
    const [read, sync] = syncSolStreamSteps(flow, entry, 0);
    const first = await run(read!);
    expect(first.message).toBe("600 withdrawn into the vault, not booked yet");
    expect(first.ctx.links).toEqual(["https://explorer.solana.com/tx/autoClaim?cluster=devnet"]);
    const second = await run(sync!);
    expect(second.message).toBe("600 booked in the swept balance; claims pay from it");
    expect(flow.sent.map((request) => request.methodName)).toEqual(["sync_sol_stream"]);
    expect(second.ctx.links[0]).toContain("nearSync");
  });

  it("refuses before any NEAR call when the auto-claim has not run or the stream left the vault", async () => {
    const early = deps({ solana: chainWithAutoClaim(400n).connection(), vaultSol: SOL_VAULT.toBase58() });
    await expect(run(syncSolStreamSteps(early, entry, 0)[0]!)).rejects.toMatchObject({ title: "Nothing to sync yet", retryable: true });
    const moved = deps({ solana: chainWithAutoClaim(1000n).connection(), vaultSol: Keypair.generate().publicKey.toBase58() });
    await expect(run(syncSolStreamSteps(moved, entry, 0)[0]!)).rejects.toMatchObject({ title: "Not at the vault" });
    expect([...early.sent, ...moved.sent]).toEqual([]);
  });

  it("reports a proof the engine did not book, and reads the stream again on retry", async () => {
    const flow = deps({ solana: chainWithAutoClaim(1000n).connection(), vaultSol: SOL_VAULT.toBase58() });
    let calls = 0;
    flow.sendNearCall = () => {
      calls += 1;
      return Promise.resolve(outcome(`near${String(calls)}`, calls === 1 ? [] : [sweptLog("600")]));
    };
    const [read, sync] = syncSolStreamSteps(flow, entry, 0);
    await run(read!);
    await expect(run(sync!)).rejects.toMatchObject({ title: "Proof not accepted", retryable: true });
    const retry = await run(sync!);
    expect(retry.message).toBe("600 booked in the swept balance; claims pay from it");
    expect(retry.ctx.details).toContain("Reading the stream again at finality…");
  });

  it("reads the stream again after the engine refused the sync call, instead of resending the same proof", async () => {
    const flow = deps({ solana: chainWithAutoClaim(1000n).connection(), vaultSol: SOL_VAULT.toBase58() });
    let calls = 0;
    flow.sendNearCall = () => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error("Smart contract panicked: A payout drawing on this stream is not confirmed yet")) : Promise.resolve(outcome("near2", [sweptLog("600")]));
    };
    const [read, sync] = syncSolStreamSteps(flow, entry, 0);
    await run(read!);
    await expect(run(sync!)).rejects.toThrow("not confirmed yet");
    const retry = await run(sync!);
    expect(retry.ctx.details).toContain("Reading the stream again at finality…");
    expect(retry.message).toBe("600 booked in the swept balance; claims pay from it");
  });

  it("plans a claim from the swept balance first, with no stream drawn when it covers the claim", async () => {
    const flow = deps();
    flow.views.getSolSwept = () => Promise.resolve({ balance: 9n, pending: 2n, available: 7n });
    flow.views.getSolStreams = () => Promise.resolve([{ position_id: "5", withdrawable: "50", redeem_claimable: "0", stream: { net_amount_deposited: "100", engine_withdrawn: "0" } }] as never);
    const source = { kind: "holding" as const, classId: "c".repeat(64), amount: 7n, label: "Units" };
    const plan = claimSolTokensSteps(flow, source, "mint", 0, "owner").find((step) => step.id === "draws")!;
    expect((await run(plan)).message).toBe("7 from the swept balance (ended streams, synced)");
    const mixed = claimSolTokensSteps(flow, { ...source, amount: 20n }, "mint", 0, "owner").find((step) => step.id === "draws")!;
    expect((await run(mixed)).message).toBe("1 stream drawn on + 7 from the swept balance (ended streams, synced)");
  });

  it("draws on no stream that withdrew beyond the engine's accounting until a sync books it", async () => {
    const swept = Keypair.generate().publicKey;
    const clean = Keypair.generate().publicKey;
    const chain = new FakeSolana();
    chain.setAccount(swept, metadataBytes(SOL_VAULT, 30n, true));
    chain.setAccount(clean, metadataBytes(SOL_VAULT, 0n, true));
    const flow = deps({ solana: chain.connection() });
    flow.views.getSolSwept = () => Promise.resolve({ balance: 0n, pending: 0n, available: 0n });
    flow.views.getSolStreams = () =>
      Promise.resolve([
        { position_id: "5", withdrawable: "80", redeem_claimable: "0", stream: { metadata: swept.toBase58(), net_amount_deposited: "100", engine_withdrawn: "0" } },
        { position_id: "6", withdrawable: "40", redeem_claimable: "0", stream: { metadata: clean.toBase58(), net_amount_deposited: "100", engine_withdrawn: "0" } },
      ] as never);
    const source = { kind: "holding" as const, classId: "c".repeat(64), amount: 20n, label: "Units" };
    const plan = claimSolTokensSteps(flow, source, "mint", 0, "owner").find((step) => step.id === "draws")!;
    expect((await run(plan)).message).toBe("1 stream drawn on");
    await expect(run(claimSolTokensSteps(flow, { ...source, amount: 50n }, "mint", 0, "owner").find((step) => step.id === "draws")!)).rejects.toMatchObject({ title: "Not payable yet" });
  });
});

describe("Solana redeem in kind", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  const metadata = Keypair.generate().publicKey;
  const solPosition = { positionId: 4n, classId: "c".repeat(64), source: { kind: "SolanaStream", metadata: metadata.toBase58() }, allocation: 1000n, depositor: "a.testnet", depositedAt: 0n, state: "Held" } as Position;

  function redeemFlow(chain: FakeSolana, engineWithdrawn: () => string, drawing: string | null = null) {
    const flow = deps({ solana: chain.connection(), vaultSol: SOL_VAULT.toBase58(), calls: { redeem: () => ({ receiverId: "engine", methodName: "redeem", args: {}, gas: 1n, deposit: 0n }) as FunctionCall } as Partial<EngineCalls> });
    flow.views.getSolStreams = () => Promise.resolve([{ position_id: "4", withdrawable: "100", redeem_claimable: "50", stream: { metadata: metadata.toBase58(), engine_withdrawn: engineWithdrawn(), net_amount_deposited: "1000", end_time: 4_000_000_000, drawing } }] as never);
    flow.sendNearCall = (request) => {
      flow.sent.push(request);
      return Promise.resolve(outcome(`near${String(flow.sent.length)}`, request.methodName === "sync_sol_stream" ? [sweptLog("300")] : []));
    };
    const steps = redeemSteps(flow, solPosition, "owner", "mint", 0);
    const step = (id: string) => steps.find((candidate) => candidate.id === id)!;
    return { flow, steps, step };
  }

  function chainWith(withdrawn: bigint, automatic = false): FakeSolana {
    const chain = new FakeSolana();
    chain.setAccount(metadata, metadataBytes(SOL_VAULT, withdrawn, automatic));
    chain.history.set(metadata.toBase58(), [{ signature: "sweep", err: null }]);
    return chain;
  }

  it("checks the stream at finality before the nonce and again before the request", () => {
    const { steps } = redeemFlow(chainWith(200n), () => "200");
    expect(steps.map((step) => step.id)).toEqual(["check", "nonce", "recheck", "request", "sign", "broadcast", "confirm"]);
  });

  it("goes ahead with no NEAR call when the engine's accounting matches the stream", async () => {
    const { flow, step } = redeemFlow(chainWith(200n), () => "200");
    expect((await run(step("check"))).message).toBe("No automatic withdrawal and nothing withdrawn outside the engine's accounting");
    expect(flow.sent).toEqual([]);
  });

  it("refuses a stream whose sender switched automatic withdrawal on, before any NEAR call", async () => {
    const { flow, step } = redeemFlow(chainWith(200n, true), () => "200");
    await expect(run(step("check"))).rejects.toMatchObject({ title: "Redeem in kind refused", retryable: false });
    expect(flow.sent).toEqual([]);
  });

  it("syncs what the stream withdrew beyond the engine's accounting first, once, even when the engine view lags", async () => {
    const { flow, step } = redeemFlow(chainWith(500n), () => "200");
    const checked = await run(step("check"));
    expect(checked.message).toBe("300 withdrawn outside the engine's accounting, synced to the swept balance first");
    expect(checked.ctx.links).toEqual(["https://explorer.solana.com/tx/sweep?cluster=devnet", "https://testnet.near.rocks/tx/near1", "https://nearvalidate.org/txns/near1?network=testnet"]);
    expect((await run(step("recheck"))).message).toBe("No automatic withdrawal and nothing withdrawn outside the engine's accounting");
    expect(flow.sent.map((request) => request.methodName)).toEqual(["sync_sol_stream"]);
  });

  it("refuses right before the request when the sender switched automatic withdrawal on after the first check", async () => {
    const chain = chainWith(200n);
    const { flow, step } = redeemFlow(chain, () => "200");
    await run(step("check"));
    chain.setAccount(metadata, metadataBytes(SOL_VAULT, 200n, true));
    await expect(run(step("recheck"))).rejects.toMatchObject({ title: "Redeem in kind refused" });
    expect(flow.sent).toEqual([]);
  });

  it("fails closed, and retryably, on an unreadable or lagging read and on an unconfirmed payout", async () => {
    await expect(run(redeemFlow(new FakeSolana(), () => "200").step("check"))).rejects.toMatchObject({ title: "Stream unreadable", retryable: true });
    await expect(run(redeemFlow(chainWith(100n), () => "200").step("check"))).rejects.toMatchObject({ title: "Stale read", retryable: true });
    await expect(run(redeemFlow(chainWith(500n), () => "200", "15").step("check"))).rejects.toMatchObject({ title: "Payout unconfirmed", retryable: true });
  });
});
