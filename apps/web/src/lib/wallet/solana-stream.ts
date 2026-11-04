/**
 * "Create a demo Streamflow position" on Solana devnet: a non-cancelable, transferable stream of
 * the demo token from the connected wallet to itself, built with the Streamflow js-sdk (loaded
 * lazily: it is only needed here and in the deposit wizard).
 */

import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import type { SolanaSigner } from "@/components/wallet/WalletProvider";
import { deployed, SOLANA_DEVNET_RPC_URL } from "@/lib/deployment";
import { RoseActionError } from "@/lib/errors";
import { solanaConnection } from "./solana-demo";

/** Demo schedule: 6 decimals, 1,000 tokens over 30 days with a 7-day cliff releasing 10 %, hourly periods. */
const DEMO_AMOUNT = 1_000_000_000n;
const DEMO_CLIFF_AMOUNT = 100_000_000n;
const DEMO_PERIOD_SECONDS = 3_600;
const DEMO_PERIODS = 23 * 24;
const DEMO_CLIFF_SECONDS = 7 * 24 * 3_600;

export type DemoStreamResult = { txId: string; metadataId: string };

async function demoTokenBalance(owner: PublicKey, mint: PublicKey): Promise<bigint> {
  const accounts = await solanaConnection().getParsedTokenAccountsByOwner(owner, { mint });
  return accounts.value.reduce((sum, account) => {
    const amount = (account.account.data.parsed as { info?: { tokenAmount?: { amount?: string } } }).info?.tokenAmount?.amount;
    return sum + (amount ? BigInt(amount) : 0n);
  }, 0n);
}

export async function createSolanaDemoPosition(signer: SolanaSigner): Promise<DemoStreamResult> {
  const mintAddress = deployed("solanaDemoMint");
  if (!mintAddress) throw new RoseActionError("not_deployed", "Demo token not deployed", "The Solana demo token mint is not configured on this deployment yet.");
  const mint = new PublicKey(mintAddress);
  const balance = await demoTokenBalance(signer.publicKey, mint);
  if (balance < DEMO_AMOUNT) {
    throw new RoseActionError(
      "insufficient_balance",
      "No demo tokens",
      "This wallet holds fewer than 1,000 demo tokens on devnet. The seed script distributes them to the demo holders; the Base faucet is the self-serve path.",
    );
  }
  const { ICluster, SolanaStreamClient } = await import("@streamflow/stream");
  const client = new SolanaStreamClient(SOLANA_DEVNET_RPC_URL, ICluster.Devnet, "confirmed");
  type CreateSender = Parameters<typeof client.create>[1]["sender"];
  const now = Math.floor(Date.now() / 1000);
  const start = now + 120;
  const result = await client.create(
    {
      recipient: signer.publicKey.toBase58(),
      tokenId: mint.toBase58(),
      start,
      cliff: start + DEMO_CLIFF_SECONDS,
      amount: new BN(DEMO_AMOUNT.toString()),
      cliffAmount: new BN(DEMO_CLIFF_AMOUNT.toString()),
      amountPerPeriod: new BN(((DEMO_AMOUNT - DEMO_CLIFF_AMOUNT) / BigInt(DEMO_PERIODS)).toString()),
      period: DEMO_PERIOD_SECONDS,
      name: "rose demo position",
      cancelableBySender: false,
      cancelableByRecipient: false,
      transferableBySender: false,
      transferableByRecipient: true,
      canTopup: false,
      automaticWithdrawal: false,
      canPause: false,
      canUpdateRate: false,
    },
    /*
     * The js-sdk treats any sender without `secretKey` as a wallet adapter and only calls its
     * `publicKey` and `signTransaction`, which is exactly what `SolanaSigner` provides.
     */
    { sender: signer as unknown as CreateSender, isNative: false },
  );
  return { txId: result.txId, metadataId: result.metadataId };
}
