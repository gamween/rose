// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {DemoStreamFaucet} from "../src/DemoStreamFaucet.sol";
import {DemoToken} from "../src/DemoToken.sol";
import {RoseVault} from "../src/RoseVault.sol";
import {ISablierLockup} from "../src/interfaces/ISablierLockup.sol";
import {MockLockup} from "./mocks/MockLockup.sol";

contract DemoStreamFaucetTest is Test {
    uint40 internal constant NOW = 1_800_000_000;

    MockLockup internal lockupMock;
    ISablierLockup internal lockup;
    DemoToken internal token;
    DemoStreamFaucet internal faucet;
    RoseVault internal vault;
    address internal alice = makeAddr("alice");

    function setUp() public {
        vm.warp(NOW);
        lockupMock = new MockLockup();
        lockup = ISablierLockup(address(lockupMock));
        token = new DemoToken("Demo Token", "DEMO", address(this), 1_000_000_000e18);
        faucet = new DemoStreamFaucet(lockup, IERC20(address(token)), _seed(), _kol());
        assertTrue(token.transfer(address(faucet), 10_000_000e18));
        vault = new RoseVault(lockup, makeAddr("signer"));
    }

    function _seed() internal pure returns (DemoStreamFaucet.Schedule memory) {
        return DemoStreamFaucet.Schedule({
            start: NOW - 180 days,
            cliff: NOW + 185 days,
            end: NOW + 915 days,
            amount: 100_000e18,
            startUnlock: 0,
            cliffUnlock: 25_000e18
        });
    }

    function _kol() internal pure returns (DemoStreamFaucet.Schedule memory) {
        return DemoStreamFaucet.Schedule({
            start: NOW - 30 days,
            cliff: 0,
            end: NOW + 335 days,
            amount: 20_000e18,
            startUnlock: 2_000e18,
            cliffUnlock: 0
        });
    }

    function test_demoToken_metadataAndSupply() public view {
        assertEq(token.name(), "Demo Token");
        assertEq(token.symbol(), "DEMO");
        assertEq(token.decimals(), 18);
        assertEq(token.totalSupply(), 1_000_000_000e18);
    }

    function test_mintPosition_createsEligibleStream() public {
        vm.prank(alice);
        uint256 streamId = faucet.mintPosition(DemoStreamFaucet.Class.Seed);

        assertEq(lockup.ownerOf(streamId), alice);
        assertFalse(lockup.isCancelable(streamId));
        assertTrue(lockup.isTransferable(streamId));
        assertEq(lockup.getDepositedAmount(streamId), 100_000e18);
        assertEq(lockup.getStartTime(streamId), NOW - 180 days);
        assertEq(lockup.getCliffTime(streamId), NOW + 185 days);
        assertEq(lockup.getEndTime(streamId), NOW + 915 days);
        assertEq(lockup.getGranularity(streamId), 1);
        assertEq(lockup.getUnlockAmounts(streamId).cliff, 25_000e18);
        assertEq(lockup.withdrawableAmountOf(streamId), 0);

        vm.startPrank(alice);
        lockup.approve(address(vault), streamId);
        vault.depositStream(lockup, streamId, "alice.testnet");
        vm.stopPrank();
        assertEq(lockup.ownerOf(streamId), address(vault));
    }

    function test_mintPosition_kolStreamIsPartlyVestedAndEligible() public {
        lockupMock.setMinFeeWei(0.0004 ether);
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        uint256 streamId = faucet.mintPosition(DemoStreamFaucet.Class.Kol);
        uint128 vested = lockup.withdrawableAmountOf(streamId);
        assertGt(vested, 2_000e18);

        vm.startPrank(alice);
        lockup.approve(address(vault), streamId);
        vault.depositStream{value: 0.0004 ether}(lockup, streamId, "alice.testnet");
        vm.stopPrank();
        assertEq(token.balanceOf(alice), vested);
        assertEq(lockup.ownerOf(streamId), address(vault));
    }

    function test_mintPosition_emitsEvent() public {
        vm.expectEmit(true, true, true, true, address(faucet));
        emit DemoStreamFaucet.PositionMinted(alice, DemoStreamFaucet.Class.Kol, 1);
        vm.prank(alice);
        faucet.mintPosition(DemoStreamFaucet.Class.Kol);
    }

    function test_mintPosition_cooldownPerAddressAndClass() public {
        vm.startPrank(alice);
        faucet.mintPosition(DemoStreamFaucet.Class.Seed);
        faucet.mintPosition(DemoStreamFaucet.Class.Kol);
        vm.expectRevert(abi.encodeWithSelector(DemoStreamFaucet.CooldownActive.selector, NOW + 1 days));
        faucet.mintPosition(DemoStreamFaucet.Class.Seed);
        vm.warp(NOW + 1 days);
        faucet.mintPosition(DemoStreamFaucet.Class.Seed);
        vm.stopPrank();
        assertEq(lockup.balanceOf(alice), 3);
    }

    function test_mintPosition_rejectsEndedSchedule() public {
        vm.warp(NOW + 335 days);
        vm.expectRevert(abi.encodeWithSelector(DemoStreamFaucet.ScheduleEnded.selector, DemoStreamFaucet.Class.Kol));
        vm.prank(alice);
        faucet.mintPosition(DemoStreamFaucet.Class.Kol);
    }

    function test_mintPosition_rejectsWhenEmpty() public {
        DemoStreamFaucet empty = new DemoStreamFaucet(lockup, IERC20(address(token)), _seed(), _kol());
        vm.expectRevert(abi.encodeWithSelector(DemoStreamFaucet.FaucetEmpty.selector, 0, 100_000e18));
        vm.prank(alice);
        empty.mintPosition(DemoStreamFaucet.Class.Seed);
    }

    function test_constructor_rejectsInvalidSchedules() public {
        DemoStreamFaucet.Schedule memory bad = _seed();
        bad.cliff = bad.end;
        vm.expectRevert(abi.encodeWithSelector(DemoStreamFaucet.InvalidSchedule.selector, DemoStreamFaucet.Class.Seed));
        new DemoStreamFaucet(lockup, IERC20(address(token)), bad, _kol());

        bad = _kol();
        bad.cliffUnlock = 1;
        vm.expectRevert(abi.encodeWithSelector(DemoStreamFaucet.InvalidSchedule.selector, DemoStreamFaucet.Class.Kol));
        new DemoStreamFaucet(lockup, IERC20(address(token)), _seed(), bad);

        bad = _seed();
        bad.startUnlock = bad.amount;
        vm.expectRevert(abi.encodeWithSelector(DemoStreamFaucet.InvalidSchedule.selector, DemoStreamFaucet.Class.Seed));
        new DemoStreamFaucet(lockup, IERC20(address(token)), bad, _kol());
    }

    function test_scheduleOf_returnsTemplate() public view {
        DemoStreamFaucet.Schedule memory seed = faucet.scheduleOf(DemoStreamFaucet.Class.Seed);
        assertEq(seed.amount, 100_000e18);
        assertEq(seed.cliffUnlock, 25_000e18);
    }
}
