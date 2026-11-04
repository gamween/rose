"use client";

import { useId, type InputHTMLAttributes, type ReactNode } from "react";
import { cn } from "@/lib/cn";

const fieldBase =
  "h-9 w-full rounded-md border bg-ink-900 px-3 text-[13px] text-ink-50 placeholder:text-ink-500 transition-colors focus:outline-none focus-visible:outline-none disabled:opacity-50";

function fieldTone(invalid: boolean): string {
  return invalid
    ? "border-danger-500 focus:border-danger-400"
    : "border-ink-700 hover:border-ink-600 focus:border-ember-500";
}

export type FieldProps = {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  children: (ids: { inputId: string; describedBy: string | undefined; invalid: boolean }) => ReactNode;
  className?: string;
};

/** Label, control, hint and error wiring with `aria-describedby` and `aria-invalid`. */
export function Field({ label, hint, error, children, className }: FieldProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label htmlFor={id} className="font-display text-[11px] uppercase tracking-wide text-ink-300">
        {label}
      </label>
      {children({ inputId: id, describedBy, invalid: Boolean(error) })}
      {hint && !error ? (
        <p id={hintId} className="text-[12px] text-ink-400">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} role="alert" className="text-[12px] text-danger-400">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function Input({ className, invalid = false, ...rest }: InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) {
  return <input className={cn(fieldBase, fieldTone(invalid), className)} aria-invalid={invalid || undefined} {...rest} />;
}

export type NumberInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "value" | "onChange"> & {
  value: string;
  onValueChange: (value: string) => void;
  unit?: ReactNode;
  /** Maximum number of fraction digits accepted (token decimals). */
  decimals?: number;
  invalid?: boolean;
};

/**
 * Decimal input kept as a string (no float rounding), with a unit suffix such as "USDC".
 * Rejects keystrokes that would make the value non-numeric or exceed `decimals`.
 */
export function NumberInput({ value, onValueChange, unit, decimals = 6, invalid = false, className, ...rest }: NumberInputProps) {
  const pattern = decimals > 0 ? new RegExp(`^\\d*(\\.\\d{0,${decimals}})?$`) : /^\d*$/;
  return (
    <div className={cn("relative flex items-center", className)}>
      <input
        {...rest}
        type="text"
        inputMode="decimal"
        autoComplete="off"
        spellCheck={false}
        value={value}
        aria-invalid={invalid || undefined}
        onChange={(event) => {
          const next = event.target.value.replace(",", ".");
          if (pattern.test(next)) onValueChange(next);
        }}
        className={cn(fieldBase, fieldTone(invalid), "tabular", unit ? "pr-16" : undefined)}
      />
      {unit ? (
        <span className="pointer-events-none absolute right-3 font-display text-[11px] uppercase tracking-wide text-ink-400">
          {unit}
        </span>
      ) : null}
    </div>
  );
}
