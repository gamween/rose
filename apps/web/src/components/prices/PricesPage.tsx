"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Deployment } from "@/components/docs/deployment";
import { useLiveQuery } from "@/components/status/useLiveQuery";
import { Segmented } from "@/components/ui/Segmented";
import { Button } from "@/components/ui/Button";
import { CARD_CELL, CARD_ROW, CARD_WIDE } from "@/components/portfolio/HoldingsSection";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { Disclosure } from "@/components/ui/DetailsList";
import { KeyStats } from "@/components/ui/KeyStats";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/Table";
import { Tabs } from "@/components/ui/Tabs";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Skeleton";
import { cn } from "@/lib/cn";
import { formatCount } from "@/lib/format";
import { ROUTES } from "@/lib/routes";
import { fetchPricesData, type PricesData } from "./data";
import { LockScatterChart } from "./LockScatterChart";
import { seriesColor, seriesShape } from "./palette";
import { PriceHistoryChart } from "./PriceHistoryChart";
import { buildSeries, formatPercent, groupByToken, priceUnitOf, type TokenGroup } from "./transforms";

const REFRESH_MS = 30_000;

type ChartTab = "history" | "lock";

const CHART_TABS = [
  { id: "history", label: "Price history" },
  { id: "lock", label: "Price vs lock left" },
] as const;

class NotConfiguredError extends Error {}

function Methodology() {
  return (
    <Disclosure summary="Methodology: how every number on this page is produced">
      <div className="flex flex-col gap-3 text-[13px] leading-relaxed text-ink-300" data-methodology>
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
          ). A Tender price is what the issuer paid per locked token and an Exit price is where sealed supply met sealed demand. An Advance price is per claimed
          token, a different unit: Advance rounds get their own line per class, labeled per claimed token, and stay out of the price-versus-lock scatter.
        </p>
        <p>
          There is no spot oracle on testnet, so no implied discount is computed on chain. When an issuer declared a public reference price at Tender creation,
          the discount shown is <code className="font-mono text-ink-100">1 - price / declared reference</code> and is labeled as a discount to the issuer&apos;s
          declaration, not to a market price. Rounds without a declaration show no discount.
        </p>
        <p>
          Price history charts are one line per class and unit. The scatter plot compares the per-locked-token prices of the classes of one token: the same token
          with more lock left should clear lower.
        </p>
      </div>
    </Disclosure>
  );
}

function LoadingGrid() {
  return (
    <div className="grid gap-4 md:grid-cols-2" aria-label="Loading prices">
      {[0, 1].map((index) => (
        <div key={index} className="ui-surface rounded-lg p-4">
          <Skeleton className="mb-3 h-4 w-2/3" />
          <Skeleton className="h-56 w-full" />
        </div>
      ))}
    </div>
  );
}

function TokenFilter({ groups, value, onChange }: { groups: TokenGroup[]; value: string; onChange: (key: string) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-[12px] text-ink-400 font-medium">Token</span>
      <Segmented
        label="Token"
        size="md"
        options={groups.map((group) => ({
          value: group.tokenKey,
          label: (
            <>
              {group.symbol} <span className="text-ink-400">· {group.chain}</span>
            </>
          ),
        }))}
        value={value}
        onChange={onChange}
      />
    </div>
  );
}

function PricesContent({ data, blockHeight }: { data: PricesData; blockHeight: number }) {
  const groups = useMemo(() => groupByToken(buildSeries(data.classes, data.histories, data.references), data.symbols), [data]);
  const withPrices = groups.filter((group) => group.series.some((series) => series.points.length > 0));
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedSeries, setSelectedSeries] = useState<string | null>(null);
  const [chart, setChart] = useState<ChartTab>("history");
  const group = withPrices.find((candidate) => candidate.tokenKey === selected) ?? withPrices[0] ?? null;

  if (!group) {
    return (
      <EmptyState
        illustration="ledger"
        title="No clearing price yet"
        description={`${formatCount(data.classes.length)} class${data.classes.length === 1 ? "" : "es"} exist${
          data.classes.length === 1 ? "s" : ""
        } but no round has settled yet.`}
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
  const perLocked = plotted.filter((series) => series.unit === "locked");
  const advanceRounds = plotted.filter((series) => series.unit === "claimed").reduce((sum, series) => sum + series.points.length, 0);
  const active = plotted.find((series) => series.key === selectedSeries) ?? plotted[0]!;
  const activeIndex = group.series.indexOf(active);

  return (
    <div className="flex flex-col gap-5">
      <TokenFilter groups={withPrices} value={group.tokenKey} onChange={setSelected} />
      <KeyStats
        items={[
          { id: "settled", label: "Settled rounds", value: formatCount(settledRounds) },
          { id: "last", label: "Last clearing price", term: "clearingPrice", value: latest.priceText, unit: `USDC per ${priceUnitOf(latest.kind)} token` },
          { id: "lock", label: "Lock left at last clearing", value: latest.remainingLockDays.toFixed(1), unit: "days" },
        ]}
      />
      <section aria-labelledby="markets" className="flex flex-col gap-3" data-markets>
        <h2 id="markets" className="text-[14px] font-semibold text-ink-50">
          Classes
        </h2>
        <Card>
          <Table className="max-md:block">
            <THead className="max-md:hidden">
              <TR>
                <TH>Class</TH>
                <TH numeric>Last price</TH>
                <TH numeric>Discount to reference</TH>
                <TH numeric>Lock left</TH>
                <TH numeric>Rounds</TH>
              </TR>
            </THead>
            <TBody className="max-md:block">
              {plotted.map((series) => {
                const last = [...series.points].sort((a, b) => b.settledAtMs - a.settledAtMs)[0]!;
                const selectedRow = series.key === active.key;
                return (
                  <TR key={series.key} className={cn(CARD_ROW, "cursor-pointer", selectedRow && "bg-ink-800/70")} onClick={() => setSelectedSeries(series.key)} data-market-row={series.key}>
                    <TD className={CARD_WIDE}>
                      <button type="button" aria-pressed={selectedRow} onClick={() => setSelectedSeries(series.key)} className="flex min-w-0 flex-col items-start gap-0.5 text-left">
                        <span className="flex items-center gap-2 text-ink-50">
                          <span aria-hidden className="size-2 shrink-0" style={{ backgroundColor: seriesColor(group.series.indexOf(series)) }} />
                          {group.symbol}
                          {series.unit === "claimed" ? <Badge tone="neutral">Advance</Badge> : null}
                        </span>
                        <span className="text-[11.5px] text-ink-400">{series.label}</span>
                      </button>
                    </TD>
                    <TD numeric className={CARD_CELL} data-label="Last price">
                      {last.priceText} <span className="text-[11px] text-ink-400">/ {series.unit} token</span>
                    </TD>
                    <TD numeric className={CARD_CELL} data-label="Discount to reference">
                      {last.discount !== null ? formatPercent(last.discount) : "—"}
                    </TD>
                    <TD numeric className={CARD_CELL} data-label="Lock left">
                      {last.remainingLockDays.toFixed(1)} d
                    </TD>
                    <TD numeric className={CARD_CELL} data-label="Rounds">
                      {formatCount(series.points.length)}
                    </TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
        </Card>
      </section>
      <section className="flex flex-col gap-3" aria-label="Chart">
        <Tabs items={CHART_TABS} value={chart} onChange={setChart} label="Chart" />
        {chart === "history" ? (
          <div role="tabpanel" className="ui-surface rounded-lg p-4" data-price-series={active.unit}>
            <PriceHistoryChart series={active} color={seriesColor(activeIndex)} shape={seriesShape(activeIndex)} symbol={group.symbol} />
          </div>
        ) : (
          <div role="tabpanel" className="ui-surface rounded-lg p-4" data-lock-scatter>
            {perLocked.length > 0 ? (
              <LockScatterChart group={{ ...group, series: perLocked }} />
            ) : (
              <p className="text-[13px] text-ink-400">No Tender or Exit round of {group.symbol} has settled yet: this chart compares prices per locked token only.</p>
            )}
            {advanceRounds > 0 ? (
              <p className="mt-3 text-[12px] text-ink-400" data-advance-note>
                {formatCount(advanceRounds)} Advance round{advanceRounds === 1 ? " is" : "s are"} left out: they clear per claimed token.
              </p>
            ) : null}
          </div>
        )}
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
      <header className="mb-6">
        <h1 className="text-[24px] font-semibold tracking-tight text-ink-50">Prices</h1>
        <p className="mt-1 text-[13px] text-ink-400">What locked tokens cleared at in settled sealed rounds.</p>
      </header>
      <div className={refreshing && state.status === "ok" ? "opacity-80 transition-opacity" : "transition-opacity"}>
        {state.status === "loading" ? <LoadingGrid /> : null}
        {notDeployed ? (
          <EmptyState
            illustration="ember"
            title="Protocol not deployed yet"
            description="Clearing prices appear here once the engine is live and a round has settled."
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
