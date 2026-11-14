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
CREATE TABLE IF NOT EXISTS accounts (
  privy_user_id TEXT PRIMARY KEY,
  player_id INTEGER UNIQUE REFERENCES players(id),
  practice_mint TEXT,
  created_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS kv (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL,
  expires_ms INTEGER
);
CREATE TABLE IF NOT EXISTS pass_owners (
  token_id TEXT PRIMARY KEY,
  owner TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS pass_owners_owner ON pass_owners(owner);
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
  // M2 columns, added in place so a database from the live game keeps working.
  const cols = new Set((db.prepare('PRAGMA table_info(runs)').all() as { name: string }[]).map((c) => c.name));
  for (const [c, type] of [['pass_id', 'TEXT'], ['pass_attempt', 'INTEGER'], ['pass_owner', 'TEXT'], ['chain_json', 'TEXT']] as const) {
    if (!cols.has(c)) db.exec(`ALTER TABLE runs ADD COLUMN ${c} ${type}`);
  }
  db.exec('CREATE INDEX IF NOT EXISTS runs_pass ON runs(pass_id, day)');

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

    // ------------------------------------------------ Privy accounts

    account(userId: string): { privy_user_id: string; player_id: number | null; practice_mint: string | null } | null {
      return (db.prepare('SELECT privy_user_id, player_id, practice_mint FROM accounts WHERE privy_user_id = ?').get(userId) as never) ?? null;
    },
    accountOfPlayer(player: number): string | null {
      return ((db.prepare('SELECT privy_user_id FROM accounts WHERE player_id = ?').get(player) as { privy_user_id: string } | undefined)?.privy_user_id) ?? null;
    },
    playerById(id: number): PlayerRow | null { return (db.prepare('SELECT id, name, token_hash FROM players WHERE id = ?').get(id) as PlayerRow | undefined) ?? null },

    /**
     * First login: create the account and bring over what the guest had in
     * this browser. A guest ranked identity (name and token) is adopted only
     * when it checks out and belongs to no other account, and only when the
     * account has no player yet. The practice keepsake is kept when the
     * account has none.
     */
    loginAccount: db.transaction((userId: string, now: number, guest: { name: string; token: string } | null, practiceMint: string | null) => {
      let acct = db.prepare('SELECT privy_user_id, player_id, practice_mint FROM accounts WHERE privy_user_id = ?').get(userId) as { player_id: number | null; practice_mint: string | null } | undefined;
      const created = !acct;
      if (!acct) { db.prepare('INSERT INTO accounts (privy_user_id, player_id, practice_mint, created_ms) VALUES (?, NULL, NULL, ?)').run(userId, now); acct = { player_id: null, practice_mint: null } }
      let adopted = false, guestKept = false;
      if (guest) {
        const row = q.playerByName.get(guest.name) as PlayerRow | undefined;
        const ok = row && hashToken(guest.token) === row.token_hash;
        const taken = ok && db.prepare('SELECT 1 FROM accounts WHERE player_id = ?').get(row!.id);
        if (ok && !taken && acct.player_id === null) {
          db.prepare('UPDATE accounts SET player_id = ? WHERE privy_user_id = ?').run(row!.id, userId);
          acct.player_id = row!.id; adopted = true;
        } else if (ok && !taken) guestKept = true; // the account already has a player; the guest name stays a separate guest
      }
      if (practiceMint && !acct.practice_mint) {
        db.prepare('UPDATE accounts SET practice_mint = ? WHERE privy_user_id = ?').run(practiceMint, userId);
        acct.practice_mint = practiceMint;
      }
      return { created, adopted, guestKept, playerId: acct.player_id, practiceMint: acct.practice_mint };
    }),

    setPracticeMint(userId: string, json: string | null): void { db.prepare('UPDATE accounts SET practice_mint = ? WHERE privy_user_id = ?').run(json, userId) },

    /** Creates the ranked player for an account that has none. Null if the name is taken. */
    createAccountPlayer: db.transaction((userId: string, name: string, now: number) => {
      const acct = db.prepare('SELECT player_id FROM accounts WHERE privy_user_id = ?').get(userId) as { player_id: number | null } | undefined;
      if (!acct) return { error: 'no account' as const };
      if (acct.player_id !== null) return { error: 'has player' as const };
      if (q.playerByName.get(name)) return { error: 'taken' as const };
      // No guest token exists for an account player: its token hash is random and unusable, login is through Privy.
      const info = q.insertPlayer.run(name, hashToken(randomBytes(32).toString('base64url')), now);
      const id = Number(info.lastInsertRowid);
      db.prepare('UPDATE accounts SET player_id = ? WHERE privy_user_id = ?').run(id, userId);
      return { id };
    }),

    deleteAccountRow(userId: string): void { db.prepare('DELETE FROM accounts WHERE privy_user_id = ?').run(userId) },

    /** Checks a name and token without creating anything. */
    authenticate(name: string, token: string): PlayerRow | null {
      const row = q.playerByName.get(name) as PlayerRow | undefined;
      if (!row || !token || hashToken(token) !== row.token_hash) return null;
      return row;
    },

    /** Everything stored about one player, for a data export. */
    accountData(player: number) {
      const p = db.prepare('SELECT id, name, created_ms FROM players WHERE id = ?').get(player) as { id: number; name: string; created_ms: number } | undefined;
      if (!p) return null;
      const runs = db.prepare('SELECT id, day, attempt, status, layers, bank, mint, minted, started_ms, ended_ms, receipt_json FROM runs WHERE player_id = ? ORDER BY id').all(player) as Record<string, unknown>[];
      const mint = db.prepare('SELECT ind, runs_left FROM mints WHERE player_id = ?').get(player) ?? null;
      return {
        player: { id: p.id, name: p.name, createdAt: new Date(p.created_ms).toISOString() },
        mint,
        runs: runs.map((r) => ({ ...r, receipt_json: undefined, receipt: r.receipt_json ? JSON.parse(String(r.receipt_json)) : null })),
      };
    },

    /** Deletes a player and every row tied to them: runs (and so their leaderboard entries and published receipts), the minted indicator, the login. */
    deleteAccount: db.transaction((player: number) => {
      db.prepare('UPDATE accounts SET player_id = NULL WHERE player_id = ?').run(player);
      const runs = db.prepare('DELETE FROM runs WHERE player_id = ?').run(player).changes;
      db.prepare('DELETE FROM mints WHERE player_id = ?').run(player);
      const players = db.prepare('DELETE FROM players WHERE id = ?').run(player).changes;
      return { runs, players };
    }),

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
    seedDays(): string[] { return (db.prepare('SELECT day FROM seeds ORDER BY day').all() as { day: string }[]).map((r) => r.day) },
    peekSeed(day: string): { seedHex: string; commitHex: string } | null {
      const row = q.seed.get(day) as { seed_hex: string; commit_hex: string } | undefined;
      return row ? { seedHex: row.seed_hex, commitHex: row.commit_hex } : null;
    },

    attemptsUsed(player: number, day: string): number { return (q.attempts.get(player, day) as { n: number }).n },

    /** Reserves the next attempt and consumes one minted charge, atomically. A run bound to a pass also takes the pass's next attempt. */
    startRun: db.transaction((player: number, day: string, cap: number, seedOf: (attempt: number) => string, now: number, pass?: { id: string; owner: string }) => {
      const used = (q.attempts.get(player, day) as { n: number }).n;
      if (used >= cap) return null;
      let passAttempt: number | null = null;
      if (pass) {
        const p = (db.prepare('SELECT COUNT(*) AS n FROM runs WHERE pass_id = ? AND day = ?').get(pass.id, day) as { n: number }).n;
        if (p >= cap) return { passFull: true as const };
        passAttempt = p + 1;
      }
      const attempt = used + 1;
      const m = q.mint.get(player) as { ind: string; runs_left: number } | undefined;
      const mint = m && m.runs_left > 0 ? m.ind : null;
      if (mint) q.useMint.run(player);
      const seed = seedOf(attempt);
      const info = q.insertRun.run(player, day, attempt, seed, mint, now);
      const run = Number(info.lastInsertRowid);
      if (pass) db.prepare('UPDATE runs SET pass_id = ?, pass_attempt = ?, pass_owner = ? WHERE id = ?').run(pass.id, passAttempt, pass.owner.toLowerCase(), run);
      return { passFull: false as const, run, attempt, seed, mint, attemptsLeft: cap - attempt, passAttempt };
    }),

    setChainSettlement(run: number, json: string): void { db.prepare('UPDATE runs SET chain_json = ? WHERE id = ?').run(json, run) },
    chainSettlement(run: number): string | null { return ((db.prepare('SELECT chain_json FROM runs WHERE id = ?').get(run) as { chain_json: string | null } | undefined)?.chain_json) ?? null },
    passRunsPlayed(passId: string): number { return (db.prepare("SELECT COUNT(*) AS n FROM runs WHERE pass_id = ? AND status = 'done'").get(passId) as { n: number }).n },

    setPassOwner(tokenId: string, owner: string): void {
      db.prepare('INSERT INTO pass_owners (token_id, owner) VALUES (?, ?) ON CONFLICT(token_id) DO UPDATE SET owner = excluded.owner').run(tokenId, owner.toLowerCase());
    },
    passesOwnedBy(owner: string): string[] {
      return (db.prepare('SELECT token_id FROM pass_owners WHERE owner = ? ORDER BY CAST(token_id AS INTEGER)').all(owner.toLowerCase()) as { token_id: string }[]).map((r) => r.token_id);
    },

    /** A KeyValueStore (the @erc8426/issuer interface) over SQLite. Single process, so getDel and incr are atomic. */
    kv: (() => {
      const live = (k: string) => {
        const r = db.prepare('SELECT v, expires_ms FROM kv WHERE k = ?').get(k) as { v: string; expires_ms: number | null } | undefined;
        if (!r) return null;
        if (r.expires_ms !== null && r.expires_ms <= Date.now()) { db.prepare('DELETE FROM kv WHERE k = ?').run(k); return null }
        return r.v;
      };
      const set = db.transaction((k: string, v: string, ttl?: number, onlyIfAbsent?: boolean) => {
        if (onlyIfAbsent && live(k) !== null) return false;
        db.prepare('INSERT INTO kv (k, v, expires_ms) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, expires_ms = excluded.expires_ms').run(k, v, ttl ? Date.now() + ttl * 1000 : null);
        return true;
      });
      const getDel = db.transaction((k: string) => { const v = live(k); if (v !== null) db.prepare('DELETE FROM kv WHERE k = ?').run(k); return v });
      const incr = db.transaction((k: string, ttl: number) => {
        const v = live(k);
        const n = (v === null ? 0 : Number(v)) + 1;
        if (v === null) db.prepare('INSERT OR REPLACE INTO kv (k, v, expires_ms) VALUES (?, ?, ?)').run(k, String(n), Date.now() + ttl * 1000);
        else db.prepare('UPDATE kv SET v = ? WHERE k = ?').run(String(n), k);
        return n;
      });
      return {
        async get(k: string) { return live(k) },
        async set(k: string, v: string, o?: { ttlSeconds?: number; onlyIfAbsent?: boolean }) { return set(k, v, o?.ttlSeconds, o?.onlyIfAbsent) },
        async getDel(k: string) { return getDel(k) },
        async del(k: string) { db.prepare('DELETE FROM kv WHERE k = ?').run(k) },
        async incr(k: string, ttlSeconds: number) { return incr(k, ttlSeconds) },
      };
    })(),

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
