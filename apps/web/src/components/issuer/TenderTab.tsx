"use client";

import { outcomeValue, type Cash, type ClassInfo, type FunctionCall, type TenderArgs } from "@rose/sdk";
import { useEffect, useMemo, useState } from "react";
import { LearnMore } from "@/components/chrome/LearnMore";
import { Segmented } from "@/components/ui/Segmented";
import { Button } from "@/components/ui/Button";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Input, NumberInput, selectClasses } from "@/components/ui/Input";
import { useWallets } from "@/components/wallet/WalletProvider";
import { formatUsdc, parseAmount, sameVenue, venueLabel } from "@/lib/amounts";
import { txLinks } from "@/lib/explorer";
import { defaultDurations, durationErrors, formatBound, minutesToNs } from "@/lib/round-window";
import { ROUTES } from "@/lib/routes";
import { useAction } from "@/lib/use-action";
import { RoundTimingFields, type RoundTimingValue } from "@/components/rounds/RoundTimingFields";
import { secondsToDateTime } from "./class-schedule";
import { DaoPanel } from "./DaoPanel";
import { ActionFeedback, ClassPicker, ClassSummary, defaultRoundClass, FieldLabel, formatNear, Hint, Preview, useVenueOptions, type IssuerBase } from "./shared";
import { BURN_ADDRESS, percentToBps, tenderArgsFromForm, tenderEscrow, type TenderFormValues } from "./tender-form";

const USDC = 6;

type Built = { args: TenderArgs; call: FunctionCall } | { error: string };

/** Tabs 4 and 6: the Tender form with its live preview, launched directly or wrapped for a Sputnik DAO and Trezu. */
export function TenderTab({ base, initialClassId, showDao, onCash }: { base: IssuerBase; initialClassId?: string; showDao: boolean; onCash?: (cash: Cash[]) => void }) {
  const wallets = useWallets();
  const venues = useVenueOptions(base);
  const [classId, setClassId] = useState(initialClassId ?? defaultRoundClass(base.classes));
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
  const launch = useAction();
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
      unlock: cls,
      engine: base.config,
    };
    const result = tenderArgsFromForm(values, now, base.limits);
    if ("error" in result) return result;
    return { args: result.args, call: base.engine.calls.createTender(result.args) };
  }, [base.config, base.engine.calls, base.limits, budget, closesAt, cls, discount, maxPrice, mode, now, opensAt, opensNow, reference, retireTo, timing, venue]);
  const timingErrors = durationErrors({ keyTimeout: minutesToNs(timing.keyTimeout), revealWindow: minutesToNs(timing.revealWindow) }, base.limits);

  const budgetUnits = parseAmount(budget, USDC) ?? 0n;
  const escrow = tenderEscrow(budgetUnits);
  const venueCash = cash?.find((entry) => sameVenue(entry.venue, venue))?.amount ?? null;
  const shortfall = venueCash !== null && venueCash < escrow.escrow ? escrow.escrow - venueCash : 0n;

  const launchTender = () =>
    launch.run("Creating the Tender", async () => {
      if (!built || "error" in built) throw new Error("Fix the form first.");
      const outcome = await wallets.sendNearCall(built.call);
      const roundId = String(outcomeValue(outcome) ?? "");
      return { message: roundId ? `Tender #${roundId} created` : "Tender created", links: [...txLinks("near", outcome.transaction.hash), ...(roundId ? [{ href: `${ROUTES.rounds}/${roundId}`, label: `Round #${roundId}` }] : [])] };
    });

  const ready = built && !("error" in built) ? built : null;

  const disabledReason = !wallets.near.accountId ? "Connect a NEAR wallet (the issuer)." : !cls ? "Choose a class." : built && "error" in built ? built.error : shortfall > 0n ? `Fund ${formatUsdc(shortfall)} more in ${venueLabel(venue, base.symbols)} first (Fund tab).` : null;

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
      <Card>
        <CardHeader title="Launch a Tender" description="One public buyer (you), a public budget and max price, sealed asks from holders, one uniform clearing price. Units bought are retired: their unlocked tokens go to the address you choose." />
        <CardBody className="flex flex-col gap-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5 sm:col-span-2">
              <FieldLabel htmlFor="tender-class">Class</FieldLabel>
              <ClassPicker id="tender-class" classes={base.classes} symbols={base.symbols} value={classId} onChange={setClassId} lockedOnly />
            </div>
            <div className="flex flex-col gap-1.5">
              <FieldLabel htmlFor="tender-venue">Cash venue</FieldLabel>
              <select id="tender-venue" value={venueId} onChange={(event) => setVenueId(event.target.value)} className={selectClasses()}>
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
            <div className="flex flex-wrap items-center gap-2 text-[12px]">
              <span className="text-ink-400">Price cap</span>
              <Segmented
                className="flex-wrap"
                label="Price cap"
                options={[
                  { value: "price", label: "Max price per locked token" },
                  { value: "discount", label: "Max discount to a declared reference" },
                ]}
                value={mode}
                onChange={setMode}
              />
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
        {showDao ? <DaoPanel base={base} venue={venue} ready={ready} escrow={escrow.escrow} /> : null}
      </div>
    </div>
  );
}
