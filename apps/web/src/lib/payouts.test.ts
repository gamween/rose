import { bytesToBase64, type PayoutView } from "@rose/sdk";
import { baseEncode } from "near-api-js";
import { describe, expect, it } from "vitest";
import { solPayoutSignature } from "./payouts";

function payoutWith(transaction: string | null): PayoutView {
  return {
    id: "4",
    chain: "Solana",
    kind: { SolTransfer: { mint: "m", to_owner: "o", amount: "1" } },
    debit: null,
    requester: "a.testnet",
    status: "Signed",
    created_at: "0",
    updated_at: "0",
    requested_block: "1",
    sign_requests: 1,
    solana: transaction === null ? null : { message: "", draws: [], authority_path: "vault/sol", authority: "v", cancel: false, transaction },
  };
}

describe("solPayoutSignature", () => {
  it("reads the transaction id (first signature) from the base64 wire bytes", () => {
    const gas = Uint8Array.from({ length: 64 }, (_, index) => index + 1);
    const wire = new Uint8Array([2, ...gas, ...new Uint8Array(64).fill(9), 1, 2, 3]);
    expect(solPayoutSignature(payoutWith(bytesToBase64(wire)))).toBe(baseEncode(gas));
  });

  it("is null before both signatures are stored", () => {
    expect(solPayoutSignature(payoutWith(null))).toBeNull();
  });
});
