import Link from "next/link";
import { docHref, type DocSummary } from "./types";

function PagerLink({ doc, direction }: { doc: DocSummary; direction: "previous" | "next" }) {
  const next = direction === "next";
  return (
    <Link
      href={docHref(doc.slug)}
      rel={direction === "next" ? "next" : "prev"}
      className={`group flex min-w-0 flex-1 flex-col gap-1 rounded-md border border-ink-750 bg-ink-900 px-4 py-3 transition-colors hover:border-ink-600 hover:bg-ink-850 ${next ? "items-end text-right" : "items-start text-left"}`}
    >
      <span className="text-[12px] text-ink-400 font-medium">{next ? "Next →" : "← Previous"}</span>
      <span className="truncate text-[14px] text-ink-100 group-hover:text-ink-50">{doc.title}</span>
    </Link>
  );
}

/** Previous and next page links in reading order. */
export function DocsPager({ previous, next }: { previous: DocSummary | null; next: DocSummary | null }) {
  return (
    <nav aria-label="Previous and next page" className="mt-12 flex flex-col gap-3 border-t border-ink-750 pt-6 sm:flex-row">
      {previous ? <PagerLink doc={previous} direction="previous" /> : <div className="flex-1" />}
      {next ? <PagerLink doc={next} direction="next" /> : <div className="flex-1" />}
    </nav>
  );
}
