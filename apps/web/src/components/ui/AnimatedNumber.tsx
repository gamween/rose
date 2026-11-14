"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";

/** `prefix`, digits (with optional thousands commas), decimals, `suffix`. */
const NUMBER = /^([^\d]*?)(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(.*)$/s;
const DURATION_MS = 650;

function reducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * A formatted number that counts up to its value when it first shows and whenever it changes
 * (adapted from Magic UI's NumberTicker, MIT, see THIRD_PARTY_LICENSES.md: requestAnimationFrame and an ease-out curve instead
 * of a spring, so it needs no animation library). The text is always the exact `value` once the
 * count ends; values that are not a plain number render unchanged. Skipped with reduced motion.
 */
export function AnimatedNumber({ value, className }: { value: string; className?: string }) {
  const [display, setDisplay] = useState(value);
  const previous = useRef<number | null>(null);

  useLayoutEffect(() => {
    const match = NUMBER.exec(value);
    const [, prefix = "", integer = "", fraction = "", suffix = ""] = match ?? [];
    const target = Number(`${integer.replaceAll(",", "")}${fraction}`);
    const from = previous.current ?? 0;
    previous.current = Number.isFinite(target) ? target : null;
    // A second number in the suffix ("45 d 12 h") would stand still while the first counts: show it as is.
    if (!match || !Number.isFinite(target) || from === target || /\d/.test(suffix) || reducedMotion()) {
      setDisplay(value);
      return;
    }
    const digits = Math.max(0, fraction.length - 1);
    const format = new Intl.NumberFormat("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits, useGrouping: integer.includes(",") });
    const start = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / DURATION_MS);
      setDisplay(t >= 1 ? value : `${prefix}${format.format(from + (target - from) * (1 - (1 - t) ** 3))}${suffix}`);
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    tick(start);
    return () => cancelAnimationFrame(frame);
  }, [value]);

  return <span className={cn("tabular", className)}>{display}</span>;
}
