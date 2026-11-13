"use client";

import Link from "next/link";
import { useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button, ButtonLink } from "@/components/ui/Button";
import { Card, CardBody } from "@/components/ui/Card";
import { DetailsList } from "@/components/ui/DetailsList";
import { EmptyState } from "@/components/ui/EmptyState";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/Table";
import { formatAmount, formatDay, formatFraction, secondsToMs, shortHex } from "@/lib/amounts";
import { cn } from "@/lib/cn";
import { classLabel } from "@/lib/token-symbols";
import { scheduleBounds } from "@/lib/unlock-schedule";
import { ROUTES } from "@/lib/routes";
import type { PortfolioData } from "./data";
import { UnlockChart } from "./UnlockChart";
import type { HoldingRow } from "./transforms";

/**
 * Below the `md` breakpoint each table row becomes a card: the header row hides and every value
 * cell prints its column name (from `data-label`) above the value, so nothing scrolls sideways at
 * 375 px while the desktop keeps the dense table.
 */
export const CARD_ROW = "max-md:grid max-md:grid-cols-2 max-md:gap-x-4 max-md:gap-y-2.5 max-md:px-3 max-md:py-3 max-md:hover:bg-transparent";
export const CARD_CELL = "max-md:h-auto max-md:px-0 max-md:text-left max-md:before:mb-0.5 max-md:before:block max-md:before:text-[11px] max-md:before:text-ink-400 max-md:before:content-[attr(data-label)] max-md:before:font-medium";
export const CARD_WIDE = "max-md:col-span-2 max-md:h-auto max-md:px-0";

function ChainBadge({ chain }: { chain: "Base" | "Solana" }) {
  return <Badge tone={chain === "Base" ? "info" : "ember"}>{chain === "Base" ? "Base" : "Solana"}</Badge>;
}

/** Units per class with what is unlocked and claimable, one Claim per row; the timeline, the other balances and Redeem open under the row. */
export function HoldingsSection({ rows, data, onClaim, onRedeem }: { rows: HoldingRow[]; data: PortfolioData; onClaim: (row: HoldingRow) => void; onRedeem: (row: HoldingRow) => void }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const expandedRow = rows.find((row) => row.info.classId === expanded) ?? null;
  if (rows.length === 0) {
    return (
      <Card data-holdings>
        <EmptyState
          illustration="vault"
          title="No units yet"
          description="Deposit a locked Sablier or Streamflow position to mint units."
          action={
            <div className="flex flex-wrap items-center justify-center gap-3">
              <ButtonLink href="/app/deposit">Deposit a position</ButtonLink>
              <Link href={ROUTES.rounds} className="text-[12px] text-ember-300 underline-offset-2 hover:underline font-medium">
                Browse rounds →
              </Link>
            </div>
          }
        />
      </Card>
    );
  }
  return (
    <Card data-holdings>
      <Table className="max-md:block">
        <THead className="max-md:hidden">
          <TR>
            <TH>Class</TH>
            <TH numeric>Units</TH>
            <TH numeric>Unlocked</TH>
            <TH numeric>Claimable</TH>
            <TH className="text-right">
              <span className="sr-only">Actions</span>
            </TH>
          </TR>
        </THead>
        <TBody className="max-md:block">
          {rows.map((row) => {
            const symbol = classLabel(row.info, data.symbols);
            const open = expanded === row.info.classId;
            return (
              <TR key={row.info.classId} data-holding={row.info.classId} className={CARD_ROW}>
                <TD className={CARD_WIDE}>
                  <span className="flex items-center gap-2 text-ink-50">
                    <span title={`Token ${row.info.token}`}>{symbol}</span>
                    <ChainBadge chain={row.info.chain} />
                  </span>
                </TD>
                <TD numeric className={CARD_CELL} data-label="Units">
                  {formatAmount(row.holding.balance, row.info.decimals)}
                </TD>
                <TD numeric className={CARD_CELL} data-label="Unlocked">
                  {formatFraction(row.fractionNow)}
                </TD>
                <TD numeric className={cn(CARD_CELL, row.holding.claimable > 0n && "text-success-400")} data-label="Claimable">
                  {formatAmount(row.holding.claimable, row.info.decimals)}
                </TD>
                <TD className={CARD_WIDE}>
                  <div className="flex flex-wrap items-center justify-end gap-1.5 max-md:justify-start">
                    <Button size="sm" variant={row.holding.claimable > 0n ? "primary" : "secondary"} disabled={row.holding.claimable === 0n} title={row.holding.claimable === 0n ? "Nothing claimable yet" : undefined} onClick={() => onClaim(row)}>
                      Claim
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setExpanded(open ? null : row.info.classId)} aria-expanded={open} data-holding-details-toggle>
                      {open ? "Hide" : "Details"}
                    </Button>
                  </div>
                </TD>
              </TR>
            );
          })}
        </TBody>
      </Table>
      {expandedRow ? <HoldingDetails row={expandedRow} data={data} onRedeem={onRedeem} /> : null}
    </Card>
  );
}

/** Under an expanded holding: its unlock timeline, the balances behind the row and the in-kind redeem. */
function HoldingDetails({ row, data, onRedeem }: { row: HoldingRow; data: PortfolioData; onRedeem: (row: HoldingRow) => void }) {
  const symbol = classLabel(row.info, data.symbols);
  const bounds = scheduleBounds(row.info.schedule);
  const positions = data.positions.filter((position) => position.classId === row.info.classId);
  const redeemBlocked = positions.length === 0 ? "No held position of this class" : !positions.some((position) => position.allocation <= row.holding.balance) ? "You need at least a position's full allocation in free units" : undefined;
  return (
    <CardBody className="flex flex-col gap-4 border-t border-ink-750" data-holding-timeline={row.info.classId}>
      <UnlockChart schedule={row.info.schedule} decimals={row.info.decimals} units={row.totalUnits} symbol={symbol} now={Number(data.blockTimeSec)} title={`Unlock timeline of ${symbol}`} />
      <DetailsList
        rows={[
          { id: "rounds", label: "In rounds", value: formatAmount(row.holding.lockedInRounds, row.info.decimals), hint: "Keeps accruing to you until the round settles." },
          { id: "liens", label: "Under liens", term: "lien", value: formatAmount(row.holding.encumbered, row.info.decimals) },
          { id: "locked", label: "Locked tokens", value: `${formatAmount(row.lockedTokens, row.info.decimals)} ${symbol}` },
          { id: "schedule", label: "Schedule", value: `${row.info.schedule.kind === "Linear" ? "Sablier linear" : "Streamflow stepped"} · ${formatDay(secondsToMs(bounds.start))} → ${formatDay(secondsToMs(bounds.end))}`, hint: row.info.tokenRisk || undefined },
          { id: "class", label: "Class id", term: "class", value: shortHex(row.info.classId, 10, 8), copy: row.info.classId, mono: true },
          { id: "token", label: "Token", value: shortHex(row.info.token, 10, 8), copy: row.info.token, mono: true },
        ]}
      />
      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm" variant="secondary" disabled={redeemBlocked !== undefined} title={redeemBlocked} onClick={() => onRedeem(row)}>
          Redeem a position in kind
        </Button>
        {redeemBlocked ? <span className="text-[12px] text-ink-400">{redeemBlocked}</span> : null}
      </div>
    </CardBody>
  );
}
