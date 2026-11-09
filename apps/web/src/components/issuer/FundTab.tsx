"use client";

import type { Cash } from "@rose/sdk";
import { useCallback, useEffect, useState } from "react";
import { LearnMore } from "@/components/chrome/LearnMore";
import { Button } from "@/components/ui/Button";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Input, NumberInput, selectClasses } from "@/components/ui/Input";
import { useWallets } from "@/components/wallet/WalletProvider";
import { cashDecimalsOf, formatUsdc, formatVenueCash, parseAmount, venueLabel } from "@/lib/amounts";
import { NEAR_TUSDC_ACCOUNT } from "@/lib/deployment";
import { RoseActionError } from "@/lib/errors";
import { depositNearCash, storageNotice, useNearCashStorageNeed } from "@/lib/near-cash";
import { useVenueDecimals, venueDecimals } from "@/lib/token-symbols";
import { useAction } from "@/lib/use-action";
import { BaseCashFunding } from "./BaseCashFunding";
import { isNearAccountId } from "./dao-accounts";
import { ActionFeedback, FieldLabel, Hint, Preview, useVenueOptions, type IssuerBase } from "./shared";

/** Tab 5: funding the issuer's engine cash in the round's venue (NEAR tUSDC, or Base USDC through RoseVault). */
export function FundTab({ base }: { base: IssuerBase }) {
  const wallets = useWallets();
  const venues = useVenueOptions(base);
  const [venueId, setVenueId] = useState(venues[0]?.id ?? "near");
  const [amount, setAmount] = useState("1000");
  const [roundId, setRoundId] = useState("");
  /* Empty means the connected NEAR account; a DAO or any other account can be credited on Base. */
  const [creditInput, setCreditInput] = useState("");
  const [cash, setCash] = useState<Cash[] | null>(null);
  const [baseRuns, setBaseRuns] = useState(0);
  const near = useAction();
  const storageNeed = useNearCashStorageNeed(base.engine, wallets.near.accountId, near.state.status);
  const option = venues.find((item) => item.id === venueId) ?? venues[0]!;
  /** The venue token's decimals (6 for NEAR tUSDC, `decimals()` of a Base token): amounts are parsed only once they are known. */
  const decimals = useVenueDecimals(option.venue);
  const amountUnits = decimals === null ? null : parseAmount(amount, decimals);
  const [venueDecimalsMap, setVenueDecimalsMap] = useState<Map<string, number>>(new Map());

  const creditTo = option.venue === "Near" ? (wallets.near.accountId ?? "") : creditInput.trim() || (wallets.near.accountId ?? "");
  const creditValid = creditTo === "" || isNearAccountId(creditTo);

  const refreshCash = useCallback(async () => {
    if (!creditTo || !isNearAccountId(creditTo)) {
      setCash(null);
      return;
    }
    try {
      setCash(await base.engine.views.getCash(creditTo));
    } catch {
      setCash(null);
    }
  }, [base.engine, creditTo]);

  useEffect(() => {
    let live = true;
    void Promise.all(venues.map(async (item) => [item.venue === "Near" ? "near" : item.venue.Base.token.toLowerCase(), await venueDecimals(item.venue)] as const)).then((entries) => {
      if (live) setVenueDecimalsMap(new Map(entries.flatMap(([key, value]) => (value === null ? [] : [[key, value] as const]))));
    });
    return () => {
      live = false;
    };
  }, [venues]);

  useEffect(() => {
    const timer = window.setTimeout(() => void refreshCash(), 0);
    return () => window.clearTimeout(timer);
  }, [refreshCash, near.state.status, baseRuns]);

  const fundNear = () =>
    near.run("Depositing tUSDC into the engine", async () => {
      if (amountUnits === null || amountUnits <= 0n) throw new RoseActionError("contract", "Enter an amount", "The amount must be positive.");
      const balance = wallets.balances.nearTusdc;
      if (balance !== null && balance < amountUnits) throw new RoseActionError("insufficient_balance", "Not enough tUSDC", `Your NEAR wallet holds ${formatUsdc(balance)} tUSDC. Mint more from "Get test funds".`);
      const account = wallets.near.accountId;
      if (!account) throw new RoseActionError("no_wallet", "No NEAR wallet", "Connect a NEAR wallet first.");
      const result = await depositNearCash({ send: wallets.sendNearCall, engine: base.engine, token: NEAR_TUSDC_ACCOUNT, account, amount: amountUnits });
      return { message: `${formatUsdc(amountUnits)} tUSDC credited to your NEAR cash`, links: result.links };
    });

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
      <Card>
        <CardHeader title="Fund the Tender" description="The escrow (budget + 30 bps) is debited from your cash balance in the round's venue when the Tender is created. Fund that venue first." />
        <CardBody className="flex flex-col gap-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <FieldLabel htmlFor="fund-venue">Venue</FieldLabel>
              <select id="fund-venue" value={venueId} onChange={(event) => setVenueId(event.target.value)} className={selectClasses()} data-fund-venue>
                {venues.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1.5">
              <FieldLabel htmlFor="fund-amount">Amount</FieldLabel>
              <NumberInput id="fund-amount" value={amount} onValueChange={setAmount} decimals={decimals ?? 6} unit={option.label.replace(/^(NEAR|Base) /, "")} />
            </div>
          </div>
          {option.venue === "Near" ? (
            <>
              <Hint>
                ft_transfer_call on {NEAR_TUSDC_ACCOUNT} credits the engine&apos;s NEAR cash ledger for your account. Wallet balance: {wallets.balances.nearTusdc === null ? "—" : `${formatUsdc(wallets.balances.nearTusdc)} tUSDC`}; mint more from the testnet banner.
              </Hint>
              {storageNeed ? (
                <Hint tone="warning">
                  <span data-storage-notice={storageNeed.kind}>{storageNotice(storageNeed)}</span>
                </Hint>
              ) : null}
              <div className="flex flex-wrap items-center gap-3">
                <Button onClick={() => void fundNear()} disabled={!wallets.near.accountId || amountUnits === null || amountUnits <= 0n || near.state.status === "loading"} loading={near.state.status === "loading"} loadingLabel="Depositing" data-fund-near>
                  Deposit tUSDC
                </Button>
                {!wallets.near.accountId ? <Hint>Connect a NEAR wallet.</Hint> : null}
              </div>
              <ActionFeedback state={near.state} onRetry={() => void fundNear()} />
            </>
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                  <FieldLabel htmlFor="fund-credit">Credit the cash to (NEAR account)</FieldLabel>
                  <Input id="fund-credit" value={creditInput} onChange={(event) => setCreditInput(event.target.value)} placeholder={wallets.near.accountId ?? "treasury.sputnik-v2.testnet"} data-fund-credit />
                  {creditValid ? <Hint>Empty credits your connected account. A DAO that files the Tender needs the escrow in its own cash.</Hint> : <Hint tone="danger">Not a NEAR account id.</Hint>}
                </div>
                <div className="flex flex-col gap-1.5">
                  <FieldLabel htmlFor="fund-round">Round id label (optional)</FieldLabel>
                  <Input id="fund-round" value={roundId} onChange={(event) => setRoundId(event.target.value.replace(/\D/g, ""))} placeholder="0" />
                  <Hint>A note in the deposit log only; the cash is usable by any round of the account.</Hint>
                </div>
              </div>
              <BaseCashFunding base={base} token={option.venue.Base.token} amount={amountUnits} creditTo={creditValid ? creditTo : ""} roundId={BigInt(roundId || "0")} onDone={() => setBaseRuns((runs) => runs + 1)} />
            </>
          )}
          <p className="text-[12px] text-ink-400">
            Every escrow, bond, fee and payout of a round lives in its venue. <LearnMore topic="fees" />
          </p>
        </CardBody>
      </Card>
      <Card>
        <CardHeader title={creditTo && creditTo !== wallets.near.accountId ? "Engine cash of the credited account" : "Your engine cash"} description={creditTo || "Connect a NEAR wallet"} />
        <CardBody>
          {cash === null ? (
            <p className="text-[13px] text-ink-400">{creditTo && creditValid ? "Reading…" : "Cash balances are per NEAR account."}</p>
          ) : (
            <Preview rows={venues.map((item) => ({ label: item.label, value: `${formatVenueCash(cash.find((entry) => venueLabel(entry.venue, base.symbols) === item.label)?.amount ?? 0n, cashDecimalsOf(item.venue, venueDecimalsMap))} ${item.label.replace(/^(NEAR|Base) /, "")}`, emphasis: item.id === venueId }))} />
          )}
        </CardBody>
      </Card>
    </div>
  );
}
