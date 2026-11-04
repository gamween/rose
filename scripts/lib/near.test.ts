import assert from "node:assert/strict";
import { test } from "node:test";
import { failedBeforeSigning } from "./near.ts";

function syntaxErrorFrom(frames: string[]): SyntaxError {
  const error = new SyntaxError(`Unexpected token '<', "<!DOCTYPE "... is not valid JSON`);
  error.stack = [`${error.name}: ${error.message}`, ...frames.map((frame) => `    at ${frame}`)].join("\n");
  return error;
}

await test("an HTML page answered while near-api-js builds the transaction is retried", () => {
  // The stack of the live engine-s4 failure (scripts/e2e-live.ts, nokey:bid).
  const error = syntaxErrorFrom(["JSON.parse (<anonymous>)", "async fetchJsonRpc (near-api-js/lib/index.js:3084:10)", "async JsonRpcProvider.sendJsonRpc (near-api-js/lib/index.js:3531:22)", "async Promise.all (index 1)", "async Account.createTransaction (near-api-js/lib/index.js:4215:44)"]);
  assert.equal(failedBeforeSigning(error), true);
});

await test("an HTML page answered to the broadcast is not retried (the transaction may have landed)", () => {
  const error = syntaxErrorFrom(["JSON.parse (<anonymous>)", "async fetchJsonRpc (near-api-js/lib/index.js:3084:10)", "async JsonRpcProvider.sendTransactionUntil (near-api-js/lib/index.js:3402:12)", "async Account.signAndSendTransaction (near-api-js/lib/index.js:4260:20)"]);
  assert.equal(failedBeforeSigning(error), false);
});

await test("other errors are not retried", () => {
  assert.equal(failedBeforeSigning(new Error("Account.createTransaction: access key not found")), false);
});
