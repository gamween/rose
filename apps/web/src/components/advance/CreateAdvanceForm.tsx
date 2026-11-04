"use client";

import { ONE, type Venue } from "@rose/sdk";
import { useState } from "react";
import { LearnMore } from "@/components/chrome/LearnMore";
import { Button } from "@/components/ui/Button";
import { Field, Input, NumberInput } from "@/components/ui/Input";
import { amountToText, formatAmount, formatFraction, formatUsdc, formatDate, nsToMs, parseAmount, sameVenue, venueLabel } from "@/lib/amounts";
import { USDC_DECIMALS } from "@/lib/engine";
import { fractionAt } from "@/lib/unlock-schedule";
import { classLabel } from "@/components/portfolio/data";
import type { AdvanceData } from "./data";
import { holderBond, maxClaim, validateAdvance } from "./math";

export type AdvanceSubmission = { classId: string; venue: Venue; units: bigint; claim: bigint; minFill: bigint; maxPrice: bigint; reserve: bigint; closesAtNs: bigint };

const selectClass = "h-9 w-full rounded-md border border-ink-700 bg-ink-900 px-3 text-[13px] text-ink-50 focus:border-ember-500 focus:outline-none";

function defaultCloseLocal(nowMs: number): string {
  const date = new Date(nowMs + 24 * 3600 * 1000);
  date.setSeconds(0, 0);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** The holder's form: units `X`, claim `K` bounded live by `X (1 - f(ts))`, sealed reserve, min fill, ceiling, venue and window. */
export function CreateAdvanceForm({ data, account, busy, onSubmit }: { data: AdvanceData; account: string; busy: boolean; onSubmit: (submission: AdvanceSubmission) => void }) {
  const holdings = data.holdings.filter((holding) => holding.balance > 0n && data.classes.has(holding.classId));
  const [chosenClassId, setClassId] = useState("");
  /** The chosen class, or the first held one while nothing was chosen (holdings can arrive after mount). */
  const classId = holdings.some((item) => item.classId === chosenClassId) ? chosenClassId : (holdings[0]?.classId ?? "");
  const [units, setUnits] = useState("");
  const [claim, setClaim] = useState("");
  const [reserve, setReserve] = useState("");
  const [minFill, setMinFill] = useState("");
  const [maxPrice, setMaxPrice] = useState("");
  const [venueKey, setVenueKey] = useState("near");
  const [closesAt, setClosesAt] = useState(() => defaultCloseLocal(Number(data.blockTimeSec) * 1000));
  const [touched, setTouched] = useState(false);

  const holding = holdings.find((item) => item.classId === classId) ?? null;
  const info = holding ? data.classes.get(holding.classId) ?? null : null;
  const decimals = info?.decimals ?? 18;
  const venues: { key: string; venue: Venue; label: string }[] = [
    { key: "near", venue: "Near", label: "NEAR tUSDC" },
    ...data.config.base_cash_tokens.map((token) => ({ key: token.toLowerCase(), venue: { Base: { token: token.toLowerCase() } } as Venue, label: venueLabel({ Base: { token } }, data.symbols) })),
  ];
  const venue = venues.find((item) => item.key === venueKey)?.venue ?? "Near";
  const closesAtMs = closesAt ? new Date(closesAt).getTime() : NaN;
  const closesAtSec = Number.isFinite(closesAtMs) ? BigInt(Math.floor(closesAtMs / 1000)) : null;
  const fTs = info && closesAtSec !== null ? fractionAt(info, closesAtSec) : null;

  const form = {
    units: parseAmount(units, decimals),
    claim: parseAmount(claim, decimals),
    reserve: parseAmount(reserve, USDC_DECIMALS),
    minFill: parseAmount(minFill, decimals),
    maxPrice: parseAmount(maxPrice, USDC_DECIMALS),
    closesAtMs: Number.isFinite(closesAtMs) ? closesAtMs : null,
  };
  const kMax = form.units !== null && fTs !== null ? maxClaim(form.units, fTs) : null;
  const bond = form.claim !== null && form.maxPrice !== null && form.claim > 0n && form.maxPrice > 0n ? holderBond(form.claim, form.maxPrice, decimals, data.limits.bondFloor) : null;
  const cash = data.cash.find((entry) => sameVenue(entry.venue, venue))?.amount ?? 0n;
  const errors = holding && fTs !== null ? validateAdvance(form, { freeUnits: holding.balance, fTs, nowMs: Number(data.blockTimeSec) * 1000, cash, bond }) : { units: "Choose a class you hold free units of" };
  const valid = Object.keys(errors).length === 0 && holding !== null && info !== null && closesAtSec !== null;
  const show = (key: keyof typeof errors) => (touched ? errors[key] : undefined);

  if (holdings.length === 0) {
    return (
      <p className="text-[13px] text-ink-400">
        You hold no free units on {account}. Deposit a position or buy units in an Exit round first. <LearnMore topic="wallets" label="Holder guide" />
      </p>
    );
  }

  return (
    <form
      className="flex flex-col gap-4"
      data-advance-form
      onSubmit={(event) => {
        event.preventDefault();
        setTouched(true);
        if (!valid || !holding || form.units === null || form.claim === null || form.minFill === null || form.maxPrice === null || form.reserve === null || closesAtSec === null) return;
        onSubmit({ classId: holding.classId, venue, units: form.units, claim: form.claim, minFill: form.minFill, maxPrice: form.maxPrice, reserve: form.reserve, closesAtNs: closesAtSec * 1_000_000_000n });
      }}
    >
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field label="Class" hint={info ? `${formatAmount(holding?.balance ?? 0n, decimals)} free units · ${formatFraction(fractionAt(info, data.blockTimeSec))} unlocked now` : undefined}>
          {({ inputId }) => (
            <select id={inputId} value={classId} onChange={(event) => setClassId(event.target.value)} className={selectClass}>
              {holdings.map((item) => {
                const cls = data.classes.get(item.classId)!;
                return (
                  <option key={item.classId} value={item.classId}>
                    {classLabel(cls, data.symbols)} · {cls.chain} · {formatAmount(item.balance, cls.decimals)} free
                  </option>
                );
              })}
            </select>
          )}
        </Field>
        <Field label="Bidding closes at (settlement time ts)" error={show("closesAtMs")} hint={fTs !== null ? `f(ts) = ${formatFraction(fTs, 2)} unlocked at settlement` : undefined}>
          {({ inputId, invalid }) => <Input id={inputId} type="datetime-local" value={closesAt} onChange={(event) => setClosesAt(event.target.value)} invalid={invalid} />}
        </Field>
        <Field label="Units to encumber (X)" error={show("units")} hint="Encumbered units cannot be transferred or enter another round until the claim is delivered.">
          {({ inputId, invalid }) => (
            <div className="flex items-center gap-2">
              <NumberInput id={inputId} value={units} onValueChange={setUnits} decimals={decimals} unit={info ? classLabel(info, data.symbols) : undefined} invalid={invalid} className="flex-1" />
              <Button type="button" size="md" variant="ghost" onClick={() => holding && setUnits(amountToText(holding.balance, decimals))}>
                Max
              </Button>
            </div>
          )}
        </Field>
        <Field label="Claim (K): first tokens to unlock" error={show("claim")} hint={kMax !== null ? `K ≤ X · (1 − f(ts)) = ${formatAmount(kMax, decimals)} tokens` : "Enter X first"}>
          {({ inputId, invalid }) => (
            <div className="flex items-center gap-2">
              <NumberInput id={inputId} value={claim} onValueChange={setClaim} decimals={decimals} invalid={invalid} className="flex-1" />
              <Button type="button" size="md" variant="ghost" disabled={kMax === null} onClick={() => kMax !== null && setClaim(amountToText(kMax, decimals))}>
                Max
              </Button>
            </div>
          )}
        </Field>
        <Field label="Sealed reserve price per claimed token" error={show("reserve")} hint="Encrypted in your browser; the floor below which you do not sell. The clearing price can land above it.">
          {({ inputId, invalid }) => <NumberInput id={inputId} value={reserve} onValueChange={setReserve} decimals={USDC_DECIMALS} unit="USDC" invalid={invalid} />}
        </Field>
        <Field label="Public price ceiling per claimed token" error={show("maxPrice")} hint={bond !== null ? `Values your bond: ${formatUsdc(bond)} USDC (1% of K at the ceiling, at least ${formatUsdc(data.limits.bondFloor)}); you hold ${formatUsdc(cash)} in the venue.` : "Bids above it stay out of the book; also values your bond."}>
          {({ inputId, invalid }) => <NumberInput id={inputId} value={maxPrice} onValueChange={setMaxPrice} decimals={USDC_DECIMALS} unit="USDC" invalid={invalid} />}
        </Field>
        <Field label="Minimum fill (public)" error={show("minFill")} hint="Below this filled volume nothing crosses and the round is cancelled.">
          {({ inputId, invalid }) => <NumberInput id={inputId} value={minFill} onValueChange={setMinFill} decimals={decimals} invalid={invalid} />}
        </Field>
        <Field label="Cash venue" hint="Funders escrow, bonds and your proceeds live in this venue.">
          {({ inputId }) => (
            <select id={inputId} value={venueKey} onChange={(event) => setVenueKey(event.target.value)} className={selectClass}>
              {venues.map((item) => (
                <option key={item.key} value={item.key}>
                  {item.label}
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>
      <div className="rounded-md border border-ink-750 bg-ink-900 px-3 py-2 text-[12px] text-ink-300" data-advance-preview>
        <p>
          Round storage deposit 0.05 NEAR (kept with the round record) plus 0.02 NEAR for the sealed ask (refunded at settlement). Key timeout {Math.round(nsToMs(BigInt(data.config.default_key_timeout)) / 60_000)} min, reveal window {Math.round(nsToMs(BigInt(data.config.default_reveal_window)) / 60_000)} min.
          {Number.isFinite(closesAtMs) ? ` Closes ${formatDate(closesAtMs)}.` : ""}
        </p>
        <p className="mt-1">
          Two transactions: <code className="font-mono">create_advance</code> locks X and opens the round, then <code className="font-mono">place_ask</code> seals your reserve (quantity K) and takes the bond. When demand is short the price follows the Exit rule: the midpoint of the tie interval, possibly above your reserve. <LearnMore topic="clearing" />
        </p>
        {fTs !== null && fTs >= ONE ? <p className="mt-1 text-danger-400">The class is fully unlocked at that settlement time.</p> : null}
      </div>
      <div className="flex justify-end">
        <Button type="submit" disabled={busy || (touched && !valid)} loading={busy} loadingLabel="Creating" data-advance-submit>
          Create the Advance and seal my reserve
        </Button>
      </div>
    </form>
  );
}
