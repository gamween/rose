// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title DemoToken
/// @notice The fictional token of rose's demo issuer on Base Sepolia (18 decimals, fixed supply, no value).
/// @dev The whole supply is minted once to `holder` (the demo issuer), who funds the demo stream faucet and creates
/// the seeded cohorts' streams.
contract DemoToken is ERC20 {
    error ZeroAddress();

    constructor(string memory name_, string memory symbol_, address holder, uint256 supply) ERC20(name_, symbol_) {
        if (holder == address(0)) {
            revert ZeroAddress();
        }
        _mint(holder, supply);
    }
}
