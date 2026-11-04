// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

/// @title NearAccountId
/// @notice Validates NEAR account IDs so that a deposit can never be attributed to a string the NEAR engine
/// cannot credit.
/// @dev Implements the nearcore rule: 2 to 64 bytes, lowercase alphanumeric runs separated by a single `-`, `_` or
/// `.`, starting and ending with an alphanumeric character. Equivalent regex:
/// `^(([a-z\d]+[\-_])*[a-z\d]+\.)*([a-z\d]+[\-_])*[a-z\d]+$`. Named, implicit (64 hex) and ETH-implicit (`0x` + 40 hex)
/// accounts all satisfy it.
library NearAccountId {
    uint256 internal constant MIN_LENGTH = 2;
    uint256 internal constant MAX_LENGTH = 64;

    function isValid(string calldata accountId) internal pure returns (bool) {
        bytes calldata b = bytes(accountId);
        uint256 length = b.length;
        if (length < MIN_LENGTH || length > MAX_LENGTH) {
            return false;
        }
        bool previousIsSeparator = true;
        for (uint256 i; i < length; ++i) {
            bytes1 c = b[i];
            if ((c >= "a" && c <= "z") || (c >= "0" && c <= "9")) {
                previousIsSeparator = false;
            } else if (c == "-" || c == "_" || c == ".") {
                if (previousIsSeparator) {
                    return false;
                }
                previousIsSeparator = true;
            } else {
                return false;
            }
        }
        return !previousIsSeparator;
    }
}
