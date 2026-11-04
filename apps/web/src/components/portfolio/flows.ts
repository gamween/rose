/**
 * The claim, redeem and payout flows of the Portfolio page as `useFlow` step lists (spec 7.3,
 * guide-holder "Claim unlocked tokens" and "Redeem in kind"). Every step is safe to re-run from
 * where it failed: the engine debits before signing and never signs twice for one payout.
 */

import {
  decodeEventLogs,
  outcomeLogs,
  readStream,
  tokenBalance,
  withdrawMax,
  type EngineCalls,
  type EngineViews,
  type FinalExecutionOutcome,
  type FunctionCall,
  type PayoutView,
  type Position,
  type SignerClient,
  type SolDrawArgs,
  type SolNonceProof,
} from "@rose/sdk";
import { PublicKey } from "@solana/web3.js";
import type { Address } from "viem";
import type { SolanaSigner } from "@/components/wallet/WalletProvider";
import { formatAmount } from "@/lib/amounts";
import { deployedAddress } from "@/lib/deployment";
import { RoseActionError } from "@/lib/errors";
import { txLinks } from "@/lib/explorer";
import { broadcastSolPayout, createPayoutNonce, readSolConfirmation, solPayoutSignature, submitBasePayout, waitForPayout } from "@/lib/payouts";
import type { StepDefinition } from "@/lib/use-action";
import { basePublicClient } from "@/lib/wallet/evm-demo";
import { solanaConnection } from "@/lib/wallet/solana-demo";
import { claimSourceArgs, planSolDraws, type ClaimSource } from "./transforms";

export type FlowDeps = {
  account: string;
  views: EngineViews;
  calls: EngineCalls;
  sendNearCall: (call: FunctionCall) => Promise<FinalExecutionOutcome>;
  getEvmWalletClient: () => Promise<SignerClient>;
  getSolanaSigner: () => SolanaSigner;
  vaultSol: string | null;
};

/** The payout id announced by the `payout_requested` event of a NEAR outcome. */
export function payoutIdFromOutcome(outcome: FinalExecutionOutcome): bigint | null {
  for (const decoded of decodeEventLogs(outcomeLogs(outcome))) {
    if (decoded.standard !== "rose" || decoded.event.event !== "payout_requested") continue;
    const data = decoded.event.data as { payout_id?: string };
    if (typeof data.payout_id === "string") return BigInt(data.payout_id);
  }
  return null;
}

/** The payout of a flow and, once broadcast on Solana, the signature that anchors its confirmation. */
type PayoutHolder = { payoutId: bigint | null; signature?: string };

function mpcWait(deps: FlowDeps, holder: PayoutHolder, label = "MPC signature (about 5 s)"): StepDefinition {
  return {
    id: "sign",
    label,
    run: async (context) => {
      const payoutId = holder.payoutId;
      if (payoutId === null) throw new RoseActionError("contract", "No payout", "Request the payout first.");
      const payout = await waitForPayout(deps.views, payoutId, { signal: context.signal, onPoll: (elapsed) => context.setDetail(`Waiting for the MPC callback… ${String(Math.round(elapsed / 1000))} s`) });
      if (payout.status === "AwaitingGasSignature") {
        throw new RoseActionError("mpc_timeout", "Fee payer signature missing", "The vault signature exists but the gas payer's does not. Use \"Re-sign gas\" on the pending payout; nothing was lost.", false);
      }
      return { message: `Payout #${payoutId.toString()} signed by the MPC` };
    },
  };
}

function requestStep(deps: FlowDeps, id: string, label: string, build: () => FunctionCall, holder: PayoutHolder): StepDefinition {
  return {
    id,
    label,
    run: async () => {
      if (holder.payoutId !== null) return { message: `Payout #${holder.payoutId.toString()} already requested` };
      const outcome = await deps.sendNearCall(build());
      const payoutId = payoutIdFromOutcome(outcome);
      if (payoutId === null) throw new RoseActionError("contract", "No payout recorded", "The engine did not announce a payout id in the transaction logs.");
      holder.payoutId = payoutId;
      return { message: `Payout #${payoutId.toString()} requested`, links: txLinks("near", outcome.transaction.hash) };
    },
  };
}

function submitBaseStep(deps: FlowDeps, holder: PayoutHolder, label: string): StepDefinition {
  return {
    id: "submit",
    label,
    run: async (context) => {
      const vault = deployedAddress("roseVault");
      if (!vault) throw new RoseActionError("not_deployed", "RoseVault not deployed", "The RoseVault address is not configured on this deployment.");
      if (holder.payoutId === null) throw new RoseActionError("contract", "No payout", "Request the authorization first.");
      const payout = await deps.views.getPayout(holder.payoutId);
      if (!payout) throw new RoseActionError("contract", "Unknown payout", `Payout #${holder.payoutId.toString()} does not exist.`);
      const wallet = await deps.getEvmWalletClient();
      context.setDetail("Confirm in your EVM wallet; you pay the Base Sepolia gas.");
      const hash = await submitBasePayout(wallet, vault, payout);
      context.addLinks(txLinks("base", hash));
      context.setDetail("Waiting for the Base receipt…");
      const receipt = await basePublicClient().waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new RoseActionError("contract", "RoseVault reverted", "The authorization was refused on Base. It stays stored on NEAR; check the explorer link.", true);
      return { message: "Executed on Base" };
    },
  };
}

function broadcastSolStep(deps: FlowDeps, holder: PayoutHolder, label: string): StepDefinition {
  return {
    id: "broadcast",
    label,
    run: async (context) => {
      if (holder.payoutId === null) throw new RoseActionError("contract", "No payout", "Request the payout first.");
      const payout = await deps.views.getPayout(holder.payoutId);
      if (!payout?.solana?.transaction) throw new RoseActionError("contract", "Not signed", "The stored transaction is incomplete.");
      context.setDetail("Broadcasting the engine-signed transaction (fee paid by gas/sol)…");
      const signature = await broadcastSolPayout(solanaConnection(), payout);
      holder.signature = signature;
      return { message: "Landed on Solana devnet", links: txLinks("solana", signature) };
    },
  };
}

function nonceStep(deps: FlowDeps, holder: { proof: SolNonceProof | null }, recipient: { owner: string; mint: string }): StepDefinition {
  return {
    id: "nonce",
    label: "Create or reuse the payout's durable nonce account (authority = vault) and the recipient's token account",
    run: async (context) => {
      if (holder.proof !== null) return { message: `Nonce account ${holder.proof.account.slice(0, 6)}… ready` };
      if (!deps.vaultSol) throw new RoseActionError("not_deployed", "Solana vault unknown", "The engine has not derived its Solana vault address yet (bootstrap).");
      const signer = deps.getSolanaSigner();
      context.setDetail("Confirm in your Solana wallet (rent about 0.0011 SOL).");
      let owner: PublicKey;
      try {
        owner = new PublicKey(recipient.owner);
      } catch {
        throw new RoseActionError("contract", "Invalid destination", "The Solana destination is not a base58 address.");
      }
      const created = await createPayoutNonce(signer, solanaConnection(), deps.vaultSol, deps.account, { owner, mint: new PublicKey(recipient.mint) }, context.setDetail);
      holder.proof = created.proof;
      return { message: `Nonce account ${created.proof.account.slice(0, 6)}… ready`, links: txLinks("solana", created.signature) };
    },
  };
}

/**
 * Settles a broadcast Solana payout or redeem on the engine: the finalized nonce account and the
 * drawn streams' metadata go to `confirm_sol_payout` / `confirm_sol_redeem`, which proves them
 * with one ForeignTx request and marks the payout `Landed` (or refunds it when it failed).
 */
function confirmSolStep(deps: FlowDeps, holder: PayoutHolder): StepDefinition {
  return {
    id: "confirm",
    label: "Confirm on NEAR that the transaction landed (MPC proof, about 7 s)",
    run: async (context) => {
      if (holder.payoutId === null) throw new RoseActionError("contract", "No payout", "Request the payout first.");
      const payout = await deps.views.getPayout(holder.payoutId);
      // After a reload the anchor is the payout's own transaction, read from its stored bytes.
      holder.signature ??= payout ? (solPayoutSignature(payout) ?? undefined) : undefined;
      if (!holder.signature) throw new RoseActionError("contract", "Nothing broadcast", "Broadcast the transaction first.");
      const nonceAccount = payout?.solana?.nonce_account;
      if (!payout || !nonceAccount) throw new RoseActionError("contract", "Unknown payout", `Payout #${holder.payoutId.toString()} has no durable nonce to confirm.`);
      if (payout.status === "Landed") return { message: `Payout #${payout.id} already confirmed` };
      let call: FunctionCall;
      if ("SolRelease" in payout.kind) {
        if (!payout.position_id) throw new RoseActionError("contract", "No position", "The release names no position.");
        context.setDetail("Reading the nonce account and the stream at finality…");
        const read = await readSolConfirmation(solanaConnection(), nonceAccount, [payout.kind.SolRelease.metadata]);
        call = deps.calls.confirmSolRedeem(BigInt(payout.position_id), holder.signature, read.nonceData, read.streamData[0]!);
      } else {
        const positions = await Promise.all((payout.solana?.draws ?? []).map((draw) => deps.views.getPosition(BigInt(draw.position_id))));
        const streams = positions.map((position) => {
          if (position?.source.kind !== "SolanaStream") throw new RoseActionError("contract", "Unknown stream", "A drawn position is not a Solana stream.");
          return position.source.metadata;
        });
        context.setDetail("Reading the nonce account and the drawn streams at finality…");
        const read = await readSolConfirmation(solanaConnection(), nonceAccount, streams);
        call = deps.calls.confirmSolPayout(BigInt(payout.id), holder.signature, read.nonceData, read.streamData);
      }
      const outcome = await deps.sendNearCall(call);
      context.addLinks(txLinks("near", outcome.transaction.hash));
      const started = Date.now();
      for (;;) {
        const current = await deps.views.getPayout(holder.payoutId, { signal: context.signal });
        if (current?.status === "Landed") return { message: `Payout #${current.id} confirmed as landed` };
        if (current && typeof current.status === "object") throw new RoseActionError("contract", "Payout failed on Solana", `${current.status.Failed.reason}. The claim was refunded.`);
        if (Date.now() - started > 150_000) throw new RoseActionError("mpc_timeout", "Confirmation timed out", "The MPC proof did not come back within 2.5 minutes; retry the confirmation.", true);
        context.setDetail(`MPC proof of the landed transaction… ${String(Math.round((Date.now() - started) / 1000))} s`);
        await new Promise((resolve) => setTimeout(resolve, 3_000));
      }
    },
  };
}

/** NEAR tUSDC cash: one pull transfer. */
export function withdrawNearCashSteps(deps: FlowDeps, amount: bigint): StepDefinition[] {
  return [
    {
      id: "withdraw",
      label: "Transfer tUSDC from the engine to your NEAR account",
      run: async () => {
        const outcome = await deps.sendNearCall(deps.calls.withdrawNearCash(amount));
        const failed = decodeEventLogs(outcomeLogs(outcome)).some((decoded) => decoded.standard === "rose" && decoded.event.event === "cash_withdrawal_failed");
        if (failed) {
          throw new RoseActionError("contract", "tUSDC transfer refused", "The token refused the transfer and the engine re-credited your cash. Register on the tUSDC token first (minting from \"Get test funds\" does it).", true);
        }
        return { message: "tUSDC received", links: txLinks("near", outcome.transaction.hash) };
      },
    },
  ];
}

/** Base cash: engine authorization, MPC signature, then `executeTransfer` from the claimant's wallet. */
export function withdrawBaseCashSteps(deps: FlowDeps, token: string, amount: bigint, to: string): StepDefinition[] {
  const holder: PayoutHolder = { payoutId: null };
  return [
    requestStep(deps, "request", "Request a RoseVault Transfer authorization", () => deps.calls.withdrawBaseCash(token, amount, to), holder),
    mpcWait(deps, holder),
    submitBaseStep(deps, holder, "Submit executeTransfer to RoseVault"),
  ];
}

/**
 * Base tokens: withdraw from the class's Sablier streams into RoseVault when its balance does
 * not cover the claim (anyone may, the claimant pays gas), then the authorization flow.
 */
export function claimBaseTokensSteps(deps: FlowDeps, source: ClaimSource, token: string, decimals: number, positions: readonly Position[], to: string): StepDefinition[] {
  const holder: PayoutHolder = { payoutId: null };
  return [
    {
      id: "withdraw-max",
      label: "Fill RoseVault from the class streams (Sablier withdrawMax)",
      run: async (context) => {
        const vault = deployedAddress("roseVault");
        if (!vault) throw new RoseActionError("not_deployed", "RoseVault not deployed", "The RoseVault address is not configured on this deployment.");
        const client = basePublicClient();
        let balance = await tokenBalance(client, token as Address, vault);
        if (balance >= source.amount) return { message: `RoseVault already holds ${formatAmount(balance, decimals)} (nothing to withdraw)` };
        const streams = positions.filter((position) => position.classId === source.classId && position.source.kind === "BaseStream");
        if (streams.length === 0) throw new RoseActionError("contract", "No stream to withdraw from", "RoseVault holds less than the claim and no held position of this class is known.");
        const wallet = await deps.getEvmWalletClient();
        const links: { href: string; label: string }[] = [];
        for (const position of streams) {
          if (position.source.kind !== "BaseStream") continue;
          const stream = await readStream(client, position.source.streamId, position.source.lockup as Address);
          if (stream.withdrawable === 0n) continue;
          context.setDetail(`withdrawMax(#${position.source.streamId.toString()}): ${formatAmount(stream.withdrawable, decimals)} withdrawable…`);
          const hash = await withdrawMax(wallet, position.source.streamId, vault, { lockup: position.source.lockup as Address });
          links.push(...txLinks("base", hash));
          context.addLinks(txLinks("base", hash));
          await client.waitForTransactionReceipt({ hash });
          balance = await tokenBalance(client, token as Address, vault);
          if (balance >= source.amount) break;
        }
        if (balance < source.amount) {
          throw new RoseActionError("contract", "Vault balance still short", `RoseVault holds ${formatAmount(balance, decimals)} after withdrawing every withdrawable stream; the claim of ${formatAmount(source.amount, decimals)} cannot be covered yet.`);
        }
        return { message: `RoseVault holds ${formatAmount(balance, decimals)}` };
      },
    },
    requestStep(deps, "request", "Request a RoseVault Transfer authorization", () => deps.calls.claimBaseTokens(claimSourceArgs(source), source.amount, to), holder),
    mpcWait(deps, holder),
    submitBaseStep(deps, holder, "Submit executeTransfer to RoseVault"),
  ];
}

/** Solana tokens: nonce and recipient token account, engine-built durable-nonce payout drawing on the class streams, broadcast, confirmation. */
export function claimSolTokensSteps(deps: FlowDeps, source: ClaimSource, mint: string, decimals: number, toOwner: string): StepDefinition[] {
  const nonce = { proof: null as SolNonceProof | null };
  const plan = { draws: null as SolDrawArgs[] | null };
  const holder: PayoutHolder = { payoutId: null };
  return [
    nonceStep(deps, nonce, { owner: toOwner, mint }),
    {
      id: "draws",
      label: "Choose the streams the payout withdraws from",
      run: async () => {
        plan.draws ??= planSolDraws(await deps.views.getSolStreams(source.classId), source.amount, decimals);
        return { message: `${String(plan.draws.length)} stream${plan.draws.length === 1 ? "" : "s"} drawn on` };
      },
    },
    requestStep(
      deps,
      "request",
      "Request the payout (nonce proof, Streamflow withdraws and SPL transfer in one transaction)",
      () => {
        if (!nonce.proof || !plan.draws) throw new RoseActionError("contract", "No nonce", "Create the nonce account first.");
        return deps.calls.claimSolTokens(claimSourceArgs(source), plan.draws, toOwner, nonce.proof);
      },
      holder,
    ),
    mpcWait(deps, holder, "Nonce proof and MPC signatures (about 15 s)"),
    broadcastSolStep(deps, holder, "Broadcast the signed transaction"),
    confirmSolStep(deps, holder),
  ];
}

/** In-kind redeem: burn the allocation, authorize the release, submit or broadcast it. */
export function redeemSteps(deps: FlowDeps, position: Position, to: string, mint: string): StepDefinition[] {
  const holder: PayoutHolder = { payoutId: null };
  if (position.source.kind === "BaseStream") {
    return [
      requestStep(deps, "request", "Burn the allocation and request the Release authorization", () => deps.calls.redeem(position.positionId, to), holder),
      mpcWait(deps, holder),
      submitBaseStep(deps, holder, "Submit executeRelease to RoseVault (the stream NFT goes to your address)"),
    ];
  }
  const nonce = { proof: null as SolNonceProof | null };
  return [
    nonceStep(deps, nonce, { owner: to, mint }),
    requestStep(
      deps,
      "request",
      "Burn the allocation and request the release (withdraw to the vault, then transfer_recipient)",
      () => {
        if (!nonce.proof) throw new RoseActionError("contract", "No nonce", "Create the nonce account first.");
        return deps.calls.redeem(position.positionId, to, nonce.proof);
      },
      holder,
    ),
    mpcWait(deps, holder, "Nonce proof and MPC signatures (about 15 s)"),
    broadcastSolStep(deps, holder, "Broadcast the signed transaction"),
    confirmSolStep(deps, holder),
  ];
}

/** Finishing a payout that was signed earlier: submit on Base or broadcast on Solana. */
export function finishPayoutSteps(deps: FlowDeps, payout: PayoutView): StepDefinition[] {
  const holder: PayoutHolder = { payoutId: BigInt(payout.id) };
  if (payout.chain === "Base") return [submitBaseStep(deps, holder, "Submit the stored authorization to RoseVault")];
  const settles = "SolTransfer" in payout.kind || "SolRelease" in payout.kind;
  return [broadcastSolStep(deps, holder, "Broadcast the stored transaction"), ...(settles ? [confirmSolStep(deps, holder)] : [])];
}

/** Confirms a Solana transfer or release that landed earlier (its nonce advanced) but was never proven on NEAR. */
export function confirmPayoutSteps(deps: FlowDeps, payout: PayoutView): StepDefinition[] {
  return [confirmSolStep(deps, { payoutId: BigInt(payout.id) })];
}

/** `retry_sol_payout` for a Solana action still `Requested` 600 blocks after its request, then broadcast and confirmation. */
export function retrySolPayoutSteps(deps: FlowDeps, payout: PayoutView): StepDefinition[] {
  const payoutId = BigInt(payout.id);
  const holder: PayoutHolder = { payoutId };
  const settles = "SolTransfer" in payout.kind || "SolRelease" in payout.kind;
  return [
    {
      id: "retry",
      label: "Resolve the expired request (refund, failure or new signature)",
      run: async () => {
        const outcome = await deps.sendNearCall(deps.calls.retrySolPayout(payoutId));
        return { message: "Retry sent", links: txLinks("near", outcome.transaction.hash) };
      },
    },
    mpcWait(deps, holder),
    broadcastSolStep(deps, holder, "Broadcast the signed transaction"),
    ...(settles ? [confirmSolStep(deps, holder)] : []),
  ];
}

/** `resign_sol_gas` for a payout whose vault signature exists, then broadcast. */
export function resignGasSteps(deps: FlowDeps, payout: PayoutView): StepDefinition[] {
  const payoutId = BigInt(payout.id);
  const holder: PayoutHolder = { payoutId };
  return [
    {
      id: "resign",
      label: "Re-request the gas payer signature",
      run: async () => {
        const outcome = await deps.sendNearCall(deps.calls.resignSolGas(payoutId));
        return { message: "Re-signature requested", links: txLinks("near", outcome.transaction.hash) };
      },
    },
    mpcWait(deps, holder),
    broadcastSolStep(deps, holder, "Broadcast the signed transaction"),
    ...("SolTransfer" in payout.kind || "SolRelease" in payout.kind ? [confirmSolStep(deps, holder)] : []),
  ];
}

/** `retry_base_signature` for a Base authorization whose first request never answered. */
export function retryBaseSignatureSteps(deps: FlowDeps, payout: PayoutView): StepDefinition[] {
  const payoutId = BigInt(payout.id);
  const holder: PayoutHolder = { payoutId };
  return [
    {
      id: "retry",
      label: "Re-request the vault signature (same digest and id)",
      run: async () => {
        const outcome = await deps.sendNearCall(deps.calls.retryBaseSignature(payoutId));
        return { message: "Signature re-requested", links: txLinks("near", outcome.transaction.hash) };
      },
    },
    mpcWait(deps, holder),
    submitBaseStep(deps, holder, "Submit the authorization to RoseVault"),
  ];
}
