"use client";

import type { Round } from "@rose/sdk";
import Link from "next/link";
import { useCallback } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Skeleton";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/Table";
import { useWallets } from "@/components/wallet/WalletProvider";
import { formatDate, formatUsdc, nsToMs, venueLabel } from "@/lib/amounts";
import { ROUTES } from "@/lib/routes";
import { useEngineQuery } from "@/lib/use-engine-query";
import { classSymbol, type IssuerBase } from "./shared";

const STATUS_TONE: Record<Round["status"], "neutral" | "ember" | "success" | "danger" | "info"> = { Scheduled: "neutral", Open: "ember", KeyRequested: "info", Revealing: "info", Clearing: "info", Settled: "success", Cancelled: "danger" };

/** Tab 7: the issuer's Tenders with their results page links. */
export function ResultsTab({ base }: { base: IssuerBase }) {
  const wallets = useWallets();
  const creator = wallets.near.accountId;
  const fetcher = useCallback(
    async (signal: AbortSignal): Promise<Round[]> => {
      if (!creator) return [];
      const rounds: Round[] = [];
      let from: bigint | null = null;
      for (;;) {
        const page = await base.engine.views.getRounds({ kind: "Tender", creator }, from ?? undefined, 50, { signal });
        rounds.push(...page.rounds);
        if (page.next === null) break;
        from = page.next;
      }
      return rounds.sort((a, b) => (a.roundId < b.roundId ? 1 : -1));
    },
    [base.engine, creator],
  );
  const { state, refresh } = useEngineQuery(fetcher, { pollMs: 20_000 });

  return (
    <Card>
      <CardHeader title="Your Tenders" description={creator ? `Rounds created by ${creator}. Settled ones have an exportable report.` : "Connect a NEAR wallet to list the Tenders you created."} action={<Button size="sm" variant="secondary" onClick={() => void refresh()}>Refresh</Button>} />
      <CardBody>
        {!creator ? (
          <EmptyState illustration="tender" title="No wallet connected" description="Your Tenders are listed by creator account." />
        ) : state.status === "loading" ? (
          <div className="flex flex-col gap-2" aria-busy>
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
          </div>
        ) : state.status === "error" ? (
          <EmptyState illustration="ember" title="Could not read the rounds" description={state.message} action={<Button variant="secondary" onClick={() => void refresh()}>Retry</Button>} />
        ) : state.status === "not_deployed" ? (
          <EmptyState illustration="vault" title="Engine not deployed yet" />
        ) : state.value.length === 0 ? (
          <EmptyState illustration="tender" title="No Tender yet" description="Launch one from the Tender tab: the round appears here with its status, and its report once settled." />
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Round</TH>
                <TH>Class</TH>
                <TH>Venue</TH>
                <TH numeric>Budget</TH>
                <TH numeric>Max price</TH>
                <TH>Closes</TH>
                <TH>Status</TH>
                <TH numeric>Asks</TH>
                <TH>Report</TH>
              </TR>
            </THead>
            <TBody>
              {state.value.map((round) => {
                const cls = base.classes.find((item) => item.classId === round.classId);
                return (
                  <TR key={round.roundId.toString()} data-tender-row={round.roundId.toString()}>
                    <TD>
                      <Link href={`${ROUTES.rounds}/${round.roundId.toString()}`} className="underline-offset-2 hover:underline">
                        #{round.roundId.toString()}
                      </Link>
                    </TD>
                    <TD>{cls ? classSymbol(cls, base.symbols) : round.classId.slice(0, 8)}</TD>
                    <TD>{venueLabel(round.venue, base.symbols)}</TD>
                    <TD numeric>{round.budget === null ? "—" : formatUsdc(round.budget)}</TD>
                    <TD numeric>{formatUsdc(round.maxPrice, 4)}</TD>
                    <TD>{formatDate(nsToMs(round.closesAt))}</TD>
                    <TD>
                      <Badge tone={STATUS_TONE[round.status]}>{round.status}</Badge>
                    </TD>
                    <TD numeric>{round.bidCount}</TD>
                    <TD>
                      {round.status === "Settled" || round.status === "Cancelled" ? (
                        <Link href={`${ROUTES.issuer}/results/${round.roundId.toString()}`} className="font-display text-[11px] uppercase tracking-wide text-ember-300 underline-offset-2 hover:underline">
                          Results →
                        </Link>
                      ) : (
                        <span className="text-[12px] text-ink-400">after settlement</span>
                      )}
                    </TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
        )}
      </CardBody>
    </Card>
  );
}
