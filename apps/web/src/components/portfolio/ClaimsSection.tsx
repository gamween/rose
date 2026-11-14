"use client";

import type { PayoutView } from "@rose/sdk";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardHeader } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/Table";
import { cashDecimalsOf, formatAmount, formatVenueCash, venueLabel } from "@/lib/amounts";
import { NEAR_TUSDC_ACCOUNT } from "@/lib/deployment";
import { describePayout } from "@/lib/payouts";
import { classLabel } from "@/lib/token-symbols";
import type { PayoutEntry, PortfolioData } from "./data";
import { CARD_CELL, CARD_ROW, CARD_WIDE } from "./HoldingsSection";
import { pendingHint, settledPayout, type CashRow, type TokenClaim } from "./transforms";

const STATE_LABEL: Record<PayoutEntry["state"], { text: string; tone: "neutral" | "ember" | "success" | "warning" | "danger" }> = {
  requested: { text: "Signature pending", tone: "ember" },
  stale: { text: "Signature request expired", tone: "warning" },
  signed: { text: "Signed, not submitted", tone: "ember" },
  unconfirmed: { text: "Landed, not confirmed", tone: "ember" },
  submitted: { text: "Executed", tone: "success" },
  awaiting_gas: { text: "Gas signature missing", tone: "warning" },
  failed: { text: "Failed, refunded", tone: "danger" },
  lapsed: { text: "Not executed (blockhash expired)", tone: "neutral" },
};

export type ClaimsActions = {
  onClaimCash: (row: CashRow) => void;
  onClaimTokens: (claim: TokenClaim) => void;
  onFinishPayout: (payout: PayoutView) => void;
  onResignGas: (payout: PayoutView) => void;
  onRetrySignature: (payout: PayoutView) => void;
  onConfirmPayout: (payout: PayoutView) => void;
};

/** Claimable cash per venue and tokens per chain in one table with a Claim per row, then the payouts still waiting for the claimant. */
export function ClaimsSection({ data, cash, tokens, actions }: { data: PortfolioData; cash: CashRow[]; tokens: { base: TokenClaim[]; solana: TokenClaim[] }; actions: ClaimsActions }) {
  const pending = data.payouts.filter((entry) => !settledPayout(entry.state));
  const tokenRows = [...tokens.base.map((claim) => ({ claim, chain: "base" as const })), ...tokens.solana.map((claim) => ({ claim, chain: "solana" as const }))];
  const empty = cash.length === 0 && tokenRows.length === 0;
  return (
    <div className="flex flex-col gap-4" data-claims>
      <Card>
        {empty ? (
          <EmptyState illustration="ember" title="Nothing to claim yet" description="Tokens become claimable as your classes unlock; cash after a round settles." />
        ) : (
          <Table className="max-md:block">
            <THead className="max-md:hidden">
              <TR>
                <TH>Asset</TH>
                <TH>Source</TH>
                <TH>Paid on</TH>
                <TH numeric>Amount</TH>
                <TH className="text-right">
                  <span className="sr-only">Actions</span>
                </TH>
              </TR>
            </THead>
            <TBody className="max-md:block">
              {cash.map((row) => (
                <TR key={venueLabel(row.cash.venue)} className={CARD_ROW} data-cash={row.chain}>
                  <TD className={CARD_WIDE}>
                    <span className="text-ink-50" title={row.cash.venue === "Near" ? NEAR_TUSDC_ACCOUNT : row.cash.venue.Base.token}>
                      {venueLabel(row.cash.venue, data.symbols)}
                    </span>
                  </TD>
                  <TD className={CARD_CELL} data-label="Source">
                    Cash
                  </TD>
                  <TD className={CARD_CELL} data-label="Paid on">
                    {row.chain === "near" ? "NEAR testnet" : "Base Sepolia"}
                  </TD>
                  <TD numeric className={CARD_CELL} data-label="Amount">
                    {formatVenueCash(row.cash.amount, cashDecimalsOf(row.cash.venue, data.cashDecimals))}
                  </TD>
                  <TD className={CARD_WIDE}>
                    <div className="flex justify-end max-md:justify-start">
                      <Button size="sm" onClick={() => actions.onClaimCash(row)}>
                        Claim
                      </Button>
                    </div>
                  </TD>
                </TR>
              ))}
              {tokenRows.map(({ claim, chain }) => (
                <TR key={`${claim.source.kind}-${claim.source.classId}-${claim.source.label}`} className={CARD_ROW} data-token-claim={chain}>
                  <TD className={CARD_WIDE}>
                    <span className="text-ink-50" title={`Token ${claim.info.token}`}>
                      {classLabel(claim.info, data.symbols)}
                    </span>
                  </TD>
                  <TD className={CARD_CELL} data-label="Source">
                    <span className="[overflow-wrap:anywhere]" title={claim.source.kind === "retired" ? `Payable only to ${claim.source.retireTo}` : undefined}>
                      {claim.source.label}
                    </span>
                  </TD>
                  <TD className={CARD_CELL} data-label="Paid on">
                    {chain === "base" ? "Base Sepolia" : "Solana devnet"}
                  </TD>
                  <TD numeric className={CARD_CELL} data-label="Amount">
                    {formatAmount(claim.source.amount, claim.info.decimals)}
                  </TD>
                  <TD className={CARD_WIDE}>
                    <div className="flex justify-end max-md:justify-start">
                      <Button size="sm" onClick={() => actions.onClaimTokens(claim)}>
                        Claim
                      </Button>
                    </div>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
      {pending.length > 0 ? (
        <Card>
          <CardHeader title="Payouts in progress" description="A signed payout never expires: finish it whenever you want." />
          <ul className="flex flex-col divide-y divide-(--border-hairline)">
            {pending.map(({ payout, state }) => {
              const label = STATE_LABEL[state];
              return (
                <li key={payout.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5" data-payout={payout.id} data-payout-state={state}>
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 text-[13px] text-ink-50">
                      <span className="[overflow-wrap:anywhere]">
                        #{payout.id} · {describePayout(payout, (token) => [...data.classes.values()].find((info) => info.token.toLowerCase() === token.toLowerCase())?.decimals ?? (data.config.base_cash_tokens.includes(token.toLowerCase()) ? 6 : null), formatAmount)}
                      </span>
                      <Badge tone={label.tone}>{label.text}</Badge>
                    </p>
                    <p className="mt-0.5 text-[12px] text-ink-400">{pendingHint(payout, state, data.blockHeight)}</p>
                  </div>
                  {state === "signed" ? (
                    <Button size="sm" onClick={() => actions.onFinishPayout(payout)}>
                      {payout.chain === "Base" ? "Submit on Base" : "Broadcast on Solana"}
                    </Button>
                  ) : null}
                  {state === "unconfirmed" ? (
                    <Button size="sm" onClick={() => actions.onConfirmPayout(payout)}>
                      Confirm
                    </Button>
                  ) : null}
                  {state === "awaiting_gas" ? (
                    <Button size="sm" variant="secondary" onClick={() => actions.onResignGas(payout)}>
                      Re-sign gas
                    </Button>
                  ) : null}
                  {state === "stale" ? (
                    <Button size="sm" variant="secondary" onClick={() => actions.onRetrySignature(payout)}>
                      Retry signature
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}
