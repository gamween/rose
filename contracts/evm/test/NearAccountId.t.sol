// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";

import {NearAccountId} from "../src/libraries/NearAccountId.sol";

contract NearAccountIdHarness {
    function isValid(string calldata accountId) external pure returns (bool) {
        return NearAccountId.isValid(accountId);
    }
}

contract NearAccountIdTest is Test {
    NearAccountIdHarness internal harness = new NearAccountIdHarness();

    function test_acceptsValidIds() public view {
        string[8] memory valid = [
            "ok",
            "rose-app.testnet",
            "alice.rose-app.testnet",
            "a_b-c.d0",
            "0x7d4777cfc6ed48061b0bccae558d29919b412042",
            "98793cd91a3f870fb126f66285808c7e094afcfc4eda8a970f6648cdf0dbd6de",
            "v1.signer-prod.testnet",
            "1234567890123456789012345678901234567890123456789012345678901234"
        ];
        for (uint256 i; i < valid.length; ++i) {
            assertTrue(harness.isValid(valid[i]), valid[i]);
        }
    }

    function test_rejectsInvalidIds() public view {
        string[12] memory invalid = [
            "",
            "a",
            "Alice.testnet",
            ".alice",
            "alice.",
            "alice..testnet",
            "a-.b",
            "a__b",
            "-alice",
            "alice testnet",
            "alice@testnet",
            "12345678901234567890123456789012345678901234567890123456789012345"
        ];
        for (uint256 i; i < invalid.length; ++i) {
            assertFalse(harness.isValid(invalid[i]), invalid[i]);
        }
    }
}
