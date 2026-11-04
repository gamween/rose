"use client";

import { erc20Abi, readStream, readStreamflowStream, ScheduleError, type Chain, type ClassInfo } from "@rose/sdk";
import { PublicKey } from "@solana/web3.js";
import { useState } from "react";
import { LearnMore } from "@/components/chrome/LearnMore";
import { UnlockChart } from "@/components/portfolio/UnlockChart";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Input, NumberInput } from "@/components/ui/Input";
import { Tabs } from "@/components/ui/Tabs";
import { formatAmount, isEvmAddress, isSolanaAddress, parseAmount, shortHex } from "@/lib/amounts";
import { toActionError } from "@/lib/errors";
import { addressUrl } from "@/lib/explorer";
import type { EngineSchedule } from "@/lib/unlock-schedule";
import { solanaConnection } from "@/lib/wallet/solana-demo";
import { dateTimeToSeconds, linearInputOfStream, normalizeLinear, normalizeStepped, sablierScheduleArgs, secondsToDateTime, steppedInputOfMetadata, streamflowScheduleArgs, type LinearInput, type SteppedInput } from "./class-schedule";
import { ClassSummary, FieldLabel, Hint, Preview, type IssuerBase, baseClient } from "./shared";

type Source = "stream" | "schedule";

type Computed = {
  chain: Chain;
  token: string;
  decimals: number;
  symbol: string | null;
  schedule: EngineSchedule;
  classId: string;
  existing: ClassInfo | null;
  deposited: bigint;
};

type ComputeState = { status: "idle" } | { status: "loading" } | { status: "error"; message: string } | { status: "ok"; computed: Computed };

const SOURCE_TABS = [
  { id: "stream", label: "From an existing stream" },
  { id: "schedule", label: "From a schedule" },
] as const;

function scheduleMessage(error: unknown): string {
  if (error instanceof ScheduleError) return `The engine refuses this schedule: ${error.message}`;
  return toActionError(error).message;
}

/** Tab 1: the deterministic class of a stream or a schedule, with its normalized unlock function. */
export function CreateClassTab({ base }: { base: IssuerBase }) {
  const [source, setSource] = useState<Source>("stream");
  const [chain, setChain] = useState<Chain>("Base");
  const [streamRef, setStreamRef] = useState("");
  const [token, setToken] = useState("");
  const [start, setStart] = useState(() => secondsToDateTime(Math.floor(Date.now() / 1000) + 3600));
  const [cliff, setCliff] = useState("");
  const [end, setEnd] = useState(() => secondsToDateTime(Math.floor(Date.now() / 1000) + 366 * 86_400));
  const [granularity, setGranularity] = useState("1");
  const [period, setPeriod] = useState("3600");
  const [deposited, setDeposited] = useState("1000");
  const [startUnlock, setStartUnlock] = useState("0");
  const [cliffUnlock, setCliffUnlock] = useState("0");
  const [state, setState] = useState<ComputeState>({ status: "idle" });

  const finish = async (chainOf: Chain, tokenOf: string, decimals: number, symbol: string | null, schedule: EngineSchedule, classId: string, depositedAmount: bigint) => {
    const existing = await base.engine.views.getClass(classId);
    setState({ status: "ok", computed: { chain: chainOf, token: tokenOf, decimals, symbol, schedule, classId, existing, deposited: depositedAmount } });
  };

  const computeFromStream = async () => {
    setState({ status: "loading" });
    try {
      if (chain === "Base") {
        if (!/^\d+$/.test(streamRef.trim())) throw new Error("Enter the Sablier stream id (a number).");
        const stream = await readStream(baseClient(), BigInt(streamRef.trim()), base.config.sablier_lockup as `0x${string}`);
        const input = linearInputOfStream(stream);
        const schedule = normalizeLinear(input, stream.decimals);
        const symbol = base.symbols.get(stream.token.toLowerCase()) ?? null;
        const classId = await base.engine.views.raw.computeBaseClassId(stream.token.toLowerCase(), stream.decimals, sablierScheduleArgs(input));
        await finish("Base", stream.token.toLowerCase(), stream.decimals, symbol, schedule, classId, stream.deposited);
      } else {
        if (!isSolanaAddress(streamRef.trim())) throw new Error("Enter the Streamflow metadata account (base58).");
        const connection = solanaConnection("finalized");
        const stream = await readStreamflowStream(connection, new PublicKey(streamRef.trim()));
        const mintInfo = await connection.getParsedAccountInfo(stream.metadata.mint);
        const parsed = mintInfo.value?.data as { parsed?: { info?: { decimals?: number } } } | undefined;
        const decimals = parsed?.parsed?.info?.decimals;
        if (decimals === undefined) throw new Error("The mint's decimals could not be read (classic SPL Token mints only).");
        const input = steppedInputOfMetadata(stream.metadata);
        const schedule = normalizeStepped(input);
        const mint = stream.metadata.mint.toBase58();
        const classId = await base.engine.views.raw.computeSolClassId(mint, decimals, streamflowScheduleArgs(input));
        await finish("Solana", mint, decimals, null, schedule, classId, stream.metadata.netAmountDeposited);
      }
    } catch (error) {
      setState({ status: "error", message: scheduleMessage(error) });
    }
  };

  const computeFromSchedule = async () => {
    setState({ status: "loading" });
    try {
      const startSec = dateTimeToSeconds(start);
      const endSec = dateTimeToSeconds(end);
      const cliffSec = cliff ? dateTimeToSeconds(cliff) : 0n;
      if (startSec === null || endSec === null || cliffSec === null) throw new Error("Enter the start and end (and an optional cliff) as dates.");
      if (chain === "Base") {
        if (!isEvmAddress(token.trim())) throw new Error("Enter the token address (0x…).");
        const address = token.trim().toLowerCase() as `0x${string}`;
        const client = baseClient();
        const [decimals, symbol] = await Promise.all([client.readContract({ address, abi: erc20Abi, functionName: "decimals" }), client.readContract({ address, abi: erc20Abi, functionName: "symbol" }).catch(() => null)]);
        const amount = parseAmount(deposited, decimals);
        const startAmount = parseAmount(startUnlock, decimals);
        const cliffAmount = parseAmount(cliffUnlock, decimals);
        if (amount === null || startAmount === null || cliffAmount === null) throw new Error(`Amounts take at most ${String(decimals)} decimals.`);
        if (!/^\d+$/.test(granularity.trim()) || BigInt(granularity.trim()) === 0n) throw new Error("The granularity is a positive number of seconds.");
        const input: LinearInput = { start: startSec, cliff: cliffSec, end: endSec, granularity: BigInt(granularity.trim()), deposited: amount, startUnlock: startAmount, cliffUnlock: cliffAmount };
        const schedule = normalizeLinear(input, decimals);
        const classId = await base.engine.views.raw.computeBaseClassId(address, decimals, sablierScheduleArgs(input));
        await finish("Base", address, decimals, symbol, schedule, classId, amount);
      } else {
        if (!isSolanaAddress(token.trim())) throw new Error("Enter the token mint (base58).");
        const mint = new PublicKey(token.trim());
        const mintInfo = await solanaConnection().getParsedAccountInfo(mint);
        const parsed = mintInfo.value?.data as { parsed?: { info?: { decimals?: number } } } | undefined;
        const decimals = parsed?.parsed?.info?.decimals;
        if (decimals === undefined) throw new Error("The mint's decimals could not be read (classic SPL Token mints only).");
        const amount = parseAmount(deposited, decimals);
        const cliffAmount = parseAmount(cliffUnlock, decimals);
        if (amount === null || cliffAmount === null) throw new Error(`Amounts take at most ${String(decimals)} decimals.`);
        if (!/^\d+$/.test(period.trim()) || BigInt(period.trim()) === 0n) throw new Error("The period is a positive number of seconds.");
        const periodSec = BigInt(period.trim());
        const effectiveStart = cliffSec > 0n ? cliffSec : startSec;
        if (endSec <= effectiveStart) throw new Error("The end must come after the start (or the cliff).");
        const periods = (endSec - effectiveStart + periodSec - 1n) / periodSec;
        const amountPerPeriod = periods > 0n ? (amount - cliffAmount) / periods : 0n;
        const input: SteppedInput = { startTime: startSec, cliff: cliffSec, endTime: endSec, period: periodSec, netAmountDeposited: amount, cliffAmount, amountPerPeriod };
        const schedule = normalizeStepped(input);
        const classId = await base.engine.views.raw.computeSolClassId(mint.toBase58(), decimals, streamflowScheduleArgs(input));
        await finish("Solana", mint.toBase58(), decimals, null, schedule, classId, amount);
      }
    } catch (error) {
      setState({ status: "error", message: scheduleMessage(error) });
    }
  };

  const chainButtons = (
    <div className="flex items-center gap-2 text-[12px]">
      <span className="text-ink-400">Chain</span>
      {(["Base", "Solana"] as const).map((value) => (
        <button
          key={value}
          type="button"
          onClick={() => setChain(value)}
          aria-pressed={chain === value}
          className={chain === value ? "rounded-sm border border-ember-500 bg-ember-700/25 px-2 py-0.5 text-ink-50" : "rounded-sm border border-ink-700 px-2 py-0.5 text-ink-300 hover:border-ink-500"}
        >
          {value === "Base" ? "Base Sepolia (Sablier)" : "Solana devnet (Streamflow)"}
        </button>
      ))}
    </div>
  );

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <Card>
        <CardHeader title="Create a class" description="A class is the set of positions with the same chain, token, decimals and normalized schedule. Its id is a hash: computing it here costs nothing; the engine writes the class record with the first registered deposit." />
        <CardBody className="flex flex-col gap-4">
          <Tabs items={SOURCE_TABS} value={source} onChange={setSource} label="Class source" />
          {chainButtons}
          {source === "stream" ? (
            <div className="flex flex-col gap-1.5">
              <FieldLabel htmlFor="class-stream">{chain === "Base" ? "Sablier stream id" : "Streamflow metadata account"}</FieldLabel>
              <Input id="class-stream" value={streamRef} onChange={(event) => setStreamRef(event.target.value)} placeholder={chain === "Base" ? "e.g. 83" : "base58 metadata account"} />
              <Hint>{chain === "Base" ? "Read live from the Lockup contract (owner, token, schedule, unlock amounts)." : "Read at finalized from the Streamflow program; the mint's decimals come from the mint account."}</Hint>
              <Button onClick={() => void computeFromStream()} loading={state.status === "loading"} loadingLabel="Reading" className="self-start" data-compute-class>
                Compute the class
              </Button>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <FieldLabel htmlFor="class-token">{chain === "Base" ? "Token address" : "Token mint"}</FieldLabel>
                <Input id="class-token" value={token} onChange={(event) => setToken(event.target.value)} placeholder={chain === "Base" ? "0x…" : "base58 mint"} />
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="flex flex-col gap-1.5">
                  <FieldLabel htmlFor="class-start">Start (UTC)</FieldLabel>
                  <Input id="class-start" type="datetime-local" value={start} onChange={(event) => setStart(event.target.value)} />
                </div>
                <div className="flex flex-col gap-1.5">
                  <FieldLabel htmlFor="class-cliff">Cliff (UTC, optional)</FieldLabel>
                  <Input id="class-cliff" type="datetime-local" value={cliff} onChange={(event) => setCliff(event.target.value)} />
                </div>
                <div className="flex flex-col gap-1.5">
                  <FieldLabel htmlFor="class-end">End (UTC)</FieldLabel>
                  <Input id="class-end" type="datetime-local" value={end} onChange={(event) => setEnd(event.target.value)} />
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="flex flex-col gap-1.5">
                  <FieldLabel htmlFor="class-deposited">{chain === "Base" ? "Deposited amount" : "Net amount deposited"}</FieldLabel>
                  <NumberInput id="class-deposited" value={deposited} onValueChange={setDeposited} decimals={18} />
                </div>
                {chain === "Base" ? (
                  <>
                    <div className="flex flex-col gap-1.5">
                      <FieldLabel htmlFor="class-start-unlock">Start unlock</FieldLabel>
                      <NumberInput id="class-start-unlock" value={startUnlock} onValueChange={setStartUnlock} decimals={18} />
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <FieldLabel htmlFor="class-cliff-unlock">Cliff unlock</FieldLabel>
                      <NumberInput id="class-cliff-unlock" value={cliffUnlock} onValueChange={setCliffUnlock} decimals={18} />
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <FieldLabel htmlFor="class-granularity">Granularity (seconds)</FieldLabel>
                      <NumberInput id="class-granularity" value={granularity} onValueChange={setGranularity} decimals={0} />
                    </div>
                  </>
                ) : (
                  <>
                    <div className="flex flex-col gap-1.5">
                      <FieldLabel htmlFor="class-cliff-amount">Cliff amount</FieldLabel>
                      <NumberInput id="class-cliff-amount" value={cliffUnlock} onValueChange={setCliffUnlock} decimals={18} />
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <FieldLabel htmlFor="class-period">Period (seconds)</FieldLabel>
                      <NumberInput id="class-period" value={period} onValueChange={setPeriod} decimals={0} />
                    </div>
                  </>
                )}
              </div>
              <Hint>
                {chain === "Base"
                  ? "Sablier Lockup Linear: start unlock at the start, cliff unlock at the cliff, then linear in steps of the granularity. Streams must be transferable and non-cancelable to enter custody."
                  : "Streamflow: the cliff amount unlocks at the cliff (or the start), then one amount per period until the end. The amount per period is derived from the remaining amount and the number of periods."}
              </Hint>
              <Button onClick={() => void computeFromSchedule()} loading={state.status === "loading"} loadingLabel="Computing" className="self-start" data-compute-class>
                Compute the class
              </Button>
            </div>
          )}
          {state.status === "error" ? (
            <p role="alert" className="text-[12px] text-danger-400">
              {state.message}
            </p>
          ) : null}
          <p className="text-[12px] text-ink-400">
            Positions in a class are fungible, which is what lets many sellers meet one price. <LearnMore topic="concepts" />
          </p>
        </CardBody>
      </Card>
      <Card>
        <CardHeader
          title="Result"
          description={state.status === "ok" ? (state.computed.existing ? "This class already exists on the engine." : "A new class: it is recorded when the first deposit with this schedule is registered.") : "The normalized schedule, the unlock function and the class id appear here."}
          action={state.status === "ok" ? <Badge tone={state.computed.existing ? "success" : "ember"}>{state.computed.existing ? "Existing" : "New"}</Badge> : null}
        />
        <CardBody className="flex flex-col gap-4" data-class-result={state.status}>
          {state.status === "ok" ? (
            <>
              <Preview
                rows={[
                  { label: "Token", value: `${state.computed.symbol ?? shortHex(state.computed.token)} · ${state.computed.chain} · ${String(state.computed.decimals)} decimals` },
                  { label: "Source amount", value: `${formatAmount(state.computed.deposited, state.computed.decimals)} ${state.computed.symbol ?? ""}` },
                  ...(state.computed.schedule.kind === "Linear"
                    ? [
                        { label: "Normalized total · start unlock · cliff unlock", value: `${state.computed.schedule.total.toString()} · ${state.computed.schedule.startUnlock.toString()} · ${state.computed.schedule.cliffUnlock.toString()}` },
                        { label: "Granularity", value: `${state.computed.schedule.granularity.toString()} s` },
                        { label: "Minimum deposit", value: `${formatAmount(state.computed.schedule.minDeposit, state.computed.decimals, 0)} whole token` },
                      ]
                    : [
                        { label: "Normalized total · cliff · per period", value: `${state.computed.schedule.total.toString()} · ${state.computed.schedule.cliffAmount.toString()} · ${state.computed.schedule.amountPerPeriod.toString()}` },
                        { label: "Period", value: `${state.computed.schedule.period.toString()} s` },
                      ]),
                  { label: "Class id", value: <span className="break-all">{state.computed.classId}</span>, emphasis: true },
                ]}
              />
              <UnlockChart schedule={state.computed.schedule} decimals={state.computed.decimals} title="Unlock function f(t)" />
              {state.computed.existing ? <ClassSummary cls={state.computed.existing} symbols={base.symbols} /> : null}
              <p className="text-[12px] text-ink-400">
                Token contract:{" "}
                <a href={addressUrl(state.computed.chain === "Base" ? "base" : "solana", state.computed.token)} target="_blank" rel="noreferrer" className="tabular underline-offset-2 hover:underline">
                  {state.computed.token}
                </a>
                . Next: create the cohort streams in custody (Base) or ask holders to deposit, then distribute units.
              </p>
            </>
          ) : (
            <p className="text-[13px] text-ink-400">{state.status === "loading" ? "Reading the chain…" : "Nothing computed yet."}</p>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
