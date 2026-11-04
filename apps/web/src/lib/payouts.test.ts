import { bytesToBase64, type PayoutView, type SignerClient } from "@rose/sdk";
import { baseEncode } from "near-api-js";
import { describe, expect, it } from "vitest";
import { solPayoutSignature, submitBasePayout } from "./payouts";

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

describe("submitBasePayout", () => {
  function release(vestedToRecipient: boolean): PayoutView {
    return {
      id: "12",
      chain: "Base",
      kind: { BaseRelease: { lockup: "0xa65a1ecef02c2b9bdc604951c6a6d02335d4532e", stream_id: 94, to: "0x00000000000000000000000000000000000000b0", vested_to_recipient: vestedToRecipient } },
      debit: null,
      requester: "a.testnet",
      status: "Signed",
      created_at: "0",
      updated_at: "0",
      requested_block: "1",
      sign_requests: 1,
      base: { v: 27, r: "11".repeat(32), s: "22".repeat(32) },
    } as PayoutView;
  }

  it.each([true, false])("signs the Release with vestedToRecipient = %s, as the engine authorized it", async (vested) => {
    const sent: unknown[] = [];
    const wallet = { writeContract: (request: { functionName: string; args: unknown[] }) => (sent.push(request), Promise.resolve("0xabc")) } as unknown as SignerClient;
    await submitBasePayout(wallet, "0x1111111111111111111111111111111111111111", release(vested));
    expect(sent).toMatchObject([{ functionName: "executeRelease", args: [{ lockup: "0xa65a1ecef02c2b9bdc604951c6a6d02335d4532e", streamId: 94n, to: "0x00000000000000000000000000000000000000b0", vestedToRecipient: vested, id: 12n }, 27, `0x${"11".repeat(32)}`, `0x${"22".repeat(32)}`] }]);
  });
});
