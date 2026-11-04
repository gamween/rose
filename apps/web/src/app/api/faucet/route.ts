import { createFaucetHandler, createFaucetSenders, readFaucetConfig } from "@/lib/faucet";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const config = readFaucetConfig(process.env);
const handler = createFaucetHandler({ senders: createFaucetSenders(process.env, config), config });

/** Limits and per-chain availability of the demo faucet (no secrets). */
export function GET(): Response {
  return handler.GET();
}

/** Sends a little Base Sepolia ETH or Solana devnet SOL, or creates a funded NEAR testnet account. */
export function POST(request: Request): Promise<Response> {
  return handler.POST(request);
}
