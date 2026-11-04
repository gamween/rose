"use client";

import { outcomeValue, type Cash, type ClassInfo, type FunctionCall, type TenderArgs } from "@rose/sdk";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { LearnMore } from "@/components/chrome/LearnMore";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Input, NumberInput } from "@/components/ui/Input";
import { useWallets } from "@/components/wallet/WalletProvider";
import { formatUsdc, parseAmount, sameVenue, venueLabel } from "@/lib/amounts";
import { nearRpc } from "@/lib/engine-client";
import { toActionError } from "@/lib/errors";
import { txLinks } from "@/lib/explorer";
import { defaultDurations, durationErrors, formatBound, minutesToNs } from "@/lib/round-window";
import { ROUTES } from "@/lib/routes";
import { useAction } from "@/lib/use-action";
import { RoundTimingFields, type RoundTimingValue } from "@/components/rounds/RoundTimingFields";
import { secondsToDateTime } from "./class-schedule";
import { sputnikCliCommand, sputnikProposal, trezuSlug, trezuTemplate } from "./dao";
import { ActionFeedback, ClassPicker, ClassSummary, classSymbol, CopyButton, FieldLabel, formatNear, Hint, Preview, useVenueOptions, type IssuerBase } from "./shared";
import { BURN_ADDRESS, percentToBps, tenderArgsFromForm, tenderEscrow, type TenderFormValues } from "./tender-form";

const USDC = 6;

type Built = { args: TenderArgs; call: FunctionCall } | { error: string };

type DaoPolicy = { proposalBond: bigint; version: string | null };

/** Tabs 4 and 6: the Tender form with its live preview, launched directly or wrapped for a Sputnik DAO and Trezu. */
export function TenderTab({ base, initialClassId, showDao, onCash }: { base: IssuerBase; initialClassId?: string; showDao: boolean; onCash?: (cash: Cash[]) => void }) {
  const wallets = useWallets();
  const venues = useVenueOptions(base);
  const [classId, setClassId] = useState(initialClassId ?? base.classes[0]?.classId ?? "");
  const cls: ClassInfo | null = base.classes.find((item) => item.classId === classId) ?? null;
  const [venueId, setVenueId] = useState(venues[0]?.id ?? "near");
  const [budget, setBudget] = useState("1000");
  const [mode, setMode] = useState<"price" | "discount">("price");
  const [maxPrice, setMaxPrice] = useState("");
  const [reference, setReference] = useState("");
  const [discount, setDiscount] = useState("15");
  const [retireTo, setRetireTo] = useState("");
  const [opensNow, setOpensNow] = useState(true);
  const [opensAt, setOpensAt] = useState(() => secondsToDateTime(Math.floor(Date.now() / 1000) + 3600));
  const [closesAt, setClosesAt] = useState(() => secondsToDateTime(Math.floor(Date.now() / 1000) + 86_400));
  const [timing, setTiming] = useState<RoundTimingValue>(() => defaultDurations(base.config));
  const [cash, setCash] = useState<Cash[] | null>(null);
  const [dao, setDao] = useState("");
  const [policy, setPolicy] = useState<DaoPolicy | null>(null);
  const [policyError, setPolicyError] = useState<string | null>(null);
  const [daoDescription, setDaoDescription] = useState("rose Tender: buy back locked units at one uniform price");
  const launch = useAction();
  const file = useAction();
  const [now, setNow] = useState(() => Date.now());

  const venue = venues.find((option) => option.id === venueId)?.venue ?? "Near";

  useEffect(() => {
    let cancelled = false;
    const account = wallets.near.accountId;
    const timer = window.setTimeout(() => {
      if (!account) {
        setCash(null);
        return;
      }
      void base.engine.views
        .getCash(account)
        .then((value) => {
          if (cancelled) return;
          setCash(value);
          onCash?.(value);
        })
        .catch(() => {
          if (!cancelled) setCash(null);
        });
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [base.engine, wallets.near.accountId, launch.state.status, onCash]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const built = useMemo<Built | null>(() => {
    if (!cls) return null;
    const budgetUnits = parseAmount(budget, USDC);
    const values: TenderFormValues = {
      classId: cls.classId,
      chain: cls.chain,
      venue,
      budget: budgetUnits ?? 0n,
      mode,
      maxPrice: parseAmount(maxPrice, USDC),
      referencePrice: reference ? parseAmount(reference, USDC) : null,
      discountBps: percentToBps(discount),
      retireTo: retireTo.trim(),
      window: { opensNow, opensAt, closesAt },
      keyTimeout: minutesToNs(timing.keyTimeout),
      revealWindow: minutesToNs(timing.revealWindow),
    };
    const result = tenderArgsFromForm(values, now, base.limits);
    if ("error" in result) return result;
    return { args: result.args, call: base.engine.calls.createTender(result.args) };
  }, [base.engine.calls, base.limits, budget, closesAt, cls, discount, maxPrice, mode, now, opensAt, opensNow, reference, retireTo, timing, venue]);
  const timingErrors = durationErrors({ keyTimeout: minutesToNs(timing.keyTimeout), revealWindow: minutesToNs(timing.revealWindow) }, base.limits);

  const budgetUnits = parseAmount(budget, USDC) ?? 0n;
  const escrow = tenderEscrow(budgetUnits);
  const venueCash = cash?.find((entry) => sameVenue(entry.venue, venue))?.amount ?? null;
  const shortfall = venueCash !== null && venueCash < escrow.escrow ? escrow.escrow - venueCash : 0n;

  const readPolicy = useCallback(async () => {
    setPolicyError(null);
    setPolicy(null);
    const account = dao.trim();
    if (!account) return;
    try {
      const [policyView, version] = await Promise.all([
        nearRpc().viewFunction<{ proposal_bond: string }>(account, "get_policy", {}),
        nearRpc()
          .viewFunction<string>(account, "version", {})
          .then((result) => result.value)
          .catch(() => null),
      ]);
      setPolicy({ proposalBond: BigInt(policyView.value.proposal_bond), version });
    } catch (error) {
      setPolicyError(toActionError(error).message);
    }
  }, [dao]);

  const launchTender = () =>
    launch.run("Creating the Tender", async () => {
      if (!built || "error" in built) throw new Error("Fix the form first.");
      const outcome = await wallets.sendNearCall(built.call);
      const roundId = String(outcomeValue(outcome) ?? "");
      return { message: roundId ? `Tender #${roundId} created` : "Tender created", links: [...txLinks("near", outcome.transaction.hash), ...(roundId ? [{ href: `${ROUTES.rounds}/${roundId}`, label: `Round #${roundId}` }] : [])] };
    });

  const fileProposal = () =>
    file.run("Filing the proposal to the DAO", async () => {
      if (!built || "error" in built || !policy) throw new Error("Build the proposal first.");
      const proposal = sputnikProposal(built.call, daoDescription);
      const outcome = await wallets.sendNearCall({ receiverId: dao.trim(), methodName: "add_proposal", args: proposal, gas: 100n * 10n ** 12n, deposit: policy.proposalBond });
      const proposalId = String(outcomeValue(outcome) ?? "");
      return { message: proposalId ? `Proposal #${proposalId} filed to ${dao.trim()}` : "Proposal filed", links: txLinks("near", outcome.transaction.hash) };
    });

  const ready = built && !("error" in built) ? built : null;
  const proposalJson = ready ? JSON.stringify(sputnikProposal(ready.call, daoDescription), null, 2) : null;
  const cliCommand = ready ? sputnikCliCommand(dao.trim() || "<dao>.sputnik-v2.testnet", sputnikProposal(ready.call, daoDescription), policy?.proposalBond ?? 10n ** 24n, wallets.near.accountId ?? "<your-account>.testnet") : null;
  const trezu = built && !("error" in built) && cls ? JSON.stringify(trezuTemplate({ id: trezuSlug(cls.classId, `tender-${classSymbol(cls, base.symbols)}`), title: `rose Tender · ${classSymbol(cls, base.symbols)}`, engine: base.engine.account, call: built.call, tender: built.args, classLabel: classSymbol(cls, base.symbols), venueLabel: venueLabel(venue, base.symbols) }), null, 2) : null;

  const disabledReason = !wallets.near.accountId ? "Connect a NEAR wallet (the issuer)." : !cls ? "Choose a class." : built && "error" in built ? built.error : shortfall > 0n ? `Fund ${formatUsdc(shortfall)} more in ${venueLabel(venue, base.symbols)} first (Fund tab).` : null;

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
      <Card>
        <CardHeader title="Launch a Tender" description="One public buyer (you), a public budget and max price, sealed asks from holders, one uniform clearing price. Units bought are retired: their unlocked tokens go to the address you choose." />
        <CardBody className="flex flex-col gap-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5 sm:col-span-2">
              <FieldLabel htmlFor="tender-class">Class</FieldLabel>
              <ClassPicker id="tender-class" classes={base.classes} symbols={base.symbols} value={classId} onChange={setClassId} />
            </div>
            <div className="flex flex-col gap-1.5">
              <FieldLabel htmlFor="tender-venue">Cash venue</FieldLabel>
              <select id="tender-venue" value={venueId} onChange={(event) => setVenueId(event.target.value)} className="h-9 w-full rounded-md border border-ink-700 bg-ink-900 px-3 text-[13px] text-ink-50 focus:border-ember-500 focus:outline-none">
                {venues.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1.5">
              <FieldLabel htmlFor="tender-budget">Budget</FieldLabel>
              <NumberInput id="tender-budget" value={budget} onValueChange={setBudget} decimals={USDC} unit="USDC" />
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2 text-[12px]">
              <span className="text-ink-400">Price cap</span>
              {(
                [
                  ["price", "Max price per locked token"],
                  ["discount", "Max discount to a declared reference"],
                ] as const
              ).map(([value, label]) => (
                <button key={value} type="button" onClick={() => setMode(value)} aria-pressed={mode === value} className={mode === value ? "rounded-sm border border-ember-500 bg-ember-700/25 px-2 py-0.5 text-ink-50" : "rounded-sm border border-ink-700 px-2 py-0.5 text-ink-300 hover:border-ink-500"}>
                  {label}
                </button>
              ))}
            </div>
            {mode === "price" ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                  <FieldLabel htmlFor="tender-max">Max price per whole locked token</FieldLabel>
                  <NumberInput id="tender-max" value={maxPrice} onValueChange={setMaxPrice} decimals={USDC} unit="USDC" />
                </div>
                <div className="flex flex-col gap-1.5">
                  <FieldLabel htmlFor="tender-ref-opt">Reference price (optional, display only)</FieldLabel>
                  <NumberInput id="tender-ref-opt" value={reference} onValueChange={setReference} decimals={USDC} unit="USDC" />
                </div>
              </div>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                  <FieldLabel htmlFor="tender-ref">Declared reference price</FieldLabel>
                  <NumberInput id="tender-ref" value={reference} onValueChange={setReference} decimals={USDC} unit="USDC" />
                </div>
                <div className="flex flex-col gap-1.5">
                  <FieldLabel htmlFor="tender-discount">Max discount</FieldLabel>
                  <NumberInput id="tender-discount" value={discount} onValueChange={setDiscount} decimals={2} unit="%" />
                </div>
              </div>
            )}
            <Hint>{mode === "discount" ? "The Prices page labels the resulting discount as \"to the issuer-declared reference\". There is no spot oracle on testnet." : "Asks above the max price are never filled."}</Hint>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <FieldLabel htmlFor="tender-opens">Opens (UTC)</FieldLabel>
              <div className="flex items-center gap-2">
                <label className="flex items-center gap-1.5 text-[12px] text-ink-300">
                  <input type="checkbox" checked={opensNow} onChange={(event) => setOpensNow(event.target.checked)} /> now
                </label>
                <Input id="tender-opens" type="datetime-local" value={opensAt} onChange={(event) => setOpensAt(event.target.value)} disabled={opensNow} />
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <FieldLabel htmlFor="tender-closes">Closes (UTC)</FieldLabel>
              <Input id="tender-closes" type="datetime-local" value={closesAt} onChange={(event) => setClosesAt(event.target.value)} />
              <Hint>At most {formatBound(base.limits.maxRoundHorizon)} after the Tender is created.</Hint>
            </div>
          </div>
          <RoundTimingFields value={timing} onChange={setTiming} errors={timingErrors} limits={base.limits} />
          <div className="flex flex-col gap-1.5">
            <FieldLabel htmlFor="tender-retire">Retired units pay to ({cls?.chain ?? "foreign"} address)</FieldLabel>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input id="tender-retire" value={retireTo} onChange={(event) => setRetireTo(event.target.value)} placeholder={cls?.chain === "Solana" ? "base58 address" : "0x…"} />
              {cls ? (
                <Button variant="secondary" onClick={() => setRetireTo(BURN_ADDRESS[cls.chain])}>
                  Burn address
                </Button>
              ) : null}
            </div>
          </div>
          <Preview
            title="Preview"
            rows={[
              { label: "Budget", value: `${formatUsdc(budgetUnits)} USDC` },
              { label: "Fee escrowed (30 bps of the budget, charged on the notional bought)", value: `${formatUsdc(escrow.fee)} USDC` },
              { label: "Escrow debited from your cash at creation", value: `${formatUsdc(escrow.escrow)} USDC`, emphasis: true },
              { label: `Your cash in ${venueLabel(venue, base.symbols)}`, value: venueCash === null ? "—" : `${formatUsdc(venueCash)} USDC` },
              { label: "Max price", value: built && !("error" in built) ? `${formatUsdc(built.args.maxPrice, 6)} USDC per locked token` : "—" },
              { label: "Round storage deposit", value: `${formatNear(base.limits.roundStorageDeposit)} NEAR (kept with the round record)` },
              { label: "Key timeout · reveal window", value: built && !("error" in built) && built.args.window.keyTimeout !== undefined && built.args.window.revealWindow !== undefined ? `${formatBound(built.args.window.keyTimeout)} · ${formatBound(built.args.window.revealWindow)}` : "—" },
            ]}
          />
          {built && "error" in built ? <Hint tone="warning">{built.error}</Hint> : null}
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={() => void launchTender()} disabled={disabledReason !== null || launch.state.status === "loading"} loading={launch.state.status === "loading"} loadingLabel="Creating" title={disabledReason ?? undefined} data-create-tender>
              Create the Tender
            </Button>
            {disabledReason && !(built && "error" in built && built.error === disabledReason) ? <Hint>{disabledReason}</Hint> : null}
          </div>
          <ActionFeedback state={launch.state} onRetry={() => void launchTender()} />
          <p className="text-[12px] text-ink-400">
            Clearing: the price that maximizes the volume bought within the budget, ties to the lowest price. <LearnMore topic="clearing" />
          </p>
        </CardBody>
      </Card>
      <div className="flex flex-col gap-4">
        <Card>
          <CardHeader title="Class" />
          <CardBody>{cls ? <ClassSummary cls={cls} symbols={base.symbols} /> : <p className="text-[13px] text-ink-400">Choose a class.</p>}</CardBody>
        </Card>
        {showDao ? (
          <Card data-dao-panel>
            <CardHeader
              title="Run via DAO"
              description="For treasuries that need an on-chain vote: the same create_tender call wrapped as a Sputnik DAO v2 function-call proposal (shape verified live on testnet, see docs/verification.md). The DAO account must hold the escrow in its engine cash balance before the proposal executes."
              action={<Badge tone="info">Sputnik v2</Badge>}
            />
            <CardBody className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <FieldLabel htmlFor="dao-account">DAO account</FieldLabel>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Input id="dao-account" value={dao} onChange={(event) => setDao(event.target.value)} placeholder="treasury.sputnik-v2.testnet" />
                  <Button variant="secondary" onClick={() => void readPolicy()} disabled={!dao.trim()} data-read-policy>
                    Read the policy
                  </Button>
                </div>
                {policy ? <Hint>Proposal bond {formatNear(policy.proposalBond)} NEAR (attached exactly, refunded on approval){policy.version ? ` · contract version ${policy.version}` : ""}.</Hint> : policyError ? <Hint tone="danger">{policyError}</Hint> : <Hint>get_policy().proposal_bond is read from the DAO; the bond is attached to add_proposal.</Hint>}
              </div>
              <div className="flex flex-col gap-1.5">
                <FieldLabel htmlFor="dao-description">Proposal description</FieldLabel>
                <Input id="dao-description" value={daoDescription} onChange={(event) => setDaoDescription(event.target.value)} />
              </div>
              {proposalJson ? (
                <>
                  <div className="flex items-center justify-between gap-2">
                    <FieldLabel>add_proposal arguments</FieldLabel>
                    <CopyButton text={proposalJson} label="Copy JSON" />
                  </div>
                  <pre className="max-h-56 overflow-auto rounded-md border border-ink-750 bg-ink-900 p-3 font-mono text-[11px] text-ink-200" data-dao-json>
                    {proposalJson}
                  </pre>
                  <div className="flex items-center justify-between gap-2">
                    <FieldLabel>near-cli-rs command</FieldLabel>
                    <CopyButton text={cliCommand ?? ""} label="Copy command" />
                  </div>
                  <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md border border-ink-750 bg-ink-900 p-3 font-mono text-[11px] text-ink-200">
                    {cliCommand}
                  </pre>
                  <div className="flex flex-wrap items-center gap-3">
                    <Button onClick={() => void fileProposal()} disabled={!policy || !wallets.near.accountId || file.state.status === "loading"} loading={file.state.status === "loading"} loadingLabel="Filing" data-file-proposal>
                      File the proposal from my wallet
                    </Button>
                    <Hint>Sputnik DAO has no testnet web UI reachable today (sputnik.fund and AstroDAO testnet hosts do not resolve), so the proposal is filed from here or with the command.</Hint>
                  </div>
                  <ActionFeedback state={file.state} onRetry={() => void fileProposal()} />
                  <div className="flex items-center justify-between gap-2">
                    <FieldLabel>Trezu custom proposal template</FieldLabel>
                    {trezu ? <CopyButton text={trezu} label="Copy manifest" /> : null}
                  </div>
                  <Hint>
                    Manifest DSL version 1 of Trezu (NEAR-DevHub/trezu, docs/CUSTOM_PROPOSAL_TEMPLATES.md): paste it in the Code tab of /&lt;dao&gt;/custom-templates/create. The class, venue and retire-to address are fixed by the template; budget, max price{reference ? ", reference price" : ""} and closing time are member inputs defaulted to the values above.
                  </Hint>
                  {trezu ? (
                    <pre className="max-h-56 overflow-auto rounded-md border border-ink-750 bg-ink-900 p-3 font-mono text-[11px] text-ink-200" data-trezu-json>
                      {trezu}
                    </pre>
                  ) : null}
                </>
              ) : (
                <Hint tone="warning">{built && "error" in built ? built.error : "Fill the Tender form to build the proposal."}</Hint>
              )}
              <p className="text-[12px] text-ink-400">
                Once the DAO approves, the proposal executes and the round appears in <Link href={ROUTES.rounds} className="underline-offset-2 hover:underline">Rounds</Link>. <LearnMore topic="issuer" anchor="5-run-via-dao" />
              </p>
            </CardBody>
          </Card>
        ) : null}
      </div>
    </div>
  );
}
