/**
 * View payloads shaped exactly like the engine ABI (`rose_engine_abi.json`); `abi.test.ts`
 * checks their keys against the schema definitions when the ABI file is present.
 */

import type { ClassView, EventsPageView, PortfolioView, RoundView, StatsView } from "../../src/engine/types.js";

export const CLASS_ID = "4e7a9d2c1b8f3e6a5d4c3b2a1f0e9d8c7b6a5f4e3d2c1b0a9f8e7d6c5b4a3f2e";

export const statsView: StatsView = { rounds_total: 3, rounds_settled: 2, volume_settled_usdc: "125000000000", classes: 3, positions: 6 };

export const classView: ClassView = {
  class_id: CLASS_ID,
  chain: "Base",
  token: "0x17e75069dd837eda977abedf7a455adda42868a9",
  token_risk: "The engine cannot verify the token contract: check it before bidding.",
  decimals: 18,
  schedule: {
    Linear: {
      start: "1793750000",
      cliff: "1796342000",
      end: "1825286000",
      granularity: "1",
      total: "1000000000000000000000000",
      start_unlock: "0",
      cliff_unlock: "100000000000000000000000",
      min_deposit: "1000000000000000000",
    },
  },
  total_units: "600000000000000000000000",
  positions: 6,
  created_at: "1793760000000000000",
  fraction_now: "123456789012345678",
};

export const roundView: RoundView = {
  round_id: "7",
  kind: "Tender",
  class_id: CLASS_ID,
  venue: { Base: { token: "0xf8f5a4c21d80993fa2fc9fe649f95384ab6dec57" } },
  creator: "cindral.testnet",
  status: "Settled",
  app_id: "9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1f0e9d8c7b6a5f4e3d2c1b0a9f8e",
  opens_at: "1793760000000000000",
  closes_at: "1793763600000000000",
  key_timeout: "3600000000000",
  reveal_window: "600000000000",
  max_price: "12000000",
  f_ts: "250000000000000000",
  remaining_lock_secs: "31000000",
  bid_count: 4,
  opened_count: 4,
  settled_count: 4,
  created_at: "1793759000000000000",
  budget: "950000000",
  issuer_escrow: "953000000",
  reference_price: "15000000",
  retire_to: "treasury.cindral.testnet",
  advance_units: null,
  advance_claim: null,
  advance_min_fill: null,
  lien_id: null,
  close_requested_at: "1793763601000000000",
  key: "bls12381g1:2cZ6v6Mv7fXnQJ7ZQZ4V3kW8Z8L5P9b1xY3n4d5e6f7g8h9i0j1k2l3m4n5o6p7q8",
  key_source: "Callback",
  key_received_at: "1793763605000000000",
  reveal_ends_at: "1793764205000000000",
  ended_at: "1793764300000000000",
  cancel_reason: null,
  result: {
    price: "9000000",
    volume: "100000000000000000000",
    notional: "900000000",
    fee: "3000000",
    issuer_charged: "900000000",
    issuer_refund: "50000000",
    remaining_lock_secs: "31000000",
    fills: [
      {
        bid_id: 0,
        bidder: "halden.testnet",
        side: "Sell",
        escrow: "0",
        locked_units: "100000000000000000000",
        bond: "1000000",
        fee: "0",
        cash: "900000000",
        fill_quantity: "100000000000000000000",
        settled: true,
        opened: { quantity: "100000000000000000000", price: "9000000" },
        void: null,
      },
      {
        bid_id: 1,
        bidder: "tessaro.testnet",
        side: "Sell",
        escrow: "0",
        locked_units: "50000000000000000000",
        bond: "1000000",
        fee: "0",
        cash: "0",
        fill_quantity: "0",
        settled: true,
        opened: null,
        void: "Unopened",
      },
    ],
  },
};

export const portfolioView: PortfolioView = {
  holdings: [{ class_id: CLASS_ID, balance: "100000000000000000000", locked_in_rounds: "0", encumbered: "0", claimable: "12500000000000000000", checkpoint: "250000000000000000" }],
  bids: [
    {
      round_id: "7",
      bid_id: 0,
      bidder: "halden.testnet",
      side: "Sell",
      status: "Opened",
      escrow: "0",
      locked_units: "100000000000000000000",
      bond: "1000000",
      fee: "0",
      cash: "0",
      fill_quantity: "0",
      ciphertext_hex: "ab".repeat(192),
      placed_at: "1793761000000000000",
      opened: { quantity: "100000000000000000000", price: "9000000" },
      void: null,
    },
  ],
  liens_held: [
    {
      lien_id: "1",
      round_id: "9",
      class_id: CLASS_ID,
      holder: "teodor.testnet",
      units: "10000000000000000000",
      claim_total: "5000000000000000000",
      delivered: "1000000000000000000",
      pending_excess: "0",
      created_at: "1793770000000000000",
      released: false,
    },
  ],
  lien_shares: [{ lien_id: "1", class_id: CLASS_ID, funder: "varick.testnet", claim: "5000000000000000000", claimed: "1000000000000000000", claimable: "0" }],
  cash: [
    { venue: "Near", amount: "250000000" },
    { venue: { Base: { token: "0xf8f5a4c21d80993fa2fc9fe649f95384ab6dec57" } }, amount: "100000000" },
  ],
};

export const eventsPageView: EventsPageView = {
  events: [
    { seq: "40", block_height: "230000001", timestamp: "1793763601000000000", predecessor: "anyone.testnet", event: "key_requested", data: { round_id: "7" } },
    {
      seq: "41",
      block_height: "230000009",
      timestamp: "1793763605000000000",
      predecessor: "v1.signer-prod.testnet",
      event: "key_received",
      data: { round_id: "7", source: "Callback", key: "bls12381g1:2cZ6v6Mv7fXnQJ7ZQZ4V3kW8Z8L5P9b1xY3n4d5e6f7g8h9i0j1k2l3m4n5o6p7q8" },
    },
    {
      seq: "42",
      block_height: "230000400",
      timestamp: "1793764300000000000",
      predecessor: "anyone.testnet",
      event: "round_cleared",
      data: { round_id: "7", price: "9000000", volume: "100000000000000000000", notional: "900000000", fee: "3000000", remaining_lock_secs: "31000000" },
    },
  ],
  total: "43",
  oldest: "0",
};
