// Plain SQLite storage: players, daily seeds, runs, minted indicators.

import Database from 'better-sqlite3';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS players (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  token_hash TEXT NOT NULL,
  created_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS seeds (
  day TEXT PRIMARY KEY,
  seed_hex TEXT NOT NULL,
  commit_hex TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY,
  player_id INTEGER NOT NULL REFERENCES players(id),
  day TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  seed TEXT NOT NULL,
  mint TEXT,
  status TEXT NOT NULL,
  layers INTEGER,
  bank REAL,
  receipt_json TEXT,
  receipt_hash TEXT,
  attestation_json TEXT,
  minted TEXT,
  started_ms INTEGER NOT NULL,
  ended_ms INTEGER,
  UNIQUE (player_id, day, attempt)
);
CREATE INDEX IF NOT EXISTS runs_day ON runs(day, status);
CREATE TABLE IF NOT EXISTS mints (
  player_id INTEGER PRIMARY KEY REFERENCES players(id),
  ind TEXT NOT NULL,
  runs_left INTEGER NOT NULL
);
`;

export interface PlayerRow { id: number; name: string; token_hash: string }
export interface BoardRow { name: string; layers: number; bank: number; run: number }

function hashToken(t: string): string { return createHash('sha256').update(t).digest('hex') }

export function openDb(path: string) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);

  const q = {
    playerByName: db.prepare('SELECT id, name, token_hash FROM players WHERE name = ?'),
    insertPlayer: db.prepare('INSERT INTO players (name, token_hash, created_ms) VALUES (?, ?, ?)'),
    seed: db.prepare('SELECT seed_hex, commit_hex FROM seeds WHERE day = ?'),
    insertSeed: db.prepare('INSERT OR IGNORE INTO seeds (day, seed_hex, commit_hex) VALUES (?, ?, ?)'),
    attempts: db.prepare('SELECT COUNT(*) AS n FROM runs WHERE player_id = ? AND day = ?'),
    insertRun: db.prepare("INSERT INTO runs (player_id, day, attempt, seed, mint, status, started_ms) VALUES (?, ?, ?, ?, ?, 'live', ?)"),
    finishRun: db.prepare("UPDATE runs SET status = 'done', layers = ?, bank = ?, receipt_json = ?, receipt_hash = ?, attestation_json = ?, ended_ms = ? WHERE id = ?"),
    setMinted: db.prepare('UPDATE runs SET minted = ? WHERE id = ? AND minted IS NULL'),
    mint: db.prepare('SELECT ind, runs_left FROM mints WHERE player_id = ?'),
    upsertMint: db.prepare('INSERT INTO mints (player_id, ind, runs_left) VALUES (?, ?, ?) ON CONFLICT(player_id) DO UPDATE SET ind = excluded.ind, runs_left = excluded.runs_left'),
    useMint: db.prepare('UPDATE mints SET runs_left = runs_left - 1 WHERE player_id = ? AND runs_left > 0'),
    board: db.prepare(`
      SELECT name, layers, bank, run FROM (
        SELECT p.name AS name, r.layers AS layers, r.bank AS bank, r.id AS run,
               ROW_NUMBER() OVER (PARTITION BY r.player_id ORDER BY r.layers DESC, r.bank DESC, r.id ASC) AS rk
        FROM runs r JOIN players p ON p.id = r.player_id
        WHERE r.day = ? AND r.status = 'done'
      ) WHERE rk = 1 ORDER BY layers DESC, bank DESC, run ASC LIMIT ?`),
    runsForDay: db.prepare("SELECT id, receipt_json, attestation_json FROM runs WHERE day = ? AND status = 'done' ORDER BY id"),
    run: db.prepare("SELECT id, day, receipt_json, attestation_json, status FROM runs WHERE id = ?"),
    liveRuns: db.prepare("SELECT id FROM runs WHERE status = 'live'"),
    abandon: db.prepare("UPDATE runs SET status = 'void', ended_ms = ? WHERE status = 'live'"),
  };

  return {
    raw: db,
    close: () => db.close(),

    /** Finds a player by name and checks the token, or creates the player. */
    login(name: string, token: string | undefined, now: number): { player: PlayerRow; token: string } | { error: string } {
      const row = q.playerByName.get(name) as PlayerRow | undefined;
      if (row) {
        if (!token || hashToken(token) !== row.token_hash) return { error: 'That name is taken on this server.' };
        return { player: row, token };
      }
      const t = randomBytes(24).toString('base64url');
      const info = q.insertPlayer.run(name, hashToken(t), now);
      return { player: { id: Number(info.lastInsertRowid), name, token_hash: hashToken(t) }, token: t };
    },

    seedFor(day: string, make: () => { seedHex: string; commitHex: string }): { seedHex: string; commitHex: string } {
      const row = q.seed.get(day) as { seed_hex: string; commit_hex: string } | undefined;
      if (row) return { seedHex: row.seed_hex, commitHex: row.commit_hex };
      const s = make();
      q.insertSeed.run(day, s.seedHex, s.commitHex);
      const again = q.seed.get(day) as { seed_hex: string; commit_hex: string };
      return { seedHex: again.seed_hex, commitHex: again.commit_hex };
    },
    peekSeed(day: string): { seedHex: string; commitHex: string } | null {
      const row = q.seed.get(day) as { seed_hex: string; commit_hex: string } | undefined;
      return row ? { seedHex: row.seed_hex, commitHex: row.commit_hex } : null;
    },

    attemptsUsed(player: number, day: string): number { return (q.attempts.get(player, day) as { n: number }).n },

    /** Reserves the next attempt and consumes one minted charge, atomically. */
    startRun: db.transaction((player: number, day: string, cap: number, seedOf: (attempt: number) => string, now: number) => {
      const used = (q.attempts.get(player, day) as { n: number }).n;
      if (used >= cap) return null;
      const attempt = used + 1;
      const m = q.mint.get(player) as { ind: string; runs_left: number } | undefined;
      const mint = m && m.runs_left > 0 ? m.ind : null;
      if (mint) q.useMint.run(player);
      const seed = seedOf(attempt);
      const info = q.insertRun.run(player, day, attempt, seed, mint, now);
      return { run: Number(info.lastInsertRowid), attempt, seed, mint, attemptsLeft: cap - attempt };
    }),

    finishRun(run: number, layers: number, bank: number, receiptJson: string, receiptHash: string, attestationJson: string, now: number): void {
      q.finishRun.run(layers, bank, receiptJson, receiptHash, attestationJson, now, run);
    },

    /** Records the one mint a finished run may make. Returns false if this run already minted. */
    mintFromRun: db.transaction((run: number, player: number, ind: string, charges: number) => {
      const ok = q.setMinted.run(ind, run).changes === 1;
      if (ok) q.upsertMint.run(player, ind, charges);
      return ok;
    }),

    leaderboard(day: string, limit = 50): BoardRow[] { return q.board.all(day, limit) as BoardRow[] },
    runsForDay(day: string): { id: number; receipt_json: string; attestation_json: string }[] { return q.runsForDay.all(day) as never },
    run(id: number): { id: number; day: string; receipt_json: string | null; attestation_json: string | null; status: string } | undefined { return q.run.get(id) as never },
    /** Runs left live by a crash cannot be finished honestly. They keep their attempt and score nothing. */
    voidLiveRuns(now: number): number { return q.abandon.run(now).changes },
  };
}

export type Db = ReturnType<typeof openDb>;
