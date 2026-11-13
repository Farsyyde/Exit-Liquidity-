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
    const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
    try {
      const body = await readFile(join(o.staticDir, p));
      res.writeHead(200, { 'content-type': types[extname(p)] ?? 'application/octet-stream' });
      res.end(body);
    } catch { json(res, 404, { error: 'not found' }) }
    void req;
  }

  const http = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const p = url.pathname;
    const today = utcDay(now());
    try {
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

        const day = utcDay(t);
        const { seed, commit } = daySeed(day);
        const started = db.startRun(player.id, day, cap, (attempt) => runSeedOf(seed, player!.id, attempt), t);
        if (!started) return fail('attempts', `No ranked attempts left today (${cap} per day). Practice is unlimited.`);
        send({ t: 'welcome', name: player.name, player: player.id, token: login.token, day, attempt: started.attempt, attemptsLeft: started.attemptsLeft, commit, mint: started.mint, resumed: false });
        const s = new RunSession(
          { run: started.run, player: player.id, day, attempt: started.attempt, seed: started.seed, mint: started.mint },
          {
            signer: signer.publicHex,
            sign: (msg) => signer.sign(msg),
            finish: (fs, receipt, att) => {
              live.delete(fs.info.player);
              recent.set(fs.info.player, { s: fs, at: now() });
              db.finishRun(fs.info.run, receipt.result.layers, receipt.result.bank, JSON.stringify(receipt), att.receiptHash, JSON.stringify(att), now());
            },
          },
          { tickMs, idleMs },
        );
        live.set(player.id, s);
        session = s;
        attach(s, conn, lite);
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

  await new Promise<void>((resolve) => http.listen(o.port ?? 0, o.host ?? '127.0.0.1', resolve));
  const addr = http.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    signer: signer.publicHex,
    db,
    liveCount: () => live.size,
    /** True while this player has a run in progress (attached or not). */
    hasLiveRun: (player: number) => live.has(player),
    async close(): Promise<void> {
      for (const s of [...live.values()]) s.finishUnattended();
      for (const c of wss.clients) c.terminate();
      await new Promise<void>((r) => wss.close(() => r()));
      await new Promise<void>((r) => http.close(() => r()));
      db.close();
    },
  };
}

export type RunServer = Awaited<ReturnType<typeof startServer>>;
