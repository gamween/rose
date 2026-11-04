# @rose/sdk

TypeScript SDK of rose: everything a client needs to use the rose engine without the web app.
It holds the engine bindings (typed views, change-call builders, a NEAR JSON-RPC client and event
decoding), the Base Sepolia and Solana devnet adapters (Sablier and RoseVault on Base, Streamflow
and durable nonces on Solana), and the parts of the engine a client must be able to recompute on
its own: the checked integer math, the unlock schedules of deposited positions and their classes,
and the uniform-price clearing of the three round types (Tender, Exit, Advance). The app's
"Verify" panel runs `tender`, `exit` and `advance` in the browser on the opened bids of a round
and compares the result with what the engine settled on-chain.

Every amount, price, quantity, id and timestamp is a `bigint`. Nothing here uses floating point or
`number` arithmetic on amounts; the only `number` is a token's decimals (`u8`) and Unix seconds of
foreign schedules. Inputs outside the engine's integer domains (`u128`, `u64`, `u8`) throw a
`RangeError`; the conditions the engine reports as errors throw `MathError`, `ScheduleError` or
`ClearingError` with the same codes and messages.

Runtime dependencies: `viem` 2.57.16 (Base), `@solana/web3.js` 1.99.0 (Solana) and `buffer` 6.0.3
(the `Buffer` web3.js needs in the browser). The `math`, `unlock` and `clearing` subpath exports
depend on none of them.

## Modules

| Module | Source | Contents |
| --- | --- | --- |
| `math` | `src/math.ts`, port of `contracts/engine/src/math.rs` | `ONE = 1e18`, `mulDivFloor`, `mulDivCeil`, `mulDivRem`, `mulDivWide` (512-bit intermediate), `pow10` |
| `unlock` | `src/unlock.ts`, port of `contracts/engine/src/unlock.rs` | `SablierLinearStream` (Lockup v4 LL with granularity), `StreamflowStream`, `LinearClass`, `SteppedClass`, `accrual` |
| `clearing` | `src/clearing.ts`, port of `contracts/engine/src/clearing/` | `tender`, `exit`, `advance`, `Pricing` (`charge` up, `payout` down, `affordable`), `fee` (30 bps, ceil) |
| engine | `src/engine/` | `NearRpc` (endpoint fallback, rate-limit backoff), `EngineViews` (every view, parsed into `bigint`s) and `EngineRawViews` (the JSON as returned), `EngineCalls` (one `FunctionCall` builder per change method, with its gas and deposit), `roseEvents` / `nep245Events` (NEP-297 logs), the engine's JSON types checked against the contract ABI |
| Base | `src/chains/base/` | `createBaseClient`, Sablier Lockup v4 reads (`readStream`, `listOwnedStreams`, `checkEligibility`, `calculateMinFeeWei`), RoseVault writes (`depositStream`, `createStreams`, `depositCash`, `executeTransfer`, `executeRelease`), log decoding for `register_base_deposit` (`decodeStreamDeposited`, `registerBaseDepositArgs`, `waitForSafeHead`), the demo faucet and TestUSDC, the ABIs generated from the Foundry build, RoseVault error decoding |
| Solana | `src/chains/solana/` | `createSolanaConnection`, Streamflow metadata decoding and pre-checks (`decodeStreamflowMetadata`, `readStreamflowStream`, `checkStreamflowEligibility`), the `transfer_recipient` transaction to a deposit address, payout nonce accounts (`payoutNonceSeed`, `payoutNonceAddress`, `createNonceAccountTransaction`), broadcast and confirmation of engine-signed transactions |

The engine re-checks everything at deposit and refuses what it does not accept: the eligibility
helpers tell a holder early, they do not replace the engine's checks.

## Examples

Read a round and build the call that opens an Exit round on the engine (sign and send the
`FunctionCall` with any NEAR wallet or `near-api-js`):

```ts
import { EngineCalls, engineViews } from "@rose/sdk";

const engine = "engine-s4.rose-app.testnet";
const views = engineViews(engine);
const round = await views.getRound(0n);
round?.status; // "Settled"

const call = new EngineCalls(engine).createExit({
  classId: round!.classId,
  venue: "Near",
  maxPrice: 50_000n, // 0.05 tUSDC per locked token
  window: { closesAt: (BigInt(Date.now()) + 600_000n) * 1_000_000n },
});
call.methodName; // "create_exit", with call.gas and call.deposit set
```

Check a Sablier stream on Base Sepolia before depositing it into RoseVault:

```ts
import { checkEligibility, createBaseClient, readStream } from "@rose/sdk";

const client = createBaseClient();
const stream = await readStream(client, 82n);
checkEligibility(stream); // { eligible: true, reasons: [] } or the failing rules
```

Read a Streamflow stream on Solana devnet:

```ts
import { PublicKey } from "@solana/web3.js";
import { checkStreamflowEligibility, createSolanaConnection, readStreamflowStream } from "@rose/sdk";

const connection = createSolanaConnection();
const { metadata } = await readStreamflowStream(connection, new PublicKey("4rX9gu7zsADqt1B5MpztX8kghx54vHSGcZTLmyYDrNc9"));
checkStreamflowEligibility(metadata).reasons; // [] when the stream passes the pre-checks
```

Clear a book exactly as the engine does:

```ts
import { exit, ONE } from "@rose/sdk";

const result = exit({
  bids: [{ id: 1n, qty: 10n, price: 15n }, { id: 2n, qty: 10n, price: 12n }],
  asks: [{ id: 1n, qty: 15n, price: 5n }],
  pricing: { lockedFractionE18: ONE, tokenDecimals: 0 },
});
if (result.outcome === "cleared") {
  result.price; // 8n: midpoint of the tied interval [5, 12]
  result.volume; // 15n
}
```

## How the vectors keep TypeScript and Rust in lockstep

The engine's integration test `contracts/engine/tests/vectors.rs` evaluates a fixed set of
books and schedules (hand-written edge cases plus books from a seeded generator) and writes the
results to `contracts/engine/tests/vectors/clearing.json` and `unlock.json`. That Rust test fails
whenever the committed files differ from what the engine computes, so the files are always the
engine's current output; after an intended engine change they are regenerated with
`ROSE_UPDATE_VECTORS=1 cargo test -p rose-engine --test vectors`.

This package's tests (`test/clearing.test.ts`, `test/unlock.test.ts`) read those two files
directly from the engine crate, never a copy, and assert exact equality on every field of every
case: clearing price, volume, each fill's quantity and cash, charged amount, refund, notional, fee,
streamed and unlocked amounts, class normalization and the class fraction at every sample time.
A change on either side that moves a single base unit fails the suite.
`test/unlock.sablier-live.test.ts` also checks the Sablier port against live `streamedAmountOf`
reads (`contracts/engine/tests/vectors/sablier_live.json`), so it does not only agree with the
Rust port but with Sablier itself.

On top of the vectors, `test/clearing.property.test.ts` checks the efficient clearing against an
independent brute-force tick scan on random small books with `fast-check`, and checks the fill
rule (priority, pro rata rationing by largest remainder, ties to the lower id, rounding of cash)
under random locked fractions and decimals. The chain adapters are tested against recorded RPC
answers and with wallets that record what they would send (`test/chains/`), including EIP-712
digests read from the deployed RoseVault and the web3.js message fixtures that
`scripts/solana-vectors.ts` regenerates.

## Scripts

```sh
pnpm --filter @rose/sdk typecheck   # tsc --noEmit
pnpm --filter @rose/sdk lint        # eslint (typescript-eslint strict + stylistic, type-checked)
pnpm --filter @rose/sdk test        # vitest
pnpm --filter @rose/sdk build       # tsc to dist/ with declarations
```
