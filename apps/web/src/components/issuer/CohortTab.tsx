"use client";

import {
  approveToken,
  calculateMinFeeWei,
  cohortTotal,
  createStreams,
  decodeStreamDeposited,
  erc20Abi,
  sablierLockupExtrasAbi,
  waitForSafeHead,
  type Allocation,
  type StreamDepositedLog,
} from "@rose/sdk";
import { useCallback, useEffect, useMemo, useState } from "react";
import { LearnMore } from "@/components/chrome/LearnMore";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { FlowSteps } from "@/components/ui/FlowSteps";
import { Input, NumberInput } from "@/components/ui/Input";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/Table";
import { useWallets } from "@/components/wallet/WalletProvider";
import { formatAmount, formatDuration, isEvmAddress, parseAmount, shortHex } from "@/lib/amounts";
import { deployedAddress } from "@/lib/deployment";
import { RoseActionError, toActionError, type ActionError } from "@/lib/errors";
import { txLinks } from "@/lib/explorer";
import { useFlow } from "@/lib/use-action";
import { checkRows, cohortSizeError, parseAllocationLines, rowsTotal, type AllocationRow } from "./allocations";
import { registerStreamLog } from "./base-registration";
import { dateTimeToSeconds, secondsToDateTime } from "./class-schedule";
import { FieldLabel, Hint, Preview, type IssuerBase, baseClient } from "./shared";

const COHORT_STORAGE_KEY = "rose.issuer.cohort-tx";

type RegistrationRow = { streamId: string; holder: string; status: "pending" | "running" | "done" | "refused" | "error"; detail: string; txHash: string | null };

type TokenInfo = { address: `0x${string}`; symbol: string; decimals: number; balance: bigint; allowance: bigint };

function readLastCohortTx(): string | null {
  try {
    return window.localStorage.getItem(COHORT_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeLastCohortTx(hash: string): void {
  try {
    window.localStorage.setItem(COHORT_STORAGE_KEY, hash);
  } catch {
    // Blocked storage: the hash stays in the page state only.
  }
}

/** Tab 2: the issuer path, `createStreams` on RoseVault then one registration per holder. */
export function CohortTab({ base }: { base: IssuerBase }) {
  const wallets = useWallets();
  const vault = deployedAddress("roseVault");
  const [token, setToken] = useState(deployedAddress("demoToken") ?? "");
  const [tokenInfo, setTokenInfo] = useState<TokenInfo | null>(null);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [start, setStart] = useState(() => secondsToDateTime(Math.floor(Date.now() / 1000) + 3600));
  const [cliff, setCliff] = useState("");
  const [end, setEnd] = useState(() => secondsToDateTime(Math.floor(Date.now() / 1000) + 366 * 86_400));
  const [granularity, setGranularity] = useState("1");
  const [unitAmount, setUnitAmount] = useState("1");
  const [unitStartUnlock, setUnitStartUnlock] = useState("0");
  const [unitCliffUnlock, setUnitCliffUnlock] = useState("0");
  const [rows, setRows] = useState<AllocationRow[]>([{ account: wallets.near.accountId ?? "", amount: "100" }]);
  /* The wallet session may restore after the first render: the untouched first row takes the account then. */
  const [prefilledFor, setPrefilledFor] = useState<string | null>(wallets.near.accountId);
  if (wallets.near.accountId && prefilledFor !== wallets.near.accountId) {
    setPrefilledFor(wallets.near.accountId);
    const account = wallets.near.accountId;
    setRows((current) => (current.length === 1 && current[0]!.account === "" ? [{ ...current[0]!, account }] : current));
  }
  const [paste, setPaste] = useState("");
  const [resumeHash, setResumeHash] = useState("");
  const [registrations, setRegistrations] = useState<RegistrationRow[]>([]);
  const flow = useFlow();
  const [lastTx, setLastTx] = useState<string | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setLastTx(readLastCohortTx()), 0);
    return () => window.clearTimeout(timer);
  }, []);

  const decimals = tokenInfo?.decimals ?? 18;
  const checked = useMemo(() => checkRows(rows, decimals, { unitAmount: parseAmount(unitAmount, decimals), minimum: 10n ** BigInt(decimals) }), [rows, decimals, unitAmount]);
  const total = rowsTotal(checked);
  const sizeError = cohortSizeError(checked.length);
  const valid = checked.length > 0 && sizeError === null && checked.every((row) => row.error === null);

  const readToken = useCallback(async () => {
    setTokenError(null);
    if (!isEvmAddress(token.trim()) || !vault || !wallets.evm.address) {
      setTokenInfo(null);
      return;
    }
    const address = token.trim().toLowerCase() as `0x${string}`;
    const client = baseClient();
    try {
      const [symbol, tokenDecimals, balance, allowance] = await Promise.all([
        client.readContract({ address, abi: erc20Abi, functionName: "symbol" }),
        client.readContract({ address, abi: erc20Abi, functionName: "decimals" }),
        client.readContract({ address, abi: erc20Abi, functionName: "balanceOf", args: [wallets.evm.address] }),
        client.readContract({ address, abi: erc20Abi, functionName: "allowance", args: [wallets.evm.address, vault] }),
      ]);
      setTokenInfo({ address, symbol, decimals: tokenDecimals, balance, allowance });
    } catch (error) {
      setTokenInfo(null);
      setTokenError(toActionError(error).message);
    }
  }, [token, vault, wallets.evm.address]);

  useEffect(() => {
    const timer = window.setTimeout(() => void readToken(), 0);
    return () => window.clearTimeout(timer);
  }, [readToken]);

  const updateRow = (index: number, patch: Partial<AllocationRow>) => setRows((current) => current.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  const registerAll = useCallback(
    async (logs: StreamDepositedLog[], signal: AbortSignal, setDetail: (text: string) => void) => {
      setRegistrations(logs.map((log) => ({ streamId: log.args.streamId.toString(), holder: log.args.nearAccount, status: "pending", detail: "", txHash: null })));
      let failures: ActionError[] = [];
      for (const [index, log] of logs.entries()) {
        const patch = (update: Partial<RegistrationRow>) => setRegistrations((current) => current.map((row, i) => (i === index ? { ...row, ...update } : row)));
        patch({ status: "running", detail: "Starting…" });
        setDetail(`Registering stream #${log.args.streamId.toString()} for ${log.args.nearAccount} (${String(index + 1)}/${String(logs.length)})`);
        try {
          const result = await registerStreamLog(base.engine, wallets.sendNearCall, log, { signal, onDetail: (detail) => patch({ detail }) });
          if (result.outcome.outcome === "refused") patch({ status: "refused", detail: `Refused by the engine: ${result.outcome.refused.reason}. The stream can be returned from the Deposit page.`, txHash: result.txHash });
          else patch({ status: "done", detail: `Units minted to ${log.args.nearAccount} in class ${shortHex(result.classId)}.`, txHash: result.txHash });
        } catch (error) {
          const described = toActionError(error);
          failures = [...failures, described];
          patch({ status: "error", detail: `${described.title}: ${described.message}` });
        }
      }
      if (failures.length > 0) throw new RoseActionError("mpc_timeout", `${String(failures.length)} registration(s) failed`, failures[0]!.message, true);
      return { message: `${String(logs.length)} stream(s) registered` };
    },
    [base.engine, wallets.sendNearCall],
  );

  const startCohort = async () => {
    if (!vault || !tokenInfo || !valid) return;
    const client = baseClient();
    const startSec = dateTimeToSeconds(start);
    const endSec = dateTimeToSeconds(end);
    const cliffSec = cliff ? dateTimeToSeconds(cliff) : 0n;
    const unit = parseAmount(unitAmount, tokenInfo.decimals);
    const unitStart = parseAmount(unitStartUnlock, tokenInfo.decimals);
    const unitCliff = parseAmount(unitCliffUnlock, tokenInfo.decimals);
    if (startSec === null || endSec === null || cliffSec === null || unit === null || unitStart === null || unitCliff === null || !/^\d+$/.test(granularity)) return;
    const allocations: Allocation[] = checked.map((row) => ({ nearAccount: row.account, amount: row.amountUnits ?? 0n }));
    const totalAmount = cohortTotal(allocations);
    let logs: StreamDepositedLog[] = [];
    let receiptBlock = 0n;
    await flow.start([
      {
        id: "approve",
        label: `Approve RoseVault for ${formatAmount(totalAmount, tokenInfo.decimals)} ${tokenInfo.symbol}`,
        run: async () => {
          if (tokenInfo.allowance >= totalAmount) return { message: "Allowance already sufficient" };
          const wallet = await wallets.getEvmWalletClient();
          const hash = await approveToken(wallet, tokenInfo.address, vault, totalAmount);
          await client.waitForTransactionReceipt({ hash });
          return { message: "Approved", links: txLinks("base", hash) };
        },
      },
      {
        id: "create",
        label: `Create ${String(allocations.length)} stream(s) in custody (createStreams)`,
        run: async ({ setDetail }) => {
          const wallet = await wallets.getEvmWalletClient();
          let value = 0n;
          const nowSec = BigInt(Math.floor(Date.now() / 1000));
          if (startSec <= nowSec) {
            const next = await client.readContract({ address: base.config.sablier_lockup as `0x${string}`, abi: sablierLockupExtrasAbi, functionName: "nextStreamId" });
            const fee = next > 1n ? await calculateMinFeeWei(client, next - 1n, base.config.sablier_lockup as `0x${string}`) : 0n;
            value = (fee * BigInt(allocations.length) * 11n) / 10n;
            setDetail(`The schedule already started: ${value.toString()} wei forwarded for Sablier's withdrawal fee (${fee.toString()} wei per stream + 10 %, unused part refunded).`);
          }
          const hash = await createStreams(wallet, { vault, token: tokenInfo.address, schedule: { start: Number(startSec), cliff: Number(cliffSec), end: Number(endSec), granularity: Number(granularity), unitAmount: unit, unitStartUnlock: unitStart, unitCliffUnlock: unitCliff }, allocations, value });
          setDetail("Waiting for the receipt…");
          const receipt = await client.waitForTransactionReceipt({ hash });
          logs = decodeStreamDeposited(receipt);
          receiptBlock = receipt.blockNumber;
          writeLastCohortTx(hash);
          setLastTx(hash);
          return { message: `${String(logs.length)} StreamDeposited log(s) in block ${receipt.blockNumber.toString()}`, links: txLinks("base", hash) };
        },
      },
      {
        id: "finality",
        label: "Base finality: ~3 min (safe head plus a 30 s margin for the MPC providers)",
        run: async ({ setDetail, signal }) => {
          await waitForSafeHead(client, receiptBlock, { signal, onProgress: (progress) => setDetail(progress.phase === "ready" ? "Safe." : progress.phase === "margin" ? "Safe head passed; 30 s margin…" : `Safe head ${progress.safeHead.toString()} / target ${progress.target.toString()} (every 3 to 4 min)…`) });
          return { message: "Base finality reached" };
        },
      },
      { id: "register", label: "Register every stream on the engine (MPC verification, ~7 s each)", run: ({ signal, setDetail }) => registerAll(logs, signal, setDetail) },
    ]);
  };

  const resume = async () => {
    const hash = (resumeHash || lastTx || "").trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) return;
    const client = baseClient();
    let logs: StreamDepositedLog[] = [];
    await flow.start([
      {
        id: "receipt",
        label: `Read the StreamDeposited logs of ${shortHex(hash, 10, 6)}`,
        run: async () => {
          const receipt = await client.getTransactionReceipt({ hash: hash as `0x${string}` });
          logs = decodeStreamDeposited(receipt);
          if (logs.length === 0) throw new RoseActionError("contract", "No StreamDeposited log", "This transaction did not create streams through RoseVault.");
          return { message: `${String(logs.length)} log(s) found`, links: txLinks("base", hash) };
        },
      },
      {
        id: "finality",
        label: "Base finality (safe head)",
        run: async ({ setDetail, signal }) => {
          await waitForSafeHead(client, logs[0]!.blockNumber, { signal, onProgress: (progress) => setDetail(progress.phase === "ready" ? "Safe." : `Safe head ${progress.safeHead.toString()} / target ${progress.target.toString()}…`) });
          return { message: "Base finality reached" };
        },
      },
      { id: "register", label: "Register every stream on the engine", run: ({ signal, setDetail }) => registerAll(logs, signal, setDetail) },
    ]);
  };

  const disabledReason = !vault ? "RoseVault is not deployed yet." : !wallets.evm.address ? "Connect a Base Sepolia wallet (the issuer's tokens)." : !wallets.near.accountId ? "Connect a NEAR wallet (registers the deposits)." : !tokenInfo ? "Enter the cohort token address." : sizeError ? sizeError : !/^[1-9]\d*$/.test(granularity) ? "The granularity must be at least 1 second." : !valid ? "Fix the allocations." : tokenInfo.balance < total ? `Balance ${formatAmount(tokenInfo.balance, tokenInfo.decimals)} ${tokenInfo.symbol} is below the cohort total.` : null;

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
      <Card>
        <CardHeader title="Create the cohort's streams in custody" description="RoseVault pulls the tokens and creates one Sablier Lockup Linear stream per holder (non-cancelable, transferable, recipient = the vault) in one transaction; each StreamDeposited names the NEAR account that receives the units." />
        <CardBody className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <FieldLabel htmlFor="cohort-token">Cohort token (Base Sepolia)</FieldLabel>
            <Input id="cohort-token" value={token} onChange={(event) => setToken(event.target.value)} placeholder="0x…" />
            {tokenInfo ? (
              <Hint>
                {tokenInfo.symbol}, {tokenInfo.decimals} decimals · balance {formatAmount(tokenInfo.balance, tokenInfo.decimals)} · allowance to the vault {formatAmount(tokenInfo.allowance, tokenInfo.decimals)}
              </Hint>
            ) : tokenError ? (
              <Hint tone="danger">{tokenError}</Hint>
            ) : (
              <Hint>Symbol, decimals, your balance and the vault allowance are read from the token.</Hint>
            )}
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="flex flex-col gap-1.5">
              <FieldLabel htmlFor="cohort-start">Start (UTC)</FieldLabel>
              <Input id="cohort-start" type="datetime-local" value={start} onChange={(event) => setStart(event.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <FieldLabel htmlFor="cohort-cliff">Cliff (UTC, optional)</FieldLabel>
              <Input id="cohort-cliff" type="datetime-local" value={cliff} onChange={(event) => setCliff(event.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <FieldLabel htmlFor="cohort-end">End (UTC)</FieldLabel>
              <Input id="cohort-end" type="datetime-local" value={end} onChange={(event) => setEnd(event.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <FieldLabel htmlFor="cohort-unit">Unit amount</FieldLabel>
              <NumberInput id="cohort-unit" value={unitAmount} onValueChange={setUnitAmount} decimals={decimals} unit={tokenInfo?.symbol} />
            </div>
            <div className="flex flex-col gap-1.5">
              <FieldLabel htmlFor="cohort-unit-start">Unit start unlock</FieldLabel>
              <NumberInput id="cohort-unit-start" value={unitStartUnlock} onValueChange={setUnitStartUnlock} decimals={decimals} />
            </div>
            <div className="flex flex-col gap-1.5">
              <FieldLabel htmlFor="cohort-unit-cliff">Unit cliff unlock</FieldLabel>
              <NumberInput id="cohort-unit-cliff" value={unitCliffUnlock} onValueChange={setUnitCliffUnlock} decimals={decimals} />
            </div>
            <div className="flex flex-col gap-1.5">
              <FieldLabel htmlFor="cohort-granularity">Granularity (seconds)</FieldLabel>
              <NumberInput id="cohort-granularity" value={granularity} onValueChange={setGranularity} decimals={0} />
            </div>
          </div>
          <Hint>Every allocation is a multiple of the unit amount; its start and cliff unlocks scale with it. Allocations must be at least one whole token and keep one whole token locked after any vested withdrawal.</Hint>
          <div className="flex flex-col gap-2">
            <FieldLabel>Allocations (NEAR account, amount)</FieldLabel>
            <Table>
              <THead>
                <TR>
                  <TH>Holder (NEAR account)</TH>
                  <TH numeric>Amount{tokenInfo ? ` (${tokenInfo.symbol})` : ""}</TH>
                  <TH />
                </TR>
              </THead>
              <TBody>
                {checked.map((row, index) => (
                  <TR key={index}>
                    <TD className="min-w-48">
                      <Input value={row.account} onChange={(event) => updateRow(index, { account: event.target.value })} placeholder="holder.testnet" invalid={row.error !== null && !row.error.includes("amount") && !row.error.includes("multiple")} aria-label={`Holder ${String(index + 1)}`} />
                      {row.error ? <span className="text-[11px] text-danger-400">{row.error}</span> : null}
                    </TD>
                    <TD numeric className="min-w-32">
                      <NumberInput value={row.amount} onValueChange={(value) => updateRow(index, { amount: value })} decimals={decimals} aria-label={`Amount ${String(index + 1)}`} />
                    </TD>
                    <TD numeric>
                      <Button size="sm" variant="ghost" onClick={() => setRows((current) => current.filter((_, i) => i !== index))} aria-label={`Remove row ${String(index + 1)}`}>
                        ×
                      </Button>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="secondary" onClick={() => setRows((current) => [...current, { account: "", amount: "" }])}>
                Add a holder
              </Button>
              <span className="text-[12px] text-ink-400">or paste `account,amount` lines:</span>
            </div>
            <textarea
              value={paste}
              onChange={(event) => setPaste(event.target.value)}
              onBlur={() => {
                const parsed = parseAllocationLines(paste);
                if (parsed.length > 0) {
                  setRows(parsed);
                  setPaste("");
                }
              }}
              rows={3}
              placeholder={"halden.testnet,1000\ntessaro.testnet,1500"}
              className="w-full rounded-md border border-ink-700 bg-ink-900 px-3 py-2 font-mono text-[12px] text-ink-50 placeholder:text-ink-400 focus:border-ember-500 focus:outline-none"
              aria-label="Paste allocations"
            />
          </div>
          <Preview
            rows={[
              { label: "Holders", value: String(checked.length) },
              { label: "Total pulled from the issuer", value: `${formatAmount(total, decimals)} ${tokenInfo?.symbol ?? ""}`, emphasis: true },
              { label: "Streams created", value: `${String(checked.length)} Sablier LL, recipient RoseVault` },
              { label: "Then", value: `${String(checked.length)} register_base_deposit call(s) with each holder's storage deposit` },
            ]}
          />
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={() => void startCohort()} disabled={disabledReason !== null || flow.running} loading={flow.running} loadingLabel="Running" title={disabledReason ?? undefined} data-create-cohort>
              Create the cohort
            </Button>
            {disabledReason ? <Hint>{disabledReason}</Hint> : null}
          </div>
          <p className="text-[12px] text-ink-400">
            Most team vestings are not transferable, so this path is the primary onboarding path. <LearnMore topic="issuer" />
          </p>
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Progress" description="Approval, creation, Base finality and one engine registration per stream. A failed step can be retried; a registration can be resumed from the transaction hash." />
        <CardBody className="flex flex-col gap-4">
          <FlowSteps steps={flow.steps} onRetry={() => void flow.retry()} running={flow.running} />
          {registrations.length > 0 ? (
            <Table>
              <THead>
                <TR>
                  <TH>Stream</TH>
                  <TH>Holder</TH>
                  <TH>Status</TH>
                </TR>
              </THead>
              <TBody>
                {registrations.map((row) => (
                  <TR key={row.streamId} data-registration={row.status}>
                    <TD className="tabular">#{row.streamId}</TD>
                    <TD>{row.holder}</TD>
                    <TD>
                      <div className="flex flex-col gap-0.5 py-1">
                        <Badge tone={row.status === "done" ? "success" : row.status === "refused" || row.status === "error" ? "danger" : row.status === "running" ? "ember" : "neutral"}>{row.status}</Badge>
                        {row.detail ? <span className="text-[11px] text-ink-400">{row.detail}</span> : null}
                        {row.txHash ? (
                          <a href={txLinks("near", row.txHash)[0]!.href} target="_blank" rel="noreferrer" className="font-display text-[11px] uppercase tracking-wide text-ember-300 underline-offset-2 hover:underline">
                            NEAR transaction ↗
                          </a>
                        ) : null}
                      </div>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          ) : null}
          <div className="flex flex-col gap-2 rounded-md border border-ink-750 bg-ink-900 p-3">
            <FieldLabel htmlFor="cohort-resume">Resume the registration of an earlier createStreams transaction</FieldLabel>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input id="cohort-resume" value={resumeHash} onChange={(event) => setResumeHash(event.target.value)} placeholder={lastTx ?? "0x… Base transaction hash"} />
              <Button variant="secondary" onClick={() => void resume()} disabled={flow.running || !wallets.near.accountId || !(resumeHash || lastTx)} data-resume-cohort>
                Resume
              </Button>
            </div>
            <Hint>{lastTx ? `Last cohort transaction in this browser: ${shortHex(lastTx, 10, 6)}.` : "Registration is idempotent: streams already registered are skipped, refused ones are reported."} Finality is about {formatDuration(180)} after mining.</Hint>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
