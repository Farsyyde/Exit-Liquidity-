# M2: the pass (testnet only)

Branch `m2-pass`. Nothing is deployed: not to the live game, not to the testnet. Robinhood Chain testnet (chain id 46630) only; the deploy script and the server refuse every other chain except a local dev chain (31337). Mainnet (4663) is refused on purpose.

## What is built

| Piece | Where | Status |
|---|---|---|
| `PlayPass.sol`: ERC-721 + ERC-8426 (inherits `ERC721WalletPass` from `@erc8426/contracts` 0.3.0), founder sale, delayed random styles, updater role, seasonal expiry and renew for later pass types | `contracts/src/PlayPass.sol` | 27 Foundry tests |
| `RunRegistry.sol`: daily seed commit and reveal, EIP-712 `settle`, best result per pass, rotatable signer, PassUpdate through PlayPass | `contracts/src/RunRegistry.sol` | 11 Foundry tests |
| Deploy script, addresses to `contracts/deployments/<chainId>.json` | `contracts/script/Deploy.s.sol` | run on a local chain; simulated against the testnet RPC (8.8M gas, about 0.00018 test ETH); not broadcast |
| Pass issuer (`@erc8426/issuer` 0.4.0, gated) under `/wallet-pass`, `render()`, preview format, Google slot | `apps/server/src/pass.ts` | end to end on anvil |
| Ranked runs bound to a pass, server signed EIP-712 result, settle from the browser | server + `apps/web/src/chain.ts` | end to end on anvil, in vitest and in Chromium |
| Seed operator job (commit before the day, reveal after) | `apps/server/src/pass.ts` | on anvil |
| My pass page: connect, mint, card drawn from the gated preview, play ranked with a pass, settle | `apps/web/src/main.ts`, `chain.ts` | in Chromium with an injected wallet |

Tests: `pnpm test` (130, including `apps/server/test/pass.test.ts` on a local chain), `cd contracts && forge test` (38), `node scripts/pass-e2e.mjs` (the built site in Chromium; `E2E_CONFORMANCE=1` also runs `@erc8426/conformance`).

## How the pieces fit

```
browser (My pass, ranked)            run server                                  chain (testnet)
  wallet (EIP-1193) ---------------------------------------------------------->  PlayPass.mint, RunRegistry.settle
  reads via /api/rpc  ----------->  read-only JSON-RPC proxy  ------------------>  eth_call ...
  @erc8426/client getManifest --->  /wallet-pass/:id  (issuer, gated) --------->  ownerOf at latest (fresh read)
                                      401 + challenge, signed acquire proof, manifest {formats: {preview}}
  fetch formats.preview  -------->  rendered PassContent (JSON) <- render(): styleOf, isFounder, bestOf, runsSettled, runs played
  /api/pass-challenge, sign ----->  hello {pass}: SIWE floor, nonce spent, signature, ownerOf, per pass cap
  ranked run (WebSocket)  ------->  end: receipt, ed25519 attestation, and EIP-712 RunResult -> settle
                                    indexer: Transfer, PassUpdate, BatchPassUpdate logs -> rotation, refresh, owner list
                                    seed job: commitDailySeed(today, tomorrow), revealDailySeed(past days)
```

## Founder styles: how the reveal works

1. Deploy. The constructor takes the shuffled 2222-byte style list (`contracts/config/founder-styles.json`, rebuilt by `node contracts/script/style-list.mjs` from the public label `exit-liquidity/founder-styles/v1`), checks the caps (Classic 800, Neon 500, Founders Gold 72, Blood Moon 400, Ghost 300, Glitch 150) and stores it and its hash `0x21af71c806ea0c53fc9d70da4833a4402838bb75993664c0db9a78dbbb14adf5`. The list is public before the sale.
2. Before the sale opens, the owner commits `keccak256(secret)` (`node contracts/script/style-secret.mjs` makes one; the contract refuses to open the sale without it, and the commit cannot change).
3. The sale closes (owner, or selling out). Minting is then impossible.
4. The owner reveals the secret (`revealStyleSecret`). That fixes a reveal block 20 L2 blocks ahead, whose hash nobody knows yet.
5. Anyone calls `finalizeStyles` within 200 blocks after it: `offset = keccak256(secret, blockhash, contract) mod 2222`; pass n gets `list[(n - 1 + offset) mod 2222]`; one `BatchPassUpdate(1, minted)` refreshes every card. If nobody finalizes in time, anyone can re-arm a new reveal block.

Why nobody can steer it: every mint happens before any randomness exists (the secret cannot be revealed while the sale is open). The owner knows the secret but commits to it before the block hash exists, and cannot re-pick the block once the secret is out. A minter knows neither. Tests: `test_RandomnessExistsOnlyAfterTheLastMint`, `testFuzz_MinterChoicesDoNotMoveTheOffset`, `test_FutureBlockHashDecidesTheStyle`, `test_StyleIsHiddenUntilFinalized`, `test_RevealTimingRules`, and `test_StyleCountsAfterRevealMatchTheCapsExactly` on a full sellout.

Residual: Robinhood's sequencer produces the block and could in principle influence its hash. It does not know the secret, which is already public by then, so it would have to compute the outcome and reorder on purpose. Chainlink VRF would remove that; see decisions.

## What was verified against the EIP

Contract (ERC-8426 Contract interface):
- `supportsInterface(0xef5f1e71)` true, with ERC-165 `0x01ffc9a7` true and `0xffffffff` false; ERC-4906 is not claimed (the pass does not mirror metadata). The interface id was also asserted as `type(IERC721WalletPass).interfaceId`.
- `passURI` returns the base plus the decimal id, reverts with `ERC721NonexistentToken` for an unminted id; the base is owner-settable for moving servers.
- `PassUpdate` on mint, transfer and burn (from the base contract), on settle (RunRegistry through the updater role, which can never block a settle), on renew; `BatchPassUpdate` over the inclusive minted range on reveal.
- Nothing in either contract is reachable from a pass link (no capability configuration), so no `BoundedAction` operator is needed.

Issuer (Pass manifest, Gated acquisition, Authorization), all in the end to end test and the conformance suite:
- No proof: 401 `proof_required` with a `challenge` and no acquisition URLs.
- Challenge: 400 for a missing or invalid address; ERC-4361 with the domain equal to the serving host, the claimed account, the chain id, a fresh single-use nonce, an expiry, the CAIP-19 token as the first resource and `urn:wallet-pass:action:acquire` second.
- Owner's proof: 200 manifest, `Content-Type: application/json`, `Cache-Control: no-store`, `version: 1`; replaying the proof is refused 401; another account's valid proof is 403 `not_owner` and nothing else is 403.
- Fresh `ownerOf` at `latest` on every manifest and download; after a transfer the previous owner gets 403 at once, and the indexer rotates links when it sees the Transfer.
- Store: SQLite through the SDK's `kvStores` (atomic `getDel` for nonces); links are derived from `linkSecret`, which lives outside the store.
- Pass content: random serial, no personal data on the card (the owner is shown shortened on the back, as in the SDK example).
- The pass-bound ranked proof is a separate challenge (`urn:exit-liquidity:action:ranked`), so an `acquire` proof can never start a ranked run and a ranked proof can never open a manifest, as the EIP requires of actions.

`@erc8426/conformance` 0.4.0 against a local deployment: every MUST it can check passed. Skipped: the optional issuer commitment, the metadata mirror (no `tokenURI` yet), and two checks it says need the server's cooperation (covered by the issuer's own tests). It passes even though the only format is `preview`, which no wallet can use; a meaningful run waits for Google on an https origin.

## What in the spec turned out wrong

1. **`prevrandao` cannot be the random source.** Robinhood Chain's docs: "prevrandao / block.difficulty return a constant value on Robinhood Chain and are not a source of randomness" (blocks report difficulty 1). The reveal uses a committed secret plus a future L2 block hash instead.
2. **`block.number` is not the chain's block number** on Robinhood Chain (an Arbitrum chain): it is an L1 estimate that updates periodically. L2 numbers and hashes come from ArbSys at `0x64`. Forge also cannot simulate that precompile, so the deploy script reads the block number from the RPC.
3. **Chain id.** `eip155:4663` (spec section 12) is mainnet; the testnet is 46630. Corrected in BUILD_SPEC.
4. **"A valid manifest needs at least one format" bites earlier than expected:** `createIssuer` refuses to start with no provider at all. The `preview` format (as in the SDK's next-app) keeps the issuer running and is what the My pass page draws.
5. **Exact style caps only hold on a sellout.** With fewer than 2222 minted, the minted passes get a contiguous window of the shuffled list, so counts are close to proportional but not exact. Decision below.
6. **"Each token stores a styleId"**: the style is computed from the stored list and the offset (`styleOf`), not written per token, which would cost 2222 storage writes at reveal. Same result, verifiable by anyone.
7. **`bank` cannot go on chain as a float**: the signed result carries `bankCents` (uint64).
8. **Seeds per pass (spec section 5 step 2)** would mean non-holders have no seed. Ranked stays free, so seeds stay per player and attempt; a run *bound* to a pass also takes one of that pass's attempts for the day (3), which is what RunRegistry enforces on chain.
9. **Gated acquisition is not "ERC-4361 required"**: the EIP mandates the challenge fields and recommends SIWE; and rotation on transfer is not synchronous (the fresh read covers the gap). Corrected in BUILD_SPEC section 12.

## Testnet runbook (when you approve a testnet deploy)

1. Server key: `pnpm --filter @exit-liquidity/server chain-signer` prints the address of the run server's chain key (result signer and seed operator), creating `apps/server/data/chain-signer.key` (gitignored). Fund it with a little testnet ETH: it sends one commit and one reveal per day.
2. Style secret: `cd contracts && node script/style-secret.mjs` prints `STYLE_SECRET_COMMIT` and writes the secret to `contracts/secrets/style-secret.json` (gitignored). Back it up privately: styles cannot be revealed without it.
3. Deploy (your deployer key, funded with testnet ETH; prefer `--account` with a Foundry keystore or `--ledger` over a raw key):
   ```sh
   cd contracts
   PASS_BASE_URI=https://<your domain>/wallet-pass/ SERVER_SIGNER=<address from 1> SEED_OPERATOR=<address from 1> \
   STYLE_SECRET_COMMIT=<from 2> MINT_PRICE_WEI=<price> \
   forge script script/Deploy.s.sol --rpc-url robinhood_testnet --broadcast --account <keystore name>
   ```
   It writes `contracts/deployments/46630.json`. Commit that file.
4. Run the server with `EXITLIQ_DEPLOYMENT=contracts/deployments/46630.json`, `EXITLIQ_BASE_URL=https://<your domain>` (must be the origin in `PASS_BASE_URI`: the SIWE domain is its host), `EXITLIQ_ENV=production`, `EXITLIQ_LINK_SECRET=<32+ random bytes>` from your secret store, and a persistent `apps/server/data/`.
5. Open the sale when ready: `cast send <PlayPass> "openSale()" --rpc-url robinhood_testnet --account <owner>`.
6. After the sale: `closeSale()`, then `revealStyleSecret(<secret>)`, wait 21 or more L2 blocks (seconds), then anyone: `finalizeStyles()`.

## Google Wallet: what you need to do

These are the SDK's steps (`docs/platforms/google.md`), made specific to this project. They need your Google account; none can be done from here.

1. **Issuer account.** Sign in to the Google Pay and Wallet Console (pay.google.com/business/console), open Google Wallet API, create the issuer for Exit Liquidity. Copy the **numeric Issuer ID** (the long number; the alphanumeric merchant id fails every API call).
2. **Cloud project.** In Google Cloud, create or pick a project and enable the **Google Wallet API**.
3. **Service account.** IAM, Service Accounts: create one with **no project roles**. Keys, Add key, JSON. Put the JSON in your secret manager. Do not send it in chat or commit it.
4. **Grant it access.** Back in the Wallet console, Users: invite the service account's email with **Developer** access. Until then every call answers 403.
5. **Class type.** We will use a **Generic** class, which works for every user immediately with no Google review (loyalty and event classes save only to test accounts until approved).
6. **Images.** Google fetches card images itself from public https URLs: a logo and icon (and optionally a 3:1 hero, about 1032x336) on the game's own domain. Tell me where they will live, or I add them to the site.
7. **The https origin** the pass will be saved from (save links name it), the same as `EXITLIQ_BASE_URL`.

Then give me, through the server's environment (not chat): `GOOGLE_WALLET_ISSUER_ID` and `GOOGLE_WALLET_SA_JSON`. I add `@erc8426/google`'s `googleFormatProvider` in `walletProviders()` (`apps/server/src/pass.ts`), back its object store with SQLite so object ids survive restarts, and run `@erc8426/conformance` against the https testnet deployment with the owner key.

## Decisions I need from you

1. **Mint currency and price.** Both are implemented; the payment token is fixed at deploy. For the testnet I suggest native ETH at the ETH amount that is $10 on deploy day (the script defaults to 0.003 ETH). For mainnet later, a stablecoin keeps it at $10; that needs a stablecoin you trust on Robinhood Chain.
2. **Randomness.** Accept commit plus future block hash (sequencer residual above), or require Chainlink VRF before any mainnet sale. I did not confirm VRF exists on Robinhood Chain; their docs name Chainlink for price feeds.
3. **Partial sellout.** Accept near-proportional styles when the sale closes early, or keep the exact caps (for example: styles only ever revealed over a full 2222, with unsold passes minted to a treasury and burned, or reveal over the minted count with a shortened list).
4. **Pass binding rules.** A pass gets 3 bound ranked runs per day across any player names, and one run settles on one pass only. OK?
5. **Domain and ownership.** The https origin for `passURI` (also the SIWE domain). Who owns the contracts: your deployer EOA or a multisig.
6. **Legal facts** for the privacy policy and terms drafts in `docs/legal/` (operator, host, contact, minimum age, jurisdiction, retention).
7. **Deploying the privacy fixes to the live game** (self-hosted fonts, DELETE ACCOUNT and MY DATA). They are on this branch and change only what the privacy work requires, but the live game stays as it is until you say so.
8. **Token metadata.** The pass has no `tokenURI` yet, so marketplaces and explorers show it blank. Add metadata now or leave it for the Indicators milestone.

## Login (Privy), optional

Guests play without logging in; progress stays in localStorage. LOG IN (OPTIONAL) loads Privy on demand (guests never download it).

Server env (secrets go in the server environment or a secret manager, never in the repo):

| Variable | What |
|---|---|
| `PRIVY_APP_ID` | Privy app id (public) |
| `PRIVY_VERIFICATION_KEY` | The app's ES256 verification key (dashboard, App settings). `\n` is unescaped. Used to verify access tokens offline. |
| `PRIVY_APP_SECRET` | Lets the server read linked wallets fresh from Privy's API and delete Privy users. Without it the server falls back to the identity token and cannot delete Privy users. |
| `PRIVY_CLIENT_ID` | Optional app client id |

Without `PRIVY_APP_ID` and `PRIVY_VERIFICATION_KEY`, `/api/auth-config` answers 404 and the LOG IN button is hidden.

Privy dashboard: enable email, Google, X, Discord and external wallets; turn on identity tokens; add the site origin(s) to allowed origins; embedded wallets on for users without wallets; key export allowed. Robinhood Chain testnet (46630) is configured in code as a custom chain; mainnet (4663) is defined but not in `supportedChains`.

Behaviour:
- First login moves the browser's guest ranked player and practice keepsake into the account (only if that guest is not already in another account).
- An account can link several wallets. `/api/me/passes` and run binding ask Privy for the linked wallets and read `ownerOf` on chain every time; nothing is cached.
- Ranked hello carries the Privy access token; the server verifies it (signature, issuer, audience, expiry) before the run starts.
- At mint the player picks which linked wallet receives the pass.
- DELETE ACCOUNT removes server data and, if ticked, the Privy user (which detaches the embedded wallet for good; export the key first).
