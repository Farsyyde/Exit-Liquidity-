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
