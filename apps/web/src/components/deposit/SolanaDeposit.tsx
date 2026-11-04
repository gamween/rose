"use client";

import { bytesToHex, buildTransferRecipientTransaction, confirmSignature, readStreamflowStream } from "@rose/sdk";
import { PublicKey } from "@solana/web3.js";
import { useCallback, useMemo, useState } from "react";
import { LearnMore } from "@/components/chrome/LearnMore";
import { Button } from "@/components/ui/Button";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { FlowSteps } from "@/components/ui/FlowSteps";
import { Skeleton } from "@/components/ui/Skeleton";
import { useWallets } from "@/components/wallet/WalletProvider";
import { formatAmount, formatDay, formatDuration, secondsToMs, shortHex } from "@/lib/amounts";
import { deployed } from "@/lib/deployment";
import { requireEngine } from "@/lib/engine-client";
import { RoseActionError, toActionError } from "@/lib/errors";
import { txLinks, type ChainId } from "@/lib/explorer";
import { broadcastSolPayout, waitForPayout } from "@/lib/payouts";
import { ROUTES } from "@/lib/routes";
import { useAction, useFlow } from "@/lib/use-action";
import { useEngineQuery } from "@/lib/use-engine-query";
import { solanaConnection } from "@/lib/wallet/solana-demo";
import { createSolanaDemoPosition } from "@/lib/wallet/solana-stream";
import { recordAttempted } from "./attempted";
import { solStreamReplayKey } from "./eligibility";
import { ClassNote, Reasons, Row, VerdictBadge, WalletPrompt } from "./shared";
import { holdingBalance } from "./base-reads";
import { depositAddressFor, listSolanaStreams, readMetadataHex, stageName, waitForStage, type SolanaStreamRow } from "./solana-reads";

type Context = { address?: string; transferSignature?: string; moveSignature?: string; needFreshMove?: boolean; balanceBefore?: bigint };

const PROOF_HINT = "MPC nodes proving the account at finalized";

function StreamRow({ row, onDeposit, busy, disabledReason }: { row: SolanaStreamRow; onDeposit: () => void; busy: boolean; disabledReason: string | null }) {
  const m = row.metadata;
  const decimals = row.mint?.decimals ?? 0;
  const unit = shortHex(m.mint.toBase58(), 4, 4);
  const start = m.cliff > 0n ? m.cliff : m.startTime;
  return (
    <li className="flex flex-col gap-2 rounded-md border border-ink-750 bg-ink-900 px-3 py-2.5" data-stream={row.metadataPubkey}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2 text-[13px] font-medium text-ink-50">
            <span className="tabular">Streamflow stream {shortHex(row.metadataPubkey, 6, 6)}</span>
            <VerdictBadge verdict={row.verdict} />
          </p>
          <dl className="mt-1 grid min-w-0 gap-x-6 gap-y-0.5 sm:grid-cols-2">
            <Row label="Deposited" value={`${formatAmount(m.netAmountDeposited, decimals)} ${unit}`} />
            <Row label="Withdrawn" value={`${formatAmount(m.amountWithdrawn, decimals)} ${unit}`} />
            <Row label="Unlocks" value={`${formatDay(secondsToMs(start))} → ${formatDay(secondsToMs(m.endTime))}`} />
            <Row label="Period" value={`${formatAmount(m.amountPerPeriod, decimals)} every ${formatDuration(Number(m.period))}`} />
            <Row label="Cliff amount" value={`${formatAmount(m.cliffAmount, decimals)} ${unit}`} />
            <Row label="Mint" value={m.mint.toBase58()} />
          </dl>
          <div className="mt-1 flex flex-col gap-1">
            <Reasons reasons={row.verdict.reasons} />
            <ClassNote classId={row.classId} classExists={row.classExists} />
          </div>
        </div>
        <Button size="sm" onClick={onDeposit} disabled={!row.verdict.eligible || busy || disabledReason !== null} title={disabledReason ?? undefined} data-deposit-stream>
          Deposit
        </Button>
      </div>
    </li>
  );
}

/** Solana devnet side of the wizard: the holder's Streamflow streams and the attribute, move and register flow of spec 7.2. */
export function SolanaDeposit({ nearAccount, onConnect }: { nearAccount: string | null; onConnect: (chain: ChainId) => void }) {
  const wallets = useWallets();
  const owner = wallets.solana.publicKey;
  const vaultSol = deployed("solanaVault");
  const [selected, setSelected] = useState<SolanaStreamRow | null>(null);

  const fetcher = useCallback(
    async (signal: AbortSignal) => {
      const { views } = requireEngine();
      if (!owner) throw new RoseActionError("no_wallet", "No Solana wallet", "Connect a Solana devnet wallet first.");
      return listSolanaStreams(solanaConnection("confirmed"), views, new PublicKey(owner), signal);
    },
    [owner],
  );
  const listing = useEngineQuery(fetcher, { enabled: owner !== null, pollMs: 60_000 });
  const flow = useFlow({ onComplete: () => void listing.refresh() });
  const demo = useAction({ onSuccess: () => void listing.refresh() });

  const disabledReason = useMemo(() => {
    if (!vaultSol) return "The engine's Solana vault is not deployed yet.";
    if (!nearAccount) return "Connect a NEAR wallet: the units are minted to it.";
    if (wallets.near.kind === "demo" && !wallets.near.demoAccountExists) return "Create the NEAR demo account first (Get test funds).";
    return null;
  }, [nearAccount, vaultSol, wallets.near.demoAccountExists, wallets.near.kind]);

  const startDeposit = (row: SolanaStreamRow) => {
    if (!owner || !nearAccount || !row.classId || !row.mint) return;
    setSelected(row);
    const context: Context = {};
    const connection = solanaConnection("confirmed");
    const metadata = new PublicKey(row.metadataPubkey);
    const metadataKey = row.metadataPubkey;
    const classId = row.classId;
    const decimals = row.mint.decimals;
    const latestAnchor = async (): Promise<string> => {
      const signatures = await connection.getSignaturesForAddress(metadata, { limit: 1 }, "finalized");
      const latest = signatures[0];
      if (!latest) throw new RoseActionError("contract", "No finalized transaction", "No finalized transaction touches this stream yet; wait a few seconds and retry.", true);
      return latest.signature;
    };
    void flow.start([
      {
        id: "derive",
        label: "Derive your deposit address",
        run: async (step) => {
          const { views, account } = requireEngine();
          const derived = await depositAddressFor(views, account, nearAccount, classId, step.signal);
          context.address = derived.address;
          return { message: `Deposit address ${shortHex(derived.address, 8, 8)} (path dep/${nearAccount}/${shortHex(classId, 8, 6)}, derived by the MPC on the Ed25519 domain).` };
        },
      },
      {
        id: "transfer",
        label: "Transfer the stream to the deposit address",
        run: async (step) => {
          const address = context.address;
          if (!address) throw new RoseActionError("unknown", "Missing address", "The deposit address is missing; retry the derivation step.");
          const current = await readStreamflowStream(connection, metadata, "confirmed");
          if (current.metadata.recipient.toBase58() !== owner) {
            if (current.metadata.recipient.toBase58() === address) return { message: "The stream already sits at your deposit address." };
            if (vaultSol && current.metadata.recipient.toBase58() === vaultSol) return { message: "The stream already sits in the vault." };
            throw new RoseActionError("contract", "Not the recipient", `The stream's recipient is ${current.metadata.recipient.toBase58()}, not your wallet.`);
          }
          const signer = wallets.getSolanaSigner();
          const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
          const transaction = buildTransferRecipientTransaction({ metadataPubkey: metadata, authority: signer.publicKey, newRecipient: new PublicKey(address), mint: row.metadata.mint, blockhash, lastValidBlockHeight });
          step.setDetail("Confirm transfer_recipient in your wallet (your wallet pays the fee and the new token account's rent)…");
          const signed = await signer.signTransaction(transaction);
          const signature = await connection.sendRawTransaction(signed.serialize());
          step.addLinks(txLinks("solana", signature));
          step.setDetail("Waiting for finality (about 15 s)…");
          await confirmSignature(connection, signature, { strategy: "blockhash", blockhash, lastValidBlockHeight, commitment: "finalized" });
          context.transferSignature = signature;
          return { message: "The stream now sits at your deposit address." };
        },
      },
      {
        id: "attribute",
        label: "Attribute the deposit: MPC proof (~7 s)",
        run: async (step) => {
          const { views, calls } = requireEngine();
          recordAttempted({ key: solStreamReplayKey(metadataKey), chain: "solana", label: `Streamflow stream ${shortHex(metadataKey, 6, 6)}`, nearAccount, attemptedAt: Date.now() });
          context.balanceBefore ??= await holdingBalance(views, nearAccount, classId);
          const existing = await views.raw.getSolDeposit(metadataKey);
          if (existing && stageName(existing.stage) !== "Refused") return { message: `Already attributed to ${existing.account} (stage ${stageName(existing.stage)}).` };
          step.setDetail("Reading the metadata and mint accounts at finalized…");
          const read = await readMetadataHex(connection, metadata);
          const anchor = context.transferSignature ?? (await latestAnchor());
          step.setDetail("Sending attribute_sol_deposit…");
          const outcome = await wallets.sendNearCall(
            calls.attributeSolDeposit({ metadata: metadataKey, class_id: classId, return_to: owner, anchor_tx: anchor, metadata_data: read.hex, mint_data: bytesToHex(row.mint?.data ?? new Uint8Array()) }),
          );
          step.addLinks(txLinks("near", outcome.transaction.hash));
          const deposit = await waitForStage(views, metadataKey, ["Attributed", "MoveSigned", "Registered"], { signal: step.signal, onPoll: (elapsed) => step.setDetail(`${PROOF_HINT} (${String(Math.round(elapsed / 1000))} s)…`) });
          if (stageName(deposit.stage) === "Refused") {
            const refused = await views.raw.getRefusedDeposit(solStreamReplayKey(metadataKey));
            throw new RoseActionError("contract", "Deposit refused by the engine", `${refused?.reason ?? "The stream failed the engine's checks"}. Use "Return my stream" below to get it back.`);
          }
          return { message: "The MPC proved the stream sits at your deposit address; the engine attributed it to you." };
        },
      },
      {
        id: "move",
        label: "Move the stream into the vault (engine-signed, you broadcast)",
        run: async (step) => {
          const { views, calls } = requireEngine();
          let deposit = await views.raw.getSolDeposit(metadataKey);
          if (!deposit) throw new RoseActionError("unknown", "Not attributed", "The deposit record is missing; retry the attribution step.");
          if (stageName(deposit.stage) === "Registered") return { message: "The stream is already registered." };
          const stage = deposit.stage;
          if (typeof stage === "string" || context.needFreshMove) {
            const { blockhash } = await connection.getLatestBlockhash("finalized");
            step.setDetail("Asking the engine to sign transfer_recipient from the deposit address to the vault…");
            const outcome = await wallets.sendNearCall(calls.moveSolDeposit(metadataKey, blockhash));
            step.addLinks(txLinks("near", outcome.transaction.hash));
            context.needFreshMove = false;
            deposit = await waitForStage(views, metadataKey, ["MoveSigned"], { signal: step.signal, onPoll: (elapsed) => step.setDetail(`Waiting for the two MPC signatures (${String(Math.round(elapsed / 1000))} s; usually about 5 s)…`) });
          }
          const moveStage = deposit.stage;
          if (typeof moveStage === "string" || !("MoveSigned" in moveStage)) throw new RoseActionError("unknown", "No move signed", "The engine did not record a signed move; retry.", true);
          const payout = await waitForPayout(views, BigInt(moveStage.MoveSigned.payout_id), { signal: step.signal, onPoll: (elapsed) => step.setDetail(`Waiting for the signatures (${String(Math.round(elapsed / 1000))} s)…`) });
          step.setDetail("Broadcasting the engine-signed transaction (fee paid by gas/sol)…");
          try {
            const signature = await broadcastSolPayout(connection, payout);
            step.addLinks(txLinks("solana", signature));
            step.setDetail("Waiting for finality (about 15 s)…");
            const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
            await confirmSignature(connection, signature, { strategy: "blockhash", blockhash, lastValidBlockHeight, commitment: "finalized" });
            context.moveSignature = signature;
          } catch (error) {
            const described = toActionError(error);
            if (described.kind === "expired_blockhash") context.needFreshMove = true;
            throw error;
          }
          return { message: "The stream now sits in the engine's vault." };
        },
      },
      {
        id: "register",
        label: "Register the position: MPC proof (~7 s)",
        run: async (step) => {
          const { views, calls } = requireEngine();
          const existing = await views.raw.getSolDeposit(metadataKey);
          if (existing && stageName(existing.stage) === "Registered") return { message: "The position is already registered." };
          step.setDetail("Reading the metadata account at finalized…");
          const read = await readMetadataHex(connection, metadata);
          const anchor = context.moveSignature ?? (await latestAnchor());
          const registration = await views.registrationDepositFor(nearAccount, classId);
          step.setDetail(`Sending register_sol_deposit with ${formatAmount(registration, 24, 5)} NEAR of storage…`);
          const outcome = await wallets.sendNearCall(calls.registerSolDeposit(metadataKey, anchor, read.hex, registration));
          step.addLinks(txLinks("near", outcome.transaction.hash));
          const deposit = await waitForStage(views, metadataKey, ["Registered"], { signal: step.signal, onPoll: (elapsed) => step.setDetail(`${PROOF_HINT} (${String(Math.round(elapsed / 1000))} s)…`) });
          if (stageName(deposit.stage) === "Refused") {
            const refused = await views.raw.getRefusedDeposit(solStreamReplayKey(metadataKey));
            throw new RoseActionError("contract", "Deposit refused by the engine", `${refused?.reason ?? "The stream failed the engine's checks"}. Use "Return my stream" below to get it back.`);
          }
          return { message: "The MPC proved the stream in the vault; the engine registered the position." };
        },
      },
      {
        id: "minted",
        label: "Units minted",
        run: async () => {
          const { views } = requireEngine();
          const holding = await views.getHolding(nearAccount, classId);
          const minted = holding.balance - (context.balanceBefore ?? 0n);
          return { message: `${formatAmount(minted, decimals)} units of class ${shortHex(classId, 8, 6)} minted to ${nearAccount}.` };
        },
      },
    ]);
  };

  if (!owner) {
    return (
      <WalletPrompt chain="solana" onConnect={onConnect}>
        Connect the Solana wallet (Phantom, Solflare or the in-app demo wallet) that is the recipient of the Streamflow stream.
      </WalletPrompt>
    );
  }

  const state = listing.state;
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader
          title="Your Streamflow streams"
          description={`Streams whose recipient is ${owner}, read from the Streamflow program.`}
          action={
            <Button size="sm" variant="secondary" onClick={() => void listing.refresh()} loading={listing.refreshing && state.status === "ok"} loadingLabel="Refreshing">
              Refresh
            </Button>
          }
        />
        <CardBody>
          {state.status === "loading" ? (
            <ul className="flex flex-col gap-2" aria-busy>
              {[0, 1].map((i) => (
                <li key={i}>
                  <Skeleton className="h-16 w-full" />
                </li>
              ))}
            </ul>
          ) : state.status === "not_deployed" ? (
            <EmptyState illustration="vault" title="Engine not deployed yet" description={state.detail} />
          ) : state.status === "error" ? (
            <EmptyState illustration="ember" title="Could not read your streams" description={state.message} action={<Button onClick={() => void listing.refresh()}>Retry</Button>} />
          ) : state.value.length === 0 ? (
            <EmptyState
              illustration="vault"
              title="No Streamflow stream for this wallet"
              description="No stream names this wallet as recipient. Create a demo Streamflow position of the demo token (needs demo tokens and about 0.02 SOL), or transfer an existing one to this wallet."
              action={
                <div className="flex flex-col items-center gap-2">
                  <Button
                    onClick={() =>
                      void demo.run("Creating a Streamflow position", async () => {
                        const result = await createSolanaDemoPosition(wallets.getSolanaSigner());
                        return { message: `Streamflow stream ${result.metadataId.slice(0, 8)}… created`, links: txLinks("solana", result.txId) };
                      })
                    }
                    loading={demo.state.status === "loading"}
                    loadingLabel="Creating"
                    data-mint-demo
                  >
                    Create a demo Streamflow position
                  </Button>
                  {demo.state.status === "error" ? (
                    <p className="text-[12px] text-danger-400" role="alert">
                      {demo.state.error.title}: {demo.state.error.message}
                    </p>
                  ) : null}
                </div>
              }
            />
          ) : (
            <ul className="flex flex-col gap-2" data-stream-list>
              {state.value.map((row) => (
                <StreamRow key={row.metadataPubkey} row={row} onDeposit={() => startDeposit(row)} busy={flow.running} disabledReason={disabledReason} />
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      {selected && flow.steps.length > 0 ? (
        <Card data-deposit-flow>
          <CardHeader
            title={`Depositing Streamflow stream ${shortHex(selected.metadataPubkey, 6, 6)}`}
            description={`Three engine steps, each proven to the MPC: attribute at your deposit address, move into the vault (signed by the engine, broadcast by you, fee paid by gas/sol), register. Units are minted to ${nearAccount ?? "your NEAR account"}.`}
            action={
              flow.completed ? (
                <Button size="sm" variant="secondary" onClick={() => (window.location.href = ROUTES.portfolio)}>
                  Open Portfolio
                </Button>
              ) : flow.running ? (
                <Button size="sm" variant="ghost" onClick={flow.cancel}>
                  Stop waiting
                </Button>
              ) : null
            }
          />
          <CardBody>
            <FlowSteps steps={flow.steps} running={flow.running} onRetry={() => void flow.retry()} />
          </CardBody>
        </Card>
      ) : null}
      <p className="text-[12px] text-ink-400">
        The engine refuses streams the sender can still cancel, transfer, pause, top up or re-rate, streams that withdraw automatically, closed streams and Token-2022 mints. Already unlocked tokens stay with the units: the engine withdraws them inside its payouts. <LearnMore topic="custody" />
      </p>
    </div>
  );
}
