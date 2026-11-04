import { describe, expect, it } from "vitest";
import nextConfig, { CONTENT_SECURITY_POLICY, SECURITY_HEADERS } from "../../next.config";

function directive(name: string): string[] {
  const entry = CONTENT_SECURITY_POLICY.split("; ").find((part) => part.startsWith(`${name} `));
  return entry ? entry.split(" ").slice(1) : [];
}

describe("security headers", () => {
  it("applies to every path", async () => {
    const rules = await nextConfig.headers!();
    expect(rules).toEqual([{ source: "/:path*", headers: SECURITY_HEADERS }]);
    expect(Object.fromEntries(SECURITY_HEADERS.map((header) => [header.key, header.value]))).toMatchObject({
      "X-Frame-Options": "DENY",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
    });
  });

  it("forbids framing, plugins, base hijacking, cross-site forms and foreign script elements", () => {
    expect(directive("frame-ancestors")).toEqual(["'none'"]);
    expect(directive("object-src")).toEqual(["'none'"]);
    expect(directive("base-uri")).toEqual(["'self'"]);
    expect(directive("form-action")).toEqual(["'self'"]);
    expect(directive("script-src").filter((source) => !source.startsWith("'"))).toEqual([]);
  });

  it("lets the wasm sealing, the wallets' RPCs and NEAR Connect's wallet frames run", () => {
    expect(directive("script-src")).toContain("'wasm-unsafe-eval'");
    expect(directive("connect-src")).toEqual(["'self'", "https:", "wss:"]);
    expect(directive("frame-src")).toContain("https:");
  });
});
