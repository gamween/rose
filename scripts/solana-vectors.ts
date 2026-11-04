/**
 * Generator of the web3.js message vectors the engine's Solana message builder is tested against
 * (`contracts/engine/tests/vectors/foreign/solana_web3js_messages.json`, mirrored by
 * `packages/sdk/test/chains/fixtures/solana_messages.json`):
 *
 *   node scripts/solana-vectors.ts           # prints the vectors as JSON
 *   node scripts/solana-vectors.ts --check   # exits non-zero unless both committed files match
 *
 * Each message is built with @solana/web3.js `TransactionMessage.compileToLegacyMessage()` from the
 * instruction builders of @solana/spl-token and @streamflow/stream, so the engine's own encoder
 * (`LegacyMessage::compile`) is compared with independent code byte for byte. Inputs: the engine
 * vault and gas payer and Circle's devnet USDC mint as fixed addresses, the other accounts from
 * `Keypair.fromSeed` of a constant 32-byte seed, and a durable nonce value of 32 bytes 0x42.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import BN from "bn.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY, TransactionInstruction, TransactionMessage } from "@solana/web3.js";
import { STREAMFLOW_TREASURY_PUBLIC_KEY, transferStreamInstruction, withdrawStreamInstruction } from "@streamflow/stream";
import { ROOT } from "./lib/env.ts";

const STREAMFLOW_DEVNET_PROGRAM = new PublicKey("HqDGZjaVRXJ9MGRQEw7qDc2rAr6iH1n1kAQdCZaCMfMZ");
/** Streamflow's `withdraw` amount meaning "everything unlocked" (u64::MAX). */
const WITHDRAW_ALL = new BN("ffffffffffffffff", 16);
/** Rent-exempt minimum of an 80-byte nonce account, as read on devnet. */
const NONCE_RENT_LAMPORTS = 1_447_680;

const seeded = (byte: number): PublicKey => Keypair.fromSeed(new Uint8Array(32).fill(byte)).publicKey;

const keys = {
  vault: new PublicKey("ERKmrj6yveQaKExLsfuiJZW19MYnwFhUUwdLBPniG6GL"),
  gas: new PublicKey("CBx96X3pThHzNJYjfXBKjdKktZxVApRaiNS8Ej6G7Qwz"),
  nonce: seeded(1),
  dest: seeded(2),
  mint: new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"),
  nonceValue: new PublicKey(new Uint8Array(32).fill(0x42)),
  metadata: seeded(3),
  escrowTokens: seeded(4),
  partner: seeded(5),
};

/** The Streamflow SDK bundles its own web3.js: rebuild its instructions with this copy's classes. */
function local(instruction: { keys: { pubkey: { toBase58(): string }; isSigner: boolean; isWritable: boolean }[]; programId: { toBase58(): string }; data: Uint8Array }): TransactionInstruction {
  return new TransactionInstruction({
    keys: instruction.keys.map((k) => ({ pubkey: new PublicKey(k.pubkey.toBase58()), isSigner: k.isSigner, isWritable: k.isWritable })),
    programId: new PublicKey(instruction.programId.toBase58()),
    data: Buffer.from(instruction.data),
  });
}

const ata = (owner: PublicKey): PublicKey => getAssociatedTokenAddressSync(keys.mint, owner, true);

async function messages(): Promise<Record<string, string>> {
  const { vault, gas, nonce, dest, mint, metadata, escrowTokens, partner } = keys;
  const vaultAta = ata(vault);
  const destAta = ata(dest);
  const advance = SystemProgram.nonceAdvance({ noncePubkey: nonce, authorizedPubkey: vault });
  const splTransfer = createTransferCheckedInstruction(vaultAta, mint, destAta, vault, 2_500_000n, 6);
  const withdraw = local(
    await withdrawStreamInstruction(WITHDRAW_ALL, STREAMFLOW_DEVNET_PROGRAM, {
      authority: vault,
      recipient: vault,
      recipientTokens: vaultAta,
      metadata,
      escrowTokens,
      streamflowTreasury: STREAMFLOW_TREASURY_PUBLIC_KEY,
      streamflowTreasuryTokens: ata(new PublicKey(STREAMFLOW_TREASURY_PUBLIC_KEY.toBase58())),
      partner,
      partnerTokens: ata(partner),
      mint,
      tokenProgram: TOKEN_PROGRAM_ID,
    }),
  );
  const transferRecipient = local(
    await transferStreamInstruction(STREAMFLOW_DEVNET_PROGRAM, {
      authority: dest,
      newRecipient: vault,
      newRecipientTokens: vaultAta,
      metadata,
      mint,
      rent: SYSVAR_RENT_PUBKEY,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    }),
  );
  const createNonce = SystemProgram.createNonceAccount({ fromPubkey: gas, noncePubkey: nonce, authorizedPubkey: vault, lamports: NONCE_RENT_LAMPORTS }).instructions;
  const cases: Record<string, TransactionInstruction[]> = {
    nonce_sol_transfer: [advance, SystemProgram.transfer({ fromPubkey: vault, toPubkey: dest, lamports: 1_000_000 })],
    nonce_spl_transfer: [advance, splTransfer],
    nonce_streamflow_withdraw_then_spl: [advance, withdraw, splTransfer],
    nonce_ata_then_transfer_recipient: [advance, createAssociatedTokenAccountIdempotentInstruction(gas, vaultAta, vault, mint), transferRecipient],
    create_nonce_account: createNonce,
  };
  const out: Record<string, string> = {};
  for (const [name, instructions] of Object.entries(cases)) {
    const message = new TransactionMessage({ payerKey: gas, recentBlockhash: keys.nonceValue.toBase58(), instructions }).compileToLegacyMessage();
    out[name] = Buffer.from(message.serialize()).toString("hex");
  }
  return out;
}

function versionOf(pkg: string): string {
  return (JSON.parse(readFileSync(join(ROOT, "scripts", "node_modules", pkg, "package.json"), "utf8")) as { version: string }).version;
}

const vectors = {
  generator: `scripts/solana-vectors.ts (@solana/web3.js ${versionOf("@solana/web3.js")}, @solana/spl-token ${versionOf("@solana/spl-token")}, @streamflow/stream ${versionOf("@streamflow/stream")})`,
  keys: Object.fromEntries(Object.entries(keys).map(([name, key]) => [name, key.toBase58()])),
  ata: { owner: keys.vault.toBase58(), mint: keys.mint.toBase58(), address: ata(keys.vault).toBase58() },
  messages: await messages(),
};

const COMMITTED = ["contracts/engine/tests/vectors/foreign/solana_web3js_messages.json", "packages/sdk/test/chains/fixtures/solana_messages.json"];

if (process.argv.includes("--check")) {
  let failed = false;
  for (const path of COMMITTED) {
    const committed = JSON.parse(readFileSync(join(ROOT, path), "utf8")) as Partial<typeof vectors>;
    for (const field of ["keys", "ata", "messages"] as const) {
      const expected = committed[field] as Record<string, string> | undefined;
      for (const [name, value] of Object.entries(expected ?? {})) {
        const actual = (vectors[field] as Record<string, string>)[name];
        if (actual !== value) {
          failed = true;
          process.stderr.write(`${path}: ${field}.${name} differs\n  committed ${value}\n  generated ${actual ?? "(missing)"}\n`);
        }
      }
    }
    process.stderr.write(`${path}: ${failed ? "MISMATCH" : `${String(Object.keys(committed.messages ?? {}).length)} messages identical`}\n`);
  }
  process.exitCode = failed ? 1 : 0;
} else {
  process.stdout.write(`${JSON.stringify(vectors, null, 2)}\n`);
}
