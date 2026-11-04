import { describe, expect, it } from "vitest";
import { RoseActionError } from "@/lib/errors";
import { requireSuccessfulReceipt } from "./receipt";

describe("requireSuccessfulReceipt", () => {
  it("passes a successful receipt through and refuses a reverted one", () => {
    const ok = { status: "success" as const, logs: [] };
    expect(requireSuccessfulReceipt(ok, "The tUSDC mint")).toBe(ok);
    const error = (() => {
      try {
        requireSuccessfulReceipt({ status: "reverted" as const }, "The tUSDC mint");
        return null;
      } catch (caught) {
        return caught;
      }
    })();
    expect(error).toBeInstanceOf(RoseActionError);
    expect((error as RoseActionError).kind).toBe("contract");
    expect((error as RoseActionError).message).toContain("The tUSDC mint reverted");
  });
});
