"use client";

/**
 * "Create Exit round" (spec 8.3): `create_exit` is open to anyone. Class, cash venue, max price,
 * bidding window, key timeout and reveal window (checked against the `get_limits` bounds, spec
 * 5.6), with the round storage deposit (0.05 NEAR, kept with the round record) shown before
 * signing, then the full transaction flow and a jump to the new round.
 */

import { ONE, outcomeValue, ROUND_STORAGE_DEPOSIT, type ClassInfo, type ConfigView, type Limits, type Venue } from "@rose/sdk";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { LearnMore } from "@/components/chrome/LearnMore";
import { Segmented } from "@/components/ui/Segmented";
import { Button } from "@/components/ui/Button";
import { Field, Input, NumberInput, selectClasses } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { useWallets } from "@/components/wallet/WalletProvider";
import { formatUnits } from "@/lib/format";
import { defaultDurations, durationErrors, horizonError, minutesToNs } from "@/lib/round-window";
import { ROUTES } from "@/lib/routes";
import { useNearAction } from "./actions";
import type { RoundsEngine } from "./engine";
import { symbolOf } from "./engine";
import { deployedCashSymbol } from "@/lib/token-symbols";
import { fractionAt } from "@/lib/unlock-schedule";
import { classLabel, lockedPercent, msToNs, parseDecimal, secondsToNs, shortHex, USDC_DECIMALS } from "./model";
import { RoundTimingFields, type RoundTimingValue } from "./RoundTimingFields";
import { Notice } from "./shared";

const WINDOWS: { label: string; seconds: number }[] = [
  { label: "10 min", seconds: 600 },
  { label: "1 h", seconds: 3600 },
  { label: "24 h", seconds: 86_400 },
  { label: "7 d", seconds: 7 * 86_400 },
];

function venueOptions(config: ConfigView): { id: string; label: string; venue: Venue }[] {
  return [
    { id: "near", label: `tUSDC on NEAR (${config.near_cash_token})`, venue: "Near" },
    ...config.base_cash_tokens.map((token) => ({ id: `base:${token}`, label: `${deployedCashSymbol(token) ?? shortHex(token, 8, 6)} on Base Sepolia (${shortHex(token, 6, 4)})`, venue: { Base: { token } } as Venue })),
  ];
}

const selectClass = selectClasses();

/** The "Custom" segment of the window presets (no preset lasts 0 s). */
const CUSTOM_WINDOW = 0;

export function CreateExitModal({
  open,
  onClose,
  engine,
  classes,
  symbols,
  settings,
  settingsError,
  onRetrySettings,
}: {
  open: boolean;
  onClose: () => void;
  engine: RoundsEngine;
  classes: ClassInfo[];
  symbols: ReadonlyMap<string, string>;
  settings: { config: ConfigView; limits: Limits } | null;
  settingsError: string | null;
  onRetrySettings: () => void;
}) {
  const config = settings?.config ?? null;
  const router = useRouter();
  const { near, restoring } = useWallets();
  const { run, status } = useNearAction();
  const [chosenClassId, setClassId] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [venueId, setVenueId] = useState("near");
  const [maxPrice, setMaxPrice] = useState("");
  const [windowSeconds, setWindowSeconds] = useState(3600);
  const [customCloses, setCustomCloses] = useState("");
  const [useCustom, setUseCustom] = useState(false);
  const [chosenTiming, setTiming] = useState<RoundTimingValue | null>(null);
  const timing = chosenTiming ?? (config ? defaultDurations(config) : { keyTimeout: "", revealWindow: "" });

  const eligible = useMemo(() => classes.filter((cls) => cls.fractionNow < ONE), [classes]);
  const classId = chosenClassId || (eligible[0]?.classId ?? "");
  useEffect(() => {
    if (!open) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [open]);

  const venues = config ? venueOptions(config) : [];
  const selectedVenue = venues.find((v) => v.id === venueId)?.venue ?? "Near";
  const cls = classes.find((c) => c.classId === classId) ?? null;
  const price = parseDecimal(maxPrice, USDC_DECIMALS);
  const closesAtMs = useCustom ? (customCloses ? new Date(customCloses).getTime() : Number.NaN) : now + windowSeconds * 1000;
  const closesValid = Number.isFinite(closesAtMs) && closesAtMs > now + 30_000;
  // f(ts) with the SDK port of the engine's unlock math (granularity, cliffs, Stepped periods), as the Portfolio and the Advance form compute it.
  const fTs = cls && closesValid ? fractionAt(cls, BigInt(Math.floor(closesAtMs / 1000))) : null;
  const fullyUnlocked = fTs !== null && fTs >= ONE;

  const keyTimeout = minutesToNs(timing.keyTimeout);
  const revealWindow = minutesToNs(timing.revealWindow);
  const durations = settings ? durationErrors({ keyTimeout, revealWindow }, settings.limits) : { keyTimeout: null, revealWindow: null };
  const tooFar = settings && closesValid ? horizonError(msToNs(closesAtMs), msToNs(now), settings.limits) : null;

  const errors = {
    price: maxPrice !== "" && (price === null || price <= 0n) ? "Enter a positive price in USDC per locked token." : null,
    closes: useCustom && customCloses !== "" && !closesValid ? "The close must be at least 30 seconds in the future." : tooFar,
    cls: fullyUnlocked ? "This class is fully unlocked at the close time: there is nothing locked to price. Pick an earlier close or another class." : null,
  };
  const ready = near.status === "connected" && settings !== null && cls !== null && price !== null && price > 0n && closesValid && tooFar === null && durations.keyTimeout === null && durations.revealWindow === null && keyTimeout !== null && revealWindow !== null && !fullyUnlocked && status.status !== "busy";

  const submit = async () => {
    if (!ready || !cls || price === null || keyTimeout === null || revealWindow === null) return;
    const call = engine.calls.createExit({ classId: cls.classId, venue: selectedVenue, maxPrice: price, window: { closesAt: secondsToNs(Math.floor(closesAtMs / 1000)), keyTimeout, revealWindow } });
    const result = await run({
      label: "Creating the Exit round",
      call,
      success: (outcome) => {
        const id = outcomeValue(outcome);
        return typeof id === "string" ? `Exit round #${id} created` : "Exit round created";
      },
    });
    if (result.ok) {
      const id = outcomeValue(result.outcome);
      onClose();
      if (typeof id === "string") router.push(`${ROUTES.rounds}/${id}`);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Create an Exit round"
      description="Holders of the class submit sealed asks, buyers submit sealed bids; one uniform clearing price."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={!ready} loading={status.status === "busy"} loadingLabel="Signing…" data-create-exit-submit>
            Create round · {formatUnits(ROUND_STORAGE_DEPOSIT, 24, 2)} NEAR
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {restoring ? <Notice tone="info">Restoring your wallet…</Notice> : near.status !== "connected" ? <Notice tone="warning">Connect a NEAR wallet (or use the demo wallet) to create a round.</Notice> : null}
        {settingsError ? (
          <Notice tone="danger">
            The engine settings (cash venues and round bounds) could not be read: {settingsError}{" "}
            <button type="button" className="underline underline-offset-2" onClick={onRetrySettings} data-retry-settings>
              Retry
            </button>
          </Notice>
        ) : null}
        {eligible.length === 0 ? <Notice tone="info">No class with locked tokens exists yet. Deposit a position first; the class appears here once it is registered.</Notice> : null}
        <Field label="Class" error={errors.cls}>
          {({ inputId, describedBy, invalid }) => (
            <select id={inputId} aria-describedby={describedBy} aria-invalid={invalid || undefined} value={classId} onChange={(event) => setClassId(event.target.value)} className={selectClass}>
              {classes.map((item) => (
                <option key={item.classId} value={item.classId} disabled={item.fractionNow >= ONE}>
                  {classLabel(item, symbolOf(symbols, item))}
                  {item.fractionNow >= ONE ? " (fully unlocked)" : ""}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Cash venue" hint="Every escrow, bond, fee and payout of the round lives in this venue.">
          {({ inputId, describedBy }) => (
            <select id={inputId} aria-describedby={describedBy} value={venueId} onChange={(event) => setVenueId(event.target.value)} className={selectClass}>
              {venues.map((venue) => (
                <option key={venue.id} value={venue.id}>
                  {venue.label}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Max price" hint="Per whole locked token at the close time; orders priced above it stay outside the book. Seller bonds are 1% of their units valued at this price." error={errors.price}>
          {({ inputId, describedBy, invalid }) => (
            <NumberInput id={inputId} aria-describedby={describedBy} invalid={invalid} value={maxPrice} onValueChange={setMaxPrice} unit="USDC" decimals={USDC_DECIMALS} placeholder="8.50" />
          )}
        </Field>
        <Field label="Bidding window" hint="Bids and asks are accepted until the close; settlement prices are taken at that time." error={errors.closes}>
          {({ inputId, describedBy, invalid }) => (
            <div className="flex flex-col gap-2">
              <Segmented
                label="Bidding window presets"
                options={[...WINDOWS.map((preset) => ({ value: preset.seconds, label: preset.label })), { value: CUSTOM_WINDOW, label: "Custom" }]}
                value={useCustom ? CUSTOM_WINDOW : windowSeconds}
                onChange={(value) => {
                  setUseCustom(value === CUSTOM_WINDOW);
                  if (value !== CUSTOM_WINDOW) setWindowSeconds(value);
                }}
                className="flex-wrap"
              />
              {useCustom ? <Input id={inputId} aria-describedby={describedBy} invalid={invalid} type="datetime-local" value={customCloses} onChange={(event) => setCustomCloses(event.target.value)} /> : null}
            </div>
          )}
        </Field>
        {settings ? <RoundTimingFields value={timing} onChange={setTiming} errors={durations} limits={settings.limits} /> : null}
        <dl className="grid grid-cols-2 gap-3 rounded-md border border-ink-750 bg-ink-900 p-3 text-[12px]">
          <div>
            <dt className="text-[11px] text-ink-400 font-medium">Storage deposit</dt>
            <dd className="tabular text-ink-100">{formatUnits(ROUND_STORAGE_DEPOSIT, 24, 2)} NEAR</dd>
            <dd className="text-ink-400">Kept with the round record, its result and its price point.</dd>
          </div>
          <div>
            <dt className="text-[11px] text-ink-400 font-medium">Locked at close</dt>
            <dd className="tabular text-ink-100" data-locked-at-close>
              {fTs === null ? "—" : lockedPercent(fTs)}
            </dd>
            <dd className="text-ink-400">Prices are per locked token at the close time.</dd>
          </div>
        </dl>
        {status.status === "error" ? <Notice tone="danger">{status.error.message}</Notice> : null}
        <LearnMore topic="clearing" label="How an Exit clears" />
      </form>
    </Modal>
  );
}
