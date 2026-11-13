"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";
import { docHref, DOCS_INDEX_SLUG, type DocSection } from "./types";

/** Left navigation of the docs, grouped by section; the active page follows the URL. */
export function DocsNav({ sections, onNavigate, className }: { sections: DocSection[]; onNavigate?: () => void; className?: string }) {
  const pathname = usePathname() ?? "/docs";
  const activeSlug = pathname === "/docs" ? DOCS_INDEX_SLUG : pathname.replace(/^\/docs\//, "").replace(/\/$/, "");
  return (
    <nav aria-label="Docs" className={cn("flex flex-col gap-6", className)}>
      {sections.map((section) => (
        <div key={section.name}>
          <p className="mb-2 px-2 text-[12px] text-ink-400 font-medium">{section.name}</p>
          <ul className="flex flex-col gap-px">
            {section.docs.map((doc) => {
              const active = doc.slug === activeSlug;
              return (
                <li key={doc.slug}>
                  <Link
                    href={docHref(doc.slug)}
                    onClick={onNavigate}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "relative flex min-h-8 items-center rounded-sm px-2 py-1 text-[13px] transition-colors",
                      active ? "bg-ink-800 text-ink-50 before:absolute before:inset-y-1.5 before:-left-px before:w-[2px] before:bg-ember-500" : "text-ink-300 hover:bg-ink-850 hover:text-ink-50",
                    )}
                  >
                    {doc.title}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
