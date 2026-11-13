"use client";

/**
 * The Details tab of a round: every public parameter, the sealing identity and round key, then
 * the settlement and payout links. Nothing here is needed to act; it is the full record, kept one
 * click away from the page.
 */

import { CopyButton } from "@/components/ui/CopyButton";
import { DetailsList, type DetailRow } from "@/components/ui/DetailsList";
import { addressUrl, nearAccountUrl, shorten } from "@/lib/explorer";
import { classLabel, formatDateTime, formatDuration, formatQty, formatUsdc, lockedPercent, nsToMs, venueChain, venueLabel, venueTokenAccount } from "./model";
import { SettlementPanel } from "./SettlementPanel";
import type { RoundDetail } from "./useRoundDetail";

function parameterRows(detail: RoundDetail): DetailRow[] {
  const { round, cls, symbol } = detail;
  const tokenChain = cls.chain === "Solana" ? "solana" : "base";
  const venueAccount = venueTokenAccount(round.venue);
  const rows: DetailRow[] = [
    { id: "class", label: "Class", term: "class", value: classLabel(cls, symbol) },
    { id: "class-id", label: "Class id", value: shorten(cls.classId, 14, 10), copy: cls.classId, mono: true },
    { id: "token", label: `Token on ${cls.chain}`, value: shorten(cls.token, 10, 8), href: addressUrl(tokenChain, cls.token), copy: cls.token, mono: true },
    { id: "venue", label: "Cash venue", term: "cashVenue", value: venueLabel(round.venue), hint: venueAccount, href: venueChain(round.venue) === "near" ? nearAccountUrl(venueAccount) : addressUrl("base", venueAccount) },
    { id: "max-price", label: "Max price", term: "maxPrice", value: `${formatUsdc(round.maxPrice)} USDC` },
    { id: "locked", label: "Locked at close", term: "lockedFraction", value: lockedPercent(round.fTs), hint: `f(ts) per unit · ${formatDuration(Number(round.remainingLockSecs))} of lock left` },
    { id: "creator", label: "Creator", value: round.creator, href: nearAccountUrl(round.creator), mono: true },
  ];
  if (round.kind === "Tender") {
    rows.push(
      { id: "budget", label: "Budget", value: `${formatUsdc(round.budget ?? 0n)} USDC` },
      { id: "issuer-escrow", label: "Issuer escrow", value: `${formatUsdc(round.issuerEscrow ?? 0n)} USDC`, hint: "budget + 30 bps" },
    );
    if (round.referencePrice !== null) rows.push({ id: "reference", label: "Declared reference", value: `${formatUsdc(round.referencePrice)} USDC` });
    rows.push({ id: "retire-to", label: "Retire to", value: round.retireTo ?? "—", copy: round.retireTo ?? undefined, mono: true });
  }
  if (round.kind === "Advance") {
    rows.push(
      { id: "units-encumbered", label: "Units encumbered", value: formatQty(round.advanceUnits ?? 0n, cls.decimals) },
      { id: "claim", label: "Claim (K)", value: `${formatQty(round.advanceClaim ?? 0n, cls.decimals)} tokens` },
      { id: "min-fill", label: "Minimum fill", value: formatQty(round.advanceMinFill ?? 0n, cls.decimals) },
    );
    if (round.lienId !== null) rows.push({ id: "lien", label: "Lien", term: "lien", value: `#${round.lienId.toString()}` });
  }
  if (round.kind !== "Tender" && round.maxBuyQuantity !== null && round.maxBuyQuantity !== undefined) {
    rows.push({ id: "max-buy", label: "Largest bid quantity", value: `${formatQty(round.maxBuyQuantity, cls.decimals)}${round.kind === "Advance" ? " tokens" : ""}` });
  }
  rows.push({ id: "opens", label: "Opens", value: formatDateTime(nsToMs(round.opensAt)) }, { id: "closes", label: "Closes", value: formatDateTime(nsToMs(round.closesAt)) });
  return rows;
}

function sealingRows(detail: RoundDetail): DetailRow[] {
  const { round, engine, limits } = detail;
  const rows: DetailRow[] = [
    { id: "app-id", label: "Identity (app_id)", value: shorten(round.appId, 16, 8), copy: round.appId, mono: true },
    { id: "key-timeout", label: "Key timeout", term: "keyTimeout", value: formatDuration(Number(round.keyTimeout) / 1e9) },
    { id: "reveal-window", label: "Reveal window", term: "revealWindow", value: formatDuration(Number(round.revealWindow) / 1e9) },
    { id: "limits", label: "Orders", value: `${String(round.bidCount)} of ${String(limits.maxBidsPerRound)} allowed` },
    { id: "engine", label: "Engine", value: engine.account, href: nearAccountUrl(engine.account), mono: true },
  ];
  return rows;
}

/** The released round key: who delivered it and how long after the close request. */
function KeyRelease({ detail }: { detail: RoundDetail }) {
  const { round } = detail;
  if (!round.key) return null;
  const latency = round.keyReceivedAt !== null && round.closeRequestedAt !== null ? Number(round.keyReceivedAt - round.closeRequestedAt) / 1e9 : null;
  return (
    <section className="min-w-0" data-key-release>
      <h3 className="mb-1 text-[12px] font-medium text-ink-400">Round key</h3>
      <div className="border-y border-(--border-hairline) py-2 text-[12px]">
        <p className="text-ink-300">
          <span className="text-success-400 font-medium">Released</span> · {round.keySource === "Submitted" ? "submitted by a participant" : "MPC callback"}
          {latency !== null ? <span className="tabular"> · {latency.toFixed(1)} s after the close request</span> : null}
          {round.keyReceivedAt !== null ? <span> · {formatDateTime(nsToMs(round.keyReceivedAt))}</span> : null}
        </p>
        <p className="mt-1 flex items-start gap-1 font-mono text-[11.5px] leading-5 text-ink-200">
          <span className="min-w-0 [overflow-wrap:anywhere]">{round.key}</span>
          <CopyButton value={round.key} label="Copy the round key" />
        </p>
      </div>
    </section>
  );
}

export function RoundDetails({ detail }: { detail: RoundDetail }) {
  return (
    <div className="flex flex-col gap-5">
      <div className="ui-surface flex flex-col gap-5 rounded-lg px-4 py-4">
        <div data-parameters>
          <DetailsList title="Parameters" rows={parameterRows(detail)} />
        </div>
        <DetailsList title="Sealing" rows={sealingRows(detail)} />
        <KeyRelease detail={detail} />
      </div>
      <SettlementPanel detail={detail} />
    </div>
  );
}
