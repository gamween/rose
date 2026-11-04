// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {DemoStreamFaucet} from "../src/DemoStreamFaucet.sol";
import {DemoToken} from "../src/DemoToken.sol";
import {RoseVault} from "../src/RoseVault.sol";
import {ISablierLockup, Lockup, LockupLinear} from "../src/interfaces/ISablierLockup.sol";
import {MpcSignature} from "./utils/MpcSignature.sol";

/// @dev Subset of Sablier's comptroller (sablier-labs/evm-monorepo `utils@v2.0.1`, ISablierComptroller), used to turn
/// on the Lockup withdrawal fee, which is zero on Base Sepolia at FORK_BLOCK.
interface ISablierComptroller {
    function admin() external view returns (address);

    // forge-lint: disable-next-line(mixed-case-function, mixed-case-variable)
    function setMinFeeUSD(uint8 protocol, uint256 newMinFeeUSD) external;
}

/// @notice RoseVault and DemoStreamFaucet against the real Sablier Lockup v4 deployment on Base Sepolia.
/// @dev The fork is pinned so Foundry serves it from its RPC cache after the first run.
contract RoseVaultForkTest is Test {
    uint256 internal constant FORK_BLOCK = 54_150_000;
    ISablierLockup internal constant SABLIER = ISablierLockup(0xA65A1ecEf02C2B9BDc604951c6A6D02335D4532e);
    /// @dev Lockup Tranched stream 61 at FORK_BLOCK: non-transferable, non-cancelable, not depleted.
    uint256 internal constant TRANCHED_STREAM = 61;
    ISablierComptroller internal constant COMPTROLLER = ISablierComptroller(0x0000008ABbFf7a84a2fE09f9A9b74D3BC2072399);
    uint8 internal constant PROTOCOL_LOCKUP = 2;
    uint256 internal constant SIGNER_KEY = 0xA11CE;
    string internal constant NEAR_ACCOUNT = "holder.rose-app.testnet";

    DemoToken internal token;
    DemoStreamFaucet internal faucet;
    RoseVault internal vault;
    uint40 internal t0;
    address internal holder = makeAddr("holder");
    address internal claimant = makeAddr("claimant");

    function setUp() public {
        vm.createSelectFork("base_sepolia", FORK_BLOCK);
        t0 = uint40(block.timestamp);
        token = new DemoToken("Demo Token", "DEMO", address(this), 1_000_000_000e18);
        faucet = new DemoStreamFaucet(
            SABLIER,
            IERC20(address(token)),
            DemoStreamFaucet.Schedule({
                start: t0 - 180 days,
                cliff: t0 + 185 days,
                end: t0 + 915 days,
                amount: 100_000e18,
                startUnlock: 0,
                cliffUnlock: 25_000e18
            }),
            DemoStreamFaucet.Schedule({
                start: t0 - 30 days,
                cliff: 0,
                end: t0 + 335 days,
                amount: 20_000e18,
                startUnlock: 2_000e18,
                cliffUnlock: 0
            })
        );
        assertTrue(token.transfer(address(faucet), 10_000_000e18));
        vault = new RoseVault(SABLIER, vm.addr(SIGNER_KEY));
        vm.deal(holder, 1 ether);
        vm.deal(claimant, 1 ether);
    }

    function _mintAndDeposit(DemoStreamFaucet.Class class, uint256 value) internal returns (uint256 streamId) {
        vm.startPrank(holder);
        streamId = faucet.mintPosition(class);
        SABLIER.approve(address(vault), streamId);
        vault.depositStream{value: value}(SABLIER, streamId, NEAR_ACCOUNT);
        vm.stopPrank();
    }

    function test_fork_zeroWithdrawableDeposit() public {
        vm.prank(holder);
        uint256 streamId = faucet.mintPosition(DemoStreamFaucet.Class.Seed);
        assertEq(SABLIER.withdrawableAmountOf(streamId), 0);

        vm.startPrank(holder);
        SABLIER.approve(address(vault), streamId);
        vm.expectEmit(true, true, true, true, address(vault));
        emit RoseVault.StreamDeposited({
            sender: holder,
            nearAccount: NEAR_ACCOUNT,
            lockup: address(SABLIER),
            streamId: streamId,
            token: address(token),
            deposited: 100_000e18,
            withdrawn: 0,
            start: t0 - 180 days,
            cliff: t0 + 185 days,
            end: t0 + 915 days,
            granularity: 1,
            startUnlock: 0,
            cliffUnlock: 25_000e18,
            cancelable: false,
            transferable: true,
            timestamp: t0
        });
        vault.depositStream(SABLIER, streamId, NEAR_ACCOUNT);
        vm.stopPrank();
        assertEq(SABLIER.ownerOf(streamId), address(vault));
    }

    function test_fork_partlyVestedDepositPaysRealFee() public {
        vm.prank(COMPTROLLER.admin());
        COMPTROLLER.setMinFeeUSD(PROTOCOL_LOCKUP, 1e8);
        vm.prank(holder);
        uint256 streamId = faucet.mintPosition(DemoStreamFaucet.Class.Kol);
        uint128 vested = SABLIER.withdrawableAmountOf(streamId);
        uint256 fee = SABLIER.calculateMinFeeWei(streamId);
        assertGt(vested, 2_000e18);
        assertGt(fee, 0);
        uint256 ethBefore = holder.balance;

        vm.startPrank(holder);
        SABLIER.approve(address(vault), streamId);
        vault.depositStream{value: fee * 2}(SABLIER, streamId, NEAR_ACCOUNT);
        vm.stopPrank();

        assertEq(token.balanceOf(holder), vested);
        assertEq(SABLIER.getWithdrawnAmount(streamId), vested);
        assertEq(SABLIER.ownerOf(streamId), address(vault));
        assertEq(holder.balance, ethBefore - fee);
        assertEq(address(vault).balance, 0);
    }

    function test_fork_refusesCancelableStream() public {
        uint256 streamId = _createDirect(true, true);
        vm.startPrank(holder);
        SABLIER.approve(address(vault), streamId);
        vm.expectRevert(abi.encodeWithSelector(RoseVault.StreamCancelable.selector, streamId));
        vault.depositStream(SABLIER, streamId, NEAR_ACCOUNT);
        vm.stopPrank();
    }

    function test_fork_refusesNonTransferableStream() public {
        uint256 streamId = _createDirect(false, false);
        vm.startPrank(holder);
        SABLIER.approve(address(vault), streamId);
        vm.expectRevert(abi.encodeWithSelector(RoseVault.StreamNotTransferable.selector, streamId));
        vault.depositStream(SABLIER, streamId, NEAR_ACCOUNT);
        vm.stopPrank();
    }

    function test_fork_refusesTranchedStream() public {
        assertEq(uint8(SABLIER.getLockupModel(TRANCHED_STREAM)), uint8(Lockup.Model.LOCKUP_TRANCHED));
        address owner = SABLIER.ownerOf(TRANCHED_STREAM);
        vm.expectRevert(abi.encodeWithSelector(RoseVault.NotLockupLinear.selector, TRANCHED_STREAM));
        vm.prank(owner);
        vault.depositStream(SABLIER, TRANCHED_STREAM, NEAR_ACCOUNT);
    }

    /// @dev After a 200-day warp the comptroller treats its oracle price as stale and the fee is zero; fee forwarding
    /// on release is covered by the unit tests.
    function test_fork_releaseWithdrawsFirstThenTransferPaysOut() public {
        uint256 streamId = _mintAndDeposit(DemoStreamFaucet.Class.Seed, 0);
        vm.warp(t0 + 200 days);
        uint128 vested = SABLIER.withdrawableAmountOf(streamId);
        assertGt(vested, 25_000e18);
        uint256 fee = SABLIER.calculateMinFeeWei(streamId);
        uint256 claimantEthBefore = claimant.balance;

        RoseVault.Release memory release = RoseVault.Release(address(SABLIER), streamId, claimant, 1);
        (uint8 v, bytes32 r, bytes32 s) = MpcSignature.sign(SIGNER_KEY, vault.hashRelease(release));
        vm.prank(claimant);
        vault.executeRelease{value: fee + 1 gwei}(release, v, r, s);
        assertEq(claimant.balance, claimantEthBefore - fee);
        assertEq(SABLIER.ownerOf(streamId), claimant);
        assertEq(token.balanceOf(address(vault)), vested);
        assertEq(SABLIER.withdrawableAmountOf(streamId), 0);

        RoseVault.Transfer memory payout = RoseVault.Transfer(address(token), claimant, vested, 2);
        (v, r, s) = MpcSignature.sign(SIGNER_KEY, vault.hashTransfer(payout));
        vault.executeTransfer(payout, v, r, s);
        assertEq(token.balanceOf(claimant), vested);
        assertEq(token.balanceOf(address(vault)), 0);
    }

    function test_fork_anyoneWithdrawsVaultStreamToVault() public {
        uint256 streamId = _mintAndDeposit(DemoStreamFaucet.Class.Seed, 0);
        vm.warp(t0 + 200 days);
        uint128 vested = SABLIER.withdrawableAmountOf(streamId);
        uint256 fee = SABLIER.calculateMinFeeWei(streamId);
        vm.prank(claimant);
        SABLIER.withdrawMax{value: fee}(streamId, address(vault));
        assertEq(token.balanceOf(address(vault)), vested);
    }

    function _createDirect(bool cancelable, bool transferable) internal returns (uint256) {
        token.approve(address(SABLIER), 1_000e18);
        return SABLIER.createWithTimestampsLL(
            Lockup.CreateWithTimestamps({
                sender: address(this),
                recipient: holder,
                depositAmount: 1_000e18,
                token: IERC20(address(token)),
                cancelable: cancelable,
                transferable: transferable,
                timestamps: Lockup.Timestamps({start: t0, end: t0 + 365 days}),
                shape: ""
            }),
            LockupLinear.UnlockAmounts({start: 0, cliff: 0}),
            1,
            0
        );
    }
}
