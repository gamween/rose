/**
 * Builders for every change method of the rose-engine contract. Each builder returns a
 * wallet-agnostic [`FunctionCall`] (method name, JSON args, gas, attached deposit) that the app
 * hands to NEAR Connect, to the in-app demo wallet or to a script. Gas figures come from the live
 * measurements recorded in `docs/verification.md` and the engine findings.
 *
 * @module
 */

import type { AccountId, ClaimSourceArgs, ClassId, ReplayKey, Side, SolDepositArgs, SolNonceProof, Venue } from "./types.js";

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

/** Gas attached per method: measured cost plus headroom, always under the 300 Tgas wallet cap. */
export const GAS = {
  simple: 30n * TGAS,
  mtTransferCall: 60n * TGAS,
  withdrawNearCash: 40n * TGAS,
  close: 80n * TGAS,
  submitKey: 30n * TGAS,
  openBid: 300n * TGAS,
  clear: 300n * TGAS,
  settleBid: 50n * TGAS,
  ftTransferCall: 60n * TGAS,
  foreignVerification: 80n * TGAS,
  payout: 60n * TGAS,
  bootstrap: 60n * TGAS,
  registerDeposit: 80n * TGAS,
  attributeSolDeposit: 100n * TGAS,
  solAction: 80n * TGAS,
  solPayout: 120n * TGAS,
} as const;

/** Storage deposit kept with every payout record (`PAYOUT_STORAGE_DEPOSIT`). */
export const PAYOUT_STORAGE_DEPOSIT = ONE_NEAR / 50n;

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
  retireTo: AccountId;
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
  registerBaseDeposit(location: BaseLogLocationArgs, fields: Record<string, unknown>, registrationDeposit: bigint): FunctionCall {
    return this.call("register_base_deposit", { location, fields }, GAS.registerDeposit, registrationDeposit);
  }

  registerBaseCash(location: BaseLogLocationArgs, fields: Record<string, unknown>): FunctionCall {
    return this.call("register_base_cash", { location, fields }, GAS.registerDeposit);
  }

  /** Spec 7.2 step 1: attributes a stream sitting at the caller's deposit address to the caller. */
  attributeSolDeposit(args: SolDepositArgs): FunctionCall {
    return this.call("attribute_sol_deposit", { args }, GAS.attributeSolDeposit);
  }

  /** Spec 7.2 step 2: the engine signs `transfer_recipient` from the deposit address to the vault. */
  moveSolDeposit(metadata: string, recentBlockhash: string): FunctionCall {
    return this.call("move_sol_deposit", { metadata, recent_blockhash: recentBlockhash }, GAS.solAction, PAYOUT_STORAGE_DEPOSIT);
  }

  /** Spec 7.2 step 3: `metadataData` is the 1,104 metadata bytes (hex) read at `finalized` right before the call. */
  registerSolDeposit(metadata: string, anchorTx: string, metadataData: string, registrationDeposit: bigint): FunctionCall {
    return this.call("register_sol_deposit", { metadata, anchor_tx: anchorTx, metadata_data: metadataData }, GAS.registerDeposit, registrationDeposit);
  }

  withdrawSolStream(positionId: bigint, recentBlockhash: string): FunctionCall {
    return this.call("withdraw_sol_stream", { position_id: positionId.toString(), recent_blockhash: recentBlockhash }, GAS.solAction, PAYOUT_STORAGE_DEPOSIT);
  }

  /** Spec 7.3: EIP-712 `Transfer` authorization for RoseVault, submitted by the claimant with `executeTransfer`. */
  claimBaseTokens(source: ClaimSourceArgs, amount: bigint, to: string): FunctionCall {
    return this.call("claim_base_tokens", { source, amount: amount.toString(), to }, GAS.payout, PAYOUT_STORAGE_DEPOSIT);
  }

  withdrawBaseCash(token: string, amount: bigint, to: string): FunctionCall {
    return this.call("withdraw_base_cash", { token, amount: amount.toString(), to }, GAS.payout, PAYOUT_STORAGE_DEPOSIT);
  }

  /** Spec 7.3: durable-nonce Solana payout; the nonce account is proven before signing. */
  claimSolTokens(source: ClaimSourceArgs, amount: bigint, toOwner: string, nonce: SolNonceProof): FunctionCall {
    return this.call("claim_sol_tokens", { source, amount: amount.toString(), to_owner: toOwner, nonce }, GAS.solPayout, PAYOUT_STORAGE_DEPOSIT);
  }

  resignSolGas(payoutId: bigint): FunctionCall {
    return this.call("resign_sol_gas", { payout_id: payoutId.toString() }, GAS.solAction);
  }

  /** In-kind exit: burns the position's allocation and authorizes its release (`nonce` and `metadataData` for Solana only). */
  redeem(positionId: bigint, to: string, solana?: { nonce: SolNonceProof; metadataData: string }): FunctionCall {
    return this.call(
      "redeem",
      { position_id: positionId.toString(), to, nonce: solana?.nonce ?? null, metadata_data: solana?.metadataData ?? null },
      solana ? GAS.solPayout : GAS.payout,
      PAYOUT_STORAGE_DEPOSIT,
    );
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
