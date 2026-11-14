# Third-party services and the data each collects

Audited 2026-11-13 from the code, not from memory: every URL in the built frontend bundle and `index.html`, every outbound call in the server, every dependency that runs in the browser. Re-run `node scripts/audit-bundle.mjs` after any frontend change; it lists every host the bundle references.

## The live game (branch `ccr-9bbe2ee8-lniwed`)

| Service | Where it is used | What it receives | Cookies | Notes |
|---|---|---|---|---|
| **Google Fonts** (Google LLC): `fonts.googleapis.com` (stylesheet) and `fonts.gstatic.com` (font files) | Every page load, from the visitor's browser | IP address, user agent, the page URL as referrer, time of request | None set by the Fonts API | The only third party in the live frontend. Google's Fonts FAQ says the requests carry no cookies and the data is used to serve fonts and count their use. A German court (LG München I, 2022) held that loading Google Fonts from Google's servers without consent breaches GDPR, because it sends the visitor's IP address to Google. Removed on the `m2-pass` branch (fonts self-hosted, see below). |
| **Hosting provider:** [FILL IN: who serves the site and runs the Node server] | Every HTTP and WebSocket request | Whatever its access logs keep: typically IP address, user agent, URL, time, response size | Depends on the host | Not visible from the code. Needed for the privacy policy: name, location of servers, log retention. |
| **Domain, DNS or CDN:** [FILL IN if separate from the host] | Every request | Same as above | Depends | |

Nothing else. In particular the live app has **no** analytics, advertising, error reporting, session replay, payment processor, email provider, social login, wallet SDK or third-party RPC. The run server makes no outbound network calls at all.

### What our own server stores (SQLite, `apps/server/data/`)

| Data | Why | Public? |
|---|---|---|
| Ranked name the player chooses | Identify a ranked player, leaderboard | Yes, on the leaderboard |
| SHA-256 hash of a random access token (the token itself stays in the player's browser) | Lets the same browser keep its name without a password | No |
| Account creation time | Housekeeping | No |
| Per ranked run: UTC day, attempt number, run seed, minted indicator used, start and end time, result (layers, bankroll), the full input log (every button press with the game tick it arrived on), receipt hash, the server's signature, the indicator minted afterwards | Running the game, the leaderboard, and letting anyone verify results | Results on the leaderboard during the day; after the UTC day closes the receipt (seed, inputs, result, numeric player id) is published at `/api/runs/:day` |
| Daily seeds and their commitments | Fair play | Commitment always; seed after the day closes |
| Minted indicator per player (id, charges left) | Game feature | No |

**Not stored:** IP addresses, emails, real names, device identifiers, cookies, request logs. The server writes three kinds of log line (a startup line, "voided N runs" after a crash, and errors), none with personal data; the logger also redacts any 32 byte hex value.

### What the browser stores (localStorage, never sent anywhere except as noted)

| Key | Contents | Sent to |
|---|---|---|
| `exitliq_mint` | Practice mode keepsake: a minted indicator id and charges left | Nobody |
| `exitliq_ranked_id` | Ranked name and access token | Our server, when playing ranked or using MY DATA and DELETE ACCOUNT |

## On the `m2-pass` branch (not deployed)

| Change | Effect on third parties |
|---|---|
| Fonts self-hosted from the npm packages `@fontsource/silkscreen` and `@fontsource/vt323` (SIL Open Font License) | Google Fonts removed. The frontend references no third-party host. |
| Account data export (`POST /api/account/export`) and deletion (`POST /api/account/delete`), buttons on the ranked screen | No new third party. |
| Pass (M2), testnet only | **Robinhood Chain testnet RPC** (`rpc.testnet.chain.robinhood.com`, operated by Robinhood): our server reads the chain (ownership, styles, results) and sends commit and reveal transactions. Pages read the chain only through our own `/api/rpc` read-only proxy, so the RPC provider sees our server, not the visitor; the requests do contain the wallet addresses and pass ids being looked up. Verified in Chromium: the pass pages contact no host but the site itself. The visitor's **browser wallet** (an extension such as MetaMask, or a mobile wallet browser) and the RPC endpoint that wallet is configured with receive the visitor's IP address, wallet address and the transactions they sign. Every mint and settle is **public and permanent on the blockchain**: wallet address, token id, run results settled, timestamps. The block explorer `explorer.testnet.chain.robinhood.com` is linked, not embedded. |
| Google Wallet (later, not built) | Google LLC will receive the pass content and the Google account that saves it. Listed now so the policy can name it before launch. |
| **Login with Privy** (Privy, Inc., `auth.privy.io`; acquired by Stripe in 2025), optional | Only when a player presses LOG IN (OPTIONAL), or on page load in a browser that has logged in before. Guests never load the Privy code: it is a separate bundle fetched on demand, and the guest page still contacts no host but the site itself (checked with the bundle audit: the entry chunk imports the Privy island only dynamically). | **Privy:** the login email address, or the profile the social provider returns (Google, X or Discord: account id, name, email, avatar as that provider shares it), the addresses of every wallet linked to the account, the embedded wallet it creates (its key is split and held by Privy's key management, not by us), IP address, user agent, device and session data, and the signing requests the player approves. **Our server** receives the Privy user id (in a signed access token it verifies with the app's public verification key) and asks Privy's API for the account's linked wallets each time ownership matters. | Privy stores session tokens in the browser (localStorage and, depending on the app setup, cookies on the site's domain) | Login methods: email one-time code, Google, X, Discord, external wallet. Players without a wallet get an embedded wallet on Robinhood Chain testnet. **Key export** is enabled, so the player can take the embedded wallet's key elsewhere. |
| **Social login providers** (Google LLC, X Corp., Discord Inc.) | Only if the player picks that provider in the Privy login window | The usual OAuth sign-in: the provider learns the player signed in to this app through Privy | The provider's own | Chosen by the player. |
| **Hosts inside the Privy bundle** | Loaded only with Privy | The Privy SDK references many services it may contact depending on what the player does: WalletConnect / Reown (`*.walletconnect.com`, `*.walletconnect.org`, `api.web3modal.org`, for connecting a mobile wallet by QR code), Coinbase Wallet (`keys.coinbase.com` and others, if the player picks Coinbase Wallet), Cloudflare Turnstile (`challenges.cloudflare.com`, bot protection on email login), Privy's own chain RPCs (`*.rpc.privy.systems`, for chains this app does not enable), MoonPay and Coinbase Pay (funding flows, **not enabled** in this app's Privy config). | Theirs | Listed from `node scripts/audit-bundle.mjs` (181 hosts in the Privy chunk). Which ones are actually contacted depends on the login method and the Privy dashboard settings. Recheck in a real browser once the Privy app exists. |

### What our server stores for logged-in players (`accounts` table)

| Data | Why |
|---|---|
| Privy user id (`did:privy:...`) | Links the Privy account to a ranked player |
| The ranked player it is linked to (the same player row as a guest, if the guest moved into the account on first login) | Ranked play under one name across devices |
| The practice keepsake (minted indicator id and charges) | Practice progress follows the account |
| Creation time | Housekeeping |

**Not stored:** email, social profile, wallet list, Privy tokens. Linked wallets are fetched from Privy every time they matter (pass list, run binding), and pass ownership is read on chain every time, never cached.

### Delete my account, with Privy

DELETE ACCOUNT (on the account screen, type DELETE to confirm) removes from our server: the ranked name, every ranked run and receipt, leaderboard entries, the minted indicator, the practice keepsake, and the `accounts` row. A checkbox (shown when the server has the app secret, on by default) also deletes the **Privy user** through Privy's API (needs `PRIVY_APP_SECRET` on the server): Privy then removes the login methods and **detaches the embedded wallet for good**. The screen warns about that first and offers EXPORT KEY, because without the key nobody can reach that wallet's passes again. Blockchain data (mints, transfers, settled results) cannot be deleted by anyone.

