"use client";

import { useId, type InputHTMLAttributes, type ReactNode } from "react";
import { cn } from "@/lib/cn";

/** Recessed field (`.ui-field`): sits below the surface, ember border and inner ring on focus. */
const fieldBase = "ui-field h-9 w-full px-3 text-[13px] placeholder:text-ink-500";

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
      <label htmlFor={id} className="text-[12px] text-ink-300 font-medium">
        {label}
      </label>
      {children({ inputId: id, describedBy, invalid: Boolean(error) })}
      {hint && !error ? (
        <p id={hintId} className="text-[12px] leading-snug text-ink-400">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} role="alert" className="flex items-start gap-1.5 text-[12px] leading-snug text-danger-400">
          <span aria-hidden className="mt-[5px] size-[5px] shrink-0 bg-danger-400" />
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function Input({ className, invalid = false, ...rest }: InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) {
  return <input className={cn(fieldBase, className)} aria-invalid={invalid || undefined} {...rest} />;
}

/** Classes of a native `<select>` styled as a field with a pixel chevron (keyboard and mobile pickers stay native). */
export function selectClasses(className?: string, size: "sm" | "md" = "md", fullWidth = true): string {
  return cn("ui-field ui-select pl-3 text-[13px]", fullWidth && "w-full", size === "sm" ? "h-8" : "h-9", className);
}

export type NumberInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "value" | "onChange" | "size" | "max"> & {
  value: string;
  onValueChange: (value: string) => void;
  unit?: ReactNode;
  /** Maximum number of fraction digits accepted (token decimals). */
  decimals?: number;
  invalid?: boolean;
  /** A value the "Max" add-on fills in (for example the user's balance). */
  max?: string;
  /** `lg` is the amount field of an order panel. */
  size?: "md" | "lg";
};

/**
 * Decimal input kept as a string (no float rounding), with a unit add-on such as "USDC" and an
 * optional "Max" button. Rejects keystrokes that would make the value non-numeric or exceed `decimals`.
 */
export function NumberInput({ value, onValueChange, unit, decimals = 6, invalid = false, max, size = "md", className, ...rest }: NumberInputProps) {
  const pattern = decimals > 0 ? new RegExp(`^\\d*(\\.\\d{0,${decimals}})?$`) : /^\d*$/;
  return (
    <div className={cn("ui-field relative flex items-stretch", size === "lg" ? "h-11" : "h-9", className)} data-invalid={invalid || undefined}>
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
        className={cn(
          "tabular min-w-0 flex-1 bg-transparent px-3 text-ink-50 placeholder:text-ink-500 focus:outline-none focus-visible:outline-none",
          size === "lg" ? "text-[16px]" : "text-[13px]",
        )}
      />
      {max !== undefined ? (
        <button
          type="button"
          onClick={() => onValueChange(max)}
          disabled={rest.disabled}
          className="my-1.5 shrink-0 rounded-sm px-1.5 text-[11px] text-ember-300 transition-colors hover:bg-ink-800 hover:text-ember-200 disabled:opacity-50 font-medium"
        >
          Max
        </button>
      ) : null}
      {unit ? (
        <span className="pointer-events-none flex shrink-0 items-center border-l border-ink-750 px-3 text-[12px] text-ink-300 font-medium">
          {unit}
        </span>
      ) : null}
    </div>
  );
}
