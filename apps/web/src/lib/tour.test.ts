import { describe, expect, it } from "vitest";
import { tourVisible } from "./tour";

describe("tourVisible", () => {
  it("hides a tour that opened by itself while the guided demo is on screen", () => {
    // Seen live: the first-visit tour fired on /app/rounds as the demo link was clicked and covered /app/demo.
    expect(tourVisible("auto", true)).toBe(false);
    expect(tourVisible("auto", false)).toBe(true);
  });

  it("shows a tour requested from the palette on any page, and never a closed one", () => {
    expect(tourVisible("requested", true)).toBe(true);
    expect(tourVisible("closed", false)).toBe(false);
  });
});
