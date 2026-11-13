"use client";

import { useEffect, useRef, useState, type HTMLAttributes, type ReactNode, type RefObject } from "react";
import { cn } from "@/lib/cn";
import { CardTitle } from "./Card";

/**
 * The one card that holds a screen's primary action (place an order, deposit, claim): an ember
 * pixel title, an optional right-hand `aside` (a countdown, a balance), the form or button as
 * `children`, and an optional `footer` for one short line or a "Learn more" link. Put it in the
 * `action` slot of `ActionLayout`; a screen has one.
 *
 * ```tsx
 * <ActionCard title="Place bid" aside={<Countdown target={closesAt} />} footer={<LearnMore topic="fees" />}>
 *   <OrderFields … />
 * </ActionCard>
 * ```
 */
export function ActionCard({
  title,
  aside,
  description,
  footer,
  children,
  className,
  ...rest
}: Omit<HTMLAttributes<HTMLElement>, "title"> & { title: ReactNode; aside?: ReactNode; description?: ReactNode; footer?: ReactNode; children: ReactNode }) {
  return (
    <section aria-label={typeof title === "string" ? title : undefined} className={cn("ui-surface rounded-lg", className)} data-action-card {...rest}>
      <header className="flex items-start justify-between gap-3 px-4 pt-3.5">
        <div className="min-w-0">
          <CardTitle accent as="h2">
            {title}
          </CardTitle>
          {description ? <p className="mt-1 text-[12px] leading-snug text-ink-400">{description}</p> : null}
        </div>
        {aside ? <div className="shrink-0 text-right text-[12px] text-ink-300">{aside}</div> : null}
      </header>
      <div className="px-4 pb-4 pt-3">{children}</div>
      {footer ? <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-ink-750 px-4 py-2.5 text-[12px] text-ink-400">{footer}</footer> : null}
    </section>
  );
}

/**
 * The launchpad layout of a detail screen: `header` across the top (title, status, countdown,
 * `KeyStats`), then the content (`children`, usually `Tabs`) on the left and the `action` card on
 * the right, sticky under the top bar from `lg` up. Below `lg` the action comes right after the
 * header, before the tabs. Without `action` the content takes the full width. The action column
 * only sticks while it fits the viewport, so a tall card never hides its own bottom.
 */
export function ActionLayout({ header, action, children, className }: { header: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  const asideRef = useRef<HTMLElement>(null);
  const fits = useFitsViewport(asideRef, STICKY_TOP + 16, Boolean(action));
  return (
    <div className={cn("flex flex-col gap-5", className)}>
      {header}
      <div className={cn("grid items-start gap-5", action ? "lg:grid-cols-[minmax(0,1fr)_400px]" : "")}>
        {action ? (
          <aside ref={asideRef} className={cn("flex min-w-0 flex-col gap-4 lg:col-start-2 lg:row-start-1", fits && "lg:sticky lg:top-[72px]")} data-action-column>
            {action}
          </aside>
        ) : null}
        <div className="flex min-w-0 flex-col gap-4 lg:col-start-1 lg:row-start-1">{children}</div>
      </div>
    </div>
  );
}

/** The top bar height plus the page gap: where a sticky action column rests. */
const STICKY_TOP = 72;

/** Whether the element (rendered while `mounted`) is no taller than the viewport minus `margin`, tracked on resize. */
function useFitsViewport(ref: RefObject<HTMLElement | null>, margin: number, mounted: boolean): boolean {
  const [fits, setFits] = useState(true);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setFits(element.offsetHeight <= window.innerHeight - margin);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [ref, margin, mounted]);
  return fits;
}
