"use client";

/**
 * After a DAO's Tender, the unspent budget and any refund sit in the DAO's engine cash in the NEAR
 * venue, with any other cash credited to it. Only the DAO itself can take that cash out
 * (`withdraw_near_cash` pays its caller), so the console builds the call, for the whole balance,
 * as a Sputnik proposal, as it does for the funding and the Tender.
 */

import { outcomeValue } from "@rose/sdk";
import { useCallback, useEffect, useState } from "react";
import { useWallets } from "@/components/wallet/WalletProvider";
import { formatUsdc, sameVenue } from "@/lib/amounts";
import { nearRpc } from "@/lib/engine-client";
import { toActionError } from "@/lib/errors";
import { txLinks } from "@/lib/explorer";
import { useAction } from "@/lib/use-action";
import { sputnikCliCommand, sputnikProposal } from "./dao";
import { ADD_PROPOSAL_GAS, ProposalBlock } from "./DaoPanel";
import { ActionFeedback, Hint, type IssuerBase } from "./shared";

type Read = { status: "loading" } | { status: "error"; message: string } | { status: "ok"; cash: bigint; bond: bigint };

export function DaoWithdrawal({ base, dao }: { base: IssuerBase; dao: string }) {
  const wallets = useWallets();
  const signer = wallets.near.accountId;
  const [read, setRead] = useState<Read>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const file = useAction();

  useEffect(() => {
    let live = true;
    void Promise.all([base.engine.views.getCash(dao), nearRpc().viewFunction<{ proposal_bond: string }>(dao, "get_policy", {})])
      .then(([cash, policy]) => {
        if (live) setRead({ status: "ok", cash: cash.find((entry) => sameVenue(entry.venue, "Near"))?.amount ?? 0n, bond: BigInt(policy.value.proposal_bond) });
      })
      .catch((error: unknown) => {
        if (live) setRead({ status: "error", message: `${toActionError(error).message} Is ${dao} a Sputnik DAO v2 account?` });
      });
    return () => {
      live = false;
    };
  }, [base.engine.views, dao, attempt]);

  const proposal = read.status === "ok" && read.cash > 0n ? sputnikProposal(base.engine.calls.withdrawNearCash(read.cash), `rose: withdraw the DAO's ${formatUsdc(read.cash)} tUSDC of engine cash on NEAR (unspent Tender budget included) to its wallet (withdraw_near_cash)`) : null;

  const fileProposal = useCallback(() => {
    if (read.status !== "ok" || !proposal) return;
    void file.run("Filing the withdrawal proposal", async () => {
      const outcome = await wallets.sendNearCall({ receiverId: dao, methodName: "add_proposal", args: proposal, gas: ADD_PROPOSAL_GAS, deposit: read.bond });
      const id = String(outcomeValue(outcome) ?? "");
      return { message: id ? `Proposal #${id} filed to ${dao}` : `Proposal filed to ${dao}`, links: txLinks("near", outcome.transaction.hash) };
    });
  }, [dao, file, proposal, read, wallets]);

  return (
    <div className="flex flex-col gap-2 rounded-md border border-ink-750 bg-ink-900 px-3 py-2.5" data-dao-withdrawal={dao}>
      <p className="text-[13px] text-ink-50">Engine cash of {dao}</p>
      {read.status === "loading" ? <Hint>Reading the DAO&apos;s engine cash and proposal bond…</Hint> : null}
      {read.status === "error" ? (
        <p className="flex flex-wrap items-center gap-2 text-[12px] text-danger-400" role="alert">
          {read.message}
          <button
            type="button"
            className="text-ember-300 underline-offset-2 hover:underline"
            onClick={() => {
              setRead({ status: "loading" });
              setAttempt((value) => value + 1);
            }}
          >
            Retry
          </button>
        </p>
      ) : null}
      {read.status === "ok" && !proposal ? <Hint>Nothing to withdraw: the DAO holds no engine cash in tUSDC on NEAR.</Hint> : null}
      {read.status === "ok" && proposal ? (
        <>
          <Hint>
            {formatUsdc(read.cash)} tUSDC sits in the DAO&apos;s engine cash on NEAR: what its Tenders did not spend, and any other cash credited to it. Only the DAO can withdraw it: this proposal withdraws the whole balance once members approve it, back to the DAO&apos;s tUSDC wallet.
          </Hint>
          <ProposalBlock
            name="Withdrawal"
            proposal={proposal}
            cli={sputnikCliCommand(dao, proposal, read.bond, signer ?? "<your-account>.testnet")}
            onFile={fileProposal}
            filing={file.state.status === "loading"}
            disabled={signer ? null : "Connect a NEAR wallet: it files the proposal and pays the bond."}
            testId={`withdraw-${dao}`}
          />
          <ActionFeedback state={file.state} onRetry={fileProposal} />
        </>
      ) : null}
    </div>
  );
}
