"use client";

import { useState } from "react";
import { LearnMore } from "@/components/chrome/LearnMore";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardBody } from "@/components/ui/Card";
import { Term } from "@/components/ui/Term";
import { useConnectModal } from "@/components/wallet/ConnectModal";
import { useWallets } from "@/components/wallet/WalletProvider";
import { deployed } from "@/lib/deployment";
import { nearAccountUrl } from "@/lib/explorer";
import { BaseDeposit } from "./BaseDeposit";
import { RefusedDeposits } from "./RefusedDeposits";
import { ChainPicker, type DepositChain } from "./shared";
import { SolanaDeposit } from "./SolanaDeposit";

/** `/app/deposit`: one centered column (swap-card style): from which chain, to which NEAR account, then the eligible streams and the deposit flow with live proof progress (spec 8.3). */
export function DepositWizard() {
  const wallets = useWallets();
  const [chain, setChain] = useState<DepositChain | null>(null);
  const openConnect = useConnectModal();
  const engine = deployed("engineAccount");
  const nearAccount = wallets.near.accountId;
  const notDeployed: Record<DepositChain, string | null> = {
    base: !engine ? "The engine is not deployed yet." : !deployed("roseVault") ? "RoseVault is not deployed yet." : null,
    solana: !engine ? "The engine is not deployed yet." : !deployed("solanaVault") ? "The engine's Solana vault is not derived yet." : null,
  };

  return (
    <div className="mx-auto flex w-full max-w-[680px] flex-col gap-5" data-deposit-wizard>
      <header>
        <h1 className="text-[24px] font-semibold tracking-tight text-ink-50">Deposit a position</h1>
        <p className="mt-1 text-[13px] text-ink-400">
          Put a locked <Term term="position">position</Term> in custody and receive <Term term="unit">units</Term> of its <Term term="class">class</Term>. <LearnMore topic="custody" />
        </p>
      </header>

      <Card>
        <CardBody className="flex flex-col gap-4">
          <section className="flex flex-col gap-2">
            <h2 className="text-[12px] font-medium text-ink-400">From</h2>
            <ChainPicker value={chain} onChange={setChain} deployed={notDeployed} />
          </section>
          <section className="flex flex-col gap-2">
            <h2 className="text-[12px] font-medium text-ink-400">Units go to</h2>
            <div className="flex min-h-11 flex-wrap items-center justify-between gap-2 rounded-md border border-ink-750 bg-(--surface-inset) px-3 py-2 text-[13px]" data-near-recipient>
              {nearAccount ? (
                <span className="flex min-w-0 items-center gap-2">
                  <a href={nearAccountUrl(nearAccount)} target="_blank" rel="noreferrer" className="truncate font-mono text-[12.5px] text-ink-50 underline-offset-2 hover:underline">
                    {nearAccount}
                  </a>
                  {wallets.near.kind === "demo" ? <Badge tone="ember">Demo</Badge> : null}
                </span>
              ) : (
                <>
                  <span className="text-ink-400">Units are minted to a NEAR account.</span>
                  <Button size="sm" variant="secondary" onClick={() => openConnect("near")} data-connect-prompt="near">
                    Connect NEAR
                  </Button>
                </>
              )}
            </div>
          </section>
        </CardBody>
      </Card>

      {chain ? (
        <section className="flex flex-col gap-3" data-chain-section={chain}>
          {notDeployed[chain] ? <p className="rounded-md border border-warning-400/40 bg-warning-400/10 px-4 py-3 text-[13px] text-warning-400">{notDeployed[chain]}</p> : null}
          {chain === "base" ? <BaseDeposit nearAccount={nearAccount} onConnect={openConnect} /> : <SolanaDeposit nearAccount={nearAccount} onConnect={openConnect} />}
        </section>
      ) : (
        <p className="text-center text-[13px] text-ink-400">Choose a chain to list your streams. No stream yet? Base offers a demo position.</p>
      )}

      <RefusedDeposits />
    </div>
  );
}
