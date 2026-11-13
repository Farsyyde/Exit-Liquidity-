// Daily seeds are the one secret in M1 (KMS is later). They must never reach a
// log, a client before the reveal, or the repository.

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startServer } from '../src/server.ts';
import { playBot } from '../src/bot.ts';
import { utcDay } from '../src/seeds.ts';

const repo = resolve(__dirname, '../../..');

describe('daily seeds stay secret until the reveal', () => {
  it('never appear in logs, console output, WebSocket messages or HTTP responses before the day closes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'exitliq-sec-'));
    const logs: string[] = [];
    const printed: string[] = [];
    const ow = process.stdout.write.bind(process.stdout), ew = process.stderr.write.bind(process.stderr);
    (process.stdout as any).write = (c: any, ...a: any[]) => { printed.push(String(c)); return ow(c, ...a) };
    (process.stderr as any).write = (c: any, ...a: any[]) => { printed.push(String(c)); return ew(c, ...a) };
    const NOON = Date.UTC(2026, 10, 12, 12);
    let offset = 0;
    const srv = await startServer({ dbPath: join(dir, 'db'), signerKeyPath: join(dir, 'k.pem'), tickMs: 1, idleMs: 200, now: () => NOON + offset, log: (m) => logs.push(m) });
    try {
      const day = utcDay(NOON);
      const wire: string[] = [];
      // bots: normal runs, a quitter, a reconnector; every message they receive is kept
      const { default: WebSocket } = await import('ws');
      const orig = WebSocket.prototype.emit;
      WebSocket.prototype.emit = function (this: any, ev: string, ...args: any[]) { if (ev === 'message') wire.push(String(args[0])); return orig.call(this, ev, ...args) } as any;
      try {
        for (let k = 0; k < 6; k++) await playBot({ url: srv.url.replace('http', 'ws') + '/ws', name: 'sec' + k, seed: k, quitChance: k === 1 ? 1 : 0, reconnectChance: k === 2 ? 1 : 0 });
        for (let k = 0; k < 200 && srv.liveCount(); k++) await new Promise((r) => setTimeout(r, 25));
      } finally { WebSocket.prototype.emit = orig }
      // every public endpoint, including ones that must refuse, plus junk requests
      const http: string[] = [];
      for (const path of ['/api/health', '/api/leaderboard', `/api/commit/${day}`, `/api/seed/${day}`, `/api/runs/${day}`, '/api/seed/2099-01-01', '/api/nope', '/../../etc/passwd', '/api/seed/' + 'x'.repeat(50)]) {
        const r = await fetch(srv.url + path);
        http.push(path + ' ' + r.status + ' ' + (await r.text()));
      }
      const seedHex = srv.db.peekSeed(day)!.seedHex;
      const bare = seedHex.slice(2);
      expect(bare).toMatch(/^[0-9a-f]{64}$/);
      const everything = [...logs, ...printed, ...wire, ...http].join('\n').toLowerCase();
      expect(wire.length).toBeGreaterThan(100);
      expect(everything.includes(bare)).toBe(false);
      // after the day closes the reveal is intended
      offset += 86_400_000;
      const rev = await (await fetch(`${srv.url}/api/seed/${day}`)).json();
      expect(rev.seed).toBe(seedHex);
      // and the logger redacts 32 byte hex even if one were ever passed to it
      expect(logs.join('\n')).not.toMatch(/[0-9a-f]{64}/i);
    } finally {
      (process.stdout as any).write = ow; (process.stderr as any).write = ew;
      await srv.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('the repository holds no seeds, databases or keys', () => {
  const tracked = execFileSync('git', ['ls-files'], { cwd: repo, encoding: 'utf8' }).split('\n').filter(Boolean);
  const history = execFileSync('git', ['log', '--all', '--name-only', '--pretty=format:'], { cwd: repo, encoding: 'utf8' }).split('\n').filter(Boolean);
  const risky = /(^|\/)data\/|\.(db|sqlite|sqlite3|pem|key)$|(^|\/)\.env$/i;

  it('tracks no database, key or env files, now or in history', () => {
    expect(tracked.filter((f) => risky.test(f))).toEqual([]);
    expect([...new Set(history)].filter((f) => risky.test(f))).toEqual([]);
  });
  it('no tracked file is a SQLite database or holds a private key', () => {
    for (const f of tracked) {
      const buf = readFileSync(join(repo, f));
      expect(buf.subarray(0, 15).toString('latin1') === 'SQLite format 3', f).toBe(false);
      expect(buf.includes('PRIVATE KEY-----'), f).toBe(false);
    }
  });
  it('the default places the server writes seeds and keys are ignored by git', () => {
    for (const f of ['apps/server/data/exitliq.db', 'apps/server/data/exitliq.db-wal', 'apps/server/data/signer.pem', 'some.db', '.env']) {
      expect(() => execFileSync('git', ['check-ignore', '-q', f], { cwd: repo }), f).not.toThrow();
    }
  });
});
