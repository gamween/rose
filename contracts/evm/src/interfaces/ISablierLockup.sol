// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.29;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

/// @notice Subset of the Sablier Lockup v4 types used by rose.
/// @dev Copied field for field from sablier-labs/evm-monorepo tag `lockup@v4.0.1`, file `lockup/src/types/Lockup.sol`.
/// Only the members rose reads or writes are declared; field order and types must stay identical for ABI encoding.
library Lockup {
    enum Model {
        LOCKUP_LINEAR,
        LOCKUP_DYNAMIC,
        LOCKUP_TRANCHED,
        LOCKUP_PRICE_GATED
    }

    struct Timestamps {
        uint40 start;
        uint40 end;
    }

    struct CreateWithTimestamps {
        address sender;
        address recipient;
        uint128 depositAmount;
        IERC20 token;
        bool cancelable;
        bool transferable;
        Timestamps timestamps;
        string shape;
    }
}

/// @notice Subset of the Sablier Lockup v4 Lockup Linear types used by rose.
/// @dev Copied from sablier-labs/evm-monorepo tag `lockup@v4.0.1`, file `lockup/src/types/LockupLinear.sol`.
library LockupLinear {
    struct UnlockAmounts {
        uint128 start;
        uint128 cliff;
    }
}

/// @title ISablierLockup
/// @notice Minimal interface of the Sablier Lockup v4 contract (`SablierLockup`), limited to the functions rose calls.
/// @dev Signatures match sablier-labs/evm-monorepo tag `lockup@v4.0.1` (`lockup/src/interfaces/ISablierLockup.sol`,
/// `ISablierLockupState.sol`, `ISablierLockupLinear.sol`). The Base Sepolia deployment
/// 0xA65A1ecEf02C2B9BDc604951c6A6D02335D4532e exposes every selector below (checked against its runtime bytecode).
interface ISablierLockup is IERC721 {
    function getLockupModel(uint256 streamId) external view returns (Lockup.Model lockupModel);

    function getUnderlyingToken(uint256 streamId) external view returns (IERC20 token);

    function getDepositedAmount(uint256 streamId) external view returns (uint128 depositedAmount);

    function getWithdrawnAmount(uint256 streamId) external view returns (uint128 withdrawnAmount);

    function getStartTime(uint256 streamId) external view returns (uint40 startTime);

    function getCliffTime(uint256 streamId) external view returns (uint40 cliffTime);

    function getEndTime(uint256 streamId) external view returns (uint40 endTime);

    function getGranularity(uint256 streamId) external view returns (uint40 granularity);

    function getUnlockAmounts(uint256 streamId) external view returns (LockupLinear.UnlockAmounts memory unlockAmounts);

    function isCancelable(uint256 streamId) external view returns (bool result);

    function isTransferable(uint256 streamId) external view returns (bool result);

    function isDepleted(uint256 streamId) external view returns (bool result);

    function wasCanceled(uint256 streamId) external view returns (bool result);

    function withdrawableAmountOf(uint256 streamId) external view returns (uint128 withdrawableAmount);

    /// @dev The fee is set by Sablier's admin in USD and converted through a price oracle by the comptroller
    /// (0x0000008ABbFf7a84a2fE09f9A9b74D3BC2072399 on Base Sepolia, where it is currently zero), so the value read
    /// at submit time can differ from the value charged at inclusion; attach it plus a margin.
    function calculateMinFeeWei(uint256 streamId) external view returns (uint256 minFeeWei);

    function withdrawMax(uint256 streamId, address to) external payable returns (uint128 withdrawnAmount);

    // forge-lint: disable-next-line(mixed-case-function)
    function createWithTimestampsLL(
        Lockup.CreateWithTimestamps calldata params,
        LockupLinear.UnlockAmounts calldata unlockAmounts,
        uint40 granularity,
        uint40 cliffTime
    ) external payable returns (uint256 streamId);
}
