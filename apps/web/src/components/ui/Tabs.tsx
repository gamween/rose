"use client";

import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { useEdgeFade } from "./edge-fade";

export type TabItem<T extends string> = { id: T; label: ReactNode; count?: number };

/**
 * Accessible tab list (WAI-ARIA tabs pattern, arrow keys, Home and End). Pair it with `TabPanel`
 * through the same `idBase` (from `useTabs`) so each panel is labelled by its tab; without
 * `idBase` the list still works for a caller that renders its own `role="tabpanel"`.
 */
export function Tabs<T extends string>({
  items,
  value,
  onChange,
  label,
  idBase,
  className,
}: {
  items: readonly TabItem<T>[];
  value: T;
  onChange: (value: T) => void;
  label: string;
  idBase?: string;
  className?: string;
}) {
  const autoId = useId();
  const baseId = idBase ?? autoId;
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const list = useRef<HTMLDivElement>(null);
  // On a narrow screen the row scrolls sideways: fade the edge that hides tabs, measured again when
  // a tab or a count changes.
  const edgeFade = useEdgeFade(list, items.map((item) => `${item.id}:${item.count ?? ""}`).join("|"));

  // Keep the selected tab inside the row (a deep link such as `#storage` may select one that starts
  // off screen), scrolling the row only, never the page.
  useEffect(() => {
    const element = list.current;
    const tab = element?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    if (!element || !tab) return;
    const left = tab.offsetLeft;
    const right = left + tab.offsetWidth;
    if (left < element.scrollLeft) element.scrollLeft = Math.max(0, left - 24);
    else if (right > element.scrollLeft + element.clientWidth) element.scrollLeft = right - element.clientWidth + 24;
  }, [value]);

  const focusAt = (index: number) => {
    const count = items.length;
    const next = ((index % count) + count) % count;
    refs.current[next]?.focus();
    const item = items[next];
    if (item) onChange(item.id);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === "ArrowRight") focusAt(index + 1);
    else if (event.key === "ArrowLeft") focusAt(index - 1);
    else if (event.key === "Home") focusAt(0);
    else if (event.key === "End") focusAt(items.length - 1);
    else return;
    event.preventDefault();
  };

  return (
    // The bottom rule is an inset shadow, not a border: the row scrolls sideways on a narrow screen
    // (labels never wrap) and the selected tab's underline still paints over the rule.
    <div
      ref={list}
      role="tablist"
      aria-label={label}
      style={edgeFade.style}
      data-overflow={edgeFade.overflow ? "true" : undefined}
      className={cn("relative flex items-center gap-1 overflow-x-auto overflow-y-hidden shadow-[inset_0_-1px_0_var(--color-ink-750)] [scrollbar-width:none]", className)}
    >
      {items.map((item, index) => {
        const selected = item.id === value;
        return (
          <button
            key={item.id}
            ref={(element) => {
              refs.current[index] = element;
            }}
            type="button"
            role="tab"
            id={tabId(baseId, item.id)}
            aria-selected={selected}
            aria-controls={panelId(baseId, item.id)}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(item.id)}
            onKeyDown={(event) => onKeyDown(event, index)}
            data-tab={item.id}
            className={cn(
              "relative flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-3 text-[13px] font-medium transition-colors",
              selected ? "border-ember-500 text-ink-50" : "border-transparent text-ink-400 hover:border-ink-600 hover:text-ink-100",
            )}
          >
            {item.label}
            {item.count !== undefined ? (
              <span className={cn("tabular rounded-sm px-1 text-[11px] leading-4", selected ? "bg-ember-700/40 text-ember-200" : "bg-ink-800 text-ink-300")}>{item.count}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

function tabId(base: string, id: string): string {
  return `${base}-tab-${id}`;
}

function panelId(base: string, id: string): string {
  return `${base}-panel-${id}`;
}

/**
 * The panel of one tab: rendered only while its tab is selected (one panel at a time), labelled by
 * the tab with the same `id` in the `Tabs` sharing `idBase`.
 */
export function TabPanel<T extends string>({ idBase, id, value, children, className }: { idBase: string; id: T; value: T; children: ReactNode; className?: string }) {
  if (id !== value) return null;
  return (
    <div role="tabpanel" id={panelId(idBase, id)} aria-labelledby={tabId(idBase, id)} tabIndex={0} data-tab-panel={id} className={cn("outline-none", className)}>
      {children}
    </div>
  );
}

/**
 * Tab state for `Tabs` + `TabPanel`. The selected tab is the one the user picked while it is still
 * offered, otherwise `fallback` (the tab that is useful for the current state, which may change as
 * the data does). With `hash`, the pick is mirrored in the URL hash (`#details`) so a tab can be
 * linked to and survives a reload; the hash is read after mount, so server and client render the
 * fallback first.
 *
 * ```tsx
 * const tabs = useTabs(items.map((item) => item.id), "overview", { hash: true });
 * <Tabs items={items} value={tabs.value} onChange={tabs.select} idBase={tabs.idBase} label="Round sections" />
 * <TabPanel idBase={tabs.idBase} id="overview" value={tabs.value}>…</TabPanel>
 * ```
 */
export function useTabs<T extends string>(ids: readonly T[], fallback: T, { hash = false }: { hash?: boolean } = {}): { value: T; select: (id: T) => void; idBase: string } {
  const idBase = useId();
  const [picked, setPicked] = useState<T | null>(null);
  const key = ids.join("|");

  useEffect(() => {
    if (!hash) return;
    const read = () => {
      const fromHash = decodeURIComponent(window.location.hash.slice(1));
      if (key.split("|").includes(fromHash)) setPicked(fromHash as T);
    };
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, [hash, key]);

  const select = useCallback(
    (id: T) => {
      setPicked(id);
      if (hash) window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}#${id}`);
    },
    [hash],
  );

  const value = picked !== null && ids.includes(picked) ? picked : fallback;
  return { value, select, idBase };
}
