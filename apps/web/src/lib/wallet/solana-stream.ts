/**
 * "Create a demo Streamflow position" on Solana devnet (spec 8.4): a non-cancelable, transferable
 * stream of the demo token from the connected wallet to itself, built with the Streamflow js-sdk
 * (loaded lazily: it is only needed here and in the deposit wizard). A wallet without the demo
 * tokens first receives them from `/api/faucet` (`solana-demo-token`), so a new visitor can do it.
 */

import { PublicKey, type Connection } from "@solana/web3.js";
import BN from "bn.js";
import type { SolanaSigner } from "@/components/wallet/WalletProvider";
import { deployed, SOLANA_DEVNET_RPC_URL } from "@/lib/deployment";
import { RoseActionError, type ActionErrorKind } from "@/lib/errors";
import { solanaTxUrl } from "@/lib/explorer";
import { solanaConnection } from "./solana-demo";

/** Demo schedule: 1,000 whole tokens over 30 days with a 7-day cliff releasing 10 %, hourly periods. */
export const DEMO_WHOLE_TOKENS = 1_000n;
const DEMO_CLIFF_PERCENT = 10n;
const DEMO_PERIOD_SECONDS = 3_600;
const DEMO_PERIODS = 23 * 24;
const DEMO_CLIFF_SECONDS = 7 * 24 * 3_600;
/**
 * SOL the creation needs from the wallet: the 1,104-byte metadata account and the escrow token
 * account rent (6,258,560 and 1,488,440 lamports measured on devnet, about 0.0063 and 0.0015 SOL)
 * plus fees, with a margin (docs/verification.md, "Rent of a Streamflow stream").
 */
export const DEMO_MIN_LAMPORTS = 12_000_000;
const TOKEN_WAIT_MS = 60_000;
const TOKEN_POLL_MS = 2_000;

export type DemoStreamResult = { txId: string; metadataId: string; faucetTx: string | null };

/** Explorer links of a created demo position: the faucet's token transfer (when there was one) and the stream creation. */
export function demoPositionLinks(result: DemoStreamResult): { href: string; label: string }[] {
  return [...(result.faucetTx ? [{ href: solanaTxUrl(result.faucetTx), label: "Demo tokens from the faucet" }] : []), { href: solanaTxUrl(result.txId), label: "Stream creation on Solana Explorer" }];
}

/** The amounts of the demo stream in base units of a mint with `decimals`. */
export function demoStreamAmounts(decimals: number): { amount: bigint; cliffAmount: bigint; amountPerPeriod: bigint } {
  const amount = DEMO_WHOLE_TOKENS * 10n ** BigInt(decimals);
  const cliffAmount = (amount * DEMO_CLIFF_PERCENT) / 100n;
  return { amount, cliffAmount, amountPerPeriod: (amount - cliffAmount) / BigInt(DEMO_PERIODS) };
}

/** Decimals of the demo mint, from its parsed account (the CINDR devnet mint has 9). */
async function mintDecimals(connection: Connection, mint: PublicKey): Promise<number> {
  const { value } = await connection.getParsedAccountInfo(mint, "confirmed");
  const decimals = value && "parsed" in value.data ? (value.data.parsed as { info?: { decimals?: number } }).info?.decimals : undefined;
  if (decimals === undefined) throw new RoseActionError("not_deployed", "Demo token not found", `The demo mint ${mint.toBase58()} is not readable on devnet.`);
  return decimals;
}

async function demoTokenBalance(connection: Connection, owner: PublicKey, mint: PublicKey): Promise<bigint> {
  const accounts = await connection.getParsedTokenAccountsByOwner(owner, { mint }, "confirmed");
  return accounts.value.reduce((sum, account) => {
    const amount = (account.account.data.parsed as { info?: { tokenAmount?: { amount?: string } } }).info?.tokenAmount?.amount;
    return sum + (amount ? BigInt(amount) : 0n);
  }, 0n);
}

type FaucetReply = { signature?: string; error?: string; message?: string };

const FAUCET_ERROR_KIND: Record<string, ActionErrorKind> = { rate_limited: "rate_limited", already_funded: "rate_limited", faucet_dry: "insufficient_balance", not_configured: "not_deployed", invalid_request: "contract", upstream: "rpc" };

/** Asks `/api/faucet` for the demo tokens (server-side hot wallet, the faucet's limits apply); returns the transfer signature. */
export async function requestDemoTokens(owner: PublicKey): Promise<string> {
  let response: Response;
  try {
    response = await fetch("/api/faucet", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chain: "solana-demo-token", address: owner.toBase58() }) });
  } catch {
    throw new RoseActionError("rpc", "Network error", "The faucet did not answer. Check your connection and retry.", true);
  }
  let reply: FaucetReply;
  try {
    reply = (await response.json()) as FaucetReply;
  } catch {
    throw new RoseActionError("rpc", "Faucet unavailable", `The faucet answered HTTP ${String(response.status)} without a result. Retry in a minute.`, true);
  }
  if (!response.ok || !reply.signature) {
    const kind = FAUCET_ERROR_KIND[reply.error ?? "upstream"] ?? "rpc";
    throw new RoseActionError(kind, kind === "rate_limited" ? "Demo tokens already sent" : "No demo tokens", reply.message ?? "The faucet could not send the demo tokens.", kind === "rpc");
  }
  return reply.signature;
}

/**
 * Creates the demo position from `signer`'s wallet: checks the SOL it needs, asks the faucet for
 * the 1,000 demo tokens when the wallet holds fewer, then creates the stream to itself.
 */
export async function createSolanaDemoPosition(signer: SolanaSigner, onProgress?: (text: string) => void): Promise<DemoStreamResult> {
  const mintAddress = deployed("solanaDemoMint");
  if (!mintAddress) throw new RoseActionError("not_deployed", "Demo token not deployed", "The Solana demo token mint is not configured on this deployment yet.");
  const mint = new PublicKey(mintAddress);
  const connection = solanaConnection();
  const [decimals, lamports, balance] = await Promise.all([mintDecimals(connection, mint), connection.getBalance(signer.publicKey, "confirmed"), demoTokenBalance(connection, signer.publicKey, mint)]);
  if (lamports < DEMO_MIN_LAMPORTS) {
    throw new RoseActionError("insufficient_balance", "Not enough SOL", "Creating the stream costs about 0.012 SOL of rent and fees. Use \"Send SOL\" in Get test funds first, then retry.", true);
  }
  const amounts = demoStreamAmounts(decimals);
  let faucetTx: string | null = null;
  if (balance < amounts.amount) {
    onProgress?.("Asking the faucet for 1,000 demo tokens…");
    faucetTx = await requestDemoTokens(signer.publicKey);
    const started = Date.now();
    while ((await demoTokenBalance(connection, signer.publicKey, mint)) < amounts.amount) {
      if (Date.now() - started > TOKEN_WAIT_MS) throw new RoseActionError("rpc", "Demo tokens not visible yet", "The faucet sent the demo tokens but the RPC does not show them yet; retry in a few seconds.", true);
      await new Promise((resolve) => setTimeout(resolve, TOKEN_POLL_MS));
    }
  }
  onProgress?.("Confirm the stream creation in your wallet…");
  const { ICluster, SolanaStreamClient } = await import("@streamflow/stream");
  const client = new SolanaStreamClient(SOLANA_DEVNET_RPC_URL, ICluster.Devnet, "confirmed");
  type CreateSender = Parameters<typeof client.create>[1]["sender"];
  const start = Math.floor(Date.now() / 1000) + 120;
  const result = await client.create(
    {
      recipient: signer.publicKey.toBase58(),
      tokenId: mint.toBase58(),
      start,
      cliff: start + DEMO_CLIFF_SECONDS,
      amount: new BN(amounts.amount.toString()),
      cliffAmount: new BN(amounts.cliffAmount.toString()),
      amountPerPeriod: new BN(amounts.amountPerPeriod.toString()),
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
     * `create` signs through @streamflow/common 13.4.0 `signTransaction`, which treats a sender
     * whose `signTransaction` is defined as a wallet adapter (`isSignerWallet`) and only asks it
     * for its `publicKey` and `signTransaction`: exactly what `SolanaSigner` provides.
     */
    { sender: signer as unknown as CreateSender, isNative: false },
  );
  return { txId: result.txId, metadataId: result.metadataId, faucetTx };
}
