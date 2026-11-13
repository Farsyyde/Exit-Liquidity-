// M2 in a real browser: the built site and run server against a local chain
// (anvil), with a scripted EIP-1193 wallet injected into the page. Connect,
// mint, open the card, bind a ranked run, play it, settle it, see the card
// update. Also records every request the page makes, to prove it talks to no
// third party. Needs Foundry and Playwright's Chromium.
//
//   node scripts/pass-e2e.mjs

import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'apps/server/package.json'));
const { chromium } = createRequire(import.meta.url)('playwright');
const { createWalletClient, createPublicClient, http, keccak256 } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');

const PATH = `${homedir()}/.local/bin:${process.env.PATH}`;
const OUT = process.argv[2] ?? tmpdir();
const KEYS = {
  owner: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  alice: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  server: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
};
const chainPort = 18545, port = 18787, rpc = `http://127.0.0.1:${chainPort}`, site = `http://127.0.0.1:${port}`;
const dir = mkdtempSync(join(tmpdir(), 'exitliq-e2e-'));
const procs = [];
const cleanup = () => { for (const p of procs) p.kill(); rmSync(dir, { recursive: true, force: true }) };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = false;
const check = (ok, what) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) failed = true };

try {
  procs.push(spawn('anvil', ['--port', String(chainPort), '--silent'], { env: { ...process.env, PATH } }));
  const pub = createPublicClient({ transport: http(rpc) });
  for (let k = 0; k < 50; k++) { try { await pub.getChainId(); break } catch { await sleep(100) } }
  const server = privateKeyToAccount(KEYS.server);
  const d = spawnSync('forge', ['script', 'script/Deploy.s.sol', '--rpc-url', rpc, '--broadcast', '--private-key', KEYS.owner], {
    cwd: join(root, 'contracts'), encoding: 'utf8',
    env: { ...process.env, PATH, SERVER_SIGNER: server.address, SEED_OPERATOR: server.address, OPEN_SALE: 'true',
      STYLE_SECRET_COMMIT: keccak256('0x' + '5e'.repeat(32)), PASS_BASE_URI: `${site}/wallet-pass/` },
  });
  if (d.status !== 0) throw new Error('deploy failed\n' + d.stdout + d.stderr);
  if (spawnSync('pnpm', ['build:web'], { cwd: root, stdio: 'ignore' }).status !== 0) throw new Error('web build failed');
  const srv = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    cwd: join(root, 'apps/server'),
    env: { ...process.env, PORT: String(port), EXITLIQ_DB: join(dir, 'db'), EXITLIQ_SIGNER_KEY: join(dir, 'k.pem'), EXITLIQ_TICK_MS: '8',
      EXITLIQ_DEPLOYMENT: join(root, 'contracts/deployments/31337.json'), EXITLIQ_RPC_URL: rpc, EXITLIQ_CHAIN_KEY: KEYS.server, EXITLIQ_BASE_URL: site, EXITLIQ_LINK_SECRET: 'e2e-'.repeat(10) },
  });
  procs.push(srv);
  srv.stdout.on('data', (b) => process.env.E2E_VERBOSE && process.stdout.write('[server] ' + b));
  srv.stderr.on('data', (b) => process.stdout.write('[server] ' + b));
  for (let k = 0; k < 100; k++) { try { if ((await fetch(site + '/api/chain')).ok) break } catch {} await sleep(200) }

  // The wallet: a viem account in Node, reached from the page through an exposed function.
  const alice = privateKeyToAccount(KEYS.alice);
  const wallet = createWalletClient({ account: alice, transport: http(rpc), chain: { id: 31337, name: 'anvil', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } } });
  const prompts = [];
  async function walletRequest(method, params) {
    prompts.push(method);
    switch (method) {
      case 'eth_requestAccounts': case 'eth_accounts': return [alice.address];
      case 'eth_chainId': return '0x7a69';
      case 'wallet_switchEthereumChain': return null;
      case 'personal_sign': return alice.signMessage({ message: { raw: params[0] } });
      case 'eth_sendTransaction': {
        const t = params[0];
        return wallet.sendTransaction({ to: t.to, data: t.data, value: t.value ? BigInt(t.value) : 0n, ...(t.gas ? { gas: BigInt(t.gas) } : {}) });
      }
      default: {
        const r = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
        const j = await r.json();
        if (j.error) throw Object.assign(new Error(j.error.message), { code: j.error.code });
        return j.result;
      }
    }
  }

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
  const hosts = new Set();
  page.on('request', (r) => hosts.add(new URL(r.url()).host));
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.exposeFunction('__wallet', async (method, params) => {
    try { return { result: await walletRequest(method, params ?? []) } } catch (e) { return { error: { code: e.code ?? -32603, message: String(e.message ?? e) } } }
  });
  await page.addInitScript(() => {
    window.ethereum = {
      async request({ method, params }) {
        const r = await window.__wallet(method, params);
        if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
        return r.result;
      },
      on() {}, removeListener() {},
    };
  });

  await page.goto(site + '/');
  await page.click('[data-act=mypass]');
  await page.click('[data-act=connect]');
  await page.waitForSelector('[data-act=passmint][data-q="2"]');
  check(/0 of 2222/.test(await page.textContent('#modal')), 'sale info shows 0 of 2222 minted');
  await page.click('[data-act=passmint][data-q="2"]');
  await page.waitForSelector('[data-act=passcard][data-id="2"]', { timeout: 30000 });
  check(true, 'minted 2 passes from the page; both listed');
  await page.click('[data-act=passcard][data-id="1"]');
  await page.waitForFunction(() => document.querySelector('#card-1 .passcard .phead')?.textContent === 'FOUNDER PASS', null, { timeout: 30000 });
  const before = await page.textContent('#card-1');
  check(/No settled run/.test(before) && /Unrevealed/.test(before), 'card drawn from the gated preview: unrevealed, no settled run');
  await page.screenshot({ path: join(OUT, 'pass-card.png') });

  await page.click('[data-act=bindpass][data-id="1"]');
  await page.fill('#rname', 'Pass Holder');
  await page.click('[data-act=enter]');
  await page.waitForSelector('[data-act=trade]', { timeout: 30000 });
  check(/RANKED/.test(await page.textContent('#modal')), 'bound ranked run started');
  await page.click('[data-act=trade]');
  // play: buy and sell a few times, then let the clock run out
  for (let k = 0; k < 4; k++) { await sleep(300); await page.keyboard.press('b'); await sleep(400); await page.keyboard.press('s') }
  for (let k = 0; k < 600; k++) {
    const open = '#overlay:not(.hide) ';
    if (await page.$(open + '[data-act=copy]')) break;
    if (await page.$(open + '[data-act=next]')) await page.click(open + '[data-act=next]').catch(() => {});
    else if (await page.$(open + '[data-act=trade]')) await page.click(open + '[data-act=trade]').catch(() => {});
    await sleep(100);
  }
  await page.waitForSelector('[data-act=settle]', { timeout: 30000 });
  check(true, 'run ended; the server signed the result; SETTLE ON CHAIN offered');
  await page.screenshot({ path: join(OUT, 'pass-settle.png') });
  await page.click('[data-act=settle]');
  await page.waitForFunction(() => /Settled on chain/.test(document.getElementById('settleArea')?.textContent ?? '') && !!document.querySelector('#settleArea .passcard'), null, { timeout: 60000 });
  const after = await page.textContent('#settleArea');
  check(/ of 8/.test(after) && /RANKEDRUNS1/.test(after.replace(/\s/g, '')), 'card after settle shows the best layer and one ranked run');
  await page.screenshot({ path: join(OUT, 'pass-after.png') });
  console.log('wallet prompts:', prompts.filter((m) => m === 'personal_sign' || m === 'eth_sendTransaction').join(', '));
  const external = [...hosts].filter((h) => h !== `127.0.0.1:${port}`);
  check(external.length === 0, 'the page contacted no host but this site' + (external.length ? ': ' + external.join(', ') : ''));
  check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await browser.close();

  if (process.env.E2E_CONFORMANCE) {
    // The SDK's conformance suite, against pass #2 (still alice's). Locally the site is plain http, so
    // checks that require https acquisition URLs fail here and pass only behind https.
    const deployment = JSON.parse((await import('node:fs')).readFileSync(join(root, 'contracts/deployments/31337.json'), 'utf8'));
    const c = spawnSync('npx', ['--yes', '@erc8426/conformance@0.4.0', '--rpc', rpc, '--contract', deployment.playPass, '--token', '2', '--nonexistent-token', '999999', '--json'],
      { cwd: dir, encoding: 'utf8', env: { ...process.env, ERC8426_OWNER_KEY: KEYS.alice } });
    try {
      const report = JSON.parse(c.stdout);
      for (const r of report.checks ?? report.results ?? []) console.log(`conformance ${String(r.status ?? r.outcome).padEnd(5)} ${(r.level ?? '').padEnd(6)} ${r.id}${r.detail ? ' : ' + String(r.detail).slice(0, 110) : ''}`);
    } catch { console.log(c.stdout.slice(0, 4000), c.stderr.slice(0, 2000)) }
  }
} catch (e) {
  console.log('FAIL', e.message);
  failed = true;
} finally {
  cleanup();
}
process.exit(failed ? 1 : 0);
