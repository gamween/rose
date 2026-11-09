"use client";

import { useState } from "react";
import { Drawer } from "@/components/ui/Modal";
import type { DocSection, SearchEntry } from "./types";
import { DocsNav } from "./DocsNav";
import { DocsSearch } from "./DocsSearch";

/** Below the desktop breakpoint the docs navigation and search live in a drawer. */
export function DocsMobileNav({ sections, index, current }: { sections: DocSection[]; index: SearchEntry[]; current: string }) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  return (
    <div className="flex items-center gap-3 border-b border-ink-750 bg-ink-950/90 px-4 py-2 backdrop-blur-md lg:hidden">
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-expanded={open}
        aria-label="Open the docs navigation"
        data-variant="secondary"
        className="ui-block flex h-9 items-center gap-2 rounded-md px-3 text-[13px]"
      >
        <svg viewBox="0 0 8 7" width="12" height="10" shapeRendering="crispEdges" aria-hidden>
          <path d="M0 0h8v1H0zM0 3h8v1H0zM0 6h8v1H0z" fill="currentColor" />
        </svg>
        Docs
      </button>
      <p className="truncate text-[13px] text-ink-400">{current}</p>
      <Drawer open={open} onClose={close} title="Docs">
        <DocsSearch index={index} onNavigate={close} className="mb-5" />
        <DocsNav sections={sections} onNavigate={close} />
      </Drawer>
    </div>
  );
}
