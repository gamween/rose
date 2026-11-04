// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import {ISablierLockup, Lockup, LockupLinear} from "./interfaces/ISablierLockup.sol";
import {NearAccountId} from "./libraries/NearAccountId.sol";

/// @title RoseVault
/// @notice Custody of Sablier Lockup Linear positions and cash on Base for the rose engine on NEAR.
/// @dev Immutable: no owner, no admin, no upgrade path. Assets leave the vault only through `executeTransfer` and
/// `executeRelease`, each authorized by an EIP-712 signature of `SIGNER`, the address the NEAR MPC network derives
/// for the rose engine. Every authorization carries a unique `id`; a bitmap of 256 ids per storage word makes each
/// one usable exactly once. There is no deadline: an authorization stored on NEAR stays valid until it is used.
///
/// Signatures are accepted only as `(v, r, s)` with `v` in {27, 28} and a low `s` (`s <= n / 2`), which is the
/// format produced from a NEAR MPC response as `v = 27 + recovery_id`, `r = big_R.x`, `s = s`.
///
/// Streams must enter only through `depositStream`. A stream sent with a plain `transferFrom` (which bypasses
/// `onERC721Received`) emits no `StreamDeposited` log, so the engine never registers it and never attributes it to
/// anyone; such a stream can only leave through a `Release` authorization, which the engine never issues for an
/// unregistered stream.
///
/// Sablier's Lockup withdrawal fee is controlled by its admin and a price oracle through the comptroller
/// (0x0000008ABbFf7a84a2fE09f9A9b74D3BC2072399 on Base Sepolia, where the fee is currently zero). Callers of
/// `depositStream` and `executeRelease` must attach `LOCKUP.calculateMinFeeWei(streamId)` as read at submit time
/// plus a margin, because the fee can move between the read and the inclusion of the transaction; the vault refunds
/// whatever it does not forward.
contract RoseVault is EIP712, ReentrancyGuardTransient, IERC721Receiver {
    using SafeERC20 for IERC20;

    /// @notice ERC-20 payout authorization.
    /// @param token The ERC-20 token to send.
    /// @param to The recipient.
    /// @param amount The amount, in the token's smallest unit.
    /// @param id Unique authorization id, shared with `Release` ids in the same replay bitmap.
    struct Transfer {
        address token;
        address to;
        uint256 amount;
        uint256 id;
    }

    /// @notice ERC-721 release authorization for a Sablier stream held by the vault.
    /// @param lockup The Sablier Lockup contract; must equal `LOCKUP`.
    /// @param streamId The stream (NFT) to release.
    /// @param to The new owner of the stream NFT.
    /// @param id Unique authorization id, shared with `Transfer` ids in the same replay bitmap.
    struct Release {
        address lockup;
        uint256 streamId;
        address to;
        uint256 id;
    }

    /// @notice keccak256("Transfer(address token,address to,uint256 amount,uint256 id)")
    bytes32 public constant TRANSFER_TYPEHASH =
        keccak256("Transfer(address token,address to,uint256 amount,uint256 id)");

    /// @notice keccak256("Release(address lockup,uint256 streamId,address to,uint256 id)")
    bytes32 public constant RELEASE_TYPEHASH =
        keccak256("Release(address lockup,uint256 streamId,address to,uint256 id)");

    /// @notice The canonical Sablier Lockup v4 contract; streams of any other contract are refused.
    ISablierLockup public immutable LOCKUP;

    /// @notice The MPC-derived address of the rose engine that authorizes every outflow.
    address public immutable SIGNER;

    mapping(uint256 wordIndex => uint256 word) private _usedAuthorizations;

    /// @dev Stream id expected by `onERC721Received` while `depositStream` pulls the NFT; zero otherwise.
    /// Sablier stream ids start at 1, so zero never matches a real stream.
    uint256 private transient _pendingStreamId;

    /// @notice A Sablier stream entered the vault.
    /// @dev ABI layout of the log (all words are 32 bytes, big-endian, left-padded unless noted):
    /// topics[0] = keccak256("StreamDeposited(address,string,address,uint256,address,uint128,uint128,uint40,uint40,uint40,uint40,uint128,uint128,bool,bool,uint40)")
    /// topics[1] = sender, topics[2] = streamId.
    /// data word 0 = offset of nearAccount (always 0x1c0 = 14 * 32), words 1..13 = lockup, token, deposited,
    /// withdrawn, start, cliff, end, granularity, startUnlock, cliffUnlock, cancelable, transferable, timestamp,
    /// word 14 = byte length of nearAccount, then nearAccount's UTF-8 bytes right-padded with zeros to a multiple of 32.
    /// `withdrawn` already includes the vested balance this deposit withdrew to `sender`.
    event StreamDeposited(
        address indexed sender,
        string nearAccount,
        address lockup,
        uint256 indexed streamId,
        address token,
        uint128 deposited,
        uint128 withdrawn,
        uint40 start,
        uint40 cliff,
        uint40 end,
        uint40 granularity,
        uint128 startUnlock,
        uint128 cliffUnlock,
        bool cancelable,
        bool transferable,
        uint40 timestamp
    );

    /// @notice Current state of a stream held by the vault.
    /// @dev Static layout: topics[1] = streamId; data words 0..14 = lockup, token, deposited, withdrawn, withdrawable,
    /// start, cliff, end, granularity, startUnlock, cliffUnlock, cancelable, transferable, depleted, timestamp.
    event StreamAttested(
        uint256 indexed streamId,
        address lockup,
        address token,
        uint128 deposited,
        uint128 withdrawn,
        uint128 withdrawable,
        uint40 start,
        uint40 cliff,
        uint40 end,
        uint40 granularity,
        uint128 startUnlock,
        uint128 cliffUnlock,
        bool cancelable,
        bool transferable,
        bool depleted,
        uint40 timestamp
    );

    /// @notice Cash entered the vault for a NEAR account.
    /// @dev topics[1] = sender, topics[2] = token, topics[3] = roundId; data word 0 = offset of nearAccount (0x60),
    /// word 1 = amount, word 2 = timestamp, word 3 = byte length of nearAccount, then its bytes right-padded.
    event CashDeposited(
        address indexed sender,
        address indexed token,
        uint64 indexed roundId,
        string nearAccount,
        uint128 amount,
        uint40 timestamp
    );

    /// @notice An ERC-20 transfer authorization was used.
    event TransferExecuted(uint256 indexed id, address indexed token, address indexed to, uint256 amount);

    /// @notice A stream release authorization was used. `withdrawnToVault` is the vested balance moved into the
    /// vault immediately before the NFT left it.
    /// @dev `withdrawnToVault` is informational only: it is legitimately zero when a third party already called
    /// `withdrawMax(streamId, vault)` (open to anyone, since the vault is the recipient), so the engine must not
    /// account from this field; it accrues from the stream's withdrawn amount instead.
    event ReleaseExecuted(
        uint256 indexed id, uint256 indexed streamId, address indexed to, address lockup, uint128 withdrawnToVault
    );

    error ZeroAddress();
    error WrongLockup(address lockup);
    error InvalidNearAccount();
    error NotStreamOwner(uint256 streamId, address owner);
    error NotLockupLinear(uint256 streamId);
    error StreamCancelable(uint256 streamId);
    error StreamNotTransferable(uint256 streamId);
    error StreamCanceled(uint256 streamId);
    error StreamDepleted(uint256 streamId);
    error StreamNotHeld(uint256 streamId);
    error UnexpectedNft();
    error InsufficientFee(uint256 paid, uint256 required);
    error RefundFailed();
    error ZeroAmount();
    error AmountMismatch(uint256 expected, uint256 received);
    error AuthorizationUsed(uint256 id);
    error InvalidSignatureV(uint8 v);
    error InvalidSignatureS(bytes32 s);
    error InvalidSigner(address recovered);

    constructor(ISablierLockup lockup, address signer) EIP712("RoseVault", "1") {
        if (address(lockup) == address(0) || signer == address(0)) {
            revert ZeroAddress();
        }
        LOCKUP = lockup;
        SIGNER = signer;
    }

    /*//////////////////////////////////////////////////////////////////////////
                                     DEPOSITS
    //////////////////////////////////////////////////////////////////////////*/

    /// @notice Deposits a Sablier Lockup Linear stream owned by the caller and attributes it to `nearAccount`.
    /// @dev The caller must own the stream and have approved this vault for it. Any vested balance is first withdrawn
    /// to the caller, paying Sablier's minimum withdrawal fee out of `msg.value`; the unused part of `msg.value` is
    /// refunded. Refuses streams of another contract, non-LL streams, cancelable, non-transferable, canceled or
    /// depleted streams, and streams that would be depleted by the withdrawal (nothing left to lock).
    function depositStream(ISablierLockup lockup, uint256 streamId, string calldata nearAccount)
        external
        payable
        nonReentrant
    {
        if (lockup != LOCKUP) {
            revert WrongLockup(address(lockup));
        }
        if (!NearAccountId.isValid(nearAccount)) {
            revert InvalidNearAccount();
        }
        address owner = LOCKUP.ownerOf(streamId);
        if (owner != msg.sender) {
            revert NotStreamOwner(streamId, owner);
        }
        if (LOCKUP.getLockupModel(streamId) != Lockup.Model.LOCKUP_LINEAR) {
            revert NotLockupLinear(streamId);
        }
        if (LOCKUP.isCancelable(streamId)) {
            revert StreamCancelable(streamId);
        }
        if (!LOCKUP.isTransferable(streamId)) {
            revert StreamNotTransferable(streamId);
        }
        if (LOCKUP.wasCanceled(streamId)) {
            revert StreamCanceled(streamId);
        }
        if (LOCKUP.isDepleted(streamId)) {
            revert StreamDepleted(streamId);
        }

        (, uint256 feePaid) = _withdrawVested(streamId, msg.sender);
        if (LOCKUP.isDepleted(streamId)) {
            revert StreamDepleted(streamId);
        }

        _pendingStreamId = streamId;
        LOCKUP.safeTransferFrom(msg.sender, address(this), streamId);
        _pendingStreamId = 0;

        _emitStreamDeposited(streamId, nearAccount);
        _refund(msg.value - feePaid);
    }

    /// @notice Deposits `amount` of an ERC-20 cash token for `nearAccount`, earmarked for round `roundId`.
    /// @dev The NEAR engine decides which tokens it credits (Base Sepolia USDC or rose tUSDC). Tokens that do not
    /// deliver exactly `amount` (fee-on-transfer, rebasing) are refused.
    function depositCash(IERC20 token, uint128 amount, string calldata nearAccount, uint64 roundId)
        external
        nonReentrant
    {
        if (amount == 0) {
            revert ZeroAmount();
        }
        if (!NearAccountId.isValid(nearAccount)) {
            revert InvalidNearAccount();
        }
        uint256 balanceBefore = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = token.balanceOf(address(this)) - balanceBefore;
        if (received != amount) {
            revert AmountMismatch(amount, received);
        }
        emit CashDeposited(msg.sender, address(token), roundId, nearAccount, amount, uint40(block.timestamp));
    }

    /// @notice Emits the current state of a stream held by the vault, so the engine can refresh it with a proof.
    function attest(uint256 streamId) external {
        if (LOCKUP.ownerOf(streamId) != address(this)) {
            revert StreamNotHeld(streamId);
        }
        LockupLinear.UnlockAmounts memory unlockAmounts = LOCKUP.getUnlockAmounts(streamId);
        emit StreamAttested({
            streamId: streamId,
            lockup: address(LOCKUP),
            token: address(LOCKUP.getUnderlyingToken(streamId)),
            deposited: LOCKUP.getDepositedAmount(streamId),
            withdrawn: LOCKUP.getWithdrawnAmount(streamId),
            withdrawable: LOCKUP.withdrawableAmountOf(streamId),
            start: LOCKUP.getStartTime(streamId),
            cliff: LOCKUP.getCliffTime(streamId),
            end: LOCKUP.getEndTime(streamId),
            granularity: LOCKUP.getGranularity(streamId),
            startUnlock: unlockAmounts.start,
            cliffUnlock: unlockAmounts.cliff,
            cancelable: LOCKUP.isCancelable(streamId),
            transferable: LOCKUP.isTransferable(streamId),
            depleted: LOCKUP.isDepleted(streamId),
            timestamp: uint40(block.timestamp)
        });
    }

    /// @inheritdoc IERC721Receiver
    /// @dev Accepts only the stream that `depositStream` is pulling from the canonical Lockup contract.
    function onERC721Received(address operator, address, uint256 tokenId, bytes calldata)
        external
        view
        returns (bytes4)
    {
        if (msg.sender != address(LOCKUP) || operator != address(this) || tokenId == 0 || tokenId != _pendingStreamId) {
            revert UnexpectedNft();
        }
        return IERC721Receiver.onERC721Received.selector;
    }

    /*//////////////////////////////////////////////////////////////////////////
                                  AUTHORIZATIONS
    //////////////////////////////////////////////////////////////////////////*/

    /// @notice Sends ERC-20 tokens held by the vault, as authorized by `SIGNER`. Anyone can submit.
    function executeTransfer(Transfer calldata authorization, uint8 v, bytes32 r, bytes32 s) external nonReentrant {
        if (authorization.to == address(0)) {
            revert ZeroAddress();
        }
        _useAuthorization(authorization.id, hashTransfer(authorization), v, r, s);
        IERC20(authorization.token).safeTransfer(authorization.to, authorization.amount);
        emit TransferExecuted(authorization.id, authorization.token, authorization.to, authorization.amount);
    }

    /// @notice Releases a stream NFT held by the vault, as authorized by `SIGNER`. Anyone can submit.
    /// @dev Any vested balance is withdrawn to the vault first, so tokens accrued while the stream was held stay with
    /// unit holders. That withdrawal pays Sablier's minimum fee out of `msg.value`; the rest is refunded.
    function executeRelease(Release calldata authorization, uint8 v, bytes32 r, bytes32 s)
        external
        payable
        nonReentrant
    {
        if (authorization.lockup != address(LOCKUP)) {
            revert WrongLockup(authorization.lockup);
        }
        if (authorization.to == address(0)) {
            revert ZeroAddress();
        }
        _useAuthorization(authorization.id, hashRelease(authorization), v, r, s);

        (uint128 withdrawn, uint256 feePaid) = _withdrawVested(authorization.streamId, address(this));
        LOCKUP.transferFrom(address(this), authorization.to, authorization.streamId);

        emit ReleaseExecuted(authorization.id, authorization.streamId, authorization.to, address(LOCKUP), withdrawn);
        _refund(msg.value - feePaid);
    }

    /*//////////////////////////////////////////////////////////////////////////
                                       VIEWS
    //////////////////////////////////////////////////////////////////////////*/

    /// @notice The EIP-712 domain separator (name "RoseVault", version "1", this chain, this contract).
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    /// @notice The EIP-712 digest the signer must sign for a `Transfer`.
    function hashTransfer(Transfer calldata authorization) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    TRANSFER_TYPEHASH, authorization.token, authorization.to, authorization.amount, authorization.id
                )
            )
        );
    }

    /// @notice The EIP-712 digest the signer must sign for a `Release`.
    function hashRelease(Release calldata authorization) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    RELEASE_TYPEHASH, authorization.lockup, authorization.streamId, authorization.to, authorization.id
                )
            )
        );
    }

    /// @notice Whether the authorization `id` has been used.
    function isAuthorizationUsed(uint256 id) public view returns (bool) {
        (uint256 wordIndex, uint256 bit) = _bitmapPosition(id);
        return _usedAuthorizations[wordIndex] & bit != 0;
    }

    /*//////////////////////////////////////////////////////////////////////////
                                     INTERNALS
    //////////////////////////////////////////////////////////////////////////*/

    function _useAuthorization(uint256 id, bytes32 digest, uint8 v, bytes32 r, bytes32 s) private {
        if (v != 27 && v != 28) {
            revert InvalidSignatureV(v);
        }
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, v, r, s);
        if (err == ECDSA.RecoverError.InvalidSignatureS) {
            revert InvalidSignatureS(s);
        }
        if (err != ECDSA.RecoverError.NoError || recovered != SIGNER) {
            revert InvalidSigner(recovered);
        }
        (uint256 wordIndex, uint256 bit) = _bitmapPosition(id);
        uint256 word = _usedAuthorizations[wordIndex];
        if (word & bit != 0) {
            revert AuthorizationUsed(id);
        }
        _usedAuthorizations[wordIndex] = word | bit;
    }

    /// @dev Id `id` lives in word `id / 256` at bit `id % 256`.
    function _bitmapPosition(uint256 id) private pure returns (uint256 wordIndex, uint256 bit) {
        wordIndex = id >> 8;
        // forge-lint: disable-next-line(incorrect-shift)
        bit = 1 << (id & 0xff);
    }

    /// @dev Withdraws the whole withdrawable balance of `streamId` to `to` when it is not zero (Sablier reverts on a
    /// zero withdrawal). Returns the amount withdrawn and the fee forwarded to Sablier.
    function _withdrawVested(uint256 streamId, address to) private returns (uint128 withdrawn, uint256 feePaid) {
        if (LOCKUP.withdrawableAmountOf(streamId) == 0) {
            return (0, 0);
        }
        feePaid = LOCKUP.calculateMinFeeWei(streamId);
        if (msg.value < feePaid) {
            revert InsufficientFee(msg.value, feePaid);
        }
        withdrawn = LOCKUP.withdrawMax{value: feePaid}(streamId, to);
    }

    function _emitStreamDeposited(uint256 streamId, string calldata nearAccount) private {
        LockupLinear.UnlockAmounts memory unlockAmounts = LOCKUP.getUnlockAmounts(streamId);
        emit StreamDeposited({
            sender: msg.sender,
            nearAccount: nearAccount,
            lockup: address(LOCKUP),
            streamId: streamId,
            token: address(LOCKUP.getUnderlyingToken(streamId)),
            deposited: LOCKUP.getDepositedAmount(streamId),
            withdrawn: LOCKUP.getWithdrawnAmount(streamId),
            start: LOCKUP.getStartTime(streamId),
            cliff: LOCKUP.getCliffTime(streamId),
            end: LOCKUP.getEndTime(streamId),
            granularity: LOCKUP.getGranularity(streamId),
            startUnlock: unlockAmounts.start,
            cliffUnlock: unlockAmounts.cliff,
            cancelable: LOCKUP.isCancelable(streamId),
            transferable: LOCKUP.isTransferable(streamId),
            timestamp: uint40(block.timestamp)
        });
    }

    function _refund(uint256 amount) private {
        if (amount == 0) {
            return;
        }
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) {
            revert RefundFailed();
        }
    }
}
