"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Kbd } from "@/components/ui/Kbd";
import { cn } from "@/lib/cn";
import { REPOSITORY_URL, ROUTES } from "@/lib/routes";

export type PaletteCommand = {
  id: string;
  label: string;
  hint?: string;
  group: "Navigate" | "Actions" | "Help";
  keywords?: string;
  run: () => void;
};

/** The groups in the order the palette shows them. */
export const PALETTE_GROUPS: readonly PaletteCommand["group"][] = ["Actions", "Navigate", "Help"];

/** Commands matching `query`, grouped in display order, so the n-th entry is the n-th row on screen. */
export function orderedMatches(commands: readonly PaletteCommand[], query: string): PaletteCommand[] {
  const needle = query.trim().toLowerCase();
  const matches = needle ? commands.filter((command) => `${command.label} ${command.hint ?? ""} ${command.keywords ?? ""}`.toLowerCase().includes(needle)) : commands;
  return PALETTE_GROUPS.flatMap((group) => matches.filter((command) => command.group === group));
}

/** Cmd+K / Ctrl+K palette with navigation and the global actions. */
export function CommandPalette({ open, onClose, commands }: { open: boolean; onClose: () => void; commands: PaletteCommand[] }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [cursor, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const listId = useId();

  const all = useMemo<PaletteCommand[]>(
    () => [
      { id: "nav-portfolio", label: "Portfolio", hint: "/app", group: "Navigate", keywords: "holdings units claim", run: () => router.push(ROUTES.portfolio) },
      { id: "nav-rounds", label: "Rounds", hint: "/app/rounds", group: "Navigate", keywords: "tender exit advance bid ask", run: () => router.push(ROUTES.rounds) },
      { id: "nav-deposit", label: "Deposit a position", hint: "/app/deposit", group: "Navigate", keywords: "sablier streamflow stream", run: () => router.push("/app/deposit") },
      { id: "nav-issuer", label: "Issuer console", hint: "/app/issuer", group: "Navigate", keywords: "tender create class distribute", run: () => router.push(ROUTES.issuer) },
      { id: "nav-advance", label: "Advance", hint: "/app/advance", group: "Navigate", keywords: "lien funder", run: () => router.push("/app/advance") },
      { id: "nav-prices", label: "Prices", hint: "/app/prices", group: "Navigate", keywords: "clearing history discount", run: () => router.push(ROUTES.prices) },
      { id: "nav-docs", label: "Docs", hint: "/docs", group: "Help", keywords: "documentation guide", run: () => router.push(ROUTES.docs) },
      { id: "nav-contracts", label: "Contracts and addresses", hint: "/docs/contracts", group: "Help", run: () => router.push(ROUTES.contracts) },
      { id: "nav-status", label: "Status", hint: "/status", group: "Help", keywords: "keyless mpc latency", run: () => router.push(ROUTES.status) },
      ...(REPOSITORY_URL ? [{ id: "nav-github", label: "GitHub repository", hint: "github.com", group: "Help" as const, run: () => window.open(REPOSITORY_URL ?? "", "_blank", "noopener") }] : []),
      ...commands,
    ],
    [commands, router],
  );

  /** The matches in display order (Actions, Navigate, Help): the keyboard, the highlight and Enter all index this one list. */
  const filtered = useMemo(() => orderedMatches(all, query), [all, query]);

  const active = Math.min(cursor, Math.max(0, filtered.length - 1));

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    // The query is cleared when the palette closes, never after it opens: an opening reset would land
    // after the input is on screen and wipe what was typed right after the shortcut.
    if (open && !dialog.open) {
      dialog.showModal();
      window.setTimeout(() => inputRef.current?.focus(), 0);
    }
    if (!open && dialog.open) {
      dialog.close();
      setQuery("");
      setActive(0);
    }
  }, [open]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const cancel = (event: Event) => {
      event.preventDefault();
      onClose();
    };
    dialog.addEventListener("cancel", cancel);
    return () => dialog.removeEventListener("cancel", cancel);
  }, [onClose]);

  const choose = (command: PaletteCommand) => {
    onClose();
    command.run();
  };


  return (
    <dialog
      ref={dialogRef}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      aria-label="Command palette"
      className="mx-auto mt-[10vh] w-[calc(100%-32px)] max-w-xl rounded-lg border border-ink-700 bg-ink-850 p-0 text-ink-100 shadow-(--shadow-overlay) backdrop:bg-ink-950/80 backdrop:backdrop-blur-[2px] open:animate-rise-in"
    >
      {/* The focus ring sits on the search row, flush with it, instead of the global outline offset around the bare input. */}
      <div className="flex items-center gap-2 border-b border-ink-750 px-3 focus-within:shadow-[inset_0_-2px_0_var(--color-ember-400)]" data-palette-row>
        <span aria-hidden className="text-[12px] text-ember-300 font-medium">⌘K</span>
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setActive((index) => Math.min(index + 1, filtered.length - 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setActive((index) => Math.max(index - 1, 0));
            } else if (event.key === "Enter") {
              event.preventDefault();
              // Match the text as typed, not the last render's list: a query typed and run in one
              // go must not run the first command of the unfiltered list.
              const matches = event.currentTarget.value === query ? filtered : orderedMatches(all, event.currentTarget.value);
              const command = matches[event.currentTarget.value === query ? active : 0];
              if (command) choose(command);
            }
          }}
          role="combobox"
          aria-expanded
          aria-controls={listId}
          aria-activedescendant={filtered[active] ? `${listId}-${filtered[active].id}` : undefined}
          placeholder="Go to a page or run an action"
          style={{ outline: "none" }}
          className="h-12 w-full bg-transparent text-[14px] text-ink-50 placeholder:text-ink-400"
          data-palette-input
        />
      </div>
      <ul id={listId} role="listbox" className="max-h-[50vh] overflow-y-auto py-2">
        {filtered.length === 0 ? <li className="px-4 py-6 text-center text-[13px] text-ink-400">No match for “{query}”.</li> : null}
        {PALETTE_GROUPS.map((group) => {
          const items = filtered.flatMap((command, index) => (command.group === group ? [{ command, index }] : []));
          if (items.length === 0) return null;
          return (
            <li key={group} role="presentation">
              <p className="px-5 pb-1 pt-2 text-[11px] text-ink-500 font-medium">{group}</p>
              <ul role="group" aria-label={group}>
                {items.map(({ command, index }) => (
                  <PaletteItem key={command.id} id={`${listId}-${command.id}`} selected={index === active} onHover={() => setActive(index)} onSelect={() => choose(command)}>
                    <span className="text-[13px] text-ink-50">{command.label}</span>
                    {command.hint ? <span className="tabular text-[11px] text-ink-400">{command.hint}</span> : null}
                  </PaletteItem>
                ))}
              </ul>
            </li>
          );
        })}
      </ul>
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-ink-750 bg-ink-900/60 px-4 py-2 text-[11px] text-ink-400">
        <span className="flex items-center gap-1">
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd> to move
        </span>
        <span className="flex items-center gap-1">
          <Kbd>Enter</Kbd> to run
        </span>
        <span className="flex items-center gap-1">
          <Kbd>Esc</Kbd> to close
        </span>
      </p>
    </dialog>
  );
}

function PaletteItem({ id, selected, onHover, onSelect, children }: { id: string; selected: boolean; onHover: () => void; onSelect: () => void; children: ReactNode }) {
  return (
    <li
      id={id}
      role="option"
      aria-selected={selected}
      onMouseEnter={onHover}
      onClick={onSelect}
      className={cn("relative mx-2 flex cursor-pointer items-center justify-between gap-3 rounded-sm px-3 py-2", selected ? "bg-ink-800 text-ink-50 before:absolute before:inset-y-1.5 before:left-0 before:w-[2px] before:bg-ember-500" : "hover:bg-ink-800/60")}
    >
      {children}
    </li>
  );
}

/** Registers the Cmd+K / Ctrl+K shortcut. */
export function usePaletteShortcut(toggle: () => void): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        toggle();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle]);
}
