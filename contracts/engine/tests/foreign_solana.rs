//! Solana messages, instructions, derivations and account parsers against recorded facts: five
//! messages compiled by `@solana/web3.js`, the payout broadcast on devnet, the ATA computed by
//! `@solana/spl-token`, a nonce account created with a seed on devnet, two devnet mints and the
//! Streamflow accounts attested live by the MPC.

use proptest::prelude::*;
use rose_engine::foreign::mpc::{parse_hex, Bytes32, SvmAccount};
use rose_engine::foreign::solana::{
    advance_nonce_account, assemble_transaction, associated_token_address, create_account,
    create_associated_token_account_idempotent, create_program_address, create_with_seed,
    find_program_address, format_pubkey, initialize_nonce_account, is_on_curve, parse_near_ed25519,
    parse_pubkey, push_compact_u16, sha256, spl_transfer_checked, streamflow_transfer_recipient,
    streamflow_withdraw, system_transfer, AccountMeta, Instruction, LegacyMessage, Mint,
    NonceAccount, Pubkey, SolanaError, StreamflowError, StreamflowMetadata,
    StreamflowWithdrawAccounts, ASSOCIATED_TOKEN_PROGRAM, MAX_TRANSACTION_LEN, NONCE_ACCOUNT_LEN,
    STREAMFLOW_DEVNET_PROGRAM, STREAMFLOW_METADATA_LEN,
    STREAMFLOW_TRANSFER_RECIPIENT_DISCRIMINATOR, STREAMFLOW_TREASURY, STREAMFLOW_WITHDRAW_ALL,
    STREAMFLOW_WITHDRAW_DISCRIMINATOR, SYSTEM_PROGRAM, SYSVAR_RECENT_BLOCKHASHES, SYSVAR_RENT,
    TOKEN_PROGRAM,
};
use rose_engine::unlock::{StreamflowParams, StreamflowStream};
use serde_json::Value;

/// Messages compiled by `@solana/web3.js` 1.98.4 `TransactionMessage.compileToLegacyMessage`
/// with `@solana/spl-token` 0.4.9 and `@streamflow/stream` 13.4.0 instruction builders.
const WEB3JS_MESSAGES: &str = include_str!("vectors/foreign/solana_web3js_messages.json");
/// The durable-nonce payout the MPC signed and that was broadcast on devnet.
const DEVNET_PAYOUT: &str = include_str!("vectors/foreign/solana_devnet_payout.json");
/// Live MPC vectors; the Solana ones carry the attested Streamflow account bytes.
const LIVE_VECTORS: &str = include_str!("vectors/foreign/mpc_live_vectors.json");

fn key(text: &str) -> Pubkey {
    parse_pubkey(text).expect("base58 key")
}

/// The attested account of the live vector with this label.
fn live_account(label: &str) -> (Pubkey, SvmAccount) {
    let vectors: Value = serde_json::from_str(LIVE_VECTORS).unwrap();
    let vector = vectors
        .as_array()
        .unwrap()
        .iter()
        .find(|vector| vector["label"] == label)
        .unwrap();
    let account = &vector["rpc_accounts"][0];
    let pubkey = key(account["pubkey"].as_str().unwrap());
    let state = SvmAccount {
        owner: Bytes32(key(account["owner"].as_str().unwrap())),
        data: parse_hex(account["data_hex"].as_str().unwrap()).unwrap(),
    };
    (pubkey, state)
}

#[test]
fn compact_u16_encoding() {
    for (value, encoding) in [
        (0u16, vec![0u8]),
        (127, vec![0x7f]),
        (128, vec![0x80, 0x01]),
        (16383, vec![0xff, 0x7f]),
        (16384, vec![0x80, 0x80, 0x01]),
    ] {
        let mut out = vec![];
        push_compact_u16(&mut out, value);
        assert_eq!(out, encoding);
    }
}

#[test]
fn constants_match_their_base58_and_discriminators_their_names() {
    assert_eq!(
        format_pubkey(&SYSTEM_PROGRAM),
        "11111111111111111111111111111111"
    );
    assert_eq!(
        format_pubkey(&SYSVAR_RECENT_BLOCKHASHES),
        "SysvarRecentB1ockHashes11111111111111111111"
    );
    assert_eq!(
        format_pubkey(&SYSVAR_RENT),
        "SysvarRent111111111111111111111111111111111"
    );
    assert_eq!(
        format_pubkey(&TOKEN_PROGRAM),
        "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
    );
    assert_eq!(
        format_pubkey(&ASSOCIATED_TOKEN_PROGRAM),
        "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
    );
    assert_eq!(
        format_pubkey(&STREAMFLOW_DEVNET_PROGRAM),
        "HqDGZjaVRXJ9MGRQEw7qDc2rAr6iH1n1kAQdCZaCMfMZ"
    );
    assert_eq!(
        format_pubkey(&STREAMFLOW_TREASURY),
        "5SEpbdjFK5FxwTvfsGMXVQTD2v4M2c5tyRTxhdsPkgDw"
    );
    assert_eq!(
        &sha256(b"global:withdraw")[..8],
        &STREAMFLOW_WITHDRAW_DISCRIMINATOR
    );
    assert_eq!(
        &sha256(b"global:transfer_recipient")[..8],
        &STREAMFLOW_TRANSFER_RECIPIENT_DISCRIMINATOR
    );
    for constant in [SYSTEM_PROGRAM, TOKEN_PROGRAM, STREAMFLOW_TREASURY] {
        assert_eq!(parse_pubkey(&format_pubkey(&constant)).unwrap(), constant);
    }
    assert_eq!(
        parse_near_ed25519("ed25519:ERKmrj6yveQaKExLsfuiJZW19MYnwFhUUwdLBPniG6GL").unwrap(),
        key("ERKmrj6yveQaKExLsfuiJZW19MYnwFhUUwdLBPniG6GL")
    );
    assert_eq!(
        parse_near_ed25519("secp256k1:abc"),
        Err(SolanaError::KeyPrefix)
    );
    assert_eq!(parse_pubkey("0OIl"), Err(SolanaError::Key));
    assert_eq!(parse_pubkey("abc"), Err(SolanaError::Key));
}

/// A durable nonce account created on devnet with `SystemProgram.createNonceAccount({ basePubkey,
/// seed })` (`@solana/web3.js` 1.99.0), transaction
/// `2UuQMx7UNH4iYXVKU45zimdVXP87w9acmP9wksNqkDQ6LaAZpLyFFHwMG93ErsT3jqDZ7tfjQQDBjmAhHmcfV1LM`:
/// the System program accepted the address, which `PublicKey.createWithSeed` also gives.
#[test]
fn create_with_seed_matches_the_system_program() {
    let base = key("6uMy1iYdq9EpL6W3EjsKdUZfrJ5G1shD1Da1QNe8gH7n");
    let address = create_with_seed(&base, "0123456789abcdef01234567probe001", &SYSTEM_PROGRAM);
    assert_eq!(
        address.map(|a| format_pubkey(&a)),
        Ok("52gAaTfvLXp2WZMuK6KBkF3fj5K4mjqnJrSUDPwsMhaH".to_string())
    );
    assert_eq!(
        create_with_seed(&base, &"x".repeat(33), &SYSTEM_PROGRAM),
        Err(SolanaError::Seeds)
    );
}

/// Two devnet mints read at `finalized` (slot 518,501,161): Circle's devnet USDC, which has a
/// freeze authority, and the demo mint, which has none.
#[test]
fn mint_accounts_parse_their_decimals_and_freeze_authority() {
    let usdc = parse_hex("01000000eb8544cf9118277a9632e9995066651bbfb1408b8573ebc02e53efab5abf0e0bb1c44b32ac3806e2060101000000a80633ff067d88dfa5d4357bf44e26cecccf0866688103c6ba609fa44c18d208").unwrap();
    let mint = Mint::parse(&usdc).unwrap();
    assert_eq!(mint.decimals, 6);
    assert_eq!(
        mint.freeze_authority.map(|a| format_pubkey(&a)),
        Some("CJtyoKSLrktozQzjERTiK3btQtiTK3nN4QrqGHLidyCT".to_string())
    );
    let demo = parse_hex("0100000057b457bd2d0c395140edb9196fc047fb35157cc1d9731a90ee6de7fd4e8d8a3100f2052a010000000601000000000000000000000000000000000000000000000000000000000000000000000000").unwrap();
    assert_eq!(
        Mint::parse(&demo),
        Ok(Mint {
            decimals: 6,
            freeze_authority: None
        })
    );
    assert_eq!(Mint::parse(&demo[..81]), Err(SolanaError::MintLength));
    let mut bad_tag = demo.clone();
    bad_tag[46] = 2;
    assert_eq!(Mint::parse(&bad_tag), Err(SolanaError::MintState));
    let mut uninitialized = demo;
    uninitialized[45] = 0;
    assert_eq!(Mint::parse(&uninitialized), Err(SolanaError::MintState));
}

#[test]
fn associated_token_address_matches_spl_token() {
    let vectors: Value = serde_json::from_str(WEB3JS_MESSAGES).unwrap();
    let owner = key(vectors["ata"]["owner"].as_str().unwrap());
    let mint = key(vectors["ata"]["mint"].as_str().unwrap());
    let ata = associated_token_address(&owner, &mint).unwrap();
    assert_eq!(
        format_pubkey(&ata),
        vectors["ata"]["address"].as_str().unwrap()
    );
    assert!(!is_on_curve(&ata));
    assert!(is_on_curve(&owner));
    let (found, bump) =
        find_program_address(&[&owner, &TOKEN_PROGRAM, &mint], &ASSOCIATED_TOKEN_PROGRAM).unwrap();
    assert_eq!(found, ata);
    assert_eq!(
        create_program_address(
            &[&owner, &TOKEN_PROGRAM, &mint, &[bump]],
            &ASSOCIATED_TOKEN_PROGRAM
        )
        .unwrap(),
        Some(ata)
    );
    let too_long = [0u8; 33];
    assert_eq!(
        create_program_address(&[&too_long], &SYSTEM_PROGRAM),
        Err(SolanaError::Seeds)
    );
    let sixteen: Vec<&[u8]> = vec![&[1u8][..]; 16];
    assert_eq!(
        find_program_address(&sixteen, &SYSTEM_PROGRAM),
        Err(SolanaError::Seeds)
    );
}

#[test]
fn messages_match_web3js_byte_for_byte() {
    let vectors: Value = serde_json::from_str(WEB3JS_MESSAGES).unwrap();
    let named = |name: &str| key(vectors["keys"][name].as_str().unwrap());
    let (vault, gas, nonce, dest, mint, nonce_value) = (
        named("vault"),
        named("gas"),
        named("nonce"),
        named("dest"),
        named("mint"),
        named("nonceValue"),
    );
    let vault_ata = associated_token_address(&vault, &mint).unwrap();
    let dest_ata = associated_token_address(&dest, &mint).unwrap();
    let metadata = named("metadata");
    let escrow = named("escrowTokens");
    let partner = named("partner");
    let withdraw_accounts = StreamflowWithdrawAccounts {
        authority: vault,
        recipient: vault,
        recipient_tokens: vault_ata,
        metadata,
        escrow_tokens: escrow,
        streamflow_treasury: STREAMFLOW_TREASURY,
        streamflow_treasury_tokens: associated_token_address(&STREAMFLOW_TREASURY, &mint).unwrap(),
        partner,
        partner_tokens: associated_token_address(&partner, &mint).unwrap(),
        mint,
    };
    let cases: Vec<(&str, Vec<Instruction>)> = vec![
        (
            "nonce_sol_transfer",
            vec![
                advance_nonce_account(nonce, vault),
                system_transfer(vault, dest, 1_000_000),
            ],
        ),
        (
            "nonce_spl_transfer",
            vec![
                advance_nonce_account(nonce, vault),
                spl_transfer_checked(vault_ata, mint, dest_ata, vault, 2_500_000, 6),
            ],
        ),
        (
            "nonce_streamflow_withdraw_then_spl",
            vec![
                advance_nonce_account(nonce, vault),
                streamflow_withdraw(
                    STREAMFLOW_DEVNET_PROGRAM,
                    &withdraw_accounts,
                    STREAMFLOW_WITHDRAW_ALL,
                ),
                spl_transfer_checked(vault_ata, mint, dest_ata, vault, 2_500_000, 6),
            ],
        ),
        (
            "nonce_ata_then_transfer_recipient",
            vec![
                advance_nonce_account(nonce, vault),
                create_associated_token_account_idempotent(gas, vault_ata, vault, mint),
                streamflow_transfer_recipient(
                    STREAMFLOW_DEVNET_PROGRAM,
                    dest,
                    vault,
                    vault_ata,
                    metadata,
                    mint,
                ),
            ],
        ),
        (
            "create_nonce_account",
            vec![
                create_account(
                    gas,
                    nonce,
                    1_447_680,
                    NONCE_ACCOUNT_LEN as u64,
                    SYSTEM_PROGRAM,
                ),
                initialize_nonce_account(nonce, vault),
            ],
        ),
    ];
    for (name, instructions) in cases {
        let message = LegacyMessage::compile(&gas, &instructions, nonce_value).unwrap();
        assert_eq!(
            hex::encode(message.serialize()),
            vectors["messages"][name].as_str().unwrap(),
            "case {name}"
        );
        assert_eq!(message.signers()[0], gas);
    }
}

#[test]
fn devnet_payout_message_is_rebuilt_and_assembled_in_signer_order() {
    let payout: Value = serde_json::from_str(DEVNET_PAYOUT).unwrap();
    let named = |name: &str| key(payout["keys"][name].as_str().unwrap());
    let (vault, gas, nonce, dest, nonce_value) = (
        named("vault"),
        named("gas"),
        named("nonce"),
        named("dest"),
        named("nonce_value"),
    );
    let lamports = payout["lamports"].as_u64().unwrap();
    let message = LegacyMessage::compile(
        &gas,
        &[
            advance_nonce_account(nonce, vault),
            system_transfer(vault, dest, lamports),
        ],
        nonce_value,
    )
    .unwrap();
    let bytes = message.serialize();
    assert_eq!(hex::encode(&bytes), payout["message_hex"].as_str().unwrap());
    assert_eq!(message.signers(), &[gas, vault]);
    assert_eq!(message.recent_blockhash, nonce_value);
    assert_eq!(message.num_required_signatures, 2);
    assert_eq!(message.num_readonly_signed, 0);
    assert_eq!(message.num_readonly_unsigned, 2);

    let gas_signature = [1u8; 64];
    let vault_signature = [2u8; 64];
    let transaction = assemble_transaction(&bytes, &[gas_signature, vault_signature]).unwrap();
    assert_eq!(transaction[0], 2);
    assert_eq!(&transaction[1..65], &gas_signature);
    assert_eq!(&transaction[65..129], &vault_signature);
    assert_eq!(&transaction[129..], &bytes[..]);
    assert_eq!(
        assemble_transaction(&bytes, &[gas_signature]),
        Err(SolanaError::SignatureCount)
    );
    let oversized = vec![0u8; MAX_TRANSACTION_LEN];
    assert_eq!(
        assemble_transaction(&oversized, &[]),
        Err(SolanaError::TransactionTooLarge)
    );
}

#[test]
fn live_streamflow_account_decodes_with_its_distinctive_values() {
    let (pubkey, account) = live_account("own_stream_finalized_expected");
    assert_eq!(
        format_pubkey(&pubkey),
        "J2MxwxkCVey1o7SQUgLh4VPuomnnhtYJbkzVbGf4jdPc"
    );
    assert_eq!(account.owner.0, STREAMFLOW_DEVNET_PROGRAM);
    assert_eq!(account.data.len(), STREAMFLOW_METADATA_LEN);
    let metadata = StreamflowMetadata::parse(&account.data).unwrap();
    assert_eq!(metadata.magic, 4);
    assert_eq!(metadata.version, 4);
    assert_eq!(metadata.created_at, 1793754329);
    assert_eq!(metadata.amount_withdrawn, 0);
    assert_eq!(metadata.canceled_at, 0);
    assert_eq!(metadata.end_time, 1793762929);
    assert_eq!(metadata.last_withdrawn_at, 0);
    assert_eq!(
        format_pubkey(&metadata.sender),
        "6uMy1iYdq9EpL6W3EjsKdUZfrJ5G1shD1Da1QNe8gH7n"
    );
    assert_eq!(
        format_pubkey(&metadata.sender_tokens),
        "5xHrkf3XfsNhxsoqV3h3e47JizP3XNj9i2GsBNSqKM2W"
    );
    assert_eq!(
        format_pubkey(&metadata.recipient),
        "2uhcVxvU947Yvp8rq1WChqqvkxrTeNZFR58MsS1t2d3w"
    );
    assert_eq!(
        format_pubkey(&metadata.recipient_tokens),
        "RphSacTYdLUacrc8sr5EHiNerYPKFHeNeKRAW5Wms6R"
    );
    assert_eq!(
        format_pubkey(&metadata.mint),
        "3q81mxTA7rricmjJQaiZk9HbZzF2Pt8aN5SJaJcXvZ4w"
    );
    assert_eq!(
        format_pubkey(&metadata.escrow_tokens),
        "3r3WwZyXsNss9p3t35xmJkNtnp8m9NxqFgEBKmpfBrZb"
    );
    assert_eq!(metadata.streamflow_treasury, STREAMFLOW_TREASURY);
    assert_eq!(
        format_pubkey(&metadata.streamflow_treasury_tokens),
        "FNuVj8TZeS564CKqqFh74ZCc6YB6vkN6MNrThLNTWiVt"
    );
    assert_eq!(metadata.partner, metadata.sender);
    assert_eq!(metadata.partner_tokens, metadata.sender_tokens);
    assert_eq!(metadata.start_time, 1793754629);
    assert_eq!(metadata.net_amount_deposited, 1_234_567_890);
    assert_eq!(metadata.period, 77);
    assert_eq!(metadata.amount_per_period, 10_000_000);
    assert_eq!(metadata.cliff, 1793755229);
    assert_eq!(metadata.cliff_amount, 234_567_890);
    assert!(!metadata.cancelable_by_sender);
    assert!(metadata.cancelable_by_recipient);
    assert!(!metadata.automatic_withdrawal);
    assert!(!metadata.transferable_by_sender);
    assert!(metadata.transferable_by_recipient);
    assert!(metadata.can_topup);
    assert_eq!(metadata.withdraw_frequency, 77);
    assert!(!metadata.pausable);
    assert!(!metadata.can_update_rate);
    assert!(!metadata.closed);
    assert_eq!(metadata.current_pause_start, 0);
    assert_eq!(metadata.pause_cumulative, 0);
    assert_eq!(metadata.last_rate_change_time, 0);
    assert_eq!(metadata.funds_unlocked_at_last_rate_change, 0);
    assert_eq!(metadata.end_time, metadata.cliff + 100 * metadata.period);

    assert_eq!(
        metadata.streamflow_treasury_tokens,
        associated_token_address(&STREAMFLOW_TREASURY, &metadata.mint).unwrap()
    );
    assert_eq!(
        metadata.recipient_tokens,
        associated_token_address(&metadata.recipient, &metadata.mint).unwrap()
    );
    let expected = StreamflowParams {
        start_time: 1793754629,
        cliff: 1793755229,
        cliff_amount: 234_567_890,
        period: 77,
        amount_per_period: 10_000_000,
        net_amount_deposited: 1_234_567_890,
        end_time: 1793762929,
        can_topup: true,
        ..StreamflowParams::default()
    };
    assert_eq!(metadata.params(), expected);
    assert_eq!(
        StreamflowStream::new(metadata.params()),
        Err(rose_engine::unlock::ScheduleError::Topup),
        "the live stream allows top-ups, which the unlock math refuses"
    );
    let stream = StreamflowStream::new(StreamflowParams {
        can_topup: false,
        ..expected
    })
    .unwrap();
    assert_eq!(stream.unlocked_amount(metadata.cliff), 234_567_890);
    assert_eq!(stream.unlocked_amount(metadata.end_time), 1_234_567_890);
}

#[test]
fn deposit_eligibility_checks_every_flag() {
    let (pubkey, account) = live_account("own_stream_finalized_expected");
    let metadata = StreamflowMetadata::parse(&account.data).unwrap();
    let vault = metadata.recipient;
    let program = STREAMFLOW_DEVNET_PROGRAM;

    assert_eq!(
        StreamflowMetadata::check_deposit(&account, &program, &vault),
        Err(StreamflowError::CanTopup)
    );
    let mut eligible = account.clone();
    eligible.data[462] = 0;
    let checked = StreamflowMetadata::check_deposit(&eligible, &program, &vault).unwrap();
    assert!(!checked.can_topup);
    let accounts = StreamflowWithdrawAccounts::for_vault(&checked, pubkey, vault).unwrap();
    assert_eq!(accounts.authority, vault);
    assert_eq!(accounts.recipient_tokens, checked.recipient_tokens);
    assert_eq!(accounts.escrow_tokens, checked.escrow_tokens);
    assert_eq!(
        accounts.streamflow_treasury_tokens,
        checked.streamflow_treasury_tokens
    );
    assert_eq!(accounts.partner_tokens, checked.partner_tokens);
    let withdraw = streamflow_withdraw(program, &accounts, STREAMFLOW_WITHDRAW_ALL);
    assert_eq!(withdraw.data.len(), 26);
    assert_eq!(withdraw.accounts.len(), 11);
    assert_eq!(withdraw.accounts[0], AccountMeta::writable(vault, true));
    assert_eq!(
        withdraw.accounts[10],
        AccountMeta::readonly(TOKEN_PROGRAM, false)
    );

    let mut other_vault = [0u8; 32];
    other_vault[0] = 1;
    assert_eq!(
        StreamflowMetadata::check_deposit(&eligible, &program, &other_vault),
        Err(StreamflowError::Recipient)
    );
    assert_eq!(
        StreamflowMetadata::check_deposit(&eligible, &SYSTEM_PROGRAM, &vault),
        Err(StreamflowError::Owner)
    );
    let cases: [(usize, u8, StreamflowError); 13] = [
        (671, 1, StreamflowError::Closed),
        (25, 1, StreamflowError::Canceled),
        (457, 1, StreamflowError::CancelableBySender),
        (460, 1, StreamflowError::TransferableBySender),
        (461, 0, StreamflowError::NotTransferableByRecipient),
        (459, 1, StreamflowError::AutomaticWithdrawal),
        (539, 1, StreamflowError::Pausable),
        (540, 1, StreamflowError::CanUpdateRate),
        (462, 1, StreamflowError::CanTopup),
        (672, 1, StreamflowError::Modified),
        (680, 1, StreamflowError::Modified),
        (696, 1, StreamflowError::Modified),
        (458, 2, StreamflowError::Flag),
    ];
    for (offset, value, error) in cases {
        let mut mutated = eligible.clone();
        mutated.data[offset] = value;
        assert_eq!(
            StreamflowMetadata::check_deposit(&mutated, &program, &vault),
            Err(error),
            "offset {offset}"
        );
    }
    let mut short = eligible.clone();
    short.data.pop();
    assert_eq!(
        StreamflowMetadata::check_deposit(&short, &program, &vault),
        Err(StreamflowError::Length)
    );
}

#[test]
fn other_live_streamflow_accounts_parse() {
    for label in ["sol_finalized", "sol_volatile_finalized"] {
        let (_, account) = live_account(label);
        assert_eq!(account.owner.0, STREAMFLOW_DEVNET_PROGRAM);
        let metadata = StreamflowMetadata::parse(&account.data).unwrap();
        assert!(metadata.net_amount_deposited > 0, "{label}");
        assert!(metadata.period > 0, "{label}");
        assert!(StreamflowStream::new(metadata.params()).is_ok(), "{label}");
        let foreign_vault = [0xffu8; 32];
        assert_eq!(
            StreamflowMetadata::check_deposit(&account, &STREAMFLOW_DEVNET_PROGRAM, &foreign_vault),
            Err(StreamflowError::Recipient),
            "{label}"
        );
    }
}

#[test]
fn nonce_accounts_parse_strictly() {
    let authority = [7u8; 32];
    let mut data = vec![0u8; NONCE_ACCOUNT_LEN];
    data[..4].copy_from_slice(&1u32.to_le_bytes());
    data[4..8].copy_from_slice(&1u32.to_le_bytes());
    data[8..40].copy_from_slice(&authority);
    data[40..72].copy_from_slice(&[9u8; 32]);
    data[72..80].copy_from_slice(&5000u64.to_le_bytes());
    let nonce = NonceAccount::parse(&data).unwrap();
    assert_eq!(nonce.authority, authority);
    assert_eq!(nonce.nonce, [9u8; 32]);
    assert_eq!(nonce.lamports_per_signature, 5000);

    let account = SvmAccount {
        owner: Bytes32(SYSTEM_PROGRAM),
        data: data.clone(),
    };
    assert_eq!(
        NonceAccount::from_account_state(&account, &authority).unwrap(),
        nonce
    );
    assert_eq!(
        NonceAccount::from_account_state(&account, &[8u8; 32]),
        Err(SolanaError::NonceAuthority)
    );
    let foreign_owner = SvmAccount {
        owner: Bytes32(TOKEN_PROGRAM),
        data: data.clone(),
    };
    assert_eq!(
        NonceAccount::from_account_state(&foreign_owner, &authority),
        Err(SolanaError::NonceOwner)
    );

    let mut uninitialized = data.clone();
    uninitialized[4] = 0;
    assert_eq!(
        NonceAccount::parse(&uninitialized),
        Err(SolanaError::NonceState)
    );
    let mut legacy = data.clone();
    legacy[0] = 0;
    assert_eq!(NonceAccount::parse(&legacy), Err(SolanaError::NonceState));
    assert_eq!(
        NonceAccount::parse(&data[..79]),
        Err(SolanaError::NonceLength)
    );
}

fn instruction_strategy() -> impl Strategy<Value = Instruction> {
    (
        0u8..6,
        proptest::collection::vec((0u8..6, any::<bool>(), any::<bool>()), 0..6),
        proptest::collection::vec(any::<u8>(), 0..8),
    )
        .prop_map(|(program, accounts, data)| Instruction {
            program_id: [program; 32],
            accounts: accounts
                .into_iter()
                .map(|(index, is_signer, is_writable)| AccountMeta {
                    pubkey: [index; 32],
                    is_signer,
                    is_writable,
                })
                .collect(),
            data,
        })
}

proptest! {
    #[test]
    fn compiled_messages_are_consistent(
        fee_payer in 0u8..6,
        instructions in proptest::collection::vec(instruction_strategy(), 0..4),
        blockhash in any::<[u8; 32]>(),
    ) {
        let fee_payer = [fee_payer; 32];
        let message = LegacyMessage::compile(&fee_payer, &instructions, blockhash).unwrap();
        prop_assert_eq!(message.account_keys[0], fee_payer);
        let signers = usize::from(message.num_required_signatures);
        let readonly_signed = usize::from(message.num_readonly_signed);
        let readonly_unsigned = usize::from(message.num_readonly_unsigned);
        let keys = message.account_keys.len();
        prop_assert!(signers >= 1 && readonly_signed <= signers);
        prop_assert!(readonly_unsigned <= keys - signers);
        let mut seen = std::collections::HashSet::new();
        for key in &message.account_keys {
            prop_assert!(seen.insert(*key));
        }
        for (instruction, compiled) in instructions.iter().zip(&message.instructions) {
            prop_assert_eq!(
                message.account_keys[usize::from(compiled.program_id_index)],
                instruction.program_id
            );
            for (account, index) in instruction.accounts.iter().zip(&compiled.account_indexes) {
                let index = usize::from(*index);
                prop_assert_eq!(message.account_keys[index], account.pubkey);
                if account.is_signer {
                    prop_assert!(index < signers);
                }
                if account.is_writable {
                    let readonly = (index < signers && index >= signers - readonly_signed)
                        || index >= keys - readonly_unsigned;
                    prop_assert!(!readonly);
                }
            }
            prop_assert_eq!(&compiled.data, &instruction.data);
        }
        let bytes = message.serialize();
        prop_assert_eq!(bytes[0], message.num_required_signatures);
        prop_assert_eq!(&bytes[4..36], &fee_payer[..]);
    }
}
