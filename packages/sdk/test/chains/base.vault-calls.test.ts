/**
 * Argument encoding of the RoseVault, TestUSDC, DemoStreamFaucet and Sablier helpers the seed and
 * live scripts rely on, with wallets and clients that record what they are asked to send or read.
 * The Transfer digest is a known answer read live from the deployed engine-s4 RoseVault.
 */

import { encodeEventTopics, hashTypedData, pad, type Address, type PublicClient, type TransactionReceipt } from "viem";
import { describe, expect, it } from "vitest";
import { demoStreamFaucetAbi, roseVaultAbi, testUsdcAbi } from "../../src/chains/base/abis.js";
import { SABLIER_LOCKUP_V4 } from "../../src/chains/base/client.js";
import { approveStream, calculateMinFeeWei, erc20Abi, type SignerClient } from "../../src/chains/base/sablier.js";
import {
  approveToken,
  cohortTotal,
  createStreams,
  DemoClass,
  decodePositionMinted,
  depositCash,
  executeTransfer,
  isAuthorizationUsed,
  lastMintAt,
  mintableAmount,
  mintDemoPosition,
  mintTestUsdc,
  tokenBalance,
  type CohortSchedule,
  type TransferAuthorization,
} from "../../src/chains/base/vault.js";

interface WriteRequest {
  address: Address;
  abi: unknown;
  functionName: string;
  args: unknown[];
  value?: bigint;
}

/** A wallet that records every `writeContract` request. */
function recordingWallet(): { wallet: SignerClient; writes: WriteRequest[] } {
  const writes: WriteRequest[] = [];
  const wallet = {
    writeContract: (request: WriteRequest) => {
      writes.push(request);
      return Promise.resolve("0x01");
    },
  } as unknown as SignerClient;
  return { wallet, writes };
}

/** A client whose `readContract` records the request and answers `value`. */
function recordingClient(value: unknown): { client: PublicClient; reads: WriteRequest[] } {
  const reads: WriteRequest[] = [];
  const client = {
    readContract: (request: WriteRequest) => {
      reads.push(request);
      return Promise.resolve(value);
    },
  } as unknown as PublicClient;
  return { client, reads };
}

const VAULT: Address = "0x14c7f1f870ccb5569a01399013ceeeffc465e243";
const TOKEN: Address = "0x1250554fdbd8e63a75ea9ed0021f2dcae55d3f4b";
const FAUCET: Address = "0xf7b1302c20faab06ad5121981b3e949da24fd98d";
const HOLDER: Address = "0x000000000000000000000000000000000000b0b0";
const schedule: CohortSchedule = { start: 1_778_201_663, cliff: 1_809_737_663, end: 1_872_809_663, granularity: 1, unitAmount: 4n, unitStartUnlock: 0n, unitCliffUnlock: 1n };

describe("RoseVault writes", () => {
  it("createStreams sends (token, schedule, allocations) to the vault and forwards the fee value", async () => {
    const { wallet, writes } = recordingWallet();
    const allocations = [
      { nearAccount: "halden-ventures.rose-app.testnet", amount: 400_000n * 10n ** 18n },
      { nearAccount: "tessaro-capital.rose-app.testnet", amount: 250_000n * 10n ** 18n },
    ];
    await createStreams(wallet, { vault: VAULT, token: TOKEN, schedule, allocations, value: 200_000_000_000_000n });
    await createStreams(wallet, { vault: VAULT, token: TOKEN, schedule, allocations });
    expect(writes[0]).toMatchObject({ address: VAULT, abi: roseVaultAbi, functionName: "createStreams", args: [TOKEN, schedule, allocations], value: 200_000_000_000_000n });
    expect(writes[1]?.value).toBe(0n);
    expect(cohortTotal(allocations)).toBe(650_000n * 10n ** 18n);
    expect(cohortTotal([])).toBe(0n);
  });

  it("depositCash sends (token, amount, nearAccount, roundId)", async () => {
    const { wallet, writes } = recordingWallet();
    await depositCash(wallet, { vault: VAULT, token: TOKEN, amount: 20_000_000n, nearAccount: "halden-ventures.rose-app.testnet", roundId: 3n });
    expect(writes[0]).toMatchObject({ address: VAULT, functionName: "depositCash", args: [TOKEN, 20_000_000n, "halden-ventures.rose-app.testnet", 3n] });
    expect(writes[0]?.value).toBeUndefined();
  });

  it("executeTransfer sends the authorization tuple, then v, r and s", async () => {
    const { wallet, writes } = recordingWallet();
    const authorization: TransferAuthorization = { token: TOKEN, to: HOLDER, amount: 1_460_000_000n, id: 12n };
    await executeTransfer(wallet, { vault: VAULT, authorization, v: 28, r: "0x0a", s: "0x0b" });
    expect(writes[0]).toMatchObject({ address: VAULT, abi: roseVaultAbi, functionName: "executeTransfer", args: [authorization, 28, "0x0a", "0x0b"] });
  });

  it("approveToken approves the spender for the amount on the token", async () => {
    const { wallet, writes } = recordingWallet();
    await approveToken(wallet, TOKEN, VAULT, 5n);
    expect(writes[0]).toMatchObject({ address: TOKEN, abi: erc20Abi, functionName: "approve", args: [VAULT, 5n] });
  });
});

describe("RoseVault Transfer digest", () => {
  it("matches the deployed vault's hashTransfer (known answer read live)", () => {
    const transferType = roseVaultAbi.find((item) => item.type === "function" && item.name === "hashTransfer");
    expect(transferType?.inputs[0]?.components.map((c) => c.name)).toEqual(["token", "to", "amount", "id"]);
    const digest = hashTypedData({
      domain: { name: "RoseVault", version: "1", chainId: 84532, verifyingContract: VAULT },
      types: { Transfer: [{ name: "token", type: "address" }, { name: "to", type: "address" }, { name: "amount", type: "uint256" }, { name: "id", type: "uint256" }] },
      primaryType: "Transfer",
      message: { token: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", to: HOLDER, amount: 12_345n, id: 7n },
    });
    expect(digest).toBe("0xe9dbe8f15bafc915d91ae21a03e5e125267a85d5d268d204ea42430e62817f73");
  });
});

describe("reads", () => {
  it("isAuthorizationUsed reads the replay bitmap of the vault", async () => {
    const { client, reads } = recordingClient(true);
    await expect(isAuthorizationUsed(client, VAULT, 9n)).resolves.toBe(true);
    expect(reads[0]).toMatchObject({ address: VAULT, abi: roseVaultAbi, functionName: "isAuthorizationUsed", args: [9n] });
  });

  it("lastMintAt reads (account, class) on the faucet", async () => {
    const { client, reads } = recordingClient(1_793_700_000n);
    await expect(lastMintAt(client, FAUCET, HOLDER, DemoClass.KOL)).resolves.toBe(1_793_700_000n);
    expect(reads[0]).toMatchObject({ address: FAUCET, abi: demoStreamFaucetAbi, functionName: "lastMintAt", args: [HOLDER, 1] });
  });


  it("calculateMinFeeWei reads the canonical Lockup unless another one is given", async () => {
    const { client, reads } = recordingClient(0n);
    await calculateMinFeeWei(client, 82n);
    await calculateMinFeeWei(client, 82n, FAUCET);
    expect(reads.map((r) => [r.address, r.functionName, r.args])).toEqual([
      [SABLIER_LOCKUP_V4, "calculateMinFeeWei", [82n]],
      [FAUCET, "calculateMinFeeWei", [82n]],
    ]);
  });

  it("mintableAmount and tokenBalance read the account", async () => {
    const { client, reads } = recordingClient(7n);
    await mintableAmount(client, TOKEN, HOLDER);
    await tokenBalance(client, TOKEN, HOLDER);
    expect(reads.map((r) => [r.abi, r.functionName, r.args])).toEqual([
      [testUsdcAbi, "mintableAmount", [HOLDER]],
      [erc20Abi, "balanceOf", [HOLDER]],
    ]);
  });
});

describe("demo writes", () => {
  it("approveStream approves the spender for one stream NFT on the Lockup", async () => {
    const { wallet, writes } = recordingWallet();
    await approveStream(wallet, 99n, VAULT);
    expect(writes[0]).toMatchObject({ address: SABLIER_LOCKUP_V4, functionName: "approve", args: [VAULT, 99n] });
  });

  it("mintTestUsdc and mintDemoPosition call the public mints", async () => {
    const { wallet, writes } = recordingWallet();
    await mintTestUsdc(wallet, TOKEN, 1_000_000_000n);
    await mintDemoPosition(wallet, FAUCET, DemoClass.KOL);
    expect(writes.map((w) => [w.address, w.functionName, w.args])).toEqual([
      [TOKEN, "mint", [1_000_000_000n]],
      [FAUCET, "mintPosition", [1]],
    ]);
  });
});

describe("decodePositionMinted", () => {
  const minted = {
    address: FAUCET,
    topics: encodeEventTopics({ abi: demoStreamFaucetAbi, eventName: "PositionMinted", args: { recipient: HOLDER, class: DemoClass.KOL, streamId: 99n } }),
    data: "0x",
  };
  const unrelated = {
    address: TOKEN,
    topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", pad(HOLDER), pad(FAUCET)],
    data: pad("0x01"),
  };

  it("returns the faucet's stream id past unrelated logs", () => {
    const receipt = { logs: [unrelated, minted] } as unknown as TransactionReceipt;
    expect(decodePositionMinted(receipt)).toEqual({ recipient: HOLDER, classIndex: DemoClass.KOL, streamId: 99n });
  });

  it("returns null without a PositionMinted log", () => {
    expect(decodePositionMinted({ logs: [unrelated] } as unknown as TransactionReceipt)).toBeNull();
  });
});
