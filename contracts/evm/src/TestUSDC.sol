// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title TestUSDC
/// @notice "Test USDC" (tUSDC): a valueless 6-decimal test token for rose on Base Sepolia, mintable by anyone.
/// @dev Each address can mint at most `MINT_CAP` (10,000 tUSDC) per fixed window of `MINT_WINDOW` (24 hours), in
/// one or several calls. The window is not rolling: it starts at the address's first mint after the previous window
/// expired and ends `MINT_WINDOW` later, whatever is minted in between.
contract TestUSDC is ERC20 {
    uint256 public constant MINT_CAP = 10_000e6;
    uint256 public constant MINT_WINDOW = 1 days;

    struct MintWindow {
        uint256 start;
        uint256 minted;
    }

    mapping(address account => MintWindow window) private _windows;

    error ZeroAmount();
    error MintCapExceeded(uint256 requested, uint256 available);

    constructor() ERC20("Test USDC", "tUSDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Mints `amount` tUSDC to the caller within the per-address cap.
    function mint(uint256 amount) external {
        if (amount == 0) {
            revert ZeroAmount();
        }
        uint256 available = mintableAmount(msg.sender);
        if (amount > available) {
            revert MintCapExceeded(amount, available);
        }
        MintWindow storage window = _windows[msg.sender];
        if (block.timestamp >= window.start + MINT_WINDOW) {
            window.start = block.timestamp;
            window.minted = amount;
        } else {
            window.minted += amount;
        }
        _mint(msg.sender, amount);
    }

    /// @notice How much `account` can still mint in its current window.
    function mintableAmount(address account) public view returns (uint256) {
        MintWindow memory window = _windows[account];
        if (block.timestamp >= window.start + MINT_WINDOW) {
            return MINT_CAP;
        }
        return MINT_CAP - window.minted;
    }
}
