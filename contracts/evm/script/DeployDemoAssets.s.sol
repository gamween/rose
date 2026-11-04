// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {DemoStreamFaucet} from "../src/DemoStreamFaucet.sol";
import {DemoToken} from "../src/DemoToken.sol";
import {TestUSDC} from "../src/TestUSDC.sol";
import {ISablierLockup} from "../src/interfaces/ISablierLockup.sol";

/// @notice Deploys rose's Base Sepolia test assets: tUSDC, the demo issuer's token and the demo stream faucet.
/// @dev Env: DEMO_TOKEN_NAME, DEMO_TOKEN_SYMBOL. The broadcaster is the demo issuer: it receives the token supply and
/// funds the faucet. Class schedules are anchored to the deployment time so that a Seed position is still before its
/// cliff (nothing withdrawable) and a KOL position is already partly vested.
/// Run: forge script contracts/evm/script/DeployDemoAssets.s.sol --rpc-url base_sepolia --broadcast --private-key ...
contract DeployDemoAssets is Script {
    uint256 internal constant BASE_SEPOLIA = 84532;
    ISablierLockup internal constant SABLIER_LOCKUP = ISablierLockup(0xA65A1ecEf02C2B9BDc604951c6A6D02335D4532e);
    uint256 internal constant TOTAL_SUPPLY = 1_000_000_000e18;
    uint256 internal constant FAUCET_FUNDING = 50_000_000e18;

    function run() external returns (TestUSDC usdc, DemoToken token, DemoStreamFaucet faucet) {
        require(block.chainid == BASE_SEPOLIA, "DeployDemoAssets: Base Sepolia only");
        string memory name = vm.envString("DEMO_TOKEN_NAME");
        string memory symbol = vm.envString("DEMO_TOKEN_SYMBOL");
        uint40 t0 = uint40(block.timestamp);

        vm.startBroadcast();
        address issuer = msg.sender;
        usdc = new TestUSDC();
        token = new DemoToken(name, symbol, issuer, TOTAL_SUPPLY);
        faucet = new DemoStreamFaucet(
            SABLIER_LOCKUP,
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
        require(token.transfer(address(faucet), FAUCET_FUNDING), "DeployDemoAssets: funding failed");
        vm.stopBroadcast();

        console2.log("TestUSDC", address(usdc));
        console2.log("DemoToken", address(token));
        console2.log("DemoStreamFaucet", address(faucet));
    }
}
