# Exit Liquidity: build spec

A roguelite where you trade memecoin charts to escape a simulation. Balatro and CloverPit are the references for feel: short runs, escalating targets, rule-bending power-ups, heavy juice. This spec takes the single-file prototype (`index.html`, shipped alongside this file) to a real product with an on-chain backend on Robinhood Chain and a play pass built on ERC-8426.

Status of this document: first draft, written before any repo exists. Sections marked UNVERIFIED must be checked against primary sources before code depends on them.

## 1. What exists today

`index.html` is a complete, playable prototype. Everything is client side.

- **Core loop.** 8 layers. Each layer is one memecoin, a 45 second session, and an equity target (a percentage gain on the bankroll you bring in). Miss the target and the run ends.
- **Market model.** `stepMarket()` advances one 100ms tick. Price is `p0 * exp(lf + dev)`, where `lf` is a fair value random walk with event drift and `dev` is a mean-reverting deviation. Events (pump, dump, dip, spike, rug) are announced by a headline about 1.2 seconds before they start. A share of headlines per level are fake.
- **Trading.** All in, all out. 0.5% fee per side. Winning trades in a row build a streak multiplier that pays a bonus on profit.
- **Power-ups.** 23 indicators (passive, 5 slots), 5 items (one use, 2 slots), bought with alpha between layers. Three indicators are cursed.
- **Meta.** One indicator can be "minted" at run end and joins the next 3 runs. Stored in localStorage as a stand-in for an NFT.
- **Determinism.** All market and shop randomness comes from `mulberry32(seed)`. The end screen exports a receipt: `{game, v, seed, mint, log, result}` where `log` is every input as `[layerIndex, tick, code]`.

The code between `/*CORE-START*/` and `/*CORE-END*/` is the market engine and level table. Treat the prototype as the reference for game rules. Port behavior from it, do not redesign it.

## 2. Target architecture

```
Player phone/browser
  |  WebSocket (ranked)            |  wallet (viem)
  v                                v
Run server  ---- signs results --> RunRegistry (contract)
  |  same engine package            |
Verifier CLI (anyone can run)      PlayPass (ERC-721 + ERC-8426)
  |                                 Indicators (ERC-1155)
Pass issuer (ERC-8426 manifest,     Tournament (entries, payouts)
Apple/Google pass signing, push)
```

Two play modes:

- **Practice.** Runs fully in the client with a local seed, exactly like the prototype. No pass needed. Nothing is recorded.
- **Ranked.** Server authoritative. The client never knows the seed and never computes prices. It renders ticks streamed from the server and sends inputs. This is required because a client that holds the seed can compute the entire future chart.

## 3. Repo layout

```
packages/engine      Pure TypeScript. Market, trading, power-ups, shop, replay. No DOM, no Date, no Math.random.
apps/web             Client. Renders, plays practice locally via engine, plays ranked via WebSocket.
apps/server          Run server (WebSocket), verifier CLI, pass issuer endpoints.
contracts            Foundry. PlayPass, RunRegistry, Indicators, Tournament.
```

## 4. Engine package

Extract all game rules from `index.html` into `packages/engine`:

- `createRun(seed, mintedIndicator)`, `applyInput(state, input)`, `tick(state)`, `replay(receipt) -> result`.
- State must be plain data and serializable.
- Every rule currently living in UI functions (`openPos`, `closePos`, `useCons`, `endLevel`, `prepLevel`, `rollOffers`) moves into the engine. The UI only reads state and dispatches inputs.

**Float determinism (important).** The prototype uses `Math.exp`, `Math.log`, `Math.cos`, and `Math.sqrt`. `sqrt` is exactly specified. `exp`, `log`, and `cos` are implementation defined and can differ in the last bits between JS engines, and the market compounds those differences. Options:

1. Ranked mode only ever computes on the server and the verifier, both pinned to one Node version. Simple. Verification then depends on that Node version.
2. Implement `exp`, `log`, and `cos` inside the engine with fixed algorithms so replay is bit-identical everywhere. More work, portable forever.

Recommendation: start with option 1, write the engine so the math functions are injected, and move to option 2 before any prize money is live.

**Golden tests.** Record 20 receipts from the prototype rules and assert `replay()` reproduces the exact final bankroll. Add a property test: random input logs never produce NaN, negative cash, or a position without margin.

## 5. Ranked run protocol

1. Before each UTC day, the operator posts `commitDailySeed(day, keccak256(dailySeed))` on chain.
2. A ranked run for pass `id` on `day` uses `runSeed = keccak256(dailySeed, id, attemptNumber)` truncated to 32 bits for `mulberry32` (or widen the PRNG, see open decisions). Per-pass seeds stop players from sharing "pump at second 12" for the day.
3. Client opens a WebSocket and proves pass ownership with a signed message. Server checks `ownerOf(id)`.
4. Server streams ticks (price, headline if any). Client sends inputs. The server stamps each input with the tick at which it arrived. That stamped log is the receipt.
5. At run end the server signs an EIP-712 `RunResult {passId, day, attempt, receiptHash, layers, bank}`. The player (or a relayer) submits it to `RunRegistry.settle`.
6. After the day closes, the operator calls `revealDailySeed(day, dailySeed)`. Receipts are published (S3, IPFS, or similar). Anyone can now run the verifier and check every result.
7. Payouts unlock after a challenge window. A successful challenge (a published receipt that does not replay to the signed result) voids that result. Who can slash what is an open decision.

Attempts per pass per day are capped (suggest 1 for tournaments, more for casual ranked).

## 6. Contracts (Foundry, Solidity 0.8.x)

**PlayPass.sol**
- ERC-721 plus the ERC-8426 wallet pass extension. Use the reference contracts from the `@erc8426` SDK rather than hand-rolling the interface.
- `mint()` payable. Price and supply set by owner. Optional season id per token.
- Emits the standard's pass update event whenever a pass's displayed data changes (run settled, indicator minted, charges burned). `RunRegistry` is authorized to trigger it.
- Pass face content (served by the issuer, not stored on chain): best layer, runs played, current minted indicator and charges, today's tournament status.

**RunRegistry.sol**
- `commitDailySeed(day, hash)` and `revealDailySeed(day, seed)`, operator only, with a check that the reveal matches the commit.
- `settle(RunResult, signature)`. Verifies the server signer, that the caller owns the pass or is a relayer, and that the attempt is unused. Stores best result per pass per day and all-time best. Emits `RunSettled`.
- Rotatable server signer.

**Indicators.sol**
- ERC-1155. Token id = indicator id from the engine table.
- `mintFromRun(passId, indicatorId)`, callable once per settled run, only for an indicator the receipt shows the player held at run end (the server attests this inside `RunResult`).
- Mint gives 3 units. Starting a ranked run with a minted indicator burns 1 unit (burn is included in the settle call so the player signs one transaction per run, not two).
- Transferable, so there is a market for them.

**Tournament.sol**
- `enter(day, passId)` payable, one entry per pass per day.
- After reveal plus challenge window, `finalize(day)` pays the top N by `layers` then `bank`. Fee split to treasury.
- Ship this last. See section 9 on legal exposure.

## 7. Server

- **Run server.** Node, WebSocket. Holds daily seeds in a KMS or equivalent. Runs `packages/engine`. One process can hold many runs since each tick is trivial work.
- **Verifier CLI.** `verify <receipt.json> <dailySeed>` prints the result and exits nonzero on mismatch. Same engine package. Publish it so third parties can run it.
- **Pass issuer.** Implements the ERC-8426 manifest and owner-proof endpoints and signs Apple and Google Wallet passes. Requires an Apple Developer account with a Pass Type ID certificate and a Google Wallet issuer account. Listens for chain events and pushes pass refreshes.

## 8. Cheating and bots

- **Seed foresight.** Solved by server authority plus commit and reveal.
- **Headline bots.** A script that buys on pump headlines and sells on dump headlines clears layer 1 about 90% of the time in simulation with no power-ups, and it never gets tired. With prizes, bots will enter. Mitigations to evaluate: one pass per entry with a meaningful pass price, attempt caps, headline text rendered so it needs reading (not a typed enum in the stream), input timing analysis, and prize structures that reward deep runs where build decisions matter more than reflexes. This is not solved. Treat it as the main design risk for paid tournaments.
- **Multi-accounting.** Pass price is the sybil cost. Consider one tournament entry per pass per day and holding periods before a transferred pass can enter.

## 9. Things to settle before money is involved

- Paid entry plus prizes is treated as gambling in some jurisdictions even when the game is skill based. Get a legal read before `Tournament.sol` goes to mainnet. Practice mode, ranked leaderboards, and the pass itself do not depend on it.
- Steam does not carry blockchain games (policy since 2021, recheck). Distribution is web first.

## 10. Milestones

- **M0 Engine.** Extract engine, golden tests, practice mode in `apps/web` running on the engine with the prototype's look. Exit test: the web app plays identically to `index.html`.
- **M1 Ranked off chain.** Run server, WebSocket protocol, stamped receipts, verifier CLI, a plain database leaderboard. Exit test: verifier reproduces 100% of server results over 1,000 scripted runs.
- **M2 Contracts on testnet.** PlayPass, RunRegistry, Indicators on Robinhood Chain testnet. Wallet connect, pass mint, settle flow. Exit test: full run from mint to settled result to minted indicator on testnet.
- **M3 Wallet pass.** Pass issuer, Apple and Google passes, refresh on settle. Exit test: the SDK's conformance suite passes and a settled run updates the card on a real phone.
- **M4 Tournaments.** Daily seed commit and reveal automation, Tournament contract, challenge window. Testnet only until the legal read is done.
- **M5 Launch prep.** List every third-party service the app uses and what data each collects. Draft the privacy policy and terms of service from that list. Add a delete-my-account flow (off-chain data: receipts linked to an account, any email or push token used for passes). Audit the frontend bundle for exposed API keys. Contract audit before mainnet.

## 11. Open decisions

1. Daily seed shared by everyone (pure leaderboard, but chart knowledge leaks during the day) or derived per pass (leak proof, but players see different charts). This spec assumes per pass.
2. Pass model: one-time purchase, or seasonal passes that expire.
3. Whether minted indicators work in tournaments or only in casual ranked. Allowing them makes tournaments partly pay to win.
4. PRNG width. `mulberry32` has 32 bits of state, which is fine for gameplay but small enough to brute force a seed from a few observed ticks. Ranked mode should move to a 128 bit or wider generator (for example xoshiro256**) seeded from the full keccak hash.
5. Who can challenge a result and what happens to the operator if the server signed a bad one.
6. Relayer and gas sponsorship so players do not need ETH for every settle.

## 12. Verified 2026-11-13 (was: UNVERIFIED)

Checked against the ERC-8426 text (ethereum/ERCs `ERCS/erc-8426.md`), the SDK source at `github.com/huntclubhero/erc8426-sdk` (commit faf0cb2) and docs.robinhood.com/chain. Details in `docs/M2-pass.md`.

- Correct: ERC-8426 is "Wallet Pass Extension for NFTs", Draft, requires 165, 721, 1271, 4361, 6492.
- Correct: `passURI(tokenId)` (reverts for an invalid token), `supportsInterface(0xef5f1e71)`, events `PassUpdate(uint256 indexed)` and `BatchPassUpdate(uint256, uint256)` with an inclusive range.
- Refined: a gated manifest answers 401 `{ error: "proof_required", challenge }` and no URLs. The challenge must carry token (CAIP-19), action, single-use nonce, expiry, verifier and account; ERC-4361 is the RECOMMENDED serialization, not a requirement. Acquisition URLs rotate on an observed transfer or the new owner's first claim (not synchronously); in between, the fresh `ownerOf` read at `latest` is what refuses the previous owner.
- Correct: optional `IERC721WalletPassIssuer`, `passIssuer()`, id `0x470be7e9`.
- Correct: npm scope `@erc8426` (contracts 0.3.0, issuer, client, google, apple, react, conformance 0.4.0), MIT. Not in the summary: `createIssuer` refuses to start without at least one format provider.
- Corrected: `eip155:4663` is Robinhood Chain **mainnet**. The **testnet is chain id 46630**, RPC `https://rpc.testnet.chain.robinhood.com`, explorer `https://explorer.testnet.chain.robinhood.com` (official docs; `eth_chainId` answers `0xb626`).
- New, affects contracts: Robinhood Chain is an Arbitrum Nitro chain. `prevrandao` (and `block.difficulty`) is a **constant** there and must not be used for randomness, and `block.number` is an L1 estimate; L2 block numbers and hashes come from the ArbSys precompile at `0x64`.
- Section 5 step 2 is superseded: ranked seeds are the full keccak hash into xoshiro256** (no truncation), and the result carries the bankroll in cents (`bankCents`), since a float cannot go on chain.
