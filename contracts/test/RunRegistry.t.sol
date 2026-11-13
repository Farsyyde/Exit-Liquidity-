// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PlayPass} from "../src/PlayPass.sol";
import {RunRegistry, IPlayPass} from "../src/RunRegistry.sol";
import {PassFixture} from "./Helpers.sol";

contract RunRegistryTest is PassFixture {
    event PassUpdate(uint256 indexed tokenId);

    PlayPass internal pass;
    RunRegistry internal reg;
    uint256 internal serverKey = 0xA11CE;
    address internal server;
    address internal operator = makeAddr("seedOperator");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    uint32 internal constant DAY = 20405; // 2025-11-13
    bytes32 internal constant DAILY_SEED = keccak256("daily seed bytes");

    function setUp() public override {
        super.setUp();
        server = vm.addr(serverKey);
        pass = deployPass();
        openPass(pass);
        mintAs(pass, alice, 2); // passes 1 and 2
        mintAs(pass, bob, 1); // pass 3
        reg = new RunRegistry(IPlayPass(address(pass)), owner, server, operator, 3);
        vm.prank(owner);
        pass.setUpdater(address(reg), true);
        vm.prank(operator);
        reg.commitDailySeed(DAY, keccak256(abi.encodePacked(DAILY_SEED)));
    }

    function result(uint256 passId, uint8 attempt, bytes32 receipt, uint8 layers, uint64 bank)
        internal pure returns (RunRegistry.RunResult memory)
    {
        return RunRegistry.RunResult(passId, DAY, attempt, receipt, layers, bank);
    }

    function sign(uint256 key, RunRegistry.RunResult memory r) internal view returns (bytes memory) {
        (uint8 v, bytes32 rr, bytes32 s) = vm.sign(key, reg.hashRunResult(r));
        return abi.encodePacked(rr, s, v);
    }

    // -------------------------------------------------------------- settle

    function test_SettleRecordsBestAndSignalsThePass() public {
        RunRegistry.RunResult memory r = result(1, 1, keccak256("receipt 1"), 3, 41250);
        bytes memory sig = sign(serverKey, r);
        vm.expectEmit(true, false, false, false, address(pass));
        emit PassUpdate(1);
        vm.prank(alice);
        assertTrue(reg.settle(r, sig));
        (uint8 layers, uint64 bank, uint32 day, bytes32 rh) = reg.bestOf(1);
        assertEq(layers, 3); assertEq(bank, 41250); assertEq(day, DAY); assertEq(rh, keccak256("receipt 1"));
        assertEq(reg.runsSettled(1), 1);
        assertTrue(reg.attemptUsed(1, DAY, 1));

        // a worse run is recorded but does not replace the best
        RunRegistry.RunResult memory w = result(1, 2, keccak256("receipt 2"), 2, 99999);
        bytes memory sig_1 = sign(serverKey, w);
        vm.prank(alice);
        assertFalse(reg.settle(w, sig_1));
        (layers,,,) = reg.bestOf(1);
        assertEq(layers, 3);
        // more layers beats a bigger bankroll; same layers, bigger bankroll wins
        RunRegistry.RunResult memory b = result(1, 3, keccak256("receipt 3"), 3, 50000);
        bytes memory sig_2 = sign(serverKey, b);
        vm.prank(alice);
        assertTrue(reg.settle(b, sig_2));
        (, bank,,) = reg.bestOf(1);
        assertEq(bank, 50000);
        assertEq(reg.runsSettled(1), 3);
    }

    function test_ReplayedSettleIsRefused() public {
        RunRegistry.RunResult memory r = result(1, 1, keccak256("receipt"), 1, 12500);
        bytes memory sig = sign(serverKey, r);
        vm.startPrank(alice);
        reg.settle(r, sig);
        vm.expectRevert(abi.encodeWithSelector(RunRegistry.AttemptUsed.selector, 1, DAY, 1));
        reg.settle(r, sig);
        // the same receipt cannot be settled again under another attempt or another pass
        RunRegistry.RunResult memory r2 = result(1, 2, keccak256("receipt"), 1, 12500);
        bytes memory sig_3 = sign(serverKey, r2);
        vm.expectRevert(abi.encodeWithSelector(RunRegistry.ReceiptUsed.selector, keccak256("receipt")));
        reg.settle(r2, sig_3);
        RunRegistry.RunResult memory r3 = result(2, 1, keccak256("receipt"), 1, 12500);
        bytes memory sig_4 = sign(serverKey, r3);
        vm.expectRevert(abi.encodeWithSelector(RunRegistry.ReceiptUsed.selector, keccak256("receipt")));
        reg.settle(r3, sig_4);
        vm.stopPrank();
    }

    function test_ForgedSettleIsRefused() public {
        RunRegistry.RunResult memory r = result(1, 1, keccak256("receipt"), 8, 1_000_000);
        // signed by someone other than the server
        bytes memory sig_5 = sign(0xBAD, r);
        vm.prank(alice);
        vm.expectRevert(RunRegistry.BadSignature.selector);
        reg.settle(r, sig_5);
        // a real server signature over different numbers
        bytes memory sig = sign(serverKey, result(1, 1, keccak256("receipt"), 1, 100));
        vm.prank(alice);
        vm.expectRevert(RunRegistry.BadSignature.selector);
        reg.settle(r, sig);
        // a real signature for another pass
        RunRegistry.RunResult memory forBob = result(3, 1, keccak256("bob's receipt"), 2, 300);
        bytes memory bobSig = sign(serverKey, forBob);
        forBob.passId = 1;
        vm.prank(alice);
        vm.expectRevert(RunRegistry.BadSignature.selector);
        reg.settle(forBob, bobSig);
        // malformed signature
        vm.prank(alice);
        vm.expectRevert(RunRegistry.BadSignature.selector);
        reg.settle(r, hex"1234");
    }

    function test_SignatureIsBoundToThisRegistryAndChain() public {
        RunRegistry other = new RunRegistry(IPlayPass(address(pass)), owner, server, operator, 3);
        vm.prank(operator);
        other.commitDailySeed(DAY, keccak256(abi.encodePacked(DAILY_SEED)));
        RunRegistry.RunResult memory r = result(1, 1, keccak256("receipt"), 2, 2000);
        (uint8 v, bytes32 rr, bytes32 s) = vm.sign(serverKey, other.hashRunResult(r));
        vm.prank(alice);
        vm.expectRevert(RunRegistry.BadSignature.selector);
        reg.settle(r, abi.encodePacked(rr, s, v));
        // and the domain carries the chain id: the same struct hashes differently on another chain
        bytes32 here = reg.hashRunResult(r);
        vm.chainId(4663);
        assertTrue(reg.hashRunResult(r) != here);
    }

    function test_OnlyThePassOwnerOrARelayerSettles() public {
        RunRegistry.RunResult memory r = result(1, 1, keccak256("receipt"), 2, 2000);
        bytes memory sig = sign(serverKey, r);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(RunRegistry.NotPassOwner.selector, bob, alice));
        reg.settle(r, sig);
        address relayer = makeAddr("relayer");
        vm.prank(owner);
        reg.setRelayer(relayer, true);
        vm.prank(relayer);
        reg.settle(r, sig);
        // a sold pass: the new owner settles, the old one cannot
        vm.prank(alice);
        pass.transferFrom(alice, bob, 2);
        RunRegistry.RunResult memory r2 = result(2, 1, keccak256("receipt 2"), 2, 2000);
        bytes memory sig2 = sign(serverKey, r2);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(RunRegistry.NotPassOwner.selector, alice, bob));
        reg.settle(r2, sig2);
        vm.prank(bob);
        reg.settle(r2, sig2);
    }

    function test_AttemptAndLayerBounds() public {
        RunRegistry.RunResult memory r0 = result(1, 0, keccak256("a"), 1, 1);
        bytes memory sig_6 = sign(serverKey, r0);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(RunRegistry.BadAttempt.selector, 0));
        reg.settle(r0, sig_6);
        RunRegistry.RunResult memory r4 = result(1, 4, keccak256("b"), 1, 1);
        bytes memory sig_7 = sign(serverKey, r4);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(RunRegistry.BadAttempt.selector, 4));
        reg.settle(r4, sig_7);
        RunRegistry.RunResult memory r9 = result(1, 1, keccak256("c"), 9, 1);
        bytes memory sig_8 = sign(serverKey, r9);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(RunRegistry.BadLayers.selector, 9));
        reg.settle(r9, sig_8);
    }

    function test_SettleNeedsACommittedDay() public {
        RunRegistry.RunResult memory r = RunRegistry.RunResult(1, DAY + 1, 1, keccak256("x"), 1, 1);
        bytes memory sig_9 = sign(serverKey, r);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(RunRegistry.NotCommitted.selector, DAY + 1));
        reg.settle(r, sig_9);
    }

    function test_ServerSignerRotation() public {
        RunRegistry.RunResult memory r = result(1, 1, keccak256("receipt"), 2, 2000);
        bytes memory oldSig = sign(serverKey, r);
        uint256 newKey = 0xB0B;
        vm.prank(alice);
        vm.expectRevert();
        reg.setServerSigner(vm.addr(newKey));
        vm.prank(owner);
        reg.setServerSigner(vm.addr(newKey));
        vm.prank(alice);
        vm.expectRevert(RunRegistry.BadSignature.selector);
        reg.settle(r, oldSig);
        bytes memory sig_10 = sign(newKey, r);
        vm.prank(alice);
        reg.settle(r, sig_10);
    }

    function test_SignalFailureNeverBlocksSettle() public {
        vm.prank(owner);
        pass.setUpdater(address(reg), false); // the registry can no longer signal
        RunRegistry.RunResult memory r = result(1, 1, keccak256("receipt"), 2, 2000);
        bytes memory sig_11 = sign(serverKey, r);
        vm.expectEmit(true, false, false, false, address(reg));
        emit RunRegistry.PassSignalFailed(1);
        vm.prank(alice);
        reg.settle(r, sig_11);
        assertEq(reg.runsSettled(1), 1);
    }

    // --------------------------------------------------------------- seeds

    function test_SeedCommitAndReveal() public {
        vm.prank(alice);
        vm.expectRevert(RunRegistry.NotSeedOperator.selector);
        reg.commitDailySeed(DAY + 1, bytes32(uint256(1)));
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(RunRegistry.AlreadyCommitted.selector, DAY));
        reg.commitDailySeed(DAY, bytes32(uint256(1)));

        vm.warp(uint256(DAY) * 1 days + 12 hours); // during the day
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(RunRegistry.DayNotOver.selector, DAY));
        reg.revealDailySeed(DAY, DAILY_SEED);
        vm.warp(uint256(DAY + 1) * 1 days);
        vm.prank(operator);
        vm.expectRevert(RunRegistry.SeedMismatch.selector);
        reg.revealDailySeed(DAY, keccak256("wrong"));
        vm.prank(operator);
        reg.revealDailySeed(DAY, DAILY_SEED);
        assertEq(reg.seedOf(DAY), DAILY_SEED);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(RunRegistry.AlreadyRevealed.selector, DAY));
        reg.revealDailySeed(DAY, DAILY_SEED);
    }

    /// The run server commits keccak256 of the 32 raw seed bytes; this is the same value.
    function test_CommitFormatMatchesTheRunServer() public pure {
        bytes32 seed = 0x1111111111111111111111111111111111111111111111111111111111111111;
        assertEq(keccak256(abi.encodePacked(seed)), 0xb569321de72d0af89c2fb48a484de3fc9343f31600ae1f3e13d633cb48cbf816);
    }
}
