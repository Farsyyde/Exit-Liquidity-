// Ranked run server (M1): HTTP API, WebSocket runs, static web client.
// No wallets, passes, contracts or payments: identity is a name plus a token.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { IND, PROTOCOL_VERSION, type ClientMsg, type ServerMsg } from '@exit-liquidity/engine';
import { openDb, type Db } from './db.ts';
import { commitOf, runSeedOf, parseSeedHex, utcDay } from './seeds.ts';
import { loadOrCreateSigner, type Signer } from './sign.ts';
import { RunSession } from './session.ts';
import type { PassService } from './pass.ts';

export interface ServerOptions {
  port?: number;
  host?: string;
  dbPath?: string;
  signerKeyPath?: string | null;
  /** Milliseconds per tick, on a monotonic clock. 100 in real play. 0 runs ticks back to back (tests only). */
  tickMs?: number;
  attemptsPerDay?: number;
  /** A run left in intro or shop this long without input plays out unattended. */
  idleMs?: number;
  /** Charges a minted indicator gets. */
  mintCharges?: number;
  /** Built web client to serve, if any. */
  staticDir?: string | null;
  /** How long a finished run's result stays available to a resuming client. */
  resumeKeepMs?: number;
  /** Messages a connection may send per second before it is dropped. */
  maxMsgsPerSec?: number;
  /** M2 pass features (issuer, binding, settlement). Absent: the server is exactly the M1 run server. */
  pass?: PassService | ((db: Db) => PassService) | null;
  /** How often the seed operator job runs when the pass is enabled. 0 turns it off. */
  seedJobMs?: number;
  /** Wall clock for UTC days and timestamps. Tick timing never uses it. */
  now?: () => number;
  log?: (msg: string) => void;
}

const NAME = /^[A-Za-z0-9 _.-]{2,24}$/;

export async function startServer(o: ServerOptions = {}) {
  const now = o.now ?? Date.now;
  // Nothing the server logs may carry a seed. Seeds are never passed to log(),
  // and as a backstop any 32 byte hex value is redacted before it is written.
  const rawLog = o.log ?? ((m: string) => console.log(m));
  const log = (m: string) => rawLog(m.replace(/(0x)?[0-9a-fA-F]{64}/g, '[redacted]'));
  const tickMs = o.tickMs ?? 100;
  const cap = o.attemptsPerDay ?? 3;
  const idleMs = o.idleMs ?? 5 * 60_000;
  const charges = o.mintCharges ?? 3;
  const maxMsgs = o.maxMsgsPerSec ?? 40;
  const db: Db = openDb(o.dbPath ?? ':memory:');
  const signer: Signer = loadOrCreateSigner(o.signerKeyPath ?? null);
  const passSvc: PassService | null = typeof o.pass === 'function' ? o.pass(db) : (o.pass ?? null);
  const voided = db.voidLiveRuns(now());
  if (voided) log(`voided ${voided} runs left live by a previous process`);
  /** Runs in progress, by player. One per player at a time. */
  const live = new Map<number, RunSession>();
  /** Finished runs kept a while, so a client that dropped near the end can still get its result. */
  const recent = new Map<number, { s: RunSession; at: number }>();
  const keepMs = o.resumeKeepMs ?? 15 * 60_000;
  function recentFor(player: number): RunSession | undefined {
    for (const [p, r] of recent) if (now() - r.at > keepMs) recent.delete(p);
    return recent.get(player)?.s;
  }

  function daySeed(day: string): { seed: Uint8Array; commit: string } {
    const s = db.seedFor(day, () => {
      const b = randomBytes(32);
      return { seedHex: '0x' + b.toString('hex'), commitHex: commitOf(b) };
    });
    return { seed: parseSeedHex(s.seedHex), commit: s.commitHex };
  }

  // ---------- HTTP ----------

  function json(res: ServerResponse, code: number, body: unknown): void {
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  }

  async function serveStatic(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    if (!o.staticDir) { json(res, 404, { error: 'not found' }); return }
    let p = normalize(path).replace(/^(\.\.[/\\])+/, '');
    if (p === '/' || p === '') p = '/index.html';
    const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.json': 'application/json' };
    try {
      const body = await readFile(join(o.staticDir, p));
      res.writeHead(200, { 'content-type': types[extname(p)] ?? 'application/octet-stream' });
      res.end(body);
    } catch { json(res, 404, { error: 'not found' }) }
    void req;
  }

  // ---------- account: export and delete (privacy) ----------

  /** Reads a small body. Past the limit it keeps draining (so the client gets an answer) and resolves null. */
  function readBody(req: IncomingMessage, limit = 4096): Promise<string | null> {
    return new Promise((resolve, reject) => {
      let size = 0; const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => { size += c.length; if (size <= limit) chunks.push(c) });
      req.on('end', () => resolve(size > limit ? null : Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  async function accountRoute(req: IncomingMessage, res: ServerResponse, action: 'export' | 'delete'): Promise<void> {
    let body: { name?: unknown; token?: unknown };
    const raw = await readBody(req);
    if (raw === null) return json(res, 413, { error: 'body too large' });
    try { body = JSON.parse(raw) } catch { return json(res, 400, { error: 'bad request' }) }
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const token = typeof body.token === 'string' ? body.token : '';
    const player = name && token ? db.authenticate(name, token) : null;
    // Same answer for an unknown name and a wrong token, so names cannot be probed.
    if (!player) return json(res, 401, { error: 'name and token do not match an account' });
    if (action === 'export') return json(res, 200, db.accountData(player.id));
    const s = live.get(player.id);
    if (s) { attachedBy.get(s)?.ws.close(); attachedBy.delete(s); s.discard(); live.delete(player.id) }
    recent.delete(player.id);
    const out = db.deleteAccount(player.id);
    log(`account deleted (${out.runs} runs)`);
    return json(res, 200, { deleted: true, runs: out.runs });
  }

  const http = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const p = url.pathname;
    const today = utcDay(now());
    try {
      if (passSvc && (p === '/wallet-pass' || p.startsWith('/wallet-pass/'))) { passSvc.handleNode(req, res); return }
      if (passSvc && req.method === 'POST' && p === '/api/rpc') {
        void readBody(req, 65536).then(async (b) => {
          if (b === null) return json(res, 413, { error: 'body too large' });
          const r = await passSvc!.rpcProxy(b);
          res.writeHead(r.status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(r.body);
        }).catch(() => json(res, 502, { error: 'rpc unavailable' }));
        return;
      }
      if (passSvc && req.method === 'GET' && p === '/api/chain') {
        void passSvc.saleInfo().then((i) => json(res, 200, i), () => json(res, 503, { error: 'chain read failed' }));
        return;
      }
      if (passSvc && req.method === 'GET' && p.startsWith('/api/passes/')) {
        void passSvc.passesOf(p.slice('/api/passes/'.length)).then((l) => json(res, 200, { passes: l }), () => json(res, 503, { error: 'chain read failed' }));
        return;
      }
      if (passSvc && req.method === 'GET' && p === '/api/pass-challenge') {
        void passSvc.rankedChallenge(url.searchParams.get('pass') ?? '', url.searchParams.get('address') ?? '')
          .then((message) => json(res, 200, { message }), () => json(res, 400, { error: 'bad pass id or address' }));
        return;
      }
      if (req.method === 'POST' && (p === '/api/account/export' || p === '/api/account/delete')) {
        void accountRoute(req, res, p.endsWith('export') ? 'export' : 'delete').catch((e) => { log('account error ' + String(e)); json(res, 500, { error: 'internal' }) });
        return;
      }
      if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });
      if (p === '/api/health') return json(res, 200, { ok: true, day: today, protocol: PROTOCOL_VERSION, signer: signer.publicHex });
      if (p === '/api/leaderboard') {
        const day = url.searchParams.get('day') ?? today;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return json(res, 400, { error: 'bad day' });
        return json(res, 200, { day, rows: db.leaderboard(day) });
      }
      let m = p.match(/^\/api\/commit\/(\d{4}-\d{2}-\d{2})$/);
      if (m) {
        // Committing ahead of time: today and tomorrow can be requested.
        const day = m[1]!;
        if (day > utcDay(now() + 86_400_000)) return json(res, 404, { error: 'too far ahead' });
        return json(res, 200, { day, commit: daySeed(day).commit });
      }
      m = p.match(/^\/api\/seed\/(\d{4}-\d{2}-\d{2})$/);
      if (m) {
        const day = m[1]!;
        if (day >= today) return json(res, 403, { error: 'seed is revealed after the day closes (UTC)' });
        const s = db.peekSeed(day);
        if (!s) return json(res, 404, { error: 'no seed for that day' });
        return json(res, 200, { day, seed: s.seedHex, commit: s.commitHex });
      }
      m = p.match(/^\/api\/runs\/(\d{4}-\d{2}-\d{2})$/);
      if (m) {
        const day = m[1]!;
        if (day >= today) return json(res, 403, { error: 'receipts are published after the day closes (UTC)' });
        const rows = db.runsForDay(day).map((r) => ({ run: r.id, receipt: JSON.parse(r.receipt_json), attestation: JSON.parse(r.attestation_json) }));
        return json(res, 200, { day, signer: signer.publicHex, runs: rows });
      }
      if (p.startsWith('/api/')) return json(res, 404, { error: 'not found' });
      void serveStatic(req, res, p);
    } catch (e) {
      log('http error ' + String(e));
      json(res, 500, { error: 'internal' });
    }
  });

  // ---------- WebSocket ----------

  const wss = new WebSocketServer({ server: http, path: '/ws', maxPayload: 4096 });
  /** A connection, as far as runs are concerned: who it is and how to reach it. */
  interface Conn { ws: WebSocket; send: (m: ServerMsg) => void }
  const attachedBy = new Map<RunSession, Conn>();

  function attach(s: RunSession, c: Conn, lite: boolean): void {
    const prev = attachedBy.get(s);
    if (prev && prev.ws !== c.ws) {
      // one screen per run: the newest connection wins
      prev.send({ t: 'error', code: 'replaced', msg: 'This run was opened somewhere else.' });
      s.detach();
      prev.ws.close();
    }
    attachedBy.set(s, c);
    s.attach(c.send, lite);
  }

  wss.on('connection', (ws: WebSocket) => {
    let session: RunSession | null = null;
    let player: { id: number; name: string } | null = null;
    let helloPending = false;
    let windowStart = now(), count = 0;
    const send = (m: ServerMsg) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m)) };
    const conn: Conn = { ws, send };
    const fail = (code: string, msg: string) => { send({ t: 'error', code, msg }); ws.close() };

    ws.on('message', (data) => {
      const t = now();
      if (t - windowStart >= 1000) { windowStart = t; count = 0 }
      if (++count > maxMsgs) return fail('rate', 'Too many messages.');
      let m: ClientMsg;
      try { m = JSON.parse(String(data)) } catch { return fail('bad', 'Bad message.') }
      if (!m || typeof m !== 'object' || typeof (m as { t?: unknown }).t !== 'string') return fail('bad', 'Bad message.');

      if (helloPending) return; // a pass check is in flight; the client waits for the snapshot anyway
      if (!session) {
        if (m.t !== 'hello' || player) return fail('bad', 'Say hello first.');
        if (m.v !== PROTOCOL_VERSION) return fail('version', 'Client is out of date. Reload the page.');
        if (typeof m.name !== 'string' || !NAME.test(m.name)) return fail('name', 'Use 2 to 24 letters, numbers, spaces, dots, dashes or underscores.');
        const login = db.login(m.name.trim(), typeof m.token === 'string' ? m.token : undefined, t);
        if ('error' in login) return fail('name', login.error);
        player = { id: login.player.id, name: login.player.name };
        const lite = !!m.lite;

        // A run already going for this player is resumed, never restarted.
        const prior = live.get(player.id) ?? (m.resume ? recentFor(player.id) : undefined);
        if (prior) {
          session = prior;
          const { commit } = daySeed(prior.info.day);
          send({ t: 'welcome', name: player.name, player: player.id, token: login.token, day: prior.info.day, attempt: prior.info.attempt,
            attemptsLeft: Math.max(0, cap - db.attemptsUsed(player.id, prior.info.day)), commit, mint: prior.info.mint, resumed: true });
          attach(prior, conn, lite);
          return;
        }
        if (m.resume) return fail('resume', 'There is no ranked run to resume.');

        const who = player;
        const bind = m.pass;
        const startNew = (passBinding: { id: string; owner: string } | undefined) => {
          if (ws.readyState !== ws.OPEN) return;
          const day = utcDay(now());
          const { seed, commit } = daySeed(day);
          const started = db.startRun(who.id, day, cap, (attempt) => runSeedOf(seed, who.id, attempt), now(), passBinding);
          if (!started) return fail('attempts', `No ranked attempts left today (${cap} per day). Practice is unlimited.`);
          if (started.passFull) return fail('pass_attempts', `This pass has used its ${cap} ranked attempts today. Play without it, or with another pass.`);
          const passInfo = passBinding ? { id: passBinding.id, attempt: started.passAttempt! } : null;
          send({ t: 'welcome', name: who.name, player: who.id, token: login.token, day, attempt: started.attempt, attemptsLeft: started.attemptsLeft, commit, mint: started.mint, resumed: false, pass: passInfo });
          const s = new RunSession(
            { run: started.run, player: who.id, day, attempt: started.attempt, seed: started.seed, mint: started.mint, pass: passInfo },
            {
              signer: signer.publicHex,
              sign: (msg) => signer.sign(msg),
              finish: (fs, receipt, att) => {
                live.delete(fs.info.player);
                recent.set(fs.info.player, { s: fs, at: now() });
                db.finishRun(fs.info.run, receipt.result.layers, receipt.result.bank, JSON.stringify(receipt), att.receiptHash, JSON.stringify(att), now());
                if (fs.info.pass && passSvc) {
                  const p = fs.info.pass;
                  // The pass owner submits this to RunRegistry.settle. Chain signing is async; the client gets it after `end`.
                  void passSvc.signRunResult({ passId: p.id, day: fs.info.day, attempt: p.attempt, receiptHash: att.receiptHash as `0x${string}`, layers: receipt.result.layers, bank: receipt.result.bank })
                    .then((st) => { db.setChainSettlement(fs.info.run, JSON.stringify(st)); fs.settlement = st; fs.sendSettlement() })
                    .catch((e: unknown) => log('settlement signing failed: ' + String(e)));
                }
              },
            },
            { tickMs, idleMs },
          );
          live.set(who.id, s);
          session = s;
          attach(s, conn, lite);
        };

        if (!bind) { startNew(undefined); return }
        // Bound to a pass: a signed proof of control and a fresh ownerOf read, before any attempt is used.
        if (!passSvc) return fail('pass', 'Passes are not enabled on this server.');
        if (typeof bind !== 'object' || typeof bind.id !== 'string' || typeof bind.message !== 'string' || typeof bind.signature !== 'string') return fail('pass', 'Bad pass proof.');
        helloPending = true;
        void passSvc.verifyBinding(bind.id, bind.message, bind.signature).then((v) => {
          helloPending = false;
          if ('error' in v) return fail('pass', v.error);
          startNew({ id: bind.id, owner: v.owner });
        }, (e: unknown) => { helloPending = false; log('pass binding failed: ' + String(e)); fail('pass', 'Could not check the pass. Try again.') });
        return;
      }

      switch (m.t) {
        case 'go': session.go(); break;
        case 'next': session.next(); break;
        case 'shop': session.shop(m.code); break;
        case 'press': session.press(m.b); break;
        case 'mint': {
          const id = typeof m.id === 'string' ? m.id : '';
          if (!session.done || !IND[id] || !session.mintable().includes(id)) { send({ t: 'error', code: 'mint', msg: 'That indicator cannot be minted from this run.' }); break }
          if (db.mintFromRun(session.info.run, session.info.player, id, charges)) send({ t: 'minted', id, runs: charges });
          else send({ t: 'error', code: 'mint', msg: 'This run already minted.' });
          break;
        }
        default: return fail('bad', 'Unknown message.');
      }
    });

    ws.on('close', () => {
      // The run is not touched: it keeps its clock and waits for this player to come back.
      if (session && attachedBy.get(session) === conn) { attachedBy.delete(session); session.detach() }
    });
    ws.on('error', () => { /* close follows */ });
  });

  // The pass: follow chain logs, and commit and reveal daily seeds on chain when this server is the operator.
  let seedTimer: NodeJS.Timeout | null = null;
  const runSeedJob = async () => {
    if (!passSvc) return;
    try { await passSvc.seedJob((day) => { daySeed(day); return db.peekSeed(day)! }, () => db.seedDays()) }
    catch (e) { log('seed job failed: ' + (e instanceof Error ? e.message.split('\n')[0] : String(e))) }
  };
  if (passSvc) {
    passSvc.startIndexer();
    const every = o.seedJobMs ?? 10 * 60_000;
    if (every > 0) { void runSeedJob(); seedTimer = setInterval(() => void runSeedJob(), every) }
  }

  await new Promise<void>((resolve) => http.listen(o.port ?? 0, o.host ?? '127.0.0.1', resolve));
  const addr = http.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    signer: signer.publicHex,
    db,
    liveCount: () => live.size,
    pass: passSvc,
    runSeedJob,
    /** True while this player has a run in progress (attached or not). */
    hasLiveRun: (player: number) => live.has(player),
    async close(): Promise<void> {
      if (seedTimer) clearInterval(seedTimer);
      passSvc?.stop();
      for (const s of [...live.values()]) s.finishUnattended();
      for (const c of wss.clients) c.terminate();
      await new Promise<void>((r) => wss.close(() => r()));
      await new Promise<void>((r) => http.close(() => r()));
      db.close();
    },
  };
}

export type RunServer = Awaited<ReturnType<typeof startServer>>;
