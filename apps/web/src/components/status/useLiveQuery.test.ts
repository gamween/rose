import { describe, expect, it } from "vitest";
import { keepsValueOnFailure } from "./useLiveQuery";

describe("keepsValueOnFailure", () => {
  it("keeps the value through a failed refresh of a query that has answered", () => {
    expect(keepsValueOnFailure("read", true, true)).toBe(true);
    expect(keepsValueOnFailure("read", true, false)).toBe(true);
  });

  it("replaces another query's value when a new list query fails, even on a read a poll restarted", () => {
    expect(keepsValueOnFailure("read", false, true)).toBe(false);
  });

  it("keeps the previous value when a new query of a single view fails", () => {
    expect(keepsValueOnFailure("read", false, false)).toBe(true);
  });

  it("never keeps the value on an explicit retry", () => {
    expect(keepsValueOnFailure("retry", true, false)).toBe(false);
    expect(keepsValueOnFailure("retry", false, true)).toBe(false);
  });
});
