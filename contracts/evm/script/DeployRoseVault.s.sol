// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Script, console2} from "forge-std/Script.sol";

import {RoseVault} from "../src/RoseVault.sol";
import {ISablierLockup} from "../src/interfaces/ISablierLockup.sol";

/// @notice Deploys RoseVault on Base Sepolia.
/// @dev Env: ROSE_VAULT_SIGNER, the MPC-derived EVM address of the rose engine (path "vault/base").
/// Run: forge script contracts/evm/script/DeployRoseVault.s.sol --rpc-url base_sepolia --broadcast --private-key ...
contract DeployRoseVault is Script {
    uint256 internal constant BASE_SEPOLIA = 84532;
    ISablierLockup internal constant SABLIER_LOCKUP = ISablierLockup(0xA65A1ecEf02C2B9BDc604951c6A6D02335D4532e);

    function run() external returns (RoseVault vault) {
        require(block.chainid == BASE_SEPOLIA, "DeployRoseVault: Base Sepolia only");
        address signer = vm.envAddress("ROSE_VAULT_SIGNER");
        vm.startBroadcast();
        vault = new RoseVault(SABLIER_LOCKUP, signer);
        vm.stopBroadcast();
        console2.log("RoseVault", address(vault));
        console2.log("signer", signer);
    }
}
