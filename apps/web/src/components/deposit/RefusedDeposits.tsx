"use client";

import type { PayoutView, RefusedDepositView, ReplayKey } from "@rose/sdk";
import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { FlowSteps } from "@/components/ui/FlowSteps";
import { useWallets } from "@/components/wallet/WalletProvider";
import { formatDate } from "@/lib/amounts";
import { deployedAddress } from "@/lib/deployment";
import { requireEngine } from "@/lib/engine-client";
import { RoseActionError } from "@/lib/errors";
import { txLinks } from "@/lib/explorer";
import { broadcastSolPayout, submitBasePayout, waitForPayout } from "@/lib/payouts";
import { useFlow } from "@/lib/use-action";
import { useEngineQuery } from "@/lib/use-engine-query";
import { solanaConnection } from "@/lib/wallet/solana-demo";
import { forgetAttempted, keyId, loadAttempted, type AttemptedDeposit } from "./attempted";

type RefusedEntry = { attempt: AttemptedDeposit; refused: RefusedDepositView };

function describeAsset(refused: RefusedDepositView): string {
  if ("BaseStream" in refused.asset) return `Sablier stream #${String(refused.asset.BaseStream.stream_id)}, held by RoseVault`;
  const asset = refused.asset.SolStream;
  return `Streamflow stream ${asset.metadata.slice(0, 6)}…${asset.metadata.slice(-6)}, held at ${asset.held_by_path}`;
}

/**
 * Deposits this browser attempted that the engine refused (`get_refused_deposit` per attempted
 * key): the reason and "Return my stream", which asks the engine to sign the return and submits
 * or broadcasts it from here.
 */
export function RefusedDeposits() {
  const wallets = useWallets();
  const [attempted, setAttempted] = useState<AttemptedDeposit[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const flow = useFlow();
  const vault = deployedAddress("roseVault");

  useEffect(() => {
    const timer = window.setTimeout(() => setAttempted(loadAttempted()), 0);
    return () => window.clearTimeout(timer);
  }, []);

  const fetcher = useCallback(
    async (signal: AbortSignal): Promise<RefusedEntry[]> => {
      if (attempted.length === 0) return [];
      const { views } = requireEngine();
      const records = await Promise.all(attempted.map((attempt) => views.raw.getRefusedDeposit(attempt.key, { signal })));
      return attempted.flatMap((attempt, index) => {
        const refused = records[index];
        return refused ? [{ attempt, refused }] : [];
      });
    },
    [attempted],
  );
  const query = useEngineQuery(fetcher, { pollMs: 30_000 });

  const startReturn = (entry: RefusedEntry) => {
    const id = keyId(entry.attempt.key);
    setActive(id);
    const key: ReplayKey = entry.attempt.key;
    const chain = entry.attempt.chain;
    let payout: PayoutView | null = null;
    void flow.start([
      {
        id: "request",
        label: chain === "base" ? "Ask the engine to sign the Release authorization" : "Ask the engine to sign transfer_recipient back to you",
        run: async (step) => {
          const { views, calls } = requireEngine();
          const before = await views.raw.getRefusedDeposit(key);
          let payoutId = before?.return_payout ? BigInt(before.return_payout) : null;
          if (payoutId !== null) {
            const existing = await views.getPayout(payoutId);
            if (existing && existing.status === "Signed") {
              payout = existing;
              return { message: `Return already signed (payout #${payoutId.toString()}).` };
            }
          }
          const blockhash = chain === "solana" ? (await solanaConnection("confirmed").getLatestBlockhash("finalized")).blockhash : undefined;
          step.setDetail("Sending return_refused_deposit…");
          const outcome = await wallets.sendNearCall(calls.returnRefusedDeposit(key, blockhash));
          step.addLinks(txLinks("near", outcome.transaction.hash));
          const after = await views.raw.getRefusedDeposit(key);
          payoutId = after?.return_payout ? BigInt(after.return_payout) : null;
          if (payoutId === null) throw new RoseActionError("contract", "No return recorded", "The engine recorded no return action; retry.", true);
          payout = await waitForPayout(views, payoutId, { signal: step.signal, onPoll: (elapsed) => step.setDetail(`Waiting for the MPC signature (${String(Math.round(elapsed / 1000))} s)…`) });
          return { message: `The engine signed the return (payout #${payoutId.toString()}).` };
        },
      },
      {
        id: "submit",
        label: chain === "base" ? "Submit executeRelease to RoseVault (you pay the Base gas)" : "Broadcast the engine-signed transaction (fee paid by gas/sol)",
        run: async (step) => {
          if (!payout) throw new RoseActionError("unknown", "No signed return", "The signed return is missing; retry the previous step.");
          if (chain === "base") {
            if (!vault) throw new RoseActionError("not_deployed", "RoseVault not deployed", "RoseVault is not deployed on this build.");
            step.setDetail("Confirm executeRelease in your wallet…");
            const hash = await submitBasePayout(await wallets.getEvmWalletClient(), vault, payout);
            return { message: "The stream NFT is back in your EVM wallet.", links: txLinks("base", hash) };
          }
          const signature = await broadcastSolPayout(solanaConnection("confirmed"), payout);
          return { message: "The stream's recipient is your Solana wallet again.", links: txLinks("solana", signature) };
        },
      },
      {
        id: "forget",
        label: "Done",
        run: () => {
          setAttempted(forgetAttempted(key));
          return Promise.resolve({ message: "Returned. The record is removed from this browser." });
        },
      },
    ]);
  };

  const entries = query.state.status === "ok" ? query.state.value : [];
  if (attempted.length === 0 || (query.state.status === "ok" && entries.length === 0)) return null;

  return (
    <Card data-refused-deposits>
      <CardHeader title="Refused deposits" description="Deposits this browser attempted that the engine refused at registration. The asset is held in custody until you ask for it back." />
      <CardBody className="flex flex-col gap-3">
        {query.state.status === "error" ? <p className="text-[12px] text-danger-400">{query.state.message}</p> : null}
        <ul className="flex flex-col gap-2">
          {entries.map((entry) => {
            const id = keyId(entry.attempt.key);
            const mine = wallets.near.accountId === entry.refused.near_account;
            return (
              <li key={id} className="flex flex-col gap-2 rounded-md border border-ink-750 bg-ink-900 px-3 py-2.5" data-refused={id}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 text-[13px] font-medium text-ink-50">
                      {entry.attempt.label}
                      <Badge tone="danger">Refused</Badge>
                    </p>
                    <p className="mt-0.5 text-[12px] text-ink-300">{entry.refused.reason}</p>
                    <p className="mt-0.5 text-[12px] text-ink-400">
                      {describeAsset(entry.refused)} · returns to <span className="tabular">{entry.refused.return_to}</span> · refused {formatDate(Number(BigInt(entry.refused.refused_at) / 1_000_000n))}
                    </p>
                  </div>
                  <Button size="sm" variant="secondary" onClick={() => startReturn(entry)} disabled={flow.running || !mine} title={mine ? undefined : `Attempted for ${entry.refused.near_account}; connect that NEAR account.`} data-return-stream>
                    Return my stream
                  </Button>
                </div>
                {active === id && flow.steps.length > 0 ? <FlowSteps steps={flow.steps} running={flow.running} onRetry={() => void flow.retry()} /> : null}
              </li>
            );
          })}
        </ul>
      </CardBody>
    </Card>
  );
}
