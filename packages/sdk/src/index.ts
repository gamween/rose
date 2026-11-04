/**
 * `@rose/sdk`: exact TypeScript ports of the rose-engine integer math, unlock schedules and
 * uniform-price clearing, plus the engine bindings and the Base Sepolia and Solana devnet chain
 * adapters. Every amount is a `bigint`; nothing here uses floating point.
 *
 * @module
 */

export {
  assertU128,
  assertU64,
  assertU8,
  MathError,
  mulDiv,
  mulDivCeil,
  mulDivFloor,
  mulDivRem,
  mulDivWide,
  ONE,
  pow10,
  U128_MAX,
  U64_MAX,
  U8_MAX,
} from "./math.js";
export type { MathErrorCode, QuotientRemainder, Rounding } from "./math.js";

export {
  accrual,
  LinearClass,
  SablierLinearStream,
  ScheduleError,
  SteppedClass,
  StreamflowStream,
} from "./unlock.js";
export type { ClassSchedule, SablierLinearParams, ScheduleErrorCode, StreamflowParams, Timestamp } from "./unlock.js";

export {
  advance,
  affordable,
  BPS_DENOMINATOR,
  charge,
  ClearingError,
  exit,
  FEE_BPS,
  fee,
  payout,
  perClaimedToken,
  tender,
} from "./clearing.js";
export type {
  AdvanceAsk,
  AdvanceBook,
  Cleared,
  ClearingErrorCode,
  ExitBook,
  Fill,
  NoCrossing,
  Order,
  Outcome,
  Pricing,
  TenderBook,
  TenderClearing,
  UniformClearing,
} from "./clearing.js";

export * from "./chains/index.js";

export * from "./engine/index.js";
export { base64ToBytes, bytesToBase64, bytesToHex, bytesToUtf8, hexToBytes, utf8ToBytes } from "./encoding.js";
