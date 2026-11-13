// M2 end to end on a local chain: deploy with the real deploy script, mint,
// unlock the gated pass with @erc8426/client, bind a ranked run to the pass,
// settle it on chain, watch the card change, reveal styles, transfer.
// Needs Foundry (anvil, forge) on PATH; skipped otherwise.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer as netServer } from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import WebSocket from 'ws';
import { createPublicClient, createWalletClient, http, keccak256, parseAbi, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createWalletPassClient, WalletPassClientError } from '@erc8426/client';
import type { PassContent } from '@erc8426/core';
import { PROTOCOL_VERSION, type ServerMsg } from '@exit-liquidity/engine';
import { startServer, type RunServer } from '../src/server.ts';
import { createPassService, loadDeployment, playPassAbi, runRegistryAbi, STYLE_COLORS, dayNumber } from '../src/pass.ts';
import { utcDay } from '../src/seeds.ts';

const PATH = `${homedir()}/.local/bin:${process.env.PATH}`;
const hasFoundry = spawnSync('anvil', ['--version'], { env: { ...process.env, PATH } }).status === 0;
const contracts = resolve(__dirname, '../../../contracts');

// anvil's well known dev keys
const KEYS = {
  owner: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  alice: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  server: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  bob: '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
} as const;
const SECRET = '0x' + '5e'.repeat(32) as Hex;

function freePort(): Promise<number> {
  return new Promise((r) => { const s = netServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => r(p)) }) });
}

describe.skipIf(!hasFoundry)('the pass, end to end on a local chain', () => {
  let anvil: ChildProcess;
  let srv: RunServer;
  let dir: string;
  let rpc: string;
  let dep: ReturnType<typeof loadDeployment>;
  const acct = Object.fromEntries(Object.entries(KEYS).map(([k, v]) => [k, privateKeyToAccount(v as Hex)])) as Record<keyof typeof KEYS, ReturnType<typeof privateKeyToAccount>>;
  let pub: ReturnType<typeof createPublicClient>;
  const wallet = (who: keyof typeof KEYS) => createWalletClient({ account: acct[who], transport: http(rpc), chain: { id: 31337, name: 'anvil', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } } });

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'exitliq-pass-'));
    const chainPort = await freePort();
    const port = await freePort();
    rpc = `http://127.0.0.1:${chainPort}`;
    anvil = spawn('anvil', ['--port', String(chainPort), '--silent'], { env: { ...process.env, PATH } });
    pub = createPublicClient({ transport: http(rpc) });
    for (let k = 0; k < 50; k++) { try { await pub.getChainId(); break } catch { await new Promise((r) => setTimeout(r, 100)) } }
    const deploy = spawnSync('forge', ['script', 'script/Deploy.s.sol', '--rpc-url', rpc, '--broadcast', '--private-key', KEYS.owner], {
      cwd: contracts, encoding: 'utf8',
      env: { ...process.env, PATH, SERVER_SIGNER: acct.server.address, SEED_OPERATOR: acct.server.address, OPEN_SALE: 'true',
        STYLE_SECRET_COMMIT: keccak256(SECRET), PASS_BASE_URI: `http://127.0.0.1:${port}/wallet-pass/`, MINT_PRICE_WEI: '3000000000000000' },
    });
    if (deploy.status !== 0) throw new Error('deploy failed: ' + deploy.stdout + deploy.stderr);
    dep = loadDeployment(join(contracts, 'deployments/31337.json'));
    srv = await startServer({
      port, dbPath: join(dir, 'db'), signerKeyPath: join(dir, 'k.pem'), tickMs: 0, idleMs: 0, maxMsgsPerSec: 1000, seedJobMs: 0, log: () => {},
      pass: (db) => createPassService({ db, deployment: dep, rpcUrl: rpc, baseUrl: `http://127.0.0.1:${port}`, chainKey: KEYS.server, linkSecret: 'x'.repeat(40), pollMs: 100_000, log: () => {} }),
    });
  }, 120_000);

  afterAll(async () => {
    await srv?.close();
    anvil?.kill();
    rmSync(dir, { recursive: true, force: true });
  });

  const passes = () => createWalletPassClient({ publicClient: pub as never });
  async function card(who: keyof typeof KEYS, tokenId: bigint): Promise<PassContent & { owner: Address }> {
    const r = await passes().getManifest({ contract: dep.playPass, tokenId }, { signer: acct[who] as never });
    const url = r.manifest.formats.preview as string;
    expect(Object.keys(r.manifest.formats)).toEqual(['preview']);
    const res = await fetch(url);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    return res.json();
  }
  const field = (c: PassContent, key: string) => [...(c.primary ?? []), ...(c.secondary ?? []), ...(c.auxiliary ?? []), ...(c.back ?? []), ...(c.header ?? [])].find((f) => f.key === key)?.value;

  it('mints, lists, and serves the gated pass with a neutral unrevealed card', async () => {
    const price = await pub.readContract({ address: dep.playPass, abi: playPassAbi, functionName: 'price' });
    const tx = await wallet('alice').writeContract({ address: dep.playPass, abi: playPassAbi, functionName: 'mint', args: [2n, price], value: price * 2n });
    await pub.waitForTransactionReceipt({ hash: tx });
    await srv.pass!.pollOnce();
    const list = await (await fetch(`${srv.url}/api/passes/${acct.alice.address}`)).json();
    expect(list.passes.map((p: { id: string }) => p.id)).toEqual(['1', '2']);
    const info = await (await fetch(`${srv.url}/api/chain`)).json();
    expect(info).toMatchObject({ chainId: 31337, sale: 'open', minted: 2, supply: 2222, maxPerWallet: 3 });

    // ERC-8426 gated configuration: no proof, 401 with a challenge and no URLs
    expect(await pub.readContract({ address: dep.playPass, abi: playPassAbi, functionName: 'passURI', args: [1n] })).toBe(`${srv.url}/wallet-pass/1`);
    const bare = await fetch(`${srv.url}/wallet-pass/1`);
    expect(bare.status).toBe(401);
    const body = await bare.json();
    expect(body.error).toBe('proof_required');
    expect(body.challenge).toBeTruthy();
    expect(JSON.stringify(body)).not.toMatch(/formats|passes\//);

    const c = await card('alice', 1n);
    expect(c.title).toBe('EXIT LIQUIDITY');
    expect(c.headline).toBe('FOUNDER PASS');
    expect(field(c, 'style')).toBe('Unrevealed');
    expect(field(c, 'best')).toBe('No settled run');
    expect(field(c, 'founder')).toBe('Yes');
    expect(c.colors).toEqual(STYLE_COLORS[255]);
    expect(c.owner).toBe(acct.alice.address);
    expect(c.links).toEqual([{ key: 'play', label: 'Play Exit Liquidity', url: `${srv.url}/` }]);

    // someone else's proof is refused with 403 not_owner, nothing else
    await expect(card('bob', 1n)).rejects.toSatisfy((e: unknown) => e instanceof WalletPassClientError && e.code === 'not_owner');
  });

  it('commits the daily seed on chain as the seed operator', async () => {
    await srv.runSeedJob();
    const day = dayNumber(utcDay(Date.now()));
    const commit = await pub.readContract({ address: dep.runRegistry, abi: runRegistryAbi, functionName: 'seedCommit', args: [day] });
    const api = await (await fetch(`${srv.url}/api/commit/${utcDay(Date.now())}`)).json();
    expect(commit).toBe(api.commit);
    expect(await pub.readContract({ address: dep.runRegistry, abi: runRegistryAbi, functionName: 'seedCommit', args: [day + 1] })).not.toBe('0x' + '00'.repeat(32));
  });

  async function boundRun(who: keyof typeof KEYS, tokenId: string, signWith: keyof typeof KEYS = who, name = 'player_' + who) {
    const { message } = await (await fetch(`${srv.url}/api/pass-challenge?pass=${tokenId}&address=${acct[who].address}`)).json();
    const signature = await acct[signWith].signMessage({ message });
    const ws = new WebSocket(srv.url.replace('http', 'ws') + '/ws');
    const msgs: ServerMsg[] = [];
    await new Promise((r) => ws.once('open', r));
    return await new Promise<{ msgs: ServerMsg[]; settlement?: Extract<ServerMsg, { t: 'settlement' }>; error?: string }>((done) => {
      ws.on('message', (d) => {
        const m = JSON.parse(String(d)) as ServerMsg;
        msgs.push(m);
        if (m.t === 'error') { done({ msgs, error: m.code + ': ' + m.msg }); ws.close() }
        if (m.t === 'snap' && (m.v.phase === 'intro')) ws.send(JSON.stringify({ t: 'go' }));
        if (m.t === 'snap' && (m.v.phase === 'shop')) ws.send(JSON.stringify({ t: 'next' }));
        if (m.t === 'settlement') { done({ msgs, settlement: m }); ws.close() }
      });
      ws.send(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, name, lite: true, pass: { id: tokenId, message, signature } }));
    });
  }

  it('binds a ranked run to a pass, settles it on chain, and the card updates', async () => {
    const r = await boundRun('alice', '1');
    expect(r.error).toBeUndefined();
    const welcome = r.msgs.find((m) => m.t === 'welcome') as Extract<ServerMsg, { t: 'welcome' }>;
    expect(welcome.pass).toEqual({ id: '1', attempt: 1 });
    const end = r.msgs.find((m) => m.t === 'end') as Extract<ServerMsg, { t: 'end' }>;
    const s = r.settlement!;
    expect(s.result).toMatchObject({ passId: '1', attempt: 1, receiptHash: end.attestation.receiptHash, layers: end.receipt.result.layers, bankCents: String(Math.round(end.receipt.result.bank * 100)) });

    const args = [{ passId: BigInt(s.result.passId), day: s.result.day, attempt: s.result.attempt, receiptHash: s.result.receiptHash, layers: s.result.layers, bankCents: BigInt(s.result.bankCents) }, s.signature] as const;
    // only the pass owner (or a relayer) may submit it
    await expect(wallet('bob').writeContract({ address: dep.runRegistry, abi: runRegistryAbi, functionName: 'settle', args })).rejects.toThrow();
    const tx = await wallet('alice').writeContract({ address: dep.runRegistry, abi: runRegistryAbi, functionName: 'settle', args });
    const rcpt = await pub.waitForTransactionReceipt({ hash: tx });
    expect(rcpt.status).toBe('success');
    // the settle signalled the pass
    const passUpdates = rcpt.logs.filter((l) => l.address.toLowerCase() === dep.playPass.toLowerCase());
    expect(passUpdates.length).toBe(1);
    // replay is refused
    await expect(wallet('alice').writeContract({ address: dep.runRegistry, abi: runRegistryAbi, functionName: 'settle', args })).rejects.toThrow();

    await srv.pass!.pollOnce();
    const c = await card('alice', 1n);
    expect(field(c, 'best')).toBe(`${s.result.layers} of 8`);
    expect(field(c, 'runs')).toBe('1');
    expect(field(c, 'settled')).toBe('1');
    expect(field(c, 'bank')).toBe('$' + (Number(s.result.bankCents) / 100).toFixed(2));
  }, 60_000);

  it('refuses a binding proof from a wallet that does not own the pass, and a reused proof', async () => {
    const wrongSigner = await boundRun('alice', '2', 'bob', 'mallory');
    expect(wrongSigner.error).toMatch(/^pass: /);
    const notOwner = await boundRun('bob', '1', 'bob', 'bobby');
    expect(notOwner.error).toMatch(/does not own/);
    // a proof can be used once
    const { message } = await (await fetch(`${srv.url}/api/pass-challenge?pass=2&address=${acct.alice.address}`)).json();
    const signature = await acct.alice.signMessage({ message });
    const hello = (name: string) => new Promise<ServerMsg>((done) => {
      const ws = new WebSocket(srv.url.replace('http', 'ws') + '/ws');
      ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, name, lite: true, pass: { id: '2', message, signature } })));
      ws.on('message', (d) => { const m = JSON.parse(String(d)); if (m.t === 'welcome' || m.t === 'error') { done(m); ws.close() } });
    });
    expect((await hello('first')).t).toBe('welcome');
    expect(await hello('second')).toMatchObject({ t: 'error', code: 'pass' });
  }, 60_000);

  it('reveals styles after the sale closes and every card takes its style colors', async () => {
    const owner = wallet('owner');
    const w = async (fn: string, args: unknown[] = []) => pub.waitForTransactionReceipt({ hash: await owner.writeContract({ address: dep.playPass, abi: parseAbi([`function ${fn}`] as never) as never, functionName: fn.split('(')[0] as never, args: args as never }) });
    await w('closeSale()');
    await w('revealStyleSecret(bytes32)', [SECRET]);
    await pub.request({ method: 'anvil_mine' as never, params: ['0x16'] as never });
    const fin = await w('finalizeStyles()');
    expect(fin.status).toBe('success');
    await srv.pass!.pollOnce();
    for (const id of [1n, 2n]) {
      const style = await pub.readContract({ address: dep.playPass, abi: playPassAbi, functionName: 'styleOf', args: [id] });
      expect(style).toBeLessThan(6);
      const c = await card('alice', id);
      expect(c.colors).toEqual(STYLE_COLORS[style]);
      expect(field(c, 'style')).not.toBe('Unrevealed');
    }
  }, 60_000);

  it('a transfer moves the pass: the old owner is refused, the new owner gets a fresh card', async () => {
    const tx = await wallet('alice').writeContract({ address: dep.playPass, abi: parseAbi(['function transferFrom(address,address,uint256)']), functionName: 'transferFrom', args: [acct.alice.address, acct.bob.address, 1n] });
    await pub.waitForTransactionReceipt({ hash: tx });
    await srv.pass!.pollOnce();
    await expect(card('alice', 1n)).rejects.toSatisfy((e: unknown) => e instanceof WalletPassClientError && e.code === 'not_owner');
    const c = await card('bob', 1n);
    expect(c.owner).toBe(acct.bob.address);
    const list = await (await fetch(`${srv.url}/api/passes/${acct.bob.address}`)).json();
    expect(list.passes.map((p: { id: string }) => p.id)).toEqual(['1']);
    // the results stay with the pass
    expect(field(c, 'settled')).toBe('1');
  }, 60_000);

  it('the browser RPC proxy forwards reads only', async () => {
    const call = (method: string, params: unknown[] = []) => fetch(`${srv.url}/api/rpc`, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    const ok = await call('eth_chainId');
    expect((await ok.json()).result).toBe('0x7a69');
    for (const m of ['eth_sendRawTransaction', 'eth_sendTransaction', 'eth_accounts', 'anvil_setBalance', 'eth_sign', 'debug_traceTransaction']) {
      expect((await call(m)).status).toBe(403);
    }
    void readFileSync;
  });
});
