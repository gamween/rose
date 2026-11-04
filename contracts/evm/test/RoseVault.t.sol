// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Test, Vm} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {RoseVault} from "../src/RoseVault.sol";
import {ISablierLockup, Lockup, LockupLinear} from "../src/interfaces/ISablierLockup.sol";
import {MockLockup} from "./mocks/MockLockup.sol";
import {FeeOnTransferToken, MockERC20} from "./mocks/MockTokens.sol";
import {MpcSignature} from "./utils/MpcSignature.sol";

contract RoseVaultTest is Test {
    uint256 internal constant SIGNER_KEY = 0xA11CE;
    uint256 internal constant FEE = 0.0004 ether;
    uint128 internal constant DEPOSIT = 1_000_000e18;
    uint40 internal constant NOW = 1_800_000_000;
    string internal constant NEAR_ACCOUNT = "alice.rose-app.testnet";
    bytes32 internal constant KAT_TRANSFER_DIGEST = 0x652ed7c219938bcc420b0786454c4e4a58b5baeed9dd1cfdf3ba8c4b1e08ac01;
    bytes32 internal constant KAT_RELEASE_DIGEST = 0x87ab8e82a059a262d10be8885c9b5993c14f8bbe9ba38e33cc96179b5f5ee308;

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
        assertEq(vault.RELEASE_TYPEHASH(), keccak256("Release(address lockup,uint256 streamId,address to,uint256 id)"));
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
        RoseVault.Release memory auth = RoseVault.Release(address(lockup), 9, bob, 43);
        bytes32 structHash =
            keccak256(abi.encode(vault.RELEASE_TYPEHASH(), auth.lockup, auth.streamId, auth.to, auth.id));
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
            0xA65A1ecEf02C2B9BDc604951c6A6D02335D4532e, 81, 0x000000000000000000000000000000000000b0b0, 8
        );
        assertEq(fixedVault.hashTransfer(auth), KAT_TRANSFER_DIGEST);
        assertEq(fixedVault.hashRelease(release), KAT_RELEASE_DIGEST);
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
        RoseVault.Release memory release = RoseVault.Release(address(usdc), uint256(uint160(bob)), bob, 1);
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

        RoseVault.Release memory release = RoseVault.Release(address(lockup), streamId, bob, 5);
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
                "StreamDeposited(address,string,address,uint256,address,uint128,uint128,uint40,uint40,uint40,uint40,uint128,uint128,bool,bool,uint40)"
            )
        );
        assertEq(log.topics[1], bytes32(uint256(uint160(alice))));
        assertEq(log.topics[2], bytes32(streamId));

        bytes memory nearAccount = bytes(NEAR_ACCOUNT);
        assertEq(log.data.length, 15 * 32 + 32);
        assertEq(_word(log.data, 0), 14 * 32);
        assertEq(_word(log.data, 1), uint256(uint160(address(lockup))));
        assertEq(_word(log.data, 2), uint256(uint160(address(token))));
        assertEq(_word(log.data, 3), DEPOSIT);
        assertEq(_word(log.data, 4), 0);
        assertEq(_word(log.data, 5), NOW - 30 days);
        assertEq(_word(log.data, 6), NOW + 30 days);
        assertEq(_word(log.data, 7), NOW + 365 days);
        assertEq(_word(log.data, 8), 1);
        assertEq(_word(log.data, 9), 0);
        assertEq(_word(log.data, 10), DEPOSIT / 10);
        assertEq(_word(log.data, 11), 0);
        assertEq(_word(log.data, 12), 1);
        assertEq(_word(log.data, 13), NOW);
        assertEq(_word(log.data, 14), nearAccount.length);
        bytes32 expectedTail = "alice.rose-app.testnet";
        assertEq(_word(log.data, 15), uint256(expectedTail));
    }

    function _word(bytes memory data, uint256 index) internal pure returns (uint256 value) {
        assembly {
            value := mload(add(data, add(32, mul(index, 32))))
        }
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

        RoseVault.Release memory auth = RoseVault.Release(address(lockup), streamId, bob, 11);
        (uint8 v, bytes32 r, bytes32 s) = _signRelease(SIGNER_KEY, auth);
        uint256 ethBefore = alice.balance;

        vm.expectEmit(true, true, true, true, address(vault));
        emit RoseVault.ReleaseExecuted(11, streamId, bob, address(lockup), vested);
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

    function test_executeRelease_zeroWithdrawable_needsNoFee() public {
        uint256 streamId = _lockedStream(alice);
        _deposit(alice, streamId);
        RoseVault.Release memory auth = RoseVault.Release(address(lockup), streamId, bob, 12);
        (uint8 v, bytes32 r, bytes32 s) = _signRelease(SIGNER_KEY, auth);

        vm.expectEmit(true, true, true, true, address(vault));
        emit RoseVault.ReleaseExecuted(12, streamId, bob, address(lockup), 0);
        vault.executeRelease(auth, v, r, s);
        assertEq(lockup.ownerOf(streamId), bob);
    }

    function test_executeRelease_refundsExcessValue() public {
        uint256 streamId = _lockedStream(alice);
        _deposit(alice, streamId);
        vm.warp(NOW + 60 days);
        RoseVault.Release memory auth = RoseVault.Release(address(lockup), streamId, bob, 18);
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
        RoseVault.Release memory auth = RoseVault.Release(address(lockup), streamId, bob, 19);
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
        RoseVault.Release memory auth = RoseVault.Release(address(lockup), streamId, bob, 20);
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
        RoseVault.Release memory auth = RoseVault.Release(address(lockup), streamId, bob, 21);
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
        RoseVault.Release memory auth = RoseVault.Release(address(lockup), streamId, bob, 13);
        (uint8 v, bytes32 r, bytes32 s) = _signRelease(SIGNER_KEY, auth);
        vm.expectRevert(abi.encodeWithSelector(RoseVault.InsufficientFee.selector, 0, FEE));
        vault.executeRelease(auth, v, r, s);
        assertFalse(vault.isAuthorizationUsed(13));
    }

    function test_executeRelease_rejectsWrongLockup() public {
        RoseVault.Release memory auth = RoseVault.Release(address(token), 1, bob, 14);
        (uint8 v, bytes32 r, bytes32 s) = _signRelease(SIGNER_KEY, auth);
        vm.expectRevert(abi.encodeWithSelector(RoseVault.WrongLockup.selector, address(token)));
        vault.executeRelease(auth, v, r, s);
    }

    function test_executeRelease_rejectsZeroRecipient() public {
        RoseVault.Release memory auth = RoseVault.Release(address(lockup), 1, address(0), 15);
        (uint8 v, bytes32 r, bytes32 s) = _signRelease(SIGNER_KEY, auth);
        vm.expectRevert(RoseVault.ZeroAddress.selector);
        vault.executeRelease(auth, v, r, s);
    }

    function test_executeRelease_rejectsReplay() public {
        uint256 streamId = _lockedStream(alice);
        _deposit(alice, streamId);
        RoseVault.Release memory auth = RoseVault.Release(address(lockup), streamId, bob, 16);
        (uint8 v, bytes32 r, bytes32 s) = _signRelease(SIGNER_KEY, auth);
        vault.executeRelease(auth, v, r, s);
        vm.expectRevert(abi.encodeWithSelector(RoseVault.AuthorizationUsed.selector, 16));
        vault.executeRelease(auth, v, r, s);
    }

    function test_executeRelease_streamNotHeldKeepsIdUnused() public {
        uint256 streamId = _lockedStream(alice);
        RoseVault.Release memory auth = RoseVault.Release(address(lockup), streamId, bob, 17);
        (uint8 v, bytes32 r, bytes32 s) = _signRelease(SIGNER_KEY, auth);
        vm.expectRevert();
        vault.executeRelease(auth, v, r, s);
        assertFalse(vault.isAuthorizationUsed(17));
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
