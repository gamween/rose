import type { NextConfig } from "next";

/**
 * Content Security Policy of every page and route. What it must allow, and why:
 * - NEAR Connect runs each external NEAR wallet in a `srcdoc` iframe, which inherits this policy:
 *   the wallet's code is fetched from the wallet's own host and inlined as a module script, and
 *   the bundles (WalletConnect, Meteor, Nightly) call `Function(...)` and talk to their own
 *   backends and relays. Hence `'unsafe-inline'` and `'unsafe-eval'` scripts, and any HTTPS or
 *   WSS endpoint in `connect-src`, `img-src`, `style-src`, `font-src` and `frame-src`.
 * - Next.js streams its payload in inline scripts (a nonce would force every page to render
 *   dynamically), the guided tour pre-paints with one inline script, and `@rose/ibe-wasm`
 *   compiles WebAssembly (`'wasm-unsafe-eval'`).
 * - No script element may load from another origin, and no plugin, `<base>` or cross-site form.
 * What it is for: nothing may frame the app (`frame-ancestors 'none'`: the demo wallets sign
 * without a prompt, so a framing page could otherwise clickjack them).
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'",
  "connect-src 'self' https: wss:",
  "img-src 'self' data: blob: https:",
  "style-src 'self' 'unsafe-inline' https:",
  "font-src 'self' data: https:",
  "frame-src 'self' https:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

/**
 * Sent with every response. USB, HID and Bluetooth keep their default (this origin and the
 * frames it delegates to), because the Ledger wallet of NEAR Connect needs them.
 */
export const SECURITY_HEADERS: { key: string; value: string }[] = [
  { key: "Content-Security-Policy", value: CONTENT_SECURITY_POLICY },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  agentRules: false,
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
};

export default nextConfig;
