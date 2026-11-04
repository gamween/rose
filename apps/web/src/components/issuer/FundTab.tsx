"use client";

import { approveToken, decodeCashDeposited, depositCash, erc20Abi, waitForSafeHead, type Cash, type CashDepositedLog } from "@rose/sdk";
import { useCallback, useEffect, useState } from "react";
import { LearnMore } from "@/components/chrome/LearnMore";
import { Button } from "@/components/ui/Button";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { FlowSteps } from "@/components/ui/FlowSteps";
import { Input, NumberInput } from "@/components/ui/Input";
import { useWallets } from "@/components/wallet/WalletProvider";
import { formatUsdc, parseAmount, venueLabel } from "@/lib/amounts";
import { deployedAddress, NEAR_TUSDC_ACCOUNT } from "@/lib/deployment";
import { RoseActionError } from "@/lib/errors";
import { txLinks } from "@/lib/explorer";
import { depositNearCash, storageNotice, useNearCashStorageNeed } from "@/lib/near-cash";
import { useAction, useFlow } from "@/lib/use-action";
import { registerCashLog } from "./base-registration";
import { ActionFeedback, FieldLabel, Hint, Preview, useVenueOptions, type IssuerBase, baseClient } from "./shared";

const USDC = 6;

/** Tab 5: funding the issuer's engine cash in the round's venue (NEAR tUSDC, or Base USDC through RoseVault). */
export function FundTab({ base }: { base: IssuerBase }) {
  const wallets = useWallets();
  const venues = useVenueOptions(base);
  const vault = deployedAddress("roseVault");
  const [venueId, setVenueId] = useState(venues[0]?.id ?? "near");
  const [amount, setAmount] = useState("1000");
  const [roundId, setRoundId] = useState("0");
  const [cash, setCash] = useState<Cash[] | null>(null);
  const near = useAction();
  const flow = useFlow();
  const storageNeed = useNearCashStorageNeed(base.engine, wallets.near.accountId, near.state.status);
  const option = venues.find((item) => item.id === venueId) ?? venues[0]!;
  const amountUnits = parseAmount(amount, USDC);

  const refreshCash = useCallback(async () => {
    if (!wallets.near.accountId) {
      setCash(null);
      return;
    }
    try {
      setCash(await base.engine.views.getCash(wallets.near.accountId));
    } catch {
      setCash(null);
    }
  }, [base.engine, wallets.near.accountId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void refreshCash(), 0);
    return () => window.clearTimeout(timer);
  }, [refreshCash, near.state.status, flow.completed]);

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

  const fundBase = async () => {
    if (option.venue === "Near" || !vault || amountUnits === null || amountUnits <= 0n || !wallets.evm.address) return;
    const token = option.venue.Base.token as `0x${string}`;
    const client = baseClient();
    const nearAccount = wallets.near.accountId ?? "";
    let log: CashDepositedLog | null = null;
    await flow.start([
      {
        id: "approve",
        label: `Approve RoseVault for ${formatUsdc(amountUnits)} ${venueLabel(option.venue, base.symbols).replace(/^Base /, "")}`,
        run: async () => {
          const [balance, allowance] = await Promise.all([client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [wallets.evm.address!] }), client.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [wallets.evm.address!, vault] })]);
          if (balance < amountUnits) throw new RoseActionError("insufficient_balance", "Not enough tokens on Base", `Your Base wallet holds ${formatUsdc(balance)}. Mint tUSDC from "Get test funds".`);
          if (allowance >= amountUnits) return { message: "Allowance already sufficient" };
          const wallet = await wallets.getEvmWalletClient();
          const hash = await approveToken(wallet, token, vault, amountUnits);
          await client.waitForTransactionReceipt({ hash });
          return { message: "Approved", links: txLinks("base", hash) };
        },
      },
      {
        id: "deposit",
        label: `depositCash(${formatUsdc(amountUnits)}, ${nearAccount}, round ${roundId || "0"})`,
        run: async ({ setDetail }) => {
          const wallet = await wallets.getEvmWalletClient();
          const hash = await depositCash(wallet, { vault, token, amount: amountUnits, nearAccount, roundId: BigInt(roundId || "0") });
          setDetail("Waiting for the receipt…");
          const receipt = await client.waitForTransactionReceipt({ hash });
          log = decodeCashDeposited(receipt)[0] ?? null;
          if (!log) throw new RoseActionError("contract", "No CashDeposited log", "RoseVault did not emit CashDeposited.");
          return { message: `CashDeposited in block ${receipt.blockNumber.toString()}`, links: txLinks("base", hash) };
        },
      },
      {
        id: "finality",
        label: "Base finality: ~3 min (safe head plus a 30 s margin)",
        run: async ({ setDetail, signal }) => {
          await waitForSafeHead(client, log!.blockNumber, { signal, onProgress: (progress) => setDetail(progress.phase === "ready" ? "Safe." : progress.phase === "margin" ? "Safe head passed; 30 s margin…" : `Safe head ${progress.safeHead.toString()} / target ${progress.target.toString()}…`) });
          return { message: "Base finality reached" };
        },
      },
      {
        id: "register",
        label: "register_base_cash on the engine (MPC verification, ~7 s)",
        run: async ({ signal, setDetail }) => {
          const result = await registerCashLog(base.engine, wallets.sendNearCall, log!, { signal, onDetail: setDetail });
          if (result.outcome.outcome === "refused") throw new RoseActionError("contract", "Deposit refused", result.outcome.refused.reason);
          return { message: `${formatUsdc(amountUnits)} credited to your Base cash`, links: result.txHash ? txLinks("near", result.txHash) : [] };
        },
      },
    ]);
  };

  const baseDisabled = option.venue === "Near" ? null : !vault ? "RoseVault is not deployed yet." : !wallets.evm.address ? "Connect a Base Sepolia wallet." : !wallets.near.accountId ? "Connect a NEAR wallet (the cash is credited to it)." : amountUnits === null || amountUnits <= 0n ? "Enter an amount." : null;

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
      <Card>
        <CardHeader title="Fund the Tender" description="The escrow (budget + 30 bps) is debited from your cash balance in the round's venue when the Tender is created. Fund that venue first." />
        <CardBody className="flex flex-col gap-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <FieldLabel htmlFor="fund-venue">Venue</FieldLabel>
              <select id="fund-venue" value={venueId} onChange={(event) => setVenueId(event.target.value)} className="h-9 w-full rounded-md border border-ink-700 bg-ink-900 px-3 text-[13px] text-ink-50 focus:border-ember-500 focus:outline-none" data-fund-venue>
                {venues.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1.5">
              <FieldLabel htmlFor="fund-amount">Amount</FieldLabel>
              <NumberInput id="fund-amount" value={amount} onValueChange={setAmount} decimals={USDC} unit="USDC" />
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
              <div className="flex flex-col gap-1.5">
                <FieldLabel htmlFor="fund-round">Round id (0 before the Tender exists)</FieldLabel>
                <Input id="fund-round" value={roundId} onChange={(event) => setRoundId(event.target.value.replace(/\D/g, ""))} />
              </div>
              <Hint>depositCash pulls the tokens into RoseVault and emits CashDeposited; the engine credits your Base cash after a ForeignTx proof at Base safe finality.</Hint>
              <div className="flex flex-wrap items-center gap-3">
                <Button onClick={() => void fundBase()} disabled={baseDisabled !== null || flow.running} loading={flow.running} loadingLabel="Running" title={baseDisabled ?? undefined} data-fund-base>
                  Deposit on Base
                </Button>
                {baseDisabled ? <Hint>{baseDisabled}</Hint> : null}
              </div>
              <FlowSteps steps={flow.steps} onRetry={() => void flow.retry()} running={flow.running} />
            </>
          )}
          <p className="text-[12px] text-ink-400">
            Every escrow, bond, fee and payout of a round lives in its venue. <LearnMore topic="fees" />
          </p>
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Your engine cash" description={wallets.near.accountId ?? "Connect a NEAR wallet"} />
        <CardBody>
          {cash === null ? (
            <p className="text-[13px] text-ink-400">{wallets.near.accountId ? "Reading…" : "Cash balances are per NEAR account."}</p>
          ) : (
            <Preview rows={venues.map((item) => ({ label: item.label, value: `${formatUsdc(cash.find((entry) => venueLabel(entry.venue, base.symbols) === item.label)?.amount ?? 0n)} USDC`, emphasis: item.id === venueId }))} />
          )}
        </CardBody>
      </Card>
    </div>
  );
}
