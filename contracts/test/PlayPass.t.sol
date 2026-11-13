// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {IERC721WalletPass} from "@erc8426/contracts/src/IERC721WalletPass.sol";
import {ERC721WalletPass} from "@erc8426/contracts/src/ERC721WalletPass.sol";

import {PlayPass} from "../src/PlayPass.sol";
import {PassFixture, MockUSD} from "./Helpers.sol";

contract PlayPassTest is PassFixture {
    event PassUpdate(uint256 indexed tokenId);
    event BatchPassUpdate(uint256 fromTokenId, uint256 toTokenId);

    PlayPass internal pass;
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    function setUp() public override {
        super.setUp();
        pass = deployPass();
        openPass(pass);
    }

    // ------------------------------------------------------------ ERC-8426

    function test_SupportsWalletPassInterface() public view {
        assertEq(type(IERC721WalletPass).interfaceId, bytes4(0xef5f1e71), "spec interface id");
        assertTrue(pass.supportsInterface(0xef5f1e71), "ERC-8426");
        assertTrue(pass.supportsInterface(type(IERC721).interfaceId), "ERC-721");
        assertTrue(pass.supportsInterface(0x01ffc9a7), "ERC-165");
        assertFalse(pass.supportsInterface(0xffffffff), "ERC-165 invalid id");
        assertFalse(pass.supportsInterface(0x49064906), "ERC-4906 not mirrored");
    }

    function test_PassURI() public {
        mintAs(pass, alice, 2);
        assertEq(pass.passURI(1), string.concat(BASE, "1"));
        assertEq(pass.passURI(2), string.concat(BASE, "2"));
    }

    function test_PassURIRevertsForNonexistentToken() public {
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, 7));
        pass.passURI(7);
    }

    function test_PassBaseURIOwnerOnly() public {
        mintAs(pass, alice, 1);
        vm.prank(alice);
        vm.expectRevert();
        pass.setPassBaseURI("https://evil.example/");
        vm.prank(owner);
        pass.setPassBaseURI("https://passes.example/wallet-pass/");
        assertEq(pass.passURI(1), "https://passes.example/wallet-pass/1");
    }

    function test_PassUpdateOnMintAndTransfer() public {
        vm.deal(alice, PRICE);
        vm.expectEmit(true, false, false, false, address(pass));
        emit PassUpdate(1);
        vm.prank(alice);
        pass.mint{value: PRICE}(1, PRICE);

        vm.expectEmit(true, false, false, false, address(pass));
        emit PassUpdate(1);
        vm.prank(alice);
        pass.transferFrom(alice, bob, 1);
        assertEq(pass.ownerOf(1), bob);
    }

    function test_PassUpdateOnRevealCoversEveryMintedPass() public {
        mintAs(pass, alice, 3);
        mintAs(pass, bob, 2);
        vm.prank(owner);
        pass.closeSale();
        pass.revealStyleSecret(SECRET);
        arb.setHash(pass.revealBlock(), keccak256("block"));
        arb.setBlock(pass.revealBlock() + 1);
        vm.expectEmit(false, false, false, true, address(pass));
        emit BatchPassUpdate(1, 5);
        pass.finalizeStyles();
    }

    // ----------------------------------------------------------- the sale

    function test_SupplyCapAndAutoClose() public {
        sellOut(pass);
        assertEq(pass.foundersMinted(), 2222);
        assertEq(uint256(pass.sale()), uint256(PlayPass.Sale.Closed), "selling out closes the sale");
        vm.deal(alice, PRICE);
        vm.prank(alice);
        vm.expectRevert(PlayPass.SaleNotOpen.selector);
        pass.mint{value: PRICE}(1, PRICE);
    }

    function test_CannotMintPastSupply() public {
        for (uint256 i = 0; i < 740; ++i) mintAs(pass, wallet(i), 3); // 2220
        address last = wallet(9999);
        vm.deal(last, PRICE * 3);
        vm.prank(last);
        vm.expectRevert(PlayPass.SoldOut.selector);
        pass.mint{value: PRICE * 3}(3, PRICE);
        mintAs(pass, last, 2);
        assertEq(pass.foundersMinted(), 2222);
    }

    function test_PerWalletCap() public {
        mintAs(pass, alice, 2);
        vm.deal(alice, PRICE * 2);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PlayPass.WalletLimit.selector, 2, 2));
        pass.mint{value: PRICE * 2}(2, PRICE);
        mintAs(pass, alice, 1);
        vm.deal(alice, PRICE);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PlayPass.WalletLimit.selector, 3, 1));
        pass.mint{value: PRICE}(1, PRICE);
        // moving passes away does not reset the cap: it counts mints, not balance
        vm.startPrank(alice);
        pass.transferFrom(alice, bob, 1);
        pass.transferFrom(alice, bob, 2);
        vm.stopPrank();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PlayPass.WalletLimit.selector, 3, 1));
        pass.mint{value: PRICE}(1, PRICE);
    }

    function test_WrongPayment() public {
        vm.deal(alice, 1 ether);
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(PlayPass.WrongPayment.selector, PRICE * 2, PRICE));
        pass.mint{value: PRICE}(2, PRICE);
        vm.expectRevert(abi.encodeWithSelector(PlayPass.WrongPayment.selector, PRICE, PRICE + 1));
        pass.mint{value: PRICE + 1}(1, PRICE);
        vm.expectRevert(abi.encodeWithSelector(PlayPass.WrongPayment.selector, PRICE, 0));
        pass.mint(1, PRICE);
        vm.expectRevert(PlayPass.BadQuantity.selector);
        pass.mint(0, PRICE);
        vm.stopPrank();
    }

    function test_PriceChangeCannotSurpriseAMinter() public {
        vm.prank(owner);
        pass.setPrice(PRICE * 2);
        vm.deal(alice, PRICE * 2);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PlayPass.PriceChanged.selector, PRICE * 2, PRICE));
        pass.mint{value: PRICE * 2}(1, PRICE);
    }

    function test_SaleMustBeOpen() public {
        PlayPass fresh = deployPass();
        vm.deal(alice, PRICE);
        vm.prank(alice);
        vm.expectRevert(PlayPass.SaleNotOpen.selector);
        fresh.mint{value: PRICE}(1, PRICE);
        vm.prank(owner);
        vm.expectRevert(PlayPass.NoSecretCommitted.selector);
        fresh.openSale(); // the style secret must be committed before anyone can mint
    }

    function test_StablecoinPayment() public {
        MockUSD usd = new MockUSD();
        PlayPass p = new PlayPass(BASE, owner, IERC20(address(usd)), 10e6, styleList(), true);
        openPass(p);
        usd.mint(alice, 30e6);
        vm.startPrank(alice);
        usd.approve(address(p), 30e6);
        vm.deal(alice, 1);
        vm.expectRevert(abi.encodeWithSelector(PlayPass.WrongPayment.selector, 0, 1));
        p.mint{value: 1}(1, 10e6);
        p.mint(2, 10e6);
        vm.stopPrank();
        assertEq(usd.balanceOf(address(p)), 20e6);
        vm.prank(owner);
        p.withdraw(payable(owner));
        assertEq(usd.balanceOf(owner), 20e6);
    }

    function test_Withdraw() public {
        mintAs(pass, alice, 3);
        vm.prank(alice);
        vm.expectRevert();
        pass.withdraw(payable(alice));
        vm.prank(owner);
        pass.withdraw(payable(owner));
        assertEq(owner.balance, PRICE * 3);
    }

    // ----------------------------------------------------------- styles

    function test_StyleListIsCommittedAndChecked() public view {
        bytes memory list = styleList();
        assertEq(pass.styleListHash(), keccak256(list));
        assertEq(keccak256(pass.styleList()), keccak256(list));
        assertEq(pass.styleListHash(), 0x21af71c806ea0c53fc9d70da4833a4402838bb75993664c0db9a78dbbb14adf5, "published hash");
    }

    function test_ConstructorRejectsAListThatBreaksTheCaps() public {
        bytes memory list = styleList();
        // swap one Classic for an extra Founders Gold
        for (uint256 i = 0; i < list.length; ++i) {
            if (uint8(list[i]) == 0) { list[i] = bytes1(uint8(2)); break; }
        }
        vm.expectRevert(PlayPass.BadStyleList.selector);
        new PlayPass(BASE, owner, IERC20(address(0)), PRICE, list, true);
        vm.expectRevert(PlayPass.BadStyleList.selector);
        new PlayPass(BASE, owner, IERC20(address(0)), PRICE, new bytes(2221), true);
    }

    function test_StyleCountsAfterRevealMatchTheCapsExactly() public {
        sellOut(pass);
        reveal(pass, keccak256("some future block"));
        uint256[6] memory counts;
        for (uint256 id = 1; id <= 2222; ++id) ++counts[pass.styleOf(id)];
        assertEq(counts[0], 800, "Classic");
        assertEq(counts[1], 500, "Neon");
        assertEq(counts[2], 72, "Founders Gold");
        assertEq(counts[3], 400, "Blood Moon");
        assertEq(counts[4], 300, "Ghost");
        assertEq(counts[5], 150, "Glitch");
    }

    /// The caps hold for every possible offset, not just the one drawn.
    function testFuzz_CapsHoldForAnyOffset(uint256 offset) public view {
        offset = bound(offset, 0, 2221);
        bytes memory list = pass.styleList();
        uint256[6] memory counts;
        for (uint256 id = 1; id <= 2222; ++id) ++counts[uint8(list[(id - 1 + offset) % 2222])];
        assertEq(counts[0], 800); assertEq(counts[1], 500); assertEq(counts[2], 72);
        assertEq(counts[3], 400); assertEq(counts[4], 300); assertEq(counts[5], 150);
    }

    // ------------------------------- a minter cannot influence or predict their style

    function test_StyleIsHiddenUntilFinalized() public {
        mintAs(pass, alice, 3);
        for (uint256 id = 1; id <= 3; ++id) assertEq(pass.styleOf(id), pass.UNREVEALED(), "open sale");
        vm.prank(owner);
        pass.closeSale();
        assertEq(pass.styleOf(1), pass.UNREVEALED(), "closed");
        pass.revealStyleSecret(SECRET);
        assertEq(pass.styleOf(1), pass.UNREVEALED(), "secret public, block hash not yet known");
        arb.setHash(pass.revealBlock(), keccak256("b"));
        arb.setBlock(pass.revealBlock() + 1);
        pass.finalizeStyles();
        assertTrue(pass.styleOf(1) < 6, "revealed");
    }

    /// Every mint happens before any randomness exists: the secret cannot be
    /// revealed while the sale is open, and nobody can mint once it is closed.
    function test_RandomnessExistsOnlyAfterTheLastMint() public {
        mintAs(pass, alice, 1);
        vm.expectRevert(PlayPass.SaleNotClosed.selector);
        pass.revealStyleSecret(SECRET);
        vm.expectRevert(PlayPass.SecretNotRevealed.selector);
        pass.finalizeStyles();
        vm.prank(owner);
        pass.closeSale();
        vm.deal(bob, PRICE);
        vm.prank(bob);
        vm.expectRevert(PlayPass.SaleNotOpen.selector);
        pass.mint{value: PRICE}(1, PRICE);
    }

    /// Who mints, how many, in what order and when has no effect on the offset.
    function testFuzz_MinterChoicesDoNotMoveTheOffset(uint8 a, uint8 b, uint8 c, uint256 blockGap) public {
        bytes32 h = keccak256("fixed future block");
        PlayPass p1 = deployPass();
        openPass(p1);
        mintAs(p1, alice, 1 + (a % 3));
        mintAs(p1, bob, 1 + (b % 3));
        PlayPass p2 = deployPass();
        openPass(p2);
        arb.setBlock(arb.num() + bound(blockGap, 0, 1000)); // minting later
        mintAs(p2, wallet(c), 3);
        mintAs(p2, alice, 1);
        // same secret, same reveal block hash: same offset, whatever was minted
        vm.startPrank(owner);
        p1.closeSale();
        p2.closeSale();
        vm.stopPrank();
        p1.revealStyleSecret(SECRET);
        p2.revealStyleSecret(SECRET);
        assertEq(p1.revealBlock(), p2.revealBlock());
        arb.setHash(p1.revealBlock(), h);
        arb.setBlock(p1.revealBlock() + 1);
        p1.finalizeStyles();
        p2.finalizeStyles();
        // the offset also mixes in the contract address, so compare each
        // against what the published formula gives
        assertEq(p1.styleOffset(), uint256(keccak256(abi.encode(SECRET, h, address(p1)))) % 2222);
        assertEq(p2.styleOffset(), uint256(keccak256(abi.encode(SECRET, h, address(p2)))) % 2222);
    }

    /// The style a token gets depends on a block hash that did not exist when
    /// the owner revealed the secret: different hashes give different styles.
    function test_FutureBlockHashDecidesTheStyle() public {
        bool differs;
        uint8 first;
        for (uint256 k = 0; k < 8; ++k) {
            PlayPass p = deployPass();
            openPass(p);
            mintAs(p, alice, 1);
            reveal(p, keccak256(abi.encode("hash", k)));
            uint8 s = p.styleOf(1);
            if (k == 0) first = s;
            else if (s != first) differs = true;
            arb.setBlock(arb.num() + 1);
        }
        assertTrue(differs, "the block hash moves the style");
    }

    function test_RevealTimingRules() public {
        mintAs(pass, alice, 1);
        vm.prank(owner);
        pass.closeSale();
        vm.expectRevert(PlayPass.SecretMismatch.selector);
        pass.revealStyleSecret(keccak256("guess"));
        pass.revealStyleSecret(SECRET);
        vm.expectRevert(PlayPass.AlreadyRevealed.selector);
        pass.revealStyleSecret(SECRET); // the reveal block cannot be re-picked
        uint256 rb = pass.revealBlock();
        assertEq(rb, 1000 + pass.REVEAL_DELAY());
        arb.setBlock(rb);
        vm.expectRevert(abi.encodeWithSelector(PlayPass.TooEarly.selector, rb, rb));
        pass.finalizeStyles();
        vm.expectRevert(PlayPass.WindowOpen.selector);
        pass.rearmReveal();
        // nobody finalized for the whole window: anyone may re-arm
        arb.setBlock(rb + pass.REVEAL_WINDOW() + 1);
        vm.expectRevert(PlayPass.WindowMissed.selector);
        pass.finalizeStyles();
        vm.prank(bob);
        pass.rearmReveal();
        uint256 rb2 = pass.revealBlock();
        arb.setHash(rb2, keccak256("later"));
        arb.setBlock(rb2 + 1);
        vm.prank(bob); // anyone can finalize
        pass.finalizeStyles();
        assertTrue(pass.revealed());
    }

    function test_SecretCannotChangeOnceCommitted() public {
        vm.prank(owner);
        vm.expectRevert(PlayPass.SecretAlreadyCommitted.selector);
        pass.commitStyleSecret(keccak256("another"));
    }

    // ---------------------------------------------------- updater and expiry

    function test_UpdaterRole() public {
        mintAs(pass, alice, 1);
        address registry = makeAddr("registry");
        vm.prank(registry);
        vm.expectRevert(PlayPass.NotUpdater.selector);
        pass.passUpdate(1);
        vm.prank(alice);
        vm.expectRevert();
        pass.setUpdater(registry, true);
        vm.prank(owner);
        pass.setUpdater(registry, true);
        vm.expectEmit(true, false, false, false, address(pass));
        emit PassUpdate(1);
        vm.prank(registry);
        pass.passUpdate(1);
        vm.prank(registry);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, 99));
        pass.passUpdate(99);
    }

    function test_FounderPassesNeverExpire() public {
        mintAs(pass, alice, 1);
        assertEq(pass.expiresAt(1), 0);
        vm.warp(block.timestamp + 3650 days);
        assertTrue(pass.isActive(1));
        vm.expectRevert(PlayPass.FounderNeverExpires.selector);
        pass.renew{value: 1}(1, 1);
    }

    function test_SeasonalPassesExpireAndRenew() public {
        vm.prank(owner);
        uint256 id = pass.grantSeasonal(alice, 1, 1, 7 days);
        assertEq(id, 100_001);
        assertEq(pass.styleOf(id), 1);
        assertTrue(pass.isActive(id));
        vm.warp(block.timestamp + 8 days);
        assertFalse(pass.isActive(id));
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PlayPass.NotForSale.selector, 1));
        pass.renew{value: 0.01 ether}(id, 1); // season prices start at zero: not for sale
        vm.prank(owner);
        pass.setSeasonPrice(1, 0.01 ether);
        vm.expectEmit(true, false, false, false, address(pass));
        emit PassUpdate(id);
        vm.prank(alice);
        pass.renew{value: 0.01 ether}(id, 1);
        assertTrue(pass.isActive(id));
        assertEq(pass.expiresAt(id), uint64(block.timestamp) + 30 days);
    }
}
