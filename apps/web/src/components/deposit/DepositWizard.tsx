"use client";

import { useState } from "react";
import { LearnMore } from "@/components/chrome/LearnMore";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ConnectModal } from "@/components/wallet/ConnectModal";
import { useWallets } from "@/components/wallet/WalletProvider";
import { deployed } from "@/lib/deployment";
import { nearAccountUrl, type ChainId } from "@/lib/explorer";
import { BaseDeposit } from "./BaseDeposit";
import { RefusedDeposits } from "./RefusedDeposits";
import { ChainPicker, type DepositChain } from "./shared";
import { SolanaDeposit } from "./SolanaDeposit";

/** `/app/deposit`: chain, wallets, eligible streams, and the deposit flow with live proof progress (spec 8.3). */
export function DepositWizard() {
  const wallets = useWallets();
  const [chain, setChain] = useState<DepositChain | null>(null);
  const [connect, setConnect] = useState<ChainId | null>(null);
  const engine = deployed("engineAccount");
  const nearAccount = wallets.near.accountId;
  const notDeployed: Record<DepositChain, string | null> = {
    base: !engine ? "The engine is not deployed yet." : !deployed("roseVault") ? "RoseVault is not deployed yet." : null,
    solana: !engine ? "The engine is not deployed yet." : !deployed("solanaVault") ? "The engine's Solana vault is not derived yet." : null,
  };

  return (
    <div className="flex flex-col gap-6" data-deposit-wizard>
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-[22px] text-ink-50">Deposit a position</h1>
          <p className="mt-1 max-w-2xl text-[13px] text-ink-400">
            Move a locked position into rose custody once. The stream stays on its chain; the engine proves it through the MPC network and mints units of its class to your NEAR account. <LearnMore topic="custody" />
          </p>
        </div>
        <div className="flex items-center gap-2 text-[12px] text-ink-300" data-near-recipient>
          {nearAccount ? (
            <>
              <span>Units go to</span>
              <a href={nearAccountUrl(nearAccount)} target="_blank" rel="noreferrer" className="tabular text-ink-50 underline-offset-2 hover:underline">
                {nearAccount}
              </a>
              {wallets.near.kind === "demo" ? <Badge tone="ember">Demo</Badge> : null}
            </>
          ) : (
            <>
              <span>Units are minted to a NEAR account.</span>
              <Button size="sm" variant="secondary" onClick={() => setConnect("near")} data-connect-prompt="near">
                Connect NEAR
              </Button>
            </>
          )}
        </div>
      </header>

      <section className="flex flex-col gap-3">
        <h2 className="font-display text-[11px] uppercase tracking-wide text-ink-400">1. Where does the position live?</h2>
        <ChainPicker value={chain} onChange={setChain} deployed={notDeployed} />
      </section>

      {chain ? (
        <section className="flex flex-col gap-3" data-chain-section={chain}>
          <h2 className="font-display text-[11px] uppercase tracking-wide text-ink-400">2. Pick an eligible stream and deposit it</h2>
          {notDeployed[chain] ? (
            <p className="rounded-md border border-warning-400/40 bg-warning-400/10 px-4 py-3 text-[13px] text-warning-400">{notDeployed[chain]} Deposits open as soon as the addresses are configured; everything else on this page already reads live.</p>
          ) : null}
          {chain === "base" ? <BaseDeposit nearAccount={nearAccount} onConnect={setConnect} /> : <SolanaDeposit nearAccount={nearAccount} onConnect={setConnect} />}
        </section>
      ) : (
        <p className="text-[13px] text-ink-400">Choose a chain to list your streams. No stream yet? The Base list offers a demo vesting position of the demo token, minted on chain.</p>
      )}

      <RefusedDeposits />
      <ConnectModal open={connect !== null} onClose={() => setConnect(null)} initialChain={connect ?? "near"} />
    </div>
  );
}
