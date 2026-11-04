//! Solana devnet byte layouts: legacy messages, the instructions the engine signs, program-derived
//! addresses, nonce accounts and Streamflow stream metadata.
//!
//! Sources:
//!
//! - Legacy message wire format and account ordering: `@solana/web3.js` 1.98.4
//!   `src/message/compiled-keys.ts` (`CompiledKeys.compile`, `getMessageComponents`) and
//!   `src/message/legacy.ts` (`Message.serialize`), the path of
//!   `TransactionMessage.compileToLegacyMessage`. Keys are the fee payer first, then every key in
//!   order of first appearance (an instruction's program id is registered before its accounts),
//!   partitioned into writable signers, read-only signers, writable non-signers and read-only
//!   non-signers. Lengths are "short vec" (compact-u16) prefixed. The legacy `Transaction`
//!   builder of the same library sorts differently (`localeCompare`), so the app side must use
//!   `compileToLegacyMessage` when it rebuilds a message.
//! - System program instructions (`solana-system-interface` 1.0, `src/instruction.rs`):
//!   `CreateAccount = 0`, `Transfer = 2`, `AdvanceNonceAccount = 4`, `InitializeNonceAccount = 6`,
//!   bincode-encoded as a little-endian `u32` tag followed by the fields.
//! - Nonce account state (`solana-nonce` 2.x, `src/state.rs` and `src/versions.rs`): 80 bytes,
//!   `Versions` tag `u32` (`Current = 1`), `State` tag `u32` (`Initialized = 1`), `authority`
//!   (32), `durable_nonce` (32), `lamports_per_signature` (`u64`).
//! - SPL Token `TransferChecked` (`spl-token` 4.x `src/instruction.rs`, index 12; data `12 ||
//!   amount u64 LE || decimals`) and the Associated Token Account program `CreateIdempotent`
//!   (`spl-associated-token-account` 3.x `src/instruction.rs`, index 1).
//! - Program-derived addresses (`solana-pubkey` 2.x `src/lib.rs`, `create_program_address` and
//!   `find_program_address`): `sha256(seeds || program_id || "ProgramDerivedAddress")`, rejected
//!   when it decompresses as an Edwards point; the bump is tried from 255 down.
//! - Addresses with seed (`solana-pubkey` 2.x `Pubkey::create_with_seed`): `sha256(base || seed
//!   || owner)` for a seed of at most 32 bytes, with no curve check; the System program's
//!   `CreateAccountWithSeed` (and so `createNonceAccount` with a seed) requires the new account
//!   to be that address.
//! - SPL Token mint (`spl-token` 4.x `src/state.rs`, `Mint::LEN = 82`): `mint_authority`
//!   `COption<Pubkey>` (u32 tag + 32 bytes), `supply` u64, `decimals` u8 at 44, `is_initialized`
//!   at 45, `freeze_authority` `COption<Pubkey>` at 46 (tag) and 50..82.
//! - Streamflow: `streamflow-finance/js-sdk` at `v13.4.0` (commit
//!   `fb236fff325ab02d7ff5d0ff5e393be8934cda9d`), `packages/stream/solana/instructions.ts`
//!   (`withdrawStreamInstruction` line 455, `transferStreamInstruction` line 618),
//!   `packages/stream/solana/layout.ts` (`streamLayout`) and `constants.ts`; cross-checked with
//!   `streamflow-finance/rust-sdk` at commit `63df7d7b831340daa27f31d007eec2a98380364c`
//!   (`streamflow-sdk` 0.15.0), `programs/streamflow-sdk/src/lib.rs` (`declare_id` line 12,
//!   `withdraw` line 540, `transfer_recipient` line 585, account structs `Withdraw` line 804 and
//!   `Transfer` line 902) and `src/state.rs` (`Contract`, `CreateParams`, `METADATA_LEN = 1104`,
//!   `STRM_TREASURY`). Every offset of the metadata table was confirmed on a stream created with
//!   distinctive values in the day-1 spike.
//!
//! The integration tests reproduce five messages compiled by `@solana/web3.js` byte for byte, the
//! payout transaction broadcast on devnet, the ATA computed by `@solana/spl-token`, and decode the
//! live Streamflow accounts attested by the MPC.

use curve25519_dalek::edwards::CompressedEdwardsY;
use sha2::{Digest, Sha256};

use super::mpc::SvmAccount;
use crate::unlock::StreamflowParams;

/// 32-byte account address.
pub type Pubkey = [u8; 32];
/// 32-byte hash (blockhash or durable nonce value).
pub type Hash = [u8; 32];

/// `11111111111111111111111111111111`.
pub const SYSTEM_PROGRAM: Pubkey = [0u8; 32];
/// `SysvarRecentB1ockHashes11111111111111111111`.
pub const SYSVAR_RECENT_BLOCKHASHES: Pubkey = [
    0x06, 0xa7, 0xd5, 0x17, 0x19, 0x2c, 0x56, 0x8e, 0xe0, 0x8a, 0x84, 0x5f, 0x73, 0xd2, 0x97, 0x88,
    0xcf, 0x03, 0x5c, 0x31, 0x45, 0xb2, 0x1a, 0xb3, 0x44, 0xd8, 0x06, 0x2e, 0xa9, 0x40, 0x00, 0x00,
];
/// `SysvarRent111111111111111111111111111111111`.
pub const SYSVAR_RENT: Pubkey = [
    0x06, 0xa7, 0xd5, 0x17, 0x19, 0x2c, 0x5c, 0x51, 0x21, 0x8c, 0xc9, 0x4c, 0x3d, 0x4a, 0xf1, 0x7f,
    0x58, 0xda, 0xee, 0x08, 0x9b, 0xa1, 0xfd, 0x44, 0xe3, 0xdb, 0xd9, 0x8a, 0x00, 0x00, 0x00, 0x00,
];
/// `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` (classic SPL Token).
pub const TOKEN_PROGRAM: Pubkey = [
    0x06, 0xdd, 0xf6, 0xe1, 0xd7, 0x65, 0xa1, 0x93, 0xd9, 0xcb, 0xe1, 0x46, 0xce, 0xeb, 0x79, 0xac,
    0x1c, 0xb4, 0x85, 0xed, 0x5f, 0x5b, 0x37, 0x91, 0x3a, 0x8c, 0xf5, 0x85, 0x7e, 0xff, 0x00, 0xa9,
];
/// `ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL`.
pub const ASSOCIATED_TOKEN_PROGRAM: Pubkey = [
    0x8c, 0x97, 0x25, 0x8f, 0x4e, 0x24, 0x89, 0xf1, 0xbb, 0x3d, 0x10, 0x29, 0x14, 0x8e, 0x0d, 0x83,
    0x0b, 0x5a, 0x13, 0x99, 0xda, 0xff, 0x10, 0x84, 0x04, 0x8e, 0x7b, 0xd8, 0xdb, 0xe9, 0xf8, 0x59,
];
/// `HqDGZjaVRXJ9MGRQEw7qDc2rAr6iH1n1kAQdCZaCMfMZ`, the Streamflow program on devnet.
pub const STREAMFLOW_DEVNET_PROGRAM: Pubkey = [
    0xfa, 0x14, 0xbd, 0xd4, 0xac, 0x5c, 0x2f, 0x93, 0x17, 0x03, 0x66, 0xf0, 0xa4, 0x5f, 0x72, 0xf3,
    0x50, 0x34, 0xaf, 0x99, 0x6d, 0xe0, 0xab, 0x1c, 0x33, 0xff, 0x29, 0xb4, 0x4d, 0x09, 0x2d, 0xf0,
];
/// `5SEpbdjFK5FxwTvfsGMXVQTD2v4M2c5tyRTxhdsPkgDw` (`STRM_TREASURY`).
pub const STREAMFLOW_TREASURY: Pubkey = [
    0x41, 0xe5, 0xe5, 0x1d, 0x66, 0x43, 0x46, 0xda, 0xf4, 0x08, 0xbc, 0x3c, 0xa5, 0x4d, 0x29, 0xff,
    0x17, 0x32, 0xc3, 0x1f, 0x49, 0x1b, 0xdb, 0x02, 0x90, 0x4d, 0xbd, 0xb8, 0x7a, 0x8c, 0x70, 0xc2,
];

/// `sha256("global:withdraw")[..8]`, the Anchor discriminator of `withdraw`.
pub const STREAMFLOW_WITHDRAW_DISCRIMINATOR: [u8; 8] =
    [0xb7, 0x12, 0x46, 0x9c, 0x94, 0x6d, 0xa1, 0x22];
/// `sha256("global:transfer_recipient")[..8]`.
pub const STREAMFLOW_TRANSFER_RECIPIENT_DISCRIMINATOR: [u8; 8] =
    [0xeb, 0xf6, 0xe0, 0x40, 0x69, 0xa6, 0x14, 0x8a];
/// `u64::MAX` asks the program to withdraw everything unlocked (js-sdk
/// `WITHDRAW_AVAILABLE_AMOUNT`).
pub const STREAMFLOW_WITHDRAW_ALL: u64 = u64::MAX;
/// Size of a Streamflow metadata account (`METADATA_LEN`).
pub const STREAMFLOW_METADATA_LEN: usize = 1104;
/// Size of a System nonce account (`nonce::State::size()`).
pub const NONCE_ACCOUNT_LEN: usize = 80;
/// Largest transaction the network accepts (`PACKET_DATA_SIZE`).
pub const MAX_TRANSACTION_LEN: usize = 1232;
/// Most seeds a program-derived address may have (`MAX_SEEDS`), bump included.
pub const MAX_SEEDS: usize = 16;
/// Longest seed (`MAX_SEED_LEN`).
pub const MAX_SEED_LEN: usize = 32;

/// SHA-256.
pub fn sha256(data: &[u8]) -> Hash {
    Sha256::digest(data).into()
}

/// Why bytes do not form a valid key, message or account.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SolanaError {
    /// Malformed base58 or not 32 bytes.
    Key,
    /// The NEAR key does not start with `ed25519:`.
    KeyPrefix,
    /// A message references more than 256 accounts.
    TooManyAccounts,
    /// Too many or too long seeds.
    Seeds,
    /// No bump gives an off-curve address (probability about `2^-256`).
    NoViableBump,
    /// The number of signatures differs from the message header.
    SignatureCount,
    /// The transaction exceeds [`MAX_TRANSACTION_LEN`].
    TransactionTooLarge,
    /// The nonce account is not owned by the System program.
    NonceOwner,
    /// The nonce account is not 80 bytes.
    NonceLength,
    /// The nonce account is not a `Current` version, initialized nonce.
    NonceState,
    /// The nonce authority is not the expected key.
    NonceAuthority,
    /// The token account is not owned by the classic SPL Token program.
    TokenProgram,
    /// The token account is not 165 bytes.
    TokenLength,
    /// The token account holds another mint.
    TokenMint,
    /// The token account belongs to another owner.
    TokenOwner,
    /// The token account is not initialized, or is frozen.
    TokenState,
    /// The mint account is not 82 bytes.
    MintLength,
    /// The mint is not initialized, or a `COption` tag is neither 0 nor 1.
    MintState,
}

/// Parses a base58 public key.
pub fn parse_pubkey(text: &str) -> Result<Pubkey, SolanaError> {
    let mut key = [0u8; 32];
    match bs58::decode(text).onto(&mut key) {
        Ok(32) => Ok(key),
        _ => Err(SolanaError::Key),
    }
}

/// Base58 rendering of a public key.
pub fn format_pubkey(key: &Pubkey) -> String {
    bs58::encode(key).into_string()
}

/// `"ed25519:<base58>"` from `derived_public_key(.., domain_id: 1)`: the base58 part is the
/// Solana address.
pub fn parse_near_ed25519(key: &str) -> Result<Pubkey, SolanaError> {
    parse_pubkey(key.strip_prefix("ed25519:").ok_or(SolanaError::KeyPrefix)?)
}

/// `true` when the bytes decompress as an Edwards point, which disqualifies a program-derived
/// address.
pub fn is_on_curve(key: &Pubkey) -> bool {
    CompressedEdwardsY(*key).decompress().is_some()
}

/// `Pubkey::create_program_address`: `sha256(seeds || program_id || "ProgramDerivedAddress")`,
/// `None` when the result is on the curve.
pub fn create_program_address(
    seeds: &[&[u8]],
    program_id: &Pubkey,
) -> Result<Option<Pubkey>, SolanaError> {
    if seeds.len() > MAX_SEEDS || seeds.iter().any(|seed| seed.len() > MAX_SEED_LEN) {
        return Err(SolanaError::Seeds);
    }
    let mut preimage =
        Vec::with_capacity(seeds.iter().map(|seed| seed.len()).sum::<usize>() + 32 + 21);
    for seed in seeds {
        preimage.extend_from_slice(seed);
    }
    preimage.extend_from_slice(program_id);
    preimage.extend_from_slice(b"ProgramDerivedAddress");
    let candidate = sha256(&preimage);
    Ok((!is_on_curve(&candidate)).then_some(candidate))
}

/// `Pubkey::find_program_address`: the highest bump (255 down to 0) that gives an off-curve key.
pub fn find_program_address(
    seeds: &[&[u8]],
    program_id: &Pubkey,
) -> Result<(Pubkey, u8), SolanaError> {
    if seeds.len() >= MAX_SEEDS {
        return Err(SolanaError::Seeds);
    }
    for bump in (0..=255u8).rev() {
        let bump_seed = [bump];
        let mut with_bump: Vec<&[u8]> = seeds.to_vec();
        with_bump.push(&bump_seed);
        if let Some(key) = create_program_address(&with_bump, program_id)? {
            return Ok((key, bump));
        }
    }
    Err(SolanaError::NoViableBump)
}

/// `Pubkey::create_with_seed`: `sha256(base || seed || owner)` for a seed of at most
/// [`MAX_SEED_LEN`] bytes.
pub fn create_with_seed(base: &Pubkey, seed: &str, owner: &Pubkey) -> Result<Pubkey, SolanaError> {
    if seed.len() > MAX_SEED_LEN {
        return Err(SolanaError::Seeds);
    }
    let mut preimage = Vec::with_capacity(32 + seed.len() + 32);
    preimage.extend_from_slice(base);
    preimage.extend_from_slice(seed.as_bytes());
    preimage.extend_from_slice(owner);
    Ok(sha256(&preimage))
}

/// Associated token account of `owner` for `mint` under the classic SPL Token program.
pub fn associated_token_address(owner: &Pubkey, mint: &Pubkey) -> Result<Pubkey, SolanaError> {
    find_program_address(&[owner, &TOKEN_PROGRAM, mint], &ASSOCIATED_TOKEN_PROGRAM)
        .map(|(key, _)| key)
}

/// One account reference of an instruction.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AccountMeta {
    /// The account.
    pub pubkey: Pubkey,
    /// Whether the account must sign the transaction.
    pub is_signer: bool,
    /// Whether the instruction may modify the account.
    pub is_writable: bool,
}

impl AccountMeta {
    /// A writable account.
    pub const fn writable(pubkey: Pubkey, is_signer: bool) -> Self {
        Self {
            pubkey,
            is_signer,
            is_writable: true,
        }
    }

    /// A read-only account.
    pub const fn readonly(pubkey: Pubkey, is_signer: bool) -> Self {
        Self {
            pubkey,
            is_signer,
            is_writable: false,
        }
    }
}

/// An instruction before compilation.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Instruction {
    /// Program to invoke.
    pub program_id: Pubkey,
    /// Accounts, in the order the program expects.
    pub accounts: Vec<AccountMeta>,
    /// Instruction data.
    pub data: Vec<u8>,
}

/// Appends a Solana "short vec" length (compact-u16).
pub fn push_compact_u16(out: &mut Vec<u8>, mut value: u16) {
    loop {
        let mut byte = (value & 0x7f) as u8;
        value >>= 7;
        if value == 0 {
            out.push(byte);
            return;
        }
        byte |= 0x80;
        out.push(byte);
    }
}

/// System `AdvanceNonceAccount` (index 4). It must be the first instruction of a durable-nonce
/// transaction, whose `recent_blockhash` is the nonce value stored in `nonce`.
pub fn advance_nonce_account(nonce: Pubkey, authority: Pubkey) -> Instruction {
    Instruction {
        program_id: SYSTEM_PROGRAM,
        accounts: vec![
            AccountMeta::writable(nonce, false),
            AccountMeta::readonly(SYSVAR_RECENT_BLOCKHASHES, false),
            AccountMeta::readonly(authority, true),
        ],
        data: 4u32.to_le_bytes().to_vec(),
    }
}

/// System `Transfer` (index 2).
pub fn system_transfer(from: Pubkey, to: Pubkey, lamports: u64) -> Instruction {
    let mut data = 2u32.to_le_bytes().to_vec();
    data.extend_from_slice(&lamports.to_le_bytes());
    Instruction {
        program_id: SYSTEM_PROGRAM,
        accounts: vec![
            AccountMeta::writable(from, true),
            AccountMeta::writable(to, false),
        ],
        data,
    }
}

/// System `CreateAccount` (index 0).
pub fn create_account(
    from: Pubkey,
    new: Pubkey,
    lamports: u64,
    space: u64,
    owner: Pubkey,
) -> Instruction {
    let mut data = 0u32.to_le_bytes().to_vec();
    data.extend_from_slice(&lamports.to_le_bytes());
    data.extend_from_slice(&space.to_le_bytes());
    data.extend_from_slice(&owner);
    Instruction {
        program_id: SYSTEM_PROGRAM,
        accounts: vec![
            AccountMeta::writable(from, true),
            AccountMeta::writable(new, true),
        ],
        data,
    }
}

/// System `InitializeNonceAccount` (index 6).
pub fn initialize_nonce_account(nonce: Pubkey, authority: Pubkey) -> Instruction {
    let mut data = 6u32.to_le_bytes().to_vec();
    data.extend_from_slice(&authority);
    Instruction {
        program_id: SYSTEM_PROGRAM,
        accounts: vec![
            AccountMeta::writable(nonce, false),
            AccountMeta::readonly(SYSVAR_RECENT_BLOCKHASHES, false),
            AccountMeta::readonly(SYSVAR_RENT, false),
        ],
        data,
    }
}

/// SPL Token `TransferChecked` (index 12).
pub fn spl_transfer_checked(
    source: Pubkey,
    mint: Pubkey,
    destination: Pubkey,
    owner: Pubkey,
    amount: u64,
    decimals: u8,
) -> Instruction {
    let mut data = vec![12u8];
    data.extend_from_slice(&amount.to_le_bytes());
    data.push(decimals);
    Instruction {
        program_id: TOKEN_PROGRAM,
        accounts: vec![
            AccountMeta::writable(source, false),
            AccountMeta::readonly(mint, false),
            AccountMeta::writable(destination, false),
            AccountMeta::readonly(owner, true),
        ],
        data,
    }
}

/// Associated Token Account `CreateIdempotent` (index 1): a no-op when the account exists. The
/// engine prepends it, paid by `gas/sol`, wherever a token account might be missing, because
/// vault and deposit addresses hold no SOL.
pub fn create_associated_token_account_idempotent(
    payer: Pubkey,
    ata: Pubkey,
    owner: Pubkey,
    mint: Pubkey,
) -> Instruction {
    Instruction {
        program_id: ASSOCIATED_TOKEN_PROGRAM,
        accounts: vec![
            AccountMeta::writable(payer, true),
            AccountMeta::writable(ata, false),
            AccountMeta::readonly(owner, false),
            AccountMeta::readonly(mint, false),
            AccountMeta::readonly(SYSTEM_PROGRAM, false),
            AccountMeta::readonly(TOKEN_PROGRAM, false),
        ],
        data: vec![1],
    }
}

/// Accounts of a Streamflow `withdraw`, as js-sdk `prepareWithdrawInstructions` fills them:
/// `recipient_tokens`, `escrow_tokens` and `partner` come from the stream metadata,
/// `streamflow_treasury` is the program constant, and the treasury and partner token accounts are
/// their associated token accounts for the mint.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StreamflowWithdrawAccounts {
    /// Signer: the recipient (the vault), the only authority when automatic withdrawal is off.
    pub authority: Pubkey,
    /// Current recipient.
    pub recipient: Pubkey,
    /// Recipient's token account (`recipient_tokens` of the metadata).
    pub recipient_tokens: Pubkey,
    /// The stream metadata account.
    pub metadata: Pubkey,
    /// Escrow token account (`escrow_tokens` of the metadata).
    pub escrow_tokens: Pubkey,
    /// Streamflow treasury.
    pub streamflow_treasury: Pubkey,
    /// Treasury's associated token account for the mint.
    pub streamflow_treasury_tokens: Pubkey,
    /// Partner (`partner` of the metadata).
    pub partner: Pubkey,
    /// Partner's associated token account for the mint.
    pub partner_tokens: Pubkey,
    /// Token mint.
    pub mint: Pubkey,
}

impl StreamflowWithdrawAccounts {
    /// The accounts for a withdrawal by the vault of a stream whose recipient is the vault.
    pub fn for_vault(
        metadata: &StreamflowMetadata,
        metadata_pubkey: Pubkey,
        vault: Pubkey,
    ) -> Result<Self, SolanaError> {
        Ok(Self {
            authority: vault,
            recipient: vault,
            recipient_tokens: metadata.recipient_tokens,
            metadata: metadata_pubkey,
            escrow_tokens: metadata.escrow_tokens,
            streamflow_treasury: STREAMFLOW_TREASURY,
            streamflow_treasury_tokens: associated_token_address(
                &STREAMFLOW_TREASURY,
                &metadata.mint,
            )?,
            partner: metadata.partner,
            partner_tokens: associated_token_address(&metadata.partner, &metadata.mint)?,
            mint: metadata.mint,
        })
    }
}

/// Streamflow `withdraw(amount)`: data is the discriminator, `amount` as `u64` LE and 10 zero
/// bytes (26 bytes); accounts as `instructions.ts:473-487`, token program last.
pub fn streamflow_withdraw(
    program_id: Pubkey,
    accounts: &StreamflowWithdrawAccounts,
    amount: u64,
) -> Instruction {
    let mut data = STREAMFLOW_WITHDRAW_DISCRIMINATOR.to_vec();
    data.extend_from_slice(&amount.to_le_bytes());
    data.extend_from_slice(&[0u8; 10]);
    Instruction {
        program_id,
        accounts: vec![
            AccountMeta::writable(accounts.authority, true),
            AccountMeta::writable(accounts.recipient, false),
            AccountMeta::writable(accounts.recipient_tokens, false),
            AccountMeta::writable(accounts.metadata, false),
            AccountMeta::writable(accounts.escrow_tokens, false),
            AccountMeta::writable(accounts.streamflow_treasury, false),
            AccountMeta::writable(accounts.streamflow_treasury_tokens, false),
            AccountMeta::writable(accounts.partner, false),
            AccountMeta::writable(accounts.partner_tokens, false),
            AccountMeta::writable(accounts.mint, false),
            AccountMeta::readonly(TOKEN_PROGRAM, false),
        ],
        data,
    }
}

/// Streamflow `transfer_recipient`: data is the discriminator and 10 zero bytes (18 bytes);
/// accounts as `instructions.ts:633-641`. `new_recipient_tokens` is the associated token account
/// of `new_recipient`; the program creates it when missing, charging the signer, so the engine
/// prepends [`create_associated_token_account_idempotent`] paid by `gas/sol` instead.
pub fn streamflow_transfer_recipient(
    program_id: Pubkey,
    authority: Pubkey,
    new_recipient: Pubkey,
    new_recipient_tokens: Pubkey,
    metadata: Pubkey,
    mint: Pubkey,
) -> Instruction {
    let mut data = STREAMFLOW_TRANSFER_RECIPIENT_DISCRIMINATOR.to_vec();
    data.extend_from_slice(&[0u8; 10]);
    Instruction {
        program_id,
        accounts: vec![
            AccountMeta::writable(authority, true),
            AccountMeta::writable(new_recipient, false),
            AccountMeta::writable(new_recipient_tokens, false),
            AccountMeta::writable(metadata, false),
            AccountMeta::readonly(mint, false),
            AccountMeta::readonly(SYSVAR_RENT, false),
            AccountMeta::readonly(TOKEN_PROGRAM, false),
            AccountMeta::readonly(ASSOCIATED_TOKEN_PROGRAM, false),
            AccountMeta::readonly(SYSTEM_PROGRAM, false),
        ],
        data,
    }
}

/// One instruction with its accounts resolved to indices into the message's account keys.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CompiledInstruction {
    /// Index of the program id.
    pub program_id_index: u8,
    /// Indices of the accounts.
    pub account_indexes: Vec<u8>,
    /// Instruction data.
    pub data: Vec<u8>,
}

/// A compiled legacy message: exactly the bytes every signer signs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LegacyMessage {
    /// Number of signatures (the first keys).
    pub num_required_signatures: u8,
    /// Read-only accounts among the signers.
    pub num_readonly_signed: u8,
    /// Read-only accounts among the non-signers.
    pub num_readonly_unsigned: u8,
    /// Account keys in signing order.
    pub account_keys: Vec<Pubkey>,
    /// Recent blockhash or durable nonce value.
    pub recent_blockhash: Hash,
    /// Instructions.
    pub instructions: Vec<CompiledInstruction>,
}

#[derive(Clone, Copy)]
struct KeyMeta {
    key: Pubkey,
    signer: bool,
    writable: bool,
}

impl KeyMeta {
    fn class(&self) -> u8 {
        match (self.signer, self.writable) {
            (true, true) => 0,
            (true, false) => 1,
            (false, true) => 2,
            (false, false) => 3,
        }
    }
}

impl LegacyMessage {
    /// Compiles `instructions` with `fee_payer` as the first signer, ordering accounts as
    /// `@solana/web3.js` `CompiledKeys` does.
    pub fn compile(
        fee_payer: &Pubkey,
        instructions: &[Instruction],
        recent_blockhash: Hash,
    ) -> Result<Self, SolanaError> {
        let mut metas: Vec<KeyMeta> = vec![KeyMeta {
            key: *fee_payer,
            signer: true,
            writable: true,
        }];
        let position = |metas: &mut Vec<KeyMeta>, key: &Pubkey| match metas
            .iter()
            .position(|meta| &meta.key == key)
        {
            Some(index) => index,
            None => {
                metas.push(KeyMeta {
                    key: *key,
                    signer: false,
                    writable: false,
                });
                metas.len() - 1
            }
        };
        for instruction in instructions {
            position(&mut metas, &instruction.program_id);
            for account in &instruction.accounts {
                let index = position(&mut metas, &account.pubkey);
                metas[index].signer |= account.is_signer;
                metas[index].writable |= account.is_writable;
            }
        }
        if metas.len() > 256 {
            return Err(SolanaError::TooManyAccounts);
        }
        let mut ordered: Vec<KeyMeta> = Vec::with_capacity(metas.len());
        for class in 0..4 {
            ordered.extend(metas.iter().filter(|meta| meta.class() == class));
        }
        let count = |class: u8| ordered.iter().filter(|meta| meta.class() == class).count() as u8;
        let account_keys: Vec<Pubkey> = ordered.iter().map(|meta| meta.key).collect();
        let index_of = |key: &Pubkey| {
            account_keys
                .iter()
                .position(|candidate| candidate == key)
                .expect("every key was registered") as u8
        };
        let compiled = instructions
            .iter()
            .map(|instruction| CompiledInstruction {
                program_id_index: index_of(&instruction.program_id),
                account_indexes: instruction
                    .accounts
                    .iter()
                    .map(|account| index_of(&account.pubkey))
                    .collect(),
                data: instruction.data.clone(),
            })
            .collect();
        Ok(Self {
            num_required_signatures: count(0) + count(1),
            num_readonly_signed: count(1),
            num_readonly_unsigned: count(3),
            account_keys,
            recent_blockhash,
            instructions: compiled,
        })
    }

    /// Wire bytes of the message: the payload every signer signs.
    pub fn serialize(&self) -> Vec<u8> {
        let mut out = vec![
            self.num_required_signatures,
            self.num_readonly_signed,
            self.num_readonly_unsigned,
        ];
        push_compact_u16(&mut out, self.account_keys.len() as u16);
        for key in &self.account_keys {
            out.extend_from_slice(key);
        }
        out.extend_from_slice(&self.recent_blockhash);
        push_compact_u16(&mut out, self.instructions.len() as u16);
        for instruction in &self.instructions {
            out.push(instruction.program_id_index);
            push_compact_u16(&mut out, instruction.account_indexes.len() as u16);
            out.extend_from_slice(&instruction.account_indexes);
            push_compact_u16(&mut out, instruction.data.len() as u16);
            out.extend_from_slice(&instruction.data);
        }
        out
    }

    /// The signers, in the order their signatures appear in the transaction.
    pub fn signers(&self) -> &[Pubkey] {
        &self.account_keys[..usize::from(self.num_required_signatures)]
    }
}

/// Wire transaction: compact-u16 signature count, the signatures in signer order, the message.
pub fn assemble_transaction(
    message: &[u8],
    signatures: &[[u8; 64]],
) -> Result<Vec<u8>, SolanaError> {
    if signatures.len() != usize::from(message.first().copied().unwrap_or(0)) {
        return Err(SolanaError::SignatureCount);
    }
    let mut out = Vec::with_capacity(1 + 64 * signatures.len() + message.len());
    push_compact_u16(&mut out, signatures.len() as u16);
    for signature in signatures {
        out.extend_from_slice(signature);
    }
    out.extend_from_slice(message);
    if out.len() > MAX_TRANSACTION_LEN {
        return Err(SolanaError::TransactionTooLarge);
    }
    Ok(out)
}

/// An initialized durable nonce account.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct NonceAccount {
    /// Key allowed to advance the nonce.
    pub authority: Pubkey,
    /// Current nonce value, used as the `recent_blockhash` of the next transaction.
    pub nonce: Hash,
    /// Fee the account was last advanced at.
    pub lamports_per_signature: u64,
}

impl NonceAccount {
    /// Parses the 80-byte state of a `Current`, initialized nonce account.
    pub fn parse(data: &[u8]) -> Result<Self, SolanaError> {
        if data.len() != NONCE_ACCOUNT_LEN {
            return Err(SolanaError::NonceLength);
        }
        if data[..4] != 1u32.to_le_bytes() || data[4..8] != 1u32.to_le_bytes() {
            return Err(SolanaError::NonceState);
        }
        Ok(Self {
            authority: data[8..40].try_into().expect("32 bytes"),
            nonce: data[40..72].try_into().expect("32 bytes"),
            lamports_per_signature: u64::from_le_bytes(data[72..80].try_into().expect("8 bytes")),
        })
    }

    /// Parses an attested account state and requires it to be a System-owned nonce account whose
    /// authority is `authority`.
    pub fn from_account_state(
        account: &SvmAccount,
        authority: &Pubkey,
    ) -> Result<Self, SolanaError> {
        if account.owner.0 != SYSTEM_PROGRAM {
            return Err(SolanaError::NonceOwner);
        }
        let nonce = Self::parse(&account.data)?;
        if &nonce.authority != authority {
            return Err(SolanaError::NonceAuthority);
        }
        Ok(nonce)
    }
}

/// Length of a classic SPL Token account (`spl-token` 4.x `state::Account::LEN`).
pub const TOKEN_ACCOUNT_LEN: usize = 165;
/// `AccountState::Initialized` (0 is uninitialized, 2 frozen).
pub const TOKEN_ACCOUNT_INITIALIZED: u8 = 1;

/// The fields of a classic SPL Token account the engine reads (`spl-token` 4.x
/// `src/state.rs`, `Account` packed as `mint` 0..32, `owner` 32..64, `amount` 64..72,
/// `delegate` 72..108, `state` 108, `is_native` 109..121, `delegated_amount` 121..129,
/// `close_authority` 129..165).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TokenAccount {
    /// Mint of the tokens it holds.
    pub mint: Pubkey,
    /// Wallet that owns it.
    pub owner: Pubkey,
    /// Balance.
    pub amount: u64,
    /// `AccountState`.
    pub state: u8,
}

impl TokenAccount {
    /// Parses the 165 bytes of a token account.
    pub fn parse(data: &[u8]) -> Result<Self, SolanaError> {
        if data.len() != TOKEN_ACCOUNT_LEN {
            return Err(SolanaError::TokenLength);
        }
        Ok(Self {
            mint: data[0..32].try_into().expect("32 bytes"),
            owner: data[32..64].try_into().expect("32 bytes"),
            amount: u64::from_le_bytes(data[64..72].try_into().expect("8 bytes")),
            state: data[108],
        })
    }

    /// Parses an attested account state and requires an initialized (not frozen) classic SPL
    /// Token account of `mint` owned by `owner`: an account a `TransferChecked` or a
    /// `transfer_recipient` can credit without creating anything.
    pub fn from_account_state(
        account: &SvmAccount,
        mint: &Pubkey,
        owner: &Pubkey,
    ) -> Result<Self, SolanaError> {
        if account.owner.0 != TOKEN_PROGRAM {
            return Err(SolanaError::TokenProgram);
        }
        let token = Self::parse(&account.data)?;
        if &token.mint != mint {
            return Err(SolanaError::TokenMint);
        }
        if &token.owner != owner {
            return Err(SolanaError::TokenOwner);
        }
        if token.state != TOKEN_ACCOUNT_INITIALIZED {
            return Err(SolanaError::TokenState);
        }
        Ok(token)
    }
}

/// Length of a classic SPL Token mint account (`Mint::LEN`).
pub const MINT_ACCOUNT_LEN: usize = 82;

/// The fields of a classic SPL Token mint the engine reads.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Mint {
    /// Decimals of the token (offset 44).
    pub decimals: u8,
    /// Key that may freeze any token account of the mint (`COption` at 46). Once `None` it can
    /// never be set again (`spl-token` `SetAuthority` fails with `MintCannotFreeze`).
    pub freeze_authority: Option<Pubkey>,
}

impl Mint {
    /// Parses the 82 bytes of an initialized mint.
    pub fn parse(data: &[u8]) -> Result<Self, SolanaError> {
        if data.len() != MINT_ACCOUNT_LEN {
            return Err(SolanaError::MintLength);
        }
        let tag = |offset: usize| {
            u32::from_le_bytes(data[offset..offset + 4].try_into().expect("4 bytes"))
        };
        if tag(0) > 1 || tag(46) > 1 || data[45] != 1 {
            return Err(SolanaError::MintState);
        }
        Ok(Self {
            decimals: data[44],
            freeze_authority: (tag(46) == 1).then(|| data[50..82].try_into().expect("32 bytes")),
        })
    }
}

/// Why a Streamflow account is not an eligible deposit.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StreamflowError {
    /// The account is not owned by the Streamflow program.
    Owner,
    /// The account is not 1104 bytes.
    Length,
    /// A boolean field is neither 0 nor 1.
    Flag,
    /// The recipient is not the vault.
    Recipient,
    /// The stream is closed.
    Closed,
    /// The stream was canceled.
    Canceled,
    /// The sender may cancel the stream.
    CancelableBySender,
    /// The sender may transfer the stream away from the vault.
    TransferableBySender,
    /// The stream may be paused.
    Pausable,
    /// The rate may be updated.
    CanUpdateRate,
    /// The stream may be topped up, which would change the registered schedule.
    CanTopup,
    /// The recipient may not transfer the stream: the vault could never release it.
    NotTransferableByRecipient,
    /// Streamflow's automatic withdrawals would move unlocked tokens without the engine's
    /// accounting.
    AutomaticWithdrawal,
    /// The stream carries pause or rate-change history, so the plain unlock formula no longer
    /// describes it.
    Modified,
    /// Withdrawals pay Streamflow or partner fees, which need the fee recipients' token accounts:
    /// only fee-free streams are accepted, whose withdrawals touch neither (verified on devnet).
    Fees,
}

/// The fields of a Streamflow stream metadata account the engine reads (`streamLayout` in
/// `layout.ts`; offsets confirmed live).
///
/// | Offset | Field |
/// |---|---|
/// | 0 | `magic` u64 |
/// | 8 | `version` u8 |
/// | 9 | `created_at` u64 |
/// | 17 | `amount_withdrawn` u64 |
/// | 25 | `canceled_at` u64 |
/// | 33 | `end_time` u64 |
/// | 41 | `last_withdrawn_at` u64 |
/// | 49 | `sender` |
/// | 81 | `sender_tokens` |
/// | 113 | `recipient` |
/// | 145 | `recipient_tokens` |
/// | 177 | `mint` |
/// | 209 | `escrow_tokens` |
/// | 241 | `streamflow_treasury` |
/// | 273 | `streamflow_treasury_tokens` |
/// | 305 | `streamflow_fee_total` u64 |
/// | 313 | `streamflow_fee_withdrawn` u64 |
/// | 321 | `streamflow_fee_percent` f32 |
/// | 325 | `partner` |
/// | 357 | `partner_tokens` |
/// | 389 | `partner_fee_total` u64 |
/// | 397 | `partner_fee_withdrawn` u64 |
/// | 405 | `partner_fee_percent` f32 |
/// | 409 | `start_time` u64 (`ix` starts here) |
/// | 417 | `net_amount_deposited` u64 |
/// | 425 | `period` u64 |
/// | 433 | `amount_per_period` u64 |
/// | 441 | `cliff` u64 |
/// | 449 | `cliff_amount` u64 |
/// | 457 | `cancelable_by_sender` |
/// | 458 | `cancelable_by_recipient` |
/// | 459 | `automatic_withdrawal` |
/// | 460 | `transferable_by_sender` |
/// | 461 | `transferable_by_recipient` |
/// | 462 | `can_topup` |
/// | 463 | `stream_name` (64) |
/// | 527 | `withdraw_frequency` u64 |
/// | 535 | `ghost` u32 |
/// | 539 | `pausable` |
/// | 540 | `can_update_rate` |
/// | 541 | `ghost2` u32 |
/// | 545 | `is_pda` |
/// | 546 | `nonce` u32 |
/// | 550 | `ix_padding` (121) |
/// | 671 | `closed` |
/// | 672 | `current_pause_start` u64 |
/// | 680 | `pause_cumulative` u64 |
/// | 688 | `last_rate_change_time` u64 |
/// | 696 | `funds_unlocked_at_last_rate_change` u64 |
/// | 704 | `creation_fee` u32 |
/// | 708 | `creation_fee_claimed` |
/// | 709 | `auto_claim_fee` u32 |
/// | 713 | `auto_claim_fee_claimed` |
/// | 714 | `old_metadata` |
/// | 746 | `payer` |
/// | 778 | `bump` |
/// | 779 | `fee_partner` (js only) |
/// | 811 | `cancel_request_time` u64 (js only) |
/// | 819 | zero padding to 1104 |
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StreamflowMetadata {
    /// `magic`.
    pub magic: u64,
    /// `version`.
    pub version: u8,
    /// `created_at`.
    pub created_at: u64,
    /// `amount_withdrawn`: changes on every withdrawal.
    pub amount_withdrawn: u64,
    /// `canceled_at`: `0` while not canceled.
    pub canceled_at: u64,
    /// `end_time`, computed by the program at creation.
    pub end_time: u64,
    /// `last_withdrawn_at`.
    pub last_withdrawn_at: u64,
    /// `sender`.
    pub sender: Pubkey,
    /// `sender_tokens`.
    pub sender_tokens: Pubkey,
    /// `recipient`.
    pub recipient: Pubkey,
    /// `recipient_tokens`.
    pub recipient_tokens: Pubkey,
    /// `mint`.
    pub mint: Pubkey,
    /// `escrow_tokens`.
    pub escrow_tokens: Pubkey,
    /// `streamflow_treasury`.
    pub streamflow_treasury: Pubkey,
    /// `streamflow_treasury_tokens`.
    pub streamflow_treasury_tokens: Pubkey,
    /// `partner`.
    pub partner: Pubkey,
    /// `partner_tokens`.
    pub partner_tokens: Pubkey,
    /// `streamflow_fee_total`.
    pub streamflow_fee_total: u64,
    /// `streamflow_fee_withdrawn`.
    pub streamflow_fee_withdrawn: u64,
    /// `streamflow_fee_percent`, the raw bits of the `f32`.
    pub streamflow_fee_percent: u32,
    /// `partner_fee_total`.
    pub partner_fee_total: u64,
    /// `partner_fee_withdrawn`.
    pub partner_fee_withdrawn: u64,
    /// `partner_fee_percent`, the raw bits of the `f32`.
    pub partner_fee_percent: u32,
    /// `ix.start_time`.
    pub start_time: u64,
    /// `ix.net_amount_deposited`.
    pub net_amount_deposited: u64,
    /// `ix.period`.
    pub period: u64,
    /// `ix.amount_per_period`.
    pub amount_per_period: u64,
    /// `ix.cliff`.
    pub cliff: u64,
    /// `ix.cliff_amount`.
    pub cliff_amount: u64,
    /// `ix.cancelable_by_sender`.
    pub cancelable_by_sender: bool,
    /// `ix.cancelable_by_recipient`.
    pub cancelable_by_recipient: bool,
    /// `ix.automatic_withdrawal`.
    pub automatic_withdrawal: bool,
    /// `ix.transferable_by_sender`.
    pub transferable_by_sender: bool,
    /// `ix.transferable_by_recipient`.
    pub transferable_by_recipient: bool,
    /// `ix.can_topup`.
    pub can_topup: bool,
    /// `ix.withdraw_frequency`.
    pub withdraw_frequency: u64,
    /// `ix.pausable`.
    pub pausable: bool,
    /// `ix.can_update_rate`.
    pub can_update_rate: bool,
    /// `closed`.
    pub closed: bool,
    /// `current_pause_start`.
    pub current_pause_start: u64,
    /// `pause_cumulative`.
    pub pause_cumulative: u64,
    /// `last_rate_change_time`.
    pub last_rate_change_time: u64,
    /// `funds_unlocked_at_last_rate_change`.
    pub funds_unlocked_at_last_rate_change: u64,
}

impl StreamflowMetadata {
    /// Parses a 1104-byte metadata account.
    pub fn parse(data: &[u8]) -> Result<Self, StreamflowError> {
        if data.len() != STREAMFLOW_METADATA_LEN {
            return Err(StreamflowError::Length);
        }
        let u64_at = |offset: usize| {
            u64::from_le_bytes(data[offset..offset + 8].try_into().expect("8 bytes"))
        };
        let u32_at = |offset: usize| {
            u32::from_le_bytes(data[offset..offset + 4].try_into().expect("4 bytes"))
        };
        let key_at =
            |offset: usize| -> Pubkey { data[offset..offset + 32].try_into().expect("32 bytes") };
        let flag_at = |offset: usize| match data[offset] {
            0 => Ok(false),
            1 => Ok(true),
            _ => Err(StreamflowError::Flag),
        };
        Ok(Self {
            magic: u64_at(0),
            version: data[8],
            created_at: u64_at(9),
            amount_withdrawn: u64_at(17),
            canceled_at: u64_at(25),
            end_time: u64_at(33),
            last_withdrawn_at: u64_at(41),
            sender: key_at(49),
            sender_tokens: key_at(81),
            recipient: key_at(113),
            recipient_tokens: key_at(145),
            mint: key_at(177),
            escrow_tokens: key_at(209),
            streamflow_treasury: key_at(241),
            streamflow_treasury_tokens: key_at(273),
            partner: key_at(325),
            partner_tokens: key_at(357),
            streamflow_fee_total: u64_at(305),
            streamflow_fee_withdrawn: u64_at(313),
            streamflow_fee_percent: u32_at(321),
            partner_fee_total: u64_at(389),
            partner_fee_withdrawn: u64_at(397),
            partner_fee_percent: u32_at(405),
            start_time: u64_at(409),
            net_amount_deposited: u64_at(417),
            period: u64_at(425),
            amount_per_period: u64_at(433),
            cliff: u64_at(441),
            cliff_amount: u64_at(449),
            cancelable_by_sender: flag_at(457)?,
            cancelable_by_recipient: flag_at(458)?,
            automatic_withdrawal: flag_at(459)?,
            transferable_by_sender: flag_at(460)?,
            transferable_by_recipient: flag_at(461)?,
            can_topup: flag_at(462)?,
            withdraw_frequency: u64_at(527),
            pausable: flag_at(539)?,
            can_update_rate: flag_at(540)?,
            closed: flag_at(671)?,
            current_pause_start: u64_at(672),
            pause_cumulative: u64_at(680),
            last_rate_change_time: u64_at(688),
            funds_unlocked_at_last_rate_change: u64_at(696),
        })
    }

    /// Parses an attested account state and requires a stream the engine may register: owned by
    /// `program`, recipient `vault`, open, not canceled, transferable by its recipient (so the
    /// vault can release or return it), without automatic withdrawals (the engine sizes its own
    /// withdrawals; Streamflow's auto-claim at the end, which ignores the flag, is booked by
    /// `sync_sol_stream`) and with none of the sender-side
    /// or schedule-changing permissions (`cancelable_by_sender`, `transferable_by_sender`,
    /// `pausable`, `can_update_rate`, `can_topup`), so that the registered schedule stays exact,
    /// and without Streamflow or partner fees (see [`StreamflowError::Fees`]).
    pub fn check_deposit(
        account: &SvmAccount,
        program: &Pubkey,
        vault: &Pubkey,
    ) -> Result<Self, StreamflowError> {
        if &account.owner.0 != program {
            return Err(StreamflowError::Owner);
        }
        let metadata = Self::parse(&account.data)?;
        if &metadata.recipient != vault {
            return Err(StreamflowError::Recipient);
        }
        if metadata.closed {
            return Err(StreamflowError::Closed);
        }
        if metadata.canceled_at != 0 {
            return Err(StreamflowError::Canceled);
        }
        if metadata.cancelable_by_sender {
            return Err(StreamflowError::CancelableBySender);
        }
        if metadata.transferable_by_sender {
            return Err(StreamflowError::TransferableBySender);
        }
        if !metadata.transferable_by_recipient {
            return Err(StreamflowError::NotTransferableByRecipient);
        }
        if metadata.automatic_withdrawal {
            return Err(StreamflowError::AutomaticWithdrawal);
        }
        if metadata.pausable {
            return Err(StreamflowError::Pausable);
        }
        if metadata.can_update_rate {
            return Err(StreamflowError::CanUpdateRate);
        }
        if metadata.can_topup {
            return Err(StreamflowError::CanTopup);
        }
        if metadata.current_pause_start != 0
            || metadata.pause_cumulative != 0
            || metadata.last_rate_change_time != 0
            || metadata.funds_unlocked_at_last_rate_change != 0
        {
            return Err(StreamflowError::Modified);
        }
        if metadata.streamflow_fee_total != 0
            || metadata.streamflow_fee_withdrawn != 0
            || metadata.streamflow_fee_percent != 0
            || metadata.partner_fee_total != 0
            || metadata.partner_fee_withdrawn != 0
            || metadata.partner_fee_percent != 0
        {
            return Err(StreamflowError::Fees);
        }
        Ok(metadata)
    }

    /// The schedule as [`crate::unlock::StreamflowStream`] validates it.
    pub fn params(&self) -> StreamflowParams {
        StreamflowParams {
            start_time: self.start_time,
            cliff: self.cliff,
            cliff_amount: self.cliff_amount,
            period: self.period,
            amount_per_period: self.amount_per_period,
            net_amount_deposited: self.net_amount_deposited,
            end_time: self.end_time,
            pausable: self.pausable,
            can_update_rate: self.can_update_rate,
            can_topup: self.can_topup,
            current_pause_start: self.current_pause_start,
            pause_cumulative: self.pause_cumulative,
            last_rate_change_time: self.last_rate_change_time,
            funds_unlocked_at_last_rate_change: self.funds_unlocked_at_last_rate_change,
        }
    }
}
