// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {ERC721WalletPass} from "@erc8426/contracts/src/ERC721WalletPass.sol";

/// @dev Arbitrum precompile. On Robinhood Chain (an Arbitrum Nitro chain)
///  `block.number` is an estimate of the L1 block number and `prevrandao` is a
///  constant, so L2 block numbers and hashes come from here.
interface IArbSys {
    function arbBlockNumber() external view returns (uint256);
    function arbBlockHash(uint256 arbBlockNum) external view returns (bytes32);
}

/// @title PlayPass
/// @notice The Exit Liquidity pass: an ERC-721 with the ERC-8426 wallet pass
///  extension, modeled on the SDK's MembershipPass example.
///
///  Founder passes (token ids 1 to 2222): payable mint, at most 3 per wallet,
///  never expire. Each gets one of six styles, assigned at random only after
///  the sale has closed, through a fixed shuffled list committed at deploy
///  and an offset nobody can choose:
///
///   1. Deploy: the shuffled list is stored and checked against the caps;
///      its hash is public before the sale.
///   2. Before the sale opens the owner commits keccak256(secret).
///   3. The sale closes (by the owner, or by selling out).
///   4. The owner reveals the secret. That fixes a future L2 block,
///      REVEAL_DELAY blocks ahead, whose hash nobody knows yet.
///   5. After that block, anyone finalizes: offset =
///      keccak256(secret, blockhash, this) mod 2222. Token n's style is
///      list[(n - 1 + offset) mod 2222]. One BatchPassUpdate refreshes every
///      card.
///
///  The owner knows the secret but not the block hash when it commits to
///  using it, so the owner cannot steer styles either. A minter knows neither
///  while the sale is open.
///
///  Seasonal passes (ids from 100001), for later: owner granted, expire, and
///  can be renewed for a price per period, like MembershipPass. Every season
///  price starts at zero, which means "not for sale".
///
/// @dev ERC-8426 capability analysis: nothing in this contract is reachable
///  from a pass link. `mint` and `renew` are paid by the caller's own wallet
///  (signed path), and transfer, approve and burn stay with the holder. The
///  only pass state written by others is the PassUpdate signal, through the
///  updater role (the RunRegistry), which changes nothing but freshness.
contract PlayPass is ERC721WalletPass, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------- config

    uint256 public constant FOUNDER_SUPPLY = 2222;
    uint256 public constant MAX_PER_WALLET = 3;

    uint8 public constant CLASSIC = 0;
    uint8 public constant NEON = 1;
    uint8 public constant FOUNDERS_GOLD = 2;
    uint8 public constant BLOOD_MOON = 3;
    uint8 public constant GHOST = 4;
    uint8 public constant GLITCH = 5;
    uint8 public constant STYLE_COUNT = 6;
    /// @notice What `styleOf` returns for a founder pass before the reveal.
    uint8 public constant UNREVEALED = 255;

    /// @notice L2 blocks between the secret reveal and the block whose hash is used.
    uint256 public constant REVEAL_DELAY = 20;
    /// @notice Blocks after the reveal block in which finalizing is possible
    ///  (block hashes are available for 256 blocks).
    uint256 public constant REVEAL_WINDOW = 200;

    uint256 public constant SEASONAL_ID_START = 100_001;
    uint64 public constant PERIOD = 30 days;

    /// @notice ERC-20 used for the mint price, or address(0) for native ETH. Fixed at deploy.
    IERC20 public immutable paymentToken;
    /// @notice True on Arbitrum chains (Robinhood Chain); false only on a local dev chain.
    bool public immutable useArbSys;
    /// @notice keccak256 of the 2222 byte founder style list.
    bytes32 public immutable styleListHash;

    IArbSys private constant ARBSYS = IArbSys(address(0x64));

    // ----------------------------------------------------------------- state

    enum Sale {
        NotStarted,
        Open,
        Closed
    }

    Sale public sale;
    uint256 public price;
    uint256 public foundersMinted;
    mapping(address => uint256) public foundersMintedBy;

    bytes private _styleList;
    bytes32 public styleSecretCommit;
    bytes32 public styleSecret;
    uint256 public revealBlock;
    bool public revealed;
    uint256 public styleOffset;

    mapping(address => bool) public updaters;

    struct Seasonal {
        uint8 kind;
        uint8 style;
        uint64 expiresAt;
    }

    mapping(uint256 => Seasonal) private _seasonal;
    mapping(uint8 kind => uint256) public seasonPricePerPeriod;
    uint256 private _nextSeasonalId = SEASONAL_ID_START;

    // ---------------------------------------------------------------- events

    event StyleListCommitted(bytes32 listHash);
    event StyleSecretCommitted(bytes32 commit);
    event SaleOpened();
    event SaleClosed(uint256 minted);
    event StyleSecretRevealed(bytes32 secret, uint256 revealBlock);
    event StylesRevealed(uint256 offset, bytes32 blockHash, uint256 revealBlock);
    event RevealRearmed(uint256 revealBlock);
    event PriceSet(uint256 price);
    event UpdaterSet(address indexed account, bool allowed);
    event SeasonPriceSet(uint8 indexed kind, uint256 pricePerPeriod);
    event Renewed(uint256 indexed tokenId, address indexed payer, uint64 expiresAt);

    error BadStyleList();
    error SaleNotOpen();
    error SaleNotStarted();
    error SaleNotClosed();
    error SoldOut();
    error WalletLimit(uint256 alreadyMinted, uint256 requested);
    error BadQuantity();
    error PriceChanged(uint256 current, uint256 expected);
    error WrongPayment(uint256 expected, uint256 received);
    error NoSecretCommitted();
    error SecretAlreadyCommitted();
    error SecretMismatch();
    error SecretNotRevealed();
    error AlreadyRevealed();
    error TooEarly(uint256 currentBlock, uint256 neededAfter);
    error WindowOpen();
    error WindowMissed();
    error NotUpdater();
    error FounderNeverExpires();
    error NotForSale(uint8 kind);
    error BadKind();

    constructor(
        string memory passBaseURI_,
        address initialOwner,
        IERC20 paymentToken_,
        uint256 price_,
        bytes memory styleList_,
        bool useArbSys_
    ) ERC721("Exit Liquidity Pass", "EXITPASS") ERC721WalletPass(passBaseURI_) Ownable(initialOwner) {
        if (styleList_.length != FOUNDER_SUPPLY) revert BadStyleList();
        uint256[6] memory caps = [uint256(800), 500, 72, 400, 300, 150];
        uint256[6] memory seen;
        for (uint256 i = 0; i < FOUNDER_SUPPLY; ++i) {
            uint8 s = uint8(styleList_[i]);
            if (s >= STYLE_COUNT) revert BadStyleList();
            ++seen[s];
        }
        for (uint256 s = 0; s < STYLE_COUNT; ++s) {
            if (seen[s] != caps[s]) revert BadStyleList();
        }
        _styleList = styleList_;
        styleListHash = keccak256(styleList_);
        paymentToken = paymentToken_;
        useArbSys = useArbSys_;
        price = price_;
        emit StyleListCommitted(styleListHash);
        emit PriceSet(price_);
    }

    // ------------------------------------------------------------ owner: sale

    function setPrice(uint256 newPrice) external onlyOwner {
        price = newPrice;
        emit PriceSet(newPrice);
    }

    /// @notice Commit keccak256(secret) for the style reveal. Required before the sale opens; cannot change.
    function commitStyleSecret(bytes32 commit) external onlyOwner {
        if (styleSecretCommit != bytes32(0)) revert SecretAlreadyCommitted();
        if (commit == bytes32(0)) revert NoSecretCommitted();
        styleSecretCommit = commit;
        emit StyleSecretCommitted(commit);
    }

    function openSale() external onlyOwner {
        if (sale != Sale.NotStarted) revert SaleNotOpen();
        if (styleSecretCommit == bytes32(0)) revert NoSecretCommitted();
        sale = Sale.Open;
        emit SaleOpened();
    }

    /// @notice End the founder sale for good. Selling out closes it too.
    function closeSale() external onlyOwner {
        if (sale != Sale.Open) revert SaleNotOpen();
        _close();
    }

    function setUpdater(address account, bool allowed) external onlyOwner {
        updaters[account] = allowed;
        emit UpdaterSet(account, allowed);
    }

    function setPassBaseURI(string calldata newBase) external onlyOwner {
        _setPassBaseURI(newBase);
    }

    /// @notice Send collected mint and renewal proceeds to `to`.
    function withdraw(address payable to) external onlyOwner nonReentrant {
        if (address(paymentToken) != address(0)) {
            paymentToken.safeTransfer(to, paymentToken.balanceOf(address(this)));
        }
        if (address(this).balance > 0) Address.sendValue(to, address(this).balance);
    }

    // -------------------------------------------------------------- mint

    /// @notice Mint `quantity` founder passes to the caller.
    /// @param expectedUnitPrice The price the caller agreed to; protects against a price change landing first.
    function mint(uint256 quantity, uint256 expectedUnitPrice) external payable nonReentrant {
        if (sale != Sale.Open) revert SaleNotOpen();
        if (quantity == 0) revert BadQuantity();
        if (expectedUnitPrice != price) revert PriceChanged(price, expectedUnitPrice);
        uint256 already = foundersMintedBy[msg.sender];
        if (already + quantity > MAX_PER_WALLET) revert WalletLimit(already, quantity);
        uint256 first = foundersMinted + 1;
        if (foundersMinted + quantity > FOUNDER_SUPPLY) revert SoldOut();

        uint256 total = price * quantity;
        if (address(paymentToken) == address(0)) {
            if (msg.value != total) revert WrongPayment(total, msg.value);
        } else {
            if (msg.value != 0) revert WrongPayment(0, msg.value);
            paymentToken.safeTransferFrom(msg.sender, address(this), total);
        }

        foundersMintedBy[msg.sender] = already + quantity;
        foundersMinted += quantity;
        for (uint256 id = first; id < first + quantity; ++id) {
            _safeMint(msg.sender, id);
        }
        if (foundersMinted == FOUNDER_SUPPLY) _close();
    }

    function _close() private {
        sale = Sale.Closed;
        emit SaleClosed(foundersMinted);
    }

    // ------------------------------------------------------------ reveal

    /// @notice Step 4. Reveal the committed secret, which fixes a future block whose hash is mixed in.
    ///  Callable by anyone who knows the secret.
    function revealStyleSecret(bytes32 secret) external {
        if (sale != Sale.Closed) revert SaleNotClosed();
        if (styleSecret != bytes32(0)) revert AlreadyRevealed();
        if (keccak256(abi.encodePacked(secret)) != styleSecretCommit) revert SecretMismatch();
        styleSecret = secret;
        revealBlock = _l2BlockNumber() + REVEAL_DELAY;
        emit StyleSecretRevealed(secret, revealBlock);
    }

    /// @notice Step 5. Anyone can finalize once the reveal block is in the past.
    function finalizeStyles() external {
        if (styleSecret == bytes32(0)) revert SecretNotRevealed();
        if (revealed) revert AlreadyRevealed();
        uint256 current = _l2BlockNumber();
        if (current <= revealBlock) revert TooEarly(current, revealBlock);
        if (current > revealBlock + REVEAL_WINDOW) revert WindowMissed();
        bytes32 h = _l2BlockHash(revealBlock);
        if (h == bytes32(0)) revert WindowMissed();
        styleOffset = uint256(keccak256(abi.encode(styleSecret, h, address(this)))) % FOUNDER_SUPPLY;
        revealed = true;
        emit StylesRevealed(styleOffset, h, revealBlock);
        if (foundersMinted > 0) _batchPassUpdate(1, foundersMinted);
    }

    /// @notice If nobody finalized inside the window, anyone can pick a new reveal block.
    ///  The secret is already public by then, so this hands nobody a choice
    ///  unless every party let the whole window pass.
    function rearmReveal() external {
        if (styleSecret == bytes32(0)) revert SecretNotRevealed();
        if (revealed) revert AlreadyRevealed();
        if (_l2BlockNumber() <= revealBlock + REVEAL_WINDOW) revert WindowOpen();
        revealBlock = _l2BlockNumber() + REVEAL_DELAY;
        emit RevealRearmed(revealBlock);
    }

    function _l2BlockNumber() internal view virtual returns (uint256) {
        return useArbSys ? ARBSYS.arbBlockNumber() : block.number;
    }

    function _l2BlockHash(uint256 n) internal view virtual returns (bytes32) {
        return useArbSys ? ARBSYS.arbBlockHash(n) : blockhash(n);
    }

    // ------------------------------------------------------- updater role

    /// @notice Signal that pass content for `tokenId` changed (for example a ranked result was settled).
    function passUpdate(uint256 tokenId) external {
        if (!updaters[msg.sender] && msg.sender != owner()) revert NotUpdater();
        _requireOwned(tokenId);
        _passUpdate(tokenId);
    }

    // ------------------------------------------------------ seasonal passes

    function setSeasonPrice(uint8 kind, uint256 pricePerPeriod) external onlyOwner {
        if (kind == 0) revert BadKind();
        seasonPricePerPeriod[kind] = pricePerPeriod;
        emit SeasonPriceSet(kind, pricePerPeriod);
    }

    /// @notice Grant a seasonal pass of `kind` (1 or more) lasting `duration` seconds.
    function grantSeasonal(address to, uint8 kind, uint8 style, uint64 duration) external onlyOwner returns (uint256 tokenId) {
        if (kind == 0 || style >= STYLE_COUNT) revert BadKind();
        tokenId = _nextSeasonalId++;
        _seasonal[tokenId] = Seasonal(kind, style, uint64(block.timestamp) + duration);
        _safeMint(to, tokenId);
    }

    /// @notice Pay for more periods of a seasonal pass, in ETH. Founder passes never expire and cannot be renewed.
    function renew(uint256 tokenId, uint64 periods) external payable {
        _requireOwned(tokenId);
        if (isFounder(tokenId)) revert FounderNeverExpires();
        if (periods == 0) revert BadQuantity();
        Seasonal storage s = _seasonal[tokenId];
        uint256 per = seasonPricePerPeriod[s.kind];
        if (per == 0) revert NotForSale(s.kind);
        uint256 expected = per * periods;
        if (msg.value != expected) revert WrongPayment(expected, msg.value);
        uint64 from = s.expiresAt > block.timestamp ? s.expiresAt : uint64(block.timestamp);
        s.expiresAt = from + PERIOD * periods;
        emit Renewed(tokenId, msg.sender, s.expiresAt);
        _passUpdate(tokenId);
    }

    // ------------------------------------------------------------- views

    function isFounder(uint256 tokenId) public pure returns (bool) {
        return tokenId >= 1 && tokenId <= FOUNDER_SUPPLY;
    }

    /// @notice Style id (0 to 5), or UNREVEALED for a founder pass before the reveal.
    function styleOf(uint256 tokenId) public view returns (uint8) {
        _requireOwned(tokenId);
        if (!isFounder(tokenId)) return _seasonal[tokenId].style;
        if (!revealed) return UNREVEALED;
        return uint8(_styleList[(tokenId - 1 + styleOffset) % FOUNDER_SUPPLY]);
    }

    /// @notice 0 means never expires (every founder pass).
    function expiresAt(uint256 tokenId) public view returns (uint64) {
        _requireOwned(tokenId);
        return isFounder(tokenId) ? 0 : _seasonal[tokenId].expiresAt;
    }

    function isActive(uint256 tokenId) external view returns (bool) {
        uint64 e = expiresAt(tokenId);
        return e == 0 || block.timestamp < e;
    }

    function passKind(uint256 tokenId) external view returns (uint8) {
        _requireOwned(tokenId);
        return isFounder(tokenId) ? 0 : _seasonal[tokenId].kind;
    }

    /// @notice The committed founder style list (2222 bytes, one style id per position).
    function styleList() external view returns (bytes memory) {
        return _styleList;
    }
}
