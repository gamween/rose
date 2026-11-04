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
