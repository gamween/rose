"use client";

import { isAuthorizationUsed, type PayoutView, type RefusedDepositView, type ReplayKey } from "@rose/sdk";
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
import { blockhashActionState, broadcastBlockhashAction, payoutExplorerLink, submitBasePayout, waitForPayout } from "@/lib/payouts";
import { useFlow, type StepContext } from "@/lib/use-action";
import { useEngineQuery } from "@/lib/use-engine-query";
import { basePublicClient } from "@/lib/wallet/evm-demo";
import { solanaConnection } from "@/lib/wallet/solana-demo";
import { forgetAttempted, keyId, loadAttempted, type AttemptedDeposit } from "./attempted";
import type { Address } from "viem";

type RefusedEntry = { attempt: AttemptedDeposit; refused: RefusedDepositView; returned: { href: string } | null };

/**
 * Whether the signed return of a refused deposit already executed on its chain (the engine
 * keeps it `Signed`: RoseVault's bitmap on Base, the transaction's status on Solana), with its
 * explorer link.
 */
async function returnExecuted(refused: RefusedDepositView, vault: Address | null, signal: AbortSignal): Promise<{ href: string } | null> {
  if (!refused.return_payout) return null;
  const payout = await requireEngine().views.getPayout(BigInt(refused.return_payout), { signal });
  if (!payout || payout.status !== "Signed") return null;
  if (payout.chain === "Base") {
    if (!vault || !(await isAuthorizationUsed(basePublicClient(), vault, BigInt(payout.id)))) return null;
    return payoutExplorerLink(payout, vault);
  }
  if ((await blockhashActionState(solanaConnection("confirmed"), payout)) !== "executed") return null;
  return payoutExplorerLink(payout, vault);
}

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
      const refusedOnes = attempted.flatMap((attempt, index) => {
        const refused = records[index];
        return refused ? [{ attempt, refused }] : [];
      });
      return Promise.all(refusedOnes.map(async (entry) => ({ ...entry, returned: await returnExecuted(entry.refused, vault, signal) })));
    },
    [attempted, vault],
  );
  const query = useEngineQuery(fetcher, { pollMs: 30_000 });

  const startReturn = (entry: RefusedEntry) => {
    const id = keyId(entry.attempt.key);
    setActive(id);
    const key: ReplayKey = entry.attempt.key;
    const chain = entry.attempt.chain;
    const connection = solanaConnection("confirmed");
    let payout: PayoutView | null = null;
    /** A signed return still usable: a Base authorization (executable forever) or a Solana one whose blockhash has not expired. */
    const usable = async (existing: PayoutView | null): Promise<boolean> => {
      if (!existing || existing.status !== "Signed") return false;
      return chain === "base" || (await blockhashActionState(connection, existing)) !== "expired";
    };
    const requestReturn = async (step: StepContext): Promise<PayoutView> => {
      const { views, calls } = requireEngine();
      const blockhash = chain === "solana" ? (await connection.getLatestBlockhash("finalized")).blockhash : undefined;
      step.setDetail("Sending return_refused_deposit…");
      const outcome = await wallets.sendNearCall(calls.returnRefusedDeposit(key, blockhash));
      step.addLinks(txLinks("near", outcome.transaction.hash));
      const after = await views.raw.getRefusedDeposit(key);
      const payoutId = after?.return_payout ? BigInt(after.return_payout) : null;
      if (payoutId === null) throw new RoseActionError("contract", "No return recorded", "The engine recorded no return action; retry.", true);
      return waitForPayout(views, payoutId, { signal: step.signal, onPoll: (elapsed) => step.setDetail(`Waiting for the MPC signature (${String(Math.round(elapsed / 1000))} s)…`) });
    };
    void flow.start([
      {
        id: "request",
        label: chain === "base" ? "Ask the engine to sign the Release authorization" : "Ask the engine to sign transfer_recipient back to you",
        run: async (step) => {
          const { views } = requireEngine();
          const before = await views.raw.getRefusedDeposit(key);
          const existing = before?.return_payout ? await views.getPayout(BigInt(before.return_payout)) : null;
          if (existing && (await usable(existing))) {
            payout = existing;
            return { message: `Return already signed (payout #${existing.id}).` };
          }
          payout = await requestReturn(step);
          return { message: `The engine signed the return (payout #${payout.id}).` };
        },
      },
      {
        id: "submit",
        label: chain === "base" ? "Submit executeRelease to RoseVault (you pay the Base gas)" : "Broadcast the engine-signed transaction (fee paid by gas/sol) and wait for finality",
        run: async (step) => {
          if (!payout) throw new RoseActionError("unknown", "No signed return", "The signed return is missing; retry the previous step.");
          if (chain === "base") {
            if (!vault) throw new RoseActionError("not_deployed", "RoseVault not deployed", "RoseVault is not deployed on this build.");
            const client = basePublicClient();
            if (await isAuthorizationUsed(client, vault, BigInt(payout.id))) return { message: "Already executed: the stream NFT is back in your EVM wallet." };
            step.setDetail("Confirm executeRelease in your wallet…");
            const hash = await submitBasePayout(await wallets.getEvmWalletClient(), vault, payout);
            step.addLinks(txLinks("base", hash));
            step.setDetail("Waiting for the Base receipt…");
            const receipt = await client.waitForTransactionReceipt({ hash });
            if (receipt.status !== "success") throw new RoseActionError("contract", "RoseVault reverted", "The release was refused on Base; the authorization stays stored on NEAR. Check the explorer link and retry.", true);
            return { message: "The stream NFT is back in your EVM wallet." };
          }
          if (!(await usable(payout))) {
            step.setDetail("The signed return's blockhash expired before it landed; asking the engine to sign it again…");
            payout = await requestReturn(step);
          }
          const signature = await broadcastBlockhashAction(connection, payout, { signal: step.signal, onProgress: step.setDetail });
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
                      {entry.returned ? <Badge tone="success">Returned</Badge> : <Badge tone="danger">Refused</Badge>}
                    </p>
                    <p className="mt-0.5 text-[12px] text-ink-300">{entry.refused.reason}</p>
                    <p className="mt-0.5 text-[12px] text-ink-400">
                      {describeAsset(entry.refused)} · returns to <span className="tabular">{entry.refused.return_to}</span> · refused {formatDate(Number(BigInt(entry.refused.refused_at) / 1_000_000n))}
                      {entry.returned ? (
                        <>
                          {" · "}
                          <a href={entry.returned.href} target="_blank" rel="noreferrer" className="text-ember-300 underline-offset-2 hover:underline">
                            return executed ↗
                          </a>
                        </>
                      ) : null}
                    </p>
                  </div>
                  {entry.returned ? (
                    <Button size="sm" variant="ghost" onClick={() => setAttempted(forgetAttempted(entry.attempt.key))} data-dismiss-refused>
                      Dismiss
                    </Button>
                  ) : (
                    <Button size="sm" variant="secondary" onClick={() => startReturn(entry)} disabled={flow.running || !mine} title={mine ? undefined : `Attempted for ${entry.refused.near_account}; connect that NEAR account.`} data-return-stream>
                      Return my stream
                    </Button>
                  )}
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
