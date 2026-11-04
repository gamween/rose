// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {ISablierLockup, Lockup, LockupLinear} from "./interfaces/ISablierLockup.sol";

/// @title DemoStreamFaucet
/// @notice "Mint me a demo vesting position": creates a Sablier Lockup Linear stream of the demo token to the caller.
/// @dev Streams are transferable and non-cancelable, so RoseVault accepts them. Each class has one fixed schedule
/// (absolute timestamps and fixed amounts) set at construction, so every position of a class is economically
/// identical and fungible in rose. Each address can mint one position per class every `COOLDOWN`. The faucet holds
/// the demo tokens it streams; it has no owner and its schedules cannot change.
contract DemoStreamFaucet {
    using SafeERC20 for IERC20;

    enum Class {
        Seed,
        Kol
    }

    /// @param start Stream start (Unix seconds).
    /// @param cliff Cliff time (Unix seconds), or zero for no cliff.
    /// @param end Stream end (Unix seconds).
    /// @param amount Deposit of each stream.
    /// @param startUnlock Amount unlocked at `start`.
    /// @param cliffUnlock Amount unlocked at `cliff` (zero when there is no cliff).
    struct Schedule {
        uint40 start;
        uint40 cliff;
        uint40 end;
        uint128 amount;
        uint128 startUnlock;
        uint128 cliffUnlock;
    }

    uint256 public constant COOLDOWN = 1 days;

    /// @notice Unlock step of every stream: one second, i.e. a continuous linear unlock.
    uint40 public constant GRANULARITY = 1;

    ISablierLockup public immutable LOCKUP;
    IERC20 public immutable TOKEN;

    mapping(Class class => Schedule schedule) private _schedules;
    mapping(address account => mapping(Class class => uint256 timestamp)) public lastMintAt;

    event PositionMinted(address indexed recipient, Class indexed class, uint256 indexed streamId);

    error ZeroAddress();
    error InvalidSchedule(Class class);
    error ScheduleEnded(Class class);
    error CooldownActive(uint256 availableAt);
    error FaucetEmpty(uint256 balance, uint256 required);

    constructor(ISablierLockup lockup, IERC20 token, Schedule memory seed, Schedule memory kol) {
        if (address(lockup) == address(0) || address(token) == address(0)) {
            revert ZeroAddress();
        }
        _validate(Class.Seed, seed);
        _validate(Class.Kol, kol);
        LOCKUP = lockup;
        TOKEN = token;
        _schedules[Class.Seed] = seed;
        _schedules[Class.Kol] = kol;
        token.forceApprove(address(lockup), type(uint256).max);
    }

    /// @notice Creates a transferable, non-cancelable LL stream of `class` to the caller.
    function mintPosition(Class class) external returns (uint256 streamId) {
        Schedule memory schedule = _schedules[class];
        if (block.timestamp >= schedule.end) {
            revert ScheduleEnded(class);
        }
        uint256 last = lastMintAt[msg.sender][class];
        if (last != 0 && block.timestamp < last + COOLDOWN) {
            revert CooldownActive(last + COOLDOWN);
        }
        uint256 balance = TOKEN.balanceOf(address(this));
        if (balance < schedule.amount) {
            revert FaucetEmpty(balance, schedule.amount);
        }
        lastMintAt[msg.sender][class] = block.timestamp;

        streamId = LOCKUP.createWithTimestampsLL(
            Lockup.CreateWithTimestamps({
                sender: address(this),
                recipient: msg.sender,
                depositAmount: schedule.amount,
                token: TOKEN,
                cancelable: false,
                transferable: true,
                timestamps: Lockup.Timestamps({start: schedule.start, end: schedule.end}),
                shape: ""
            }),
            LockupLinear.UnlockAmounts({start: schedule.startUnlock, cliff: schedule.cliffUnlock}),
            GRANULARITY,
            schedule.cliff
        );
        emit PositionMinted(msg.sender, class, streamId);
    }

    /// @notice The fixed schedule of `class`.
    function scheduleOf(Class class) external view returns (Schedule memory) {
        return _schedules[class];
    }

    /// @dev Mirrors the Sablier LL creation checks so a bad template fails at deployment, not at the first mint.
    function _validate(Class class, Schedule memory schedule) private pure {
        bool validTimes = schedule.start > 0 && schedule.start < schedule.end
            && (schedule.cliff == 0 || (schedule.start < schedule.cliff && schedule.cliff < schedule.end));
        bool validAmounts = schedule.amount > 0 && schedule.startUnlock + schedule.cliffUnlock <= schedule.amount
            && (schedule.cliff != 0 || schedule.cliffUnlock == 0);
        if (!validTimes || !validAmounts) {
            revert InvalidSchedule(class);
        }
    }
}
