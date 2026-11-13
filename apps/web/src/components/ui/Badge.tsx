import type { HTMLAttributes } from "react";
import { cn } from "@/lib/cn";

export type BadgeTone = "neutral" | "ember" | "rose" | "success" | "warning" | "danger" | "info";

/** A neutral chip carries its meaning in a square pixel "LED"; only the text of strong states is tinted. */
const tones: Record<BadgeTone, { led: string; text: string }> = {
  neutral: { led: "bg-ink-400", text: "text-ink-200" },
  ember: { led: "bg-ember-400", text: "text-ember-200" },
  rose: { led: "bg-rose-400", text: "text-rose-300" },
  success: { led: "bg-success-400", text: "text-ink-100" },
  warning: { led: "bg-warning-400", text: "text-warning-400" },
  danger: { led: "bg-danger-400", text: "text-danger-400" },
  info: { led: "bg-info-400", text: "text-ink-100" },
};

export function Badge({
  tone = "neutral",
  led = tone !== "neutral",
  live = false,
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLSpanElement> & { tone?: BadgeTone; led?: boolean; live?: boolean }) {
  const style = tones[tone];
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center gap-1.5 whitespace-nowrap rounded-sm border border-ink-700 bg-ink-900 px-1.5 text-[11.5px] leading-none font-medium",
        style.text,
        className,
      )}
      {...rest}
    >
      {led ? <span aria-hidden className={cn("size-[5px] shrink-0", style.led, live && "animate-pixel-blink")} /> : null}
      {children}
    </span>
  );
}

/** Network badge shown in the top bar: every rose deployment runs on testnets only. `detail` adds a sentence to its title. */
export function NetworkBadge({ className, detail }: { className?: string; detail?: string }) {
  return (
    <Badge tone="ember" live className={className} title={`NEAR testnet, Base Sepolia and Solana devnet. Nothing here has value.${detail ? ` ${detail}` : ""}`}>
      Testnet
    </Badge>
  );
}
