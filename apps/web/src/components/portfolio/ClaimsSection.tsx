"use client";

import type { PayoutView } from "@rose/sdk";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { formatAmount, formatUsdc, shortHex, venueLabel } from "@/lib/amounts";
import { NEAR_TUSDC_ACCOUNT } from "@/lib/deployment";
import { describePayout } from "@/lib/payouts";
import { classLabel } from "@/lib/token-symbols";
import type { PayoutEntry, PortfolioData } from "./data";
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

/** Claimable cash per venue and tokens per chain, with the payouts still waiting for the claimant. */
export function ClaimsSection({ data, cash, tokens, actions }: { data: PortfolioData; cash: CashRow[]; tokens: { base: TokenClaim[]; solana: TokenClaim[] }; actions: ClaimsActions }) {
  const pending = data.payouts.filter((entry) => !settledPayout(entry.state));
  const nothing = cash.length === 0 && tokens.base.length === 0 && tokens.solana.length === 0 && pending.length === 0;
  return (
    <Card data-claims>
      <CardHeader title="Claims" description="Everything is pull-based: the engine debits first, the MPC signs, and your browser submits on the foreign chain. An authorization that was signed but not submitted stays here; it never expires." />
      <CardBody className="flex flex-col gap-4">
        {nothing ? <p className="text-[13px] text-ink-400">Nothing to claim right now. Claimable tokens appear as your classes unlock; cash appears after a round settles or when you fund a venue.</p> : null}
        {cash.length > 0 ? (
          <section className="flex flex-col gap-2">
            <h4 className="font-display text-[11px] uppercase tracking-wide text-ink-300">Cash</h4>
            <ul className="flex flex-col gap-2">
              {cash.map((row) => (
                <li key={venueLabel(row.cash.venue)} className="flex items-center justify-between gap-3 rounded-md border border-ink-750 bg-ink-900 px-3 py-2" data-cash={row.chain}>
                  <div>
                    <p className="tabular text-[14px] text-ink-50">{formatUsdc(row.cash.amount)}</p>
                    <p className="text-[12px] text-ink-400" title={row.cash.venue === "Near" ? NEAR_TUSDC_ACCOUNT : row.cash.venue.Base.token}>
                      {venueLabel(row.cash.venue, data.symbols)}
                    </p>
                  </div>
                  <Button size="sm" onClick={() => actions.onClaimCash(row)}>
                    Claim
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {(["base", "solana"] as const).map((chain) => {
          const claims = tokens[chain];
          if (claims.length === 0) return null;
          return (
            <section key={chain} className="flex flex-col gap-2">
              <h4 className="font-display text-[11px] uppercase tracking-wide text-ink-300">Tokens on {chain === "base" ? "Base Sepolia" : "Solana devnet"}</h4>
              <ul className="flex flex-col gap-2">
                {claims.map((claim) => (
                  <li key={`${claim.source.kind}-${claim.source.classId}-${claim.source.label}`} className="flex items-center justify-between gap-3 rounded-md border border-ink-750 bg-ink-900 px-3 py-2" data-token-claim={chain}>
                    <div className="min-w-0">
                      <p className="tabular text-[14px] text-ink-50">
                        {formatAmount(claim.source.amount, claim.info.decimals)} <span title={`Token ${claim.info.token}`}>{classLabel(claim.info, data.symbols)}</span>
                      </p>
                      <p className="truncate text-[12px] text-ink-400">
                        {claim.source.label}
                        {claim.source.kind === "retired" ? ` · payable only to ${shortHex(claim.source.retireTo, 8, 6)}` : ""}
                      </p>
                    </div>
                    <Button size="sm" onClick={() => actions.onClaimTokens(claim)}>
                      Claim
                    </Button>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
        {pending.length > 0 ? (
          <section className="flex flex-col gap-2">
            <h4 className="font-display text-[11px] uppercase tracking-wide text-ink-300">Pending payouts</h4>
            <ul className="flex flex-col gap-2">
              {pending.map(({ payout, state }) => {
                const label = STATE_LABEL[state];
                return (
                  <li key={payout.id} className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-ink-750 bg-ink-900 px-3 py-2" data-payout={payout.id} data-payout-state={state}>
                    <div className="min-w-0">
                      <p className="flex items-center gap-2 text-[13px] text-ink-50">
                        #{payout.id} · {describePayout(payout, (token) => [...data.classes.values()].find((info) => info.token.toLowerCase() === token.toLowerCase())?.decimals ?? (data.config.base_cash_tokens.includes(token.toLowerCase()) ? 6 : null), formatAmount)}
                      </p>
                      <p className="flex items-center gap-2 text-[12px] text-ink-400">
                        <Badge tone={label.tone}>{label.text}</Badge>
                        {pendingHint(payout, state, data.blockHeight)}
                      </p>
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
          </section>
        ) : null}
      </CardBody>
    </Card>
  );
}
