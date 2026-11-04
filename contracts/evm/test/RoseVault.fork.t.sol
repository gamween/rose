// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Test, Vm} from "forge-std/Test.sol";
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

    /// @dev `SablierLockupState.isCancelable` (lockup@v4.0.1, lines 233-237) reports false once a stream is SETTLED,
    /// so a cancelable stream past its end clears the cancelable check; the vested withdrawal then depletes it and
    /// the vault refuses the deposit, leaving the NFT with the holder.
    function test_fork_refusesSettledCancelableStream() public {
        uint256 streamId = _createDirect(true, true);
        assertTrue(SABLIER.isCancelable(streamId));
        vm.warp(t0 + 365 days + 1);
        assertFalse(SABLIER.isCancelable(streamId));
        assertFalse(SABLIER.isDepleted(streamId));
        uint256 fee = SABLIER.calculateMinFeeWei(streamId);

        vm.startPrank(holder);
        SABLIER.approve(address(vault), streamId);
        vm.expectRevert(abi.encodeWithSelector(RoseVault.StreamDepleted.selector, streamId));
        vault.depositStream{value: fee}(SABLIER, streamId, NEAR_ACCOUNT);
        vm.stopPrank();

        assertEq(SABLIER.ownerOf(streamId), holder);
        assertEq(token.balanceOf(holder), 0);
        assertFalse(SABLIER.isDepleted(streamId));
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

    /// @dev Issuer path against the real Lockup: three cohort streams minted straight into the vault, with the exact
    /// `StreamDeposited` layout the engine parses (same words as the `depositStream` log).
    function test_fork_createStreamsCohort() public {
        RoseVault.CohortSchedule memory schedule = RoseVault.CohortSchedule({
            start: t0 - 180 days,
            cliff: t0 + 185 days,
            end: t0 + 915 days,
            granularity: 1,
            unitAmount: 4,
            unitStartUnlock: 0,
            unitCliffUnlock: 1
        });
        RoseVault.Allocation[] memory list = new RoseVault.Allocation[](3);
        list[0] = RoseVault.Allocation({nearAccount: "holder1.rose-app.testnet", amount: 100_000e18});
        list[1] = RoseVault.Allocation({nearAccount: "holder2.rose-app.testnet", amount: 40_000e18});
        list[2] = RoseVault.Allocation({nearAccount: "holder3.rose-app.testnet", amount: 8_000e18});
        uint256 total = 148_000e18;
        uint256 sablierBefore = token.balanceOf(address(SABLIER));
        uint256 issuerBefore = token.balanceOf(address(this));
        token.approve(address(vault), total);

        vm.recordLogs();
        uint256[] memory ids = vault.createStreams(IERC20(address(token)), schedule, list);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(ids.length, 3);
        uint256 found;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(vault)) {
                continue;
            }
            Vm.Log memory log = logs[i];
            uint256 streamId = ids[found];
            bytes memory nearAccount = bytes(list[found].nearAccount);
            assertEq(log.topics.length, 3);
            assertEq(
                log.topics[0],
                keccak256(
                    "StreamDeposited(address,string,address,uint256,address,uint128,uint128,uint40,uint40,uint40,uint40,uint128,uint128,bool,bool,uint40)"
                )
            );
            assertEq(log.topics[1], bytes32(uint256(uint160(address(this)))));
            assertEq(log.topics[2], bytes32(streamId));
            assertEq(log.data.length, 15 * 32 + 32);
            assertEq(_word(log.data, 0), 14 * 32);
            assertEq(_word(log.data, 1), uint256(uint160(address(SABLIER))));
            assertEq(_word(log.data, 2), uint256(uint160(address(token))));
            assertEq(_word(log.data, 3), list[found].amount);
            assertEq(_word(log.data, 4), 0);
            assertEq(_word(log.data, 5), t0 - 180 days);
            assertEq(_word(log.data, 6), t0 + 185 days);
            assertEq(_word(log.data, 7), t0 + 915 days);
            assertEq(_word(log.data, 8), 1);
            assertEq(_word(log.data, 9), 0);
            assertEq(_word(log.data, 10), list[found].amount / 4);
            assertEq(_word(log.data, 11), 0);
            assertEq(_word(log.data, 12), 1);
            assertEq(_word(log.data, 13), t0);
            assertEq(_word(log.data, 14), nearAccount.length);
            assertLe(nearAccount.length, 32);
            // forge-lint: disable-next-line(unsafe-typecast)
            assertEq(_word(log.data, 15), uint256(bytes32(nearAccount)));
            ++found;
        }
        assertEq(found, 3);

        for (uint256 i; i < 3; ++i) {
            assertEq(SABLIER.ownerOf(ids[i]), address(vault));
            assertFalse(SABLIER.isCancelable(ids[i]));
            assertTrue(SABLIER.isTransferable(ids[i]));
            assertFalse(SABLIER.wasCanceled(ids[i]));
            assertFalse(SABLIER.isDepleted(ids[i]));
            assertEq(uint8(SABLIER.getLockupModel(ids[i])), uint8(Lockup.Model.LOCKUP_LINEAR));
            assertEq(SABLIER.getDepositedAmount(ids[i]), list[i].amount);
            assertEq(SABLIER.getWithdrawnAmount(ids[i]), 0);
            assertEq(SABLIER.getUnlockAmounts(ids[i]).cliff, list[i].amount / 4);
            assertEq(SABLIER.withdrawableAmountOf(ids[i]), 0);
        }
        assertEq(token.balanceOf(address(SABLIER)), sablierBefore + total);
        assertEq(token.balanceOf(address(this)), issuerBefore - total);
        assertEq(token.balanceOf(address(vault)), 0);
        assertEq(token.allowance(address(vault), address(SABLIER)), 0);
    }

    function _word(bytes memory data, uint256 index) internal pure returns (uint256 value) {
        assembly {
            value := mload(add(data, add(32, mul(index, 32))))
        }
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
