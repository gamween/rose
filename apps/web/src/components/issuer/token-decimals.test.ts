import { Keypair, type Connection } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";
import { scheduleTokenDecimals, solanaMintDecimals } from "./token-decimals";

const MINT = Keypair.generate().publicKey;

describe("schedule token decimals", () => {
  it("reads the ERC-20 decimals on Base and the mint decimals on Solana once the token is an address", async () => {
    const evm = vi.fn(() => Promise.resolve(6));
    const solana = vi.fn(() => Promise.resolve(9));
    expect(await scheduleTokenDecimals("Base", " 0x69FA19AD12345678901234567890123456789012 ", { evm, solana })).toBe(6);
    expect(evm).toHaveBeenCalledWith("0x69fa19ad12345678901234567890123456789012");
    expect(await scheduleTokenDecimals("Solana", MINT.toBase58(), { evm, solana })).toBe(9);
  });

  it("reads nothing while the field holds no address of the chain, and null when the read fails", async () => {
    const evm = vi.fn(() => Promise.reject(new Error("no decimals()")));
    const solana = vi.fn(() => Promise.resolve(null));
    expect(await scheduleTokenDecimals("Base", "0x12", { evm, solana })).toBeNull();
    expect(await scheduleTokenDecimals("Solana", "0x69fa19ad12345678901234567890123456789012", { evm, solana })).toBeNull();
    expect(evm).not.toHaveBeenCalled();
    expect(await scheduleTokenDecimals("Base", "0x69fa19ad12345678901234567890123456789012", { evm, solana })).toBeNull();
  });

  it("takes the decimals from a parsed SPL mint only", async () => {
    const connection = (data: unknown) => ({ getParsedAccountInfo: () => Promise.resolve({ context: { slot: 1 }, value: data === null ? null : { data } }) }) as unknown as Connection;
    expect(await solanaMintDecimals(connection({ parsed: { info: { decimals: 9 } } }), MINT)).toBe(9);
    expect(await solanaMintDecimals(connection(Buffer.alloc(82)), MINT)).toBeNull();
    expect(await solanaMintDecimals(connection(null), MINT)).toBeNull();
  });
});
