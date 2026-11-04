"use client";

import { useEffect, useState } from "react";
import { formatCountdown } from "@/lib/format";
import { cn } from "@/lib/cn";

/** Live countdown to `target` (epoch milliseconds). Renders `endedLabel` once the target has passed. */
export function Countdown({
  target,
  endedLabel = "Ended",
  onEnd,
  className,
}: {
  target: number;
  endedLabel?: string;
  onEnd?: () => void;
  className?: string;
}) {
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    const tick = () => setNow(Date.now());
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, []);

  const remaining = now === null ? null : target - now;
  const ended = remaining !== null && remaining <= 0;

  useEffect(() => {
    if (ended) onEnd?.();
  }, [ended, onEnd]);

  return (
    <time dateTime={new Date(target).toISOString()} className={cn("tabular", ended ? "text-ink-400" : "text-ink-100", className)}>
      {remaining === null ? "--:--:--" : ended ? endedLabel : formatCountdown(remaining)}
    </time>
  );
}
