// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

interface IPlayPass {
    function ownerOf(uint256 tokenId) external view returns (address);
    function passUpdate(uint256 tokenId) external;
}

/// @title RunRegistry
/// @notice Ranked results on chain (BUILD_SPEC section 5 and 6).
///
///  - The seed operator commits keccak256(dailySeed) for each UTC day and
///    reveals the seed after the day ends. The run server's commitments are
///    keccak256 of the 32 seed bytes, the same value checked here.
///  - The run server signs an EIP-712 RunResult when a ranked run bound to a
///    pass ends. The pass owner (or an approved relayer) submits it with
///    `settle`. Each (pass, day, attempt) and each receipt settles once.
///  - Best result per pass, per day and all time: more layers wins, then the
///    bigger bankroll.
///  - Settling signals the pass contract so wallet cards refresh. A failing
///    signal never blocks the settle.
///
///  No payouts, entries or prizes live here.
contract RunRegistry is Ownable, EIP712 {
    struct RunResult {
        uint256 passId;
        uint32 day; // UTC days since 1970-01-01
        uint8 attempt; // 1-based, per pass per day
        bytes32 receiptHash; // keccak256 of the canonical receipt JSON
        uint8 layers; // 0 to 8
        uint64 bankCents; // final bankroll in cents
    }

    struct Best {
        uint8 layers;
        uint64 bankCents;
        uint32 day;
        bytes32 receiptHash;
    }

    bytes32 public constant RUN_RESULT_TYPEHASH = keccak256(
        "RunResult(uint256 passId,uint32 day,uint8 attempt,bytes32 receiptHash,uint8 layers,uint64 bankCents)"
    );
    uint8 public constant MAX_LAYERS = 8;

    IPlayPass public immutable pass;
    address public serverSigner;
    address public seedOperator;
    uint8 public maxAttemptsPerDay;

    mapping(uint32 day => bytes32) public seedCommit;
    mapping(uint32 day => bytes32) public seedOf;
    mapping(bytes32 receiptHash => bool) public receiptSettled;
    mapping(uint256 passId => mapping(uint32 day => uint256 bitmap)) private _attemptsUsed;
    mapping(uint256 passId => Best) public bestOf;
    mapping(uint256 passId => mapping(uint32 day => Best)) public bestOfDay;
    mapping(uint256 passId => uint32) public runsSettled;
    mapping(address => bool) public relayers;

    event ServerSignerSet(address indexed signer);
    event SeedOperatorSet(address indexed operator);
    event RelayerSet(address indexed relayer, bool allowed);
    event MaxAttemptsSet(uint8 maxAttempts);
    event DailySeedCommitted(uint32 indexed day, bytes32 commit);
    event DailySeedRevealed(uint32 indexed day, bytes32 seed);
    event RunSettled(
        uint256 indexed passId, uint32 indexed day, uint8 attempt, bytes32 receiptHash, uint8 layers, uint64 bankCents, bool newBest
    );
    event PassSignalFailed(uint256 indexed passId);

    error NotSeedOperator();
    error AlreadyCommitted(uint32 day);
    error NotCommitted(uint32 day);
    error SeedMismatch();
    error DayNotOver(uint32 day);
    error AlreadyRevealed(uint32 day);
    error BadSignature();
    error AttemptUsed(uint256 passId, uint32 day, uint8 attempt);
    error ReceiptUsed(bytes32 receiptHash);
    error BadAttempt(uint8 attempt);
    error BadLayers(uint8 layers);
    error NotPassOwner(address caller, address owner);
    error ZeroAddress();

    constructor(IPlayPass pass_, address owner_, address serverSigner_, address seedOperator_, uint8 maxAttemptsPerDay_)
        Ownable(owner_)
        EIP712("ExitLiquidityRunRegistry", "1")
    {
        if (address(pass_) == address(0) || serverSigner_ == address(0) || seedOperator_ == address(0)) revert ZeroAddress();
        pass = pass_;
        serverSigner = serverSigner_;
        seedOperator = seedOperator_;
        maxAttemptsPerDay = maxAttemptsPerDay_;
        emit ServerSignerSet(serverSigner_);
        emit SeedOperatorSet(seedOperator_);
        emit MaxAttemptsSet(maxAttemptsPerDay_);
    }

    // ---------------------------------------------------------------- owner

    /// @notice Rotate the run server's signing key. Results signed by the old key stop settling.
    function setServerSigner(address signer) external onlyOwner {
        if (signer == address(0)) revert ZeroAddress();
        serverSigner = signer;
        emit ServerSignerSet(signer);
    }

    function setSeedOperator(address operator) external onlyOwner {
        if (operator == address(0)) revert ZeroAddress();
        seedOperator = operator;
        emit SeedOperatorSet(operator);
    }

    function setRelayer(address relayer, bool allowed) external onlyOwner {
        relayers[relayer] = allowed;
        emit RelayerSet(relayer, allowed);
    }

    function setMaxAttemptsPerDay(uint8 maxAttempts) external onlyOwner {
        maxAttemptsPerDay = maxAttempts;
        emit MaxAttemptsSet(maxAttempts);
    }

    // ---------------------------------------------------------------- seeds

    function commitDailySeed(uint32 day, bytes32 commit) external {
        if (msg.sender != seedOperator) revert NotSeedOperator();
        if (seedCommit[day] != bytes32(0)) revert AlreadyCommitted(day);
        seedCommit[day] = commit;
        emit DailySeedCommitted(day, commit);
    }

    /// @notice Publish a day's seed once the day is over. Anyone can then verify every receipt of that day.
    function revealDailySeed(uint32 day, bytes32 seed) external {
        if (msg.sender != seedOperator) revert NotSeedOperator();
        bytes32 c = seedCommit[day];
        if (c == bytes32(0)) revert NotCommitted(day);
        if (seedOf[day] != bytes32(0)) revert AlreadyRevealed(day);
        if (block.timestamp < (uint256(day) + 1) * 1 days) revert DayNotOver(day);
        if (keccak256(abi.encodePacked(seed)) != c) revert SeedMismatch();
        seedOf[day] = seed;
        emit DailySeedRevealed(day, seed);
    }

    // --------------------------------------------------------------- settle

    function hashRunResult(RunResult calldata r) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(abi.encode(RUN_RESULT_TYPEHASH, r.passId, r.day, r.attempt, r.receiptHash, r.layers, r.bankCents))
        );
    }

    function attemptUsed(uint256 passId, uint32 day, uint8 attempt) public view returns (bool) {
        return attempt < 256 && (_attemptsUsed[passId][day] >> attempt) & 1 == 1;
    }

    function settle(RunResult calldata r, bytes calldata signature) external returns (bool newBest) {
        address owner_ = pass.ownerOf(r.passId); // reverts for a pass that does not exist
        if (msg.sender != owner_ && !relayers[msg.sender]) revert NotPassOwner(msg.sender, owner_);
        if (r.attempt == 0 || r.attempt > maxAttemptsPerDay) revert BadAttempt(r.attempt);
        if (r.layers > MAX_LAYERS) revert BadLayers(r.layers);
        if (seedCommit[r.day] == bytes32(0)) revert NotCommitted(r.day);
        if (attemptUsed(r.passId, r.day, r.attempt)) revert AttemptUsed(r.passId, r.day, r.attempt);
        if (receiptSettled[r.receiptHash]) revert ReceiptUsed(r.receiptHash);
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(hashRunResult(r), signature);
        if (err != ECDSA.RecoverError.NoError || signer != serverSigner) revert BadSignature();

        _attemptsUsed[r.passId][r.day] |= uint256(1) << r.attempt;
        receiptSettled[r.receiptHash] = true;
        runsSettled[r.passId] += 1;

        Best storage day = bestOfDay[r.passId][r.day];
        if (_better(r.layers, r.bankCents, day) || day.receiptHash == bytes32(0)) {
            bestOfDay[r.passId][r.day] = Best(r.layers, r.bankCents, r.day, r.receiptHash);
        }
        Best storage all = bestOf[r.passId];
        newBest = _better(r.layers, r.bankCents, all) || all.receiptHash == bytes32(0);
        if (newBest) bestOf[r.passId] = Best(r.layers, r.bankCents, r.day, r.receiptHash);

        emit RunSettled(r.passId, r.day, r.attempt, r.receiptHash, r.layers, r.bankCents, newBest);
        try pass.passUpdate(r.passId) {} catch {
            emit PassSignalFailed(r.passId);
        }
    }

    function _better(uint8 layers, uint64 bankCents, Best storage b) private view returns (bool) {
        return layers > b.layers || (layers == b.layers && bankCents > b.bankCents);
    }
}
