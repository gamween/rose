// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

import {Lockup, LockupLinear} from "../../src/interfaces/ISablierLockup.sol";

/// @notice Local stand-in for Sablier Lockup v4, reproducing the behavior RoseVault depends on: LL streamed amount
/// with cliff, unlock amounts and granularity (LockupMath.calculateStreamedAmountLL), withdraw authorization
/// (`to` must be the recipient unless the caller is approved), zero-amount withdrawal revert, minimum fee in wei,
/// depletion, and the non-transferable check on NFT transfers. Test helpers flip states that the real contract
/// reaches through other models or cancellation.
contract MockLockup is ERC721 {
    using SafeERC20 for IERC20;

    struct Stream {
        address sender;
        IERC20 token;
        uint40 start;
        uint40 cliff;
        uint40 end;
        uint40 granularity;
        uint128 deposited;
        uint128 withdrawn;
        uint128 startUnlock;
        uint128 cliffUnlock;
        bool cancelable;
        bool transferable;
        bool canceled;
        bool depleted;
        Lockup.Model model;
    }

    uint256 public nextStreamId = 1;
    uint256 public minFeeWei;
    mapping(uint256 streamId => Stream stream) private _streams;

    error InsufficientFeePayment(uint256 paid, uint256 required);
    error WithdrawAmountZero(uint256 streamId);
    error WithdrawalAddressNotRecipient(uint256 streamId, address caller, address to);
    error StreamDepletedError(uint256 streamId);
    error NotTransferable(uint256 streamId);

    constructor() ERC721("Sablier Lockup NFT", "SAB-LOCKUP") {}

    function setMinFeeWei(uint256 fee) external {
        minFeeWei = fee;
    }

    function setLockupModel(uint256 streamId, Lockup.Model model) external {
        _streams[streamId].model = model;
    }

    /// @dev Mirrors the effects of `cancel` on the flags RoseVault reads.
    function markCanceled(uint256 streamId) external {
        _streams[streamId].canceled = true;
        _streams[streamId].cancelable = false;
    }

    // forge-lint: disable-next-line(mixed-case-function)
    function createWithTimestampsLL(
        Lockup.CreateWithTimestamps calldata params,
        LockupLinear.UnlockAmounts calldata unlockAmounts,
        uint40 granularity,
        uint40 cliffTime
    ) external payable returns (uint256 streamId) {
        streamId = nextStreamId++;
        _streams[streamId] = Stream({
            sender: params.sender,
            token: params.token,
            start: params.timestamps.start,
            cliff: cliffTime,
            end: params.timestamps.end,
            granularity: granularity == 0 ? 1 : granularity,
            deposited: params.depositAmount,
            withdrawn: 0,
            startUnlock: unlockAmounts.start,
            cliffUnlock: unlockAmounts.cliff,
            cancelable: params.cancelable,
            transferable: params.transferable,
            canceled: false,
            depleted: false,
            model: Lockup.Model.LOCKUP_LINEAR
        });
        params.token.safeTransferFrom(msg.sender, address(this), params.depositAmount);
        _mint(params.recipient, streamId);
    }

    function getLockupModel(uint256 streamId) external view returns (Lockup.Model) {
        return _streams[streamId].model;
    }

    function getUnderlyingToken(uint256 streamId) external view returns (IERC20) {
        return _streams[streamId].token;
    }

    function getDepositedAmount(uint256 streamId) external view returns (uint128) {
        return _streams[streamId].deposited;
    }

    function getWithdrawnAmount(uint256 streamId) external view returns (uint128) {
        return _streams[streamId].withdrawn;
    }

    function getStartTime(uint256 streamId) external view returns (uint40) {
        return _streams[streamId].start;
    }

    function getCliffTime(uint256 streamId) external view returns (uint40) {
        return _streams[streamId].cliff;
    }

    function getEndTime(uint256 streamId) external view returns (uint40) {
        return _streams[streamId].end;
    }

    function getGranularity(uint256 streamId) external view returns (uint40) {
        return _streams[streamId].granularity;
    }

    function getUnlockAmounts(uint256 streamId) external view returns (LockupLinear.UnlockAmounts memory) {
        return
            LockupLinear.UnlockAmounts({start: _streams[streamId].startUnlock, cliff: _streams[streamId].cliffUnlock});
    }

    /// @dev Mirrors `SablierLockupState.isCancelable` (lockup@v4.0.1, lines 233-237): the stored flag is reported
    /// only while the stream is not SETTLED, and a stream is SETTLED once it has started, is neither depleted nor
    /// canceled, and its streamed amount has reached the deposit.
    function isCancelable(uint256 streamId) external view returns (bool) {
        return _streams[streamId].cancelable && !_isSettled(streamId);
    }

    function isTransferable(uint256 streamId) external view returns (bool) {
        return _streams[streamId].transferable;
    }

    function isDepleted(uint256 streamId) external view returns (bool) {
        return _streams[streamId].depleted;
    }

    function wasCanceled(uint256 streamId) external view returns (bool) {
        return _streams[streamId].canceled;
    }

    function calculateMinFeeWei(uint256) external view returns (uint256) {
        return minFeeWei;
    }

    function withdrawableAmountOf(uint256 streamId) public view returns (uint128) {
        return streamedAmountOf(streamId) - _streams[streamId].withdrawn;
    }

    function streamedAmountOf(uint256 streamId) public view returns (uint128) {
        Stream storage s = _streams[streamId];
        if (s.start > block.timestamp) {
            return 0;
        }
        if (s.cliff > block.timestamp) {
            return s.startUnlock;
        }
        if (s.end <= block.timestamp) {
            return s.deposited;
        }
        uint128 unlockSum = s.startUnlock + s.cliffUnlock;
        if (unlockSum >= s.deposited) {
            return s.deposited;
        }
        uint256 from = s.cliff == 0 ? s.start : s.cliff;
        uint256 elapsedUnits = (block.timestamp - from) / s.granularity;
        uint256 streamable = s.deposited - unlockSum;
        // forge-lint: disable-next-line(unsafe-typecast)
        return unlockSum + uint128(elapsedUnits * streamable * s.granularity / (s.end - from));
    }

    function withdrawMax(uint256 streamId, address to) external payable returns (uint128 amount) {
        if (msg.value < minFeeWei) {
            revert InsufficientFeePayment(msg.value, minFeeWei);
        }
        Stream storage s = _streams[streamId];
        if (s.depleted) {
            revert StreamDepletedError(streamId);
        }
        address recipient = _requireOwned(streamId);
        if (to != recipient && !_isAuthorized(recipient, msg.sender, streamId)) {
            revert WithdrawalAddressNotRecipient(streamId, msg.sender, to);
        }
        amount = withdrawableAmountOf(streamId);
        if (amount == 0) {
            revert WithdrawAmountZero(streamId);
        }
        s.withdrawn += amount;
        if (s.withdrawn >= s.deposited) {
            s.depleted = true;
            s.cancelable = false;
        }
        s.token.safeTransfer(to, amount);
    }

    /// @dev The SETTLED branch of `SablierLockupState._statusOf`: not DEPLETED, not CANCELED, not PENDING, and no
    /// longer STREAMING because the streamed amount equals the deposit.
    function _isSettled(uint256 streamId) private view returns (bool) {
        Stream storage s = _streams[streamId];
        if (s.depleted || s.canceled || block.timestamp < s.start) {
            return false;
        }
        return streamedAmountOf(streamId) >= s.deposited;
    }

    function _update(address to, uint256 streamId, address auth) internal override returns (address) {
        address from = _ownerOf(streamId);
        if (from != address(0) && to != address(0) && !_streams[streamId].transferable) {
            revert NotTransferable(streamId);
        }
        return super._update(to, streamId, auth);
    }
}
