import type { HTMLAttributes } from "react";
import { cn } from "@/lib/cn";

export type BadgeTone = "neutral" | "ember" | "rose" | "success" | "warning" | "danger" | "info";

const tones: Record<BadgeTone, string> = {
  neutral: "border-ink-600 bg-ink-800 text-ink-200",
  ember: "border-ember-700 bg-ember-700/25 text-ember-300",
  rose: "border-rose-600 bg-rose-700/30 text-rose-300",
  success: "border-success-500/50 bg-success-500/10 text-success-400",
  warning: "border-warning-400/40 bg-warning-400/10 text-warning-400",
  danger: "border-danger-500/60 bg-danger-500/10 text-danger-400",
  info: "border-info-400/40 bg-info-400/10 text-info-400",
};

export function Badge({ tone = "neutral", className, ...rest }: HTMLAttributes<HTMLSpanElement> & { tone?: BadgeTone }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center gap-1.5 rounded-sm border px-1.5 text-[12px] leading-none font-medium",
        tones[tone],
        className,
      )}
      {...rest}
    />
  );
}

/** Network badge shown in the top bar: every rose deployment runs on testnets only. */
export function NetworkBadge({ className }: { className?: string }) {
  return (
    <Badge tone="ember" className={className} title="NEAR testnet, Base Sepolia and Solana devnet. Nothing touches mainnet.">
      <span aria-hidden className="size-[5px] animate-pulse bg-ember-400" />
      Testnet
    </Badge>
  );
}
