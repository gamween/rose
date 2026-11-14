import type { ReactNode } from "react";
import type { GlossaryTerm } from "@/lib/glossary";
import { cn } from "@/lib/cn";
import { CopyButton } from "./CopyButton";
import { Term } from "./Term";

export type DetailRow = {
  /** Stable key and `data-detail` value. */
  id: string;
  label: ReactNode;
  value: ReactNode;
  /** Shows a copy button that copies this exact text (the full hash or address, not the shortened display). */
  copy?: string;
  /** Shows an explorer arrow that opens this URL in a new tab. */
  href?: string;
  /** Geist Mono for hashes, addresses and ids; numbers use tabular figures either way. */
  mono?: boolean;
  /** One short muted line under the value. */
  hint?: ReactNode;
  /** Turns the label into a glossary `Term`. */
  term?: GlossaryTerm;
};

function ExternalIcon() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M9 2.5h4.5V7M13.5 2.5 7 9M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3" />
    </svg>
  );
}

/**
 * The technical fields of a screen (ids, hashes, accounts, timeouts, limits) as label / value
 * rows with copy buttons and explorer links: the full record, kept one click away (a "Details"
 * tab or a `Disclosure`) instead of in the user's face. Values wrap, they are never cut.
 *
 * ```tsx
 * <DetailsList title="Identity" rows={[
 *   { id: "app", label: "Identity (app_id)", value: shorten(appId, 10, 8), copy: appId, mono: true },
 *   { id: "engine", label: "Engine", value: engine, href: nearAccountUrl(engine), mono: true },
 * ]} />
 * ```
 */
export function DetailsList({ rows, title, className }: { rows: readonly DetailRow[]; title?: ReactNode; className?: string }) {
  return (
    <section className={cn("min-w-0", className)} data-details-list>
      {title ? <h3 className="mb-1 text-[12px] font-medium text-ink-400">{title}</h3> : null}
      <dl className="divide-y divide-(--border-hairline) border-y border-(--border-hairline)">
        {rows.map((row) => (
          <div key={row.id} className="grid gap-x-4 gap-y-0.5 py-2 sm:grid-cols-[minmax(0,220px)_minmax(0,1fr)]" data-detail={row.id}>
            <dt className="text-[12.5px] text-ink-400">{row.term ? <Term term={row.term} align="start">{row.label}</Term> : row.label}</dt>
            <dd className="min-w-0">
              <span className="flex min-w-0 items-start gap-1.5">
                <span className={cn("min-w-0 text-[13px] text-ink-100 [overflow-wrap:anywhere]", row.mono ? "font-mono text-[12px] leading-5" : "tabular")}>
                  {row.href ? (
                    <a href={row.href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline-offset-2 hover:underline">
                      {row.value}
                      <span className="text-ink-400">
                        <ExternalIcon />
                      </span>
                    </a>
                  ) : (
                    row.value
                  )}
                </span>
                {row.copy ? <CopyButton value={row.copy} label={`Copy ${typeof row.label === "string" ? row.label.toLowerCase() : "value"}`} /> : null}
              </span>
              {row.hint ? <span className="mt-0.5 block text-[11.5px] leading-snug text-ink-400">{row.hint}</span> : null}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/**
 * A collapsed section (native `<details>`: keyboard and screen readers for free) for secondary
 * content on screens without a "Details" tab, closed by default. The summary is one short line.
 *
 * ```tsx
 * <Disclosure summary="Technical details"><DetailsList rows={rows} /></Disclosure>
 * ```
 */
export function Disclosure({ summary, children, defaultOpen = false, className }: { summary: ReactNode; children: ReactNode; defaultOpen?: boolean; className?: string }) {
  return (
    <details open={defaultOpen} className={cn("group rounded-lg border border-ink-750 bg-ink-900", className)} data-disclosure>
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-2.5 text-[13px] font-medium text-ink-200 transition-colors hover:text-ink-50 [&::-webkit-details-marker]:hidden">
        {summary}
        <svg viewBox="0 0 10 6" width="10" height="6" shapeRendering="crispEdges" className="shrink-0 text-ink-400 transition-transform group-open:rotate-180" aria-hidden>
          <path d="M0 0h2v2H0zM2 2h2v2H2zM4 4h2v2H4zM6 2h2v2H6zM8 0h2v2H8z" fill="currentColor" />
        </svg>
      </summary>
      <div className="border-t border-ink-750 px-4 py-3">{children}</div>
    </details>
  );
}
