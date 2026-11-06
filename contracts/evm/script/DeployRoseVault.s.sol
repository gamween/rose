// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Script, console2} from "forge-std/Script.sol";

import {RoseVault} from "../src/RoseVault.sol";
import {ISablierLockup} from "../src/interfaces/ISablierLockup.sol";

/// @notice Deploys RoseVault on Base Sepolia.
/// @dev Env: ROSE_VAULT_SIGNER, the MPC-derived EVM address of the rose engine (path "vault/base"), and
/// SABLIER_LOCKUP, the canonical Sablier Lockup (scripts/deploy-base.sh passes the one of scripts/lib.sh and reads
/// both back from the deployed vault).
/// Run: scripts/deploy-base.sh, which runs forge script contracts/evm/script/DeployRoseVault.s.sol with them.
contract DeployRoseVault is Script {
    uint256 internal constant BASE_SEPOLIA = 84532;

    function run() external returns (RoseVault vault) {
        require(block.chainid == BASE_SEPOLIA, "DeployRoseVault: Base Sepolia only");
        address signer = vm.envAddress("ROSE_VAULT_SIGNER");
        ISablierLockup lockup = ISablierLockup(vm.envAddress("SABLIER_LOCKUP"));
        vm.startBroadcast();
        vault = new RoseVault(lockup, signer);
        vm.stopBroadcast();
        console2.log("RoseVault", address(vault));
        console2.log("signer", signer);
        console2.log("lockup", address(lockup));
    }
}
