// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Test, Vm} from "forge-std/Test.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import {RoseVault} from "../src/RoseVault.sol";
import {ISablierLockup, Lockup, LockupLinear} from "../src/interfaces/ISablierLockup.sol";
import {MockLockup} from "./mocks/MockLockup.sol";
import {
    FeeOnTransferToken,
    MockERC20,
    RawDecimalsToken,
    ReentrantToken,
    ShiftingDecimalsToken
} from "./mocks/MockTokens.sol";
import {MpcSignature} from "./utils/MpcSignature.sol";

contract RoseVaultTest is Test {
    uint256 internal constant SIGNER_KEY = 0xA11CE;
    uint256 internal constant FEE = 0.0004 ether;
    uint128 internal constant DEPOSIT = 1_000_000e18;
    uint40 internal constant NOW = 1_800_000_000;
    string internal constant NEAR_ACCOUNT = "alice.rose-app.testnet";
    bytes32 internal constant KAT_TRANSFER_DIGEST = 0x652ed7c219938bcc420b0786454c4e4a58b5baeed9dd1cfdf3ba8c4b1e08ac01;
    bytes32 internal constant KAT_RELEASE_DIGEST = 0xab3684e318c5c016035a36f948f02e970040e271317ea09a327d2c59f6fef666;
    bytes32 internal constant KAT_RETURN_DIGEST = 0x1aa2f755fbde4c0062a5437278478f1b0f3820980c2ef5560ac419d7dc5eafe3;

    MockLockup internal lockupMock;
    ISablierLockup internal lockup;
    MockERC20 internal token;
    MockERC20 internal usdc;
    RoseVault internal vault;
    address internal signer;
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    function setUp() public {
        vm.warp(NOW);
        lockupMock = new MockLockup();
        lockup = ISablierLockup(address(lockupMock));
        lockupMock.setMinFeeWei(FEE);
        token = new MockERC20("Demo", "DEMO");
        usdc = new MockERC20("USD Coin", "USDC");
        signer = vm.addr(SIGNER_KEY);
        vault = new RoseVault(lockup, signer);
        token.mint(address(this), type(uint128).max);
        token.approve(address(lockup), type(uint256).max);
        vm.deal(alice, 1 ether);
        vm.deal(bob, 1 ether);
    }

    /*//////////////////////////////////////////////////////////////////////////
                                      HELPERS
    //////////////////////////////////////////////////////////////////////////*/

    function _create(address recipient, bool cancelable, bool transferable, uint40 start, uint40 cliff, uint40 end)
        internal
        returns (uint256)
    {
        return lockup.createWithTimestampsLL(
            Lockup.CreateWithTimestamps({
                sender: address(this),
                recipient: recipient,
                depositAmount: DEPOSIT,
                token: IERC20(address(token)),
                cancelable: cancelable,
                transferable: transferable,
                timestamps: Lockup.Timestamps({start: start, end: end}),
                shape: ""
            }),
            LockupLinear.UnlockAmounts({start: 0, cliff: cliff == 0 ? 0 : DEPOSIT / 10}),
            1,
            cliff
        );
    }

    /// @dev Cliff 30 days ahead: nothing is withdrawable yet.
    function _lockedStream(address recipient) internal returns (uint256) {
        return _create(recipient, false, true, NOW - 30 days, NOW + 30 days, NOW + 365 days);
    }

    /// @dev Cliff passed 10 days ago: part of the stream is withdrawable.
    function _vestingStream(address recipient) internal returns (uint256) {
        return _create(recipient, false, true, NOW - 100 days, NOW - 10 days, NOW + 265 days);
    }

    function _deposit(address holder, uint256 streamId) internal {
        vm.startPrank(holder);
        lockup.approve(address(vault), streamId);
        vault.depositStream{value: FEE}(lockup, streamId, NEAR_ACCOUNT);
        vm.stopPrank();
    }

    function _signTransfer(uint256 key, RoseVault.Transfer memory auth)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        return MpcSignature.sign(key, vault.hashTransfer(auth));
    }

    function _signRelease(uint256 key, RoseVault.Release memory auth)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        return MpcSignature.sign(key, vault.hashRelease(auth));
    }

    function _fundVault(uint256 amount) internal {
        usdc.mint(address(vault), amount);
    }

    function _assertEntry(uint256 streamId, bool recorded, uint128 withdrawnAtEntry) internal view {
        (bool isRecorded, uint128 atEntry) = vault.streamEntries(streamId);
        assertEq(isRecorded, recorded);
        assertEq(atEntry, withdrawnAtEntry);
    }

    /*//////////////////////////////////////////////////////////////////////////
                                    CONSTRUCTION
    //////////////////////////////////////////////////////////////////////////*/

    function test_constructor_setsImmutables() public view {
        assertEq(address(vault.LOCKUP()), address(lockup));
        assertEq(vault.SIGNER(), signer);
    }

    function test_constructor_rejectsZeroAddresses() public {
        vm.expectRevert(RoseVault.ZeroAddress.selector);
        new RoseVault(ISablierLockup(address(0)), signer);
        vm.expectRevert(RoseVault.ZeroAddress.selector);
        new RoseVault(lockup, address(0));
    }

    /*//////////////////////////////////////////////////////////////////////////
                                      EIP-712
    //////////////////////////////////////////////////////////////////////////*/

    function test_typehashes() public view {
        assertEq(vault.TRANSFER_TYPEHASH(), keccak256("Transfer(address token,address to,uint256 amount,uint256 id)"));
        assertEq(
            vault.RELEASE_TYPEHASH(),
            keccak256("Release(address lockup,uint256 streamId,address to,bool vestedToRecipient,uint256 id)")
        );
    }

    function test_domainSeparator_matchesEip712() public view {
        bytes32 expected = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("RoseVault"),
                keccak256("1"),
                block.chainid,
                address(vault)
            )
        );
        assertEq(vault.domainSeparator(), expected);
        (, string memory name, string memory version, uint256 chainId, address verifyingContract,,) =
            vault.eip712Domain();
        assertEq(name, "RoseVault");
        assertEq(version, "1");
        assertEq(chainId, block.chainid);
        assertEq(verifyingContract, address(vault));
    }

    function test_hashTransfer_matchesManualDigest() public view {
        RoseVault.Transfer memory auth = RoseVault.Transfer(address(usdc), bob, 123e6, 42);
        bytes32 structHash = keccak256(abi.encode(vault.TRANSFER_TYPEHASH(), auth.token, auth.to, auth.amount, auth.id));
        bytes32 expected = keccak256(abi.encodePacked("\x19\x01", vault.domainSeparator(), structHash));
        assertEq(vault.hashTransfer(auth), expected);
    }

    function test_hashRelease_matchesManualDigest() public view {
        RoseVault.Release memory auth = RoseVault.Release(address(lockup), 9, bob, false, 43);
        bytes32 structHash = keccak256(
            abi.encode(vault.RELEASE_TYPEHASH(), auth.lockup, auth.streamId, auth.to, auth.vestedToRecipient, auth.id)
        );
        bytes32 expected = keccak256(abi.encodePacked("\x19\x01", vault.domainSeparator(), structHash));
        assertEq(vault.hashRelease(auth), expected);
    }

    /// @dev Known-answer vector shared with the NEAR engine and the SDK. The digest was computed independently with
    /// viem `hashTypedData` for chain 84532 and the verifying contract below.
    function test_digests_knownAnswerVectors() public {
        vm.chainId(84532);
        address at = 0x00000000000000000000000000000000000A11cE;
        deployCodeTo("RoseVault.sol:RoseVault", abi.encode(lockup, signer), at);
        RoseVault fixedVault = RoseVault(at);
        RoseVault.Transfer memory auth = RoseVault.Transfer(
            0x036CbD53842c5426634e7929541eC2318f3dCF7e, 0x000000000000000000000000000000000000b0b0, 1_000_000, 7
        );
        RoseVault.Release memory release = RoseVault.Release(
            0xA65A1ecEf02C2B9BDc604951c6A6D02335D4532e, 81, 0x000000000000000000000000000000000000b0b0, false, 8
        );
        assertEq(fixedVault.hashTransfer(auth), KAT_TRANSFER_DIGEST);
        assertEq(fixedVault.hashRelease(release), KAT_RELEASE_DIGEST);
        release.vestedToRecipient = true;
        assertEq(fixedVault.hashRelease(release), KAT_RETURN_DIGEST);
    }

    /*//////////////////////////////////////////////////////////////////////////
                                 SIGNATURE FORMAT
    //////////////////////////////////////////////////////////////////////////*/

    function test_executeTransfer_acceptsMpcFormatSignature() public {
        _fundVault(500e6);
        RoseVault.Transfer memory auth = RoseVault.Transfer(address(usdc), bob, 123e6, 1);
        (uint8 v, bytes32 r, bytes32 s) = _signTransfer(SIGNER_KEY, auth);
        assertTrue(v == 27 || v == 28);
        assertLe(uint256(s), MpcSignature.HALF_N);

        vm.expectEmit(true, true, true, true, address(vault));
        emit RoseVault.TransferExecuted(1, address(usdc), bob, 123e6);
        vm.prank(alice);
        vault.executeTransfer(auth, v, r, s);

        assertEq(usdc.balanceOf(bob), 123e6);
        assertEq(usdc.balanceOf(address(vault)), 377e6);
        assertTrue(vault.isAuthorizationUsed(1));
    }

    function test_executeTransfer_acceptsBothRecoveryIds() public {
        _fundVault(1_000e6);
        bool seen27;
        bool seen28;
        for (uint256 id = 0; id < 64 && !(seen27 && seen28); ++id) {
            RoseVault.Transfer memory auth = RoseVault.Transfer(address(usdc), bob, 1e6, id);
            (uint8 v, bytes32 r, bytes32 s) = _signTransfer(SIGNER_KEY, auth);
            vault.executeTransfer(auth, v, r, s);
            if (v == 27) seen27 = true;
            if (v == 28) seen28 = true;
        }
        assertTrue(seen27 && seen28);
    }

    function test_executeTransfer_rejectsHighS() public {
        _fundVault(500e6);
        RoseVault.Transfer memory auth = RoseVault.Transfer(address(usdc), bob, 1e6, 1);
        (uint8 v, bytes32 r, bytes32 s) = _signTransfer(SIGNER_KEY, auth);
        (uint8 highV, bytes32 highS) = MpcSignature.highS(v, s);
        // The malleable twin still recovers the signer through the raw precompile, so only the low-s rule stops it.
        assertEq(ecrecover(vault.hashTransfer(auth), highV, r, highS), signer);
        vm.expectRevert(abi.encodeWithSelector(RoseVault.InvalidSignatureS.selector, highS));
        vault.executeTransfer(auth, highV, r, highS);
    }

    function test_executeTransfer_rejectsRawRecoveryId() public {
        _fundVault(500e6);
        RoseVault.Transfer memory auth = RoseVault.Transfer(address(usdc), bob, 1e6, 1);
        (uint8 v, bytes32 r, bytes32 s) = _signTransfer(SIGNER_KEY, auth);
        uint8 recoveryId = v - 27;
        vm.expectRevert(abi.encodeWithSelector(RoseVault.InvalidSignatureV.selector, recoveryId));
        vault.executeTransfer(auth, recoveryId, r, s);
    }

    function test_executeTransfer_rejectsWrongSigner() public {
        _fundVault(500e6);
        RoseVault.Transfer memory auth = RoseVault.Transfer(address(usdc), bob, 1e6, 1);
        (uint8 v, bytes32 r, bytes32 s) = _signTransfer(0xB0B, auth);
        vm.expectRevert(abi.encodeWithSelector(RoseVault.InvalidSigner.selector, vm.addr(0xB0B)));
        vault.executeTransfer(auth, v, r, s);
    }

    function test_executeTransfer_rejectsTamperedAuthorization() public {
        _fundVault(500e6);
        RoseVault.Transfer memory auth = RoseVault.Transfer(address(usdc), bob, 1e6, 1);
        (uint8 v, bytes32 r, bytes32 s) = _signTransfer(SIGNER_KEY, auth);
        auth.amount = 400e6;
        vm.expectPartialRevert(RoseVault.InvalidSigner.selector);
        vault.executeTransfer(auth, v, r, s);
    }

    function test_executeTransfer_rejectsReleaseSignatureForSameFields() public {
        _fundVault(500e6);
        RoseVault.Release memory release = RoseVault.Release(address(usdc), uint256(uint160(bob)), bob, false, 1);
        (uint8 v, bytes32 r, bytes32 s) = _signRelease(SIGNER_KEY, release);
        RoseVault.Transfer memory auth = RoseVault.Transfer(address(usdc), bob, uint256(uint160(bob)), 1);
        vm.expectPartialRevert(RoseVault.InvalidSigner.selector);
        vault.executeTransfer(auth, v, r, s);
    }

    function test_executeTransfer_rejectsZeroRecipient() public {
        _fundVault(500e6);
        RoseVault.Transfer memory auth = RoseVault.Transfer(address(usdc), address(0), 1e6, 2);
        (uint8 v, bytes32 r, bytes32 s) = _signTransfer(SIGNER_KEY, auth);
        vm.expectRevert(RoseVault.ZeroAddress.selector);
        vault.executeTransfer(auth, v, r, s);
        assertFalse(vault.isAuthorizationUsed(2));
        assertEq(usdc.balanceOf(address(vault)), 500e6);
    }

    /*//////////////////////////////////////////////////////////////////////////
                                   REPLAY BITMAP
    //////////////////////////////////////////////////////////////////////////*/

    function test_executeTransfer_rejectsReplay() public {
        _fundVault(500e6);
        RoseVault.Transfer memory auth = RoseVault.Transfer(address(usdc), bob, 1e6, 7);
        (uint8 v, bytes32 r, bytes32 s) = _signTransfer(SIGNER_KEY, auth);
        vault.executeTransfer(auth, v, r, s);
        vm.expectRevert(abi.encodeWithSelector(RoseVault.AuthorizationUsed.selector, 7));
        vault.executeTransfer(auth, v, r, s);
    }

    function test_bitmap_idsAreIndependentAcrossWordBoundaries() public {
        _fundVault(500e6);
        uint256[4] memory ids = [uint256(255), 256, 0, type(uint256).max];
        for (uint256 i; i < ids.length; ++i) {
            assertFalse(vault.isAuthorizationUsed(ids[i]));
            RoseVault.Transfer memory auth = RoseVault.Transfer(address(usdc), bob, 1e6, ids[i]);
            (uint8 v, bytes32 r, bytes32 s) = _signTransfer(SIGNER_KEY, auth);
            vault.executeTransfer(auth, v, r, s);
            for (uint256 j; j < ids.length; ++j) {
                assertEq(vault.isAuthorizationUsed(ids[j]), j <= i);
            }
        }
        assertFalse(vault.isAuthorizationUsed(257));
        assertFalse(vault.isAuthorizationUsed(1));
    }

    function test_bitmap_transferAndReleaseShareIds() public {
        _fundVault(500e6);
        uint256 streamId = _lockedStream(alice);
        _deposit(alice, streamId);
        RoseVault.Transfer memory auth = RoseVault.Transfer(address(usdc), bob, 1e6, 5);
        (uint8 v, bytes32 r, bytes32 s) = _signTransfer(SIGNER_KEY, auth);
        vault.executeTransfer(auth, v, r, s);

        RoseVault.Release memory release = RoseVault.Release(address(lockup), streamId, bob, false, 5);
        (v, r, s) = _signRelease(SIGNER_KEY, release);
        vm.expectRevert(abi.encodeWithSelector(RoseVault.AuthorizationUsed.selector, 5));
        vault.executeRelease(release, v, r, s);
    }

    function testFuzz_bitmap_marksExactlyOneId(uint256 id) public {
        _fundVault(1e6);
        RoseVault.Transfer memory auth = RoseVault.Transfer(address(usdc), bob, 1e6, id);
        (uint8 v, bytes32 r, bytes32 s) = _signTransfer(SIGNER_KEY, auth);
        vault.executeTransfer(auth, v, r, s);
        assertTrue(vault.isAuthorizationUsed(id));
        assertFalse(vault.isAuthorizationUsed(id ^ 1));
        assertFalse(vault.isAuthorizationUsed(id ^ (1 << 8)));
    }

    /*//////////////////////////////////////////////////////////////////////////
                                  STREAM DEPOSIT
    //////////////////////////////////////////////////////////////////////////*/

    function test_depositStream_zeroWithdrawable_skipsWithdrawAndRefundsValue() public {
        uint256 streamId = _lockedStream(alice);
        assertEq(lockup.withdrawableAmountOf(streamId), 0);
        uint256 ethBefore = alice.balance;

        vm.startPrank(alice);
        lockup.approve(address(vault), streamId);
        vm.expectEmit(true, true, true, true, address(vault));
        emit RoseVault.StreamDeposited({
            sender: alice,
            nearAccount: NEAR_ACCOUNT,
            lockup: address(lockup),
            streamId: streamId,
            token: address(token),
            decimals: 18,
            deposited: DEPOSIT,
            withdrawn: 0,
            start: NOW - 30 days,
            cliff: NOW + 30 days,
            end: NOW + 365 days,
            granularity: 1,
            startUnlock: 0,
            cliffUnlock: DEPOSIT / 10,
            cancelable: false,
            transferable: true,
            timestamp: NOW
        });
        vault.depositStream{value: FEE}(lockup, streamId, NEAR_ACCOUNT);
        vm.stopPrank();

        assertEq(lockup.ownerOf(streamId), address(vault));
        assertEq(alice.balance, ethBefore);
        assertEq(address(lockup).balance, 0);
        assertEq(token.balanceOf(alice), 0);
    }

    function test_depositStream_zeroWithdrawable_worksWithoutValue() public {
        uint256 streamId = _lockedStream(alice);
        vm.startPrank(alice);
        lockup.approve(address(vault), streamId);
        vault.depositStream(lockup, streamId, NEAR_ACCOUNT);
        vm.stopPrank();
        assertEq(lockup.ownerOf(streamId), address(vault));
    }

    function test_depositStream_withdrawsVestedToHolderFirst() public {
        uint256 streamId = _vestingStream(alice);
        uint128 vested = lockup.withdrawableAmountOf(streamId);
        assertGt(vested, 0);
        uint256 ethBefore = alice.balance;

        vm.startPrank(alice);
        lockup.approve(address(vault), streamId);
        vm.expectEmit(true, true, true, true, address(vault));
        emit RoseVault.StreamDeposited({
            sender: alice,
            nearAccount: NEAR_ACCOUNT,
            lockup: address(lockup),
            streamId: streamId,
            token: address(token),
            decimals: 18,
            deposited: DEPOSIT,
            withdrawn: vested,
            start: NOW - 100 days,
            cliff: NOW - 10 days,
            end: NOW + 265 days,
            granularity: 1,
            startUnlock: 0,
            cliffUnlock: DEPOSIT / 10,
            cancelable: false,
            transferable: true,
            timestamp: NOW
        });
        vault.depositStream{value: 1 ether / 10}(lockup, streamId, NEAR_ACCOUNT);
        vm.stopPrank();

        assertEq(token.balanceOf(alice), vested);
        assertEq(lockup.getWithdrawnAmount(streamId), vested);
        assertEq(lockup.withdrawableAmountOf(streamId), 0);
        assertEq(lockup.ownerOf(streamId), address(vault));
        _assertEntry(streamId, true, vested);
        assertEq(address(lockup).balance, FEE);
        assertEq(alice.balance, ethBefore - FEE);
        assertEq(address(vault).balance, 0);
    }

    function test_depositStream_rejectsInsufficientFee() public {
        uint256 streamId = _vestingStream(alice);
        vm.startPrank(alice);
        lockup.approve(address(vault), streamId);
        vm.expectRevert(abi.encodeWithSelector(RoseVault.InsufficientFee.selector, FEE - 1, FEE));
        vault.depositStream{value: FEE - 1}(lockup, streamId, NEAR_ACCOUNT);
        vm.stopPrank();
    }

    function test_depositStream_rejectsWrongLockup() public {
        MockLockup other = new MockLockup();
        vm.expectRevert(abi.encodeWithSelector(RoseVault.WrongLockup.selector, address(other)));
        vm.prank(alice);
        vault.depositStream(ISablierLockup(address(other)), 1, NEAR_ACCOUNT);
    }

    function test_depositStream_rejectsNonLinear() public {
        uint256 streamId = _lockedStream(alice);
        lockupMock.setLockupModel(streamId, Lockup.Model.LOCKUP_TRANCHED);
        _expectDepositRevert(streamId, abi.encodeWithSelector(RoseVault.NotLockupLinear.selector, streamId));
        lockupMock.setLockupModel(streamId, Lockup.Model.LOCKUP_DYNAMIC);
        _expectDepositRevert(streamId, abi.encodeWithSelector(RoseVault.NotLockupLinear.selector, streamId));
        lockupMock.setLockupModel(streamId, Lockup.Model.LOCKUP_PRICE_GATED);
        _expectDepositRevert(streamId, abi.encodeWithSelector(RoseVault.NotLockupLinear.selector, streamId));
    }

    function test_depositStream_rejectsCancelable() public {
        uint256 streamId = _create(alice, true, true, NOW - 30 days, NOW + 30 days, NOW + 365 days);
        _expectDepositRevert(streamId, abi.encodeWithSelector(RoseVault.StreamCancelable.selector, streamId));
    }

    /// @dev Sablier reports a SETTLED stream as not cancelable, so a cancelable stream past its end passes the
    /// cancelable check; the vested withdrawal then depletes it and the deposit is refused without moving the NFT.
    function test_depositStream_settledCancelableStreamIsRefusedAsDepleted() public {
        uint256 streamId = _create(alice, true, true, NOW - 100 days, 0, NOW - 1 days);
        assertFalse(lockup.isCancelable(streamId));
        assertFalse(lockup.isDepleted(streamId));
        _expectDepositRevert(streamId, abi.encodeWithSelector(RoseVault.StreamDepleted.selector, streamId));
        assertEq(lockup.ownerOf(streamId), alice);
        assertEq(token.balanceOf(alice), 0);
        assertFalse(lockup.isDepleted(streamId));
    }

    function test_mockLockup_isCancelableFollowsSablierStatus() public {
        uint256 streamId = _create(alice, true, true, NOW - 30 days, 0, NOW + 30 days);
        assertTrue(lockup.isCancelable(streamId));
        vm.warp(NOW + 30 days);
        assertFalse(lockup.isCancelable(streamId));
        vm.prank(alice);
        lockup.withdrawMax{value: FEE}(streamId, alice);
        assertTrue(lockup.isDepleted(streamId));
        assertFalse(lockup.isCancelable(streamId));

        uint256 pending = _create(alice, true, true, NOW + 60 days, 0, NOW + 90 days);
        assertTrue(lockup.isCancelable(pending));
        lockupMock.markCanceled(pending);
        assertFalse(lockup.isCancelable(pending));
    }

    function test_depositStream_rejectsNonTransferable() public {
        uint256 streamId = _create(alice, false, false, NOW - 30 days, NOW + 30 days, NOW + 365 days);
        _expectDepositRevert(streamId, abi.encodeWithSelector(RoseVault.StreamNotTransferable.selector, streamId));
    }

    function test_depositStream_rejectsCanceled() public {
        uint256 streamId = _create(alice, true, true, NOW - 30 days, NOW + 30 days, NOW + 365 days);
        lockupMock.markCanceled(streamId);
        _expectDepositRevert(streamId, abi.encodeWithSelector(RoseVault.StreamCanceled.selector, streamId));
    }

    function test_depositStream_rejectsDepleted() public {
        uint256 streamId = _create(alice, false, true, NOW - 100 days, 0, NOW - 1 days);
        vm.prank(alice);
        lockup.withdrawMax{value: FEE}(streamId, alice);
        assertTrue(lockup.isDepleted(streamId));
        _expectDepositRevert(streamId, abi.encodeWithSelector(RoseVault.StreamDepleted.selector, streamId));
    }

    function test_depositStream_rejectsStreamDepletedByVestedWithdrawal() public {
        uint256 streamId = _create(alice, false, true, NOW - 100 days, 0, NOW - 1 days);
        assertFalse(lockup.isDepleted(streamId));
        _expectDepositRevert(streamId, abi.encodeWithSelector(RoseVault.StreamDepleted.selector, streamId));
        assertEq(lockup.ownerOf(streamId), alice);
        assertEq(token.balanceOf(alice), 0);
    }

    function test_depositStream_rejectsNonOwner() public {
        uint256 streamId = _lockedStream(alice);
        vm.prank(alice);
        lockup.setApprovalForAll(bob, true);
        vm.prank(alice);
        lockup.approve(address(vault), streamId);
        vm.expectRevert(abi.encodeWithSelector(RoseVault.NotStreamOwner.selector, streamId, alice));
        vm.prank(bob);
        vault.depositStream(lockup, streamId, "bob.testnet");
    }

    function test_depositStream_rejectsWithoutApproval() public {
        uint256 streamId = _lockedStream(alice);
        vm.expectRevert();
        vm.prank(alice);
        vault.depositStream(lockup, streamId, NEAR_ACCOUNT);
    }

    function test_depositStream_rejectsInvalidNearAccount() public {
        uint256 streamId = _lockedStream(alice);
        vm.startPrank(alice);
        lockup.approve(address(vault), streamId);
        vm.expectRevert(RoseVault.InvalidNearAccount.selector);
        vault.depositStream(lockup, streamId, "Alice.testnet");
        vm.stopPrank();
    }

    function _expectDepositRevert(uint256 streamId, bytes memory reason) internal {
        vm.startPrank(alice);
        lockup.approve(address(vault), streamId);
        vm.expectRevert(reason);
        vault.depositStream{value: FEE}(lockup, streamId, NEAR_ACCOUNT);
        vm.stopPrank();
    }

    /// @dev Pins the byte layout the NEAR engine rebuilds from (topics, data words, string tail).
    function test_depositStream_rawLogLayout() public {
        uint256 streamId = _lockedStream(alice);
        vm.startPrank(alice);
        lockup.approve(address(vault), streamId);
        vm.recordLogs();
        vault.depositStream(lockup, streamId, NEAR_ACCOUNT);
        vm.stopPrank();

        Vm.Log[] memory logs = vm.getRecordedLogs();
        Vm.Log memory log = logs[logs.length - 1];
        assertEq(log.emitter, address(vault));
        assertEq(log.topics.length, 3);
        assertEq(
            log.topics[0],
            keccak256(
                "StreamDeposited(address,string,address,uint256,address,uint8,uint128,uint128,uint40,uint40,uint40,uint40,uint128,uint128,bool,bool,uint40)"
            )
        );
        assertEq(log.topics[0], 0x588ce8ddd1a55c330cac56a02ed1423586edfcc762edb1db1b1f253dade6a599);
        assertEq(log.topics[1], bytes32(uint256(uint160(alice))));
        assertEq(log.topics[2], bytes32(streamId));

        bytes memory nearAccount = bytes(NEAR_ACCOUNT);
        assertEq(log.data.length, 16 * 32 + 32);
        assertEq(_word(log.data, 0), 15 * 32);
        assertEq(_word(log.data, 1), uint256(uint160(address(lockup))));
        assertEq(_word(log.data, 2), uint256(uint160(address(token))));
        assertEq(_word(log.data, 3), 18);
        assertEq(_word(log.data, 4), DEPOSIT);
        assertEq(_word(log.data, 5), 0);
        assertEq(_word(log.data, 6), NOW - 30 days);
        assertEq(_word(log.data, 7), NOW + 30 days);
        assertEq(_word(log.data, 8), NOW + 365 days);
        assertEq(_word(log.data, 9), 1);
        assertEq(_word(log.data, 10), 0);
        assertEq(_word(log.data, 11), DEPOSIT / 10);
        assertEq(_word(log.data, 12), 0);
        assertEq(_word(log.data, 13), 1);
        assertEq(_word(log.data, 14), NOW);
        assertEq(_word(log.data, 15), nearAccount.length);
        bytes32 expectedTail = "alice.rose-app.testnet";
        assertEq(_word(log.data, 16), uint256(expectedTail));
    }

    /// @dev Pins the static layout of the attestation the engine refreshes from.
    function test_attest_rawLogLayout() public {
        uint256 streamId = _lockedStream(alice);
        _deposit(alice, streamId);
        vm.warp(NOW + 60 days);
        uint128 withdrawable = lockup.withdrawableAmountOf(streamId);
        vm.recordLogs();
        vault.attest(streamId);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        Vm.Log memory log = logs[logs.length - 1];

        assertEq(log.emitter, address(vault));
        assertEq(log.topics.length, 2);
        assertEq(
            log.topics[0],
            keccak256(
                "StreamAttested(uint256,address,address,uint8,uint128,uint128,uint128,uint40,uint40,uint40,uint40,uint128,uint128,bool,bool,bool,uint40)"
            )
        );
        assertEq(log.topics[0], 0x72b596f8267d8e09b6a0efe69ebfaf52164aabafa9d62fb0bcb001c25394d626);
        assertEq(log.topics[1], bytes32(streamId));
        assertEq(log.data.length, 16 * 32);
        assertEq(_word(log.data, 0), uint256(uint160(address(lockup))));
        assertEq(_word(log.data, 1), uint256(uint160(address(token))));
        assertEq(_word(log.data, 2), 18);
        assertEq(_word(log.data, 3), DEPOSIT);
        assertEq(_word(log.data, 4), 0);
        assertEq(_word(log.data, 5), withdrawable);
        assertEq(_word(log.data, 6), NOW - 30 days);
        assertEq(_word(log.data, 7), NOW + 30 days);
        assertEq(_word(log.data, 8), NOW + 365 days);
        assertEq(_word(log.data, 9), 1);
        assertEq(_word(log.data, 10), 0);
        assertEq(_word(log.data, 11), DEPOSIT / 10);
        assertEq(_word(log.data, 12), 0);
        assertEq(_word(log.data, 13), 1);
        assertEq(_word(log.data, 14), 0);
        assertEq(_word(log.data, 15), NOW + 60 days);
    }

    function test_depositStream_rejectsDepositBelowOneToken() public {
        uint256 streamId = _createWithDeposit(alice, 5e17, NOW - 30 days, NOW + 30 days);
        _expectDepositRevert(streamId, abi.encodeWithSelector(RoseVault.AmountBelowMinimum.selector, 5e17, 1e18));
    }

    /// @dev Half of 1.5 tokens has vested: the deposit would leave 0.75 token locked, which the engine refuses.
    function test_depositStream_rejectsRemainderBelowOneToken() public {
        uint256 streamId = _createWithDeposit(alice, 15e17, NOW - 50 days, NOW + 50 days);
        assertEq(lockup.withdrawableAmountOf(streamId), 75e16);
        _expectDepositRevert(streamId, abi.encodeWithSelector(RoseVault.AmountBelowMinimum.selector, 75e16, 1e18));
        assertEq(lockup.ownerOf(streamId), alice);
        assertEq(token.balanceOf(alice), 0);
        assertEq(lockup.getWithdrawnAmount(streamId), 0);
    }

    function test_depositStream_rejectsTokenWithoutDecimals() public {
        RawDecimalsToken raw = new RawDecimalsToken();
        raw.setAnswer(abi.encode(uint256(1)), false);
        uint256 streamId = lockupMock.createWithTimestampsLL(
            Lockup.CreateWithTimestamps({
                sender: address(this),
                recipient: alice,
                depositAmount: DEPOSIT,
                token: IERC20(address(raw)),
                cancelable: false,
                transferable: true,
                timestamps: Lockup.Timestamps({start: NOW - 30 days, end: NOW + 365 days}),
                shape: ""
            }),
            LockupLinear.UnlockAmounts({start: 0, cliff: 0}),
            1,
            0
        );
        raw.setAnswer("", true);
        _expectDepositRevert(streamId, abi.encodeWithSelector(RoseVault.NoDecimals.selector, address(raw)));
    }

    function _createWithDeposit(address recipient, uint128 amount, uint40 start, uint40 end)
        internal
        returns (uint256)
    {
        return lockup.createWithTimestampsLL(
            Lockup.CreateWithTimestamps({
                sender: address(this),
                recipient: recipient,
                depositAmount: amount,
                token: IERC20(address(token)),
                cancelable: false,
                transferable: true,
                timestamps: Lockup.Timestamps({start: start, end: end}),
                shape: ""
            }),
            LockupLinear.UnlockAmounts({start: 0, cliff: 0}),
            1,
            0
        );
    }

    function _word(bytes memory data, uint256 index) internal pure returns (uint256 value) {
        assembly {
            value := mload(add(data, add(32, mul(index, 32))))
        }
    }

    /// @dev The vault's last log in `logs`; Sablier and the token log after it (`Approval` from the allowance reset).
    function _lastVaultLog(Vm.Log[] memory logs) internal view returns (Vm.Log memory) {
        for (uint256 i = logs.length; i > 0; --i) {
            if (logs[i - 1].emitter == address(vault)) {
                return logs[i - 1];
            }
        }
        revert("no vault log");
    }

    /*//////////////////////////////////////////////////////////////////////////
                                  NFT RECEIVER
    //////////////////////////////////////////////////////////////////////////*/

    function test_onERC721Received_rejectsDirectSafeTransfer() public {
        uint256 streamId = _lockedStream(alice);
        vm.expectRevert(RoseVault.UnexpectedNft.selector);
        vm.prank(alice);
        lockup.safeTransferFrom(alice, address(vault), streamId);
    }

    function test_onERC721Received_rejectsOtherCollections() public {
        MockLockup other = new MockLockup();
        token.approve(address(other), type(uint256).max);
        uint256 streamId = other.createWithTimestampsLL(
            Lockup.CreateWithTimestamps({
                sender: address(this),
                recipient: alice,
                depositAmount: DEPOSIT,
                token: IERC20(address(token)),
                cancelable: false,
                transferable: true,
                timestamps: Lockup.Timestamps({start: NOW, end: NOW + 1 days}),
                shape: ""
            }),
            LockupLinear.UnlockAmounts({start: 0, cliff: 0}),
            1,
            0
        );
        vm.expectRevert(RoseVault.UnexpectedNft.selector);
        vm.prank(alice);
        other.safeTransferFrom(alice, address(vault), streamId);
    }

    /*//////////////////////////////////////////////////////////////////////////
                                      RELEASE
    //////////////////////////////////////////////////////////////////////////*/

    function test_executeRelease_withdrawsVestedToVaultFirst() public {
        uint256 streamId = _lockedStream(alice);
        _deposit(alice, streamId);
        vm.warp(NOW + 60 days);
        uint128 vested = lockup.withdrawableAmountOf(streamId);
        assertGt(vested, 0);

        RoseVault.Release memory auth = RoseVault.Release(address(lockup), streamId, bob, false, 11);
        (uint8 v, bytes32 r, bytes32 s) = _signRelease(SIGNER_KEY, auth);
        uint256 ethBefore = alice.balance;

        vm.expectEmit(true, true, true, true, address(vault));
        emit RoseVault.ReleaseExecuted(11, streamId, bob, address(lockup), address(vault), vested, 0);
        vm.prank(alice);
        vault.executeRelease{value: 1 ether / 10}(auth, v, r, s);

        assertEq(lockup.ownerOf(streamId), bob);
        assertEq(token.balanceOf(address(vault)), vested);
        assertEq(token.balanceOf(bob), 0);
        assertEq(lockup.withdrawableAmountOf(streamId), 0);
        assertEq(alice.balance, ethBefore - FEE);
        assertEq(address(vault).balance, 0);
        assertTrue(vault.isAuthorizationUsed(11));
    }

    function test_executeRelease_vestedToRecipient_sendsVestedToTheReturnee() public {
        uint256 streamId = _lockedStream(alice);
        _deposit(alice, streamId);
        vm.warp(NOW + 60 days);
        uint128 vested = lockup.withdrawableAmountOf(streamId);
        assertGt(vested, 0);
        uint256 vaultBefore = token.balanceOf(address(vault));

        RoseVault.Release memory auth = RoseVault.Release(address(lockup), streamId, bob, true, 25);
        (uint8 v, bytes32 r, bytes32 s) = _signRelease(SIGNER_KEY, auth);

        vm.expectEmit(true, true, true, true, address(vault));
        emit RoseVault.ReleaseExecuted(25, streamId, bob, address(lockup), bob, vested, 0);
        vm.prank(alice);
        vault.executeRelease{value: FEE}(auth, v, r, s);

        assertEq(lockup.ownerOf(streamId), bob);
        assertEq(token.balanceOf(bob), vested);
        assertEq(token.balanceOf(address(vault)), vaultBefore);
        assertEq(lockup.withdrawableAmountOf(streamId), 0);
    }

    function test_executeRelease_vestedFlagIsSigned() public {
        uint256 streamId = _lockedStream(alice);
        _deposit(alice, streamId);
        vm.warp(NOW + 60 days);
        RoseVault.Release memory auth = RoseVault.Release(address(lockup), streamId, bob, false, 26);
        (uint8 v, bytes32 r, bytes32 s) = _signRelease(SIGNER_KEY, auth);
        auth.vestedToRecipient = true;
        address recovered = ecrecover(vault.hashRelease(auth), v, r, s);
        vm.expectRevert(abi.encodeWithSelector(RoseVault.InvalidSigner.selector, recovered));
        vault.executeRelease{value: FEE}(auth, v, r, s);
        assertFalse(vault.isAuthorizationUsed(26));
    }

    function test_executeRelease_zeroWithdrawable_needsNoFee() public {
        uint256 streamId = _lockedStream(alice);
        _deposit(alice, streamId);
        RoseVault.Release memory auth = RoseVault.Release(address(lockup), streamId, bob, false, 12);
        (uint8 v, bytes32 r, bytes32 s) = _signRelease(SIGNER_KEY, auth);

        vm.expectEmit(true, true, true, true, address(vault));
        emit RoseVault.ReleaseExecuted(12, streamId, bob, address(lockup), address(vault), 0, 0);
        vault.executeRelease(auth, v, r, s);
        assertEq(lockup.ownerOf(streamId), bob);
    }

    function test_executeRelease_refundsExcessValue() public {
        uint256 streamId = _lockedStream(alice);
        _deposit(alice, streamId);
        vm.warp(NOW + 60 days);
        RoseVault.Release memory auth = RoseVault.Release(address(lockup), streamId, bob, false, 18);
        (uint8 v, bytes32 r, bytes32 s) = _signRelease(SIGNER_KEY, auth);
        uint256 ethBefore = alice.balance;

        vm.prank(alice);
        vault.executeRelease{value: FEE + 0.5 ether}(auth, v, r, s);

        assertEq(alice.balance, ethBefore - FEE);
        assertEq(address(lockup).balance, FEE);
        assertEq(address(vault).balance, 0);
        assertEq(lockup.ownerOf(streamId), bob);
    }

    function test_executeRelease_zeroWithdrawable_refundsWholeValue() public {
        uint256 streamId = _lockedStream(alice);
        _deposit(alice, streamId);
        RoseVault.Release memory auth = RoseVault.Release(address(lockup), streamId, bob, false, 19);
        (uint8 v, bytes32 r, bytes32 s) = _signRelease(SIGNER_KEY, auth);
        uint256 ethBefore = alice.balance;

        vm.prank(alice);
        vault.executeRelease{value: 0.5 ether}(auth, v, r, s);

        assertEq(alice.balance, ethBefore);
        assertEq(address(lockup).balance, 0);
        assertEq(address(vault).balance, 0);
    }

    function test_executeRelease_revertsWhenRefundIsRejected() public {
        uint256 streamId = _lockedStream(alice);
        _deposit(alice, streamId);
        vm.warp(NOW + 60 days);
        RoseVault.Release memory auth = RoseVault.Release(address(lockup), streamId, bob, false, 20);
        (uint8 v, bytes32 r, bytes32 s) = _signRelease(SIGNER_KEY, auth);
        RejectingSubmitter submitter = new RejectingSubmitter();
        uint256 ethBefore = address(this).balance;

        vm.expectRevert(RoseVault.RefundFailed.selector);
        submitter.submitRelease{value: FEE + 1}(vault, auth, v, r, s);

        assertEq(lockup.ownerOf(streamId), address(vault));
        assertFalse(vault.isAuthorizationUsed(20));
        assertEq(address(this).balance, ethBefore);
        assertEq(address(lockup).balance, 0);
    }

    function test_executeRelease_exactFeeNeedsNoRefund() public {
        uint256 streamId = _lockedStream(alice);
        _deposit(alice, streamId);
        vm.warp(NOW + 60 days);
        RoseVault.Release memory auth = RoseVault.Release(address(lockup), streamId, bob, false, 21);
        (uint8 v, bytes32 r, bytes32 s) = _signRelease(SIGNER_KEY, auth);
        RejectingSubmitter submitter = new RejectingSubmitter();
        uint256 ethBefore = address(this).balance;

        submitter.submitRelease{value: FEE}(vault, auth, v, r, s);

        assertEq(lockup.ownerOf(streamId), bob);
        assertEq(address(this).balance, ethBefore - FEE);
        assertEq(address(lockup).balance, FEE);
        assertEq(address(vault).balance, 0);
    }

    function test_executeRelease_rejectsInsufficientFee() public {
        uint256 streamId = _lockedStream(alice);
        _deposit(alice, streamId);
        vm.warp(NOW + 60 days);
        RoseVault.Release memory auth = RoseVault.Release(address(lockup), streamId, bob, false, 13);
        (uint8 v, bytes32 r, bytes32 s) = _signRelease(SIGNER_KEY, auth);
        vm.expectRevert(abi.encodeWithSelector(RoseVault.InsufficientFee.selector, 0, FEE));
        vault.executeRelease(auth, v, r, s);
        assertFalse(vault.isAuthorizationUsed(13));
    }

    function test_executeRelease_rejectsWrongLockup() public {
        RoseVault.Release memory auth = RoseVault.Release(address(token), 1, bob, false, 14);
        (uint8 v, bytes32 r, bytes32 s) = _signRelease(SIGNER_KEY, auth);
        vm.expectRevert(abi.encodeWithSelector(RoseVault.WrongLockup.selector, address(token)));
        vault.executeRelease(auth, v, r, s);
    }

    function test_executeRelease_rejectsZeroRecipient() public {
        RoseVault.Release memory auth = RoseVault.Release(address(lockup), 1, address(0), false, 15);
        (uint8 v, bytes32 r, bytes32 s) = _signRelease(SIGNER_KEY, auth);
        vm.expectRevert(RoseVault.ZeroAddress.selector);
        vault.executeRelease(auth, v, r, s);
    }

    function test_executeRelease_rejectsReplay() public {
        uint256 streamId = _lockedStream(alice);
        _deposit(alice, streamId);
        RoseVault.Release memory auth = RoseVault.Release(address(lockup), streamId, bob, false, 16);
        (uint8 v, bytes32 r, bytes32 s) = _signRelease(SIGNER_KEY, auth);
        vault.executeRelease(auth, v, r, s);
        vm.expectRevert(abi.encodeWithSelector(RoseVault.AuthorizationUsed.selector, 16));
        vault.executeRelease(auth, v, r, s);
    }

    function test_executeRelease_streamNotHeldKeepsIdUnused() public {
        uint256 streamId = _lockedStream(alice);
        RoseVault.Release memory auth = RoseVault.Release(address(lockup), streamId, bob, false, 17);
        (uint8 v, bytes32 r, bytes32 s) = _signRelease(SIGNER_KEY, auth);
        vm.expectRevert();
        vault.executeRelease(auth, v, r, s);
        assertFalse(vault.isAuthorizationUsed(17));
    }

    /*//////////////////////////////////////////////////////////////////////////
                          THIRD-PARTY WITHDRAWALS TO THE VAULT
    //////////////////////////////////////////////////////////////////////////*/

    /// @dev Deposits a vesting stream (its entry withdrawal pays alice), lets bob push 30 days of vesting into the
    /// vault with `withdrawMax(streamId, vault)`, then lets 30 more days vest. The vault also holds unrelated tokens
    /// of the same kind, which no release may touch.
    function _depositAndPush() internal returns (uint256 streamId, uint128 pushed, uint128 vestedSince) {
        streamId = _vestingStream(alice);
        _deposit(alice, streamId);
        uint128 atEntry = lockup.getWithdrawnAmount(streamId);
        assertGt(atEntry, 0);
        _assertEntry(streamId, true, atEntry);
        token.mint(address(vault), 500e18);

        vm.warp(NOW + 30 days);
        vm.prank(bob);
        pushed = lockup.withdrawMax{value: FEE}(streamId, address(vault));
        assertGt(pushed, 0);
        vm.warp(NOW + 60 days);
        vestedSince = lockup.withdrawableAmountOf(streamId);
        assertGt(vestedSince, 0);
    }

    function test_executeRelease_vestedToRecipient_forwardsThirdPartyWithdrawals() public {
        (uint256 streamId, uint128 pushed, uint128 vestedSince) = _depositAndPush();
        address returnee = makeAddr("returnee");
        RoseVault.Release memory auth = RoseVault.Release(address(lockup), streamId, returnee, true, 27);
        (uint8 v, bytes32 r, bytes32 s) = _signRelease(SIGNER_KEY, auth);

        vm.expectEmit(true, true, true, true, address(vault));
        emit RoseVault.ReleaseExecuted(27, streamId, returnee, address(lockup), returnee, vestedSince, pushed);
        vm.prank(alice);
        vault.executeRelease{value: FEE}(auth, v, r, s);

        assertEq(lockup.ownerOf(streamId), returnee);
        assertEq(token.balanceOf(returnee), pushed + vestedSince);
        assertEq(token.balanceOf(address(vault)), 500e18);
        assertEq(lockup.withdrawableAmountOf(streamId), 0);
        _assertEntry(streamId, false, 0);
    }

    function test_executeRelease_registeredPosition_forwardsNothingAfterThirdPartyWithdrawal() public {
        (uint256 streamId, uint128 pushed, uint128 vestedSince) = _depositAndPush();
        RoseVault.Release memory auth = RoseVault.Release(address(lockup), streamId, bob, false, 28);
        (uint8 v, bytes32 r, bytes32 s) = _signRelease(SIGNER_KEY, auth);

        vm.expectEmit(true, true, true, true, address(vault));
        emit RoseVault.ReleaseExecuted(28, streamId, bob, address(lockup), address(vault), vestedSince, 0);
        vm.prank(alice);
        vault.executeRelease{value: FEE}(auth, v, r, s);

        assertEq(lockup.ownerOf(streamId), bob);
        assertEq(token.balanceOf(bob), 0);
        assertEq(token.balanceOf(address(vault)), 500e18 + pushed + vestedSince);
        _assertEntry(streamId, false, 0);
    }

    /// @dev A third party drains a refused stream after its end: nothing is left to withdraw, so the return pays no
    /// fee and forwards everything that vested since the entry.
    function test_executeRelease_vestedToRecipient_afterThirdPartyDepletedTheStream() public {
        uint256 streamId = _vestingStream(alice);
        _deposit(alice, streamId);
        uint128 atEntry = lockup.getWithdrawnAmount(streamId);
        vm.warp(NOW + 266 days);
        vm.prank(bob);
        lockup.withdrawMax{value: FEE}(streamId, address(vault));
        assertTrue(lockup.isDepleted(streamId));
        RoseVault.Release memory auth = RoseVault.Release(address(lockup), streamId, bob, true, 29);
        (uint8 v, bytes32 r, bytes32 s) = _signRelease(SIGNER_KEY, auth);

        vm.expectEmit(true, true, true, true, address(vault));
        emit RoseVault.ReleaseExecuted(29, streamId, bob, address(lockup), bob, 0, DEPOSIT - atEntry);
        vault.executeRelease(auth, v, r, s);

        assertEq(lockup.ownerOf(streamId), bob);
        assertEq(token.balanceOf(bob), DEPOSIT - atEntry);
        assertEq(token.balanceOf(address(vault)), 0);
    }

    /// @dev A stream sent with a plain `transferFrom` has no entry record, so even a return forwards nothing from
    /// the vault's balance: the engine never registers such a stream and cannot know what belongs to it.
    function test_executeRelease_unrecordedStreamForwardsNothing() public {
        uint256 streamId = _lockedStream(alice);
        vm.prank(alice);
        lockup.transferFrom(alice, address(vault), streamId);
        _assertEntry(streamId, false, 0);
        vm.warp(NOW + 60 days);
        vm.prank(bob);
        uint128 pushed = lockup.withdrawMax{value: FEE}(streamId, address(vault));
        vm.warp(NOW + 90 days);
        uint128 vestedSince = lockup.withdrawableAmountOf(streamId);
        RoseVault.Release memory auth = RoseVault.Release(address(lockup), streamId, alice, true, 30);
        (uint8 v, bytes32 r, bytes32 s) = _signRelease(SIGNER_KEY, auth);

        vm.expectEmit(true, true, true, true, address(vault));
        emit RoseVault.ReleaseExecuted(30, streamId, alice, address(lockup), alice, vestedSince, 0);
        vm.prank(alice);
        vault.executeRelease{value: FEE}(auth, v, r, s);

        assertEq(token.balanceOf(alice), vestedSince);
        assertEq(token.balanceOf(address(vault)), pushed);
    }

    /// @dev A stream that left and came back is measured from its latest entry: what was pushed during the first
    /// stay stays with unit holders.
    function test_executeRelease_redepositedStreamForwardsOnlySinceItsLatestEntry() public {
        uint256 streamId = _vestingStream(alice);
        _deposit(alice, streamId);
        vm.warp(NOW + 30 days);
        vm.prank(bob);
        uint128 firstPush = lockup.withdrawMax{value: FEE}(streamId, address(vault));
        RoseVault.Release memory auth = RoseVault.Release(address(lockup), streamId, alice, false, 31);
        (uint8 v, bytes32 r, bytes32 s) = _signRelease(SIGNER_KEY, auth);
        vault.executeRelease(auth, v, r, s);
        _assertEntry(streamId, false, 0);

        vm.warp(NOW + 40 days);
        _deposit(alice, streamId);
        _assertEntry(streamId, true, lockup.getWithdrawnAmount(streamId));
        vm.warp(NOW + 50 days);
        vm.prank(bob);
        uint128 secondPush = lockup.withdrawMax{value: FEE}(streamId, address(vault));
        uint256 aliceBefore = token.balanceOf(alice);
        auth = RoseVault.Release(address(lockup), streamId, alice, true, 32);
        (v, r, s) = _signRelease(SIGNER_KEY, auth);

        vm.expectEmit(true, true, true, true, address(vault));
        emit RoseVault.ReleaseExecuted(32, streamId, alice, address(lockup), alice, 0, secondPush);
        vault.executeRelease(auth, v, r, s);

        assertEq(token.balanceOf(alice), aliceBefore + secondPush);
        assertEq(token.balanceOf(address(vault)), firstPush);
        assertEq(lockup.ownerOf(streamId), alice);
    }

    /// @dev If the pushed tokens were already paid out, the return cannot forward them and reverts as a whole: the
    /// NFT stays in the vault and the authorization id stays unused.
    function test_executeRelease_vestedToRecipient_revertsWhenPushedTokensAreGone() public {
        (uint256 streamId, uint128 pushed,) = _depositAndPush();
        RoseVault.Transfer memory payout = RoseVault.Transfer(address(token), bob, 500e18 + pushed, 33);
        (uint8 v, bytes32 r, bytes32 s) = _signTransfer(SIGNER_KEY, payout);
        vault.executeTransfer(payout, v, r, s);
        RoseVault.Release memory auth = RoseVault.Release(address(lockup), streamId, alice, true, 34);
        (v, r, s) = _signRelease(SIGNER_KEY, auth);

        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, address(vault), 0, pushed)
        );
        vm.prank(alice);
        vault.executeRelease{value: FEE}(auth, v, r, s);

        assertEq(lockup.ownerOf(streamId), address(vault));
        assertFalse(vault.isAuthorizationUsed(34));
    }

    /*//////////////////////////////////////////////////////////////////////////
                                  COHORT CREATION
    //////////////////////////////////////////////////////////////////////////*/

    /// @dev Same timestamps and unlock ratio as `_lockedStream`: a `DEPOSIT` allocation unlocks `DEPOSIT / 10` at the
    /// cliff, so its log is byte-identical to a `depositStream` of a locked stream.
    function _cohort() internal pure returns (RoseVault.CohortSchedule memory) {
        return RoseVault.CohortSchedule({
            start: NOW - 30 days,
            cliff: NOW + 30 days,
            end: NOW + 365 days,
            granularity: 1,
            unitAmount: 10,
            unitStartUnlock: 0,
            unitCliffUnlock: 1
        });
    }

    function _allocations(uint256 count, uint128 amount) internal pure returns (RoseVault.Allocation[] memory list) {
        list = new RoseVault.Allocation[](count);
        for (uint256 i; i < count; ++i) {
            list[i] = RoseVault.Allocation({
                nearAccount: string.concat("holder", vm.toString(i), ".rose-app.testnet"), amount: amount
            });
        }
    }

    function _fundIssuer(uint256 amount) internal {
        token.mint(alice, amount);
        vm.prank(alice);
        token.approve(address(vault), amount);
    }

    function test_createStreams_createsVaultHeldStreamsAndEmits() public {
        RoseVault.Allocation[] memory list = _allocations(3, DEPOSIT);
        list[1].amount = 2 * DEPOSIT;
        list[2].amount = 3 * DEPOSIT;
        _fundIssuer(6 * DEPOSIT);
        uint256 firstId = lockupMock.nextStreamId();
        uint256 lockupBefore = token.balanceOf(address(lockup));

        for (uint256 i; i < 3; ++i) {
            vm.expectEmit(true, true, true, true, address(vault));
            emit RoseVault.StreamDeposited({
                sender: alice,
                nearAccount: list[i].nearAccount,
                lockup: address(lockup),
                streamId: firstId + i,
                token: address(token),
                decimals: 18,
                deposited: list[i].amount,
                withdrawn: 0,
                start: NOW - 30 days,
                cliff: NOW + 30 days,
                end: NOW + 365 days,
                granularity: 1,
                startUnlock: 0,
                cliffUnlock: list[i].amount / 10,
                cancelable: false,
                transferable: true,
                timestamp: NOW
            });
        }
        vm.prank(alice);
        uint256[] memory ids = vault.createStreams(IERC20(address(token)), _cohort(), list);

        assertEq(ids.length, 3);
        for (uint256 i; i < 3; ++i) {
            assertEq(ids[i], firstId + i);
            assertEq(lockup.ownerOf(ids[i]), address(vault));
            assertFalse(lockup.isCancelable(ids[i]));
            assertTrue(lockup.isTransferable(ids[i]));
            assertEq(uint8(lockup.getLockupModel(ids[i])), uint8(Lockup.Model.LOCKUP_LINEAR));
            assertEq(lockup.getDepositedAmount(ids[i]), list[i].amount);
            assertEq(lockup.getWithdrawnAmount(ids[i]), 0);
            assertEq(lockup.getUnlockAmounts(ids[i]).cliff, list[i].amount / 10);
            _assertEntry(ids[i], true, 0);
        }
        assertEq(token.balanceOf(alice), 0);
        assertEq(token.balanceOf(address(vault)), 0);
        assertEq(token.balanceOf(address(lockup)), lockupBefore + 6 * DEPOSIT);
        assertEq(token.allowance(address(vault), address(lockup)), 0);
    }

    function test_createStreams_withoutCliff() public {
        RoseVault.CohortSchedule memory schedule = RoseVault.CohortSchedule({
            start: NOW,
            cliff: 0,
            end: NOW + 100 days,
            granularity: 1 days,
            unitAmount: 1,
            unitStartUnlock: 0,
            unitCliffUnlock: 0
        });
        _fundIssuer(7e18);
        vm.prank(alice);
        uint256[] memory ids = vault.createStreams(IERC20(address(token)), schedule, _allocations(1, 7e18));
        assertEq(lockup.ownerOf(ids[0]), address(vault));
        assertEq(lockup.getCliffTime(ids[0]), 0);
        assertEq(lockup.getGranularity(ids[0]), 1 days);
    }

    /// @dev The engine rebuilds both logs with the same code: a cohort stream and a deposited stream with the same
    /// schedule, deposit and sender produce byte-identical topics (but the stream id) and data.
    function test_createStreams_rawLogIsIdenticalToDepositStream() public {
        RoseVault.Allocation[] memory list = new RoseVault.Allocation[](1);
        list[0] = RoseVault.Allocation({nearAccount: NEAR_ACCOUNT, amount: DEPOSIT});
        _fundIssuer(DEPOSIT);
        vm.recordLogs();
        vm.prank(alice);
        uint256[] memory ids = vault.createStreams(IERC20(address(token)), _cohort(), list);
        Vm.Log memory cohortLog = _lastVaultLog(vm.getRecordedLogs());

        uint256 streamId = _lockedStream(alice);
        vm.recordLogs();
        _deposit(alice, streamId);
        Vm.Log[] memory deposited = vm.getRecordedLogs();
        Vm.Log memory depositLog = deposited[deposited.length - 1];

        assertEq(cohortLog.emitter, address(vault));
        assertEq(depositLog.emitter, address(vault));
        assertEq(cohortLog.topics.length, 3);
        assertEq(cohortLog.topics[0], depositLog.topics[0]);
        assertEq(cohortLog.topics[1], depositLog.topics[1]);
        assertEq(cohortLog.topics[2], bytes32(ids[0]));
        assertEq(depositLog.topics[2], bytes32(streamId));
        assertEq(cohortLog.data, depositLog.data);
        assertEq(_word(cohortLog.data, 3), 18);
        assertEq(_word(cohortLog.data, 5), 0);
    }

    function test_createStreams_rejectsEmptyList() public {
        vm.expectRevert(RoseVault.NoAllocations.selector);
        vm.prank(alice);
        vault.createStreams(IERC20(address(token)), _cohort(), new RoseVault.Allocation[](0));
    }

    function test_createStreams_rejectsTooManyAllocations() public {
        uint256 count = vault.MAX_ALLOCATIONS() + 1;
        vm.expectRevert(abi.encodeWithSelector(RoseVault.TooManyAllocations.selector, count));
        vm.prank(alice);
        vault.createStreams(IERC20(address(token)), _cohort(), _allocations(count, DEPOSIT));
    }

    function test_createStreams_acceptsMaxAllocations() public {
        uint256 count = vault.MAX_ALLOCATIONS();
        _fundIssuer(count * 10e18);
        vm.prank(alice);
        uint256[] memory ids = vault.createStreams(IERC20(address(token)), _cohort(), _allocations(count, 10e18));
        assertEq(ids.length, count);
        assertEq(lockup.ownerOf(ids[count - 1]), address(vault));
    }

    function test_createStreams_rejectsZeroAmount() public {
        RoseVault.Allocation[] memory list = _allocations(2, DEPOSIT);
        list[1].amount = 0;
        vm.expectRevert(abi.encodeWithSelector(RoseVault.AmountBelowMinimum.selector, 0, 1e18));
        vm.prank(alice);
        vault.createStreams(IERC20(address(token)), _cohort(), list);
    }

    function test_createStreams_rejectsAmountBelowOneToken() public {
        RoseVault.Allocation[] memory list = _allocations(2, DEPOSIT);
        list[1].amount = 1e18 - 10;
        vm.expectRevert(abi.encodeWithSelector(RoseVault.AmountBelowMinimum.selector, 1e18 - 10, 1e18));
        vm.prank(alice);
        vault.createStreams(IERC20(address(token)), _cohort(), list);
    }

    function test_createStreams_rejectsAmountNotMultipleOfUnit() public {
        RoseVault.Allocation[] memory list = _allocations(2, DEPOSIT);
        list[1].amount = 1e18 + 5;
        vm.expectRevert(abi.encodeWithSelector(RoseVault.AmountNotMultiple.selector, 1, 1e18 + 5, 10));
        vm.prank(alice);
        vault.createStreams(IERC20(address(token)), _cohort(), list);
    }

    function test_createStreams_rejectsLockupAsToken() public {
        vm.expectRevert(abi.encodeWithSelector(RoseVault.InvalidToken.selector, address(lockup)));
        vm.prank(alice);
        vault.createStreams(IERC20(address(lockup)), _cohort(), _allocations(1, DEPOSIT));
    }

    function test_createStreams_rejectsUnlockSumOverflow() public {
        RoseVault.CohortSchedule memory s = _cohort();
        s.unitStartUnlock = type(uint128).max;
        s.unitCliffUnlock = 1;
        _expectInvalidSchedule(s);
    }

    function test_createStreams_rejectsTokenWithoutDecimals() public {
        RawDecimalsToken raw = new RawDecimalsToken();
        bytes memory expected = abi.encodeWithSelector(RoseVault.NoDecimals.selector, address(raw));
        raw.setAnswer("", true);
        _expectCreateRevert(raw, expected);
        raw.setAnswer("", false);
        _expectCreateRevert(raw, expected);
        raw.setAnswer(abi.encode(uint256(18), uint256(0)), false);
        _expectCreateRevert(raw, expected);
        raw.setAnswer(abi.encode(uint256(256)), false);
        _expectCreateRevert(raw, expected);
        raw.setAnswer(abi.encode(uint256(39)), false);
        _expectCreateRevert(raw, abi.encodeWithSelector(RoseVault.UnsupportedDecimals.selector, 39));
        raw.setAnswer(abi.encode(uint256(38)), false);
        _expectCreateRevert(raw, abi.encodeWithSelector(RoseVault.AmountBelowMinimum.selector, DEPOSIT, 1e38));
    }

    function _expectCreateRevert(RawDecimalsToken raw, bytes memory reason) internal {
        vm.expectRevert(reason);
        vm.prank(alice);
        vault.createStreams(IERC20(address(raw)), _cohort(), _allocations(1, DEPOSIT));
    }

    /// @dev A token that burns 1% per transfer, with the vault already holding some of it: the shortfall of the pull
    /// would otherwise be covered by that prior balance when Sablier pulls the full deposits.
    function test_createStreams_rejectsFeeOnTransferToken() public {
        FeeOnTransferToken feeToken = new FeeOnTransferToken();
        feeToken.mint(address(vault), 100e18);
        feeToken.mint(alice, 100e18);
        vm.startPrank(alice);
        feeToken.approve(address(vault), 100e18);
        vm.expectRevert(abi.encodeWithSelector(RoseVault.AmountMismatch.selector, 100e18, 99e18));
        vault.createStreams(IERC20(address(feeToken)), _cohort(), _allocations(1, 100e18));
        vm.stopPrank();
        assertEq(feeToken.balanceOf(address(vault)), 100e18);
    }

    /// @dev Started schedule with a start unlock: each stream's vested balance goes to the issuer at creation, one
    /// Sablier fee per stream is forwarded and the excess value is refunded.
    function test_createStreams_startedScheduleWithdrawsVestedToIssuer() public {
        RoseVault.CohortSchedule memory schedule = RoseVault.CohortSchedule({
            start: NOW - 10 days,
            cliff: 0,
            end: NOW + 355 days,
            granularity: 1,
            unitAmount: 10,
            unitStartUnlock: 1,
            unitCliffUnlock: 0
        });
        RoseVault.Allocation[] memory list = _allocations(2, DEPOSIT);
        list[1].amount = 2 * DEPOSIT;
        _fundIssuer(3 * DEPOSIT);
        uint256 ethBefore = alice.balance;

        vm.recordLogs();
        vm.prank(alice);
        uint256[] memory ids = vault.createStreams{value: 3 * FEE}(IERC20(address(token)), schedule, list);

        uint256 totalVested;
        for (uint256 i; i < 2; ++i) {
            uint128 startUnlock = list[i].amount / 10;
            uint128 linear = uint128(uint256(list[i].amount - startUnlock) * 10 days / 365 days);
            uint128 vested = startUnlock + linear;
            assertGt(linear, 0);
            assertEq(lockup.getWithdrawnAmount(ids[i]), vested);
            assertEq(lockup.withdrawableAmountOf(ids[i]), 0);
            assertEq(lockup.ownerOf(ids[i]), address(vault));
            _assertEntry(ids[i], true, vested);
            totalVested += vested;
        }
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 found;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(vault)) {
                continue;
            }
            assertEq(logs[i].topics[2], bytes32(ids[found]));
            assertEq(_word(logs[i].data, 5), lockup.getWithdrawnAmount(ids[found]));
            ++found;
        }
        assertEq(found, 2);
        assertEq(token.balanceOf(alice), totalVested);
        assertEq(token.balanceOf(address(vault)), 0);
        assertEq(alice.balance, ethBefore - 2 * FEE);
        assertEq(address(lockup).balance, 2 * FEE);
        assertEq(address(vault).balance, 0);
    }

    /// @dev A cohort stream whose creation withdrew its vested balance to the issuer, then pushed into the vault by a
    /// third party: its return forwards exactly the push, measured from the withdrawn amount recorded at creation.
    function test_createStreams_returnForwardsThirdPartyWithdrawalsSinceCreation() public {
        RoseVault.CohortSchedule memory schedule = RoseVault.CohortSchedule({
            start: NOW - 10 days,
            cliff: 0,
            end: NOW + 355 days,
            granularity: 1,
            unitAmount: 10,
            unitStartUnlock: 1,
            unitCliffUnlock: 0
        });
        _fundIssuer(DEPOSIT);
        vm.prank(alice);
        uint256 streamId =
            vault.createStreams{value: FEE}(IERC20(address(token)), schedule, _allocations(1, DEPOSIT))[0];
        uint128 atEntry = lockup.getWithdrawnAmount(streamId);
        assertGt(atEntry, DEPOSIT / 10);
        _assertEntry(streamId, true, atEntry);

        vm.warp(NOW + 30 days);
        vm.prank(bob);
        uint128 pushed = lockup.withdrawMax{value: FEE}(streamId, address(vault));
        vm.warp(NOW + 60 days);
        uint128 vestedSince = lockup.withdrawableAmountOf(streamId);
        assertGt(pushed, 0);
        assertGt(vestedSince, 0);
        RoseVault.Release memory auth = RoseVault.Release(address(lockup), streamId, bob, true, 35);
        (uint8 v, bytes32 r, bytes32 s) = _signRelease(SIGNER_KEY, auth);

        vm.expectEmit(true, true, true, true, address(vault));
        emit RoseVault.ReleaseExecuted(35, streamId, bob, address(lockup), bob, vestedSince, pushed);
        vm.prank(alice);
        vault.executeRelease{value: FEE}(auth, v, r, s);

        assertEq(lockup.ownerOf(streamId), bob);
        assertEq(token.balanceOf(bob), pushed + vestedSince);
        assertEq(token.balanceOf(alice), atEntry);
        assertEq(token.balanceOf(address(vault)), 0);
        _assertEntry(streamId, false, 0);
    }

    function test_createStreams_passedCliffWithdrawsCliffUnlockToIssuer() public {
        RoseVault.CohortSchedule memory schedule = RoseVault.CohortSchedule({
            start: NOW - 100 days,
            cliff: NOW - 10 days,
            end: NOW + 265 days,
            granularity: 1,
            unitAmount: 10,
            unitStartUnlock: 0,
            unitCliffUnlock: 1
        });
        _fundIssuer(DEPOSIT);
        vm.prank(alice);
        uint256[] memory ids =
            vault.createStreams{value: FEE}(IERC20(address(token)), schedule, _allocations(1, DEPOSIT));
        uint128 withdrawn = lockup.getWithdrawnAmount(ids[0]);
        assertGt(withdrawn, DEPOSIT / 10);
        assertEq(token.balanceOf(alice), withdrawn);
        assertEq(lockup.withdrawableAmountOf(ids[0]), 0);
        assertEq(address(lockup).balance, FEE);
    }

    /// @dev Unit unlocks equal to the unit amount with a past start: the stream would be withdrawn in full at birth.
    function test_createStreams_rejectsStreamDepletedAtCreation() public {
        RoseVault.CohortSchedule memory schedule = RoseVault.CohortSchedule({
            start: NOW - 1,
            cliff: 0,
            end: NOW + 100 days,
            granularity: 1,
            unitAmount: 10,
            unitStartUnlock: 10,
            unitCliffUnlock: 0
        });
        _fundIssuer(DEPOSIT);
        uint256 streamId = lockupMock.nextStreamId();
        vm.expectRevert(abi.encodeWithSelector(RoseVault.StreamDepleted.selector, streamId));
        vm.prank(alice);
        vault.createStreams{value: FEE}(IERC20(address(token)), schedule, _allocations(1, DEPOSIT));
    }

    function test_createStreams_rejectsRemainderBelowOneToken() public {
        RoseVault.CohortSchedule memory schedule = RoseVault.CohortSchedule({
            start: NOW,
            cliff: 0,
            end: NOW + 100 days,
            granularity: 1,
            unitAmount: 2e18,
            unitStartUnlock: 15e17,
            unitCliffUnlock: 0
        });
        _fundIssuer(2e18);
        vm.expectRevert(abi.encodeWithSelector(RoseVault.AmountBelowMinimum.selector, 5e17, 1e18));
        vm.prank(alice);
        vault.createStreams{value: FEE}(IERC20(address(token)), schedule, _allocations(1, 2e18));
    }

    function test_createStreams_rejectsInsufficientFeeForSecondStream() public {
        RoseVault.CohortSchedule memory schedule = RoseVault.CohortSchedule({
            start: NOW - 10 days,
            cliff: 0,
            end: NOW + 355 days,
            granularity: 1,
            unitAmount: 10,
            unitStartUnlock: 1,
            unitCliffUnlock: 0
        });
        _fundIssuer(2 * DEPOSIT);
        vm.expectRevert(abi.encodeWithSelector(RoseVault.InsufficientFee.selector, 0, FEE));
        vm.prank(alice);
        vault.createStreams{value: FEE}(IERC20(address(token)), schedule, _allocations(2, DEPOSIT));
    }

    function test_createStreams_notStarted_refundsWholeValue() public {
        _fundIssuer(DEPOSIT);
        uint256 ethBefore = alice.balance;
        vm.prank(alice);
        vault.createStreams{value: 0.5 ether}(IERC20(address(token)), _cohort(), _allocations(1, DEPOSIT));
        assertEq(alice.balance, ethBefore);
        assertEq(address(vault).balance, 0);
    }

    function test_createStreams_rejectsInvalidNearAccount() public {
        RoseVault.Allocation[] memory list = _allocations(2, DEPOSIT);
        list[1].nearAccount = "Holder.testnet";
        vm.expectRevert(RoseVault.InvalidNearAccount.selector);
        vm.prank(alice);
        vault.createStreams(IERC20(address(token)), _cohort(), list);
    }

    function test_createStreams_rejectsInvalidSchedules() public {
        RoseVault.CohortSchedule memory s = _cohort();
        s.start = 0;
        _expectInvalidSchedule(s);
        s = _cohort();
        s.end = s.start;
        _expectInvalidSchedule(s);
        s = _cohort();
        s.start = NOW - 100 days;
        s.cliff = 0;
        s.end = NOW;
        _expectInvalidSchedule(s);
        s = _cohort();
        s.cliff = s.start;
        _expectInvalidSchedule(s);
        s = _cohort();
        s.cliff = s.end;
        _expectInvalidSchedule(s);
        s = _cohort();
        s.granularity = 0;
        _expectInvalidSchedule(s);
        s = _cohort();
        s.granularity = 335 days + 1;
        _expectInvalidSchedule(s);
        s = _cohort();
        s.unitAmount = 0;
        _expectInvalidSchedule(s);
        s = _cohort();
        s.unitStartUnlock = 10;
        _expectInvalidSchedule(s);
        s = _cohort();
        s.cliff = 0;
        _expectInvalidSchedule(s);
    }

    function _expectInvalidSchedule(RoseVault.CohortSchedule memory schedule) internal {
        vm.expectRevert(RoseVault.InvalidSchedule.selector);
        vm.prank(alice);
        vault.createStreams(IERC20(address(token)), schedule, _allocations(1, DEPOSIT));
    }

    function test_createStreams_revertsWithoutFundsAndMintsNothing() public {
        uint256 nextBefore = lockupMock.nextStreamId();
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(vault), 0, 2 * DEPOSIT)
        );
        vm.prank(alice);
        vault.createStreams(IERC20(address(token)), _cohort(), _allocations(2, DEPOSIT));
        assertEq(lockupMock.nextStreamId(), nextBefore);
    }

    /*//////////////////////////////////////////////////////////////////////////
                                    CASH, ATTEST
    //////////////////////////////////////////////////////////////////////////*/

    function test_depositCash_pullsAndEmits() public {
        usdc.mint(alice, 50e6);
        vm.startPrank(alice);
        usdc.approve(address(vault), 50e6);
        vm.expectEmit(true, true, true, true, address(vault));
        emit RoseVault.CashDeposited(alice, address(usdc), 3, NEAR_ACCOUNT, 50e6, NOW);
        vault.depositCash(IERC20(address(usdc)), 50e6, NEAR_ACCOUNT, 3);
        vm.stopPrank();
        assertEq(usdc.balanceOf(address(vault)), 50e6);
    }

    /// @dev Pins the byte layout the NEAR engine rebuilds from, for an account id that fits in one tail word.
    function test_depositCash_rawLogLayout_shortAccount() public {
        Vm.Log memory log = _cashLog(NEAR_ACCOUNT, 50e6, 3);
        _assertCashLogHead(log, 50e6, 3, bytes(NEAR_ACCOUNT).length, 1);
        bytes32 tail = "alice.rose-app.testnet";
        assertEq(_word(log.data, 4), uint256(tail));
    }

    /// @dev Same layout for account ids of 33 to 64 bytes: two tail words, the second right-padded with zeros.
    function test_depositCash_rawLogLayout_longAccount() public {
        string memory account = "0123456789abcdef0123456789abcdef0123.testnet";
        Vm.Log memory log = _cashLog(account, 7e6, 4);
        _assertCashLogHead(log, 7e6, 4, 44, 2);
        bytes32 first = "0123456789abcdef0123456789abcdef";
        bytes32 second = "0123.testnet";
        assertEq(_word(log.data, 4), uint256(first));
        assertEq(_word(log.data, 5), uint256(second));
    }

    /// @dev The 64-byte upper bound (an implicit account) fills both tail words exactly.
    function test_depositCash_rawLogLayout_maxLengthAccount() public {
        string memory account = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        Vm.Log memory log = _cashLog(account, 1, type(uint64).max);
        _assertCashLogHead(log, 1, type(uint64).max, 64, 2);
        bytes32 word = "0123456789abcdef0123456789abcdef";
        assertEq(_word(log.data, 4), uint256(word));
        assertEq(_word(log.data, 5), uint256(word));
    }

    function _cashLog(string memory account, uint128 amount, uint64 roundId) internal returns (Vm.Log memory) {
        usdc.mint(alice, amount);
        vm.startPrank(alice);
        usdc.approve(address(vault), amount);
        vm.recordLogs();
        vault.depositCash(IERC20(address(usdc)), amount, account, roundId);
        vm.stopPrank();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        return logs[logs.length - 1];
    }

    function _assertCashLogHead(Vm.Log memory log, uint128 amount, uint64 roundId, uint256 length, uint256 tailWords)
        internal
        view
    {
        assertEq(log.emitter, address(vault));
        assertEq(log.topics.length, 4);
        assertEq(log.topics[0], keccak256("CashDeposited(address,address,uint64,string,uint128,uint40)"));
        assertEq(log.topics[1], bytes32(uint256(uint160(alice))));
        assertEq(log.topics[2], bytes32(uint256(uint160(address(usdc)))));
        assertEq(log.topics[3], bytes32(uint256(roundId)));
        assertEq(log.data.length, 4 * 32 + tailWords * 32);
        assertEq(_word(log.data, 0), 0x60);
        assertEq(_word(log.data, 1), amount);
        assertEq(_word(log.data, 2), NOW);
        assertEq(_word(log.data, 3), length);
    }

    function test_depositCash_rejectsZeroAmount() public {
        vm.expectRevert(RoseVault.ZeroAmount.selector);
        vault.depositCash(IERC20(address(usdc)), 0, NEAR_ACCOUNT, 1);
    }

    function test_depositCash_rejectsInvalidNearAccount() public {
        vm.expectRevert(RoseVault.InvalidNearAccount.selector);
        vault.depositCash(IERC20(address(usdc)), 1, "a", 1);
    }

    function test_depositCash_rejectsFeeOnTransferToken() public {
        FeeOnTransferToken feeToken = new FeeOnTransferToken();
        feeToken.mint(alice, 100e6);
        vm.startPrank(alice);
        feeToken.approve(address(vault), 100e6);
        vm.expectRevert(abi.encodeWithSelector(RoseVault.AmountMismatch.selector, 100e6, 99e6));
        vault.depositCash(IERC20(address(feeToken)), 100e6, NEAR_ACCOUNT, 1);
        vm.stopPrank();
    }

    function test_attest_emitsCurrentState() public {
        uint256 streamId = _lockedStream(alice);
        _deposit(alice, streamId);
        vm.warp(NOW + 60 days);
        uint128 withdrawable = lockup.withdrawableAmountOf(streamId);
        vm.expectEmit(true, true, true, true, address(vault));
        emit RoseVault.StreamAttested({
            streamId: streamId,
            lockup: address(lockup),
            token: address(token),
            decimals: 18,
            deposited: DEPOSIT,
            withdrawn: 0,
            withdrawable: withdrawable,
            start: NOW - 30 days,
            cliff: NOW + 30 days,
            end: NOW + 365 days,
            granularity: 1,
            startUnlock: 0,
            cliffUnlock: DEPOSIT / 10,
            cancelable: false,
            transferable: true,
            depleted: false,
            timestamp: NOW + 60 days
        });
        vault.attest(streamId);
    }

    function test_attest_rejectsStreamNotHeld() public {
        uint256 streamId = _lockedStream(alice);
        vm.expectRevert(abi.encodeWithSelector(RoseVault.StreamNotHeld.selector, streamId));
        vault.attest(streamId);
    }

    function test_withdrawMaxToVault_isOpenToAnyone() public {
        uint256 streamId = _lockedStream(alice);
        _deposit(alice, streamId);
        vm.warp(NOW + 60 days);
        uint128 vested = lockup.withdrawableAmountOf(streamId);
        vm.prank(bob);
        lockup.withdrawMax{value: FEE}(streamId, address(vault));
        assertEq(token.balanceOf(address(vault)), vested);
    }

    function test_depositCash_rejectsLockupAsToken() public {
        vm.expectRevert(abi.encodeWithSelector(RoseVault.InvalidToken.selector, address(lockup)));
        vault.depositCash(IERC20(address(lockup)), 1, NEAR_ACCOUNT, 1);
    }

    function test_depositCash_succeedsWhenVaultAlreadyHoldsToken() public {
        usdc.mint(address(vault), 100e6);
        usdc.mint(alice, 50e6);
        vm.startPrank(alice);
        usdc.approve(address(vault), 50e6);
        vault.depositCash(IERC20(address(usdc)), 50e6, NEAR_ACCOUNT, 3);
        vm.stopPrank();
        assertEq(usdc.balanceOf(address(vault)), 150e6);
    }

    function test_createStreams_succeedsWhenVaultAlreadyHoldsToken() public {
        token.mint(address(vault), 500e18);
        _fundIssuer(DEPOSIT);
        vm.prank(alice);
        uint256[] memory ids = vault.createStreams(IERC20(address(token)), _cohort(), _allocations(1, DEPOSIT));
        assertEq(lockup.ownerOf(ids[0]), address(vault));
        assertEq(token.balanceOf(address(vault)), 500e18);
        assertEq(token.allowance(address(vault), address(lockup)), 0);
    }

    function test_executeRelease_toContractWithoutReceiverHook() public {
        uint256 streamId = _lockedStream(alice);
        _deposit(alice, streamId);
        address recipient = address(new RejectingSubmitter());
        RoseVault.Release memory auth = RoseVault.Release(address(lockup), streamId, recipient, false, 22);
        (uint8 v, bytes32 r, bytes32 s) = _signRelease(SIGNER_KEY, auth);
        vault.executeRelease(auth, v, r, s);
        assertEq(lockup.ownerOf(streamId), recipient);
    }

    /*//////////////////////////////////////////////////////////////////////////
                               DECIMALS CONSISTENCY
    //////////////////////////////////////////////////////////////////////////*/

    /// @dev The token flips from 18 to 6 decimals while the cohort is pulled: the log must carry the 18 that passed
    /// the minimum check.
    function test_createStreams_emitsDecimalsReadForMinimumCheck() public {
        ShiftingDecimalsToken shifting = new ShiftingDecimalsToken();
        shifting.setTrigger(alice);
        shifting.mint(alice, DEPOSIT);
        vm.startPrank(alice);
        shifting.approve(address(vault), DEPOSIT);
        vm.recordLogs();
        vault.createStreams(IERC20(address(shifting)), _cohort(), _allocations(1, DEPOSIT));
        vm.stopPrank();
        Vm.Log memory log = _lastVaultLog(vm.getRecordedLogs());
        assertEq(shifting.decimals(), 6);
        assertEq(_word(log.data, 3), 18);
    }

    /// @dev The token flips when the vested balance leaves the Lockup during the deposit: same rule.
    function test_depositStream_emitsDecimalsReadForMinimumCheck() public {
        ShiftingDecimalsToken shifting = new ShiftingDecimalsToken();
        shifting.setTrigger(address(lockup));
        shifting.mint(address(this), DEPOSIT);
        shifting.approve(address(lockup), DEPOSIT);
        uint256 streamId = lockup.createWithTimestampsLL(
            Lockup.CreateWithTimestamps({
                sender: address(this),
                recipient: alice,
                depositAmount: DEPOSIT,
                token: IERC20(address(shifting)),
                cancelable: false,
                transferable: true,
                timestamps: Lockup.Timestamps({start: NOW - 100 days, end: NOW + 265 days}),
                shape: ""
            }),
            LockupLinear.UnlockAmounts({start: 0, cliff: 0}),
            1,
            0
        );
        assertGt(lockup.withdrawableAmountOf(streamId), 0);
        vm.startPrank(alice);
        lockup.approve(address(vault), streamId);
        vm.recordLogs();
        vault.depositStream{value: FEE}(lockup, streamId, NEAR_ACCOUNT);
        vm.stopPrank();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        Vm.Log memory log = logs[logs.length - 1];
        assertEq(log.emitter, address(vault));
        assertEq(shifting.decimals(), 6);
        assertEq(_word(log.data, 3), 18);
    }

    /*//////////////////////////////////////////////////////////////////////////
                                    REENTRANCY
    //////////////////////////////////////////////////////////////////////////*/

    function _reentrantCall() internal pure returns (bytes memory) {
        return abi.encodeWithSelector(ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector);
    }

    function test_reentrancy_tokenCannotReenterCreateStreams() public {
        ReentrantToken reentrant = new ReentrantToken();
        reentrant.mint(alice, DEPOSIT);
        RoseVault.Allocation[] memory list = _allocations(1, DEPOSIT);
        reentrant.arm(
            address(vault), abi.encodeCall(vault.createStreams, (IERC20(address(reentrant)), _cohort(), list))
        );
        vm.startPrank(alice);
        reentrant.approve(address(vault), DEPOSIT);
        uint256[] memory ids = vault.createStreams(IERC20(address(reentrant)), _cohort(), list);
        vm.stopPrank();
        assertEq(reentrant.lastReason(), _reentrantCall());
        assertEq(lockup.ownerOf(ids[0]), address(vault));
    }

    function test_reentrancy_tokenCannotReenterDepositCash() public {
        ReentrantToken reentrant = new ReentrantToken();
        reentrant.mint(alice, 50e6);
        reentrant.arm(
            address(vault), abi.encodeCall(vault.depositCash, (IERC20(address(reentrant)), 1e6, NEAR_ACCOUNT, 1))
        );
        vm.startPrank(alice);
        reentrant.approve(address(vault), 50e6);
        vault.depositCash(IERC20(address(reentrant)), 50e6, NEAR_ACCOUNT, 1);
        vm.stopPrank();
        assertEq(reentrant.lastReason(), _reentrantCall());
        assertEq(reentrant.balanceOf(address(vault)), 50e6);
    }

    function test_reentrancy_tokenCannotReenterExecuteTransfer() public {
        ReentrantToken reentrant = new ReentrantToken();
        reentrant.mint(address(vault), 500e6);
        RoseVault.Transfer memory first = RoseVault.Transfer(address(reentrant), bob, 100e6, 1);
        RoseVault.Transfer memory second = RoseVault.Transfer(address(reentrant), bob, 100e6, 2);
        (uint8 v, bytes32 r, bytes32 s) = _signTransfer(SIGNER_KEY, second);
        reentrant.arm(address(vault), abi.encodeCall(vault.executeTransfer, (second, v, r, s)));
        (v, r, s) = _signTransfer(SIGNER_KEY, first);
        vault.executeTransfer(first, v, r, s);
        assertEq(reentrant.lastReason(), _reentrantCall());
        assertEq(reentrant.balanceOf(bob), 100e6);
        assertTrue(vault.isAuthorizationUsed(1));
        assertFalse(vault.isAuthorizationUsed(2));
    }

    function test_reentrancy_refundCannotReenterDepositStream() public {
        ReentrantReceiver holder = new ReentrantReceiver(vault);
        uint256 streamId = _vestingStream(address(holder));
        holder.approveStream(lockup, streamId);
        holder.arm(abi.encodeCall(vault.depositStream, (lockup, streamId, NEAR_ACCOUNT)));
        holder.deposit{value: FEE + 1}(lockup, streamId, NEAR_ACCOUNT);
        assertEq(holder.lastReason(), _reentrantCall());
        assertEq(lockup.ownerOf(streamId), address(vault));
        assertEq(address(holder).balance, 1);
    }

    function test_reentrancy_refundCannotReenterExecuteRelease() public {
        uint256 streamId = _lockedStream(alice);
        _deposit(alice, streamId);
        vm.warp(NOW + 60 days);
        _fundVault(500e6);
        ReentrantReceiver submitter = new ReentrantReceiver(vault);
        RoseVault.Transfer memory payout = RoseVault.Transfer(address(usdc), bob, 100e6, 23);
        (uint8 v, bytes32 r, bytes32 s) = _signTransfer(SIGNER_KEY, payout);
        submitter.arm(abi.encodeCall(vault.executeTransfer, (payout, v, r, s)));
        RoseVault.Release memory release = RoseVault.Release(address(lockup), streamId, bob, false, 24);
        (v, r, s) = _signRelease(SIGNER_KEY, release);
        submitter.release{value: FEE + 1}(release, v, r, s);
        assertEq(submitter.lastReason(), _reentrantCall());
        assertEq(lockup.ownerOf(streamId), bob);
        assertFalse(vault.isAuthorizationUsed(23));
        assertEq(usdc.balanceOf(bob), 0);
    }
}

/// @dev Submits a release on behalf of a contract that has no `receive`, so any refund the vault sends back fails.
contract RejectingSubmitter {
    function submitRelease(RoseVault vault, RoseVault.Release calldata auth, uint8 v, bytes32 r, bytes32 s)
        external
        payable
    {
        vault.executeRelease{value: msg.value}(auth, v, r, s);
    }
}

/// @dev Holder or submitter whose refund hook re-enters the vault with the armed call and records why the re-entry
/// failed; a re-entry that succeeds reverts the whole call.
contract ReentrantReceiver {
    RoseVault private immutable _vault;
    bytes private _attack;
    bytes public lastReason;

    error ReentrySucceeded();

    constructor(RoseVault vault) {
        _vault = vault;
    }

    function arm(bytes calldata attack) external {
        _attack = attack;
    }

    function approveStream(ISablierLockup lockup, uint256 streamId) external {
        lockup.approve(address(_vault), streamId);
    }

    function deposit(ISablierLockup lockup, uint256 streamId, string calldata nearAccount) external payable {
        _vault.depositStream{value: msg.value}(lockup, streamId, nearAccount);
    }

    function release(RoseVault.Release calldata auth, uint8 v, bytes32 r, bytes32 s) external payable {
        _vault.executeRelease{value: msg.value}(auth, v, r, s);
    }

    receive() external payable {
        if (_attack.length == 0) {
            return;
        }
        bytes memory attack = _attack;
        delete _attack;
        (bool ok, bytes memory reason) = address(_vault).call(attack);
        if (ok) {
            revert ReentrySucceeded();
        }
        lastReason = reason;
    }
}
