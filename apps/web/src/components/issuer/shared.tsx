"use client";

/**
 * Pieces shared by the issuer console tabs: the engine reads every tab needs (config, limits,
 * classes with their token symbols), the class picker and summary, and the small feedback
 * blocks for one-shot actions.
 */

import { baseSepoliaChain, type ClassInfo, type ConfigView, type Limits } from "@rose/sdk";
import { createPublicClient, http, type PublicClient } from "viem";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { LearnMore } from "@/components/chrome/LearnMore";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Skeleton";
import { useWallets } from "@/components/wallet/WalletProvider";
import { formatAmount, formatDate, formatFraction, secondsToMs, shortHex, venueLabel } from "@/lib/amounts";
import { engineClient, requireEngine, type EngineClient } from "@/lib/engine-client";
import { addressUrl } from "@/lib/explorer";
import { scheduleBounds } from "@/lib/unlock-schedule";
import type { ActionState } from "@/lib/use-action";
import { useEngineQuery, type EngineQueryState } from "@/lib/use-engine-query";
import { BASE_SEPOLIA_RPC_URL } from "@/lib/deployment";
import { tokenKey, tokenSymbols } from "@/lib/token-symbols";

export type IssuerBase = {
  engine: EngineClient;
  config: ConfigView;
  limits: Limits;
  classes: ClassInfo[];
  /** Token symbols by `tokenKey` (Base tokens and the Solana demo mint); others show their short address. */
  symbols: Map<string, string>;
};

const PAGE = 50;

let client: PublicClient | null = null;

/**
 * The Base Sepolia client of the console: one request per read (no Multicall3 batching), so a
 * single failing token read never takes the other reads down with it.
 */
export function baseClient(): PublicClient {
  client ??= createPublicClient({ chain: baseSepoliaChain, transport: http(BASE_SEPOLIA_RPC_URL) });
  return client;
}

async function fetchAllClasses(engine: EngineClient, signal: AbortSignal): Promise<ClassInfo[]> {
  const classes: ClassInfo[] = [];
  for (let from = 0; ; from += PAGE) {
    const page = await engine.views.getClasses(from, PAGE, { signal });
    classes.push(...page);
    if (page.length < PAGE) return classes;
  }
}

/** Symbols of the class tokens and Base cash tokens (see `lib/token-symbols`); tokens without one keep their address. */
export function resolveSymbols(classes: readonly Pick<ClassInfo, "chain" | "token">[], baseCashTokens: readonly string[] = []): Promise<Map<string, string>> {
  return tokenSymbols([...classes.map((cls) => ({ chain: cls.chain, token: cls.token })), ...baseCashTokens.map((token) => ({ chain: "Base" as const, token }))]);
}

/** Config, limits and classes of the engine, polled every 30 s. */
export function useIssuerBase(): { state: EngineQueryState<IssuerBase>; refresh: () => Promise<void> } {
  const fetcher = useCallback(async (signal: AbortSignal): Promise<IssuerBase> => {
    const engine = requireEngine();
    const [config, limits, classes] = await Promise.all([engine.views.getConfig({ signal }), engine.views.getLimits({ signal }), fetchAllClasses(engine, signal)]);
    const symbols = await resolveSymbols(classes, config.base_cash_tokens);
    return { engine, config, limits, classes, symbols };
  }, []);
  return useEngineQuery(fetcher, { pollMs: 30_000 });
}

export function classSymbol(cls: Pick<ClassInfo, "chain" | "token">, symbols: ReadonlyMap<string, string>): string {
  return symbols.get(tokenKey(cls.token)) ?? (cls.chain === "Base" ? shortHex(cls.token) : shortHex(cls.token, 4, 4));
}

export function classLabel(cls: ClassInfo, symbols: ReadonlyMap<string, string>): string {
  const bounds = scheduleBounds(cls.schedule);
  return `${classSymbol(cls, symbols)} · ${cls.chain} · ends ${new Date(secondsToMs(bounds.end)).toISOString().slice(0, 10)} · ${shortHex(cls.classId, 6, 4)}`;
}

/** Native select over the engine's classes. */
export function ClassPicker({ classes, symbols, value, onChange, id, disabled }: { classes: ClassInfo[]; symbols: ReadonlyMap<string, string>; value: string; onChange: (classId: string) => void; id?: string; disabled?: boolean }) {
  return (
    <select
      id={id}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
      className="h-9 w-full rounded-md border border-ink-700 bg-ink-900 px-3 text-[13px] text-ink-50 hover:border-ink-600 focus:border-ember-500 focus:outline-none disabled:opacity-50"
      data-class-picker
    >
      <option value="">Choose a class</option>
      {classes.map((cls) => (
        <option key={cls.classId} value={cls.classId}>
          {classLabel(cls, symbols)}
        </option>
      ))}
    </select>
  );
}

export function ClassSummary({ cls, symbols }: { cls: ClassInfo; symbols: ReadonlyMap<string, string> }) {
  const bounds = scheduleBounds(cls.schedule);
  const chain = cls.chain === "Base" ? "base" : "solana";
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-[12px] sm:grid-cols-3">
      <div>
        <dt className="font-display text-[11px] uppercase tracking-wide text-ink-400">Token</dt>
        <dd className="text-ink-100">
          {classSymbol(cls, symbols)}{" "}
          <a href={addressUrl(chain, cls.token)} target="_blank" rel="noreferrer" className="tabular text-ink-400 underline-offset-2 hover:underline">
            {shortHex(cls.token)}
          </a>
        </dd>
      </div>
      <div>
        <dt className="font-display text-[11px] uppercase tracking-wide text-ink-400">Chain · decimals</dt>
        <dd className="text-ink-100">
          {cls.chain} · {cls.decimals}
        </dd>
      </div>
      <div>
        <dt className="font-display text-[11px] uppercase tracking-wide text-ink-400">Unlocked now</dt>
        <dd className="tabular text-ink-100">{formatFraction(cls.fractionNow)}</dd>
      </div>
      <div>
        <dt className="font-display text-[11px] uppercase tracking-wide text-ink-400">Schedule</dt>
        <dd className="text-ink-100">
          {formatDate(secondsToMs(bounds.start))} → {formatDate(secondsToMs(bounds.end))}
        </dd>
      </div>
      <div>
        <dt className="font-display text-[11px] uppercase tracking-wide text-ink-400">Units outstanding</dt>
        <dd className="tabular text-ink-100">{formatAmount(cls.totalUnits, cls.decimals)}</dd>
      </div>
      <div>
        <dt className="font-display text-[11px] uppercase tracking-wide text-ink-400">Positions</dt>
        <dd className="tabular text-ink-100">{cls.positions}</dd>
      </div>
      <div className="col-span-2 sm:col-span-3">
        <dt className="font-display text-[11px] uppercase tracking-wide text-ink-400">Class id</dt>
        <dd className="tabular break-all text-ink-300">{cls.classId}</dd>
      </div>
      {cls.tokenRisk ? <dd className="col-span-2 text-ink-400 sm:col-span-3">{cls.tokenRisk}</dd> : null}
    </dl>
  );
}

/** Success links or the error (with its retry) under an action button. */
export function ActionFeedback({ state, onRetry }: { state: ActionState; onRetry?: () => void }) {
  if (state.status === "success") {
    return (
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-success-400" data-action-success>
        {state.message}
        {state.links.map((link) => (
          <a key={link.href} href={link.href} target="_blank" rel="noreferrer" className="font-display text-[11px] uppercase tracking-wide text-ember-300 underline-offset-2 hover:underline">
            {link.label} ↗
          </a>
        ))}
      </p>
    );
  }
  if (state.status === "error") {
    return (
      <p className="flex flex-wrap items-center gap-2 text-[12px] text-danger-400" role="alert">
        <span>
          {state.error.title}: {state.error.message}
        </span>
        {state.error.retryable && onRetry ? (
          <Button size="sm" variant="secondary" onClick={onRetry}>
            Retry
          </Button>
        ) : null}
      </p>
    );
  }
  return null;
}

export function FieldLabel({ htmlFor, children }: { htmlFor?: string; children: ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="font-display text-[11px] uppercase tracking-wide text-ink-300">
      {children}
    </label>
  );
}

export function Hint({ children, tone = "muted" }: { children: ReactNode; tone?: "muted" | "warning" | "danger" }) {
  const color = tone === "danger" ? "text-danger-400" : tone === "warning" ? "text-warning-400" : "text-ink-400";
  return <p className={`text-[12px] ${color}`}>{children}</p>;
}

/** A compact key/value preview block (escrow, deposits, totals). */
export function Preview({ rows, title }: { rows: { label: string; value: ReactNode; emphasis?: boolean }[]; title?: string }) {
  return (
    <dl className="rounded-md border border-ink-750 bg-ink-900 px-3 py-2 text-[12px]" data-preview>
      {title ? <p className="mb-1 font-display text-[11px] uppercase tracking-wide text-ink-400">{title}</p> : null}
      {rows.map((row) => (
        <div key={row.label} className="flex items-baseline justify-between gap-3 py-0.5">
          <dt className="text-ink-400">{row.label}</dt>
          <dd className={`tabular min-w-0 text-right [overflow-wrap:anywhere] ${row.emphasis ? "text-ink-50" : "text-ink-200"}`}>{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <Button
      size="sm"
      variant="secondary"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => setCopied(true));
      }}
    >
      {copied ? "Copied" : label}
    </Button>
  );
}

/** Downloads `text` as `filename`. */
export function downloadFile(filename: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

/** The venues a round may use: NEAR tUSDC and the engine's accepted Base cash tokens. */
export function useVenueOptions(base: IssuerBase | null): { id: string; label: string; venue: "Near" | { Base: { token: string } } }[] {
  return useMemo(() => {
    const options: { id: string; label: string; venue: "Near" | { Base: { token: string } } }[] = [{ id: "near", label: venueLabel("Near"), venue: "Near" }];
    for (const token of base?.config.base_cash_tokens ?? []) {
      const venue = { Base: { token: token.toLowerCase() } };
      options.push({ id: `base:${token.toLowerCase()}`, label: venueLabel(venue, base?.symbols), venue });
    }
    return options;
  }, [base]);
}

/** The shared calm states: engine not deployed, loading, read error, no NEAR wallet. */
export function IssuerGate({ state, onRetry, children }: { state: EngineQueryState<IssuerBase>; onRetry: () => void; children: (base: IssuerBase) => ReactNode }) {
  const wallets = useWallets();
  if (state.status === "not_deployed") {
    return (
      <EmptyState
        illustration="vault"
        title="Engine not deployed yet"
        description="The issuer console reads classes, limits and cash balances from the rose engine on NEAR testnet. It opens as soon as the engine is deployed."
        action={<LearnMore topic="contracts" label="Contracts and addresses" />}
      />
    );
  }
  if (state.status === "loading") {
    return (
      <div className="flex flex-col gap-3" aria-busy>
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <EmptyState
        illustration="ember"
        title="Could not read the engine"
        description={state.message}
        action={
          <Button variant="secondary" onClick={onRetry}>
            Retry
          </Button>
        }
      />
    );
  }
  if (!wallets.near.accountId && wallets.hydrated) {
    return (
      <div className="flex flex-col gap-4">
        <EmptyState
          illustration="ledger"
          title="Connect a NEAR wallet to act as the issuer"
          description="Every issuer action (registering cohort deposits, distributing units, creating and funding a Tender) is signed by your NEAR account. Previews below work without a wallet."
          action={<Badge tone="ember">Top bar → Connect</Badge>}
        />
        {children(state.value)}
      </div>
    );
  }
  return <>{children(state.value)}</>;
}

/** yoctoNEAR as NEAR with up to five decimals, trailing zeros trimmed (`1`, `0.05`, `0.00336`). */
export function formatNear(yocto: bigint): string {
  return formatAmount(yocto, 24, 5).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

/** The engine account for links and messages, or null. */
export function engineAccountOrNull(): string | null {
  return engineClient()?.account ?? null;
}
