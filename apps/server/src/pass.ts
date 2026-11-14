// M2: the Exit Liquidity pass, server side. Testnet only.
//
// - An ERC-8426 issuer (@erc8426/issuer, gated configuration) mounted under
//   /wallet-pass. Its one format today is `preview`: the rendered PassContent
//   as JSON, behind the same proof and fresh ownership read as any pass file,
//   so the "My pass" page can draw the card. Wallets ignore the key (clients
//   MUST ignore unknown format keys). Google Wallet plugs in at
//   `walletProviders()`.
// - Ranked runs can be bound to a pass with a signed challenge and a fresh
//   ownerOf read. A bound run that ends gets an EIP-712 RunResult signature
//   the pass owner submits to RunRegistry.settle.
// - An indexer follows Transfer and PassUpdate logs: it keeps who owns which
//   pass (for listing) and drives the issuer's rotation and refresh hooks.
// - The seed operator job commits each UTC day's seed before the day and
//   reveals it after, on chain, when this server's key is the operator.

import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  createPublicClient, createWalletClient, defineChain, getAddress, http, isAddress, parseAbi, parseAbiItem,
  type Address, type Hex, type PublicClient, type Chain,
} from 'viem';
import { privateKeyToAccount, generatePrivateKey, type PrivateKeyAccount } from 'viem/accounts';
import { createSiweMessage, parseSiweMessage, generateSiweNonce } from 'viem/siwe';
import { createIssuer, kvStores, toNodeHandler, type Issuer, type IssuerProvider } from '@erc8426/issuer';
import type { PassContent, PassFileProvider } from '@erc8426/core';
import { googleFormatProvider, googleWalletClient, saveOrigins, type GoogleObjectStore, type GoogleObjectRecord } from '@erc8426/google';
import type { Db } from './db.ts';
import { parseSeedHex } from './seeds.ts';

// ------------------------------------------------------------------ chains

/** Robinhood Chain testnet. Values from docs.robinhood.com/chain/connecting, and eth_chainId answers 0xb626. */
export const robinhoodTestnet = defineChain({
  id: 46630,
  name: 'Robinhood Chain Testnet',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.testnet.chain.robinhood.com'] } },
  blockExplorers: { default: { name: 'Explorer', url: 'https://explorer.testnet.chain.robinhood.com' } },
  testnet: true,
});

const localDev = defineChain({
  id: 31337, name: 'Local dev chain', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['http://127.0.0.1:8545'] } }, testnet: true,
});

/** Only these chains are allowed. Mainnet (4663) is refused on purpose. */
export const ALLOWED_CHAINS: Record<number, Chain> = { 46630: robinhoodTestnet, 31337: localDev };

export interface Deployment {
  chainId: number;
  playPass: Address;
  runRegistry: Address;
  deployBlock: number;
  price: string;
  paymentToken: Address;
}

export function loadDeployment(path: string): Deployment {
  const j = JSON.parse(readFileSync(path, 'utf8'));
  const d: Deployment = {
    chainId: Number(j.chainId), playPass: getAddress(j.playPass), runRegistry: getAddress(j.runRegistry),
    deployBlock: Number(j.deployBlock ?? 0), price: String(j.price ?? '0'), paymentToken: getAddress(j.paymentToken ?? '0x0000000000000000000000000000000000000000'),
  };
  if (!ALLOWED_CHAINS[d.chainId]) throw new Error(`chain ${d.chainId} is not allowed: testnet (46630) or a local chain (31337) only`);
  return d;
}

// -------------------------------------------------------------------- ABIs

export const playPassAbi = parseAbi([
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function passURI(uint256 tokenId) view returns (string)',
  'function styleOf(uint256 tokenId) view returns (uint8)',
  'function isFounder(uint256 tokenId) pure returns (bool)',
  'function expiresAt(uint256 tokenId) view returns (uint64)',
  'function foundersMinted() view returns (uint256)',
  'function foundersMintedBy(address) view returns (uint256)',
  'function price() view returns (uint256)',
  'function sale() view returns (uint8)',
  'function revealed() view returns (bool)',
  'function paymentToken() view returns (address)',
  'function FOUNDER_SUPPLY() view returns (uint256)',
  'function MAX_PER_WALLET() view returns (uint256)',
  'function mint(uint256 quantity, uint256 expectedUnitPrice) payable',
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
  'event PassUpdate(uint256 indexed tokenId)',
  'event BatchPassUpdate(uint256 fromTokenId, uint256 toTokenId)',
]);

export const runRegistryAbi = parseAbi([
  'struct RunResult { uint256 passId; uint32 day; uint8 attempt; bytes32 receiptHash; uint8 layers; uint64 bankCents; }',
  'function settle(RunResult r, bytes signature) returns (bool)',
  'function bestOf(uint256 passId) view returns (uint8 layers, uint64 bankCents, uint32 day, bytes32 receiptHash)',
  'function runsSettled(uint256 passId) view returns (uint32)',
  'function seedCommit(uint32 day) view returns (bytes32)',
  'function seedOf(uint32 day) view returns (bytes32)',
  'function seedOperator() view returns (address)',
  'function serverSigner() view returns (address)',
  'function commitDailySeed(uint32 day, bytes32 commit)',
  'function revealDailySeed(uint32 day, bytes32 seed)',
  'event RunSettled(uint256 indexed passId, uint32 indexed day, uint8 attempt, bytes32 receiptHash, uint8 layers, uint64 bankCents, bool newBest)',
]);

export const STYLE_NAMES = ['Classic', 'Neon', 'Founders Gold', 'Blood Moon', 'Ghost', 'Glitch'] as const;
export const UNREVEALED = 255;

/** Card colors per style id. An unrevealed pass gets the neutral card. */
export const STYLE_COLORS: Record<number, { background: string; foreground: string; label: string }> = {
  0: { background: '#1f2636', foreground: '#efe6cf', label: '#f5b83d' }, // Classic: the game's panel and cream
  1: { background: '#0b0f2a', foreground: '#3aa0ff', label: '#ff4fd8' }, // Neon
  2: { background: '#3b2a07', foreground: '#f5d27a', label: '#ffe9a8' }, // Founders Gold
  3: { background: '#2a0608', foreground: '#ffd6d2', label: '#fe5f55' }, // Blood Moon
  4: { background: '#e9edf2', foreground: '#2c3440', label: '#7c8798' }, // Ghost
  5: { background: '#06140d', foreground: '#4bc292', label: '#b06cff' }, // Glitch
  [UNREVEALED]: { background: '#2b2f38', foreground: '#c9ced8', label: '#8a94ad' },
};

/** UTC days since 1970-01-01, as RunRegistry counts them. */
export function dayNumber(day: string): number {
  return Math.floor(Date.parse(day + 'T00:00:00Z') / 86_400_000);
}
export function dayString(n: number): string {
  return new Date(n * 86_400_000).toISOString().slice(0, 10);
}

export const RANKED_ACTION = 'urn:exit-liquidity:action:ranked';

// ---------------------------------------------------------------- service

export interface PassOptions {
  db: Db;
  deployment: Deployment;
  rpcUrl?: string;
  /** Public origin the site is served from, for example https://exitliquidity.example. The SIWE domain is its host. */
  baseUrl: string;
  /** EIP-712 run result signer and seed operator key. 0x hex. Generated and kept at keyPath if absent. */
  chainKey?: Hex;
  keyPath?: string | null;
  /** At least 32 bytes. Generated and kept at linkSecretPath if absent. */
  linkSecret?: string;
  linkSecretPath?: string | null;
  environment?: 'production' | 'development';
  maxAttemptsPerDay?: number;
  /**
   * Google Wallet. Off when absent. issuerId is the numeric id from the Pay
   * and Wallet Console; the service account is the JSON key (client_email and
   * private_key). `fetch` is for tests only.
   */
  google?: { issuerId: string; serviceAccount: { client_email: string; private_key: string }; classSuffix?: string; fetch?: typeof fetch } | null;
  /** Public https URLs of the card art (from the image pack). Google omits slots without one. */
  images?: { logo?: string; icon?: string; hero?: string; heroFounders?: string } | null;
  /** Milliseconds between log polls. */
  pollMs?: number;
  log?: (m: string) => void;
  now?: () => number;
}

export interface Settlement {
  chainId: number;
  registry: Address;
  result: { passId: string; day: number; attempt: number; receiptHash: Hex; layers: number; bankCents: string };
  signature: Hex;
}

function persistentSecret(path: string | null | undefined, make: () => string): string {
  if (path && existsSync(path)) return readFileSync(path, 'utf8').trim();
  const v = make();
  if (path) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, v + '\n', { mode: 0o600 }) }
  return v;
}

export function createPassService(o: PassOptions) {
  const log = o.log ?? ((m: string) => console.log(m));
  const now = o.now ?? Date.now;
  const dep = o.deployment;
  const chain = ALLOWED_CHAINS[dep.chainId]!;
  const rpcUrl = o.rpcUrl ?? chain.rpcUrls.default.http[0]!;
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl, { retryCount: 1, timeout: 10_000 }) }) as PublicClient;
  const key = o.chainKey ?? (persistentSecret(o.keyPath ?? null, () => generatePrivateKey()) as Hex);
  const account: PrivateKeyAccount = privateKeyToAccount(key);
  const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) });
  const linkSecret = o.linkSecret ?? persistentSecret(o.linkSecretPath ?? null, () => randomBytes(32).toString('base64url'));
  const base = new URL(o.baseUrl);
  const domain = base.host;
  const cap = o.maxAttemptsPerDay ?? 3;
  const pass = { address: dep.playPass, abi: playPassAbi } as const;
  const registry = { address: dep.runRegistry, abi: runRegistryAbi } as const;

  // ------------------------------------------------------------ render

  /** Pass content for one token, shared by every format (the preview today, Google later). */
  async function renderPass(tokenId: string, owner: Address, serial: string, superseded: boolean, updatedAt: number): Promise<PassContent> {
    const id = BigInt(tokenId);
    const [style, founder, best, settled] = await Promise.all([
      publicClient.readContract({ ...pass, functionName: 'styleOf', args: [id] }),
      publicClient.readContract({ ...pass, functionName: 'isFounder', args: [id] }),
      publicClient.readContract({ ...registry, functionName: 'bestOf', args: [id] }),
      publicClient.readContract({ ...registry, functionName: 'runsSettled', args: [id] }),
    ]);
    const played = o.db.passRunsPlayed(tokenId);
    const [layers, bankCents, , receiptHash] = best;
    const hasBest = receiptHash !== '0x0000000000000000000000000000000000000000000000000000000000000000';
    const styleName = style === UNREVEALED ? 'Unrevealed' : (STYLE_NAMES[style] ?? 'Classic');
    return {
      serial,
      style: 'generic',
      organizationName: 'Exit Liquidity',
      description: `Exit Liquidity pass #${tokenId}`,
      title: 'EXIT LIQUIDITY',
      headline: founder ? 'FOUNDER PASS' : 'PASS',
      colors: STYLE_COLORS[style] ?? STYLE_COLORS[UNREVEALED]!,
      ...passImages(founder),
      header: [{ key: 'pass', label: 'PASS', value: `#${tokenId}` }],
      primary: [{
        key: 'best', label: superseded ? 'STATUS' : 'BEST LAYER',
        value: superseded ? 'Transferred' : hasBest ? `${layers} of 8` : 'No settled run',
        changeMessage: 'New best: %@',
      }],
      secondary: [
        { key: 'runs', label: 'RANKED RUNS', value: String(played) },
        { key: 'founder', label: 'FOUNDER', value: founder ? 'Yes' : 'No' },
        { key: 'style', label: 'STYLE', value: styleName },
      ],
      auxiliary: hasBest ? [{ key: 'bank', label: 'BEST BANKROLL', value: '$' + (Number(bankCents) / 100).toFixed(2) }] : [],
      back: [
        { key: 'settled', label: 'Results settled on chain', value: String(settled) },
        { key: 'contract', label: 'Issuing contract', value: dep.playPass },
        { key: 'chain', label: 'Chain', value: `${chain.name} (${dep.chainId})` },
        { key: 'owner', label: 'Issued to', value: `${owner.slice(0, 6)}...${owner.slice(-4)}` },
        { key: 'updated', label: 'Content updated', value: new Date(updatedAt * 1000).toISOString() },
        { key: 'about', label: 'About', value: 'A founder pass never expires. Ranked play is free for everyone; a pass lets you settle your ranked results on chain.' },
      ],
      links: [{ key: 'play', label: 'Play Exit Liquidity', url: base.origin + '/' }],
      ...(superseded ? { voided: true } : {}),
    };
  }

  /** Card art from the configured public URLs. Founders get the Gold hero when one is set. */
  function passImages(founder: boolean): Pick<PassContent, 'images'> {
    const im = o.images;
    if (!im) return {};
    const images: NonNullable<PassContent['images']> = {};
    if (im.logo) images.logo = { url: im.logo };
    if (im.icon) images.icon = { url: im.icon };
    const hero = founder ? (im.heroFounders ?? im.hero) : im.hero;
    if (hero) images.hero = { url: hero };
    return Object.keys(images).length ? { images } : {};
  }

  /** The `preview` format: the rendered content as JSON, served at a rotating capability URL behind the fresh read. */
  const previewProvider: PassFileProvider = {
    format: 'preview',
    async passFile(ctx) {
      return { body: JSON.stringify({ ...ctx.content, owner: ctx.owner, token: ctx.token }), contentType: 'application/json', filename: 'pass.json' };
    },
  };

  /**
   * Wallet platform providers. Google Wallet when its issuer id and service
   * account are configured; nothing otherwise (the manifest then carries only
   * `preview`). Apple is not in scope yet.
   */
  function walletProviders(): IssuerProvider[] {
    const g = o.google;
    if (!g) return [];
    if (!/^[0-9]{10,}$/.test(g.issuerId)) throw new Error('google.issuerId must be the numeric issuer id from the Pay and Wallet Console (not the merchant id)');
    return [googleFormatProvider({
      client: googleWalletClient({ serviceAccount: g.serviceAccount, issuerId: g.issuerId, ...(g.fetch ? { fetch: g.fetch } : {}) }),
      // A Generic class: works for every Google account at once, no Google review.
      classSuffix: g.classSuffix ?? 'exit_liquidity_pass_v1',
      // Save links are accepted only from the site's own origin.
      origins: saveOrigins([base.origin]),
      store: googleObjectStore,
      // Until the image pack is hosted, image slots without a public https URL are left out rather than failing.
      unhostedImages: 'omit',
      messageFor: () => null, // silent updates; no notifications for now
      onError: (err, where) => log(`[google] ${where}: ${err.message}`),
    })];
  }

  /** Google object records (object id per serial and owner) on SQLite, so they survive restarts. */
  const googleObjectStore: GoogleObjectStore = {
    async get(serial) { const v = await o.db.kv.get('google:obj:' + serial); return v ? JSON.parse(v) as GoogleObjectRecord : null },
    async put(serial, record) { await o.db.kv.set('google:obj:' + serial, JSON.stringify(record)) },
    async delete(serial) { await o.db.kv.del('google:obj:' + serial) },
  };

  const issuer: Issuer = createIssuer({
    domain,
    baseUrl: base.origin,
    chainId: dep.chainId,
    contract: dep.playPass,
    mode: 'gated',
    publicClient,
    providers: [previewProvider, ...walletProviders()],
    // The manifest's optional issuer member: lets a client check the pass it saves comes from our Google issuer.
    ...(o.google ? { manifestIssuer: { google: { issuerId: o.google.issuerId } } } : {}),
    stores: kvStores(o.db.kv, { chainId: dep.chainId, contract: dep.playPass }),
    linkSecret,
    environment: o.environment ?? 'development',
    render: ({ token, owner, serial, superseded, updatedAt }) => renderPass(token.tokenId, owner, serial, !!superseded, updatedAt),
    onError: (err, ctx) => log(`[pass issuer] ${ctx.operation} failed: ${err instanceof Error ? err.message : String(err)}`),
  });
  const issuerNode = toNodeHandler(issuer);

  // ------------------------------------------------- ranked pass binding

  /** A SIWE challenge to bind a ranked run to a pass. Single use, five minutes. */
  async function rankedChallenge(tokenId: string, address: string): Promise<string> {
    if (!/^[1-9][0-9]{0,6}$/.test(tokenId) || !isAddress(address)) throw new Error('bad pass id or address');
    const nonce = generateSiweNonce();
    const issuedAt = new Date(now());
    await o.db.kv.set('ranked-nonce:' + nonce, JSON.stringify({ tokenId, address: getAddress(address) }), { ttlSeconds: 300 });
    return createSiweMessage({
      domain, address: getAddress(address), uri: base.origin + '/', version: '1', chainId: dep.chainId, nonce, issuedAt,
      expirationTime: new Date(issuedAt.getTime() + 300_000),
      statement: `Play a ranked run of Exit Liquidity with pass #${tokenId}.`,
      resources: [`eip155:${dep.chainId}/erc721:${dep.playPass}/${tokenId}`, RANKED_ACTION],
    });
  }

  /**
   * Checks a binding proof: every field against what this server issued, the
   * signature (EOA, ERC-1271 or ERC-6492 through viem), and a fresh ownerOf
   * read at latest. Returns the owner, or an error to show the player.
   */
  async function verifyBinding(tokenId: string, message: string, signature: string): Promise<{ owner: Address } | { error: string }> {
    if (message.length > 2048 || !/^0x[0-9a-fA-F]{2,1000}$/.test(signature)) return { error: 'Bad pass proof.' };
    const m = parseSiweMessage(message);
    if (!m.nonce || !m.address) return { error: 'Bad pass proof.' };
    const issued = await o.db.kv.getDel('ranked-nonce:' + m.nonce); // single use, spent first
    if (!issued) return { error: 'The pass proof expired. Try again.' };
    const rec = JSON.parse(issued) as { tokenId: string; address: Address };
    const want = `eip155:${dep.chainId}/erc721:${dep.playPass}/${tokenId}`;
    if (m.domain !== domain || m.chainId !== dep.chainId || rec.tokenId !== tokenId || getAddress(m.address) !== rec.address ||
      !m.expirationTime || m.expirationTime.getTime() < now() || m.resources?.length !== 2 || m.resources[0] !== want || m.resources[1] !== RANKED_ACTION) {
      return { error: 'The pass proof does not match this pass.' };
    }
    let valid = false;
    try { valid = await publicClient.verifyMessage({ address: rec.address, message, signature: signature as Hex }) } catch { valid = false }
    if (!valid) return { error: 'The pass signature is not valid.' };
    let owner: Address;
    try { owner = await publicClient.readContract({ ...pass, functionName: 'ownerOf', args: [BigInt(tokenId)], blockTag: 'latest' }) }
    catch { return { error: 'Could not read the pass owner from the chain. Try again.' } }
    if (getAddress(owner) !== rec.address) return { error: 'That wallet does not own this pass.' };
    return { owner: rec.address };
  }

  /** EIP-712 RunResult for a bound run that ended. */
  async function signRunResult(r: { passId: string; day: string; attempt: number; receiptHash: Hex; layers: number; bank: number }): Promise<Settlement> {
    const result = { passId: BigInt(r.passId), day: dayNumber(r.day), attempt: r.attempt, receiptHash: r.receiptHash, layers: r.layers, bankCents: BigInt(Math.round(r.bank * 100)) };
    const signature = await account.signTypedData({
      domain: { name: 'ExitLiquidityRunRegistry', version: '1', chainId: dep.chainId, verifyingContract: dep.runRegistry },
      types: { RunResult: [
        { name: 'passId', type: 'uint256' }, { name: 'day', type: 'uint32' }, { name: 'attempt', type: 'uint8' },
        { name: 'receiptHash', type: 'bytes32' }, { name: 'layers', type: 'uint8' }, { name: 'bankCents', type: 'uint64' },
      ] },
      primaryType: 'RunResult',
      message: result,
    });
    return {
      chainId: dep.chainId, registry: dep.runRegistry, signature,
      result: { passId: r.passId, day: result.day, attempt: r.attempt, receiptHash: r.receiptHash, layers: r.layers, bankCents: result.bankCents.toString() },
    };
  }

  // ------------------------------------------------------------- indexer

  let cursor = BigInt(dep.deployBlock);
  let step = 10_000n;
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  const transfer = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)');
  const passUpdate = parseAbiItem('event PassUpdate(uint256 indexed tokenId)');
  const batchUpdate = parseAbiItem('event BatchPassUpdate(uint256 fromTokenId, uint256 toTokenId)');

  async function pollOnce(): Promise<void> {
    const head = await publicClient.getBlockNumber({ cacheTime: 0 }); // viem caches the head for 4 s by default
    while (cursor <= head && !stopped) {
      const to = cursor + step - 1n < head ? cursor + step - 1n : head;
      let logs;
      try {
        logs = await publicClient.getLogs({ address: dep.playPass, events: [transfer, passUpdate, batchUpdate], fromBlock: cursor, toBlock: to });
      } catch (e) {
        if (step > 100n) { step /= 2n; continue } // the RPC may cap ranges
        throw e;
      }
      for (const l of logs) {
        if (l.eventName === 'Transfer') {
          const { from, to: dest, tokenId } = l.args as { from: Address; to: Address; tokenId: bigint };
          o.db.setPassOwner(tokenId.toString(), dest);
          await issuer.onTransfer(tokenId, from, dest).catch((e: unknown) => log(`[pass] onTransfer ${tokenId}: ${String(e)}`));
        } else if (l.eventName === 'PassUpdate') {
          const { tokenId } = l.args as { tokenId: bigint };
          await issuer.onPassUpdate(tokenId, tokenId).catch(() => {});
        } else {
          const { fromTokenId, toTokenId } = l.args as { fromTokenId: bigint; toTokenId: bigint };
          await issuer.onPassUpdate(fromTokenId, toTokenId).catch(() => {});
        }
      }
      cursor = to + 1n;
      if (step < 10_000n) step *= 2n;
    }
  }

  function startIndexer(): void {
    const tick = async () => {
      try { await pollOnce() } catch (e) { log(`[pass] log poll failed: ${e instanceof Error ? e.message : String(e)}`) }
      if (!stopped) timer = setTimeout(tick, o.pollMs ?? 4000);
    };
    void tick();
  }

  /** Passes the indexer saw arrive at `owner`, confirmed by a fresh ownerOf. */
  async function passesOf(owner: string): Promise<{ id: string; style: number; founder: boolean }[]> {
    if (!isAddress(owner)) return [];
    const out = [];
    for (const id of o.db.passesOwnedBy(owner)) {
      try {
        const [who, style, founder] = await Promise.all([
          publicClient.readContract({ ...pass, functionName: 'ownerOf', args: [BigInt(id)] }),
          publicClient.readContract({ ...pass, functionName: 'styleOf', args: [BigInt(id)] }),
          publicClient.readContract({ ...pass, functionName: 'isFounder', args: [BigInt(id)] }),
        ]);
        if (getAddress(who) === getAddress(owner)) out.push({ id, style, founder });
      } catch { /* burned or unreadable: skip */ }
    }
    return out;
  }

  /** Public sale facts for the web client. */
  async function saleInfo() {
    const [price, sale, minted, supply, maxPerWallet, revealed, paymentToken] = await Promise.all([
      publicClient.readContract({ ...pass, functionName: 'price' }),
      publicClient.readContract({ ...pass, functionName: 'sale' }),
      publicClient.readContract({ ...pass, functionName: 'foundersMinted' }),
      publicClient.readContract({ ...pass, functionName: 'FOUNDER_SUPPLY' }),
      publicClient.readContract({ ...pass, functionName: 'MAX_PER_WALLET' }),
      publicClient.readContract({ ...pass, functionName: 'revealed' }),
      publicClient.readContract({ ...pass, functionName: 'paymentToken' }),
    ]);
    return {
      chainId: dep.chainId, chainName: chain.name, explorer: chain.blockExplorers?.default.url ?? null,
      // what a wallet adds for this chain (wallets send transactions through their own RPC, never through /api/rpc)
      walletRpcUrl: dep.chainId === 31337 ? rpcUrl : chain.rpcUrls.default.http[0],
      playPass: dep.playPass, runRegistry: dep.runRegistry, price: price.toString(), paymentToken,
      sale: ['not_started', 'open', 'closed'][sale] ?? 'unknown', minted: Number(minted), supply: Number(supply),
      maxPerWallet: Number(maxPerWallet), revealed,
    };
  }

  // ---------------------------------------------------- seed operator job

  /** Commits today's and tomorrow's seeds, reveals finished days. Only when this key is the registry's operator. */
  async function seedJob(seedFor: (day: string) => { seedHex: string; commitHex: string }, revealedDays: () => string[]): Promise<void> {
    const operator = await publicClient.readContract({ ...registry, functionName: 'seedOperator' });
    if (getAddress(operator) !== account.address) return;
    const today = new Date(now()).toISOString().slice(0, 10);
    const tomorrow = new Date(now() + 86_400_000).toISOString().slice(0, 10);
    for (const day of [today, tomorrow]) {
      const n = dayNumber(day);
      const c = await publicClient.readContract({ ...registry, functionName: 'seedCommit', args: [n] });
      if (c !== '0x0000000000000000000000000000000000000000000000000000000000000000') continue;
      const hash = await wallet.writeContract({ ...registry, functionName: 'commitDailySeed', args: [n, seedFor(day).commitHex as Hex] });
      await publicClient.waitForTransactionReceipt({ hash });
      log(`[pass] committed the seed for ${day}`);
    }
    for (const day of revealedDays()) {
      if (day >= today) continue;
      const n = dayNumber(day);
      const [c, s] = await Promise.all([
        publicClient.readContract({ ...registry, functionName: 'seedCommit', args: [n] }),
        publicClient.readContract({ ...registry, functionName: 'seedOf', args: [n] }),
      ]);
      if (c === '0x0000000000000000000000000000000000000000000000000000000000000000' || s !== '0x0000000000000000000000000000000000000000000000000000000000000000') continue;
      const seed = ('0x' + Buffer.from(parseSeedHex(seedFor(day).seedHex)).toString('hex')) as Hex;
      const hash = await wallet.writeContract({ ...registry, functionName: 'revealDailySeed', args: [n, seed] });
      await publicClient.waitForTransactionReceipt({ hash });
      log(`[pass] revealed the seed for ${day}`);
    }
  }

  // ------------------------------------------------------------ RPC proxy

  const RPC_METHODS = new Set(['eth_chainId', 'eth_blockNumber', 'eth_call', 'eth_getTransactionReceipt', 'eth_getCode', 'eth_getBalance', 'eth_estimateGas', 'eth_gasPrice', 'eth_maxPriorityFeePerGas', 'eth_getBlockByNumber', 'eth_feeHistory', 'eth_getTransactionCount']);

  /**
   * Read-only JSON-RPC proxy for the browser, so pages read the chain
   * through this origin and the visitor's IP does not reach the RPC
   * provider. Writes go through the visitor's own wallet, never here.
   */
  async function rpcProxy(body: string): Promise<{ status: number; body: string }> {
    let req: { jsonrpc?: string; id?: unknown; method?: unknown; params?: unknown };
    try { req = JSON.parse(body) } catch { return { status: 400, body: '{"error":"bad json"}' } }
    if (Array.isArray(req) || typeof req.method !== 'string' || !RPC_METHODS.has(req.method)) {
      return { status: 403, body: JSON.stringify({ jsonrpc: '2.0', id: req?.id ?? null, error: { code: -32601, message: 'method not allowed' } }) };
    }
    const r = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: req.id ?? 1, method: req.method, params: req.params ?? [] }) });
    return { status: r.status, body: await r.text() };
  }

  return {
    issuer, publicClient, account, deployment: dep, chain, domain,
    /** Handles /wallet-pass/*. */
    handleNode(req: IncomingMessage, res: ServerResponse): void { void issuerNode(req as never, res as never) },
    renderPass, rankedChallenge, verifyBinding, signRunResult, passesOf, saleInfo, seedJob, rpcProxy,
    startIndexer, pollOnce,
    stop(): void { stopped = true; if (timer) clearTimeout(timer) },
  };
}

export type PassService = ReturnType<typeof createPassService>;
