/**
 * Types of the rose-engine contract (`contracts/engine`), checked against the ABI produced by
 * `cargo near build non-reproducible-wasm` (`target/near/rose_engine/rose_engine_abi.json`).
 *
 * `*View` types mirror the JSON exactly as the contract returns it: `U128` and `U64` are decimal
 * strings, `u32` and `u8` are numbers, enums without payload are strings and enums with payload
 * are single-key objects. The matching parsed types (`Round`, `Holding`, ...) carry `bigint`.
 *
 * @module
 */

/** `U128` as serialized by near-sdk: a decimal string. */
export type U128 = string;
/** `U64` as serialized by near-sdk: a decimal string. */
export type U64 = string;
/** Lowercase hex SHA-256 of the class key. */
export type ClassId = string;
export type AccountId = string;

export type Chain = "Base" | "Solana";
export type RoundKind = "Tender" | "Exit" | "Advance";
export type RoundStatus = "Scheduled" | "Open" | "KeyRequested" | "Revealing" | "Clearing" | "Settled" | "Cancelled";
export type Side = "Buy" | "Sell";
export type BidStatus = "Sealed" | "Opened" | "Void" | "Settled";
export type CancelReason = "Creator" | "NoKey" | "NoCrossing" | "Empty";
export type KeySource = "Callback" | "Submitted";
export type VoidReason = "Unopened" | "EscrowTooSmall" | "QuantityAboveSupply" | "QuantityAboveLocked" | "ClaimMismatch";
export type PositionState = "Held" | "Releasing" | "Released";

/** Cash venue: the NEP-141 tUSDC on NEAR, or an ERC-20 held by RoseVault on Base. */
export type Venue = "Near" | { Base: { token: string } };

export type PositionSourceView = { BaseStream: { lockup: string; stream_id: U128 } } | { SolanaStream: { metadata: string } };

export type ScheduleView =
  | {
      Linear: {
        start: U64;
        cliff: U64;
        end: U64;
        granularity: U64;
        total: U128;
        start_unlock: U128;
        cliff_unlock: U128;
        min_deposit: U128;
      };
    }
  | {
      Stepped: {
        start: U64;
        end: U64;
        period: U64;
        amount_per_period: U128;
        cliff_amount: U128;
        total: U128;
      };
    };

export interface StatsView {
  rounds_total: number;
  rounds_settled: number;
  volume_settled_usdc: U128;
  classes: number;
  positions: number;
}

export interface DerivedAddressesView { vault_base: string; vault_sol: string; gas_sol: string }

export interface ConfigView {
  mpc_account: AccountId;
  sign_secp256k1_domain: number;
  sign_ed25519_domain: number;
  ckd_domain: number;
  foreign_tx_domain: number;
  ckd_public_key: string;
  fee_recipient: AccountId;
  rose_vault: string;
  sablier_lockup: string;
  base_cash_tokens: string[];
  base_chain_id: number;
  streamflow_program: string;
  near_cash_token: AccountId;
  default_key_timeout: U64;
  default_reveal_window: U64;
  derived_addresses?: DerivedAddressesView | null;
}

export interface LimitsView {
  bid_storage_deposit: U128;
  round_storage_deposit: U128;
  bond_floor: U128;
  fee_bps: number;
  max_bids_per_round: number;
  max_distribution_receivers: number;
  /** Bounds of a round's `key_timeout`, nanoseconds. */
  min_key_timeout: U64;
  max_key_timeout: U64;
  /** Bounds of a round's `reveal_window`, nanoseconds. */
  min_reveal_window: U64;
  max_reveal_window: U64;
  /** Longest time from a round's creation to its `closes_at`, nanoseconds. */
  max_round_horizon: U64;
}

export interface ClassView {
  class_id: ClassId;
  chain: Chain;
  token: string;
  /** What the engine cannot verify about the stream token (shown next to the class). */
  token_risk: string;
  decimals: number;
  schedule: ScheduleView;
  total_units: U128;
  positions: number;
  created_at: U64;
  fraction_now: U128;
}

export interface PositionView {
  position_id: U64;
  class_id: ClassId;
  source: PositionSourceView;
  allocation: U128;
  depositor: AccountId;
  deposited_at: U64;
  state: PositionState;
}

export interface OpenedView { quantity: U128; price: U128 }

export interface BidView {
  round_id: U64;
  bid_id: number;
  bidder: AccountId;
  side: Side;
  status: BidStatus;
  escrow: U128;
  locked_units: U128;
  bond: U128;
  fee: U128;
  cash: U128;
  fill_quantity: U128;
  ciphertext_hex?: string | null;
  placed_at?: U64 | null;
  opened?: OpenedView | null;
  void?: VoidReason | null;
}

export interface BidOutcomeView {
  bid_id: number;
  bidder: AccountId;
  side: Side;
  escrow: U128;
  locked_units: U128;
  bond: U128;
  fee: U128;
  cash: U128;
  fill_quantity: U128;
  settled: boolean;
  opened?: OpenedView | null;
  void?: VoidReason | null;
}

export interface RoundResultView {
  price: U128;
  volume: U128;
  notional: U128;
  fee: U128;
  issuer_charged: U128;
  issuer_refund: U128;
  remaining_lock_secs: U64;
  fills: BidOutcomeView[];
}

export interface RoundView {
  round_id: U64;
  kind: RoundKind;
  class_id: ClassId;
  venue: Venue;
  creator: AccountId;
  status: RoundStatus;
  app_id: string;
  opens_at: U64;
  closes_at: U64;
  key_timeout: U64;
  reveal_window: U64;
  max_price: U128;
  f_ts: U128;
  remaining_lock_secs: U64;
  bid_count: number;
  opened_count: number;
  settled_count: number;
  created_at: U64;
  budget?: U128 | null;
  issuer_escrow?: U128 | null;
  reference_price?: U128 | null;
  /** Largest quantity a buy order may name (a larger one is void at opening): the class supply when the round was created (Exit), the claim (Advance); null for a Tender. */
  max_buy_quantity?: U128 | null;
  /** Foreign address (Base `0x…` or Solana base58) a Tender's retired lot pays to. */
  retire_to?: string | null;
  advance_units?: U128 | null;
  advance_claim?: U128 | null;
  advance_min_fill?: U128 | null;
  lien_id?: U64 | null;
  close_requested_at?: U64 | null;
  key?: string | null;
  key_source?: KeySource | null;
  key_received_at?: U64 | null;
  reveal_ends_at?: U64 | null;
  ended_at?: U64 | null;
  cancel_reason?: CancelReason | null;
  result?: RoundResultView | null;
}

export interface RoundFilter {
  kind?: RoundKind;
  class_id?: ClassId;
  status?: RoundStatus;
  creator?: AccountId;
}

export interface HoldingView {
  class_id: ClassId;
  balance: U128;
  locked_in_rounds: U128;
  encumbered: U128;
  claimable: U128;
  checkpoint: U128;
}

export interface RetiredLotView { round_id: U64; class_id: ClassId; retire_to: string; units: U128; claimable: U128 }

export interface CashView { venue: Venue; amount: U128 }

export interface LienView {
  lien_id: U64;
  round_id: U64;
  class_id: ClassId;
  holder: AccountId;
  units: U128;
  claim_total: U128;
  delivered: U128;
  pending_excess: U128;
  created_at: U64;
  released: boolean;
}

export interface LienShareView {
  lien_id: U64;
  class_id: ClassId;
  funder: AccountId;
  claim: U128;
  claimed: U128;
  claimable: U128;
}

export interface PortfolioView {
  holdings: HoldingView[];
  bids: BidView[];
  liens_held: LienView[];
  lien_shares: LienShareView[];
  cash: CashView[];
}

export interface PricePointView {
  round_id: number;
  kind: RoundKind;
  price: U128;
  volume: U128;
  remaining_lock_secs: U64;
  settled_at: U64;
}

/** `get_price_history`: a page of a class's clearing history, oldest first. */
export interface PriceHistoryPageView { points: PricePointView[]; total: number }

/** `get_rounds`: `next` is the id to continue from, null once every round was examined. */
export interface RoundsPageView { rounds: RoundView[]; next?: U64 | null }

export interface BuyQuoteView { charge: U128; fee: U128; bond: U128; escrow_required: U128 }
export interface SellQuoteView { valuation: U128; bond: U128 }

export interface TokenView { token_id: string; owner_id?: AccountId | null }

/** NEP-145 storage balance of an account in the engine. */
export interface StorageBalanceView {
  total: U128;
  available: U128;
}
export interface StorageBalanceBoundsView {
  min: U128;
  max?: U128 | null;
}
export interface StorageBalance {
  total: bigint;
  available: bigint;
}

/** Payload of one engine event, keyed by the NEP-297 `event` name (`snake_case`). */
export interface RoseEventData {
  class_created: { class_id: ClassId };
  position_registered: { position_id: U64; class_id: ClassId; depositor: AccountId; allocation: U128 };
  position_released: { position_id: U64; class_id: ClassId; account: AccountId };
  units_minted: { class_id: ClassId; account: AccountId; units: U128 };
  units_burned: { class_id: ClassId; account: AccountId; units: U128 };
  units_transferred: { class_id: ClassId; from: AccountId; to: AccountId; units: U128 };
  cash_deposited: { account: AccountId; venue: Venue; amount: U128 };
  cash_withdrawn: { account: AccountId; venue: Venue; amount: U128 };
  cash_withdrawal_failed: { account: AccountId; venue: Venue; amount: U128 };
  round_created: {
    round_id: U64;
    kind: RoundKind;
    class_id: ClassId;
    venue: Venue;
    creator: AccountId;
    opens_at: U64;
    closes_at: U64;
    max_price: U128;
  };
  bid_placed: { round_id: U64; bid_id: number; bidder: AccountId; side: Side; escrow: U128; locked_units: U128; bond: U128 };
  round_cancelled: { round_id: U64; reason: CancelReason };
  key_requested: { round_id: U64 };
  key_request_failed: { round_id: U64 };
  key_ignored: { round_id: U64 };
  clearing_failed: { round_id: U64; error: string };
  storage_deposited: { account: AccountId; amount: U128; total: U128 };
  storage_withdrawn: { account: AccountId; amount: U128 };
  storage_unregistered: { account: AccountId; refund: U128 };
  key_received: { round_id: U64; source: KeySource; key: string };
  bid_opened: { round_id: U64; bid_id: number; quantity: U128; price: U128; void?: VoidReason | null };
  round_cleared: { round_id: U64; price: U128; volume: U128; notional: U128; fee: U128; remaining_lock_secs: U64 };
  bid_settled: {
    round_id: U64;
    bid_id: number;
    bidder: AccountId;
    fill_quantity: U128;
    cash: U128;
    refund: U128;
    bond_refunded: boolean;
  };
  lien_created: { lien_id: U64; round_id: U64; class_id: ClassId; holder: AccountId; units: U128; claim_total: U128 };
  lien_released: { lien_id: U64; holder: AccountId; units: U128 };
  claimable_taken: { class_id: ClassId; source: string; amount: U128 };
  /** Unit variant: the engine serializes it without `data`; parsing fills an empty object. */
  bootstrap_requested: Record<string, never>;
  bootstrapped: { vault_base: string; vault_sol: string; gas_sol: string };
  /** Unit variant, as `bootstrap_requested`. */
  bootstrap_failed: Record<string, never>;
  deposit_verification_requested: { key: ReplayKey };
  deposit_verification_failed: { key: ReplayKey };
  deposit_mismatch: { key: ReplayKey };
  deposit_refused: { key: ReplayKey; reason: string };
  deposit_registered: { key: ReplayKey; chain: Chain; position_id: U64; class_id: ClassId; account: AccountId; units: U128; checkpoint: U128 };
  base_cash_registered: { key: ReplayKey; account: AccountId; token: string; amount: U128; round_id: U64; accepted: boolean };
  sol_deposit_attributed: { metadata: string; account: AccountId; class_id: ClassId; deposit_address: string };
  payout_requested: { payout_id: U64; chain: Chain; requester: AccountId };
  payout_signed: { payout_id: U64 };
  payout_awaiting_gas_signature: { payout_id: U64 };
  payout_failed: { payout_id: U64; reason: string };
  payout_landed: { payout_id: U64 };
  payout_cancelling: { payout_id: U64 };
  sol_stream_swept: { position_id: U64; class_id: ClassId; amount: U64 };
  position_release_requested: { position_id: U64; payout_id: U64; account: AccountId };
}

export type RoseEventName = keyof RoseEventData;

/** `{"event": "<name>", "data": {...}}`, the serialization of `RoseEvent`. */
export type RoseEventView = { [K in RoseEventName]: { event: K; data: RoseEventData[K] } }[RoseEventName];

/** One entry of the on-chain history (`get_events`): the event flattened with its context. */
export type StoredEventView = { seq: U64; block_height: U64; timestamp: U64; predecessor: AccountId } & RoseEventView;

export interface EventsPageView { events: StoredEventView[]; total: U64; oldest: U64 }

/** Parsed types: the same shapes with `bigint` for every `U128` and `U64`. */

export interface Stats { roundsTotal: number; roundsSettled: number; volumeSettledUsdc: bigint; classes: number; positions: number }

export interface Limits {
  bidStorageDeposit: bigint;
  roundStorageDeposit: bigint;
  bondFloor: bigint;
  feeBps: number;
  maxBidsPerRound: number;
  maxDistributionReceivers: number;
  /** Bounds of a round's key timeout and reveal window, and the longest time from creation to `closesAt`, nanoseconds. */
  minKeyTimeout: bigint;
  maxKeyTimeout: bigint;
  minRevealWindow: bigint;
  maxRevealWindow: bigint;
  maxRoundHorizon: bigint;
}

export interface Holding {
  classId: ClassId;
  balance: bigint;
  lockedInRounds: bigint;
  encumbered: bigint;
  claimable: bigint;
  checkpoint: bigint;
}

export interface Cash { venue: Venue; amount: bigint }

export interface Round {
  roundId: bigint;
  kind: RoundKind;
  classId: ClassId;
  venue: Venue;
  creator: AccountId;
  status: RoundStatus;
  appId: string;
  opensAt: bigint;
  closesAt: bigint;
  keyTimeout: bigint;
  revealWindow: bigint;
  maxPrice: bigint;
  fTs: bigint;
  remainingLockSecs: bigint;
  bidCount: number;
  openedCount: number;
  settledCount: number;
  createdAt: bigint;
  budget: bigint | null;
  issuerEscrow: bigint | null;
  referencePrice: bigint | null;
  /** Largest quantity a buy order may name (see `RoundView.max_buy_quantity`); `parseRound` always sets it. */
  maxBuyQuantity?: bigint | null;
  /** Foreign address a Tender's retired lot pays to. */
  retireTo: string | null;
  advanceUnits: bigint | null;
  advanceClaim: bigint | null;
  advanceMinFill: bigint | null;
  lienId: bigint | null;
  closeRequestedAt: bigint | null;
  key: string | null;
  keySource: KeySource | null;
  keyReceivedAt: bigint | null;
  revealEndsAt: bigint | null;
  endedAt: bigint | null;
  cancelReason: CancelReason | null;
  result: RoundResult | null;
}

export interface BidOutcome {
  bidId: number;
  bidder: AccountId;
  side: Side;
  escrow: bigint;
  lockedUnits: bigint;
  bond: bigint;
  fee: bigint;
  cash: bigint;
  fillQuantity: bigint;
  settled: boolean;
  opened: { quantity: bigint; price: bigint } | null;
  void: VoidReason | null;
}

export interface RoundResult {
  price: bigint;
  volume: bigint;
  notional: bigint;
  fee: bigint;
  issuerCharged: bigint;
  issuerRefund: bigint;
  remainingLockSecs: bigint;
  fills: BidOutcome[];
}

export interface Bid {
  roundId: bigint;
  bidId: number;
  bidder: AccountId;
  side: Side;
  status: BidStatus;
  escrow: bigint;
  lockedUnits: bigint;
  bond: bigint;
  fee: bigint;
  cash: bigint;
  fillQuantity: bigint;
  ciphertextHex: string | null;
  placedAt: bigint | null;
  opened: { quantity: bigint; price: bigint } | null;
  void: VoidReason | null;
}

export type ClassSchedule =
  | {
      kind: "Linear";
      start: bigint;
      cliff: bigint;
      end: bigint;
      granularity: bigint;
      total: bigint;
      startUnlock: bigint;
      cliffUnlock: bigint;
      minDeposit: bigint;
    }
  | { kind: "Stepped"; start: bigint; end: bigint; period: bigint; amountPerPeriod: bigint; cliffAmount: bigint; total: bigint };

export interface ClassInfo {
  classId: ClassId;
  chain: Chain;
  token: string;
  tokenRisk: string;
  decimals: number;
  schedule: ClassSchedule;
  totalUnits: bigint;
  positions: number;
  createdAt: bigint;
  fractionNow: bigint;
}

export type PositionSource = { kind: "BaseStream"; lockup: string; streamId: bigint } | { kind: "SolanaStream"; metadata: string };

export interface Position {
  positionId: bigint;
  classId: ClassId;
  source: PositionSource;
  allocation: bigint;
  depositor: AccountId;
  depositedAt: bigint;
  state: PositionState;
}

export interface Lien {
  lienId: bigint;
  roundId: bigint;
  classId: ClassId;
  holder: AccountId;
  units: bigint;
  claimTotal: bigint;
  delivered: bigint;
  pendingExcess: bigint;
  createdAt: bigint;
  released: boolean;
}

export interface LienShare { lienId: bigint; classId: ClassId; funder: AccountId; claim: bigint; claimed: bigint; claimable: bigint }

export interface Portfolio { holdings: Holding[]; bids: Bid[]; liensHeld: Lien[]; lienShares: LienShare[]; cash: Cash[] }

export interface RetiredLot { roundId: bigint; classId: ClassId; retireTo: string; units: bigint; claimable: bigint }

export interface PricePoint { roundId: number; kind: RoundKind; price: bigint; volume: bigint; remainingLockSecs: bigint; settledAt: bigint }

export interface PriceHistoryPage { points: PricePoint[]; total: number }

export interface RoundsPage { rounds: Round[]; next: bigint | null }

export interface BuyQuote { charge: bigint; fee: bigint; bond: bigint; escrowRequired: bigint }
export interface SellQuote { valuation: bigint; bond: bigint }

export interface StoredEvent { seq: bigint; blockHeight: bigint; timestamp: bigint; predecessor: AccountId; event: RoseEventView }

export interface EventsPage { events: StoredEvent[]; total: bigint; oldest: bigint }

/* Custody (`contracts/engine/src/custody`): deposits, payouts and redeems. */

export type ClaimSourceArgs = { Holding: { class_id: ClassId } } | { Retired: { round_id: U64 } } | { LienShare: { lien_id: U64 } };

/**
 * The accounts a Solana payout or redeem is built on (`claim_sol_tokens`, `redeem`), proven in
 * one ForeignTx request before signing: the durable nonce account (`data`, its 80 raw bytes as
 * hex, authority = vault), the receipt nonce account the transaction advances last
 * (`receipt_data`, same rules, another account) and the recipient's existing associated token
 * account for the mint (`recipient_tokens_data`, its 165 bytes as hex), all read at `finalized`
 * right before the call. Both nonce accounts must be `createWithSeed(base, seed, SystemProgram)`
 * with a seed starting with the caller's `nonce_seed_prefix_of` (`payoutNonceSeed`): they serve
 * only that NEAR account, and stay reserved to the action until it is confirmed.
 */
export interface SolNonceProof {
  account: string;
  /** Base58 key both nonce accounts were created from with their seeds (it signed the creations). */
  base: string;
  /** The caller's 24-character prefix, then at most 8 characters. */
  seed: string;
  /** Seed of the receipt nonce account (same base, same rule, another account than `seed`). */
  receipt_seed: string;
  anchor_tx: string;
  data: string;
  receipt_data: string;
  recipient_tokens_data: string;
}

/** One stream a Solana payout draws on (`claim_sol_tokens`): at most what `get_sol_streams` reports as withdrawable. */
export interface SolDrawArgs {
  position_id: U64;
  amount: U128;
}

export type ReplayKey = { BaseLog: { tx_hash: string; log_index: number } } | { SolStream: { metadata: string } } | { SolNonce: { account: string; value: string } };
export type ReplayStateView = { Pending: { since_block: number } } | "Consumed";

export type PayoutKindView =
  | { BaseTransfer: { token: string; to: string; amount: U128 } }
  /** `vested_to_recipient`: `false` for a redeem (vested tokens to the vault), `true` for the return of a refused stream (vested tokens to `to`); pass it to `executeRelease`. */
  | { BaseRelease: { lockup: string; stream_id: number; to: string; vested_to_recipient: boolean } }
  | { SolTransfer: { mint: string; to_owner: string; amount: U128 } }
  | { SolRelease: { metadata: string; to_owner: string } }
  | { SolMove: { metadata: string; from: string; to_owner: string } }
  | { SolReturn: { metadata: string; from: string; to_owner: string } };

/** `Signed` Solana payouts and redeems become `Landed` or `Failed` once confirmed (`confirm_sol_payout`, `confirm_sol_redeem`). */
export type PayoutStatusView = "Requested" | "Signed" | "AwaitingGasSignature" | "Landed" | { Failed: { reason: string } };

export interface BaseSignatureView {
  r: string;
  s: string;
  v: number;
}

/** A Streamflow `withdraw` inside a payout; `expected_withdrawn` is the stream's `amount_withdrawn` once it executed. */
export interface SolDrawView { position_id: U64; amount: U128; expected_withdrawn: U128 }

/** Bytes are base64. */
export interface SolTransactionView {
  message: string;
  draws: SolDrawView[];
  /** What the payout takes from its class's swept balance (`U64`, 0 for other actions). */
  swept: U64;
  /** Receipt nonce account the message advances last (durable-nonce actions). */
  receipt_account?: string | null;
  authority_path: string;
  /** Address (base58) the authority signature verifies against. */
  authority: string;
  nonce_account?: string | null;
  nonce_value?: string | null;
  authority_signature?: string | null;
  gas_signature?: string | null;
  /** The message only advances the nonce: the action is being cancelled after its authority signature failed. */
  cancel: boolean;
  /** Block at which the first proof that the transaction did not execute was answered (a second one requested at least 150 blocks later settles it). */
  not_executed_seen_at?: U64 | null;
  /** Wire transaction (`[2] || sig(gas) || sig(authority) || message`), once both signatures exist. */
  transaction?: string | null;
}

export interface PayoutView {
  id: U64;
  chain: Chain;
  kind: PayoutKindView;
  debit: unknown;
  requester: AccountId;
  position_id?: U64 | null;
  status: PayoutStatusView;
  digest?: string | null;
  base?: BaseSignatureView | null;
  solana?: SolTransactionView | null;
  created_at: U64;
  updated_at: U64;
  /** Block of the latest proof or signature request (`retry_base_signature` and `retry_sol_payout` wait 600 blocks past it). */
  requested_block: U64;
  /** Signature requests issued. A signature request never refunds a payout: only a failed proof (nothing signed) or a confirmed non-execution does. */
  sign_requests: number;
}

export type RefusedAssetView = { BaseStream: { lockup: string; stream_id: number } } | { SolStream: { metadata: string; held_by: string; held_by_path: string } };

export interface RefusedDepositView {
  chain: Chain;
  asset: RefusedAssetView;
  near_account: AccountId;
  return_to: string;
  reason: string;
  refused_at: U64;
  return_payout?: U64 | null;
}

export type SolDepositStageView = "Attributed" | { MoveSigned: { payout_id: U64 } } | { Registered: { position_id: U64 } } | "Refused";

export interface SolDepositView {
  metadata: string;
  account: AccountId;
  class_id: ClassId;
  path: string;
  deposit_address: string;
  mint: string;
  decimals: number;
  return_to: string;
  stage: SolDepositStageView;
  attributed_at: U64;
}

export interface SolStreamInfoView {
  metadata: string;
  mint: string;
  escrow_tokens: string;
  streamflow_treasury_tokens: string;
  partner: string;
  partner_tokens: string;
  start_time: number;
  end_time: number;
  /** Token amounts are `u64` base units as JSON strings (`U64`): a Solana allocation easily exceeds 2^53. */
  net_amount_deposited: U64;
  period: number;
  amount_per_period: U64;
  cliff: number;
  cliff_amount: U64;
  /** Withdrawals proven on chain: landed payouts and what `sync_sol_stream` booked. */
  engine_withdrawn: U64;
  /** `amount_withdrawn` attested at registration. */
  registered_withdrawn: U64;
  /** Accrual checkpoint the position's units were minted from. */
  checkpoint: U128;
  /** The one unconfirmed payout drawing on the stream, if any. */
  drawing?: U64 | null;
  pending_withdraw: U64;
}

/** A Solana stream of a class with what a payout can draw from it now and the claimable a redeem of it takes now (`get_sol_streams`; 0 from five minutes before the stream's end). */
export interface SolStreamStateView {
  position_id: U64;
  withdrawable: U128;
  redeem_claimable: U128;
  stream: SolStreamInfoView;
}

/**
 * Tokens of a Solana class Streamflow's auto-claim moved into the vault's token account and
 * `sync_sol_stream` booked (`get_sol_swept`): a payout may take `balance - pending` with
 * `claimSolTokens(..., swept)`.
 */
export interface SolSweptView {
  balance: U64;
  pending: U64;
}

export interface SablierScheduleArgs {
  start: number;
  cliff: number;
  end: number;
  granularity: number;
  deposited: U128;
  start_unlock: U128;
  cliff_unlock: U128;
}

/** Schedule of `compute_sol_class_id`: token amounts as `U64` strings (base units). */
export interface StreamflowScheduleArgs {
  start_time: number;
  end_time: number;
  net_amount_deposited: U64;
  period: number;
  amount_per_period: U64;
  cliff: number;
  cliff_amount: U64;
}

export interface SolDepositArgs {
  metadata: string;
  class_id: ClassId;
  return_to: string;
  anchor_tx: string;
  /** 1,104 metadata bytes as hex, read at `finalized` right before the call. */
  metadata_data: string;
  /** 82 mint account bytes as hex. */
  mint_data: string;
}
