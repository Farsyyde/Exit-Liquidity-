import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROTOCOL_VERSION, type ServerMsg, type RankedReceipt, type Attestation } from '@exit-liquidity/engine';
import { startServer, type RunServer } from '../src/server.ts';
import { verifyRanked } from '../src/verify.ts';
import { utcDay } from '../src/seeds.ts';
import { runExit } from '../src/exit-run.ts';
import { headlineType } from '../src/headlines.ts';

const NOON = Date.UTC(2026, 10, 12, 12);
let offset = 0;
const now = () => NOON + offset;
let dir: string;
let srv: RunServer;

class Client {
  ws: WebSocket;
  q: ServerMsg[] = [];
  waiters: (() => void)[] = [];
  closed = false;
  constructor(url: string) {
    this.ws = new WebSocket(url.replace('http', 'ws') + '/ws');
    this.ws.on('message', (d) => { this.q.push(JSON.parse(String(d))); this.waiters.splice(0).forEach((w) => w()) });
    this.ws.on('close', () => { this.closed = true; this.waiters.splice(0).forEach((w) => w()) });
  }
  open(): Promise<void> { return new Promise((r) => this.ws.once('open', () => r())) }
  send(m: unknown): void { this.ws.send(JSON.stringify(m)) }
  /** Next message matching pred, discarding others. */
  async next<T extends ServerMsg['t']>(t: T, pred: (m: Extract<ServerMsg, { t: T }>) => boolean = () => true, ms = 10000): Promise<Extract<ServerMsg, { t: T }>> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      while (this.q.length) {
        const m = this.q.shift()!;
        if (m.t === t && pred(m as never)) return m as never;
      }
      if (this.closed) throw new Error('closed while waiting for ' + t);
      await new Promise<void>((r) => { this.waiters.push(r); setTimeout(r, 50) });
    }
    throw new Error('timeout waiting for ' + t);
  }
  close(): void { this.ws.close() }
}

async function hello(name: string, token?: string, lite = true, resume = false): Promise<{ c: Client; welcome: Extract<ServerMsg, { t: 'welcome' }> }> {
  const c = new Client(srv.url);
  await c.open();
  c.send({ t: 'hello', v: PROTOCOL_VERSION, name, token, lite, resume });
  const welcome = await c.next('welcome');
  return { c, welcome };
}

/** Plays a run to the end with a simple policy. Holds whatever it buys. */
async function playOut(c: Client, opts: { buyFirstOffer?: boolean } = {}): Promise<{ receipt: RankedReceipt; attestation: Attestation; inds: string[] }> {
  let inds: string[] = [];
  c.send({ t: 'go' });
  let n = 0;
  while (true) {
    const m = c.q.shift() ?? (await new Promise<void>((r) => { c.waiters.push(r); setTimeout(r, 50) }), undefined);
    if (!m) { if (c.closed) throw new Error('closed'); continue }
    if (m.t === 'snap') {
      inds = m.v.inds;
      if (m.v.phase === 'shop') {
        if (opts.buyFirstOffer) for (const o of m.v.offers) if (!o.con) { c.send({ t: 'shop', code: 'buy:' + o.id }); break }
        c.send({ t: 'next' });
      } else if (m.v.phase === 'intro') c.send({ t: 'go' });
    } else if (m.t === 'tick' && 's' in m) {
      // headline trader: buy pump headlines, sell 50 ticks later, lock in when ready
      n = m.s.pos ? n + 1 : 0;
      if (m.ev.some((e) => e.k === 'headline' && headlineType(e.text) === 'pump') && !m.s.pos) c.send({ t: 'press', b: 'buy' });
      else if (m.s.pos && n === 50) c.send({ t: 'press', b: 'sell' });
      else if (m.s.ready) c.send({ t: 'press', b: 'lock' });
    } else if (m.t === 'end') return { receipt: m.receipt, attestation: m.attestation, inds };
  }
}

beforeEach(async () => {
  offset = 0;
  dir = mkdtempSync(join(tmpdir(), 'exitliq-test-'));
  srv = await startServer({ dbPath: join(dir, 'db.sqlite'), signerKeyPath: join(dir, 'k.pem'), tickMs: 0, attemptsPerDay: 2, idleMs: 0, maxMsgsPerSec: 500, now, log: () => {} });
});
afterEach(async () => { await srv.close(); rmSync(dir, { recursive: true, force: true }) });

describe('run server', () => {
  it('plays a ranked run end to end and the result verifies after the reveal', async () => {
    const day = utcDay(now());
    const commit = (await (await fetch(`${srv.url}/api/commit/${day}`)).json()).commit as string;
    const { c, welcome } = await hello('alice');
    expect(welcome.attempt).toBe(1);
    expect(welcome.commit).toBe(commit);
    const first = await c.next('snap');
    expect(first.v.phase).toBe('intro');
    expect(JSON.stringify(first)).not.toMatch(/"seed"/); // no seed before the end
    const { receipt, attestation } = await playOut(c);
    c.close();
    expect(receipt.ranked).toEqual({ day, player: welcome.player, attempt: 1 });

    // before the day closes the seed and receipts stay private
    expect((await fetch(`${srv.url}/api/seed/${day}`)).status).toBe(403);
    expect((await fetch(`${srv.url}/api/runs/${day}`)).status).toBe(403);
    const board = await (await fetch(`${srv.url}/api/leaderboard`)).json();
    expect(board.rows[0]).toMatchObject({ name: 'alice', layers: receipt.result.layers, bank: receipt.result.bank });

    offset += 86_400_000;
    const seed = await (await fetch(`${srv.url}/api/seed/${day}`)).json();
    expect(seed.commit).toBe(commit);
    const out = verifyRanked({ receipt, attestation, dailySeed: seed.seed, commit, signer: srv.signer });
    expect(out.problems).toEqual([]);
    const pub = await (await fetch(`${srv.url}/api/runs/${day}`)).json();
    expect(pub.runs).toHaveLength(1);
    expect(pub.runs[0].receipt).toEqual(receipt);
  });

  it('caps attempts per day and protects names with a token', async () => {
    const a = await hello('bob');
    const token = a.welcome.token;
    await playOut(a.c); a.c.close();
    // someone else cannot take the name
    const thief = new Client(srv.url); await thief.open();
    thief.send({ t: 'hello', v: PROTOCOL_VERSION, name: 'BOB', lite: true });
    expect((await thief.next('error')).code).toBe('name');
    const b = await hello('bob', token);
    expect(b.welcome.attempt).toBe(2);
    expect(b.welcome.attemptsLeft).toBe(0);
    await playOut(b.c); b.c.close();
    const c3 = new Client(srv.url); await c3.open();
    c3.send({ t: 'hello', v: PROTOCOL_VERSION, name: 'bob', token, lite: true });
    expect((await c3.next('error')).code).toBe('attempts');
    // next UTC day, attempts reset
    offset += 86_400_000;
    const d = await hello('bob', token);
    expect(d.welcome.attempt).toBe(1);
    d.c.close();
  });

  it('mints only an indicator held at run end, once per run, and the next run starts with it', async () => {
    await srv.close();
    srv = await startServer({ dbPath: join(dir, 'db2.sqlite'), tickMs: 3, attemptsPerDay: 2, idleMs: 0, maxMsgsPerSec: 500, now, log: () => {} });
    let held: string[] = [];
    let token = '';
    for (let tries = 0; tries < 12 && !held.length; tries++) {
      offset += 86_400_000; // fresh day, fresh attempts, new chart
      const { c, welcome } = await hello('dave', token || undefined);
      token = welcome.token;
      const r = await playOut(c, { buyFirstOffer: true });
      held = r.inds;
      if (!held.length) { c.send({ t: 'mint', id: 'diamond' }); expect((await c.next('error')).code).toBe('mint'); c.close(); continue }
      const notHeld = ['diamond', 'paper', 'vwap', 'insider'].find((x) => !held.includes(x))!;
      c.send({ t: 'mint', id: notHeld });
      expect((await c.next('error')).code).toBe('mint');
      c.send({ t: 'mint', id: held[0] });
      expect(await c.next('minted')).toMatchObject({ id: held[0], runs: 3 });
      c.send({ t: 'mint', id: held[0] });
      expect((await c.next('error')).msg).toMatch(/already/);
      c.close();
      const n = await hello('dave', token);
      expect(n.welcome.mint).toBe(held[0]);
      const snap = await n.c.next('snap');
      expect(snap.v.nft).toBe(held[0]);
      n.c.close();
    }
    // A run that never clears layer 1 holds nothing. This test needs one that does.
    expect(held.length).toBeGreaterThan(0);
  }, 120_000);

  it('rejects garbage and floods', async () => {
    const c = new Client(srv.url); await c.open();
    c.send({ t: 'press', b: 'buy' });
    expect((await c.next('error')).code).toBe('bad');
    const d = new Client(srv.url); await d.open();
    d.send({ t: 'hello', v: 999, name: 'x1' });
    expect((await d.next('error')).code).toBe('version');
    const e = await hello('erin');
    for (let k = 0; k < 600; k++) e.c.send({ t: 'press', b: 'lock' });
    expect((await e.c.next('error')).code).toBe('rate');
  });
});

describe('M1 exit harness (small)', () => {
  it('verifier reproduces every server result', async () => {
    await srv.close(); // the harness runs its own server
    srv = await startServer({ dbPath: ':memory:', now, log: () => {} });
    const s = await runExit({ runs: 24, concurrency: 8, tickMs: 2 });
    expect(s.stored).toBe(24);
    expect(s.botErrors).toEqual([]);
    expect(s.botMismatches).toBe(0);
    expect(s.verifierExit).toBe(0);
    expect(s.verifierSummary).toContain('24/24 runs verified');
  });
});

describe('reconnect', () => {
  const TICK = 5;
  beforeEach(async () => {
    await srv.close();
    srv = await startServer({ dbPath: join(dir, 'rc.sqlite'), tickMs: TICK, attemptsPerDay: 3, idleMs: 400, maxMsgsPerSec: 500, now, log: () => {} });
  });
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const runsToday = () => (srv.db.raw.prepare('SELECT COUNT(*) AS n FROM runs').get() as { n: number }).n;

  it('the run keeps going while the player is away, and resumes from a full snapshot', async () => {
    const day = utcDay(now());
    const a = await hello('frank', undefined, false);
    await a.c.next('snap');
    a.c.send({ t: 'go' });
    const before = await a.c.next('tick', (m) => m.k >= 15);
    a.c.send({ t: 'press', b: 'buy' }); // an input before the drop
    await a.c.next('snap', (m) => !!m.v.pos);
    a.c.close();
    const away = 200;
    const t0 = Date.now();
    await sleep(away);
    const b = await hello('frank', a.welcome.token, false, true);
    expect(b.welcome.resumed).toBe(true);
    expect(b.welcome.attempt).toBe(1);
    const snap = await b.c.next('snap');
    const elapsedTicks = (Date.now() - t0) / TICK;
    const k = snap.v.level.dur - snap.v.left;
    // the clock did not pause: about away/TICK ticks passed (timers are coarse, so allow slack)
    expect(k - before.k).toBeGreaterThan((away / TICK) * 0.6);
    expect(k - before.k).toBeLessThanOrEqual(elapsedTicks + 5);
    // full snapshot: the whole chart history and the open position
    expect(snap.v.candles.length).toBeGreaterThan(40);
    expect(snap.v.pos).not.toBeNull();
    // and it is live: ticks keep arriving, inputs after the resume count
    const t1 = await b.c.next('tick', (m) => 'v' in m && m.k > k);
    expect(t1.k).toBeGreaterThan(k);
    b.c.send({ t: 'press', b: 'sell' });
    const r = await playOut(b.c);
    expect(r.receipt.log.filter((e) => e[0] === 0 && e[1] >= 0).length).toBeGreaterThanOrEqual(2);
    expect(runsToday()).toBe(1); // no extra attempt was used
    offset += 86_400_000;
    const seed = await (await fetch(`${srv.url}/api/seed/${day}`)).json();
    expect(verifyRanked({ ...r, dailySeed: seed.seed, signer: srv.signer }).problems).toEqual([]);
  });

  it('a plain hello during a live run resumes it instead of starting a new attempt', async () => {
    const a = await hello('gina');
    await a.c.next('snap'); a.c.send({ t: 'go' }); await a.c.next('tick');
    a.c.close();
    const b = await hello('gina', a.welcome.token);
    expect(b.welcome.resumed).toBe(true);
    expect(b.welcome.attempt).toBe(1);
    expect(runsToday()).toBe(1);
    b.c.close();
  });

  it('resume with nothing to resume is refused and uses no attempt', async () => {
    const a = await hello('hank');
    await playOut(a.c); a.c.close();
    await sleep(20);
    const c = new Client(srv.url); await c.open();
    c.send({ t: 'hello', v: PROTOCOL_VERSION, name: 'ivy', resume: true, lite: true });
    expect((await c.next('error')).code).toBe('resume');
    expect(runsToday()).toBe(1);
  });

  it('a second connection takes over the run and the first is told why', async () => {
    const a = await hello('jack');
    await a.c.next('snap'); a.c.send({ t: 'go' }); await a.c.next('tick');
    const b = await hello('jack', a.welcome.token);
    expect(b.welcome.resumed).toBe(true);
    expect((await a.c.next('error')).code).toBe('replaced');
    await b.c.next('tick');
    b.c.close();
  });

  it('a run that ends while the player is away hands over its result on resume', async () => {
    const a = await hello('kim');
    await a.c.next('snap'); a.c.send({ t: 'go' }); await a.c.next('tick');
    a.c.close();
    for (let k = 0; k < 400 && srv.liveCount(); k++) await sleep(25); // plays out (level timeout, then idle in the shop)
    expect(srv.liveCount()).toBe(0);
    const b = await hello('kim', a.welcome.token, true, true);
    expect(b.welcome.resumed).toBe(true);
    const snap = await b.c.next('snap');
    expect(snap.v.phase).toBe('end');
    const end = await b.c.next('end');
    const row = srv.db.run(end.run)!;
    expect(row.receipt_json).toBe(JSON.stringify(end.receipt));
    b.c.close();
  });
});
