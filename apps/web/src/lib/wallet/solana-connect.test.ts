import { EventEmitter } from "node:events";
import { WalletConnectionError, type Adapter } from "@solana/wallet-adapter-base";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RoseActionError } from "@/lib/errors";
import { waitForSolanaConnection } from "./solana-connect";

function fakeAdapter(): EventEmitter & Pick<Adapter, "on" | "off"> {
  return new EventEmitter() as EventEmitter & Pick<Adapter, "on" | "off">;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("waitForSolanaConnection", () => {
  it("resolves when the adapter connects and stops listening", async () => {
    const adapter = fakeAdapter();
    const waiting = waitForSolanaConnection(adapter);
    adapter.emit("connect");
    await expect(waiting).resolves.toBeUndefined();
    expect(adapter.listenerCount("connect")).toBe(0);
    expect(adapter.listenerCount("error")).toBe(0);
  });

  it("rejects with the wallet's error, a rejection in the wallet included", async () => {
    const adapter = fakeAdapter();
    const waiting = waitForSolanaConnection(adapter);
    const rejection = new WalletConnectionError("User rejected the request.");
    adapter.emit("error", rejection);
    await expect(waiting).rejects.toBe(rejection);
    expect(adapter.listenerCount("error")).toBe(0);
  });

  it("gives up after the timeout with a retryable error", async () => {
    vi.useFakeTimers();
    const adapter = fakeAdapter();
    const waiting = waitForSolanaConnection(adapter, 1_000);
    const outcome = waiting.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1_000);
    const error = await outcome;
    expect(error).toBeInstanceOf(RoseActionError);
    expect((error as RoseActionError).retryable).toBe(true);
    expect(adapter.listenerCount("connect")).toBe(0);
  });
});
