// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";

import {TestUSDC} from "../src/TestUSDC.sol";

contract TestUSDCTest is Test {
    TestUSDC internal usdc;
    address internal alice = makeAddr("alice");

    function setUp() public {
        vm.warp(1_800_000_000);
        usdc = new TestUSDC();
    }

    function test_metadata() public view {
        assertEq(usdc.name(), "Test USDC");
        assertEq(usdc.symbol(), "tUSDC");
        assertEq(usdc.decimals(), 6);
        assertEq(usdc.MINT_CAP(), 10_000e6);
        assertEq(usdc.MINT_WINDOW(), 1 days);
    }

    function test_mint_upToCapAcrossCalls() public {
        vm.startPrank(alice);
        usdc.mint(4_000e6);
        usdc.mint(6_000e6);
        assertEq(usdc.balanceOf(alice), 10_000e6);
        assertEq(usdc.mintableAmount(alice), 0);
        vm.expectRevert(abi.encodeWithSelector(TestUSDC.MintCapExceeded.selector, 1, 0));
        usdc.mint(1);
        vm.stopPrank();
    }

    function test_mint_rejectsAboveCapInOneCall() public {
        vm.expectRevert(abi.encodeWithSelector(TestUSDC.MintCapExceeded.selector, 10_000e6 + 1, 10_000e6));
        vm.prank(alice);
        usdc.mint(10_000e6 + 1);
    }

    function test_mint_rejectsZero() public {
        vm.expectRevert(TestUSDC.ZeroAmount.selector);
        vm.prank(alice);
        usdc.mint(0);
    }

    function test_mint_windowResetsAfter24Hours() public {
        vm.prank(alice);
        usdc.mint(10_000e6);
        vm.warp(block.timestamp + 1 days - 1);
        assertEq(usdc.mintableAmount(alice), 0);
        vm.warp(block.timestamp + 1);
        assertEq(usdc.mintableAmount(alice), 10_000e6);
        vm.prank(alice);
        usdc.mint(10_000e6);
        assertEq(usdc.balanceOf(alice), 20_000e6);
    }

    function test_mint_capIsPerAddress() public {
        vm.prank(alice);
        usdc.mint(10_000e6);
        address bob = makeAddr("bob");
        vm.prank(bob);
        usdc.mint(10_000e6);
        assertEq(usdc.totalSupply(), 20_000e6);
    }
}
