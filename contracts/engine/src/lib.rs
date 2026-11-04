//! rose engine.
//!
//! The modules below are pure: no NEAR SDK, no floating point, no I/O. They hold the arithmetic the
//! contract settles with, so the same code can be property-tested natively and compiled to wasm.

pub mod clearing;
pub mod math;
pub mod unlock;
