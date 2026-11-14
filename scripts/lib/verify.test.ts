import assert from "node:assert/strict";
import { test } from "node:test";
import { abiAddress, isTransientRpcError, JsonRpc, sdkSource } from "./verify.ts";

const SOURCES = new URL("file:///repo/packages/sdk/src/");

await test("an @rose/sdk entry point loads from its TypeScript source", () => {
  assert.equal(sdkSource("@rose/sdk/clearing", "file:///repo/scripts/lib/clearing.ts", SOURCES), "file:///repo/packages/sdk/src/clearing.ts");
  assert.equal(sdkSource("@rose/sdk/math", undefined, SOURCES), "file:///repo/packages/sdk/src/math.ts");
});

await test("a .js import inside the SDK sources becomes the .ts file beside it, and nothing else is mapped", () => {
  assert.equal(sdkSource("./math.js", "file:///repo/packages/sdk/src/clearing.ts", SOURCES), "./math.ts");
  assert.equal(sdkSource("../encoding.js", "file:///repo/packages/sdk/src/engine/rpc.ts", SOURCES), "../encoding.ts");
  assert.equal(sdkSource("./math.js", "file:///repo/scripts/verify.ts", SOURCES), null);
  assert.equal(sdkSource("@rose/sdk", "file:///repo/scripts/verify.ts", SOURCES), null);
  assert.equal(sdkSource("node:module", "file:///repo/packages/sdk/src/clearing.ts", SOURCES), null);
});

await test("an eth_call address must be exactly one word with a zero high part", () => {
  assert.equal(abiAddress("0x000000000000000000000000C345e592C6Db18c162c6225BFb6F6c92b425b7cb"), "0xc345e592c6db18c162c6225bfb6f6c92b425b7cb");
  assert.throws(() => abiAddress("0x"));
  assert.throws(() => abiAddress(undefined));
  assert.throws(() => abiAddress(`0x${"00".repeat(12)}${"11".repeat(20)}${"00".repeat(32)}`));
  assert.throws(() => abiAddress(`0x01${"00".repeat(11)}${"11".repeat(20)}`));
});

await test("rate limits and deprecation notices are transient, an answer about the request is not", () => {
  assert.equal(isTransientRpcError({ code: -429, message: "WARNING! THIS ENDPOINT IS DEPRECATED! STOP USING IT NOW!" }), true);
  assert.equal(isTransientRpcError({ code: -32000, cause: { name: "TOO_MANY_REQUESTS" } }), true);
  assert.equal(isTransientRpcError({ code: -32000, message: "Server error", cause: { name: "UNKNOWN_ACCOUNT" } }), false);
  assert.equal(isTransientRpcError({ code: 3, message: "execution reverted" }), false);
  assert.equal(isTransientRpcError(undefined), false);
});

type Reply = { status: number; body?: unknown } | "unreachable";

/** A fetch that answers each endpoint from its own queue of replies and counts the requests. */
function fakeFetch(replies: Record<string, Reply[]>): { fetch: typeof globalThis.fetch; sent: string[] } {
  const sent: string[] = [];
  const fetch = (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    sent.push(url);
    const reply = replies[url]?.shift() ?? "unreachable";
    if (reply === "unreachable") return Promise.reject(new TypeError("fetch failed"));
    return Promise.resolve(new Response(JSON.stringify(reply.body ?? null), { status: reply.status }));
  };
  return { fetch, sent };
}

await test("a refused request moves to the next endpoint, which later calls then start with", async () => {
  const { fetch, sent } = fakeFetch({
    "https://a.test/": [{ status: 429 }],
    "https://b.test/": [
      { status: 200, body: { jsonrpc: "2.0", id: 0, result: "first" } },
      { status: 200, body: { jsonrpc: "2.0", id: 0, result: "second" } },
    ],
  });
  const rpc = new JsonRpc("test", ["https://a.test/", "https://b.test/"], { fetch, pauseMs: 0 });
  assert.deepEqual(await rpc.call("m", []), { result: "first", host: "b.test" });
  assert.deepEqual(await rpc.call("m", []), { result: "second", host: "b.test" });
  assert.deepEqual(sent, ["https://a.test/", "https://b.test/", "https://b.test/"]);
});

await test("an error answer moves to the next endpoint, which may answer the request", async () => {
  const { fetch, sent } = fakeFetch({
    "https://a.test/": [{ status: 200, body: { jsonrpc: "2.0", id: 0, error: { code: -32603, message: "Temporary internal error" } } }],
    "https://b.test/": [{ status: 200, body: { jsonrpc: "2.0", id: 0, result: "answer" } }],
  });
  const rpc = new JsonRpc("test", ["https://a.test/", "https://b.test/"], { fetch, pauseMs: 0 });
  assert.deepEqual(await rpc.call("m", []), { result: "answer", host: "b.test" });
  assert.deepEqual(sent, ["https://a.test/", "https://b.test/"]);
});

await test("an error answer is final once every endpoint gave one, without a second pass", async () => {
  const unknownAccount = { status: 200, body: { jsonrpc: "2.0", id: 0, error: { code: -32000, message: "Server error", cause: { name: "UNKNOWN_ACCOUNT" } } } };
  const { fetch, sent } = fakeFetch({ "https://a.test/": [unknownAccount], "https://b.test/": [unknownAccount] });
  const rpc = new JsonRpc("test", ["https://a.test/", "https://b.test/"], { fetch, pauseMs: 0 });
  await assert.rejects(rpc.call("m", []), /^RpcAnswerError: a\.test answered with an error: Server error/);
  assert.deepEqual(sent, ["https://a.test/", "https://b.test/"]);
});

await test("a rate limit answered as a JSON-RPC error gets a second pass", async () => {
  const deprecated = { status: 200, body: { jsonrpc: "2.0", id: 0, error: { code: -429, message: "THIS ENDPOINT IS DEPRECATED" } } };
  const { fetch, sent } = fakeFetch({ "https://a.test/": [deprecated, { status: 200, body: { jsonrpc: "2.0", id: 0, result: "later" } }] });
  const rpc = new JsonRpc("test", ["https://a.test/"], { fetch, pauseMs: 0 });
  assert.deepEqual(await rpc.call("m", []), { result: "later", host: "a.test" });
  assert.equal(sent.length, 2);
});

await test("once every endpoint failed a whole call, later calls fail without a request", async () => {
  const { fetch, sent } = fakeFetch({});
  const rpc = new JsonRpc("test", ["https://a.test/", "https://b.test/"], { fetch, pauseMs: 0 });
  await assert.rejects(rpc.call("m", []), /no test RPC endpoint answered \(a\.test: fetch failed; b\.test: fetch failed; a\.test: fetch failed; b\.test: fetch failed\)/);
  await assert.rejects(rpc.call("m", []), /no test RPC endpoint answered/);
  assert.equal(sent.length, 4);
});

await test("a batch takes every answer from one endpoint, matched by id", async () => {
  const { fetch } = fakeFetch({
    "https://a.test/": [{ status: 200, body: [{ jsonrpc: "2.0", id: 1, result: "0x1" }, { jsonrpc: "2.0", id: 0, result: "0x0" }] }],
  });
  const rpc = new JsonRpc("test", ["https://a.test/"], { fetch, pauseMs: 0 });
  assert.deepEqual(await rpc.batch([{ method: "x", params: [] }, { method: "y", params: [] }]), { results: ["0x0", "0x1"], host: "a.test" });
});
