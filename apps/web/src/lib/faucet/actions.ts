/**
 * The faucet's actions, one entry per `chain` value of the request body. The handler only knows
 * this table: adding an action is one request shape in `validate.ts`, one sender in `chains.ts`
 * and one entry here.
 */

import { NEAR_HELPER_FUNDING, type FaucetConfig, type FaucetSenders } from "./chains";
import type { SendCaps } from "./guards";
import type { FaucetChain, FaucetRequest } from "./validate";

export const NEAR_TX_URL = "https://testnet.near.rocks/tx/";
export const BASE_TX_URL = "https://sepolia.basescan.org/tx/";
export const SOLANA_TX_URL = "https://explorer.solana.com/tx/";

export type FaucetSuccess =
  | { chain: "base"; txHash: string; amount: string; explorerUrl: string }
  | { chain: "solana"; signature: string; amount: string; explorerUrl: string }
  | { chain: "near"; accountId: string; txHash: string; amount: string; explorerUrl: string };

export type FaucetActionInfo = { configured: boolean; amount: string; unit: string; caps: SendCaps };

export type FaucetAction<C extends FaucetChain> = {
  /** The network as people read it in messages ("Base Sepolia"). */
  label: string;
  configured: (config: FaucetConfig) => boolean;
  /** What `GET /api/faucet` publishes for the action: never a key value. */
  info: (config: FaucetConfig) => FaucetActionInfo;
  send: (senders: FaucetSenders, request: Extract<FaucetRequest, { chain: C }>) => Promise<FaucetSuccess>;
};

export const FAUCET_ACTIONS: { [C in FaucetChain]: FaucetAction<C> } = {
  base: {
    label: "Base Sepolia",
    configured: (config) => config.base.configured,
    info: (config) => ({ configured: config.base.configured, amount: config.base.amountWei.toString(), unit: "wei", caps: config.base.caps }),
    send: async (senders, request) => {
      const { txHash, amount } = await senders.sendBase(request.address);
      return { chain: "base", txHash, amount, explorerUrl: `${BASE_TX_URL}${txHash}` };
    },
  },
  solana: {
    label: "Solana devnet",
    configured: (config) => config.solana.configured,
    info: (config) => ({ configured: config.solana.configured, amount: config.solana.lamports.toString(), unit: "lamports", caps: config.solana.caps }),
    send: async (senders, request) => {
      const { signature, amount } = await senders.sendSolana(request.address);
      return { chain: "solana", signature, amount, explorerUrl: `${SOLANA_TX_URL}${signature}?cluster=devnet` };
    },
  },
  near: {
    label: "NEAR testnet",
    configured: (config) => config.near.configured,
    info: (config) => ({ configured: config.near.configured, amount: NEAR_HELPER_FUNDING, unit: "NEAR", caps: config.near.funderCaps }),
    send: async (senders, request) => {
      const { txHash, amount } = await senders.createNearAccount(request.accountId, request.publicKey);
      return { chain: "near", accountId: request.accountId, txHash, amount, explorerUrl: `${NEAR_TX_URL}${txHash}` };
    },
  },
};

/** The action of `request.chain`, typed for that request. */
export function actionFor<R extends FaucetRequest>(request: R): FaucetAction<R["chain"]> {
  return FAUCET_ACTIONS[request.chain] as FaucetAction<R["chain"]>;
}
