/**
 * The claim, redeem and payout flows of the Portfolio page as `useFlow` step lists (spec 7.3,
 * guide-holder "Claim unlocked tokens" and "Redeem in kind"). Every step is safe to re-run from
 * where it failed: the engine debits before signing and never signs twice for one payout.
 */

import {
  bytesToHex,
  calculateMinFeeWei,
  decodeEventLogs,
  isAuthorizationUsed,
  outcomeLogs,
  readStream,
  readStreamflowStream,
  tokenBalance,
  withdrawMax,
  type EngineCalls,
  type EngineViews,
  type FinalExecutionOutcome,
  type FunctionCall,
  type PayoutView,
  type Position,
  type SignerClient,
  type SolNonceProof,
  type SolStreamStateView,
} from "@rose/sdk";
import { PublicKey, type Connection } from "@solana/web3.js";
import type { Address, PublicClient } from "viem";
import type { SolanaSigner } from "@/components/wallet/WalletProvider";
import { formatAmount } from "@/lib/amounts";
import { deployedAddress } from "@/lib/deployment";
import { RoseActionError } from "@/lib/errors";
import { txLinks } from "@/lib/explorer";
import {
  broadcastBlockhashAction,
  broadcastDurableNonceTransaction,
  confirmationAnchor,
  createPayoutNonce,
  payoutIdFromOutcome,
  isBlockhashAction,
  latestSuccessfulSignature,
  PayoutRefusedError,
  readSolConfirmation,
  secondProofBlock,
  sleep,
  submitBasePayout,
  waitForFinalizedNonce,
  waitForPayout,
} from "@/lib/payouts";
import type { StepContext, StepDefinition } from "@/lib/use-action";
import { claimSourceArgs, planSolClaim, type ClaimSource, type SolClaimPlan } from "./transforms";

export type FlowDeps = {
  account: string;
  views: EngineViews;
  calls: EngineCalls;
  sendNearCall: (call: FunctionCall) => Promise<FinalExecutionOutcome>;
  getEvmWalletClient: () => Promise<SignerClient>;
  getSolanaSigner: () => SolanaSigner;
  vaultSol: string | null;
  base: PublicClient;
  solana: Connection;
  /** Height of the latest final NEAR block (the clock of the engine's 150-block confirmation delay). */
  finalBlockHeight: (signal?: AbortSignal) => Promise<bigint>;
};

/**
 * The payout of a flow. `refunded` is set when the engine failed it before signing (the debit
 * came back): the next run of the signature step requests a new payout through `redo`, after
 * `reset` cleared what the old request was built from.
 */
type PayoutHolder = { payoutId: bigint | null; refunded?: boolean; reset?: () => void };

function mpcWait(deps: FlowDeps, holder: PayoutHolder, label = "MPC signature (about 5 s)", redo: StepDefinition[] = []): StepDefinition {
  return {
    id: "sign",
    label,
    run: async (context) => {
      if (holder.payoutId === null && holder.refunded && redo.length > 0) {
        context.setDetail("The previous request was refunded; requesting a new payout…");
        for (const step of redo) await step.run(context);
        holder.refunded = false;
      }
      const payoutId = holder.payoutId;
      if (payoutId === null) throw new RoseActionError("contract", "No payout", "Request the payout first.");
      let payout: PayoutView;
      try {
        payout = await waitForPayout(deps.views, payoutId, { signal: context.signal, onPoll: (elapsed) => context.setDetail(`Waiting for the MPC callback… ${String(Math.round(elapsed / 1000))} s`) });
      } catch (error) {
        if (error instanceof PayoutRefusedError && redo.length > 0) {
          holder.payoutId = null;
          holder.refunded = true;
          holder.reset?.();
        }
        throw error;
      }
      if (payout.status === "AwaitingGasSignature") {
        throw new RoseActionError("mpc_timeout", "Fee payer signature missing", "The vault signature exists but the gas payer's does not. Use \"Re-sign gas\" on the pending payout; nothing was lost.", false);
      }
      return { message: `Payout #${payoutId.toString()} signed by the MPC` };
    },
  };
}

/**
 * The payout as the next step needs it, signed: the views come from several RPC nodes, and one
 * that lags behind the node that answered the signature wait can still show it `Requested`
 * (seen live: a broadcast read the payout without its transaction right after "signed by the
 * MPC"), so this polls until the view catches up instead of failing.
 */
async function signedPayout(deps: FlowDeps, payoutId: bigint, context: StepContext): Promise<PayoutView> {
  try {
    return await waitForPayout(deps.views, payoutId, { signal: context.signal, onPoll: (elapsed) => context.setDetail(`Waiting for the RPC to show the signed payout… ${String(Math.round(elapsed / 1000))} s`) });
  } catch (error) {
    // Refunded meanwhile (a confirmation from elsewhere found it did not execute): there is nothing left to submit.
    const payout = error instanceof PayoutRefusedError ? await deps.views.getPayout(payoutId, { signal: context.signal }) : null;
    if (payout && typeof payout.status === "object") throw refundedVerdict(payout);
    throw error;
  }
}

function requestStep(deps: FlowDeps, id: string, label: string, build: (context: StepContext) => FunctionCall | Promise<FunctionCall>, holder: PayoutHolder): StepDefinition {
  return {
    id,
    label,
    run: async (context) => {
      if (holder.payoutId !== null) return { message: `Payout #${holder.payoutId.toString()} already requested` };
      const outcome = await deps.sendNearCall(await build(context));
      context.addLinks(txLinks("near", outcome.transaction.hash));
      const payoutId = payoutIdFromOutcome(outcome);
      if (payoutId === null) throw new RoseActionError("contract", "No payout recorded", "The engine did not announce a payout id in the transaction logs.");
      holder.payoutId = payoutId;
      return { message: `Payout #${payoutId.toString()} requested` };
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
      if (await isAuthorizationUsed(deps.base, vault, holder.payoutId)) return { message: `Authorization #${holder.payoutId.toString()} already executed on Base` };
      const payout = await signedPayout(deps, holder.payoutId, context);
      const wallet = await deps.getEvmWalletClient();
      context.setDetail("Confirm in your EVM wallet; you pay the Base Sepolia gas.");
      const hash = await submitBasePayout(wallet, vault, payout);
      context.addLinks(txLinks("base", hash));
      context.setDetail("Waiting for the Base receipt…");
      const receipt = await deps.base.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new RoseActionError("contract", "RoseVault reverted", "The authorization was refused on Base. It stays stored on NEAR; check the explorer link.", true);
      return { message: "Executed on Base" };
    },
  };
}

/** Broadcasts a stored Solana action: durable-nonce ones until the nonce advance is final, blockhash ones until finalized. */
function broadcastSolStep(deps: FlowDeps, holder: PayoutHolder, label: string): StepDefinition {
  return {
    id: "broadcast",
    label,
    run: async (context) => {
      if (holder.payoutId === null) throw new RoseActionError("contract", "No payout", "Request the payout first.");
      const payout = await signedPayout(deps, holder.payoutId, context);
      if (!payout.solana?.transaction) throw new RoseActionError("contract", "Not signed", "The stored transaction is incomplete.");
      if (payout.status === "Landed") return { message: `Payout #${payout.id} already confirmed` };
      if (isBlockhashAction(payout)) {
        const signature = await broadcastBlockhashAction(deps.solana, payout, { signal: context.signal, onProgress: context.setDetail });
        return { message: "Executed on Solana devnet", links: txLinks("solana", signature) };
      }
      context.setDetail("Broadcasting the engine-signed transaction (fee paid by gas/sol)…");
      const result = await broadcastDurableNonceTransaction(deps.solana, payout, { signal: context.signal, onProgress: context.setDetail });
      context.addLinks(txLinks("solana", result.signature));
      return {
        message: result.failedOnChain
          ? "Landed and finalized, but failed on chain: the confirmation proves it did not execute and refunds it"
          : "Landed and finalized on Solana devnet; the nonce advanced",
      };
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
      const created = await createPayoutNonce(signer, deps.solana, deps.vaultSol, deps.account, { owner, mint: new PublicKey(recipient.mint) }, context.setDetail);
      holder.proof = created.proof;
      return { message: `Nonce account ${created.proof.account.slice(0, 6)}… ready`, links: txLinks("solana", created.signature) };
    },
  };
}

const CONFIRM_POLL_MS = 3_000;
/** The confirmation's MPC callback has run when `sendNearCall` returns; this covers view lag only. */
const CONFIRM_SETTLE_MS = 30_000;
/** About 0.6 s per NEAR testnet block (spec 7.1: 200 blocks take about 2 min). */
const NEAR_BLOCK_MS = 600;

function refundedVerdict(payout: PayoutView): RoseActionError {
  const reason = typeof payout.status === "object" ? payout.status.Failed.reason : "the transaction did not execute";
  return new RoseActionError(
    "contract",
    "Did not execute on Solana",
    "SolRelease" in payout.kind
      ? `${reason}. The engine proved it twice: your units and the claimable tokens you paid are back, and the position is held again.`
      : `${reason}. The engine proved it twice and refunded the claim to your claimable balance; claim again.`,
  );
}

/** Waits for the NEAR block from which the engine accepts the second "did not execute" proof, with a countdown. */
async function waitForBlock(deps: FlowDeps, target: bigint, context: StepContext, firstSeen: bigint): Promise<void> {
  for (;;) {
    const height = await deps.finalBlockHeight(context.signal);
    if (height >= target) return;
    const left = target - height;
    context.setDetail(
      `The first proof read the transaction as not executed (block ${firstSeen.toString()}). A lagging read must not refund a payout that landed, so the engine settles only on a second proof requested at least 150 blocks later: ${left.toString()} block${left === 1n ? "" : "s"} left (about ${String(Math.ceil((Number(left) * NEAR_BLOCK_MS) / 1000))} s).`,
    );
    await sleep(CONFIRM_POLL_MS, context.signal);
  }
}

/**
 * Settles a broadcast Solana payout or redeem on the engine (`confirm_sol_payout`,
 * `confirm_sol_redeem`): it first waits until the nonce advance is final (the engine panics
 * otherwise), anchors the proof on a successful finalized transaction, and drives the second
 * proof a "did not execute" verdict needs, 150 blocks after the first one's answer.
 */
function confirmSolStep(deps: FlowDeps, holder: PayoutHolder): StepDefinition {
  return {
    id: "confirm",
    label: "Confirm on NEAR that the transaction landed (MPC proof, about 7 s)",
    run: async (context) => {
      const payoutId = holder.payoutId;
      if (payoutId === null) throw new RoseActionError("contract", "No payout", "Request the payout first.");
      for (;;) {
        const payout = await deps.views.getPayout(payoutId, { signal: context.signal });
        if (!payout) throw new RoseActionError("contract", "Unknown payout", `Payout #${payoutId.toString()} does not exist.`);
        if (payout.status === "Landed") return { message: `Payout #${payout.id} confirmed as landed` };
        if (typeof payout.status === "object") throw refundedVerdict(payout);
        const nonceAccount = payout.solana?.nonce_account;
        const nonceValue = payout.solana?.nonce_value;
        if (!nonceAccount || !nonceValue) throw new RoseActionError("contract", "Unknown payout", `Payout #${payout.id} has no durable nonce to confirm.`);
        await waitForFinalizedNonce(deps.solana, nonceAccount, nonceValue, { signal: context.signal, onProgress: context.setDetail });
        const second = secondProofBlock(payout);
        if (second !== null) await waitForBlock(deps, second, context, BigInt(payout.solana!.not_executed_seen_at!));
        const receiptAccount = payout.solana?.receipt_account;
        if (!receiptAccount) throw new RoseActionError("contract", "Unknown payout", `Payout #${payout.id} has no receipt account to confirm.`);
        context.setDetail("Reading the nonce and receipt accounts at finality…");
        const anchor = await confirmationAnchor(deps.solana, payout);
        const read = await readSolConfirmation(deps.solana, nonceAccount, receiptAccount);
        let call: FunctionCall;
        if ("SolRelease" in payout.kind) {
          if (!payout.position_id) throw new RoseActionError("contract", "No position", "The release names no position.");
          call = deps.calls.confirmSolRedeem(BigInt(payout.position_id), anchor, read.nonceData, read.receiptData);
        } else {
          call = deps.calls.confirmSolPayout(BigInt(payout.id), anchor, read.nonceData, read.receiptData);
        }
        context.setDetail(second === null ? "Sending the confirmation (MPC proof of the nonce and the receipt)…" : "Sending the second proof…");
        const outcome = await deps.sendNearCall(call);
        context.addLinks(txLinks("near", outcome.transaction.hash));
        const verdict = await awaitVerdict(deps, payoutId, second === null, context);
        if (verdict.status === "Landed") return { message: `Payout #${verdict.id} confirmed as landed` };
      }
    },
  };
}

/**
 * What the engine recorded after a confirmation: `Landed` (returned), `Failed` (thrown: the
 * second proof found it did not execute and refunded it), or, after a first proof, the payout
 * still `Signed` with its first "did not execute" reading recorded, so the caller sends the
 * second proof. Anything else means the proof did not match the accounts.
 */
async function awaitVerdict(deps: FlowDeps, payoutId: bigint, firstProof: boolean, context: StepContext): Promise<PayoutView> {
  const started = Date.now();
  for (;;) {
    const current = await deps.views.getPayout(payoutId, { signal: context.signal });
    if (current?.status === "Landed") return current;
    if (current && typeof current.status === "object") throw refundedVerdict(current);
    if (current && firstProof && secondProofBlock(current) !== null) return current;
    if (Date.now() - started > CONFIRM_SETTLE_MS) {
      throw new RoseActionError("mpc_timeout", "Proof not accepted", "The MPC proof did not settle the payout: an account changed between the read and the proof, or the MPC failed. Retry reads the accounts again.", true);
    }
    context.setDetail(`Waiting for the MPC proof of the transaction… ${String(Math.round((Date.now() - started) / 1000))} s`);
    await sleep(CONFIRM_POLL_MS, context.signal);
  }
}

/** NEAR tUSDC cash: one pull transfer. */
export function withdrawNearCashSteps(deps: FlowDeps, amount: bigint): StepDefinition[] {
  return [
    {
      id: "withdraw",
      label: "Transfer tUSDC from the engine to your NEAR account",
      run: async (context) => {
        const outcome = await deps.sendNearCall(deps.calls.withdrawNearCash(amount));
        context.addLinks(txLinks("near", outcome.transaction.hash));
        const failed = decodeEventLogs(outcomeLogs(outcome)).some((decoded) => decoded.standard === "rose" && decoded.event.event === "cash_withdrawal_failed");
        if (failed) {
          throw new RoseActionError("contract", "tUSDC transfer refused", "The token refused the transfer and the engine re-credited your cash. Register on the tUSDC token first (minting from \"Get test funds\" does it).", true);
        }
        return { message: "tUSDC received" };
      },
    },
  ];
}

/** Base cash: engine authorization, MPC signature, then `executeTransfer` from the claimant's wallet. */
export function withdrawBaseCashSteps(deps: FlowDeps, token: string, amount: bigint, to: string): StepDefinition[] {
  const holder: PayoutHolder = { payoutId: null };
  const request = requestStep(deps, "request", "Request a RoseVault Transfer authorization", () => deps.calls.withdrawBaseCash(token, amount, to), holder);
  return [request, mpcWait(deps, holder, undefined, [request]), submitBaseStep(deps, holder, "Submit executeTransfer to RoseVault")];
}

const POSITIONS_PAGE = 50;

/**
 * Every held Base position of a class, paged from `get_positions`: the streams `withdrawMax` may
 * fill RoseVault from. They belong to whoever deposited them; the claimant (an Advance funder,
 * a Tender issuer) needs to hold none.
 */
export async function classBaseStreams(views: EngineViews, classId: string, signal?: AbortSignal): Promise<Position[]> {
  const streams: Position[] = [];
  for (let from = 0n; ; from += BigInt(POSITIONS_PAGE)) {
    const page = await views.getPositions(from, POSITIONS_PAGE, { signal });
    for (const position of page) if (position.classId === classId && position.state === "Held" && position.source.kind === "BaseStream") streams.push(position);
    if (page.length < POSITIONS_PAGE) return streams;
  }
}

/**
 * Base tokens: withdraw from the class's Sablier streams into RoseVault when its balance does
 * not cover the claim (`withdrawMax` to the recipient is permissionless; the claimant pays the
 * gas and Sablier's `calculateMinFeeWei`), then the authorization flow.
 */
export function claimBaseTokensSteps(deps: FlowDeps, source: ClaimSource, token: string, decimals: number, to: string): StepDefinition[] {
  const holder: PayoutHolder = { payoutId: null };
  const request = requestStep(deps, "request", "Request a RoseVault Transfer authorization", () => deps.calls.claimBaseTokens(claimSourceArgs(source), source.amount, to), holder);
  return [
    {
      id: "withdraw-max",
      label: "Fill RoseVault from the class streams (Sablier withdrawMax)",
      run: async (context) => {
        const vault = deployedAddress("roseVault");
        if (!vault) throw new RoseActionError("not_deployed", "RoseVault not deployed", "The RoseVault address is not configured on this deployment.");
        let balance = await tokenBalance(deps.base, token as Address, vault);
        if (balance >= source.amount) return { message: `RoseVault already holds ${formatAmount(balance, decimals)} (nothing to withdraw)` };
        context.setDetail("Listing the class's streams held by RoseVault…");
        const streams = await classBaseStreams(deps.views, source.classId, context.signal);
        if (streams.length === 0) throw new RoseActionError("contract", "No stream to withdraw from", "RoseVault holds less than the claim and the engine holds no Base stream of this class.");
        const wallet = await deps.getEvmWalletClient();
        for (const position of streams) {
          if (position.source.kind !== "BaseStream") continue;
          const lockup = position.source.lockup as Address;
          const stream = await readStream(deps.base, position.source.streamId, lockup);
          if (stream.withdrawable === 0n) continue;
          const fee = await calculateMinFeeWei(deps.base, position.source.streamId, lockup);
          context.setDetail(`withdrawMax(#${position.source.streamId.toString()}): ${formatAmount(stream.withdrawable, decimals)} withdrawable${fee > 0n ? `, Sablier fee ${formatAmount(fee, 18)} ETH` : ""}…`);
          const hash = await withdrawMax(wallet, position.source.streamId, vault, { lockup, value: fee });
          context.addLinks(txLinks("base", hash));
          const receipt = await deps.base.waitForTransactionReceipt({ hash });
          if (receipt.status !== "success") throw new RoseActionError("contract", "withdrawMax reverted", `Sablier refused withdrawMax on stream #${position.source.streamId.toString()}; check the explorer link.`, true);
          balance = await tokenBalance(deps.base, token as Address, vault);
          if (balance >= source.amount) break;
        }
        if (balance < source.amount) {
          throw new RoseActionError("contract", "Vault balance still short", `RoseVault holds ${formatAmount(balance, decimals)} after withdrawing every withdrawable stream; the claim of ${formatAmount(source.amount, decimals)} cannot be covered yet.`);
        }
        return { message: `RoseVault holds ${formatAmount(balance, decimals)}` };
      },
    },
    request,
    mpcWait(deps, holder, undefined, [request]),
    submitBaseStep(deps, holder, "Submit executeTransfer to RoseVault"),
  ];
}

/** The message of a planned Solana claim: the streams drawn on and the part paid from the swept balance. */
export function describeSolPlan(plan: SolClaimPlan, decimals: number): string {
  const streams = plan.draws.length === 0 ? null : `${String(plan.draws.length)} stream${plan.draws.length === 1 ? "" : "s"} drawn on`;
  const swept = plan.swept === 0n ? null : `${formatAmount(plan.swept, decimals)} from the swept balance (ended streams, synced)`;
  return [streams, swept].filter((part) => part !== null).join(" + ");
}

/**
 * Solana tokens: nonce, receipt and recipient token account, then an engine-built durable-nonce
 * payout paid from the class's swept balance and drawing on its streams for the rest, broadcast,
 * confirmation on the receipt.
 */
export function claimSolTokensSteps(deps: FlowDeps, source: ClaimSource, mint: string, decimals: number, toOwner: string): StepDefinition[] {
  const nonce = { proof: null as SolNonceProof | null };
  const holder = { plan: null as SolClaimPlan | null };
  const payout: PayoutHolder = {
    payoutId: null,
    reset: () => {
      nonce.proof = null;
      holder.plan = null;
    },
  };
  const planNow = async (context: StepContext): Promise<SolClaimPlan> => {
    const [streams, swept] = await Promise.all([deps.views.getSolStreams(source.classId, { signal: context.signal }), deps.views.getSolSwept(source.classId, { signal: context.signal })]);
    return planSolClaim(streams, swept.available, source.amount, decimals);
  };
  const steps: StepDefinition[] = [
    nonceStep(deps, nonce, { owner: toOwner, mint }),
    {
      id: "draws",
      label: "Plan the payout: the class's swept balance first, then the fewest streams",
      run: async (context) => {
        holder.plan = await planNow(context);
        return { message: describeSolPlan(holder.plan, decimals) };
      },
    },
    requestStep(
      deps,
      "request",
      "Request the payout (nonce and receipt proof, Streamflow withdraws, SPL transfer and receipt advance in one transaction)",
      async (context) => {
        if (!nonce.proof) throw new RoseActionError("contract", "No nonce", "Create the nonce account first.");
        // Planned again right before every request: the swept balance is shared by the class's
        // claimants and a stream can enter its last 5 minutes or start carrying another payout, so
        // a retry must not resend a plan the engine already refused.
        const plan = await planNow(context);
        if (holder.plan && describeSolPlan(plan, decimals) !== describeSolPlan(holder.plan, decimals)) context.setDetail(`Plan updated: ${describeSolPlan(plan, decimals)}`);
        holder.plan = plan;
        return deps.calls.claimSolTokens(claimSourceArgs(source), plan.draws, toOwner, nonce.proof, plan.swept === 0n ? undefined : plan.swept);
      },
      payout,
    ),
  ];
  return [...steps, mpcWait(deps, payout, "Nonce proof and MPC signatures (about 15 s)", steps), broadcastSolStep(deps, payout, "Broadcast the signed transaction and wait for finality"), confirmSolStep(deps, payout)];
}

/**
 * `sync_sol_stream` of an ended vault stream (spec 7.3): reads its metadata at finality, which
 * must show Streamflow's auto-claim (`amount_withdrawn` above the engine's accounting) into the
 * vault's token account, anchors the proof on the newest successful finalized transaction
 * touching it (the auto-claim), and asks the engine to prove it and book the difference in the
 * class's swept balance. Anyone may sync; the engine refuses while a payout drawing on the stream
 * is unsettled.
 */
export function syncSolStreamSteps(deps: FlowDeps, entry: SolStreamStateView, decimals: number): StepDefinition[] {
  type SyncProof = { anchor: string; metadataData: string; amount: bigint };
  const holder = { proof: null as SyncProof | null };
  const readProof = async (context: StepContext): Promise<SyncProof> => {
    const metadata = new PublicKey(entry.stream.metadata);
    const [state, anchor] = await Promise.all([readStreamflowStream(deps.solana, metadata, "finalized"), latestSuccessfulSignature(deps.solana, metadata)]);
    if (deps.vaultSol && state.metadata.recipient.toBase58() !== deps.vaultSol) {
      throw new RoseActionError("contract", "Not at the vault", "The stream no longer names the engine's vault as its recipient, so there is nothing for the engine to book.");
    }
    const engineWithdrawn = BigInt(entry.stream.engine_withdrawn);
    if (state.metadata.amountWithdrawn <= engineWithdrawn) {
      throw new RoseActionError("contract", "Nothing to sync yet", "The stream shows no withdrawal beyond the engine's accounting at finality: Streamflow's auto-claim runs one second after the end and takes about 15 s to be final. Retry in a few seconds.", true);
    }
    if (!anchor) throw new RoseActionError("contract", "No anchor", "No successful finalized transaction touches the stream yet; retry in a few seconds.", true);
    context.addLinks(txLinks("solana", anchor));
    return { anchor, metadataData: bytesToHex(state.raw), amount: state.metadata.amountWithdrawn - engineWithdrawn };
  };
  return [
    {
      id: "read",
      label: "Read the stream at finality: Streamflow's auto-claim into the vault",
      run: async (context) => {
        holder.proof = await readProof(context);
        return { message: `${formatAmount(holder.proof.amount, decimals)} withdrawn by the auto-claim, not booked yet` };
      },
    },
    {
      id: "sync",
      label: "Prove it on NEAR and book it in the class's swept balance (MPC proof, about 7 s)",
      run: async (context) => {
        if (!holder.proof) {
          context.setDetail("Reading the stream again at finality…");
          holder.proof = await readProof(context);
        }
        const proof = holder.proof;
        holder.proof = null;
        const outcome = await deps.sendNearCall(deps.calls.syncSolStream(BigInt(entry.position_id), proof.anchor, proof.metadataData));
        context.addLinks(txLinks("near", outcome.transaction.hash));
        const swept = decodeEventLogs(outcomeLogs(outcome)).find((decoded) => decoded.standard === "rose" && decoded.event.event === "sol_stream_swept");
        if (!swept) {
          throw new RoseActionError("mpc_timeout", "Proof not accepted", "The engine did not book the sync: the stream changed between the read and the proof, a payout started drawing on it, or the MPC failed. Nothing changed; retry reads the stream again.", true);
        }
        const amount = BigInt((swept.event.data as { amount: string }).amount);
        return { message: `${formatAmount(amount, decimals)} booked in the swept balance; claims pay from it` };
      },
    },
  ];
}

/** In-kind redeem: burn the allocation, authorize the release, submit or broadcast it. */
export function redeemSteps(deps: FlowDeps, position: Position, to: string, mint: string): StepDefinition[] {
  if (position.source.kind === "BaseStream") {
    const holder: PayoutHolder = { payoutId: null };
    const request = requestStep(deps, "request", "Burn the allocation and request the Release authorization", () => deps.calls.redeem(position.positionId, to), holder);
    return [request, mpcWait(deps, holder, undefined, [request]), submitBaseStep(deps, holder, "Submit executeRelease to RoseVault (the stream NFT goes to your address)")];
  }
  const nonce = { proof: null as SolNonceProof | null };
  const holder: PayoutHolder = { payoutId: null, reset: () => (nonce.proof = null) };
  const steps: StepDefinition[] = [
    nonceStep(deps, nonce, { owner: to, mint }),
    requestStep(
      deps,
      "request",
      "Burn the allocation, pay the stream's owed share from your claimable tokens and request the release (transfer_recipient to you)",
      () => {
        if (!nonce.proof) throw new RoseActionError("contract", "No nonce", "Create the nonce account first.");
        return deps.calls.redeem(position.positionId, to, nonce.proof);
      },
      holder,
    ),
  ];
  return [...steps, mpcWait(deps, holder, "Nonce proof and MPC signatures (about 15 s)", steps), broadcastSolStep(deps, holder, "Broadcast the signed transaction and wait for finality"), confirmSolStep(deps, holder)];
}

function settles(payout: PayoutView): boolean {
  return "SolTransfer" in payout.kind || "SolRelease" in payout.kind;
}

/** Finishing a payout that was signed earlier: submit on Base, or broadcast on Solana and confirm. */
export function finishPayoutSteps(deps: FlowDeps, payout: PayoutView): StepDefinition[] {
  const holder: PayoutHolder = { payoutId: BigInt(payout.id) };
  if (payout.chain === "Base") return [submitBaseStep(deps, holder, "Submit the stored authorization to RoseVault")];
  return [broadcastSolStep(deps, holder, "Broadcast the stored transaction and wait for finality"), ...(settles(payout) ? [confirmSolStep(deps, holder)] : [])];
}

/** Confirms a Solana transfer or release whose nonce advanced but which was never proven on NEAR. */
export function confirmPayoutSteps(deps: FlowDeps, payout: PayoutView): StepDefinition[] {
  return [confirmSolStep(deps, { payoutId: BigInt(payout.id) })];
}

/** `retry_sol_payout` for a Solana action still `Requested` 600 blocks after its request, then broadcast and confirmation. */
export function retrySolPayoutSteps(deps: FlowDeps, payout: PayoutView): StepDefinition[] {
  const payoutId = BigInt(payout.id);
  const holder: PayoutHolder = { payoutId };
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
    broadcastSolStep(deps, holder, "Broadcast the signed transaction and wait for finality"),
    ...(settles(payout) ? [confirmSolStep(deps, holder)] : []),
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
    broadcastSolStep(deps, holder, "Broadcast the signed transaction and wait for finality"),
    ...(settles(payout) ? [confirmSolStep(deps, holder)] : []),
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
