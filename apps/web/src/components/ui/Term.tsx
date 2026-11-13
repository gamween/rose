"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { GLOSSARY, glossaryHref, type GlossaryTerm } from "@/lib/glossary";
import { Tooltip } from "./Tooltip";

/**
 * A word of rose's vocabulary, dotted-underlined: its definition shows on hover, focus or tap, with
 * a link to the full glossary entry. `children` defaults to the glossary entry itself.
 */
export function Term({ term, children, side = "top", align = "center" }: { term: GlossaryTerm; children?: ReactNode; side?: "top" | "bottom"; align?: "start" | "center" | "end" }) {
  const entry = GLOSSARY[term];
  return (
    <Tooltip
      side={side}
      align={align}
      interactive
      content={
        <>
          <span className="block">{entry.short}</span>
          <Link href={glossaryHref(term)} className="mt-1 inline-block text-[11.5px] text-ember-300 hover:text-ember-200 font-medium">
            Glossary →
          </Link>
        </>
      }
    >
      {(props) => (
        <span tabIndex={0} className="ui-term" data-term={term} {...props}>
          {children ?? entry.entry}
        </span>
      )}
    </Tooltip>
  );
}
