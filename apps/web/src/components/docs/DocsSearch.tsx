"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { cn } from "@/lib/cn";
import type { SearchEntry } from "./types";
import { searchDocs } from "./search";

/** Client-side search over page titles and headings; arrows move, Enter opens, Escape closes. */
export function DocsSearch({ index, onNavigate, className }: { index: SearchEntry[]; onNavigate?: () => void; className?: string }) {
  const router = useRouter();
  const listId = useId();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const hits = useMemo(() => searchDocs(index, query), [index, query]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const go = (href: string) => {
    setOpen(false);
    setQuery("");
    onNavigate?.();
    router.push(href);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      setOpen(true);
      setActive((index) => Math.min(index + 1, Math.max(hits.length - 1, 0)));
    } else if (event.key === "ArrowUp") {
      setActive((index) => Math.max(index - 1, 0));
    } else if (event.key === "Enter") {
      const hit = hits[active];
      if (hit) go(hit.href);
    } else if (event.key === "Escape") {
      setOpen(false);
    } else return;
    event.preventDefault();
  };

  const showList = open && query.trim().length > 0;

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      <label className="sr-only" htmlFor={`${listId}-input`}>
        Search the docs
      </label>
      <input
        id={`${listId}-input`}
        type="search"
        role="combobox"
        aria-expanded={showList}
        aria-controls={`${listId}-list`}
        aria-activedescendant={showList && hits[active] ? `${listId}-option-${active}` : undefined}
        aria-autocomplete="list"
        autoComplete="off"
        placeholder="Search titles and headings"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        className="h-9 w-full rounded-md border border-ink-700 bg-ink-900 px-3 text-[13px] text-ink-50 placeholder:text-ink-500 hover:border-ink-600 focus:border-ember-500 focus:outline-none"
      />
      {showList ? (
        <ul
          id={`${listId}-list`}
          role="listbox"
          aria-label="Search results"
          className="absolute inset-x-0 top-full z-30 mt-1 max-h-80 overflow-y-auto rounded-md border border-ink-700 bg-ink-850 p-1 shadow-2xl"
        >
          {hits.length === 0 ? (
            <li className="px-2 py-2 text-[12px] text-ink-400" role="option" aria-selected={false} aria-disabled>
              No page or heading matches &ldquo;{query.trim()}&rdquo;.
            </li>
          ) : (
            hits.map((hit, index) => (
              <li
                key={hit.href}
                id={`${listId}-option-${index}`}
                role="option"
                aria-selected={index === active}
                onPointerMove={() => setActive(index)}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => go(hit.href)}
                className={cn("flex cursor-pointer flex-col gap-0.5 rounded-sm px-2 py-1.5", index === active ? "bg-ink-800" : "hover:bg-ink-800/60")}
              >
                <span className="text-[13px] text-ink-50">{hit.heading ?? hit.title}</span>
                <span className="text-[11px] text-ink-400">
                  {hit.section} · {hit.heading ? hit.title : hit.description}
                </span>
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}
