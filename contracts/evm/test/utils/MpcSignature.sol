// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Vm} from "forge-std/Vm.sol";

/// @notice Produces signatures in the exact shape the rose engine builds from a NEAR MPC `sign` response:
/// `r = big_R.x`, `s` normalized to the lower half of the curve order, `v = 27 + recovery_id`, where the recovery id
/// flips whenever `s` is negated.
library MpcSignature {
    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 internal constant SECP256K1_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
    uint256 internal constant HALF_N = SECP256K1_N / 2;

    function sign(uint256 privateKey, bytes32 digest) internal pure returns (uint8 v, bytes32 r, bytes32 s) {
        (uint8 rawV, bytes32 rawR, bytes32 rawS) = VM.sign(privateKey, digest);
        uint8 recoveryId = rawV - 27;
        if (uint256(rawS) > HALF_N) {
            rawS = bytes32(SECP256K1_N - uint256(rawS));
            recoveryId ^= 1;
        }
        return (27 + recoveryId, rawR, rawS);
    }

    /// @notice The malleable twin of a valid signature: same `r`, `s' = n - s`, flipped `v`.
    function highS(uint8 v, bytes32 s) internal pure returns (uint8, bytes32) {
        return (v == 27 ? 28 : 27, bytes32(SECP256K1_N - uint256(s)));
    }
}
