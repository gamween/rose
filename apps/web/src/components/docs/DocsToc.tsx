"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/cn";
import type { DocHeading } from "./markdown";

/** Table of contents of the current page with anchor links; the section in view is highlighted. */
export function DocsToc({ headings, className }: { headings: DocHeading[]; className?: string }) {
  const [activeId, setActiveId] = useState<string | null>(headings[0]?.id ?? null);

  useEffect(() => {
    if (headings.length === 0) return;
    const elements = headings.map((heading) => document.getElementById(heading.id)).filter((element): element is HTMLElement => element !== null);
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        const first = visible[0];
        if (first) setActiveId(first.target.id);
      },
      { rootMargin: "-80px 0px -70% 0px", threshold: 0 },
    );
    elements.forEach((element) => observer.observe(element));
    return () => observer.disconnect();
  }, [headings]);

  if (headings.length === 0) return null;

  return (
    <nav aria-label="On this page" className={cn("text-[12.5px]", className)}>
      <p className="mb-2 font-display text-[11px] uppercase tracking-wide text-ink-400">On this page</p>
      <ul className="flex flex-col border-l border-ink-750">
        {headings.map((heading) => (
          <li key={heading.id}>
            <a
              href={`#${heading.id}`}
              aria-current={activeId === heading.id ? "location" : undefined}
              className={cn(
                "-ml-px block border-l py-1 pr-2 leading-snug transition-colors",
                heading.depth === 3 ? "pl-6" : "pl-3",
                activeId === heading.id ? "border-ember-500 text-ink-50" : "border-transparent text-ink-400 hover:text-ink-100",
              )}
            >
              {heading.text}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
