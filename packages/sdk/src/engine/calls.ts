/**
 * Builders for every change method of the rose-engine contract. Each builder returns a
 * wallet-agnostic [`FunctionCall`] (method name, JSON args, gas, attached deposit) that the app
 * hands to NEAR Connect, to the in-app demo wallet or to a script. Gas figures come from the live
 * measurements recorded in `docs/verification.md` and the engine findings.
 *
 * @module
 */

import type { CashDepositedFields, StreamDepositedFields } from "../chains/base/deposit.js";
import type { AccountId, ClaimSourceArgs, ClassId, ReplayKey, Side, SolDepositArgs, SolDrawArgs, SolNonceProof, Venue } from "./types.js";

/** One NEAR function call: what every wallet needs to sign it. */
export interface FunctionCall {
  receiverId: AccountId;
  methodName: string;
  args: Record<string, unknown>;
  /** Prepaid gas in gas units (1 Tgas = 10^12). */
  gas: bigint;
  /** Attached deposit in yoctoNEAR. */
  deposit: bigint;
}

export const TGAS = 1_000_000_000_000n;
export const ONE_YOCTO = 1n;
export const ONE_NEAR = 1_000_000_000_000_000_000_000_000n;

/** Storage deposits of the engine (`get_limits` returns the same values live). */
export const ROUND_STORAGE_DEPOSIT = ONE_NEAR / 20n;
export const BID_STORAGE_DEPOSIT = ONE_NEAR / 50n;

/**
 * Gas attached per method: measured cost plus headroom, always under the 300 Tgas wallet cap.
 * Prepaid gas is charged up front at the pessimistic gas price (about 1 NEAR per 1,000 Tgas on
 * testnet, measured 2026-11-04: 300 Tgas needed 0.3009 NEAR of balance), so oversized limits
 * lock small demo accounts out of a call they could afford.
 */
export const GAS = {
  simple: 30n * TGAS,
  mtTransferCall: 60n * TGAS,
  withdrawNearCash: 40n * TGAS,
  close: 80n * TGAS,
  submitKey: 30n * TGAS,
  /** Fully verified opening: 131.7 to 132.1 Tgas measured (sandbox at the bid cap and live staging). */
  openBid: 200n * TGAS,
  /** 11.1 Tgas at the 64-bid cap (sandbox), 4.1 Tgas live with two orders. */
  clear: 50n * TGAS,
  settleBid: 50n * TGAS,
  ftTransferCall: 60n * TGAS,
  foreignVerification: 80n * TGAS,
  payout: 80n * TGAS,
  bootstrap: 80n * TGAS,
  registerDeposit: 80n * TGAS,
  attributeSolDeposit: 120n * TGAS,
  solAction: 120n * TGAS,
  solPayout: 200n * TGAS,
  solConfirm: 100n * TGAS,
  submitSignature: 30n * TGAS,
} as const;

/**
 * NEP-145 storage of one cash row (`CASH_ROW_BYTES`, 172 bytes at 1e19 yoctoNEAR per byte):
 * `ft_on_transfer` refuses a NEAR cash deposit (the token refunds it) unless the sender is
 * registered with room for its row in the venue. `storage_balance_bounds().min` covers the
 * record, one holding row and one cash row; an account that already holds other rows tops up
 * this much before its first deposit in a venue.
 */
export const CASH_ROW_STORAGE_DEPOSIT = 172n * 10_000_000_000_000_000_000n;

/** Storage deposit kept with every payout record (`PAYOUT_STORAGE_DEPOSIT`, 0.025 NEAR). */
export const PAYOUT_STORAGE_DEPOSIT = (ONE_NEAR * 25n) / 1000n;

/** Storage deposit kept with deposit records (`RECORD_STORAGE_DEPOSIT`, 0.015 NEAR): attribution and Base cash registration attach it; `registration_deposit_for` includes it. */
export const RECORD_STORAGE_DEPOSIT = (ONE_NEAR * 15n) / 1000n;

/** `BaseLogLocation` and the `StreamDeposited` / `CashDeposited` fields as the engine expects them (see `chains/base/deposit.ts`). */
export interface BaseLogLocationArgs {
  tx_hash: string;
  block_hash: string;
  block_number: number;
  transaction_index: number;
  log_index: number;
}

export interface RoundWindowArgs {
  /** Nanosecond timestamps; `opensAt` defaults to now on chain. */
  closesAt: bigint;
  opensAt?: bigint;
  keyTimeout?: bigint;
  revealWindow?: bigint;
}

function window(args: RoundWindowArgs): Record<string, string | null> {
  return {
    opens_at: args.opensAt === undefined ? null : args.opensAt.toString(),
    closes_at: args.closesAt.toString(),
    key_timeout: args.keyTimeout === undefined ? null : args.keyTimeout.toString(),
    reveal_window: args.revealWindow === undefined ? null : args.revealWindow.toString(),
  };
}

export interface TenderArgs {
  classId: ClassId;
  venue: Venue;
  budget: bigint;
  maxPrice: bigint;
  referencePrice?: bigint;
  /** Foreign address the retired lot pays to: lowercase `0x` address (Base class) or base58 key (Solana class); never RoseVault or an engine key. */
  retireTo: string;
  window: RoundWindowArgs;
}

export interface ExitArgs { classId: ClassId; venue: Venue; maxPrice: bigint; window: RoundWindowArgs }

export interface AdvanceArgs {
  classId: ClassId;
  venue: Venue;
  units: bigint;
  claim: bigint;
  minFill: bigint;
  maxPrice: bigint;
  window: RoundWindowArgs;
}

/** Builders bound to one engine account. */
export class EngineCalls {
  constructor(readonly engine: AccountId) {}

  private call(methodName: string, args: Record<string, unknown>, gas: bigint, deposit = 0n): FunctionCall {
    return { receiverId: this.engine, methodName, args, gas, deposit };
  }

  createTender(a: TenderArgs): FunctionCall {
    return this.call(
      "create_tender",
      {
        params: {
          class_id: a.classId,
          venue: a.venue,
          budget: a.budget.toString(),
          max_price: a.maxPrice.toString(),
          reference_price: a.referencePrice === undefined ? null : a.referencePrice.toString(),
          retire_to: a.retireTo,
          window: window(a.window),
        },
      },
      GAS.simple,
      ROUND_STORAGE_DEPOSIT,
    );
  }

  createExit(a: ExitArgs): FunctionCall {
    return this.call(
      "create_exit",
      { params: { class_id: a.classId, venue: a.venue, max_price: a.maxPrice.toString(), window: window(a.window) } },
      GAS.simple,
      ROUND_STORAGE_DEPOSIT,
    );
  }

  createAdvance(a: AdvanceArgs): FunctionCall {
    return this.call(
      "create_advance",
      {
        params: {
          class_id: a.classId,
          venue: a.venue,
          units: a.units.toString(),
          claim: a.claim.toString(),
          min_fill: a.minFill.toString(),
          max_price: a.maxPrice.toString(),
          window: window(a.window),
        },
      },
      GAS.simple,
      ROUND_STORAGE_DEPOSIT,
    );
  }

  cancelRound(roundId: bigint): FunctionCall {
    return this.call("cancel_round", { round_id: roundId.toString() }, GAS.simple);
  }

  /** `ciphertextHex`: the 192-byte sealed order from `encryptBid`, lowercase hex without `0x`. */
  placeBid(roundId: bigint, ciphertextHex: string, escrow: bigint): FunctionCall {
    return this.call("place_bid", { round_id: roundId.toString(), ciphertext_hex: ciphertextHex, escrow: escrow.toString() }, GAS.simple, BID_STORAGE_DEPOSIT);
  }

  placeAsk(roundId: bigint, ciphertextHex: string, units: bigint): FunctionCall {
    return this.call("place_ask", { round_id: roundId.toString(), ciphertext_hex: ciphertextHex, units: units.toString() }, GAS.simple, BID_STORAGE_DEPOSIT);
  }

  close(roundId: bigint): FunctionCall {
    return this.call("close", { round_id: roundId.toString() }, GAS.close);
  }

  submitKey(roundId: bigint, key: string): FunctionCall {
    return this.call("submit_key", { round_id: roundId.toString(), key }, GAS.submitKey);
  }

  cancelNoKey(roundId: bigint): FunctionCall {
    return this.call("cancel_no_key", { round_id: roundId.toString() }, GAS.simple);
  }

  /** `plaintextHex` (48 bytes) and `sigmaHex` (32 bytes) come from `decryptBid`. */
  openBid(roundId: bigint, bidId: number, plaintextHex: string, sigmaHex: string): FunctionCall {
    return this.call("open_bid", { round_id: roundId.toString(), bid_id: bidId, plaintext_hex: plaintextHex, sigma_hex: sigmaHex }, GAS.openBid);
  }

  clear(roundId: bigint): FunctionCall {
    return this.call("clear", { round_id: roundId.toString() }, GAS.clear);
  }

  settleBid(roundId: bigint, bidId: number): FunctionCall {
    return this.call("settle_bid", { round_id: roundId.toString(), bid_id: bidId }, GAS.settleBid);
  }

  releaseLien(lienId: bigint): FunctionCall {
    return this.call("release_lien", { lien_id: lienId.toString() }, GAS.simple);
  }

  withdrawNearCash(amount: bigint): FunctionCall {
    return this.call("withdraw_near_cash", { amount: amount.toString() }, GAS.withdrawNearCash, ONE_YOCTO);
  }

  mtTransfer(receiverId: AccountId, tokenId: string, amount: bigint, memo?: string): FunctionCall {
    return this.call(
      "mt_transfer",
      { receiver_id: receiverId, token_id: tokenId, amount: amount.toString(), approval: null, memo: memo ?? null },
      GAS.simple,
      ONE_YOCTO,
    );
  }

  mtBatchTransfer(receiverId: AccountId, tokenIds: string[], amounts: bigint[], memo?: string): FunctionCall {
    return this.call(
      "mt_batch_transfer",
      { receiver_id: receiverId, token_ids: tokenIds, amounts: amounts.map((a) => a.toString()), approvals: null, memo: memo ?? null },
      GAS.simple,
      ONE_YOCTO,
    );
  }

  mtTransferCall(receiverId: AccountId, tokenId: string, amount: bigint, msg: string, memo?: string): FunctionCall {
    return this.call(
      "mt_transfer_call",
      { receiver_id: receiverId, token_id: tokenId, amount: amount.toString(), approval: null, memo: memo ?? null, msg },
      GAS.mtTransferCall,
      ONE_YOCTO,
    );
  }

  /**
   * Issuer distribution: at most 50 receivers per call (`get_limits().max_distribution_receivers`).
   * `registrationDeposit` (at least 1 yocto) registers receivers that never touched the engine and
   * pays their holding row; the unused part is refunded.
   */
  distributeUnits(tokenId: string, receivers: { account: AccountId; units: bigint }[], registrationDeposit: bigint = ONE_YOCTO): FunctionCall {
    return this.call(
      "distribute_units",
      { token_id: tokenId, receivers: receivers.map((r) => [r.account, r.units.toString()]) },
      GAS.simple,
      registrationDeposit < ONE_YOCTO ? ONE_YOCTO : registrationDeposit,
    );
  }

  /** NEP-145 registration in the engine: required before an account can receive units or buy in an Exit. */
  storageDeposit(deposit: bigint, accountId?: AccountId, registrationOnly = false): FunctionCall {
    return this.call("storage_deposit", { account_id: accountId ?? null, registration_only: registrationOnly }, GAS.simple, deposit);
  }

  storageWithdraw(amount?: bigint): FunctionCall {
    return this.call("storage_withdraw", { amount: amount === undefined ? null : amount.toString() }, GAS.simple, ONE_YOCTO);
  }

  storageUnregister(force = false): FunctionCall {
    return this.call("storage_unregister", { force }, GAS.simple, ONE_YOCTO);
  }

  /* Custody */

  /** Permissionless one-time derivation of `vault/base`, `vault/sol` and `gas/sol`. */
  bootstrap(): FunctionCall {
    return this.call("bootstrap", {}, GAS.bootstrap);
  }

  /** Spec 7.1 step 3; `registrationDeposit` comes from `registration_deposit_for` (the unused part is returned). */
  registerBaseDeposit(location: BaseLogLocationArgs, fields: StreamDepositedFields, registrationDeposit: bigint): FunctionCall {
    return this.call("register_base_deposit", { location, fields }, GAS.registerDeposit, registrationDeposit);
  }

  registerBaseCash(location: BaseLogLocationArgs, fields: CashDepositedFields): FunctionCall {
    return this.call("register_base_cash", { location, fields }, GAS.registerDeposit, RECORD_STORAGE_DEPOSIT);
  }

  /** Spec 7.2 step 1: attributes a stream sitting at the caller's deposit address to the caller. */
  attributeSolDeposit(args: SolDepositArgs): FunctionCall {
    return this.call("attribute_sol_deposit", { args }, GAS.attributeSolDeposit, RECORD_STORAGE_DEPOSIT);
  }

  /** Spec 7.2 step 2: the engine signs `transfer_recipient` from the deposit address to the vault. */
  moveSolDeposit(metadata: string, recentBlockhash: string): FunctionCall {
    return this.call("move_sol_deposit", { metadata, recent_blockhash: recentBlockhash }, GAS.solAction, PAYOUT_STORAGE_DEPOSIT);
  }

  /** Spec 7.2 step 3: `metadataData` is the 1,104 metadata bytes (hex) read at `finalized` right before the call. */
  registerSolDeposit(metadata: string, anchorTx: string, metadataData: string, registrationDeposit: bigint): FunctionCall {
    return this.call("register_sol_deposit", { metadata, anchor_tx: anchorTx, metadata_data: metadataData }, GAS.registerDeposit, registrationDeposit);
  }

  /** Spec 7.3: EIP-712 `Transfer` authorization for RoseVault, submitted by the claimant with `executeTransfer`. */
  claimBaseTokens(source: ClaimSourceArgs, amount: bigint, to: string): FunctionCall {
    return this.call("claim_base_tokens", { source, amount: amount.toString(), to }, GAS.payout, PAYOUT_STORAGE_DEPOSIT);
  }

  withdrawBaseCash(token: string, amount: bigint, to: string): FunctionCall {
    return this.call("withdraw_base_cash", { token, amount: amount.toString(), to }, GAS.payout, PAYOUT_STORAGE_DEPOSIT);
  }

  /**
   * Spec 7.3: durable-nonce Solana payout drawing on the named streams of the class (the claim
   * is their sum); the nonce account (created with the caller's seed, `payoutNonceSeed`) and the
   * recipient's token account are proven before signing. The payout stays `Signed` until
   * `confirmSolPayout`.
   */
  claimSolTokens(source: ClaimSourceArgs, draws: SolDrawArgs[], toOwner: string, nonce: SolNonceProof): FunctionCall {
    return this.call("claim_sol_tokens", { source, draws, to_owner: toOwner, nonce }, GAS.solPayout, PAYOUT_STORAGE_DEPOSIT);
  }

  /** Settles a signed Solana payout once its nonce advanced: `streamData` is the metadata (hex) of every drawn stream, in draw order. */
  confirmSolPayout(payoutId: bigint, anchorTx: string, nonceData: string, streamData: string[]): FunctionCall {
    return this.call("confirm_sol_payout", { payout_id: payoutId.toString(), anchor_tx: anchorTx, nonce_data: nonceData, stream_data: streamData }, GAS.solConfirm);
  }

  /** Settles the signed release of a Solana position once its nonce advanced. */
  confirmSolRedeem(positionId: bigint, anchorTx: string, nonceData: string, streamData: string): FunctionCall {
    return this.call("confirm_sol_redeem", { position_id: positionId.toString(), anchor_tx: anchorTx, nonce_data: nonceData, stream_data: streamData }, GAS.solConfirm);
  }

  /** Resolves a Solana action still `Requested` 600 blocks after its last request (refund, failure or re-signature). */
  retrySolPayout(payoutId: bigint): FunctionCall {
    return this.call("retry_sol_payout", { payout_id: payoutId.toString() }, GAS.solAction);
  }

  /** Completes a Base authorization whose MPC response the callback could not read (`r`, `s` hex, `v` 27 or 28). */
  submitBaseSignature(payoutId: bigint, r: string, s: string, v: number): FunctionCall {
    return this.call("submit_base_signature", { payout_id: payoutId.toString(), r, s, v }, GAS.submitSignature);
  }

  /** Completes a Solana action with a signature (hex) of `signerPath` (its authority path or `gas/sol`) the callback could not read. */
  submitSolSignature(payoutId: bigint, signerPath: string, signature: string): FunctionCall {
    return this.call("submit_sol_signature", { payout_id: payoutId.toString(), signer_path: signerPath, signature }, GAS.submitSignature);
  }

  resignSolGas(payoutId: bigint): FunctionCall {
    return this.call("resign_sol_gas", { payout_id: payoutId.toString() }, GAS.solAction);
  }

  /** Re-requests the `vault/base` signature of a Base authorization still `Requested` 600 blocks after its request. */
  retryBaseSignature(payoutId: bigint): FunctionCall {
    return this.call("retry_base_signature", { payout_id: payoutId.toString() }, GAS.payout);
  }

  /**
   * In-kind exit: burns the position's allocation and authorizes its release. A Solana position
   * needs a nonce proof (and `to`'s token account), carries no unconfirmed payout, and the caller
   * pays what the stream still owes the unit holders from its claimable (`redeem_claimable` of
   * `get_sol_streams`); the release stays `Signed` until `confirmSolRedeem`.
   */
  redeem(positionId: bigint, to: string, nonce?: SolNonceProof): FunctionCall {
    return this.call("redeem", { position_id: positionId.toString(), to, nonce: nonce ?? null }, nonce ? GAS.solPayout : GAS.payout, PAYOUT_STORAGE_DEPOSIT);
  }

  returnRefusedDeposit(key: ReplayKey, recentBlockhash?: string): FunctionCall {
    return this.call("return_refused_deposit", { key, recent_blockhash: recentBlockhash ?? null }, GAS.solAction, PAYOUT_STORAGE_DEPOSIT);
  }
}

/**
 * `ft_transfer_call` on the NEP-141 cash token that credits the caller's NEAR cash in the engine
 * (`ft_on_transfer` with an empty `msg`).
 */
export function depositNearCashCall(token: AccountId, engine: AccountId, amount: bigint): FunctionCall {
  return { receiverId: token, methodName: "ft_transfer_call", args: { receiver_id: engine, amount: amount.toString(), msg: "" }, gas: GAS.ftTransferCall, deposit: ONE_YOCTO };
}

/** `storage_deposit` on a NEP-141 token for `account` (needed once before it can hold the token). */
export function storageDepositCall(token: AccountId, account: AccountId, deposit: bigint): FunctionCall {
  return { receiverId: token, methodName: "storage_deposit", args: { account_id: account, registration_only: true }, gas: GAS.simple, deposit };
}

/** rose tUSDC public capped mint (`contracts/tusdc`): 10,000 tUSDC per account per rolling 24 h. */
export function mintTestUsdcCall(token: AccountId, amount: bigint, storageDeposit: bigint): FunctionCall {
  return { receiverId: token, methodName: "mint", args: { amount: amount.toString() }, gas: GAS.simple, deposit: storageDeposit };
}

/** The `Buy` or `Sell` side of an order as the engine encodes it in associated data (`side: u8`). */
export function sideIndex(side: Side): number {
  return side === "Buy" ? 0 : 1;
}
