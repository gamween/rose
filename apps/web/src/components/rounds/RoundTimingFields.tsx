"use client";

/**
 * Key timeout and reveal window of a new round (spec 5.6), prefilled with the engine defaults
 * and checked inline against the bounds `get_limits` reports. Shared by the Exit, Tender and
 * Advance forms.
 */

import { Field, NumberInput } from "@/components/ui/Input";
import { boundsHint, type WindowBounds } from "@/lib/round-window";

export type RoundTimingValue = { keyTimeout: string; revealWindow: string };

export function RoundTimingFields({ value, onChange, errors, limits }: { value: RoundTimingValue; onChange: (value: RoundTimingValue) => void; errors: { keyTimeout: string | null; revealWindow: string | null }; limits: WindowBounds }) {
  return (
    <div className="flex flex-col gap-1.5" data-round-timing>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Key timeout" hint="After the close, how long the MPC key may take before anyone can cancel." error={errors.keyTimeout}>
          {({ inputId, describedBy, invalid }) => <NumberInput id={inputId} aria-describedby={describedBy} invalid={invalid} value={value.keyTimeout} onValueChange={(keyTimeout) => onChange({ ...value, keyTimeout })} decimals={0} unit="min" data-key-timeout />}
        </Field>
        <Field label="Reveal window" hint="After the key, how long orders can be opened before clearing." error={errors.revealWindow}>
          {({ inputId, describedBy, invalid }) => <NumberInput id={inputId} aria-describedby={describedBy} invalid={invalid} value={value.revealWindow} onValueChange={(revealWindow) => onChange({ ...value, revealWindow })} decimals={0} unit="min" data-reveal-window />}
        </Field>
      </div>
      <p className="text-[12px] text-ink-500">{boundsHint(limits)}</p>
    </div>
  );
}
