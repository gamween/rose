//! The Sablier port against live `streamedAmountOf` reads: twelve Lockup Linear streams of the
//! Base Sepolia Lockup v4 read at one pinned block (`tests/vectors/sablier_live.json`, commands
//! inside), covering a stream before its cliff, cliffs, start unlocks, a fully streamed stream
//! and mid-stream values of 14, 18 and 27-digit deposits.

use rose_engine::unlock::{SablierLinearParams, SablierLinearStream};
use serde_json::Value;

const LIVE: &str = include_str!("vectors/sablier_live.json");

fn amount(value: &Value) -> u128 {
    value.as_str().unwrap().parse().unwrap()
}

#[test]
fn port_reproduces_live_streamed_amounts_at_the_pinned_block() {
    let vectors: Value = serde_json::from_str(LIVE).unwrap();
    let timestamp = vectors["timestamp"].as_u64().unwrap();
    let streams = vectors["streams"].as_array().unwrap();
    assert_eq!(streams.len(), 12);
    let mut mid_stream = 0;
    for stream in streams {
        let params = SablierLinearParams {
            start: stream["start"].as_u64().unwrap(),
            cliff: stream["cliff"].as_u64().unwrap(),
            end: stream["end"].as_u64().unwrap(),
            granularity: stream["granularity"].as_u64().unwrap(),
            start_unlock: amount(&stream["start_unlock"]),
            cliff_unlock: amount(&stream["cliff_unlock"]),
            deposited: amount(&stream["deposited"]),
        };
        let expected = amount(&stream["streamed"]);
        let port = SablierLinearStream::new(params).unwrap();
        assert_eq!(
            port.streamed_amount(timestamp),
            expected,
            "stream {}",
            stream["stream_id"]
        );
        if expected > 0 && expected < params.deposited {
            mid_stream += 1;
        }
    }
    assert!(mid_stream >= 9, "most vectors are strictly mid-stream");
}
