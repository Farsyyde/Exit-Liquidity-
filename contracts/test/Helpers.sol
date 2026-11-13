// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {PlayPass} from "../src/PlayPass.sol";

/// Stand-in for the Arbitrum ArbSys precompile at 0x64: L2 block number and
/// L2 block hashes that tests set, so the reveal runs on the same code path
/// as on Robinhood Chain (useArbSys = true).
contract MockArbSys {
    uint256 public num;
    mapping(uint256 => bytes32) public hashes;

    function setBlock(uint256 n) external { num = n; }
    function setHash(uint256 n, bytes32 h) external { hashes[n] = h; }
    function arbBlockNumber() external view returns (uint256) { return num; }
    function arbBlockHash(uint256 n) external view returns (bytes32) {
        require(n < num && n + 256 >= num, "invalid block number for ArbBlockHash");
        return hashes[n];
    }
}

contract MockUSD is ERC20 {
    constructor() ERC20("Mock USD", "mUSD") {}
    function decimals() public pure override returns (uint8) { return 6; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

abstract contract PassFixture is Test {
    MockArbSys internal arb = MockArbSys(address(0x64));
    address internal owner = makeAddr("owner");
    bytes32 internal constant SECRET = keccak256("the owner's style secret");
    uint256 internal constant PRICE = 0.003 ether;
    string internal constant BASE = "https://exitliquidity.example/wallet-pass/";

    function setUp() public virtual {
        vm.etch(address(0x64), type(MockArbSys).runtimeCode);
        arb.setBlock(1000);
    }

    function styleList() internal view returns (bytes memory) {
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/config/founder-styles.json"));
        return vm.parseJsonBytes(json, ".list");
    }

    function deployPass() internal returns (PlayPass p) {
        p = new PlayPass(BASE, owner, IERC20(address(0)), PRICE, styleList(), true);
    }

    function openPass(PlayPass p) internal {
        vm.startPrank(owner);
        p.commitStyleSecret(keccak256(abi.encodePacked(SECRET)));
        p.openSale();
        vm.stopPrank();
    }

    function mintAs(PlayPass p, address who, uint256 n) internal {
        vm.deal(who, who.balance + PRICE * n);
        vm.prank(who);
        p.mint{value: PRICE * n}(n, PRICE);
    }

    /// Close, reveal the secret, move past the reveal block with `h` as its hash, finalize.
    function reveal(PlayPass p, bytes32 h) internal {
        if (p.sale() == PlayPass.Sale.Open) {
            vm.prank(owner);
            p.closeSale();
        }
        p.revealStyleSecret(SECRET);
        uint256 rb = p.revealBlock();
        arb.setHash(rb, h);
        arb.setBlock(rb + 1);
        p.finalizeStyles();
    }

    function wallet(uint256 i) internal pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encode("wallet", i)))));
    }

    /// Mint every founder pass: 740 wallets of 3 plus one of 2.
    function sellOut(PlayPass p) internal {
        for (uint256 i = 0; i < 741; ++i) mintAs(p, wallet(i), i == 740 ? 2 : 3);
    }
}
