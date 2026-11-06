// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";

import {DeployRoseVault} from "../script/DeployRoseVault.s.sol";
import {RoseVault} from "../src/RoseVault.sol";
import {MockLockup} from "./mocks/MockLockup.sol";

/// @notice DeployRoseVault takes the Sablier Lockup and the signer from the environment (scripts/deploy-base.sh
/// passes the Lockup of scripts/lib.sh), so the immutable vault's Lockup has a single source. One test sets the
/// environment, because forge runs the tests of a contract in parallel and the environment is shared by the process.
contract DeployScriptsTest is Test {
    function test_DeployRoseVaultUsesTheLockupAndSignerOfTheEnvironment() public {
        address lockup = address(new MockLockup());
        address signer = makeAddr("vault-base");
        vm.setEnv("SABLIER_LOCKUP", vm.toString(lockup));
        vm.setEnv("ROSE_VAULT_SIGNER", vm.toString(signer));
        DeployRoseVault script = new DeployRoseVault();

        vm.chainId(1);
        vm.expectRevert(bytes("DeployRoseVault: Base Sepolia only"));
        script.run();

        vm.chainId(84532);
        RoseVault vault = script.run();
        assertEq(address(vault.LOCKUP()), lockup);
        assertEq(vault.SIGNER(), signer);
    }
}
