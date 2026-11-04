"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";
import { Logo } from "@/components/brand/Logo";
import { NetworkBadge } from "@/components/ui/Badge";
import { Drawer } from "@/components/ui/Modal";
import { cn } from "@/lib/cn";
import { PRIMARY_NAV, ROUTES } from "@/lib/routes";

/** A global action listed in the mobile menu (the activity feed and the palette, whose top-bar buttons hide on small screens). */
export type MenuAction = { id: string; label: string; hint: string; onSelect: () => void };

/**
 * Global top bar: logo, primary navigation, network badge and an action slot (the Connect button
 * in the app, "Launch app" on the landing). Collapses into a drawer below 768 px, which also
 * lists `menuActions`.
 */
export function TopNav({ action, overlay = false, menuActions = [] }: { action?: ReactNode; overlay?: boolean; menuActions?: readonly MenuAction[] }) {
  const pathname = usePathname() ?? "/";
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <header
      className={cn(
        "z-40 w-full",
        overlay
          ? "fixed inset-x-0 top-0 border-b border-ink-850 bg-ink-950/80 backdrop-blur-md"
          : "sticky top-0 border-b border-ink-750 bg-ink-950/90 backdrop-blur-md",
      )}
    >
      <nav aria-label="Primary" className="mx-auto flex h-14 max-w-[1440px] items-center gap-6 px-4 md:px-6">
        <Link href={ROUTES.home} aria-label="rose home" className="shrink-0 rounded-sm">
          <Logo />
        </Link>
        <ul className="hidden items-center gap-1 md:flex">
          {PRIMARY_NAV.map((item) => {
            const active = item.match(pathname);
            return (
              <li key={item.label}>
                <Link
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "rounded-md px-2.5 py-1.5 text-[13px] transition-colors",
                    active ? "bg-ink-800 text-ink-50" : "text-ink-300 hover:bg-ink-850 hover:text-ink-50",
                  )}
                >
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
        <div className="ml-auto flex items-center gap-3">
          <NetworkBadge className="hidden sm:inline-flex" />
          {action}
          <button
            type="button"
            className="flex size-9 items-center justify-center rounded-md text-ink-200 hover:bg-ink-800 md:hidden"
            aria-label="Open menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen(true)}
          >
            <svg viewBox="0 0 8 7" width="14" height="12" shapeRendering="crispEdges" aria-hidden>
              <path d="M0 0h8v1H0zM0 3h8v1H0zM0 6h8v1H0z" fill="currentColor" />
            </svg>
          </button>
        </div>
      </nav>
      <Drawer open={menuOpen} onClose={() => setMenuOpen(false)} title="Menu">
        <ul className="flex flex-col gap-1">
          {PRIMARY_NAV.map((item) => (
            <li key={item.label}>
              <Link
                href={item.href}
                onClick={() => setMenuOpen(false)}
                aria-current={item.match(pathname) ? "page" : undefined}
                className="flex h-11 items-center rounded-md px-3 text-[15px] text-ink-100 hover:bg-ink-800"
              >
                {item.label}
              </Link>
            </li>
          ))}
        </ul>
        {menuActions.length > 0 ? (
          <ul className="mt-4 flex flex-col gap-1 border-t border-ink-750 pt-4" aria-label="Tools">
            {menuActions.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    item.onSelect();
                  }}
                  className="flex h-11 w-full items-center justify-between gap-3 rounded-md px-3 text-left text-[15px] text-ink-100 hover:bg-ink-800"
                  data-menu-action={item.id}
                >
                  {item.label}
                  <span className="text-[12px] text-ink-400">{item.hint}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="mt-6">
          <NetworkBadge />
        </div>
      </Drawer>
    </header>
  );
}
