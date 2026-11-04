import { cn } from "@/lib/cn";

/** Three pixel blocks lighting in sequence: the dithered loading indicator. */
export function Spinner({ className, label = "Loading" }: { className?: string; label?: string }) {
  return (
    <span role="status" aria-label={label} className={cn("inline-flex items-center gap-[2px]", className)}>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="size-[4px] animate-pulse bg-current"
          style={{ animationDelay: `${i * 160}ms`, animationDuration: "900ms" }}
        />
      ))}
    </span>
  );
}
