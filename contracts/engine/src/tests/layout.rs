//! Layout of the Borsh-stored enums. A Borsh enum is stored as its variant index, so a variant
//! inserted anywhere but at the end, or removed, makes every record written before it decode as
//! another variant or fail ("Cannot deserialize element"). Every enum stored in state (records,
//! the event ring buffer, storage-key prefixes, the class schedule) or hashed for the MPC must
//! keep the variants listed here, in this order, and may only gain new ones at the end
//! (docs/architecture.md, "Stored layouts").

/// Engine sources that define Borsh enums.
const SOURCES: &[(&str, &str)] = &[
    ("custody/mod.rs", include_str!("../custody/mod.rs")),
    ("custody/types.rs", include_str!("../custody/types.rs")),
    ("events.rs", include_str!("../events.rs")),
    ("foreign/mpc.rs", include_str!("../foreign/mpc.rs")),
    ("lib.rs", include_str!("../lib.rs")),
    ("types.rs", include_str!("../types.rs")),
    ("unlock.rs", include_str!("../unlock.rs")),
];

/// Variants of every Borsh enum, in stored order, as of this layout.
const LAYOUT: &[(&str, &str, &[&str])] = &[
    (
        "custody/mod.rs",
        "StorageKey",
        &[
            "Replays",
            "Refused",
            "Payouts",
            "AccountPayouts",
            "AccountPayoutList",
            "SolDeposits",
            "SolStreams",
            "Releasing",
            "Pending",
            "ClassStreams",
            "KeyHolds",
        ],
    ),
    (
        "custody/types.rs",
        "ReplayKey",
        &["BaseLog", "SolStream", "SolNonce"],
    ),
    ("custody/types.rs", "ReplayState", &["Pending", "Consumed"]),
    (
        "custody/types.rs",
        "ClaimSourceArgs",
        &["Holding", "Retired", "LienShare"],
    ),
    (
        "custody/types.rs",
        "StoredClaimSource",
        &["Holding", "Retired", "LienShare"],
    ),
    (
        "custody/types.rs",
        "PayoutKind",
        &[
            "BaseTransfer",
            "BaseRelease",
            "SolTransfer",
            "SolRelease",
            "SolMove",
            "SolReturn",
        ],
    ),
    (
        "custody/types.rs",
        "PayoutDebit",
        &["None", "Claimable", "Cash", "Units"],
    ),
    (
        "custody/types.rs",
        "PayoutStatus",
        &[
            "Requested",
            "Signed",
            "AwaitingGasSignature",
            "Failed",
            "Landed",
        ],
    ),
    (
        "custody/types.rs",
        "RefusedAsset",
        &["BaseStream", "SolStream"],
    ),
    (
        "custody/types.rs",
        "SolDepositStage",
        &["Attributed", "MoveSigned", "Registered", "Refused"],
    ),
    (
        "events.rs",
        "RoseEvent",
        &[
            "ClassCreated",
            "PositionRegistered",
            "PositionReleased",
            "UnitsMinted",
            "UnitsBurned",
            "UnitsTransferred",
            "CashDeposited",
            "CashWithdrawn",
            "CashWithdrawalFailed",
            "RoundCreated",
            "BidPlaced",
            "RoundCancelled",
            "KeyRequested",
            "KeyRequestFailed",
            "KeyIgnored",
            "ClearingFailed",
            "StorageDeposited",
            "StorageWithdrawn",
            "StorageUnregistered",
            "KeyReceived",
            "BidOpened",
            "RoundCleared",
            "BidSettled",
            "LienCreated",
            "LienReleased",
            "ClaimableTaken",
            "BootstrapRequested",
            "Bootstrapped",
            "BootstrapFailed",
            "DepositVerificationRequested",
            "DepositVerificationFailed",
            "DepositMismatch",
            "DepositRefused",
            "DepositRegistered",
            "BaseCashRegistered",
            "SolDepositAttributed",
            "PayoutRequested",
            "PayoutSigned",
            "PayoutAwaitingGasSignature",
            "PayoutFailed",
            "PositionReleaseRequested",
            "PayoutLanded",
            "PayoutCancelling",
        ],
    ),
    (
        "foreign/mpc.rs",
        "ForeignChainRpcRequest",
        &["Solana", "Base"],
    ),
    (
        "foreign/mpc.rs",
        "EvmFinality",
        &["Latest", "Safe", "Finalized"],
    ),
    ("foreign/mpc.rs", "EvmExtractor", &["Log"]),
    ("foreign/mpc.rs", "SvmFinality", &["Confirmed", "Finalized"]),
    ("foreign/mpc.rs", "SvmExtractor", &["AccountState"]),
    (
        "foreign/mpc.rs",
        "ExtractedValue",
        &["EvmExtractedValue", "SvmExtractedValue"],
    ),
    ("foreign/mpc.rs", "EvmExtractedValue", &["Log"]),
    ("foreign/mpc.rs", "SvmExtractedValue", &["AccountState"]),
    ("foreign/mpc.rs", "ForeignTxSignPayload", &["V1"]),
    (
        "lib.rs",
        "StorageKey",
        &[
            "Classes",
            "Positions",
            "Holdings",
            "Cash",
            "Rounds",
            "Bids",
            "Orders",
            "Liens",
            "LienShares",
            "AccountIndex",
            "Events",
            "PriceHistory",
            "PriceHistoryClass",
            "StorageAccounts",
        ],
    ),
    ("types.rs", "Chain", &["Base", "Solana"]),
    ("types.rs", "Venue", &["Near", "Base"]),
    ("types.rs", "Holder", &["Account", "Retired"]),
    (
        "types.rs",
        "PositionSource",
        &["BaseStream", "SolanaStream"],
    ),
    (
        "types.rs",
        "PositionState",
        &["Held", "Released", "Releasing"],
    ),
    ("types.rs", "RoundKind", &["Tender", "Exit", "Advance"]),
    (
        "types.rs",
        "Phase",
        &[
            "Bidding",
            "KeyRequested",
            "Revealing",
            "Settled",
            "Cancelled",
        ],
    ),
    (
        "types.rs",
        "CancelReason",
        &["Creator", "NoKey", "NoCrossing", "Empty"],
    ),
    ("types.rs", "KeySource", &["Callback", "Submitted"]),
    ("types.rs", "Side", &["Buy", "Sell"]),
    (
        "types.rs",
        "VoidReason",
        &[
            "Unopened",
            "EscrowTooSmall",
            "QuantityAboveSupply",
            "QuantityAboveLocked",
            "ClaimMismatch",
        ],
    ),
    ("unlock.rs", "ClassSchedule", &["Linear", "Stepped"]),
];

/// The Borsh enums of a source file with their variants in declaration order.
fn borsh_enums(source: &str) -> Vec<(String, Vec<String>)> {
    let mut enums = Vec::new();
    let lines: Vec<&str> = source.lines().collect();
    for (index, line) in lines.iter().enumerate() {
        let trimmed = line
            .trim_start_matches("pub ")
            .trim_start_matches("pub(crate) ");
        let Some(rest) = trimmed.strip_prefix("enum ") else {
            continue;
        };
        if line.starts_with(' ') {
            continue;
        }
        let attributes = lines[..index]
            .iter()
            .rev()
            .take_while(|l| !l.is_empty() && !l.starts_with('}') && !l.ends_with(';'))
            .any(|l| l.contains("borsh") || l.contains("Borsh"));
        if !attributes {
            continue;
        }
        let name: String = rest
            .chars()
            .take_while(|c| c.is_alphanumeric() || *c == '_')
            .collect();
        let mut variants = Vec::new();
        let mut depth = 0i32;
        for body in &lines[index + 1..] {
            if *body == "}" {
                break;
            }
            let text = body.trim();
            if depth == 0 && !text.starts_with("//") && !text.starts_with('#') {
                let variant: String = text
                    .chars()
                    .take_while(|c| c.is_alphanumeric() || *c == '_')
                    .collect();
                if variant.starts_with(|c: char| c.is_ascii_uppercase()) {
                    variants.push(variant);
                }
            }
            depth += body.matches(['{', '(']).count() as i32;
            depth -= body.matches(['}', ')']).count() as i32;
        }
        enums.push((name, variants));
    }
    enums
}

#[test]
fn borsh_enums_only_gain_variants_at_the_end() {
    let mut seen = 0;
    for (file, source) in SOURCES {
        for (name, variants) in borsh_enums(source) {
            let (_, _, stored) = LAYOUT
                .iter()
                .find(|(f, n, _)| f == file && *n == name)
                .unwrap_or_else(|| panic!("{file}: Borsh enum {name} is missing from LAYOUT"));
            assert!(
                variants.len() >= stored.len()
                    && variants.iter().zip(stored.iter()).all(|(a, b)| a == b),
                "{file}: {name} must keep {stored:?} in order and only append; it has {variants:?}"
            );
            seen += 1;
        }
    }
    assert_eq!(
        seen,
        LAYOUT.len(),
        "an enum listed in LAYOUT is no longer found"
    );
}
