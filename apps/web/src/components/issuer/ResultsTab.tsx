"use client";

import type { Round } from "@rose/sdk";
import Link from "next/link";
import { useCallback, useMemo, useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { Input } from "@/components/ui/Input";
import { Skeleton } from "@/components/ui/Skeleton";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/Table";
import { useWallets } from "@/components/wallet/WalletProvider";
import { formatDate, formatUsdc, nsToMs, venueLabel } from "@/lib/amounts";
import { ROUTES } from "@/lib/routes";
import { useEngineQuery } from "@/lib/use-engine-query";
import { endedDaoCreators, forgetDaoAccount, isNearAccountId, readDaoAccounts, rememberDaoAccount, resultCreators } from "./dao-accounts";
import { DaoWithdrawal } from "./DaoWithdrawal";
import { classSymbol, FieldLabel, Hint, type IssuerBase } from "./shared";

const STATUS_TONE: Record<Round["status"], "neutral" | "ember" | "success" | "danger" | "info"> = { Scheduled: "neutral", Open: "ember", KeyRequested: "info", Revealing: "info", Clearing: "info", Settled: "success", Cancelled: "danger" };

/**
 * Tab 7: the Tenders of the connected account and of the DAOs it works with (a Tender filed
 * through "Run via DAO" has the DAO as its creator), with their results page links. DAOs read or
 * proposed for in this browser are remembered; another can be added by name.
 */
export function ResultsTab({ base }: { base: IssuerBase }) {
  const wallets = useWallets();
  const connected = wallets.near.accountId;
  const [daos, setDaos] = useState<string[]>(() => readDaoAccounts());
  const [named, setNamed] = useState("");
  const [namedError, setNamedError] = useState<string | null>(null);
  const creators = useMemo(() => resultCreators(connected, daos), [connected, daos]);
  const fetcher = useCallback(
    async (signal: AbortSignal): Promise<Round[]> => {
      const rounds: Round[] = [];
      for (const creator of creators) {
        let from: bigint | null = null;
        for (;;) {
          const page = await base.engine.views.getRounds({ kind: "Tender", creator }, from ?? undefined, 50, { signal });
          rounds.push(...page.rounds);
          if (page.next === null) break;
          from = page.next;
        }
      }
      return rounds.sort((a, b) => (a.roundId < b.roundId ? 1 : -1));
    },
    [base.engine, creators],
  );
  const { state, refresh } = useEngineQuery(fetcher, { pollMs: 20_000 });

  const addNamed = () => {
    const account = named.trim();
    if (!isNearAccountId(account)) {
      setNamedError("Not a NEAR account id.");
      return;
    }
    setNamedError(null);
    setDaos(rememberDaoAccount(account));
    setNamed("");
  };

  return (
    <Card>
      <CardHeader
        title="Tenders"
        description={creators.length > 0 ? `Rounds created by ${creators.join(", ")}. Settled ones have an exportable report.` : "Connect a NEAR wallet, or name a DAO, to list the Tenders it created."}
        action={
          <Button size="sm" variant="secondary" onClick={() => void refresh()}>
            Refresh
          </Button>
        }
      />
      <CardBody className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <FieldLabel htmlFor="results-creator">Also list a DAO&apos;s Tenders</FieldLabel>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input id="results-creator" value={named} onChange={(event) => setNamed(event.target.value)} placeholder="treasury.sputnikv2.testnet" onKeyDown={(event) => (event.key === "Enter" ? addNamed() : undefined)} />
            <Button variant="secondary" onClick={addNamed} disabled={!named.trim()} data-add-creator>
              Add
            </Button>
          </div>
          {namedError ? <Hint tone="danger">{namedError}</Hint> : null}
          {daos.length > 0 ? (
            <ul className="flex flex-wrap gap-2" aria-label="DAO accounts listed">
              {daos.map((dao) => (
                <li key={dao} className="flex items-center gap-1 rounded-sm border border-ink-700 px-2 py-0.5 text-[12px] text-ink-200">
                  {dao}
                  <button type="button" onClick={() => setDaos(forgetDaoAccount(dao))} className="text-ink-400 hover:text-ink-50" aria-label={`Stop listing ${dao}`}>
                    ×
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        {creators.length === 0 ? (
          <EmptyState illustration="tender" title="No account to list" description="Tenders are listed by creator account: connect the issuer's NEAR wallet or add the DAO that files them." />
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
          <EmptyState illustration="tender" title="No Tender yet" description="Launch one from New Tender (step 5, Launch Tender): the round appears here with its status, and its report once settled." />
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Round</TH>
                <TH>Creator</TH>
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
                    <TD>{round.creator === connected ? "You" : round.creator}</TD>
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
                        <Link href={`${ROUTES.issuer}/results/${round.roundId.toString()}`} className="text-[12px] text-ember-300 underline-offset-2 hover:underline font-medium">
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
        {state.status === "ok" && endedDaoCreators(state.value, connected).length > 0 ? (
          <section className="flex flex-col gap-2" aria-label="DAO budgets" data-dao-budgets>
            <FieldLabel>After a DAO&apos;s Tender</FieldLabel>
            {endedDaoCreators(state.value, connected).map((dao) => (
              <DaoWithdrawal key={dao} base={base} dao={dao} />
            ))}
          </section>
        ) : null}
      </CardBody>
    </Card>
  );
}
