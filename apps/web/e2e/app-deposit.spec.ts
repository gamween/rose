import { expect, test, type Page } from "@playwright/test";
import { demoStreamFaucetAbi, roseVaultAbi, sablierLockupAbi } from "../../../packages/sdk/src/chains/base/abis";
import { erc20Abi, sablierLockupExtrasAbi } from "../../../packages/sdk/src/chains/base/sablier";
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionResult, getAbiItem, multicall3Abi, type Abi, type Hex } from "viem";
import { MOCK, mockChains, type MockOverrides } from "./fixtures/engine-mock";

/**
 * The deposit wizard against mocked chains: a Base holder with three Sablier streams (one joins
 * the seed class, one creates a new class, one is cancelable) runs the whole spec 7.1 flow with
 * the demo wallets, and a Solana holder sees eligibility explanations and the deposit address
 * derived by the MPC. Nothing reaches a real network.
 */
test.describe("deposit wizard (mocked chains)", () => {
  test.skip(!process.env.NEXT_PUBLIC_ENGINE_ACCOUNT, "NEXT_PUBLIC_ENGINE_ACCOUNT is not set for this build");

  const SEED = "a".repeat(64);
  const NEW_CLASS = "d".repeat(64);
  const STRATEGIC = "c".repeat(64);
  const MULTICALL3 = "0xca11bde05977b3631167028862be2a173976ca11";
  const DEPOSIT_ADDRESS = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T";
  const NOW = 1_762_200_000;
  const DAY = 86_400;
  const DEPOSIT_TX = `0x${"7".repeat(64)}` as Hex;
  const BLOCK_HASH = `0x${"8".repeat(64)}` as Hex;
  const DEPOSIT_BLOCK = 38_990_000n;
  const lockupAbi = [...sablierLockupAbi, ...sablierLockupExtrasAbi] as Abi;

  type Stream = { id: bigint; cancelable: boolean; start: number; cliff: number; end: number; deposited: bigint; cliffUnlock: bigint };
  const streams: Stream[] = [
    { id: 100n, cancelable: false, start: NOW - 90 * DAY, cliff: NOW - 60 * DAY, end: NOW + 275 * DAY, deposited: 100n * 10n ** 18n, cliffUnlock: 10n * 10n ** 18n },
    { id: 99n, cancelable: true, start: NOW - 10 * DAY, cliff: NOW + 20 * DAY, end: NOW + 200 * DAY, deposited: 50n * 10n ** 18n, cliffUnlock: 0n },
    { id: 98n, cancelable: false, start: NOW - 5 * DAY, cliff: 0, end: NOW + 100 * DAY, deposited: 20n * 10n ** 18n, cliffUnlock: 0n },
  ];

  const state = { owner: "", nearAccount: "", blockNumber: 38_990_010n, replayPolls: 0, registered: false, deposited: false, registerSent: false };

  function hex(value: bigint | number): Hex {
    return `0x${BigInt(value).toString(16)}`;
  }

  function lockupResult(data: Hex): { success: boolean; returnData: Hex } {
    const { functionName, args } = decodeFunctionData({ abi: lockupAbi, data });
    const encode = (result: unknown) => ({ success: true, returnData: encodeFunctionResult({ abi: lockupAbi, functionName, result: result as never }) });
    if (functionName === "nextStreamId") return encode(101n);
    const id = (args as readonly [bigint])[0];
    const stream = streams.find((item) => item.id === id);
    if (!stream) return { success: false, returnData: "0x" };
    switch (functionName) {
      case "ownerOf":
        return encode(state.deposited && id === 100n ? MOCK.vault : state.owner);
      case "getUnderlyingToken":
        return encode(MOCK.demoToken);
      case "getDepositedAmount":
        return encode(stream.deposited);
      case "getWithdrawnAmount":
      case "getRefundedAmount":
      case "withdrawableAmountOf":
      case "calculateMinFeeWei":
        return encode(0n);
      case "getStartTime":
        return encode(BigInt(stream.start));
      case "getCliffTime":
        return encode(BigInt(stream.cliff));
      case "getEndTime":
        return encode(BigInt(stream.end));
      case "getGranularity":
        return encode(1n);
      case "getUnlockAmounts":
        return encode({ start: 0n, cliff: stream.cliffUnlock });
      case "isCancelable":
        return encode(stream.cancelable);
      case "isTransferable":
        return encode(true);
      case "wasCanceled":
      case "isDepleted":
        return encode(false);
      case "getLockupModel":
        return encode(0);
      case "getApproved":
        return encode(MOCK.vault);
      default:
        return { success: false, returnData: "0x" };
    }
  }

  function tokenResult(to: string, data: Hex): { success: boolean; returnData: Hex } {
    const { functionName } = decodeFunctionData({ abi: erc20Abi, data });
    const encode = (result: unknown) => ({ success: true, returnData: encodeFunctionResult({ abi: erc20Abi, functionName, result: result as never }) });
    if (functionName === "symbol") return encode(to.toLowerCase() === MOCK.demoToken ? "CINDR" : "tUSDC");
    if (functionName === "decimals") return encode(to.toLowerCase() === MOCK.demoToken ? 18 : 6);
    if (functionName === "balanceOf") return encode(0n);
    return { success: false, returnData: "0x" };
  }

  function call(to: string, data: Hex): { success: boolean; returnData: Hex } {
    const target = to.toLowerCase();
    if (target === MOCK.lockup) return lockupResult(data);
    if (target === MOCK.demoToken || target === MOCK.baseTusdc) return tokenResult(target, data);
    if (target === MOCK.vault) {
      const { functionName } = decodeFunctionData({ abi: roseVaultAbi, data });
      if (functionName === "depositStream") return { success: true, returnData: "0x" };
      if (functionName === "LOCKUP") return { success: true, returnData: encodeFunctionResult({ abi: roseVaultAbi, functionName, result: MOCK.lockup }) };
    }
    if (target === "0x5555555555555555555555555555555555555555") {
      const { functionName } = decodeFunctionData({ abi: demoStreamFaucetAbi, data });
      if (functionName === "mintPosition") return { success: true, returnData: "0x" };
    }
    return { success: false, returnData: "0x" };
  }

  function streamDepositedLog(stream: Stream, nearAccount: string) {
    const event = getAbiItem({ abi: roseVaultAbi, name: "StreamDeposited" });
    if (event.type !== "event") throw new Error("StreamDeposited is not an event");
    const topics = encodeEventTopics({ abi: roseVaultAbi, eventName: "StreamDeposited", args: { sender: state.owner as Hex, streamId: stream.id } });
    const data = encodeAbiParameters(
      event.inputs.filter((input) => !input.indexed),
      [nearAccount, MOCK.lockup, MOCK.demoToken, 18, stream.deposited, 0n, stream.start, stream.cliff, stream.end, 1, 0n, stream.cliffUnlock, false, true, NOW],
    );
    return { address: MOCK.vault, topics, data, blockNumber: hex(DEPOSIT_BLOCK), blockHash: BLOCK_HASH, transactionHash: DEPOSIT_TX, transactionIndex: "0x3", logIndex: "0x7", removed: false };
  }

  function block(number: bigint) {
    return { number: hex(number), hash: BLOCK_HASH, parentHash: BLOCK_HASH, timestamp: hex(NOW), baseFeePerGas: "0x3b9aca00", gasLimit: "0x1c9c380", gasUsed: "0x0", miner: MOCK.signer, nonce: "0x0000000000000000", transactions: [], logsBloom: `0x${"0".repeat(512)}`, difficulty: "0x0", extraData: "0x", size: "0x0", sha3Uncles: BLOCK_HASH, stateRoot: BLOCK_HASH, transactionsRoot: BLOCK_HASH, receiptsRoot: BLOCK_HASH, uncles: [], mixHash: BLOCK_HASH };
  }

  const baseRequest: MockOverrides["baseRequest"] = (method, params) => {
    switch (method) {
      case "eth_chainId":
        return "0x14a34";
      case "eth_blockNumber":
        state.blockNumber += 1n;
        return hex(state.blockNumber);
      case "eth_getBlockByNumber": {
        const tag = params[0] as string;
        return block(tag === "safe" ? DEPOSIT_BLOCK + 5n : tag.startsWith("0x") ? BigInt(tag) : state.blockNumber);
      }
      case "eth_getBalance":
        return "0x16345785d8a0000";
      case "eth_getTransactionCount":
        return "0x1";
      case "eth_estimateGas":
        return "0x30d40";
      case "eth_maxPriorityFeePerGas":
      case "eth_gasPrice":
        return "0x3b9aca00";
      case "eth_feeHistory":
        return { oldestBlock: hex(state.blockNumber), baseFeePerGas: ["0x3b9aca00", "0x3b9aca00"], gasUsedRatio: [0.5], reward: [["0x3b9aca00"]] };
      case "eth_fillTransaction": {
        const request = params[0] as Record<string, unknown>;
        return { raw: "0x", tx: { ...request, input: request.data, nonce: "0x1", gas: "0x30d40", maxFeePerGas: "0x77359400", maxPriorityFeePerGas: "0x3b9aca00", type: "0x2", chainId: "0x14a34", value: request.value ?? "0x0" } };
      }
      case "eth_sendRawTransaction":
        state.deposited = true;
        return DEPOSIT_TX;
      case "eth_getTransactionByHash":
        return { hash: DEPOSIT_TX, blockNumber: hex(DEPOSIT_BLOCK), blockHash: BLOCK_HASH, from: state.owner, to: MOCK.vault, nonce: "0x1", value: "0x0", input: "0x", gas: "0x30d40", gasPrice: "0x3b9aca00", transactionIndex: "0x3", type: "0x2", chainId: "0x14a34", v: "0x0", r: "0x0", s: "0x0" };
      case "eth_getTransactionReceipt": {
        return { transactionHash: DEPOSIT_TX, blockNumber: hex(DEPOSIT_BLOCK), blockHash: BLOCK_HASH, transactionIndex: "0x3", from: state.owner, to: MOCK.vault, status: "0x1", cumulativeGasUsed: "0x30d40", gasUsed: "0x30d40", effectiveGasPrice: "0x3b9aca00", contractAddress: null, type: "0x2", logs: [streamDepositedLog(streams[0]!, state.nearAccount)], logsBloom: `0x${"0".repeat(512)}` };
      }
      case "eth_call": {
        const request = params[0] as { to: string; data: Hex };
        if (request.to.toLowerCase() === MULTICALL3) {
          const { args } = decodeFunctionData({ abi: multicall3Abi, data: request.data });
          const calls = args[0] as readonly { target: string; callData: Hex }[];
          return encodeFunctionResult({ abi: multicall3Abi, functionName: "aggregate3", result: calls.map((item) => call(item.target, item.callData)) });
        }
        const result = call(request.to, request.data);
        return result.success ? result.returnData : "0x";
      }
      default:
        return undefined;
    }
  };

  const engineView: MockOverrides["engineView"] = (method, args) => {
    switch (method) {
      case "compute_base_class_id":
        return Number(args.decimals) === 18 && String((args.schedule as { deposited: string }).deposited) === (100n * 10n ** 18n).toString() ? SEED : NEW_CLASS;
      case "compute_sol_class_id":
        return STRATEGIC;
      case "get_holding":
        return { class_id: args.class_id, balance: state.registered ? (100n * 10n ** 18n).toString() : "0", locked_in_rounds: "0", encumbered: "0", claimable: "0", checkpoint: "0" };
      case "registration_deposit_for":
        return "2160000000000000000000";
      case "get_replay":
        if (!state.registerSent) return null;
        state.replayPolls += 1;
        if (state.replayPolls >= 3) state.registered = true;
        return state.replayPolls >= 3 ? "Consumed" : { Pending: { since_block: 276_200_000 } };
      case "get_refused_deposit":
      case "get_sol_deposit":
        return null;
      case "deposit_path_of":
        return `dep/${String(args.account)}/${String(args.class_id)}`;
      default:
        return undefined;
    }
  };

  const nearRequest: MockOverrides["nearRequest"] = (method, params) => {
    if (params.request_type === "call_function" && params.account_id === "v1.signer-prod.testnet") return `ed25519:${DEPOSIT_ADDRESS}`;
    if (params.request_type === "call_function" && params.account_id === "tusdc.rose-app.testnet") return "0";
    if (params.request_type === "view_access_key") return { nonce: 7, permission: "FullAccess", block_height: 276_200_000, block_hash: "6zKgP7tApq19qYQnbWw4FtzA6hnrnoWWLti88pM6jGYS" };
    if (method === "block") return { header: { height: 276_200_000, hash: "6zKgP7tApq19qYQnbWw4FtzA6hnrnoWWLti88pM6jGYS", timestamp: NOW * 1e9, timestamp_nanosec: `${String(NOW)}000000000` } };
    if (method === "send_tx" || method === "tx") {
      state.registerSent = true;
      return {
        status: { SuccessValue: "" },
        transaction: { hash: "9Z7vFmqS3mG4KJ2sQxMx9nKpWcCkQ1cvZk4b7m1RsE2a", signer_id: "demo.testnet", receiver_id: MOCK.engine, nonce: 8, public_key: "ed25519:11111111111111111111111111111111" },
        transaction_outcome: { id: "t", outcome: { logs: [], receipt_ids: [], gas_burnt: 1, tokens_burnt: "0", executor_id: MOCK.engine, status: { SuccessValue: "" } } },
        receipts_outcome: [],
      };
    }
    return undefined;
  };

  function metadataBytes(recipient: string, options: { cancelableBySender: boolean; canTopup: boolean }): string {
    const bytes = new Uint8Array(1104);
    const view = new DataView(bytes.buffer);
    const u64 = (offset: number, value: bigint) => view.setBigUint64(offset, value, true);
    const key = (offset: number, base58: string) => bytes.set(decodeBase58(base58), offset);
    u64(9, BigInt(NOW - 60 * DAY));
    u64(33, BigInt(NOW + 305 * DAY));
    key(49, MOCK.gasSol);
    key(113, recipient);
    key(177, "3q81mxTA7rricmjJQaiZk9HbZzF2Pt8aN5SJaJcXvZ4w");
    key(209, MOCK.vaultSol);
    u64(409, BigInt(NOW - 60 * DAY));
    u64(417, 365_000_000_000n);
    u64(425, 86_400n);
    u64(433, 1_000_000_000n);
    bytes[457] = options.cancelableBySender ? 1 : 0;
    bytes[461] = 1;
    bytes[462] = options.canTopup ? 1 : 0;
    return Buffer.from(bytes).toString("base64");
  }

  function decodeBase58(text: string): Uint8Array {
    const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let value = 0n;
    for (const char of text) value = value * 58n + BigInt(alphabet.indexOf(char));
    const out: number[] = [];
    while (value > 0n) {
      out.unshift(Number(value % 256n));
      value /= 256n;
    }
    for (const char of text) {
      if (char !== "1") break;
      out.unshift(0);
    }
    while (out.length < 32) out.unshift(0);
    return Uint8Array.from(out.slice(-32));
  }

  const solanaState = { owner: "" };
  const STREAM_A = "5bWqgE2tDNrdsnR3kQh3Vbz5xN4nM8wYJ9vLkPq1Xy7f";
  const STREAM_B = "9fQ2hJkL4mN7pR3sT6vW8xY1zA5bC9dE2fG4hJ6kM8nP";

  const solanaRequest: MockOverrides["solanaRequest"] = (method, params) => {
    const account = (owner: string, data: string, space: number) => ({ data: [data, "base64"], executable: false, lamports: 2_039_280, owner, rentEpoch: 0, space });
    switch (method) {
      case "getProgramAccounts":
        return [
          { pubkey: STREAM_A, account: account("HqDGZjaVRXJ9MGRQEw7qDc2rAr6iH1n1kAQdCZaCMfMZ", metadataBytes(solanaState.owner, { cancelableBySender: false, canTopup: false }), 1104) },
          { pubkey: STREAM_B, account: account("HqDGZjaVRXJ9MGRQEw7qDc2rAr6iH1n1kAQdCZaCMfMZ", metadataBytes(solanaState.owner, { cancelableBySender: true, canTopup: true }), 1104) },
        ];
      case "getAccountInfo": {
        const target = params[0] as string;
        const context = { slot: 518_422_893, apiVersion: "4.4.0" };
        if (target === "3q81mxTA7rricmjJQaiZk9HbZzF2Pt8aN5SJaJcXvZ4w") {
          const mint = new Uint8Array(82);
          mint[44] = 9;
          return { context, value: account("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", Buffer.from(mint).toString("base64"), 82) };
        }
        if (target === STREAM_A) return { context, value: account("HqDGZjaVRXJ9MGRQEw7qDc2rAr6iH1n1kAQdCZaCMfMZ", metadataBytes(solanaState.owner, { cancelableBySender: false, canTopup: false }), 1104) };
        return { context, value: null };
      }
      case "getLatestBlockhash":
        return { context: { slot: 518_422_893 }, value: { blockhash: "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N", lastValidBlockHeight: 500_000_000 } };
      case "sendTransaction":
        return "4Vw2CJ8ovmS9r4z5x6YzbXk3Ck1nQ7rmT8uGv1pA2bC3dE4fG5hJ6kL7mN8pQ9rS1tU2vW3xY4zA5bC6dE7fG8h";
      case "getBlockHeight":
        return 499_000_000;
      default:
        return undefined;
    }
  };

  /** Screenshots of the reviewed states (`SCREENSHOT_DIR` set) at 1470 px, or 375 px on the mobile project: `app-deposit-<state>-<width>.png`. */
  async function snap(page: Page, name: string): Promise<void> {
    const dir = process.env.SCREENSHOT_DIR;
    if (!dir) return;
    const viewport = page.viewportSize();
    const mobile = (viewport?.width ?? 0) < 1000;
    if (mobile) await page.setViewportSize({ width: 375, height: 812 });
    await page.screenshot({ path: `${dir}/app-deposit-${name}-${mobile ? "375" : "1470"}.png`, fullPage: true });
    if (mobile && viewport) await page.setViewportSize(viewport);
  }

  async function connectDemoWallets(page: Page, chains: ("NEAR" | "Base" | "Solana")[]): Promise<void> {
    for (const chain of chains) {
      await page.locator("[data-connect]").click();
      const dialog = page.getByRole("dialog", { name: /Connect a wallet/ });
      await dialog.getByRole("tab", { name: chain }).click();
      await dialog.getByRole("button", { name: /Create a demo wallet/ }).click();
      await expect(dialog).toBeHidden();
    }
    const stored = await page.evaluate(() => ({
      evm: JSON.parse(localStorage.getItem("rose.demo.evm") ?? "null") as { address?: string } | null,
      near: JSON.parse(localStorage.getItem("rose.demo.near") ?? "null") as { accountId?: string } | null,
      solana: JSON.parse(localStorage.getItem("rose.demo.solana") ?? "null") as { publicKey?: string } | null,
    }));
    state.owner = stored.evm?.address ?? "";
    state.nearAccount = stored.near?.accountId ?? "";
    solanaState.owner = stored.solana?.publicKey ?? "";
  }

  test.beforeEach(async ({ page }) => {
    Object.assign(state, { owner: "", nearAccount: "", blockNumber: 38_990_010n, replayPolls: 0, registered: false, deposited: false, registerSent: false });
    await page.addInitScript(() => localStorage.setItem("rose.tour.dismissed", "1"));
    await mockChains(page, { engineView, nearRequest, baseRequest, solanaRequest });
    await page.goto("/app/prices");
  });

  test("asks for wallets, explains the chain states and keeps the NEAR recipient visible", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("/app/deposit");
    await expect(page.getByRole("heading", { name: "Deposit a position" })).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("[data-near-recipient]")).toContainText("Units are minted to a NEAR account");
    await snap(page, "start");
    await page.locator("[data-chain='base']").click();
    await expect(page.locator("[data-connect-prompt='base']")).toBeVisible();
    await snap(page, "no-wallet");
    await page.locator("[data-chain='solana']").click();
    await expect(page.locator("[data-connect-prompt='solana']")).toBeVisible();
    await page.locator("[data-connect-prompt='solana']").click();
    await expect(page.getByRole("dialog", { name: /Connect a wallet/ })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("Base: lists the holder's streams with eligibility, class matching and runs the deposit flow to the minted units", async ({ page }) => {
    test.setTimeout(180_000);
    await connectDemoWallets(page, ["NEAR", "Base"]);
    await page.goto("/app/deposit");
    await expect(page.locator("[data-near-recipient]")).toContainText(state.nearAccount, { timeout: 30_000 });
    await page.locator("[data-chain='base']").click();
    const list = page.locator("[data-stream-list]");
    await expect(list.locator("[data-stream]")).toHaveCount(3, { timeout: 60_000 });
    const eligible = list.locator("[data-stream='100']");
    await expect(eligible).toContainText("Eligible");
    await expect(eligible).toContainText("Joins class");
    await expect(eligible).toContainText("100.0000 CINDR");
    await expect(list.locator("[data-stream='98']")).toContainText("Creates a new class");
    const cancelable = list.locator("[data-stream='99']");
    await expect(cancelable).toContainText("Not eligible");
    await expect(cancelable).toContainText("The stream is cancelable; the sender must renounce it first.");
    await expect(cancelable.locator("[data-deposit-stream]")).toBeDisabled();
    await snap(page, "base-list");
    await eligible.locator("[data-deposit-stream]").click();
    const flow = page.locator("[data-deposit-flow]");
    await expect(flow).toBeVisible();
    await expect(flow.locator("[data-step='approve']")).toHaveAttribute("data-status", "done", { timeout: 30_000 });
    await expect(flow.locator("[data-step='approve']")).toContainText("already approved");
    await expect(flow.locator("[data-step='deposit']")).toHaveAttribute("data-status", "done", { timeout: 60_000 });
    await expect(flow.locator("[data-step='deposit']")).toContainText(`Deposited in block ${DEPOSIT_BLOCK.toString()}`);
    await expect(flow.locator("[data-step='deposit']").getByRole("link", { name: /Basescan/ })).toHaveAttribute("href", `https://sepolia.basescan.org/tx/${DEPOSIT_TX}`);
    const finality = flow.locator("[data-step='finality']");
    await expect(finality).toContainText("30 s margin", { timeout: 30_000 });
    await snap(page, "base-finality");
    await expect(finality).toHaveAttribute("data-status", "done", { timeout: 60_000 });
    const register = flow.locator("[data-step='register']");
    await expect(register).toHaveAttribute("data-status", "done", { timeout: 60_000 });
    await expect(register.getByRole("link", { name: /near.rocks/ })).toBeVisible();
    await expect(flow.locator("[data-step='minted']")).toContainText("100.0000 units of class aaaaaaaa…aaaaaa minted to");
    await expect(flow.getByRole("button", { name: "Open Portfolio" })).toBeVisible();
    await snap(page, "base-minted");
    const attempted = await page.evaluate(() => localStorage.getItem("rose.deposits.attempted"));
    expect(attempted).toContain(`"tx_hash":"${DEPOSIT_TX.slice(2)}"`);
  });

  test("Solana: lists Streamflow streams with explanations and derives the MPC deposit address", async ({ page }) => {
    await connectDemoWallets(page, ["NEAR", "Solana"]);
    await page.goto("/app/deposit");
    await page.locator("[data-chain='solana']").click();
    const list = page.locator("[data-stream-list]");
    await expect(list.locator("[data-stream]")).toHaveCount(2, { timeout: 60_000 });
    const eligible = list.locator(`[data-stream='${STREAM_A}']`);
    await expect(eligible).toContainText("Eligible");
    await expect(eligible).toContainText("Joins class");
    await expect(eligible).toContainText("365.0000");
    const refused = list.locator(`[data-stream='${STREAM_B}']`);
    await expect(refused).toContainText("The sender can still cancel the stream.");
    await expect(refused).toContainText("The sender can top the stream up, which would change the schedule.");
    await expect(refused.locator("[data-deposit-stream]")).toBeDisabled();
    await snap(page, "solana-list");
    await eligible.locator("[data-deposit-stream]").click();
    const flow = page.locator("[data-deposit-flow]");
    await expect(flow.locator("[data-step='derive']")).toHaveAttribute("data-status", "done", { timeout: 30_000 });
    await expect(flow.locator("[data-step='derive']")).toContainText(`Deposit address ${DEPOSIT_ADDRESS.slice(0, 8)}…${DEPOSIT_ADDRESS.slice(-8)} (path dep/${state.nearAccount}/cccccccc…cccccc`);
    await expect(flow.locator("[data-step='transfer']")).toHaveAttribute("data-status", "running");
    await snap(page, "solana-flow");
    await flow.getByRole("button", { name: "Stop waiting" }).click();
  });

  test("Base: the empty list offers the demo vesting position", async ({ page }) => {
    await connectDemoWallets(page, ["NEAR", "Base"]);
    state.owner = "0x000000000000000000000000000000000000dead";
    await page.goto("/app/deposit");
    await page.locator("[data-chain='base']").click();
    await expect(page.getByText("No Sablier stream in this range")).toBeVisible({ timeout: 60_000 });
    await expect(page.locator("[data-mint-demo]")).toBeEnabled();
    await expect(page.getByText(/ids 1 to 100 scanned/)).toBeVisible();
    await snap(page, "base-empty");
  });
});
