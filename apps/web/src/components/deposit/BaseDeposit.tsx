"use client";

import {
  approvedFor,
  approveStream,
  decodePositionMinted,
  decodeStreamDeposited,
  depositStream,
  DemoClass,
  erc20Abi,
  mintDemoPosition,
  registerBaseDepositArgs,
  sablierLockupExtrasAbi,
  waitForSafeHead,
  type StreamDepositedLog,
} from "@rose/sdk";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Address } from "viem";
import { LearnMore } from "@/components/chrome/LearnMore";
import { Segmented } from "@/components/ui/Segmented";
import { Button } from "@/components/ui/Button";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Disclosure } from "@/components/ui/DetailsList";
import { EmptyState } from "@/components/ui/EmptyState";
import { FlowSteps } from "@/components/ui/FlowSteps";
import { Skeleton } from "@/components/ui/Skeleton";
import { useWallets } from "@/components/wallet/WalletProvider";
import { formatAmount, formatDay, secondsToMs, shortHex } from "@/lib/amounts";
import { requireEngine } from "@/lib/engine-client";
import { deployedAddress, SABLIER_LOCKUP_ADDRESS } from "@/lib/deployment";
import { RoseActionError } from "@/lib/errors";
import { txLinks, type ChainId } from "@/lib/explorer";
import { ROUTES } from "@/lib/routes";
import { useAction, useFlow, type StepDefinition } from "@/lib/use-action";
import { useEngineQuery } from "@/lib/use-engine-query";
import { basePublicClient } from "@/lib/wallet/evm-demo";
import { loadAttempted, recordAttempted, type AttemptedDeposit } from "./attempted";
import { holdingBalance, initialRange, listBaseStreams, waitForReplay, type BaseListing, type BaseStreamRow } from "./base-reads";
import { baseLogReplayKey, remainingToLock } from "./eligibility";
import { Row, StreamItem, WalletPrompt } from "./shared";

/** Extra wei above `calculateMinFeeWei` (0 today, oracle-based, admin-controlled); the vault refunds the unused part. */
const FEE_MARGIN_WEI = 1_000_000_000_000n;

type Context = { log?: StreamDepositedLog; classId?: string; balanceBefore?: bigint };

function StreamRow({ row, symbol, onDeposit, busy, disabledReason }: { row: BaseStreamRow; symbol: string | null; onDeposit: () => void; busy: boolean; disabledReason: string | null }) {
  const stream = row.stream;
  const unit = symbol ?? (stream ? shortHex(stream.token) : "tokens");
  return (
    <StreamItem
      id={row.streamId.toString()}
      title={`Sablier stream #${row.streamId.toString()}`}
      amount={stream ? `${formatAmount(stream.deposited, stream.decimals)} ${unit} · ${formatAmount(remainingToLock(stream), stream.decimals)} still locked` : "Unreadable stream"}
      verdict={row.verdict}
      classId={row.classId}
      classExists={row.classExists}
      onDeposit={onDeposit}
      depositDisabled={!row.verdict.eligible || busy || disabledReason !== null}
      disabledReason={disabledReason}
      details={
        stream ? (
          <>
            <Row label="Schedule" value={`${formatDay(secondsToMs(stream.start))} → ${formatDay(secondsToMs(stream.end))}`} />
            <Row label="Cliff" value={stream.cliff > 0 ? formatDay(secondsToMs(stream.cliff)) : "none"} />
            <Row label="Vested, withdrawable now" value={`${formatAmount(stream.withdrawable, stream.decimals)} ${unit}`} />
            <Row label="Token" value={stream.token} />
          </>
        ) : null
      }
    />
  );
}

/** Base Sepolia side of the wizard: the holder's Sablier streams, eligibility, and the deposit flow of spec 7.1. */
export function BaseDeposit({ nearAccount, onConnect }: { nearAccount: string | null; onConnect: (chain: ChainId) => void }) {
  const wallets = useWallets();
  const address = wallets.evm.address;
  const vault = deployedAddress("roseVault");
  const demoFaucet = deployedAddress("demoStreamFaucet");
  const lockup = SABLIER_LOCKUP_ADDRESS as Address;
  const [older, setOlder] = useState(0n);
  const [selected, setSelected] = useState<{ streamId: bigint; resumed: boolean } | null>(null);
  const [demoClass, setDemoClass] = useState<0 | 1>(DemoClass.SEED);
  const [symbols, setSymbols] = useState<Map<string, string>>(new Map());

  const fetcher = useCallback(
    async (signal: AbortSignal): Promise<BaseListing> => {
      const { views } = requireEngine();
      if (!address) throw new RoseActionError("no_wallet", "No EVM wallet", "Connect a Base Sepolia wallet first.");
      const client = basePublicClient();
      const nextStreamId = await client.readContract({ address: lockup, abi: sablierLockupExtrasAbi, functionName: "nextStreamId" });
      const range = initialRange(nextStreamId);
      const fromId = range.fromId - older > 1n ? range.fromId - older : 1n;
      const rows = await listBaseStreams(client, views, address, lockup, { fromId, toId: range.toId }, signal);
      const tokens = [...new Set(rows.flatMap((row) => (row.stream ? [row.stream.token.toLowerCase()] : [])))];
      const resolved = await Promise.all(tokens.map((token) => client.readContract({ address: token as Address, abi: erc20Abi, functionName: "symbol" }).catch(() => null)));
      setSymbols(new Map(tokens.flatMap((token, index) => (resolved[index] ? [[token, resolved[index]] as const] : []))));
      return { rows, fromId, toId: range.toId, nextStreamId };
    },
    [address, lockup, older],
  );
  const listing = useEngineQuery(fetcher, { enabled: address !== null, pollMs: 60_000 });
  const flow = useFlow({ onComplete: () => void listing.refresh() });
  const demo = useAction({ onSuccess: () => void listing.refresh() });

  const disabledReason = useMemo(() => {
    if (!vault) return "RoseVault is not deployed yet.";
    if (!nearAccount) return "Connect a NEAR wallet: the units are minted to it.";
    if (wallets.near.kind === "demo" && !wallets.near.demoAccountExists) return "Create the NEAR demo account first (Get test funds).";
    return null;
  }, [nearAccount, vault, wallets.near.demoAccountExists, wallets.near.kind]);

  /** Finality, registration and the minted units of a deposited stream (shared by a new deposit and a resumed one). */
  const registrationSteps = (context: Context, streamId: bigint, owner: string): StepDefinition[] => {
    if (!nearAccount) return [];
    return [
      {
        id: "finality",
        label: "Base finality: ~3 min",
        run: async (step) => {
          const log = context.log;
          if (!log) throw new RoseActionError("unknown", "Missing receipt", "The deposit receipt is missing; retry the deposit step.");
          const result = await waitForSafeHead(basePublicClient(), log.blockNumber, {
            signal: step.signal,
            onProgress: (progress) => {
              if (progress.phase === "waiting_safe") step.setDetail(`Safe head ${progress.safeHead.toString()}, waiting for block ${progress.target.toString()} (the safe head moves every 3 to 4 min)…`);
              else if (progress.phase === "margin") step.setDetail(`Safe head ${progress.safeHead.toString()} passed block ${progress.target.toString()}; 30 s margin for the MPC nodes' providers…`);
            },
          });
          return { message: `Block ${log.blockNumber.toString()} is safe (safe head ${result.safeHead.toString()}).` };
        },
      },
      {
        id: "register",
        label: "Register on NEAR: MPC verification (~7 s)",
        run: async (step) => {
          const log = context.log;
          if (!log) throw new RoseActionError("unknown", "Missing receipt", "The deposit receipt is missing; retry the deposit step.");
          const { views, calls } = requireEngine();
          const key = baseLogReplayKey(log);
          recordAttempted({ key, chain: "base", label: `Sablier stream #${streamId.toString()}`, nearAccount, attemptedAt: Date.now(), baseTx: log.transactionHash, streamId: streamId.toString() });
          const args = registerBaseDepositArgs(log);
          context.classId ??= await views.raw.computeBaseClassId(args.fields.token, args.fields.decimals, {
            start: args.fields.start,
            cliff: args.fields.cliff,
            end: args.fields.end,
            granularity: args.fields.granularity,
            deposited: args.fields.deposited,
            start_unlock: args.fields.start_unlock,
            cliff_unlock: args.fields.cliff_unlock,
          });
          context.balanceBefore ??= await holdingBalance(views, nearAccount, context.classId);
          const state = await views.raw.getReplay(key);
          const sentNow = state === null;
          if (sentNow) {
            const registration = await views.registrationDepositFor(nearAccount, context.classId);
            step.setDetail(`Sending register_base_deposit with ${formatAmount(registration, 24, 5)} NEAR of storage for ${nearAccount}…`);
            const outcome = await wallets.sendNearCall(calls.registerBaseDeposit(args.location, { ...args.fields }, registration));
            step.addLinks(txLinks("near", outcome.transaction.hash));
          } else if (state !== "Consumed") {
            step.setDetail("A verification of this log is already in flight; waiting for the MPC callback…");
          }
          const outcome = await waitForReplay(views, key, {
            signal: step.signal,
            sentNow,
            onPoll: (elapsed) => step.setDetail(`MPC nodes verifying the Base log (${String(Math.round(elapsed / 1000))} s; usually 6 to 9 s)…`),
          });
          if (outcome === "cleared") {
            throw new RoseActionError("mpc_timeout", "MPC verification failed", "The MPC request ended without a match (a PromiseError after about 2 min, or a value mismatch). The log can be registered again: retry.", true);
          }
          const refused = await views.raw.getRefusedDeposit(key);
          if (refused) throw new RoseActionError("contract", "Deposit refused by the engine", `${refused.reason}. The stream is held by RoseVault; use "Return my stream" below to get it back.`);
          return { message: "The MPC matched the log and the engine registered the position." };
        },
      },
      {
        id: "minted",
        label: "Units minted",
        run: async () => {
          const { views } = requireEngine();
          const classId = context.classId;
          const log = context.log;
          if (!classId || !log) throw new RoseActionError("unknown", "Missing class", "The class id is missing; retry the registration step.");
          const holding = await views.getHolding(owner, classId);
          const minted = holding.balance - (context.balanceBefore ?? 0n);
          return { message: `${formatAmount(minted, log.args.decimals)} units of class ${shortHex(classId, 8, 6)} minted to ${owner}.` };
        },
      },
    ];
  };

  const startDeposit = (row: BaseStreamRow) => {
    const stream = row.stream;
    if (!stream || !vault || !nearAccount) return;
    setSelected({ streamId: row.streamId, resumed: false });
    const context: Context = {};
    const client = basePublicClient();
    const streamId = stream.streamId;
    void flow.start([
      {
        id: "approve",
        label: `Approve RoseVault for stream #${streamId.toString()}`,
        run: async (step) => {
          const approved = await approvedFor(client, streamId, lockup);
          if (approved.toLowerCase() === vault.toLowerCase()) return { message: "RoseVault is already approved for this stream." };
          step.setDetail("Confirm the approval in your wallet…");
          const wallet = await wallets.getEvmWalletClient();
          const hash = await approveStream(wallet, streamId, vault, lockup);
          step.addLinks(txLinks("base", hash));
          step.setDetail("Waiting for the approval receipt…");
          const receipt = await client.waitForTransactionReceipt({ hash });
          if (receipt.status !== "success") throw new RoseActionError("contract", "Approval reverted", "The approval transaction reverted on Base Sepolia.", true);
          return { message: "RoseVault approved for the stream NFT." };
        },
      },
      {
        id: "deposit",
        label: "Deposit the stream into RoseVault",
        run: async (step) => {
          if (context.log) return { message: `Deposited in block ${context.log.blockNumber.toString()}.` };
          step.setDetail("Reading the Sablier withdrawal fee and simulating the deposit…");
          const wallet = await wallets.getEvmWalletClient();
          const { hash, minFeeWei, value } = await depositStream(wallet, client, { vault, streamId, nearAccount, feeMarginWei: FEE_MARGIN_WEI, lockup });
          step.addLinks(txLinks("base", hash));
          step.setDetail(`Sent with ${formatAmount(value, 18, 6)} ETH (fee ${formatAmount(minFeeWei, 18, 6)} ETH, the rest is refunded). Waiting for the receipt…`);
          const receipt = await client.waitForTransactionReceipt({ hash });
          if (receipt.status !== "success") throw new RoseActionError("contract", "Deposit reverted", "RoseVault refused the deposit on Base Sepolia. The stream stays in your wallet.", true);
          const log = decodeStreamDeposited(receipt).find((entry) => entry.args.streamId === streamId);
          if (!log) throw new RoseActionError("contract", "No StreamDeposited event", "The receipt holds no StreamDeposited log for this stream.");
          context.log = log;
          recordAttempted({ key: baseLogReplayKey(log), chain: "base", label: `Sablier stream #${streamId.toString()}`, nearAccount, attemptedAt: Date.now(), baseTx: hash, streamId: streamId.toString() });
          const vested = log.args.withdrawn - stream.withdrawn;
          return {
            message: `Deposited in block ${log.blockNumber.toString()}${vested > 0n ? `; ${formatAmount(vested, stream.decimals)} already vested tokens were withdrawn to you first` : ""}.`,
          };
        },
      },
      ...registrationSteps(context, streamId, nearAccount),
    ]);
  };

  /** Registers a deposit made earlier in this browser whose registration did not finish (a reload during the finality wait). */
  const resumeRegistration = (attempt: AttemptedDeposit) => {
    if (!attempt.baseTx || !attempt.streamId || !nearAccount) return;
    const streamId = BigInt(attempt.streamId);
    const hash = attempt.baseTx as `0x${string}`;
    setSelected({ streamId, resumed: true });
    const context: Context = {};
    void flow.start([
      {
        id: "deposit",
        label: "Read the deposit receipt",
        run: async (step) => {
          step.addLinks(txLinks("base", hash));
          const receipt = await basePublicClient().getTransactionReceipt({ hash });
          const log = decodeStreamDeposited(receipt).find((entry) => entry.args.streamId === streamId);
          if (!log) throw new RoseActionError("contract", "No StreamDeposited event", "The receipt holds no StreamDeposited log for this stream.");
          context.log = log;
          return { message: `Deposited in block ${log.blockNumber.toString()} for ${log.args.nearAccount}.` };
        },
      },
      ...registrationSteps(context, streamId, attempt.nearAccount),
    ]);
  };

  if (!address) {
    return (
      <WalletPrompt chain="base" onConnect={onConnect}>
        Connect the EVM wallet that owns the Sablier stream (or create the in-app demo wallet and mint a demo position).
      </WalletPrompt>
    );
  }

  const state = listing.state;
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader
          title="Your Sablier v4 streams"
          description={
            <span title={state.status === "ok" ? `Ids ${state.value.fromId.toString()} to ${state.value.toId.toString()} scanned (next id ${state.value.nextStreamId.toString()})` : undefined}>
              Owned by {shortHex(address, 6, 4)}
            </span>
          }
          action={
            <div className="flex items-center gap-2">
              <Button size="sm" variant="ghost" onClick={() => setOlder((value) => value + 200n)} disabled={state.status !== "ok" || state.value.fromId <= 1n}>
                Load older
              </Button>
              <Button size="sm" variant="secondary" onClick={() => void listing.refresh()} loading={listing.refreshing && state.status === "ok"} loadingLabel="Refreshing">
                Refresh
              </Button>
            </div>
          }
        />
        <CardBody>
          {state.status === "loading" ? (
            <ul className="flex flex-col gap-2" aria-busy>
              {[0, 1, 2].map((i) => (
                <li key={i}>
                  <Skeleton className="h-16 w-full" />
                </li>
              ))}
            </ul>
          ) : state.status === "not_deployed" ? (
            <EmptyState illustration="vault" title="Engine not deployed yet" description={state.detail} />
          ) : state.status === "error" ? (
            <EmptyState illustration="ember" title="Could not read your streams" description={state.message} action={<Button onClick={() => void listing.refresh()}>Retry</Button>} />
          ) : state.value.rows.length === 0 ? (
            <EmptyState
              illustration="vault"
              title="No Sablier stream in this range"
              description="Mint a demo vesting position, or load older stream ids."
              action={
                <div className="flex flex-col items-center gap-3">
                  <div className="flex flex-wrap items-center gap-2 text-[12px]">
                    <span className="text-ink-400">Class</span>
                    <Segmented
                      label="Demo class"
                      options={[
                        { value: DemoClass.SEED, label: "Seed cohort" },
                        { value: DemoClass.KOL, label: "KOL cohort" },
                      ]}
                      value={demoClass}
                      onChange={setDemoClass}
                    />
                  </div>
                  <Button
                    onClick={() =>
                      void demo.run("Minting a demo vesting position", async () => {
                        if (!demoFaucet) throw new RoseActionError("not_deployed", "DemoStreamFaucet not deployed", "The demo stream faucet is not deployed on this build.");
                        const wallet = await wallets.getEvmWalletClient();
                        const hash = await mintDemoPosition(wallet, demoFaucet, demoClass);
                        const receipt = await basePublicClient().waitForTransactionReceipt({ hash });
                        const minted = decodePositionMinted(receipt);
                        return { message: minted ? `Sablier stream #${minted.streamId.toString()} minted to you` : "Demo position minted", links: txLinks("base", hash) };
                      })
                    }
                    loading={demo.state.status === "loading"}
                    loadingLabel="Minting"
                    disabled={!demoFaucet}
                    title={demoFaucet ? undefined : "DemoStreamFaucet is not deployed yet."}
                    data-mint-demo
                  >
                    Mint me a demo vesting position
                  </Button>
                  {demo.state.status === "error" ? (
                    <p className="text-[12px] text-danger-400" role="alert">
                      {demo.state.error.title}: {demo.state.error.message}
                    </p>
                  ) : null}
                  {!demoFaucet ? <p className="text-[11px] text-ink-400">DemoStreamFaucet is not deployed yet.</p> : null}
                </div>
              }
            />
          ) : (
            <ul className="flex flex-col gap-2" data-stream-list>
              {state.value.rows.map((row) => (
                <StreamRow key={row.streamId.toString()} row={row} symbol={row.stream ? (symbols.get(row.stream.token.toLowerCase()) ?? null) : null} onDeposit={() => startDeposit(row)} busy={flow.running} disabledReason={disabledReason} />
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      <PendingRegistrations nearAccount={nearAccount} busy={flow.running} onResume={resumeRegistration} refreshKey={flow.completed} />

      {selected && flow.steps.length > 0 ? (
        <Card data-deposit-flow>
          <CardHeader
            title={`${selected.resumed ? "Registering" : "Depositing"} Sablier stream #${selected.streamId.toString()}`}
            description={`Units are minted to ${nearAccount ?? "your NEAR account"}; the vested part goes to your EVM address.`}
            action={
              flow.completed ? (
                <Button size="sm" variant="secondary" onClick={() => (window.location.href = ROUTES.portfolio)}>
                  Open Portfolio
                </Button>
              ) : flow.running ? (
                <Button size="sm" variant="ghost" onClick={flow.cancel}>
                  Stop waiting
                </Button>
              ) : null
            }
          />
          <CardBody>
            <FlowSteps steps={flow.steps} running={flow.running} onRetry={() => void flow.retry()} />
          </CardBody>
        </Card>
      ) : null}
      <Disclosure summary="Which streams are eligible">
        <p className="text-[12.5px] leading-relaxed text-ink-300">
          RoseVault refuses non-linear, cancelable, non-transferable, canceled or depleted streams and streams below one whole token; the engine re-checks the schedule from the attested event. The vault withdraws the already vested part to your EVM address first; the rest accrues to the units. <LearnMore topic="custody" />
        </p>
      </Disclosure>
    </div>
  );
}

/**
 * Base deposits this browser made whose registration never completed (the tab was closed during
 * the finality wait, or the step failed): the stream sits in RoseVault until its log is
 * registered, which anyone can do, so the holder gets a one-click resume here.
 */
function PendingRegistrations({ nearAccount, busy, onResume, refreshKey }: { nearAccount: string | null; busy: boolean; onResume: (attempt: AttemptedDeposit) => void; refreshKey: boolean }) {
  const [attempts, setAttempts] = useState<AttemptedDeposit[]>([]);
  useEffect(() => {
    const timer = window.setTimeout(() => setAttempts(loadAttempted().filter((attempt) => attempt.chain === "base" && attempt.baseTx && attempt.streamId && attempt.nearAccount === nearAccount)), 0);
    return () => window.clearTimeout(timer);
  }, [nearAccount, refreshKey]);
  const fetcher = useCallback(
    async (signal: AbortSignal): Promise<AttemptedDeposit[]> => {
      if (attempts.length === 0) return [];
      const { views } = requireEngine();
      const states = await Promise.all(attempts.map((attempt) => Promise.all([views.raw.getReplay(attempt.key, { signal }), views.raw.getRefusedDeposit(attempt.key, { signal })])));
      return attempts.filter((_, index) => states[index]![0] === null && states[index]![1] === null);
    },
    [attempts],
  );
  const query = useEngineQuery(fetcher, { enabled: attempts.length > 0, pollMs: 60_000 });
  if (query.state.status !== "ok" || query.state.value.length === 0) return null;
  return (
    <Card data-pending-registrations>
      <CardHeader title="Waiting for registration" description="Deposited but not registered on NEAR yet. Register to receive the units." />
      <CardBody>
        <ul className="flex flex-col gap-2">
          {query.state.value.map((attempt) => (
            <li key={attempt.baseTx} className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-ink-750 bg-ink-900 px-3 py-2.5">
              <div className="min-w-0 text-[13px]">
                <p className="text-ink-50">{attempt.label}</p>
                <p className="text-[12px] text-ink-400">
                  Deposited {formatDay(attempt.attemptedAt)} for {attempt.nearAccount}.{" "}
                  <a href={txLinks("base", attempt.baseTx!)[0]!.href} target="_blank" rel="noreferrer" className="text-ember-300 underline-offset-2 hover:underline">
                    Deposit transaction ↗
                  </a>
                </p>
              </div>
              <Button size="sm" onClick={() => onResume(attempt)} disabled={busy} data-resume-registration>
                Register
              </Button>
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  );
}
