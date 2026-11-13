// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {PlayPass} from "../src/PlayPass.sol";
import {RunRegistry, IPlayPass} from "../src/RunRegistry.sol";

/// Deploys PlayPass and RunRegistry and writes the addresses to
/// deployments/<chainId>.json. Testnet only: it refuses every chain except
/// Robinhood Chain testnet (46630) and a local dev chain (31337).
///
///   forge script script/Deploy.s.sol --rpc-url robinhood_testnet --broadcast --private-key $DEPLOYER_KEY
///
/// Environment (all optional except SERVER_SIGNER):
///   PASS_BASE_URI        https://<your domain>/wallet-pass/   (passURI = base + token id)
///   MINT_PRICE_WEI       founder price per pass, in the payment unit (default 0.003 ether)
///   PAYMENT_TOKEN        ERC-20 for the price; unset or 0x0 = native ETH. Fixed for good at deploy.
///   SERVER_SIGNER        address of the run server's EIP-712 key (apps/server prints it)
///   SEED_OPERATOR        who commits and reveals daily seeds (default: deployer)
///   OWNER                owner of both contracts (default: deployer)
///   STYLE_SECRET_COMMIT  keccak256(secret) from script/style-secret.mjs; committed now if set
///   OPEN_SALE            "true" to open the founder sale right away (needs the commit)
contract Deploy is Script {
    struct Config {
        bool arb;
        string baseUri;
        uint256 price;
        address token;
        address serverSigner;
        bytes32 commit;
        bool open;
        bytes styles;
    }

    struct Result {
        PlayPass pass;
        RunRegistry registry;
        address owner;
        address operator;
        uint256 startBlock;
    }

    function config() internal view returns (Config memory c) {
        require(block.chainid == 46630 || block.chainid == 31337, "testnet only: Robinhood Chain testnet (46630) or a local chain (31337)");
        c.arb = block.chainid == 46630;
        c.baseUri = vm.envOr("PASS_BASE_URI", string("http://127.0.0.1:8787/wallet-pass/"));
        c.price = vm.envOr("MINT_PRICE_WEI", uint256(0.003 ether));
        c.token = vm.envOr("PAYMENT_TOKEN", address(0));
        c.serverSigner = vm.envAddress("SERVER_SIGNER");
        c.commit = vm.envOr("STYLE_SECRET_COMMIT", bytes32(0));
        c.open = vm.envOr("OPEN_SALE", false);
        c.styles = vm.parseJsonBytes(vm.readFile(string.concat(vm.projectRoot(), "/config/founder-styles.json")), ".list");
    }

    function run() external returns (PlayPass, RunRegistry) {
        Config memory c = config();
        vm.startBroadcast();
        Result memory r = deploy(c);
        vm.stopBroadcast();
        write(c, r);
        return (r.pass, r.registry);
    }

    function deploy(Config memory c) internal returns (Result memory r) {
        (, address deployer,) = vm.readCallers();
        r.owner = vm.envOr("OWNER", deployer);
        r.operator = vm.envOr("SEED_OPERATOR", deployer);
        // The RPC's block number, which on an Arbitrum chain is the L2 block number logs are indexed by.
        // (Inside contracts block.number is an L1 estimate there; and forge simulates scripts locally,
        // where the ArbSys precompile does not exist, so it is not called here.)
        r.startBlock = vm.getBlockNumber();
        r.pass = new PlayPass(c.baseUri, deployer, IERC20(c.token), c.price, c.styles, c.arb);
        r.registry = new RunRegistry(IPlayPass(address(r.pass)), r.owner, c.serverSigner, r.operator, 3);
        r.pass.setUpdater(address(r.registry), true);
        if (c.commit != bytes32(0)) r.pass.commitStyleSecret(c.commit);
        if (c.open) r.pass.openSale();
        if (r.owner != deployer) r.pass.transferOwnership(r.owner);
    }

    function write(Config memory c, Result memory r) internal {
        string memory k = "deployment";
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeAddress(k, "playPass", address(r.pass));
        vm.serializeAddress(k, "runRegistry", address(r.registry));
        vm.serializeUint(k, "deployBlock", r.startBlock);
        vm.serializeString(k, "passBaseURI", c.baseUri);
        vm.serializeUint(k, "price", c.price);
        vm.serializeAddress(k, "paymentToken", c.token);
        vm.serializeAddress(k, "serverSigner", c.serverSigner);
        vm.serializeAddress(k, "seedOperator", r.operator);
        vm.serializeAddress(k, "owner", r.owner);
        vm.serializeBytes32(k, "styleListHash", r.pass.styleListHash());
        vm.serializeBytes32(k, "styleSecretCommit", c.commit);
        string memory json = vm.serializeBool(k, "useArbSys", c.arb);
        bool live = vm.isContext(VmSafe.ForgeContext.ScriptBroadcast);
        string memory path =
            string.concat(vm.projectRoot(), "/deployments/", vm.toString(block.chainid), live ? ".json" : ".dry-run.json");
        vm.writeJson(json, path);
        console2.log("PlayPass", address(r.pass));
        console2.log("RunRegistry", address(r.registry));
        console2.log("written", path);
    }
}
