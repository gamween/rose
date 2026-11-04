"use client";

/**
 * The live part of each demo step: what the engine's views return right now for the seeded
 * round (parameters, sealed book, key release, openings, curves, verification, fills, positions).
 * Every number here is read from NEAR testnet; the manifest only supplies names and hashes.
 */

import type { Bid, BidOutcome, Venue } from "@rose/sdk";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ClearingChart } from "@/components/rounds/ClearingChart";
import { buildBook, roundCurves } from "@/components/rounds/curves";
import { ciphertextHash } from "@/components/rounds/ibe";
import { classLabel, formatDateTime, formatDuration, formatQty, formatUsdc, lockedPercent, nsToMs, shortHex } from "@/components/rounds/model";
import { KindBadge, Param, StatusBadge } from "@/components/rounds/shared";
import { verifyRound } from "@/components/rounds/verify";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/Table";
import { cn } from "@/lib/cn";
import type { DemoManifest, DemoScenario } from "@/lib/demo/manifest";
import type { WalkStep } from "@/lib/demo/walkthrough";
import { deployed } from "@/lib/deployment";
import { addressUrl, nearAccountUrl } from "@/lib/explorer";
import type { DemoLive } from "./useDemoRound";

export interface PanelProps {
  manifest: DemoManifest;
  scenario: DemoScenario;
  step: WalkStep;
  live: DemoLive;
}

function Box({ label, children, note, data }: { label: string; children: ReactNode; note?: ReactNode; data?: string }) {
  return (
    <section aria-label={label} className="rounded-lg border border-ink-750 bg-ink-850" data-demo-panel={data}>
      <h3 className="flex flex-wrap items-baseline justify-between gap-2 border-b border-ink-750 px-4 py-2.5">
        <span className="font-display text-[11px] uppercase tracking-wide text-ink-300">{label}</span>
        <span className="text-[11px] text-ink-500">read live from the engine</span>
      </h3>
      <div className="px-4 py-3">{children}</div>
      {note ? <p className="border-t border-ink-750 px-4 py-2 text-[11px] text-ink-500">{note}</p> : null}
    </section>
  );
}

function Grid({ children }: { children: ReactNode }) {
  return <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3 xl:grid-cols-4">{children}</dl>;
}

function nameOf(manifest: DemoManifest, account: string): string {
  return manifest.people.find((person) => person.account === account)?.name ?? account;
}

function venueText(venue: Venue): string {
  if (venue === "Near") return "tUSDC on NEAR";
  const tusdc = deployed("baseTestUsdc");
  return tusdc && venue.Base.token.toLowerCase() === tusdc.toLowerCase() ? "tUSDC on Base (RoseVault)" : `${shortHex(venue.Base.token)} on Base`;
}

function Person({ manifest, account }: { manifest: DemoManifest; account: string }) {
  return (
    <a href={nearAccountUrl(account)} target="_blank" rel="noreferrer" className="underline-offset-2 hover:underline" title={account}>
      {nameOf(manifest, account)}
    </a>
  );
}

function symbolOf(props: PanelProps): string {
  return props.live.symbol ?? props.manifest.token.symbol;
}

function ClassPanel(props: PanelProps) {
  const { live } = props;
  const { cls } = live;
  const unlocked = Number((cls.fractionNow * 10_000n) / 10n ** 18n) / 100;
  return (
    <Box label="Class" data="class">
      <Grid>
        <Param label="Class" mono={false} className="col-span-2">
          <span>{classLabel(cls, symbolOf(props))}</span>
          <span className="tabular block truncate text-[11px] text-ink-500">{cls.classId}</span>
        </Param>
        <Param label="Token" mono={false}>
          <a href={addressUrl(cls.chain === "Base" ? "base" : "solana", cls.token)} target="_blank" rel="noreferrer" className="tabular underline-offset-2 hover:underline">
            {shortHex(cls.token)} ↗
          </a>
        </Param>
        <Param label="Positions">{String(cls.positions)}</Param>
        <Param label="Units outstanding">{formatQty(cls.totalUnits, cls.decimals, 2)}</Param>
        <Param label="Unlocked today">{unlocked.toFixed(2)}%</Param>
      </Grid>
    </Box>
  );
}

function PositionsPanel(props: PanelProps) {
  const { live, manifest, scenario } = props;
  const byId = new Map(live.positions.map((position) => [position.positionId.toString(), position]));
  return (
    <Box label="Positions held by the engine" data="positions" note="Units equal the attested allocation; each holder can trade them, lock them in rounds or redeem in kind.">
      <Table className="min-w-[600px]">
        <THead>
          <TR>
            <TH>Position</TH>
            <TH>Holder</TH>
            <TH>Source</TH>
            <TH numeric>Allocation</TH>
            <TH>State</TH>
          </TR>
        </THead>
        <TBody>
          {scenario.positions.map((entry) => {
            const position = byId.get(entry.positionId);
            return (
              <TR key={entry.positionId} data-demo-position={entry.positionId}>
                <TD className="tabular">#{entry.positionId}</TD>
                <TD>
                  <Person manifest={manifest} account={entry.account} />
                </TD>
                <TD className="text-ink-300">{entry.source}</TD>
                <TD numeric>{position ? formatQty(position.allocation, live.cls.decimals, 2) : "—"}</TD>
                <TD className={position?.state === "Released" ? "text-ink-400" : "text-success-400"}>{position ? (position.state === "Released" ? "Released (redeemed)" : position.state) : "not found"}</TD>
              </TR>
            );
          })}
        </TBody>
      </Table>
    </Box>
  );
}

function CashPanel(props: PanelProps) {
  const { live } = props;
  const { round, bids } = live;
  const escrowed = bids.reduce((sum, bid) => sum + bid.escrow, 0n);
  const bonds = bids.reduce((sum, bid) => sum + bid.bond, 0n);
  return (
    <Box label="Cash in the round" data="cash">
      <Grid>
        <Param label="Venue" mono={false}>
          {venueText(round.venue)}
        </Param>
        {round.kind === "Tender" ? (
          <>
            <Param label="Budget">{formatUsdc(round.budget ?? 0n)} USDC</Param>
            <Param label="Issuer escrow">{formatUsdc(round.issuerEscrow ?? 0n)} USDC</Param>
          </>
        ) : (
          <Param label="Buyers' escrow">{formatUsdc(escrowed)} USDC</Param>
        )}
        <Param label="Bonds posted">{formatUsdc(bonds)} USDC</Param>
      </Grid>
    </Box>
  );
}

function ParametersPanel(props: PanelProps) {
  const { live, manifest } = props;
  const { round, cls } = live;
  return (
    <Box label={`Round #${round.roundId.toString()}`} data="parameters">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <KindBadge kind={round.kind} />
        <StatusBadge status={round.status} />
      </div>
      <Grid>
        <Param label="Created by" mono={false}>
          <Person manifest={manifest} account={round.creator} />
        </Param>
        <Param label="Cash venue" mono={false}>
          {venueText(round.venue)}
        </Param>
        <Param label="Max price">{formatUsdc(round.maxPrice)} USDC</Param>
        {round.kind === "Tender" ? <Param label="Budget">{formatUsdc(round.budget ?? 0n)} USDC</Param> : null}
        {round.kind === "Advance" ? (
          <>
            <Param label="Units encumbered">{formatQty(round.advanceUnits ?? 0n, cls.decimals)}</Param>
            <Param label="Claim (K)">{formatQty(round.advanceClaim ?? 0n, cls.decimals)} tokens</Param>
          </>
        ) : null}
        <Param label="Locked at close">{lockedPercent(round.fTs)}</Param>
        <Param label="Closes">{formatDateTime(nsToMs(round.closesAt))}</Param>
        <Param label="Key timeout">{formatDuration(Number(round.keyTimeout) / 1e9)}</Param>
        <Param label="Reveal window">{formatDuration(Number(round.revealWindow) / 1e9)}</Param>
        <Param label="Identity (app_id)" className="col-span-2">
          <span title={round.appId}>{round.appId.slice(0, 24)}…</span>
        </Param>
      </Grid>
    </Box>
  );
}

function useHashes(bids: readonly Bid[]): Map<number, string> {
  const [hashes, setHashes] = useState<Map<number, string>>(() => new Map());
  useEffect(() => {
    let cancelled = false;
    void Promise.all(bids.filter((bid) => bid.ciphertextHex).map(async (bid) => [bid.bidId, await ciphertextHash(bid.ciphertextHex ?? "")] as const)).then((entries) => {
      if (!cancelled) setHashes(new Map(entries));
    });
    return () => {
      cancelled = true;
    };
  }, [bids]);
  return hashes;
}

function collateralText(bid: Bid, decimals: number): string {
  return bid.side === "Buy" ? `${formatUsdc(bid.escrow)} USDC` : `${formatQty(bid.lockedUnits, decimals, 2)} units`;
}

function SealedPanel(props: PanelProps) {
  const { live, manifest, scenario } = props;
  const hashes = useHashes(live.bids);
  return (
    <Box
      label="Sealed book"
      data="book"
      note="Settlement keeps each order's outcome and drops its ciphertext from the engine's state; the ciphertext itself stays in the place transaction linked below. The hash is the one recorded when the order was posted, recomputed in this browser whenever the engine still stores the ciphertext."
    >
      <Table className="min-w-[600px]">
        <THead>
          <TR>
            <TH>#</TH>
            <TH>Side</TH>
            <TH>Participant</TH>
            <TH numeric>Public collateral</TH>
            <TH numeric>Bond</TH>
            <TH>Ciphertext SHA-256</TH>
          </TR>
        </THead>
        <TBody>
          {live.bids.map((bid) => {
            const recorded = scenario.orders.find((order) => order.bidId === bid.bidId);
            const computed = hashes.get(bid.bidId);
            const hash = computed ?? recorded?.ciphertextSha256;
            return (
              <TR key={bid.bidId} data-demo-sealed={bid.bidId}>
                <TD className="tabular">{String(bid.bidId)}</TD>
                <TD className={bid.side === "Buy" ? "text-success-400" : "text-rose-300"}>{bid.side === "Buy" ? "Bid" : "Ask"}</TD>
                <TD>
                  <Person manifest={manifest} account={bid.bidder} />
                  {recorded?.malformed ? <span className="ml-1.5 font-display text-[10px] uppercase tracking-wide text-warning-400">malformed</span> : null}
                </TD>
                <TD numeric>{collateralText(bid, live.cls.decimals)}</TD>
                <TD numeric>{formatUsdc(bid.bond)}</TD>
                <TD>
                  <span className="tabular text-[11px] text-ink-300" title={hash} data-demo-hash>
                    {hash ? `${hash.slice(0, 16)}…` : "—"}
                  </span>
                  {computed !== undefined ? (
                    <span className={cn("ml-2 text-[11px]", computed === recorded?.ciphertextSha256 ? "text-success-400" : "text-danger-400")}>{computed === recorded?.ciphertextSha256 ? "matches the seal" : "differs from the seal"}</span>
                  ) : (
                    <span className="ml-2 text-[11px] text-ink-500">as posted</span>
                  )}
                </TD>
              </TR>
            );
          })}
        </TBody>
      </Table>
    </Box>
  );
}

function KeyPanel(props: PanelProps) {
  const { round } = props.live;
  const latency = round.keyReceivedAt !== null && round.closeRequestedAt !== null ? Number(round.keyReceivedAt - round.closeRequestedAt) / 1e9 : null;
  return (
    <Box label="Key release" data="key">
      <Grid>
        <Param label="Close requested">{round.closeRequestedAt !== null ? formatDateTime(nsToMs(round.closeRequestedAt)) : "—"}</Param>
        <Param label="Key stored">{round.keyReceivedAt !== null ? formatDateTime(nsToMs(round.keyReceivedAt)) : "—"}</Param>
        <Param label="MPC latency">
          <span className="text-[15px] text-ember-200" data-demo-latency>
            {latency !== null ? `${latency.toFixed(2)} s` : "—"}
          </span>
        </Param>
        <Param label="Delivered by" mono={false}>
          {round.keySource === "Submitted" ? "submit_key (anyone)" : round.keySource === "Callback" ? "MPC callback" : "—"}
        </Param>
        <Param label="Round key (BLS12-381, G1)" className="col-span-2 sm:col-span-3 xl:col-span-4">
          <span className="block truncate" title={round.key ?? undefined}>
            {round.key ?? "not released"}
          </span>
        </Param>
      </Grid>
    </Box>
  );
}

function OpeningsPanel(props: PanelProps) {
  const { live, manifest, scenario, step } = props;
  const gasOf = (bidId: number) => step.txs.find((tx) => !tx.failed && new RegExp(`open_bid ${String(bidId)}\\b`).test(tx.label))?.gasTgas ?? null;
  return (
    <Box label="Openings" data="openings" note="Each opening is checked by the contract against the ciphertext and the public round key. The last column is the seed script's own check of the opened values against each participant's private record of the order.">
      <Table className="min-w-[600px]">
        <THead>
          <TR>
            <TH>#</TH>
            <TH>Participant</TH>
            <TH numeric>Opened on chain</TH>
            <TH numeric>Verification gas</TH>
            <TH>Against the sealed order</TH>
          </TR>
        </THead>
        <TBody>
          {live.bids.map((bid) => {
            const check = scenario.openings.find((opening) => opening.bidId === bid.bidId);
            const gas = gasOf(bid.bidId);
            return (
              <TR key={bid.bidId} data-demo-opening={bid.bidId}>
                <TD className="tabular">{String(bid.bidId)}</TD>
                <TD>
                  <Person manifest={manifest} account={bid.bidder} />
                </TD>
                <TD numeric>{bid.opened ? `${formatQty(bid.opened.quantity, live.cls.decimals, 2)} @ ${formatUsdc(bid.opened.price)}` : <span className="text-danger-400">never opened</span>}</TD>
                <TD numeric>{gas !== null ? `${gas.toFixed(1)} Tgas` : "—"}</TD>
                <TD className="text-[12px]">
                  {check?.unopenable ? (
                    <span className="text-warning-400" data-demo-check="unopenable">
                      cannot be decrypted by anyone
                    </span>
                  ) : check?.matchesSealed === true ? (
                    <span className="text-success-400" data-demo-check="match">
                      same quantity and price
                    </span>
                  ) : check?.matchesSealed === false ? (
                    <span className="text-danger-400" data-demo-check="mismatch">
                      differs from the record
                    </span>
                  ) : (
                    <span className="text-ink-500">not recorded</span>
                  )}
                </TD>
              </TR>
            );
          })}
        </TBody>
      </Table>
    </Box>
  );
}

function CurvesPanel(props: PanelProps) {
  const { round, bids, cls } = props.live;
  const book = useMemo(() => buildBook(round, bids), [bids, round]);
  const curves = useMemo(() => roundCurves(round, cls.decimals, book), [book, cls.decimals, round]);
  const result = round.result;
  return (
    <Box label="Supply and demand" data="curves">
      <ClearingChart curves={curves} decimals={cls.decimals} kind={round.kind} clearing={result ? { price: result.price, volume: result.volume } : null} noCrossing={round.status === "Cancelled" && round.cancelReason === "NoCrossing"} />
      {result ? (
        <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-ink-750 pt-3 sm:grid-cols-4">
          <Param label="Clearing price">
            <span className="text-[15px] text-ember-200" data-demo-price>
              {formatUsdc(result.price)} USDC
            </span>
          </Param>
          <Param label="Volume">{formatQty(result.volume, cls.decimals, 2)}</Param>
          <Param label="Notional">{formatUsdc(result.notional)} USDC</Param>
          <Param label="Fee (30 bps)">{formatUsdc(result.fee)} USDC</Param>
        </dl>
      ) : null}
    </Box>
  );
}

function VerifyPanel(props: PanelProps) {
  const { live, scenario } = props;
  const verification = useMemo(() => verifyRound(live.round, live.cls.decimals, live.bids), [live]);
  const ok = verification.status === "match";
  return (
    <Box label="Verify in this browser" data="verify" note={scenario.clearingMatchesReference ? "The seed script ran the same reference against the engine's result when it cleared the round, and matched too." : undefined}>
      <p className={cn("font-display text-[16px]", ok ? "text-success-400" : "text-danger-400")} data-demo-verify={verification.status}>
        {ok ? "Match: the browser reproduces the on-chain result exactly" : verification.status === "mismatch" ? "Mismatch" : (verification.reason ?? "Not comparable")}
      </p>
      {verification.local && verification.onChain ? (
        <div className="mt-3">
          <Table>
            <THead>
              <TR>
                <TH>Field</TH>
                <TH numeric>This browser</TH>
                <TH numeric>On chain</TH>
              </TR>
            </THead>
            <TBody>
              <TR>
                <TD>Clearing price</TD>
                <TD numeric>{verification.local.price !== null ? `${formatUsdc(verification.local.price)} USDC` : "no crossing"}</TD>
                <TD numeric>{verification.onChain.price !== null ? `${formatUsdc(verification.onChain.price)} USDC` : "no crossing"}</TD>
              </TR>
              <TR>
                <TD>Volume</TD>
                <TD numeric>{verification.local.volume !== null ? formatQty(verification.local.volume, live.cls.decimals, 4) : "—"}</TD>
                <TD numeric>{verification.onChain.volume !== null ? formatQty(verification.onChain.volume, live.cls.decimals, 4) : "—"}</TD>
              </TR>
              <TR>
                <TD>Orders filled</TD>
                <TD numeric>{String(verification.local.fills.filter((fill) => fill.qty > 0n).length)}</TD>
                <TD numeric>{String(verification.onChain.fills.length)}</TD>
              </TR>
            </TBody>
          </Table>
        </div>
      ) : null}
      {verification.differences.length > 0 ? (
        <ul className="mt-2 list-disc pl-5 text-[12px] text-danger-400">
          {verification.differences.map((difference) => (
            <li key={difference}>{difference}</li>
          ))}
        </ul>
      ) : null}
      {verification.book.excluded.length > 0 ? <p className="mt-2 text-[12px] text-ink-400">Left out of the book: {verification.book.excluded.map((entry) => `#${String(entry.bidId)} (${entry.reason === "Unopened" ? "never opened" : entry.reason})`).join(", ")}.</p> : null}
    </Box>
  );
}

type FillRow = Pick<BidOutcome, "bidId" | "bidder" | "side" | "escrow" | "fillQuantity" | "cash" | "fee" | "bond" | "void" | "settled">;

function FillsPanel(props: PanelProps) {
  const { live, manifest } = props;
  const rows: FillRow[] = live.round.result?.fills ?? live.bids.map((bid) => ({ ...bid, settled: bid.status === "Settled" }));
  return (
    <Box label={live.round.result ? "Fills and settlement" : "Settlement"} data="fills">
      <Table className="min-w-[600px]">
        <THead>
          <TR>
            <TH>#</TH>
            <TH>Participant</TH>
            <TH numeric>Filled</TH>
            <TH numeric>Cash</TH>
            <TH numeric>Fee</TH>
            <TH numeric>Escrow back</TH>
            <TH>Bond</TH>
          </TR>
        </THead>
        <TBody>
          {rows.map((row) => {
            const slashed = row.void !== null;
            return (
              <TR key={row.bidId} data-demo-fill={row.bidId}>
                <TD className="tabular">{String(row.bidId)}</TD>
                <TD>
                  <Person manifest={manifest} account={row.bidder} />
                  <span className={cn("ml-1.5 text-[11px]", row.side === "Buy" ? "text-success-400" : "text-rose-300")}>{row.side === "Buy" ? "bid" : "ask"}</span>
                </TD>
                <TD numeric>{formatQty(row.fillQuantity, live.cls.decimals, 2)}</TD>
                <TD numeric>{formatUsdc(row.cash)}</TD>
                <TD numeric>{formatUsdc(row.fee)}</TD>
                <TD numeric>{row.side === "Buy" ? formatUsdc(row.escrow - row.cash - row.fee) : "—"}</TD>
                <TD className={cn("text-[12px]", slashed ? "text-danger-400" : "text-ink-300")} data-demo-bond={slashed ? "slashed" : "refunded"}>
                  {formatUsdc(row.bond)} {slashed ? "slashed (void, never opened)" : row.settled ? "refunded" : "pending"}
                </TD>
              </TR>
            );
          })}
        </TBody>
      </Table>
    </Box>
  );
}

function CancelPanel(props: PanelProps) {
  const { round } = props.live;
  return (
    <Box label={`Round #${round.roundId.toString()}`} data="cancel">
      <Grid>
        <Param label="Status" mono={false}>
          <StatusBadge status={round.status} />
        </Param>
        <Param label="Reason" mono={false}>
          {round.cancelReason === "NoKey" ? "no key before the timeout" : (round.cancelReason ?? "—")}
        </Param>
        <Param label="Key timeout">{formatDuration(Number(round.keyTimeout) / 1e9)}</Param>
        <Param label="Round key" mono={false}>
          {round.key ?? "never stored"}
        </Param>
      </Grid>
    </Box>
  );
}

/** The live panel of `step`, or null for steps whose evidence is their transactions only. */
export function LivePanel(props: PanelProps) {
  switch (props.step.id) {
    case "custody":
      return <ClassPanel {...props} />;
    case "deposit":
    case "redeem":
      return props.scenario.positions.length > 0 ? <PositionsPanel {...props} /> : null;
    case "cash":
      return <CashPanel {...props} />;
    case "create":
      return <ParametersPanel {...props} />;
    case "seal":
      return <SealedPanel {...props} />;
    case "close":
      return <KeyPanel {...props} />;
    case "open":
      return <OpeningsPanel {...props} />;
    case "clear":
      return <CurvesPanel {...props} />;
    case "verify":
      return <VerifyPanel {...props} />;
    case "settle":
      return <FillsPanel {...props} />;
    case "cancel":
      return <CancelPanel {...props} />;
    case "payout":
      return null;
  }
}
