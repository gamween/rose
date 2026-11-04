"use client";

import Link from "next/link";
import { useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/Table";
import { formatAmount, formatDay, formatFraction, secondsToMs, shortHex } from "@/lib/amounts";
import { scheduleBounds } from "@/lib/unlock-schedule";
import { ROUTES } from "@/lib/routes";
import { classLabel, type PortfolioData } from "./data";
import { UnlockChart } from "./UnlockChart";
import type { HoldingRow } from "./transforms";

function ChainBadge({ chain }: { chain: "Base" | "Solana" }) {
  return <Badge tone={chain === "Base" ? "info" : "ember"}>{chain === "Base" ? "Base" : "Solana"}</Badge>;
}

/** Units per class with locked and claimable amounts, and the unlock timeline on demand. */
export function HoldingsSection({ rows, data, onClaim, onRedeem }: { rows: HoldingRow[]; data: PortfolioData; onClaim: (row: HoldingRow) => void; onRedeem: (row: HoldingRow) => void }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const expandedRow = rows.find((row) => row.info.classId === expanded) ?? null;
  return (
    <Card data-holdings>
      <CardHeader title="Holdings" description="Units per class, valued with the class unlock function at the current time. Locked tokens unlock by the schedule; claimable tokens accrued to your units already." />
      {rows.length === 0 ? (
        <EmptyState
          illustration="vault"
          title="No units yet"
          description="Deposit a Sablier or Streamflow position to mint units, buy some in an Exit round, or ask an issuer to distribute a cohort to your NEAR account."
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <Link href="/app/deposit" className="font-display text-[11px] uppercase tracking-wide text-ember-300 underline-offset-2 hover:underline">
                Deposit a position →
              </Link>
              <Link href={ROUTES.rounds} className="font-display text-[11px] uppercase tracking-wide text-ember-300 underline-offset-2 hover:underline">
                Browse rounds →
              </Link>
            </div>
          }
        />
      ) : (
        <Table>
          <THead>
            <TR>
              <TH>Class</TH>
              <TH numeric>Units</TH>
              <TH numeric>In rounds / liens</TH>
              <TH numeric>Unlocked</TH>
              <TH numeric>Locked tokens</TH>
              <TH numeric>Claimable</TH>
              <TH className="text-right">Actions</TH>
            </TR>
          </THead>
          <TBody>
            {rows.map((row) => {
              const symbol = classLabel(row.info, data.symbols);
              const open = expanded === row.info.classId;
              const bounds = scheduleBounds(row.info.schedule);
              const positions = data.positions.filter((position) => position.classId === row.info.classId);
              return (
                <TR key={row.info.classId} data-holding={row.info.classId}>
                  <TD>
                    <div className="flex flex-col gap-0.5">
                      <span className="flex items-center gap-2 text-ink-50">
                        {symbol}
                        <ChainBadge chain={row.info.chain} />
                      </span>
                      <span className="tabular text-[11px] text-ink-400" title={row.info.classId}>
                        {shortHex(row.info.classId, 8, 6)} · {formatDay(secondsToMs(bounds.start))} → {formatDay(secondsToMs(bounds.end))}
                      </span>
                    </div>
                  </TD>
                  <TD numeric>{formatAmount(row.holding.balance, row.info.decimals)}</TD>
                  <TD numeric>
                    {formatAmount(row.holding.lockedInRounds, row.info.decimals)} / {formatAmount(row.holding.encumbered, row.info.decimals)}
                  </TD>
                  <TD numeric>{formatFraction(row.fractionNow)}</TD>
                  <TD numeric>{formatAmount(row.lockedTokens, row.info.decimals)}</TD>
                  <TD numeric className={row.holding.claimable > 0n ? "text-success-400" : undefined}>
                    {formatAmount(row.holding.claimable, row.info.decimals)}
                  </TD>
                  <TD>
                    <div className="flex justify-end gap-1.5">
                      <Button size="sm" variant="ghost" onClick={() => setExpanded(open ? null : row.info.classId)} aria-expanded={open}>
                        {open ? "Hide timeline" : "Timeline"}
                      </Button>
                      <Button size="sm" variant="secondary" disabled={row.holding.claimable === 0n} title={row.holding.claimable === 0n ? "Nothing claimable yet" : undefined} onClick={() => onClaim(row)}>
                        Claim
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={positions.length === 0 || !positions.some((position) => position.allocation <= row.holding.balance)}
                        title={positions.length === 0 ? "No held position of this class" : !positions.some((position) => position.allocation <= row.holding.balance) ? "You need at least a position's full allocation in free units" : undefined}
                        onClick={() => onRedeem(row)}
                      >
                        Redeem
                      </Button>
                    </div>
                  </TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
      )}
      {expandedRow ? (
        <CardBody className="flex flex-col gap-2 border-t border-ink-750" data-holding-timeline={expandedRow.info.classId}>
          <p className="text-[12px] text-ink-400">
            Unlock timeline of your {formatAmount(expandedRow.totalUnits, expandedRow.info.decimals)} {classLabel(expandedRow.info, data.symbols)} units ({expandedRow.info.schedule.kind === "Linear" ? "Sablier Lockup Linear" : "Streamflow stepped"} schedule, exact port of the protocol math). {expandedRow.info.tokenRisk}
          </p>
          <UnlockChart schedule={expandedRow.info.schedule} decimals={expandedRow.info.decimals} units={expandedRow.totalUnits} symbol={classLabel(expandedRow.info, data.symbols)} now={Number(data.blockTimeSec)} title={`Unlock timeline of ${classLabel(expandedRow.info, data.symbols)}`} />
        </CardBody>
      ) : null}
      {rows.length > 0 ? (
        <CardBody className="border-t border-ink-750 py-2 text-[11px] text-ink-400">
          Units in rounds keep accruing to you until the round settles; encumbered units accrue to the lien until its claim is delivered. Dust rounding always favors the pool.
        </CardBody>
      ) : null}
    </Card>
  );
}
