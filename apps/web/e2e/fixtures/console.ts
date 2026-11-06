import type { Page } from "@playwright/test";

/** The public NEAR RPCs the app reads from (with fallback between them). */
const NEAR_RPC_HOSTS = /^https:\/\/(test\.rpc\.fastnear\.com|rpc\.testnet\.near\.org|near-testnet\.drpc\.org)\//;

/**
 * Console errors and failed page responses. Tolerated: a public RPC answering 429, and the
 * browser's CORS error for it (both public NEAR RPCs send their 429 without CORS headers, so
 * Chromium reports a blocked request; the app falls over to the other endpoint). A smoke run
 * from one IP reads a lot more than one visitor does, so it can trip those limits.
 */
export function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  let rateLimited = 0;
  page.on("requestfailed", (request) => {
    if (NEAR_RPC_HOSTS.test(request.url())) rateLimited += 1;
  });
  page.on("console", (message) => {
    const text = message.text();
    if (message.type() !== "error" || /status of 429|Rate limit/i.test(text)) return;
    if (/^Access to fetch at 'https:\/\/(test\.rpc\.fastnear\.com|rpc\.testnet\.near\.org)\/'.*blocked by CORS policy/.test(text)) return;
    if (text === "Failed to load resource: net::ERR_FAILED" && rateLimited > 0) {
      rateLimited -= 1;
      return;
    }
    errors.push(text);
  });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => {
    if (response.status() >= 400 && response.status() !== 429) errors.push(`${String(response.status())} ${response.url()}`);
  });
  return errors;
}
