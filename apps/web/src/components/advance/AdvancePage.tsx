"use client";

import { outcomeValue, type Round } from "@rose/sdk";
import Link from "next/link";
import { useCallback, useState } from "react";
import { LearnMore } from "@/components/chrome/LearnMore";
import { classLabel } from "@/lib/token-symbols";
import { FlowDialog, type FlowRequest } from "@/components/portfolio/FlowDialog";
import { lienProgress } from "@/components/portfolio/transforms";
import { orderIdentity, sealOrder } from "@/components/rounds/ibe";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Countdown } from "@/components/ui/Countdown";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Skeleton";
import { Tabs } from "@/components/ui/Tabs";
import { ConnectModal } from "@/components/wallet/ConnectModal";
import { useWallets } from "@/components/wallet/WalletProvider";
import { WalletsStatusRow } from "@/components/wallet/WalletsStatus";
import { formatAmount, formatUsdc, formatDate, nsToMs, venueLabel } from "@/lib/amounts";
import { deployed } from "@/lib/deployment";
import { requireEngine } from "@/lib/engine-client";
import { RoseActionError } from "@/lib/errors";
import { txLinks } from "@/lib/explorer";
import { ROUTES } from "@/lib/routes";
import { useEngineQuery } from "@/lib/use-engine-query";
import { CreateAdvanceForm, type AdvanceSubmission } from "./CreateAdvanceForm";
import { fetchAdvanceData, type AdvanceData } from "./data";

type Tab = "browse" | "create" | "liens";
const TABS: { id: Tab; label: string }[] = [
  { id: "browse", label: "Browse Advances" },
  { id: "create", label: "Create an Advance" },
  { id: "liens", label: "My liens" },
];

function AdvanceCard({ round, data }: { round: Round; data: AdvanceData }) {
  const info = data.classes.get(round.classId);
  const decimals = info?.decimals ?? 18;
  const symbol = info ? classLabel(info, data.symbols) : round.classId.slice(0, 8);
  const closesMs = nsToMs(round.closesAt);
  return (
    <li className="flex flex-col gap-3 rounded-lg border border-ink-750 bg-ink-850 p-4" data-advance-round={round.roundId.toString()}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-display text-[14px] text-ink-50">
            Advance #{round.roundId.toString()} · {symbol}
          </p>
          <p className="text-[12px] text-ink-400">
            by {round.creator} · {venueLabel(round.venue, data.symbols)}
          </p>
        </div>
        <Badge tone={round.status === "Open" ? "success" : "neutral"}>{round.status}</Badge>
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-[12px]">
        <div>
          <dt className="font-display text-[10px] uppercase tracking-wide text-ink-400">Claim K</dt>
          <dd className="tabular text-ink-50">{formatAmount(round.advanceClaim ?? 0n, decimals)} tokens</dd>
        </div>
        <div>
          <dt className="font-display text-[10px] uppercase tracking-wide text-ink-400">On units X</dt>
          <dd className="tabular text-ink-50">{formatAmount(round.advanceUnits ?? 0n, decimals)}</dd>
        </div>
        <div>
          <dt className="font-display text-[10px] uppercase tracking-wide text-ink-400">Price ceiling</dt>
          <dd className="tabular text-ink-50">{formatUsdc(round.maxPrice)} / claimed token</dd>
        </div>
        <div>
          <dt className="font-display text-[10px] uppercase tracking-wide text-ink-400">Min fill</dt>
          <dd className="tabular text-ink-50">{formatAmount(round.advanceMinFill ?? 0n, decimals)}</dd>
        </div>
        <div>
          <dt className="font-display text-[10px] uppercase tracking-wide text-ink-400">{round.status === "Open" ? "Closes in" : "Opens"}</dt>
          <dd className="tabular text-ink-50">{round.status === "Open" ? <Countdown target={closesMs} /> : formatDate(nsToMs(round.opensAt))}</dd>
        </div>
        <div>
          <dt className="font-display text-[10px] uppercase tracking-wide text-ink-400">Sealed bids</dt>
          <dd className="tabular text-ink-50">{round.bidCount}</dd>
        </div>
      </dl>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-ink-400">Delivered by the schedule, no oracle, no liquidation.</span>
        <Link href={`${ROUTES.rounds}/${round.roundId.toString()}`} className="font-display text-[11px] uppercase tracking-wide text-ember-300 underline-offset-2 hover:underline">
          {round.status === "Open" ? "Bid on this Advance →" : "View round →"}
        </Link>
      </div>
    </li>
  );
}

function LiensTab({ data }: { data: AdvanceData }) {
  const held = lienProgress(data.liens.held);
  if (held.length === 0 && data.liens.shares.length === 0) {
    return <EmptyState illustration="ledger" title="No lien yet" description="Liens appear here once an Advance you created or funded settles. Your portfolio shows them with claim buttons." />;
  }
  return (
    <div className="flex flex-col gap-4">
      {held.length > 0 ? (
        <ul className="flex flex-col gap-2" data-liens-held>
          {held.map(({ lien, remaining, percentDelivered }) => {
            const info = data.classes.get(lien.classId);
            return (
              <li key={lien.lienId.toString()} className="rounded-md border border-ink-750 bg-ink-900 px-3 py-2">
                <p className="flex items-center justify-between text-[13px] text-ink-50">
                  <span>
                    As holder · Lien #{lien.lienId.toString()} · {info ? classLabel(info, data.symbols) : lien.classId.slice(0, 8)} ·{" "}
                    <Link href={`${ROUTES.rounds}/${lien.roundId.toString()}`} className="underline-offset-2 hover:underline">
                      Advance #{lien.roundId.toString()}
                    </Link>
                  </span>
                  <Badge tone={lien.released ? "success" : "ember"}>{lien.released ? "Released" : "Delivering"}</Badge>
                </p>
                <div className="mt-2 h-1.5 w-full overflow-hidden rounded-sm bg-ink-800" role="progressbar" aria-valuenow={percentDelivered} aria-valuemin={0} aria-valuemax={100} aria-label="Claim delivered">
                  <div className="h-full bg-ember-500" style={{ width: `${String(percentDelivered)}%` }} />
                </div>
                <p className="mt-1 tabular text-[12px] text-ink-400">
                  {info ? formatAmount(lien.delivered, info.decimals) : lien.delivered.toString()} of {info ? formatAmount(lien.claimTotal, info.decimals) : lien.claimTotal.toString()} delivered · {info ? formatAmount(remaining, info.decimals) : remaining.toString()} remaining
                </p>
              </li>
            );
          })}
        </ul>
      ) : null}
      {data.liens.shares.length > 0 ? (
        <ul className="flex flex-col gap-2" data-lien-shares>
          {data.liens.shares.map((share) => {
            const info = data.classes.get(share.classId);
            return (
              <li key={share.lienId.toString()} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-ink-750 bg-ink-900 px-3 py-2 text-[12px]">
                <span className="text-[13px] text-ink-50">
                  As funder · Lien #{share.lienId.toString()} · {info ? classLabel(info, data.symbols) : share.classId.slice(0, 8)}
                </span>
                <span className="tabular text-ink-400">
                  claim {info ? formatAmount(share.claim, info.decimals) : share.claim.toString()} · received {info ? formatAmount(share.claimed, info.decimals) : share.claimed.toString()} · claimable {info ? formatAmount(share.claimable, info.decimals) : share.claimable.toString()}
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
      <p className="text-[12px] text-ink-400">
        Claim the delivered tokens from your{" "}
        <Link href={ROUTES.portfolio} className="text-ember-300 underline-offset-2 hover:underline">
          portfolio
        </Link>
        .
      </p>
    </div>
  );
}

/** `/app/advance` (spec 8.3 "Advance"): holders create an Advance and seal their reserve; funders browse and bid. */
export function AdvancePage() {
  const wallets = useWallets();
  const account = wallets.near.accountId;
  const engine = deployed("engineAccount");
  const [tab, setTab] = useState<Tab>("browse");
  const [connect, setConnect] = useState(false);
  const [flow, setFlow] = useState<FlowRequest | null>(null);
  const [created, setCreated] = useState<bigint | null>(null);

  const fetcher = useCallback((signal: AbortSignal) => fetchAdvanceData(account, signal), [account]);
  const { state, refresh } = useEngineQuery(fetcher, { enabled: engine !== null });
  const data = state.status === "ok" ? state.value : null;

  const submit = (submission: AdvanceSubmission) => {
    if (!account || !data) return;
    const holder = { roundId: null as bigint | null };
    setCreated(null);
    setFlow({
      title: "Create the Advance",
      summary: `${formatAmount(submission.units, data.classes.get(submission.classId)?.decimals ?? 18)} units encumbered · claim ${formatAmount(submission.claim, data.classes.get(submission.classId)?.decimals ?? 18)} · ceiling ${formatUsdc(submission.maxPrice)} USDC`,
      steps: () => [
        {
          id: "create",
          label: "create_advance: lock the units and open the round",
          run: async () => {
            if (holder.roundId !== null) return { message: `Round #${holder.roundId.toString()} already created` };
            const { calls } = requireEngine();
            const outcome = await wallets.sendNearCall(calls.createAdvance({ classId: submission.classId, venue: submission.venue, units: submission.units, claim: submission.claim, minFill: submission.minFill, maxPrice: submission.maxPrice, window: { closesAt: submission.closesAtNs, keyTimeout: submission.keyTimeoutNs, revealWindow: submission.revealWindowNs } }));
            const value = outcomeValue(outcome);
            if (typeof value !== "string") throw new RoseActionError("contract", "No round id returned", "create_advance did not return the round id.");
            holder.roundId = BigInt(value);
            setCreated(holder.roundId);
            return { message: `Advance #${value} created`, links: txLinks("near", outcome.transaction.hash) };
          },
        },
        {
          id: "seal",
          label: "Seal the reserve in the browser and place the ask (bond taken from your cash)",
          run: async (context) => {
            if (holder.roundId === null) throw new RoseActionError("contract", "No round", "Create the round first.");
            const { account: engineAccount, calls } = requireEngine();
            context.setDetail("Encrypting (quantity K, reserve) to the round identity…");
            const sealed = await sealOrder(orderIdentity(data.config.ckd_public_key, engineAccount, holder.roundId, account, "Sell"), submission.claim, submission.reserve);
            context.setDetail("Placing the sealed ask…");
            const outcome = await wallets.sendNearCall(calls.placeAsk(holder.roundId, sealed.ciphertextHex, submission.claim));
            return { message: "Reserve sealed and placed", links: txLinks("near", outcome.transaction.hash) };
          },
        },
      ],
    });
  };

  return (
    <div className="flex flex-col gap-6" data-advance>
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-[22px] text-ink-50">Advance</h1>
          <p className="mt-1 text-[13px] text-ink-400">
            A holder sells a senior claim on the first K tokens that will unlock from X of their units; funders bid sealed per claimed token. No oracle, no liquidation: the claim is repaid by the schedule. <LearnMore topic="concepts" anchor="advance" />
          </p>
        </div>
        {!account ? (
          <Button size="sm" onClick={() => setConnect(true)}>
            Connect NEAR
          </Button>
        ) : null}
      </header>
      <Tabs items={TABS} value={tab} onChange={setTab} label="Advance sections" />
      {!engine ? (
        <EmptyState illustration="ledger" title="Engine not deployed yet" description="Advances are rounds of the engine. They appear here once NEXT_PUBLIC_ENGINE_ACCOUNT points to a deployed engine." />
      ) : state.status === "loading" ? (
        <div className="flex flex-col gap-3" aria-busy>
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
        </div>
      ) : state.status === "not_deployed" ? (
        <EmptyState illustration="ledger" title="Engine not reachable" description={state.detail} />
      ) : state.status === "error" ? (
        <EmptyState
          illustration="ember"
          title="Could not read the Advances"
          description={state.message}
          action={
            <Button variant="secondary" onClick={() => void refresh()}>
              Retry
            </Button>
          }
        />
      ) : data ? (
        <>
          {tab === "browse" ? (
            data.rounds.length === 0 ? (
              <EmptyState
                illustration="tender"
                title="No open Advance"
                description="Nobody is selling a claim on their first unlocks right now. Holders create one from the next tab; funders bid from the round page."
                action={
                  <Button variant="secondary" onClick={() => setTab("create")}>
                    Create an Advance
                  </Button>
                }
              />
            ) : (
              <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3" data-advance-list>
                {data.rounds.map((round) => (
                  <AdvanceCard key={round.roundId.toString()} round={round} data={data} />
                ))}
              </ul>
            )
          ) : null}
          {tab === "create" ? (
            <Card>
              <CardHeader title="Create an Advance" description={account ? `Holder: ${account}. Your units stay yours; only their first unlocks are sold.` : "Connect a NEAR wallet holding free units."} />
              <CardBody>
                {account ? (
                  <>
                    {created !== null ? (
                      <p className="mb-4 rounded-md border border-success-500/40 bg-success-500/10 px-3 py-2 text-[13px] text-success-400" data-advance-created>
                        Advance #{created.toString()} is live.{" "}
                        <Link href={`${ROUTES.rounds}/${created.toString()}`} className="underline-offset-2 hover:underline">
                          Open the round page →
                        </Link>
                      </p>
                    ) : null}
                    <CreateAdvanceForm data={data} account={account} busy={flow !== null} onSubmit={submit} onCashDeposited={() => void refresh()} />
                  </>
                ) : wallets.restoring || wallets.walletsStatus === "failed" ? (
                  <WalletsStatusRow what="Restoring your wallet…" />
                ) : (
                  <EmptyState
                    illustration="vault"
                    title="Connect a NEAR wallet"
                    description="The Advance encumbers units of your NEAR account."
                    action={
                      <Button onClick={() => setConnect(true)} data-advance-connect>
                        Connect NEAR
                      </Button>
                    }
                  />
                )}
              </CardBody>
            </Card>
          ) : null}
          {tab === "liens" ? (
            account ? (
              <LiensTab data={data} />
            ) : wallets.restoring || wallets.walletsStatus === "failed" ? (
              <WalletsStatusRow what="Restoring your wallet…" />
            ) : (
              <EmptyState illustration="vault" title="Connect a NEAR wallet" description="Liens are attached to your NEAR account." action={<Button onClick={() => setConnect(true)}>Connect NEAR</Button>} />
            )
          ) : null}
        </>
      ) : null}
      <ConnectModal open={connect} onClose={() => setConnect(false)} initialChain="near" />
      <FlowDialog request={flow} onClose={() => setFlow(null)} onDone={() => void refresh()} />
    </div>
  );
}
