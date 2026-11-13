"use client";

import Link from "next/link";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Button, ButtonLink } from "@/components/ui/Button";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/Table";
import { Term } from "@/components/ui/Term";
import { formatAmount, formatUsdc, formatDate, nsToMs } from "@/lib/amounts";
import { ROUTES } from "@/lib/routes";
import { classLabel } from "@/lib/token-symbols";
import type { PortfolioData } from "./data";
import { CARD_CELL, CARD_ROW, CARD_WIDE } from "./HoldingsSection";
import type { LienProgress, OrderRow } from "./transforms";

const STATUS_TONE: Record<string, BadgeTone> = { Sealed: "ember", Opened: "info", Void: "danger", Settled: "success" };

/** The account's sealed bids and asks (live ones first, then settled and void) with links into the round detail. */
export function OrdersSection({ rows, data }: { rows: OrderRow[]; data: PortfolioData }) {
  return (
    <Card data-orders>
      <CardHeader title="Bids and asks" description="Prices and quantities stay sealed until the round closes." />
      {rows.length === 0 ? (
        <EmptyState
          illustration="tender"
          title="No sealed orders"
          description="Place a bid or an ask from a round."
          action={
            <ButtonLink href={ROUTES.rounds} size="sm">
              Browse rounds
            </ButtonLink>
          }
        />
      ) : (
        <Table className="max-md:block">
          <THead className="max-md:hidden">
            <TR>
              <TH>Round</TH>
              <TH>Side</TH>
              <TH>Status</TH>
              <TH numeric>Collateral</TH>
              <TH numeric>Fill</TH>
            </TR>
          </THead>
          <TBody className="max-md:block">
            {rows.map(({ bid }) => {
              const round = data.rounds.get(bid.roundId.toString());
              const info = round ? data.classes.get(round.classId) : undefined;
              return (
                <TR key={`${bid.roundId.toString()}-${String(bid.bidId)}`} data-order={bid.roundId.toString()} className={CARD_ROW}>
                  <TD className={CARD_WIDE}>
                    <Link href={`${ROUTES.rounds}/${bid.roundId.toString()}`} className="text-ink-50 underline-offset-2 hover:underline">
                      #{bid.roundId.toString()} {round ? `${round.kind}` : ""} {info ? `· ${classLabel(info, data.symbols)}` : ""}
                    </Link>
                    {round ? <p className="text-[11px] text-ink-400">closes {formatDate(nsToMs(round.closesAt))}</p> : null}
                  </TD>
                  <TD className={CARD_CELL} data-label="Side">
                    {bid.side === "Buy" ? "Bid" : "Ask"}
                  </TD>
                  <TD className={CARD_CELL} data-label="Status">
                    <Badge tone={STATUS_TONE[bid.status] ?? "neutral"}>{bid.status}</Badge>
                    {bid.void ? <span className="ml-1 text-[11px] text-danger-400">{bid.void}</span> : null}
                  </TD>
                  <TD numeric className={CARD_CELL} data-label="Collateral">
                    <span className="block">{bid.side === "Buy" ? `${formatUsdc(bid.escrow)} USDC` : `${info ? formatAmount(bid.lockedUnits, info.decimals) : bid.lockedUnits.toString()} units`}</span>
                    <span className="block text-[11px] text-ink-400">+ {formatUsdc(bid.bond)} bond</span>
                  </TD>
                  <TD numeric className={CARD_CELL} data-label="Fill">
                    {bid.status === "Settled" ? (info ? formatAmount(bid.fillQuantity, info.decimals) : bid.fillQuantity.toString()) : "—"}
                  </TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
      )}
    </Card>
  );
}

/** Liens the account sold (as holder) and lien shares it bought (as funder). */
export function LiensSection({ held, data, onRelease }: { held: LienProgress[]; data: PortfolioData; onRelease: (lienId: bigint) => void }) {
  const shares = data.portfolio.lienShares;
  return (
    <Card data-liens>
      <CardHeader title={<Term term="lien">Liens</Term>} description="Unlocks of pledged units pay the funders until the claim is delivered." />
      <CardBody className="flex flex-col gap-4">
        <section className="flex flex-col gap-2">
          <h4 className="text-[12px] text-ink-300 font-medium">As holder</h4>
          {held.length === 0 ? (
            <p className="text-[13px] text-ink-400">
              No lien on your units.{" "}
              <Link href="/app/advance" className="text-ember-300 underline-offset-2 hover:underline">
                Create an Advance →
              </Link>
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {held.map(({ lien, remaining, percentDelivered, releasable }) => {
                const info = data.classes.get(lien.classId);
                return (
                  <li key={lien.lienId.toString()} className="rounded-md border border-ink-750 bg-ink-900 px-3 py-2" data-lien={lien.lienId.toString()}>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-[13px] text-ink-50">
                        Lien #{lien.lienId.toString()} · {info ? classLabel(info, data.symbols) : lien.classId.slice(0, 8)} ·{" "}
                        <Link href={`${ROUTES.rounds}/${lien.roundId.toString()}`} className="underline-offset-2 hover:underline">
                          Advance #{lien.roundId.toString()}
                        </Link>
                      </p>
                      {lien.released ? (
                        <Badge tone="success">Released</Badge>
                      ) : releasable ? (
                        <Button size="sm" variant="secondary" onClick={() => onRelease(lien.lienId)}>
                          Release lien
                        </Button>
                      ) : (
                        <Badge tone="ember">Delivering</Badge>
                      )}
                    </div>
                    <div className="mt-2 h-1.5 w-full overflow-hidden rounded-sm bg-ink-800" role="progressbar" aria-valuenow={percentDelivered} aria-valuemin={0} aria-valuemax={100} aria-label="Claim delivered">
                      <div className="h-full bg-ember-500" style={{ width: `${String(percentDelivered)}%` }} />
                    </div>
                    <p className="mt-1 tabular text-[12px] text-ink-400">
                      {info ? formatAmount(lien.delivered, info.decimals) : lien.delivered.toString()} of {info ? formatAmount(lien.claimTotal, info.decimals) : lien.claimTotal.toString()} delivered · {info ? formatAmount(remaining, info.decimals) : remaining.toString()} remaining · {info ? formatAmount(lien.units, info.decimals) : lien.units.toString()} units encumbered
                      {lien.pendingExcess > 0n ? ` · ${info ? formatAmount(lien.pendingExcess, info.decimals) : lien.pendingExcess.toString()} excess back to you` : ""}
                    </p>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
        <section className="flex flex-col gap-2">
          <h4 className="text-[12px] text-ink-300 font-medium">As funder</h4>
          {shares.length === 0 ? (
            <p className="text-[13px] text-ink-400">
              No lien share. Fund an Advance to buy a senior claim on its first unlocks.{" "}
              <Link href="/app/advance" className="text-ember-300 underline-offset-2 hover:underline">
                Browse Advances →
              </Link>
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {shares.map((share) => {
                const info = data.classes.get(share.classId);
                return (
                  <li key={share.lienId.toString()} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-ink-750 bg-ink-900 px-3 py-2" data-lien-share={share.lienId.toString()}>
                    <p className="text-[13px] text-ink-50">
                      Lien #{share.lienId.toString()} · {info ? classLabel(info, data.symbols) : share.classId.slice(0, 8)}
                    </p>
                    <p className="tabular text-[12px] text-ink-400">
                      claim {info ? formatAmount(share.claim, info.decimals) : share.claim.toString()} · received {info ? formatAmount(share.claimed, info.decimals) : share.claimed.toString()} · claimable now{" "}
                      <span className={share.claimable > 0n ? "text-success-400" : undefined}>{info ? formatAmount(share.claimable, info.decimals) : share.claimable.toString()}</span>
                    </p>
                  </li>
                );
              })}
            </ul>
          )}
          {shares.some((share) => share.claimable > 0n) ? <p className="text-[12px] text-ink-400">Claimable lien tokens are listed under Claims with the other token claims.</p> : null}
        </section>
      </CardBody>
    </Card>
  );
}
