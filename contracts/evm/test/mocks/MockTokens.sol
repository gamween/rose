// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockERC20 is ERC20 {
    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice Answers every call, `decimals()` included, with the configured raw bytes, to exercise RoseVault's
/// decimals validation (missing function, malformed return, value above 255).
contract RawDecimalsToken {
    bytes private _answer;
    bool private _reverts;

    function setAnswer(bytes memory answer, bool reverts) external {
        _answer = answer;
        _reverts = reverts;
    }

    fallback() external {
        if (_reverts) {
            revert();
        }
        bytes memory answer = _answer;
        assembly {
            return(add(answer, 32), mload(answer))
        }
    }
}

/// @notice Burns 1% of every transfer, to exercise RoseVault's exact-amount check.
contract FeeOnTransferToken is ERC20 {
    constructor() ERC20("Fee Token", "FEE") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 fee = value / 100;
            super._update(from, address(0), fee);
            super._update(from, to, value - fee);
        } else {
            super._update(from, to, value);
        }
    }
}

/// @notice Reports 18 decimals until a transfer leaves `trigger`, then 6: shows that a stream log carries the
/// decimals read for the minimum check rather than whatever the token answers later in the same call.
contract ShiftingDecimalsToken is ERC20 {
    uint8 private _decimals = 18;
    address private _trigger;

    constructor() ERC20("Shifting Decimals", "SHIFT") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setTrigger(address trigger) external {
        _trigger = trigger;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (from == _trigger) {
            _decimals = 6;
        }
    }
}

/// @notice Re-enters `target` with the armed call during the next transfer it performs, records the reason that
/// re-entry failed with and lets the transfer complete; a re-entry that succeeds reverts the whole call.
contract ReentrantToken is ERC20 {
    address private _target;
    bytes private _attack;
    bytes public lastReason;

    error ReentrySucceeded();

    constructor() ERC20("Reentrant", "RENT") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function arm(address target, bytes calldata attack) external {
        _target = target;
        _attack = attack;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (_attack.length == 0) {
            return;
        }
        bytes memory attack = _attack;
        delete _attack;
        (bool ok, bytes memory reason) = _target.call(attack);
        if (ok) {
            revert ReentrySucceeded();
        }
        lastReason = reason;
    }
}
