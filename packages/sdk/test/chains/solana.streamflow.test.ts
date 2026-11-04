import { readFileSync } from "node:fs";
import { Keypair, Message, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { must } from "./must.js";
import { stubConnection } from "./rpc.js";
import { solanaAddressUrl, solanaTxUrl, STREAMFLOW_DEVNET_PROGRAM, STREAMFLOW_TREASURY } from "../../src/chains/solana/client.js";
import {
  associatedTokenAddress,
  buildTransferRecipientTransaction,
  checkStreamflowEligibility,
  decodeStreamflowMetadata,
  listStreamflowStreamsForRecipient,
  readStreamflowStream,
  STREAMFLOW_TRANSFER_RECIPIENT_DISCRIMINATOR,
  transferRecipientInstruction,
} from "../../src/chains/solana/streamflow.js";

interface StreamFixture {
  pubkey: string;
  slot: number;
  owner: string;
  dataBase64: string;
}
interface MessagesFixture {
  keys: Record<string, string>;
  ata: { owner: string; mint: string; address: string };
  messages: Record<string, string>;
}

const fixture = JSON.parse(readFileSync(new URL("./fixtures/streamflow_J2Mx.json", import.meta.url), "utf8")) as StreamFixture;
const messages = JSON.parse(readFileSync(new URL("./fixtures/solana_messages.json", import.meta.url), "utf8")) as MessagesFixture;
const bytes = Uint8Array.from(Buffer.from(fixture.dataBase64, "base64"));

describe("decodeStreamflowMetadata", () => {
  it("decodes the spike stream created with distinctive values (scratchpad/findings/foreigntx.md section 6.2)", () => {
    const metadata = decodeStreamflowMetadata(bytes);
    expect(metadata.sender.toBase58()).toBe("6uMy1iYdq9EpL6W3EjsKdUZfrJ5G1shD1Da1QNe8gH7n");
    expect(metadata.recipient.toBase58()).toBe("2uhcVxvU947Yvp8rq1WChqqvkxrTeNZFR58MsS1t2d3w");
    expect(metadata.mint.toBase58()).toBe("3q81mxTA7rricmjJQaiZk9HbZzF2Pt8aN5SJaJcXvZ4w");
    expect(metadata.streamflowTreasury.equals(STREAMFLOW_TREASURY)).toBe(true);
    expect(metadata.startTime).toBe(1793754629n);
    expect(metadata.cliff).toBe(1793755229n);
    expect(metadata.netAmountDeposited).toBe(1234567890n);
    expect(metadata.cliffAmount).toBe(234567890n);
    expect(metadata.amountPerPeriod).toBe(10000000n);
    expect(metadata.period).toBe(77n);
    expect(metadata.endTime).toBe(1793755229n + 100n * 77n);
    expect(metadata.canceledAt).toBe(0n);
    expect(metadata.cancelableBySender).toBe(false);
    expect(metadata.cancelableByRecipient).toBe(true);
    expect(metadata.transferableBySender).toBe(false);
    expect(metadata.transferableByRecipient).toBe(true);
    expect(metadata.canTopup).toBe(true);
    expect(metadata.automaticWithdrawal).toBe(false);
    expect(metadata.pausable).toBe(false);
    expect(metadata.canUpdateRate).toBe(false);
    expect(metadata.closed).toBe(false);
  });

  it("refuses the wrong length and non-boolean flags", () => {
    expect(() => decodeStreamflowMetadata(bytes.subarray(1))).toThrow("Expected 1104 bytes");
    const corrupt = Uint8Array.from(bytes);
    corrupt[671] = 7;
    expect(() => decodeStreamflowMetadata(corrupt)).toThrow("Flag at offset 671");
  });
});

describe("checkStreamflowEligibility", () => {
  it("flags the spike stream's can_topup and accepts a locked-down stream", () => {
    const metadata = decodeStreamflowMetadata(bytes);
    expect(checkStreamflowEligibility(metadata)).toEqual({ eligible: false, reasons: ["can_topup"] });
    expect(checkStreamflowEligibility({ ...metadata, canTopup: false })).toEqual({ eligible: true, reasons: [] });
    const bad = { ...metadata, closed: true, canceledAt: 5n, cancelableBySender: true, transferableBySender: true, transferableByRecipient: false, pausable: true, canUpdateRate: true };
    expect(checkStreamflowEligibility(bad).reasons).toEqual([
      "closed",
      "canceled",
      "cancelable_by_sender",
      "transferable_by_sender",
      "not_transferable_by_recipient",
      "pausable",
      "can_update_rate",
      "can_topup",
    ]);
  });

  it("applies the engine's attribution rules: no automatic withdrawal, history, fee or imminent end", () => {
    const metadata = { ...decodeStreamflowMetadata(bytes), canTopup: false };
    const bad = { ...metadata, automaticWithdrawal: true, pauseCumulative: 1n, partnerFeePercentBits: 0x8000_0000 };
    expect(checkStreamflowEligibility(bad).reasons).toEqual(["automatic_withdrawal", "modified", "fees"]);
    expect(checkStreamflowEligibility(metadata, metadata.endTime - 3_600n).reasons).toEqual(["ends_too_soon"]);
    expect(checkStreamflowEligibility(metadata, metadata.endTime - 3_601n).reasons).toEqual([]);
  });
});

describe("transfer_recipient", () => {
  it("derives the associated token account like spl-token", () => {
    const ata = associatedTokenAddress(new PublicKey(messages.ata.owner), new PublicKey(messages.ata.mint));
    expect(ata.toBase58()).toBe(messages.ata.address);
  });

  it("matches the instruction of the engine's web3.js vector byte for byte", () => {
    const message = Message.from(Buffer.from(must(messages.messages["nonce_ata_then_transfer_recipient"]), "hex"));
    const compiled = must(
      message.compiledInstructions.find((ix) => Buffer.from(ix.data.subarray(0, 8)).equals(Buffer.from(STREAMFLOW_TRANSFER_RECIPIENT_DISCRIMINATOR))),
      "transfer_recipient instruction",
    );
    const keyAt = (index: number) => must(message.accountKeys[index]);
    expect(keyAt(compiled.programIdIndex).equals(STREAMFLOW_DEVNET_PROGRAM)).toBe(true);
    const accounts = compiled.accountKeyIndexes.map(keyAt);
    const authority = must(accounts[0]);
    const newRecipient = must(accounts[1]);
    const metadataPubkey = must(accounts[3]);
    const mint = must(accounts[4]);
    expect(newRecipient.toBase58()).toBe(messages.keys["vault"]);
    expect(metadataPubkey.toBase58()).toBe(messages.keys["metadata"]);
    expect(mint.toBase58()).toBe(messages.keys["mint"]);
    const instruction = transferRecipientInstruction({ metadataPubkey, authority, newRecipient, mint });
    expect(instruction.programId.equals(STREAMFLOW_DEVNET_PROGRAM)).toBe(true);
    expect(instruction.keys.map((key) => key.pubkey.toBase58())).toEqual(accounts.map((key) => key.toBase58()));
    expect(Buffer.from(instruction.data).equals(Buffer.from(compiled.data))).toBe(true);
    expect(instruction.data).toHaveLength(18);
    // Message-level signer flags are the union over the three instructions (the vault also signs
    // the nonce advance there), so only the authority's signer flag is instruction-specific.
    expect(instruction.keys.map((key) => key.isSigner)).toEqual([true, false, false, false, false, false, false, false, false]);
    instruction.keys.forEach((key, index) => {
      expect(key.isWritable).toBe(message.isAccountWritable(must(compiled.accountKeyIndexes[index])));
    });
  });

  it("builds a one-instruction transaction the holder signs", () => {
    const authority = Keypair.generate();
    const transaction = buildTransferRecipientTransaction({
      metadataPubkey: new PublicKey(must(messages.keys["metadata"])),
      authority: authority.publicKey,
      newRecipient: new PublicKey(must(messages.keys["vault"])),
      mint: new PublicKey(must(messages.keys["mint"])),
      blockhash: must(messages.keys["nonceValue"]),
      lastValidBlockHeight: 1,
    });
    expect(transaction.instructions).toHaveLength(1);
    expect(transaction.feePayer?.equals(authority.publicKey)).toBe(true);
    transaction.sign(authority);
    expect(transaction.verifySignatures()).toBe(true);
    expect(transaction.serialize().length).toBeLessThan(1232);
  });
});

describe("devnet reads", () => {
  it("reads a stream with its raw bytes and lists streams for a recipient through getProgramAccounts", async () => {
    const requests: { method: string; params: unknown[] }[] = [];
    const account = { data: [fixture.dataBase64, "base64"], executable: false, lamports: 1, owner: fixture.owner, rentEpoch: 0, space: 1104 };
    const connection = stubConnection(
      (method) => (method === "getAccountInfo" ? { context: { slot: fixture.slot }, value: account } : [{ pubkey: fixture.pubkey, account }]),
      (method, params) => requests.push({ method, params }),
    );
    const state = await readStreamflowStream(connection, new PublicKey(fixture.pubkey));
    expect(state.slot).toBe(fixture.slot);
    expect(state.owner.toBase58()).toBe(fixture.owner);
    expect(state.raw).toEqual(bytes);
    expect(state.metadata.period).toBe(77n);
    expect((must(requests[0]).params[1] as { commitment: string }).commitment).toBe("finalized");

    const listed = await listStreamflowStreamsForRecipient(connection, new PublicKey("2uhcVxvU947Yvp8rq1WChqqvkxrTeNZFR58MsS1t2d3w"));
    expect(listed.map((entry) => entry.metadataPubkey.toBase58())).toEqual([fixture.pubkey]);
    const gpa = must(requests[1]);
    expect(gpa.method).toBe("getProgramAccounts");
    expect(gpa.params[0]).toBe(STREAMFLOW_DEVNET_PROGRAM.toBase58());
    expect((gpa.params[1] as { filters: unknown[] }).filters).toEqual([
      { dataSize: 1104 },
      { memcmp: { offset: 113, bytes: "2uhcVxvU947Yvp8rq1WChqqvkxrTeNZFR58MsS1t2d3w", encoding: "base58" } },
    ]);
  });

  it("builds explorer links on the devnet cluster", () => {
    expect(solanaTxUrl("sig")).toBe("https://explorer.solana.com/tx/sig?cluster=devnet");
    expect(solanaAddressUrl(STREAMFLOW_TREASURY)).toBe("https://explorer.solana.com/address/5SEpbdjFK5FxwTvfsGMXVQTD2v4M2c5tyRTxhdsPkgDw?cluster=devnet");
  });
});
