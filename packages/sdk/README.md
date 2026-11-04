# @rose/sdk

TypeScript SDK of rose. Today it holds the parts of the engine that the web app must be able to
recompute on its own: the checked integer math, the unlock schedules of deposited positions and
their classes, and the uniform-price clearing of the three round types (Tender, Exit, Advance).
The app's "Verify" panel runs `tender`, `exit` and `advance` in the browser on the opened bids of
a round and compares the result with what the engine settled on-chain.

Every amount, price, quantity, id and timestamp is a `bigint`. Nothing here uses floating point or
`number` arithmetic on amounts; the only `number` is a token's decimals (`u8`). Inputs outside the
engine's integer domains (`u128`, `u64`, `u8`) throw a `RangeError`; the conditions the engine
reports as errors throw `MathError`, `ScheduleError` or `ClearingError` with the same codes and
messages.

## Modules

| Module                 | Rust source                           | Contents                                                                                                    |
| ---------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `math` (`src/math.ts`) | `contracts/engine/src/math.rs`        | `ONE = 1e18`, `mulDivFloor`, `mulDivCeil`, `mulDivRem`, `mulDivWide` (512-bit intermediate), `pow10`        |
| `unlock`               | `contracts/engine/src/unlock.rs`      | `SablierLinearStream` (Lockup v4 LL with granularity), `StreamflowStream`, `LinearClass`, `SteppedClass`, `accrual` |
| `clearing`             | `contracts/engine/src/clearing/`      | `tender`, `exit`, `advance`, `Pricing` (`charge` up, `payout` down, `affordable`), `fee` (30 bps, ceil)       |

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

On top of the vectors, `test/clearing.property.test.ts` checks the efficient clearing against an
independent brute-force tick scan on random small books with `fast-check`, and checks the fill
rule (priority, pro rata rationing by largest remainder, ties to the lower id, rounding of cash)
under random locked fractions and decimals.

## Scripts

```sh
pnpm --filter @rose/sdk typecheck   # tsc --noEmit
pnpm --filter @rose/sdk lint        # eslint (typescript-eslint strict + stylistic, type-checked)
pnpm --filter @rose/sdk test        # vitest
pnpm --filter @rose/sdk build       # tsc to dist/ with declarations
```

The package has no runtime dependencies.
