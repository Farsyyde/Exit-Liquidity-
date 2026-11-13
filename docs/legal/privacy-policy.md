# Exit Liquidity: Privacy Policy

**DRAFT for review. Not legal advice. Every [BRACKET] needs a real answer before this is published, and a lawyer should read it, especially for players in the EU, UK and California.**

Last updated: [DATE]

This policy covers the game at [SITE URL] ("Exit Liquidity", "we"). It is operated by [OPERATOR LEGAL NAME], [ADDRESS]. Contact: [CONTACT EMAIL].

We built the game to collect as little as possible. There are no accounts with emails or passwords, no analytics, no ads, no tracking cookies, and we never store your IP address.

## 1. Practice mode

Practice runs entirely in your browser. Nothing about your play is sent to us. The game keeps one item in your browser's local storage: the indicator you minted at the end of a run and how many runs it has left. You can clear it by clearing this site's data in your browser.

## 2. Ranked mode

When you play ranked, the run happens on our server so nobody can see the chart in advance. To do that we store:

- **The name you choose.** It appears on the public leaderboard. Do not use your real name if you do not want it public.
- **An access token.** Your browser keeps a random token so it can reuse your name. We store only a one-way hash of it, not the token itself.
- **Each ranked run:** the day, which attempt it was, the run's seed, every button you pressed and the game tick it arrived on, the result (layers cleared, final bankroll), when it started and ended, the indicator you minted, and our signature over the result.
- **When your name was first used.**

**What becomes public.** The leaderboard shows names and results. After each UTC day ends we publish that day's seed and the receipt of every ranked run (seed, inputs, result and a numeric player number, without the name), so that anyone can check that results were not faked. That is how the game proves it is fair.

**Why we process it.** To run the game you asked to play and show the leaderboard (performance of a contract), and to let players verify results and to stop cheating (our legitimate interest in a fair game).

## 3. Data we do not collect

No email, real name, phone number, payment details, precise location, contacts or device identifiers. No cookies. Our server does not record IP addresses.

## 4. Services that receive data

- **Hosting:** [HOSTING PROVIDER, COUNTRY]. Like any web host it may keep access logs (IP address, browser type, pages requested, time) for [RETENTION PERIOD] for security and operations. [LINK TO THEIR PRIVACY POLICY]
- [IF THE LIVE SITE STILL LOADS GOOGLE FONTS: **Google Fonts** (Google LLC, USA): your browser downloads the game's fonts from Google, which receives your IP address and browser details. The next release serves the fonts ourselves and removes this. Remove this bullet once that release is live.]

We do not sell or share personal data for advertising.

## 5. How long we keep it

Ranked data is kept until you delete it, or [RETENTION RULE, for example: deleted after 24 months without a ranked run]. Daily seeds and published receipts are kept so results stay verifiable.

## 6. Your choices and rights

- **See your data:** on the ranked screen, MY DATA downloads everything we store about your ranked name as a file.
- **Delete it:** DELETE ACCOUNT on the ranked screen erases your name, every ranked run and receipt, your leaderboard entries and your minted indicator from our server, immediately. It cannot be undone. Receipts that other people downloaded while they were public stay with them; we cannot recall those copies.
- **Lost your browser data?** Without the token we cannot tell that a name is yours. Write to [CONTACT EMAIL] and tell us the name and when you played; we will [PROCESS FOR UNVERIFIED REQUESTS].
- Depending on where you live (for example the EU, UK or California) you may also have rights to correct data, to object, to restrict processing and to complain to your data protection authority ([LEAD AUTHORITY IF ANY]). Write to [CONTACT EMAIL].

## 7. Children

The game is not directed at children under [13, or 16 where local law requires]. We do not knowingly collect data from them. [DECIDE: age gate or not.]

## 8. Security

Ranked data is stored on our server and accessed only by [WHO]. Tokens are stored only as hashes. The fairness secrets (daily seeds) are never logged and never sent to players before the day ends.

## 9. International transfers

[IF THE HOST OR OPERATOR IS OUTSIDE THE PLAYER'S COUNTRY: name the country and the safeguard, for example Standard Contractual Clauses.]

## 10. Changes

We will post changes here and update the date above. If a change is significant we will say so on the title screen.

---

## Addendum, not yet in effect: the Exit Liquidity pass (testnet)

Add this section only when the pass launches. Today it exists on a test network only.

- **Wallet address.** If you connect a crypto wallet, our server reads which passes your wallet holds and checks signatures you make with it. We store the wallet address that owned a pass when you bound a ranked run to it.
- **The blockchain is public and permanent.** Minting a pass and settling a ranked result on chain are blockchain transactions. Your wallet address, the pass id, the result you settled and the time are published on [Robinhood Chain testnet / mainnet] for anyone to see, forever. **We cannot delete anything from a blockchain**, including after you use DELETE ACCOUNT.
- **Your wallet and its network provider** (for example a browser extension and the RPC service it connects to) see your IP address, wallet address and every transaction you sign. They are your choice and covered by their own policies.
- **Robinhood Chain RPC** ([LINK]): our server reads the chain through it. It sees our server's requests, which include pass ids and wallet addresses.
- **Google Wallet (later):** if you save your pass to Google Wallet, Google receives the pass content and your Google account saves it. Covered by Google's policy.
