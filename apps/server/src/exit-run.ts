// M1 exit test harness: N scripted ranked runs over real WebSockets, then the
// verifier CLI (as a separate process) checks every published result.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './server.ts';
import { playBot, type BotResult } from './bot.ts';
import { utcDay } from './seeds.ts';

export interface ExitStats {
  runs: number;
  stored: number;
  completedByBots: number;
  quit: number;
  reconnects: number;
  resumedRunsCompleted: number;
  awayTicks: { min: number; max: number; mean: number } | null;
  botErrors: string[];
  botMismatches: number;
  verifierExit: number | null;
  verifierSummary: string;
  layers: number[];
  inputs: number;
  shopInputs: number;
  mints: number;
  seconds: number;
}

export async function runExit(o: { runs: number; concurrency: number; tickMs: number; attempts?: number; quitChance?: number; reconnectChance?: number }): Promise<ExitStats> {
  const t0 = Date.now();
  const dir = mkdtempSync(join(tmpdir(), 'exitliq-'));
  // Pin the clock to midday UTC so a run of the test never straddles midnight.
  const realNow = Date.now();
  const noon = Date.UTC(new Date(realNow).getUTCFullYear(), new Date(realNow).getUTCMonth(), new Date(realNow).getUTCDate(), 12);
  let offset = noon - realNow;
  const now = () => Date.now() + offset;
  const attempts = o.attempts ?? 3;
  const srv = await startServer({
    dbPath: join(dir, 'runs.db'), signerKeyPath: join(dir, 'signer.pem'), tickMs: o.tickMs,
    attemptsPerDay: attempts, maxMsgsPerSec: 1000, idleMs: 500, now, log: () => {},
  });
  const day = utcDay(now());
  const commit = (await (await fetch(`${srv.url}/api/commit/${day}`)).json() as { commit: string }).commit;
  const players = Math.ceil(o.runs / attempts);
  const tokens = new Map<string, string>();
  const results: BotResult[] = [];
  const botErrors: string[] = [];
  // Each worker takes whole players and plays their attempts in order, so a
  // player is never connected twice at once and always has its token.
  let nextPlayer = 0;
  async function worker(w: number): Promise<void> {
    while (true) {
      const p = nextPlayer++;
      if (p >= players) return;
      const name = `bot_${p}`;
      for (let a = 0; a < attempts; a++) {
        const n = p * attempts + a;
        if (n >= o.runs) return;
        const r = await playBot({
          url: srv.url.replace('http', 'ws') + '/ws', name, token: tokens.get(name), seed: (n * 2654435761 + w) >>> 0,
          quitChance: o.quitChance ?? 0.03, reconnectChance: o.reconnectChance ?? 0.15, maxPerSec: 400,
        });
        if (r.token) tokens.set(name, r.token);
        if (r.error && !r.quit) botErrors.push(`run ${n}: ${r.error}`);
        results.push(r);
        // A walked-away run keeps going on the server. The player's next hello would
        // resume it (by design), so wait for it to play out before the next attempt.
        while (r.player != null && srv.hasLiveRun(r.player)) await new Promise((res) => setTimeout(res, 25));
      }
    }
  }
  await Promise.all(Array.from({ length: o.concurrency }, (_, w) => worker(w)));
  // unattended runs finish synchronously on disconnect; give close handlers a moment
  for (let k = 0; k < 1000 && srv.liveCount() > 0; k++) await new Promise((r) => setTimeout(r, 20));

  const stored = srv.db.raw.prepare("SELECT COUNT(*) AS n FROM runs WHERE day = ? AND status = 'done'").get(day) as { n: number };
  const rows = srv.db.raw.prepare("SELECT id, layers, bank, receipt_json FROM runs WHERE day = ? AND status = 'done'").all(day) as { id: number; layers: number; bank: number; receipt_json: string }[];
  const byRun = new Map(rows.map((r) => [r.id, r]));
  let botMismatches = 0;
  for (const r of results) {
    if (!r.receipt || r.run == null) continue;
    const row = byRun.get(r.run);
    if (!row || row.layers !== r.receipt.result.layers || row.bank !== r.receipt.result.bank || row.receipt_json !== JSON.stringify(r.receipt)) botMismatches++;
  }
  let inputs = 0, shopInputs = 0;
  const layers = Array(9).fill(0) as number[];
  for (const r of rows) {
    const rc = JSON.parse(r.receipt_json) as { log: [number, number, string][] };
    inputs += rc.log.length; shopInputs += rc.log.filter((e) => e[1] === -1).length;
    layers[r.layers]!++;
  }
  const mints = (srv.db.raw.prepare('SELECT COUNT(*) AS n FROM runs WHERE minted IS NOT NULL').get() as { n: number }).n;

  // The day closes: seeds and receipts become public. Verify with the CLI as an outsider would.
  offset += 86_400_000;
  const cli = resolve(fileURLToPath(new URL('.', import.meta.url)), 'verify-cli.ts');
  // Async spawn: the server in this process must keep answering the CLI's requests.
  const verify = await new Promise<{ code: number | null; out: string }>((done) => {
    const c = spawn(process.execPath, ['--import', 'tsx', cli, '--server', srv.url, '--day', day, '--signer', srv.signer, '--commit', commit], { cwd: resolve(cli, '../..') });
    let out = '';
    c.stdout.on('data', (d) => { out += d });
    c.stderr.on('data', (d) => { out += d });
    c.on('close', (code) => done({ code, out }));
  });
  await srv.close();
  rmSync(dir, { recursive: true, force: true });
  return {
    runs: o.runs, stored: stored.n, completedByBots: results.filter((r) => r.receipt).length, quit: results.filter((r) => r.quit).length,
    reconnects: results.reduce((a, r) => a + r.reconnects, 0),
    resumedRunsCompleted: results.filter((r) => r.reconnects > 0 && r.receipt).length,
    awayTicks: (() => { const a = results.flatMap((r) => r.awayTicks); return a.length ? { min: Math.min(...a), max: Math.max(...a), mean: +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(1) } : null })(),
    botErrors, botMismatches, verifierExit: verify.code, verifierSummary: verify.out.trim().split('\n').slice(-3).join(' | '),
    layers, inputs, shopInputs, mints, seconds: (Date.now() - t0) / 1000,
  };
}
