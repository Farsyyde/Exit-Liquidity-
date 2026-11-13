# Exit Liquidity

Roguelite, trench edition. You trade memecoin charts to escape a simulation. See `BUILD_SPEC.md` for the full plan. This repo currently covers milestones **M0 (engine)** and **M1 (ranked, off chain)**. Nothing here touches money: no wallets, passes, contracts, tournaments or payments.

```
packages/engine      Game rules as pure TypeScript. No DOM, no Date, no Math.random.
apps/web             Client. Practice runs the engine in the page; ranked plays over WebSocket.
apps/server          Run server (WebSocket + HTTP API), SQLite leaderboard, verifier CLI, bots.
reference/           The original single-file prototype, unchanged. It is the rules reference.
scripts/             Golden recording, web parity test, bundling helpers.
```

## Quick start

Node 22 and pnpm 10.

```sh
pnpm install
pnpm test              # engine golden/property tests, server and verifier tests (93 tests)
pnpm typecheck
pnpm build:web && pnpm server     # http://127.0.0.1:8787 serves the game and the ranked API
pnpm dev:web           # Vite dev server, proxies /api and /ws to the run server
```

Exit tests:

```sh
pnpm parity            # M0: web app replays 66 prototype runs through the real UI, 66/66 must match
pnpm m1:exit           # M1: 1,000 scripted ranked runs, then the verifier CLI checks every one
pnpm golden:record     # re-record golden receipts from reference/prototype.html (needs Chromium)
```

Verifier:

```sh
pnpm verify run.json 0x<dailySeed> [--commit 0x..] [--signer <hex>]
pnpm verify --server http://host:8787 --day 2026-11-13 [--signer <hex>] [--commit 0x..]
pnpm verify --batch runs.jsonl
```

It exits nonzero on any mismatch.

## M0: engine

- `packages/engine` exposes `createRun(seed, mint)`, `applyInput(state, code)`, `tick(state)`, `replay(receipt)`, `receipt(state)` and `view(state)`. State is plain JSON; a JSON round trip mid run continues identically (tested).
- All rules that lived in prototype UI functions (`openPos`, `closePos`, `useCons`, `endLevel`, `prepLevel`, `rollOffers`, `tick`) are in the engine, written with the same operation order as the prototype because float results depend on it.
- Receipts keep the prototype's v2 format (`{game, v, seed, mint, log, result}`). Phase changes the prototype never logged (opening the chart, leaving the shop) are inferred during replay, as the format requires.

### Float determinism (decision taken: spec option 2 now, not later)

Measured: Chromium 153 and Node 22 disagree in the last bit on roughly 10% of `Math.exp`, `Math.log` and `Math.cos` inputs. A receipt recorded in a browser therefore does not replay bit for bit in Node, and option 1 (pin one Node version) would also break whenever that Node is upgraded.

So the engine ships `fixedMath`, a straight port of fdlibm's exp, log and cos that uses only IEEE basic operations and gives the same bits on every JS engine (within 1 ulp of the host, tested). Math is injected (`makeEngine(math, id)`):

- `engine` (default) uses fixed math. Practice and ranked both use it. Receipts carry `math: "fdlibm-js-1"`.
- `nativeEngine` uses the host's Math and reproduces the prototype bit for bit in the same browser (`?math=native` in the web app).

### Tests that pin the port to the prototype

66 runs recorded by scripted bots playing the untouched prototype in headless Chromium (oracle, headline and random styles; every indicator minted at least once; runs ending on every layer, several full clears):

| Check | Result |
|---|---|
| Prototype with fixed math (Chromium) vs engine with fixed math (Node) | 66/66 bit for bit: bank, best, credits, trades, streak, inventory, receipt |
| Prototype with native Math vs engine with native Math, both in Chromium | 66/66 bit for bit |
| Web app UI (real key presses and shop clicks) vs prototype, native Math | 66/66 identical receipts and end screens (`pnpm parity`) |
| Property test, 300 random runs with garbage inputs | no NaN, no negative cash, no position without margin; every run replays |

## M1: ranked, off chain

- **Seeds.** Each UTC day gets a 32 byte secret seed. `GET /api/commit/:day` publishes `keccak256(seed)` (today or tomorrow, so it can be recorded before the day starts). `runSeed = uint32(keccak256(dailySeed ++ uint256(player) ++ uint256(attempt)))`. The player id stands in for the pass id until M2.
- **Server authority.** The client never receives the seed before the run ends and never computes prices. It gets the public `View` (no pending events, no RNG state; fake-news flags only with Insider, the fair value line only with Fair Value) and per tick updates.
- **Stamping.** Inputs are applied the moment they arrive, so the engine logs them at the tick the server stamped. That log is the receipt.
- **Results.** At run end the server signs `{run, day, player, attempt, receiptHash, layers, bank}` with ed25519 (`receiptHash` = keccak256 of the canonical receipt). M2 swaps this for EIP-712 so `RunRegistry` can check it on chain.
- **Reveal.** `GET /api/seed/:day` and `GET /api/runs/:day` only answer after the day closes (UTC). Then anyone can run the verifier.
- **Leaving early does not help.** A disconnect, or 5 minutes idle on an intro or shop screen, plays the run out with no further input and the result counts. Otherwise players could peek at a chart and retry.
- **Identity.** A name plus a server-issued token kept in the browser. No wallet in M1.
- **Limits.** 3 ranked attempts per player per day (configurable), 40 messages per second per connection, 4 KB max message.
- **Minting.** Kept on the server as a stand-in for the ERC-1155: only an indicator held at run end, once per run, 3 charges, one charge used per ranked run.
- **Leaderboard.** `GET /api/leaderboard?day=` gives the best run per player, by layers then bank.

### Exit test result

`pnpm m1:exit` (1,000 runs, 100 concurrent bots over real WebSockets, 4 ms ticks):

```
stored 1000, verifier exit 0, "1000/1000 runs verified"
runs ending on layer 0..8: 246, 285, 201, 135, 64, 47, 7, 13, 2
39 runs abandoned mid run (finished unattended), 2,236 shop inputs, 192 mints, 48.7 s
```

The verifier runs as a separate process, fetches the revealed seed and published receipts over HTTP like an outsider would, and checks the seed against the commit recorded before the runs started.

## Open items before anything involving money (M2+)

1. **PRNG width (spec open decision 4), not done.** Ranked still uses 32 bit `mulberry32` so receipts stay compatible with the prototype. A 32 bit seed can be brute forced from the first few observed prices with a precomputed table. Move ranked to a wider generator seeded from the full hash before prizes. This changes game rules for ranked, so it needs a decision.
2. **Headline bots (spec section 8).** The tick stream includes the headline `type` field (the client uses it for the rug sound). The scripted headline bot in `apps/server/src/bot.ts` cleared layer 1 in 754 of 1,000 exit test runs. Dropping `type` from the stream is easy; the deeper mitigations are still open.
3. **Seed custody.** Daily seeds sit in SQLite in plain text. Spec section 7 wants a KMS before this matters.
4. **No reconnect.** A dropped connection ends the player's control of that run. It still plays out and counts.
5. **Signer key** is a local PEM in `apps/server/data/` (gitignored). Rotation is manual.
