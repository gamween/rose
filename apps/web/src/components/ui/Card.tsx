import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/cn";

/** A raised surface (`.ui-surface`): hairline border and a lit top edge, no drop shadow. */
export function Card({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("ui-surface rounded-lg", className)} {...rest} />;
}

/** A section title led by a square pixel marker (`accent` turns it ember, for the panel that holds the page's main action). */
export function CardTitle({ children, accent = false, as: Tag = "h3", className }: { children: ReactNode; accent?: boolean; as?: "h2" | "h3"; className?: string }) {
  return (
    <Tag className={cn("flex items-center gap-2 text-[13px] text-ink-50 font-semibold", className)}>
      <span aria-hidden className={cn("size-[5px] shrink-0", accent ? "bg-ember-500" : "bg-ink-500")} />
      {children}
    </Tag>
  );
}

export function CardHeader({
  title,
  description,
  action,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-start justify-between gap-4 border-b border-ink-750 px-4 py-3", className)}>
      <div className="min-w-0">
        <CardTitle>{title}</CardTitle>
        {description ? <p className="mt-1 text-[12px] leading-snug text-ink-400">{description}</p> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

export function CardBody({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("p-4", className)} {...rest} />;
}
