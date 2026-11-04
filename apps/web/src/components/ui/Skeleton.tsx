import { cn } from "@/lib/cn";

/** Loading placeholder: a dark block with a dithered (2x2 checker) light band sweeping across. */
export function Skeleton({ className }: { className?: string }) {
  return (
    <span aria-hidden className={cn("relative block overflow-hidden rounded-sm bg-ink-800", className)}>
      <span
        className="absolute inset-0 animate-dither-shimmer"
        style={{
          backgroundImage: "linear-gradient(90deg, transparent, var(--color-ink-500), transparent)",
          backgroundSize: "45% 100%",
          backgroundRepeat: "no-repeat",
          maskImage: "var(--dither-50)",
          WebkitMaskImage: "var(--dither-50)",
          maskSize: "4px 4px",
          WebkitMaskSize: "4px 4px",
        }}
      />
    </span>
  );
}
