import { cn } from "@/lib/cn";

const tones = { ember: "bg-ember-500", success: "bg-success-500", danger: "bg-danger-500", neutral: "bg-ink-500" } as const;

/** A thin recessed track whose fill ends on a dithered pixel edge (`.ui-progress-fill`). Decorative: say the value in text too. */
export function ProgressBar({ value, tone = "ember", className }: { value: number; tone?: keyof typeof tones; className?: string }) {
  const percent = Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <div className={cn("h-1 w-full rounded-sm bg-(--surface-inset) shadow-[inset_0_0_0_1px_var(--color-ink-800)]", className)} aria-hidden>
      <div className={cn("ui-progress-fill rounded-l-sm", tones[tone], percent === 100 && "rounded-r-sm after:hidden")} style={{ width: `${String(percent)}%` }} />
    </div>
  );
}
