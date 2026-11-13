# Exit Liquidity

Roguelite, trench edition. You trade memecoin charts to escape a simulation. See `BUILD_SPEC.md` for the full plan. This repo currently covers milestones **M0 (engine)** and **M1 (ranked, off chain)**. Nothing here touches money: no wallets, passes, contracts, tournaments or payments.

```
packages/engine      Game rules as pure TypeScript. No DOM, no Date, no Math.random.
apps/web             Client. Practice runs the engine in the page; ranked plays over WebSocket.
apps/server          Run server (WebSocket + HTTP API), SQLite leaderboard, verifier CLI, bots.
reference/           The original single-file prototype, unchanged. It is the rules reference.
scripts/             Golden recording, web parity test, bundling helpers.
```

**Branch `m2-pass`** adds the M2 pass on Robinhood Chain testnet (contracts in `contracts/`, pass server, My pass page) and the privacy work (`docs/legal/`). See `docs/M2-pass.md`. Not deployed anywhere.

## Quick start

Node 22 and pnpm 10.

```sh
pnpm install
pnpm test              # engine, server, verifier, stream audit, reconnect and secrecy tests (121 tests)
pnpm typecheck
pnpm build:web && pnpm server     # http://127.0.0.1:8787 serves the game and the ranked API
pnpm dev:web           # Vite dev server, proxies /api and /ws to the run server
```

Exit tests:

```sh
pnpm parity            # M0: web app replays 66 prototype runs through the real UI, 66/66 must match
pnpm m1:exit           # M1: 1,000 scripted ranked runs, then the verifier CLI checks every one
pnpm golden:record     # re-record golden receipts from reference/prototype.html (needs Chromium)
pnpm --filter @exit-liquidity/server sim 50000   # balance sim, mulberry32 vs xoshiro256** (docs/balance-rng.md)
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
- Receipts are v3: `{game, v: 3, rng, seed, mint, log, result, math}`. `rng` names the generator. The prototype's v2 receipts (no `rng`, always mulberry32) still replay. Phase changes the prototype never logged (opening the chart, leaving the shop) are inferred during replay, as the format requires.

### Random generators

The generator is injected (`makeEngine(math, mathId, generators)`) and chosen per run (`createRun(seed, mint, rng)`):

- **Practice: `mulberry32`**, seeded with a uint32, exactly as the prototype. This keeps the prototype golden tests exact.
- **Ranked: `xoshiro256**`**, seeded with the full 32 byte keccak hash (the four state words are the hash read as big-endian uint64s). The shop stream is the run stream jumped 2^128 ahead. The port is checked bit for bit against Blackman and Vigna's reference C (outputs, doubles and `jump`), with pinned vectors in `packages/engine/test/rng.test.ts`.

Balance did not move: 50,000 runs per arm, same bots and same bot randomness, only the market generator changed. The largest per-layer difference across 16 comparisons was |z| = 1.96, about what chance alone gives. Full table in `docs/balance-rng.md`.

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

- **Seeds.** Each UTC day gets a 32 byte secret seed. `GET /api/commit/:day` publishes `keccak256(seed)` (today or tomorrow, so it can be recorded before the day starts). `runSeed = keccak256(dailySeed ++ uint256(player) ++ uint256(attempt))`, all 32 bytes, seeding xoshiro256**. The player id stands in for the pass id until M2.
- **Server authority.** The client never receives the seed before the run ends and never computes prices. It gets only what its screen can show:
  - no event queue, generator state, fair value internals, cash or debt, and headlines without an event type (the player reads the text);
  - fake-news flags only with Insider, the fair value line only with Fair Value, the sniper line only with Dip Sniper, all only while trading;
  - the exact fake-news rate only when the intro shows its chip (30% or more), shop offers only in the shop, the run summary and seed only at the end.

  Views and events are built field by field, and `apps/server/test/stream-audit.test.ts` checks every message of real runs against a key allowlist and those rules.
- **Reconnect.** A run belongs to the player, not the connection. If the socket drops, the run keeps going at the server and the clock never pauses. The client retries with `hello {resume: true}` and gets a full snapshot (chart history included), then live ticks. A second connection takes over the run and the first is told why. `resume` never starts a new attempt, and a plain hello while a run is live resumes that run. A run that ends while the player is away hands over its result when they come back (kept 15 minutes).
- **Stamping.** Inputs are applied the moment they arrive, so the engine logs them at the tick the server stamped. That log is the receipt.
- **Results.** At run end the server signs `{run, day, player, attempt, receiptHash, layers, bank}` with ed25519 (`receiptHash` = keccak256 of the canonical receipt). M2 swaps this for EIP-712 so `RunRegistry` can check it on chain.
- **Reveal.** `GET /api/seed/:day` and `GET /api/runs/:day` only answer after the day closes (UTC). Then anyone can run the verifier.
- **Leaving early does not help.** A player who never comes back gets the run played out without them: the clock runs the level down, and 5 minutes idle on an intro or shop screen finishes the rest with no input. The result counts. Otherwise players could peek at a chart and retry.
- **Identity.** A name plus a server-issued token kept in the browser. No wallet in M1.
- **Limits.** 3 ranked attempts per player per day (configurable), 40 messages per second per connection, 4 KB max message.
- **Minting.** Kept on the server as a stand-in for the ERC-1155: only an indicator held at run end, once per run, 3 charges, one charge used per ranked run.
- **Leaderboard.** `GET /api/leaderboard?day=` gives the best run per player, by layers then bank.

### Exit test result

`pnpm m1:exit` (1,000 runs, 100 concurrent bots over real WebSockets, 4 ms ticks, xoshiro256**):

```
stored 1000, verifier exit 0, "1000/1000 runs verified"
runs ending on layer 0..8: 250, 297, 183, 155, 53, 42, 8, 7, 5
125 runs dropped and resumed mid run (5 to 80 ticks passed while away), 25 abandoned for good
2,251 shop inputs, 192 mints, 48.9 s
```

The verifier runs as a separate process, fetches the revealed seed and published receipts over HTTP like an outsider would, and checks the seed against the commit recorded before the runs started.

## Open items before anything involving money (M2+)

1. **Headline bots (spec section 8).** The stream no longer carries a headline's event type, but the headline table ships with the client, so a bot reads the type back from the text in a few lines (`apps/server/src/headlines.ts` does exactly that for our bots). This is hygiene, not a defense. The headline bot clears layer 1 in about 82% of simulated runs.
2. **Seed custody.** Daily seeds sit in SQLite in plain text, under `apps/server/data/` by default (gitignored). They are never logged (the logger also redacts any 32 byte hex value), never sent before the reveal, and not in the repo or its history; `apps/server/test/secrets.test.ts` checks all of that. A KMS is still later work.
3. **Server restarts.** Live runs do not survive one. A clean shutdown plays them out unattended; after a crash they are voided on startup (the attempt is used, nothing scores). Reconnect covers dropped clients, not a dropped server.
4. **Signer key** is a local PEM in `apps/server/data/` (gitignored). Rotation is manual.
