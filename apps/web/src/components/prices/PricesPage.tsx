"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Deployment } from "@/components/docs/deployment";
import { useLiveQuery } from "@/components/status/useLiveQuery";
import { Button } from "@/components/ui/Button";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Skeleton";
import { Stat } from "@/components/ui/Stat";
import { formatCount } from "@/lib/format";
import { ROUTES } from "@/lib/routes";
import { fetchPricesData, type PricesData } from "./data";
import { LockScatterChart } from "./LockScatterChart";
import { seriesColor, seriesShape } from "./palette";
import { PriceHistoryChart } from "./PriceHistoryChart";
import { buildSeries, groupByToken, type TokenGroup } from "./transforms";

const REFRESH_MS = 30_000;

class NotConfiguredError extends Error {}

function Methodology() {
  return (
    <Card>
      <CardHeader title="Methodology" description="How every number on this page is produced." />
      <CardBody className="flex flex-col gap-3 text-[13px] leading-relaxed text-ink-300">
        <p>
          Every settled round publishes its clearing price per locked token at the settlement time <code className="font-mono text-ink-100">ts = closes_at</code>,
          its remaining lock duration (<code className="font-mono text-ink-100">1 - f(ts)</code> of the schedule still to unlock, expressed in days) and the units it
          traded. The engine stores these points per class in <code className="font-mono text-ink-100">get_price_history</code>; this page reads them from the
          contract in your browser, with no indexer or cache.
        </p>
        <p>
          Prices are uniform: every filled order of a round settled at that price (see the{" "}
          <Link href="/docs/clearing-rules" className="text-ember-300 hover:text-ember-200">
            clearing rules
          </Link>
          ). A Tender price is what the issuer paid per locked token, an Exit price is where sealed supply met sealed demand, and an Advance price is per claimed
          token, which is why Advance points sit on their own class line and are labeled.
        </p>
        <p>
          There is no spot oracle on testnet, so no implied discount is computed on chain. When an issuer declared a public reference price at Tender creation,
          the discount shown is <code className="font-mono text-ink-100">1 - price / declared reference</code> and is labeled as a discount to the issuer&apos;s
          declaration, not to a market price. Rounds without a declaration show no discount.
        </p>
        <p>Price history charts are one line per class. The scatter plot compares the classes of one token: the same token with more lock left should clear lower.</p>
      </CardBody>
    </Card>
  );
}

function LoadingGrid() {
  return (
    <div className="grid gap-4 md:grid-cols-2" aria-label="Loading prices">
      {[0, 1].map((index) => (
        <div key={index} className="rounded-lg border border-ink-750 bg-ink-850 p-4">
          <Skeleton className="mb-3 h-4 w-2/3" />
          <Skeleton className="h-56 w-full" />
        </div>
      ))}
    </div>
  );
}

function TokenFilter({ groups, value, onChange }: { groups: TokenGroup[]; value: string; onChange: (key: string) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Token">
      <span className="font-display text-[11px] uppercase tracking-wide text-ink-400">Token</span>
      {groups.map((group) => (
        <button
          key={group.tokenKey}
          type="button"
          aria-pressed={group.tokenKey === value}
          onClick={() => onChange(group.tokenKey)}
          className={`h-8 rounded-md border px-3 text-[13px] transition-colors ${
            group.tokenKey === value ? "border-ember-600 bg-ember-700/25 text-ember-200" : "border-ink-700 bg-ink-900 text-ink-300 hover:border-ink-600 hover:text-ink-50"
          }`}
        >
          {group.symbol} <span className="text-ink-400">· {group.chain}</span>
        </button>
      ))}
    </div>
  );
}

function PricesContent({ data, blockHeight }: { data: PricesData; blockHeight: number }) {
  const groups = useMemo(() => groupByToken(buildSeries(data.classes, data.histories, data.references), data.symbols), [data]);
  const withPrices = groups.filter((group) => group.series.some((series) => series.points.length > 0));
  const [selected, setSelected] = useState<string | null>(null);
  const group = withPrices.find((candidate) => candidate.tokenKey === selected) ?? withPrices[0] ?? null;

  if (!group) {
    return (
      <EmptyState
        illustration="ledger"
        title="No clearing price yet"
        description={`${formatCount(data.classes.length)} class${data.classes.length === 1 ? "" : "es"} exist${
          data.classes.length === 1 ? "s" : ""
        } but no round has settled. Prices appear here after the first settled round: a Tender, Exit or Advance that cleared with a crossing.`}
        action={
          <Link href={ROUTES.rounds} className="text-[13px] text-ember-300 underline underline-offset-4 hover:text-ember-200">
            See the open rounds
          </Link>
        }
      />
    );
  }

  const plotted = group.series.filter((series) => series.points.length > 0);
  const settledRounds = plotted.reduce((sum, series) => sum + series.points.length, 0);
  const latest = plotted.flatMap((series) => series.points).sort((a, b) => b.settledAtMs - a.settledAtMs)[0]!;
  const declared = plotted.flatMap((series) => series.points).filter((point) => point.discount !== null);

  return (
    <div className="flex flex-col gap-6">
      <TokenFilter groups={withPrices} value={group.tokenKey} onChange={setSelected} />
      <dl className="grid grid-cols-2 gap-4 rounded-lg border border-ink-750 bg-ink-900 p-4 md:grid-cols-4">
        <Stat label="Settled rounds" value={formatCount(settledRounds)} hint={`${plotted.length} class${plotted.length === 1 ? "" : "es"} priced`} />
        <Stat label="Last clearing price" value={latest.priceText} unit="USDC" hint={`per locked token, round #${latest.roundId}`} />
        <Stat label="Lock left at last clearing" value={latest.remainingLockDays.toFixed(1)} unit="days" />
        <Stat
          label="Declared references"
          value={formatCount(declared.length)}
          hint={declared.length > 0 ? "Tender rounds with an issuer-declared reference" : "no issuer declared a reference yet"}
        />
      </dl>
      <section aria-labelledby="price-history" className="flex flex-col gap-4">
        <h2 id="price-history" className="font-display text-[16px] text-ink-50">
          Clearing price history per class
        </h2>
        <div className="grid gap-4 md:grid-cols-2">
          {plotted.map((series) => {
            const index = group.series.indexOf(series);
            return (
              <div key={series.classId} className="rounded-lg border border-ink-750 bg-ink-850 p-4">
                <PriceHistoryChart series={series} color={seriesColor(index)} shape={seriesShape(index)} symbol={group.symbol} />
              </div>
            );
          })}
        </div>
      </section>
      <section aria-labelledby="lock-scatter" className="flex flex-col gap-4">
        <h2 id="lock-scatter" className="font-display text-[16px] text-ink-50">
          Price versus remaining lock
        </h2>
        <div className="rounded-lg border border-ink-750 bg-ink-850 p-4">
          <LockScatterChart group={{ ...group, series: plotted }} />
        </div>
      </section>
      <p className="text-[12px] text-ink-400">Read from the engine at block {formatCount(blockHeight)}.</p>
    </div>
  );
}

/** Clearing prices of every class, read live from the engine; the page explains itself when nothing has settled. */
export function PricesPage({ deployment }: { deployment: Deployment }) {
  const [refreshKey, setRefreshKey] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setRefreshKey((key) => key + 1), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, []);
  const fetcher = useCallback(
    (signal: AbortSignal) => {
      if (!deployment.ENGINE_ACCOUNT) throw new NotConfiguredError("not configured");
      return fetchPricesData(deployment.ENGINE_ACCOUNT, { signal });
    },
    [deployment],
  );
  const { state, retry, refreshing } = useLiveQuery(fetcher, refreshKey);
  const notDeployed = state.status === "not_deployed" || (state.status === "error" && !deployment.ENGINE_ACCOUNT);

  return (
    <div className="py-2 lg:py-4" aria-busy={state.status === "loading"} data-prices>
      <header className="mb-8">
        <p className="font-display text-[11px] uppercase tracking-wide text-ember-400">Clearing prices</p>
        <h1 className="mt-2 font-display text-[28px] leading-tight text-ink-50 md:text-[34px]">Prices</h1>
        <p className="mt-3 max-w-2xl text-[15px] leading-relaxed text-ink-300">
          What locked tokens actually cleared at, per class and against the lock left at settlement. Every point is a settled sealed round.
        </p>
      </header>
      <div className={refreshing && state.status === "ok" ? "opacity-80 transition-opacity" : "transition-opacity"}>
        {state.status === "loading" ? <LoadingGrid /> : null}
        {notDeployed ? (
          <EmptyState
            illustration="ember"
            title="Protocol not deployed yet"
            description="Clearing prices are read from the engine contract on NEAR testnet. They appear here, straight from the contract, once the engine is live and a round has settled."
          />
        ) : null}
        {state.status === "error" && !notDeployed ? (
          <EmptyState
            illustration="ledger"
            title="Could not read the engine"
            description={state.message}
            action={
              <Button variant="secondary" size="sm" onClick={retry} loading={refreshing} loadingLabel="Retrying">
                Retry
              </Button>
            }
          />
        ) : null}
        {state.status === "ok" ? <PricesContent data={state.value} blockHeight={state.value.blockHeight} /> : null}
      </div>
      <div className="mt-8">
        <Methodology />
      </div>
    </div>
  );
}
