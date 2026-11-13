// Game rules, ported from reference/prototype.html.
//
// Every rule that lived in prototype UI functions (openPos, closePos, useCons,
// endLevel, prepLevel, rollOffers, tick) lives here. The UI only reads state
// and dispatches inputs. Arithmetic is written in the same order as the
// prototype on purpose: floating point results depend on it.
//
// The engine has no DOM, no Date and no Math.random. exp, log and cos are
// injected (see MathImpl) so a fixed implementation can replace the host's.

import {
  CANDLE, CON, CSLOTS, HEAD, IND, INDS, CONS, K, LEVELS, MAX_CANDLES, SLOTS, WARMUP,
  type EventType, type LevelDef,
} from './tables.ts';
import { GENERATORS, type Generator, type RngState, type Seed } from './rng.ts';

// ---------- types ----------

export interface MathImpl {
  exp(x: number): number;
  log(x: number): number;
  cos(x: number): number;
}

export type Phase = 'attract' | 'intro' | 'play' | 'shop' | 'end';

export interface MarketEvent { type: EventType; mag: number; dur: number; start: number; end: number }

export interface Market {
  t: number;
  lf: number;
  dev: number;
  p0: number;
  p: number;
  q: MarketEvent[];
  /** Tick of the next headline. null stands in for the prototype's Infinity. */
  nextEv: number | null;
}

export interface Candle { o: number; h: number; l: number; c: number; f: number; n: number }

export interface FeedItem { text: string; fake: boolean; mine: boolean }

export interface Snap { cash: number; debt: number; streak: number; martin: boolean }

export interface Position {
  dir: 1 | -1;
  basis: number;
  margin: number;
  entry: number;
  lev: number;
  t0: number;
  worst: number;
  snap: Snap;
  snipe: boolean;
  whale: boolean;
}

export interface Level {
  li: number;
  live: boolean;
  start: number;
  target: number;
  cash: number;
  debt: number;
  pos: Position | null;
  dur: number;
  candles: Candle[];
  cur: Candle | null;
  lastP: number | null;
  high: number;
  copium: boolean;
  feed: FeedItem[];
  drop: number;
  loan: number;
  drained: string | null;
  done: boolean;
  taxN: number;
  pumpT: number;
  lastSnap: Snap | null;
  t0: number;
}

export interface Offer { id: string; sold: boolean; con: boolean }

export interface ClearInfo { bank: number; target: number; a: number; b: number; c: number }

export type LogEntry = [layer: number, tick: number, code: string];

export interface RunState {
  /** Generator id, a key of the engine's generator registry. */
  gen: string;
  seed: Seed;
  rng: RngState;
  shopRng: RngState;
  phase: Phase;
  i: number;
  bank: number;
  credits: number;
  inds: string[];
  cons: (string | null)[];
  nft: string | null;
  streak: number;
  trades: number;
  best: number;
  bagMult: number;
  whaleMult: number;
  martin: boolean;
  log: LogEntry[];
  offers: Offer[];
  clear: ClearInfo | null;
  won: boolean | null;
  m: Market;
  lv: Level;
}

export type EngineEvent =
  | { k: 'headline'; text: string; type: EventType | null; flagged: boolean; mine: boolean }
  | { k: 'open'; dir: 1 | -1; snipe: boolean }
  | { k: 'win'; total: number; mult: number; tags: string[]; streak: number; big: boolean }
  | { k: 'loss'; loss: number; notes: string[] }
  | { k: 'liquidated' }
  | { k: 'apeLocked' }
  | { k: 'item'; id: string; amount?: number; into?: 'trade' | 'cash' }
  | { k: 'reorgEmpty' }
  | { k: 'countdown'; left: number }
  | { k: 'cleared'; bank: number; target: number; a: number; b: number; c: number; last: boolean }
  | { k: 'failed'; bank: number; target: number };

export interface InputResult { ok: boolean; events: EngineEvent[] }

/**
 * Events as a client may see them. Same as EngineEvent except headlines carry
 * no event type: the player reads the text, like on screen.
 */
export type PublicEvent =
  | { k: 'headline'; text: string; flagged: boolean; mine: boolean }
  | Exclude<EngineEvent, { k: 'headline' }>;

/** Rebuilds each event field by field, so nothing outside the public shape survives. */
export function toPublicEvents(ev: readonly EngineEvent[]): PublicEvent[] {
  return ev.map((e): PublicEvent => {
    switch (e.k) {
      case 'headline': return { k: 'headline', text: e.text, flagged: e.flagged, mine: e.mine };
      case 'open': return { k: 'open', dir: e.dir, snipe: e.snipe };
      case 'win': return { k: 'win', total: e.total, mult: e.mult, tags: e.tags.slice(), streak: e.streak, big: e.big };
      case 'loss': return { k: 'loss', loss: e.loss, notes: e.notes.slice() };
      case 'item': {
        const o: PublicEvent = { k: 'item', id: e.id };
        if (e.amount !== undefined) o.amount = e.amount;
        if (e.into !== undefined) o.into = e.into;
        return o;
      }
      case 'countdown': return { k: 'countdown', left: e.left };
      case 'cleared': return { k: 'cleared', bank: e.bank, target: e.target, a: e.a, b: e.b, c: e.c, last: e.last };
      case 'failed': return { k: 'failed', bank: e.bank, target: e.target };
      case 'liquidated': case 'apeLocked': case 'reorgEmpty': return { k: e.k };
    }
  });
}

export interface Receipt {
  game: 'exit-liquidity';
  /** 2: the prototype's format, always mulberry32. 3: adds rng. */
  v: 2 | 3;
  /** Generator id. Absent in v2 receipts, which are mulberry32. */
  rng?: string;
  seed: Seed;
  mint: string | null;
  log: LogEntry[];
  result: RunResult;
  /** Math implementation that produced the run. Absent means the host's Math (the prototype's receipts). */
  math?: string;
}

export interface RunResult { layers: number; bank: number }

export type Button = 'buy' | 'sell' | 'lock' | 'item0' | 'item1';

export interface ReplayOutcome {
  ok: boolean;
  error?: string;
  result: RunResult | null;
  state: RunState | null;
}

// ---------- factory ----------

export function makeEngine(math: MathImpl = Math, mathId: string = 'native', generators: Readonly<Record<string, Generator>> = GENERATORS) {
  const { exp, log, cos } = math;

  function genOf(id: string): Generator {
    const g = generators[id];
    if (!g) throw new Error('unknown generator: ' + id);
    return g;
  }
  // random draws mutate the stored generator state
  function rnd(S: RunState): number { return genOf(S.gen).next(S.rng) }
  function shopRnd(S: RunState): number { return genOf(S.gen).next(S.shopRng) }
  function gauss(S: RunState): number {
    let u = 0;
    while (u === 0) u = rnd(S);
    return Math.sqrt(-2 * log(u)) * cos(6.283185307 * rnd(S));
  }

  function lvl(S: RunState): LevelDef { return LEVELS[S.lv.li] as LevelDef }

  // ---------- market ----------

  function makeMarket(S: RunState): Market {
    return { t: 0, lf: 0, dev: 0, p0: 0.01 + rnd(S) * 0.4, p: 0, q: [], nextEv: null };
  }

  function pickEvent(L: LevelDef, S: RunState): { type: EventType; mag: number; dur: number } {
    const w: [EventType, number][] = [['pump', 3.4], ['dump', 2.2], ['dip', 3], ['spike', 2]];
    if (L.rug) w.push(['rug', 0.6]);
    let tot = 0;
    for (const x of w) tot += x[1];
    let z = rnd(S) * tot;
    let type: EventType = 'pump';
    for (const x of w) { z -= x[1]; if (z <= 0) { type = x[0]; break } }
    const v = Math.sqrt(L.vol);
    if (type === 'pump' || type === 'dump') {
      const mag = (0.16 + rnd(S) * 0.14) * v;
      return { type, mag, dur: 25 + Math.floor(rnd(S) * 20) };
    }
    if (type === 'dip' || type === 'spike') return { type, mag: (0.15 + rnd(S) * 0.10) * v, dur: 3 };
    return { type, mag: 0.55 + rnd(S) * 0.25, dur: 8 };
  }

  interface Fresh { t: number; type: EventType; fake: boolean; n: number }

  // One 100ms step. Returns a headline when one fires, else null.
  function stepMarket(S: RunState, L: LevelDef, posDir: number, lead: number): Fresh | null {
    const m = S.m;
    m.t++;
    let fresh: Fresh | null = null;
    if (m.nextEv !== null && m.t >= m.nextEv) {
      const ev = pickEvent(L, S);
      const fake = rnd(S) < L.fake;
      fresh = { t: m.t, type: ev.type, fake, n: Math.floor(rnd(S) * 8) };
      if (!fake) m.q.push({ type: ev.type, mag: ev.mag, dur: ev.dur, start: m.t + lead, end: m.t + lead + ev.dur });
      m.nextEv = m.t + L.gapMin + rnd(S) * L.gapVar;
    }
    let drift = 0, shock = 0;
    for (const e of m.q) {
      if (m.t > e.start && m.t <= e.end) {
        const s = e.mag / e.dur;
        if (e.type === 'pump') drift += s;
        else if (e.type === 'dump' || e.type === 'rug') drift -= s;
        else if (e.type === 'dip') shock -= s;
        else shock += s;
      }
    }
    m.q = m.q.filter((e) => m.t <= e.end);
    if (L.hunter && posDir) shock -= 0.002 * posDir;
    m.lf += drift + 0.0025 * L.vol * gauss(S);
    m.dev = m.dev * (1 - K) + 0.008 * L.vol * gauss(S) + shock;
    m.p = m.p0 * exp(m.lf + m.dev);
    return fresh;
  }

  // ---------- helpers ----------

  function has(S: RunState, id: string): boolean { return S.inds.indexOf(id) >= 0 || S.nft === id }
  function slots(S: RunState): number { return SLOTS + (has(S, 'sticky') ? 2 : 0) }
  function consCount(S: RunState): number { return S.cons.filter(Boolean).length }
  function feeRate(S: RunState): number { return has(S, 'mev') ? 0 : 0.005 }
  function levNow(S: RunState): number { return (has(S, 'lev2') ? 2 : 1) * (has(S, 'lev5') ? 5 : 1) }
  function posValue(S: RunState): number {
    const x = S.lv.pos as Position;
    return Math.max(0, x.margin * (1 + x.lev * x.dir * (S.m.p / x.entry - 1)));
  }
  function equity(S: RunState): number { const Lv = S.lv; return Lv.cash + (Lv.pos ? posValue(S) : 0) - Lv.debt }
  function apeLocked(S: RunState): boolean { return !!S.lv.pos && has(S, 'ape') && S.m.t - S.lv.pos.t0 < 20 }
  function playTick(S: RunState): number { return S.phase === 'play' ? S.m.t - S.lv.t0 : -1 }
  function lg(S: RunState, code: string): void { S.log.push([S.i, playTick(S), code]) }
  function fill(text: string, S: RunState): string { return text.replace('{T}', lvl(S).tk) }

  function pushCandle(Lv: Level, p: number, f: number): void {
    if (!Lv.cur) {
      const o = Lv.lastP == null ? p : Lv.lastP;
      Lv.cur = { o, h: Math.max(o, p), l: Math.min(o, p), c: p, f: 0, n: 0 };
    }
    const c = Lv.cur;
    c.h = Math.max(c.h, p); c.l = Math.min(c.l, p); c.c = p; c.f = f; c.n++; Lv.lastP = p;
    if (c.n >= CANDLE) { Lv.candles.push(c); Lv.cur = null; if (Lv.candles.length > MAX_CANDLES) Lv.candles.shift() }
  }
  function pushTick(S: RunState): void { pushCandle(S.lv, S.m.p, S.m.p0 * exp(S.m.lf)) }

  function ma20(S: RunState): number {
    const Lv = S.lv;
    const a = Lv.candles.slice(-20);
    let s = 0, n = 0;
    for (const c of a) { s += c.c; n++ }
    if (Lv.cur) { s += Lv.cur.c; n++ }
    return n ? s / n : S.m.p;
  }

  function addFeed(S: RunState, text: string, fake: boolean, mine: boolean): void {
    const Lv = S.lv;
    Lv.feed.unshift({ text: fill(text, S), fake, mine });
    if (Lv.feed.length > 2) Lv.feed.pop();
  }

  // ---------- run and level setup ----------

  function blankRun(seed: Seed, gen: string): RunState {
    const { run, shop } = genOf(gen).init(seed);
    const S = {
      gen, seed, rng: run, shopRng: shop, phase: 'intro', i: 0, bank: 100, credits: 0,
      inds: [], cons: [null, null], nft: null, streak: 0, trades: 0, best: 0, bagMult: 0, whaleMult: 0,
      martin: false, log: [], offers: [], clear: null, won: null,
    } as unknown as RunState;
    return S;
  }

  function prepLevel(S: RunState, live: boolean): void {
    const L = LEVELS[S.i] as LevelDef;
    const before = S.bank;
    let drop = 0, loan = 0, gain = L.gain, drained: string | null = null;
    if (live && has(S, 'sticky')) {
      const c = S.inds.filter((id) => id !== 'sticky');
      if (c.length && shopRnd(S) < 0.10) {
        drained = c[Math.floor(shopRnd(S) * c.length)] as string;
        S.inds.splice(S.inds.indexOf(drained), 1);
      }
    }
    if (live && has(S, 'airdrop')) { drop = S.bank * 0.08; S.bank += drop }
    if (live && has(S, 'devwallet')) { loan = S.bank; gain *= 1.5 }
    S.m = makeMarket(S);
    S.lv = {
      li: S.i, live, start: S.bank, target: before * (1 + gain), cash: S.bank + loan, debt: loan, pos: null,
      dur: 450 + (live && has(S, 'time') ? 120 : 0), candles: [], cur: null, lastP: null, high: 0,
      copium: has(S, 'copium'), feed: [], drop, loan, drained, done: false, taxN: 0, pumpT: -999,
      lastSnap: null, t0: 0,
    };
    for (let k = 0; k < WARMUP; k++) { stepMarket(S, L, 0, 12); pushTick(S) }
    S.m.nextEv = S.m.t + 12;
    S.lv.t0 = S.m.t;
    S.lv.high = S.m.p;
  }

  /**
   * A new run waiting on the intro screen of layer 1. Practice uses mulberry32
   * with a uint32 seed (the prototype's rules); ranked uses xoshiro256** with a
   * 32 byte seed.
   */
  function createRun(seed: Seed, mint: string | null = null, gen: string = 'mulberry32'): RunState {
    if (mint != null && !IND[mint]) throw new Error('unknown minted indicator: ' + mint);
    const S = blankRun(seed, gen);
    S.nft = mint;
    prepLevel(S, true);
    S.phase = 'intro';
    return S;
  }

  /** The background chart behind the title screen. Not a run. */
  function createAttract(seed: number): RunState {
    const S = blankRun(seed, 'mulberry32');
    prepLevel(S, false);
    S.phase = 'attract';
    return S;
  }

  // ---------- trading ----------

  function openPos(S: RunState, dir: 1 | -1, ev: EngineEvent[]): boolean {
    const Lv = S.lv, M = S.m;
    if (S.phase !== 'play' || Lv.pos || Lv.cash <= 0) return false;
    if (dir === -1 && !has(S, 'short')) return false;
    lg(S, dir === 1 ? 'O+' : 'O-');
    const fee = Lv.cash * feeRate(S);
    Lv.pos = {
      dir, basis: Lv.cash, margin: Lv.cash - fee, entry: M.p, lev: levNow(S), t0: M.t, worst: 0,
      snap: { cash: Lv.cash, debt: Lv.debt, streak: S.streak, martin: S.martin },
      snipe: dir === 1 && has(S, 'sniper') && M.p <= ma20(S) * 0.94,
      whale: dir === 1 && M.t - Lv.pumpT <= 20,
    };
    Lv.cash = 0;
    ev.push({ k: 'open', dir, snipe: Lv.pos.snipe });
    return true;
  }

  function closePos(S: RunState, why: string | null, ev: EngineEvent[]): void {
    const Lv = S.lv, M = S.m;
    const x = Lv.pos;
    if (!x) return;
    const net = posValue(S) * (1 - feeRate(S));
    const profit = net - x.basis;
    let add = 0, mult = 1;
    const tags: string[] = [];
    if (profit > 0) {
      mult = 1 + S.streak * (has(S, 'compound') ? 0.2 : 0.1);
      const held = (M.t - x.t0) / 10;
      if (has(S, 'diamond')) { const b = Math.min(1, held * 0.05); if (b >= 0.05) { mult += b; tags.push('diamond') } }
      if (has(S, 'paper') && held <= 3) { mult += 0.5; tags.push('paper') }
      if (x.snipe) { mult += 0.75; tags.push('sniped') }
      if (has(S, 'top') && x.dir === 1 && M.p >= Lv.high * 0.97) { mult += 1; tags.push('top tick') }
      if (has(S, 'bag')) { if (x.worst <= -0.15) { S.bagMult += 0.1; tags.push('bag grew') } mult += S.bagMult }
      if (has(S, 'whale')) { if (x.whale) { S.whaleMult += 0.15; tags.push('whale grew') } mult += S.whaleMult }
      if (has(S, 'ape')) { mult += 2; tags.push('ape') }
      if (S.martin) { if (has(S, 'martin')) { mult *= 2; tags.push('martingale') } S.martin = false }
      add = profit * (mult - 1);
      if (profit >= x.basis * 0.02) S.streak++;
      const total = profit + add;
      if (total > S.best) S.best = total;
      ev.push({ k: 'win', total, mult, tags, streak: S.streak, big: total > x.basis * 0.15 });
    } else {
      const notes: string[] = [];
      if (why) notes.push(why);
      if (Lv.copium && S.streak > 0) { Lv.copium = false; notes.push('copium saved streak') }
      else S.streak = 0;
      S.martin = has(S, 'martin');
      if (has(S, 'tax') && Lv.taxN < 2) { Lv.taxN++; S.credits++; notes.push('+1 alpha harvested') }
      ev.push({ k: 'loss', loss: -profit, notes });
    }
    Lv.cash += net + add;
    Lv.pos = null;
    Lv.lastSnap = x.snap;
    S.trades++;
  }

  // ---------- items ----------

  function useItem(S: RunState, id: string, ev: EngineEvent[]): boolean {
    const Lv = S.lv, M = S.m;
    const k = S.cons.indexOf(id);
    if (S.phase !== 'play' || k < 0 || !CON[id]) return false;
    const v = Math.sqrt(lvl(S).vol);
    if (id === 'reorg' && (Lv.pos || !Lv.lastSnap)) { ev.push({ k: 'reorgEmpty' }); return false }
    lg(S, 'C:' + id);
    if (id === 'inject') {
      const X = Lv.start * 0.5;
      Lv.debt += X;
      if (Lv.pos) {
        const x = Lv.pos, V = posValue(S), net = X * (1 - feeRate(S)), m2 = x.margin + net;
        const k2 = ((V + net) / m2 - 1) / (x.lev * x.dir);
        x.entry = M.p / (1 + k2); x.margin = m2; x.basis += X;
        ev.push({ k: 'item', id, amount: X, into: 'trade' });
      } else {
        Lv.cash += X;
        ev.push({ k: 'item', id, amount: X, into: 'cash' });
      }
    } else if (id === 'shill') {
      M.q.push({ type: 'pump', mag: 0.22 * v, dur: 30, start: M.t + 5, end: M.t + 35 });
      Lv.pumpT = M.t;
      addFeed(S, 'You paid a guy. He is posting about {T} right now', false, true);
      ev.push({ k: 'item', id }, headlineEvent(S, 0, null));
    } else if (id === 'fud') {
      M.q.push({ type: 'dip', mag: 0.2 * v, dur: 3, start: M.t + 5, end: M.t + 8 });
      addFeed(S, 'Your burner account says {T} is finished', false, true);
      ev.push({ k: 'item', id }, headlineEvent(S, 0, null));
    } else if (id === 'breaker') {
      M.q = [];
      addFeed(S, 'Trading halt on {T}. Every pending move is cancelled', false, true);
      ev.push({ k: 'item', id }, headlineEvent(S, 0, null));
    } else if (id === 'reorg') {
      const s = Lv.lastSnap as Snap;
      Lv.cash = s.cash; Lv.debt = s.debt; S.streak = s.streak; S.martin = s.martin; Lv.lastSnap = null;
      ev.push({ k: 'item', id });
    }
    S.cons[k] = null;
    return true;
  }

  function headlineEvent(S: RunState, idx: number, type: EventType | null): EngineEvent {
    const f = S.lv.feed[idx] as FeedItem;
    return { k: 'headline', text: f.text, type, flagged: insiderFlag(S) && f.fake, mine: f.mine };
  }
  function insiderFlag(S: RunState): boolean { return S.phase === 'play' && has(S, 'insider') }

  // ---------- level end and shop ----------

  function endLevel(S: RunState, locked: boolean, ev: EngineEvent[]): void {
    const Lv = S.lv, M = S.m;
    if (Lv.done) return;
    Lv.done = true;
    if (Lv.pos) closePos(S, 'time up', ev);
    const left = Math.max(0, Lv.dur - (M.t - Lv.t0));
    const bank = Math.max(0, Lv.cash - Lv.debt);
    if (bank >= Lv.target) {
      const sPct = (bank / Lv.target - 1) * 100;
      const a = 3, b = Math.min(6, Math.floor(sPct / 15)), c = locked ? Math.floor(left / 100) : 0;
      S.bank = bank;
      S.credits += a + b + c;
      S.clear = { bank, target: Lv.target, a, b, c };
      const last = S.i >= LEVELS.length - 1;
      ev.push({ k: 'cleared', bank, target: Lv.target, a, b, c, last });
      if (last) { S.phase = 'end'; S.won = true }
      else { S.i++; rollOffers(S); S.phase = 'shop' }
    } else {
      S.bank = bank;
      ev.push({ k: 'failed', bank, target: Lv.target });
      S.phase = 'end';
      S.won = false;
    }
  }

  function shuffled<T>(S: RunState, a: readonly T[]): T[] {
    const b = a.slice();
    for (let k = b.length - 1; k > 0; k--) {
      const j = Math.floor(shopRnd(S) * (k + 1));
      const t = b[k] as T; b[k] = b[j] as T; b[j] = t;
    }
    return b;
  }

  function rollOffers(S: RunState): void {
    const a = shuffled(S, INDS.filter((x) => !has(S, x.id))).slice(0, 3).map((x) => ({ id: x.id, sold: false, con: false }));
    const b = shuffled(S, CONS).slice(0, 2).map((x) => ({ id: x.id, sold: false, con: true }));
    S.offers = a.concat(b);
  }

  // ---------- inputs ----------

  /**
   * Applies one input. Codes:
   * play:  O+ (open long), O- (open short), X (close), L (lock in), C:<item id>
   * shop:  buy:<id>, sell:<indicator id>, reroll, next (to the next intro)
   * intro: go (open the chart)
   * Every accepted code except go and next is appended to the log, exactly as
   * the prototype's receipt records it.
   */
  function applyInput(S: RunState, code: string): InputResult {
    const ev: EngineEvent[] = [];
    let ok = false;
    const Lv = S.lv;
    if (S.phase === 'play') {
      if (code === 'O+') ok = openPos(S, 1, ev);
      else if (code === 'O-') ok = openPos(S, -1, ev);
      else if (code === 'X') {
        if (Lv.pos) {
          if (apeLocked(S)) ev.push({ k: 'apeLocked' });
          else { lg(S, 'X'); closePos(S, null, ev); ok = true }
        }
      } else if (code === 'L') {
        if (!Lv.pos && Lv.cash - Lv.debt >= Lv.target) { lg(S, 'L'); endLevel(S, true, ev); ok = true }
      } else if (code.startsWith('C:')) ok = useItem(S, code.slice(2), ev);
    } else if (S.phase === 'intro') {
      if (code === 'go') { S.phase = 'play'; ok = true }
    } else if (S.phase === 'shop') {
      if (code.startsWith('buy:')) {
        const id = code.slice(4);
        const o = S.offers.find((x) => x.id === id);
        if (o) {
          const x = o.con ? CON[o.id] : IND[o.id];
          const room = o.con ? consCount(S) < CSLOTS : S.inds.length < slots(S);
          if (x && !o.sold && S.credits >= x.cost && room) {
            S.credits -= x.cost;
            if (o.con) S.cons[S.cons.indexOf(null)] = o.id; else S.inds.push(o.id);
            o.sold = true;
            lg(S, code);
            ok = true;
          }
        }
      } else if (code.startsWith('sell:')) {
        const id = code.slice(5);
        const k = S.inds.indexOf(id);
        if (k >= 0) { S.inds.splice(k, 1); S.credits += 1; lg(S, code); ok = true }
      } else if (code === 'reroll') {
        if (S.credits >= 1) { S.credits--; lg(S, code); rollOffers(S); ok = true }
      } else if (code === 'next') {
        prepLevel(S, true);
        S.phase = 'intro';
        ok = true;
      }
    }
    return { ok, events: ev };
  }

  /** Translates a button press into an input code for the current state, as the prototype's press handlers did. */
  function pressCode(S: RunState, b: Button): string | null {
    if (S.phase !== 'play') return null;
    const x = S.lv.pos;
    if (b === 'buy') return x ? (x.dir === -1 ? 'X' : null) : 'O+';
    if (b === 'sell') return x ? (x.dir === 1 ? 'X' : null) : 'O-';
    if (b === 'lock') return 'L';
    const id = S.cons[b === 'item0' ? 0 : 1];
    return id ? 'C:' + id : null;
  }

  // ---------- tick ----------

  /** Advances one 100ms tick. Does nothing outside play and attract. */
  function tick(S: RunState): EngineEvent[] {
    const ev: EngineEvent[] = [];
    if (S.phase !== 'play' && S.phase !== 'attract') return ev;
    const Lv = S.lv, M = S.m, play = S.phase === 'play';
    const L = lvl(S);
    const lead = play && has(S, 'insider') ? 24 : 12;
    const fresh = stepMarket(S, L, Lv.pos ? Lv.pos.dir : 0, lead);
    pushTick(S);
    if (M.p > Lv.high) Lv.high = M.p;
    if (fresh) {
      const arr = HEAD[fresh.type];
      if (fresh.type === 'pump') Lv.pumpT = M.t;
      addFeed(S, arr[fresh.n % arr.length] as string, fresh.fake, false);
      ev.push(headlineEvent(S, 0, fresh.type));
    }
    if (!play) return ev;
    if (Lv.pos) {
      const x = Lv.pos;
      if (has(S, 'funding')) x.margin *= x.dir === -1 ? 1.0004 : 0.9998;
      const v = posValue(S), r = v / x.margin - 1;
      if (r < x.worst) x.worst = r;
      if (v <= 0) {
        Lv.pos = null; S.streak = 0; S.martin = has(S, 'martin'); S.trades++;
        ev.push({ k: 'liquidated' });
      } else if (has(S, 'stop') && r <= -0.12) closePos(S, 'stop loss', ev);
    }
    const left = Lv.dur - (M.t - Lv.t0);
    if (left <= 50 && left > 0 && left % 10 === 0) ev.push({ k: 'countdown', left });
    if (equity(S) <= 0 || (!Lv.pos && equity(S) < 0.5)) { endLevel(S, false, ev); return ev }
    if (left <= 0) endLevel(S, false, ev);
    return ev;
  }

  // ---------- receipts and replay ----------

  function result(S: RunState): RunResult {
    return { layers: S.won ? LEVELS.length : S.i, bank: +S.bank.toFixed(2) };
  }

  function receipt(S: RunState): Receipt {
    const r: Receipt = { game: 'exit-liquidity', v: 3, rng: S.gen, seed: S.seed, mint: S.nft, log: S.log.map((e) => [e[0], e[1], e[2]] as LogEntry), result: result(S) };
    if (mathId !== 'native') r.math = mathId;
    return r;
  }

  /**
   * Replays a receipt's seed, mint and input log from scratch. Phase changes
   * that the log does not record (opening the chart, leaving the shop) are
   * implied by the order of entries, as in the prototype.
   */
  function replay(r: Pick<Receipt, 'v' | 'rng' | 'seed' | 'mint' | 'log' | 'math'>, opts: { maxTicks?: number; anyMath?: boolean } = {}): ReplayOutcome {
    const fail = (error: string, state: RunState | null = null): ReplayOutcome => ({ ok: false, error, result: null, state });
    if ((r.math ?? 'native') !== mathId && !opts.anyMath) return fail('receipt math ' + (r.math ?? 'native') + ' does not match engine math ' + mathId);
    let gen: string;
    if (r.v === 2) { if (r.rng !== undefined) return fail('v2 receipts have no rng field'); gen = 'mulberry32' }
    else if (r.v === 3) { if (typeof r.rng !== 'string' || !generators[r.rng]) return fail('unknown generator ' + String(r.rng)); gen = r.rng }
    else return fail('unsupported receipt version ' + String(r.v));
    if (r.mint != null && !IND[r.mint]) return fail('unknown mint');
    if (!Array.isArray(r.log)) return fail('bad log');
    let S: RunState;
    try { S = createRun(r.seed, r.mint ?? null, gen) } catch (e) { return fail('bad seed: ' + String((e as Error).message ?? e)) }
    const logIn = r.log;
    let p = 0, ticks = 0;
    const maxTicks = opts.maxTicks ?? 100000;
    const next = (): LogEntry | undefined => logIn[p];
    while (S.phase !== 'end') {
      if (S.phase === 'intro') { applyInput(S, 'go'); continue }
      if (S.phase === 'shop') {
        let e = next();
        while (e && e[0] === S.i && e[1] === -1) {
          if (!applyInput(S, String(e[2])).ok) return fail('rejected shop input ' + JSON.stringify(e) + ' at entry ' + p, S);
          p++; e = next();
        }
        applyInput(S, 'next');
        continue;
      }
      // play
      const t = S.m.t - S.lv.t0;
      let e = next();
      const startLayer = S.i;
      while (e && e[0] === startLayer && e[1] === t && S.phase === 'play' && S.i === startLayer) {
        if (!applyInput(S, String(e[2])).ok) return fail('rejected input ' + JSON.stringify(e) + ' at entry ' + p, S);
        p++; e = next();
      }
      if (S.phase !== 'play') continue;
      if (e && e[0] === S.i && e[1] >= 0 && e[1] < t) return fail('input out of order at entry ' + p, S);
      if (++ticks > maxTicks) return fail('tick limit', S);
      tick(S);
    }
    if (p !== logIn.length) return fail('unused log entries from ' + p, S);
    return { ok: true, result: result(S), state: S };
  }

  // ---------- view ----------

  function view(S: RunState) { return makeView(S) }

  function makeView(S: RunState): View {
    const Lv = S.lv, M = S.m, L = lvl(S);
    const fair = S.phase === 'play' && has(S, 'vwap');
    // Built field by field: a field added to engine state never reaches a client by accident.
    const strip = (c: Candle): Candle => ({ o: c.o, h: c.h, l: c.l, c: c.c, f: fair ? c.f : 0, n: c.n });
    const shop = S.phase === 'shop';
    const pos = Lv.pos
      ? { dir: Lv.pos.dir, entry: Lv.pos.entry, lev: Lv.pos.lev, ret: posValue(S) / Lv.pos.margin - 1, locked: apeLocked(S) }
      : null;
    const flag = insiderFlag(S);
    return {
      phase: S.phase,
      i: S.i,
      layers: LEVELS.length,
      level: {
        tk: L.tk, lore: L.lore, rug: !!L.rug, fakeChip: L.fake >= 0.3 ? L.fake : null, hunter: !!L.hunter,
        start: Lv.start, target: Lv.target, dur: Lv.dur, drop: Lv.drop, loan: Lv.loan, drained: Lv.drained,
      },
      left: Math.max(0, Lv.dur - (M.t - Lv.t0)),
      p: M.p,
      fair,
      candles: Lv.candles.map(strip),
      cur: Lv.cur ? strip(Lv.cur) : null,
      ma20: S.phase === 'play' && has(S, 'sniper') ? ma20(S) : null,
      feed: Lv.feed.map((f) => ({ text: f.text, flagged: flag && f.fake, mine: f.mine })),
      equity: equity(S),
      pos,
      ready: S.phase === 'play' && !Lv.pos && Lv.cash - Lv.debt >= Lv.target,
      streak: S.streak,
      mult: 1 + S.streak * (has(S, 'compound') ? 0.2 : 0.1),
      canShort: has(S, 'short'),
      inds: S.inds.slice(),
      nft: S.nft,
      cons: S.cons.slice(),
      slots: slots(S),
      credits: S.credits,
      bagMult: S.bagMult,
      whaleMult: S.whaleMult,
      offers: shop ? S.offers.map((o) => ({ id: o.id, sold: o.sold, con: o.con })) : [],
      clear: shop && S.clear ? { bank: S.clear.bank, target: S.clear.target, a: S.clear.a, b: S.clear.b, c: S.clear.c } : null,
      end: S.phase === 'end'
        ? { won: !!S.won, bank: S.bank, layers: result(S).layers, trades: S.trades, best: S.best, seed: S.seed, rng: S.gen }
        : null,
    };
  }

  return {
    createRun, createAttract, applyInput, pressCode, tick, receipt, result, replay, view,
    has, slots, consCount, equity, pushCandle, mathId,
  };
}

export interface PosView { dir: 1 | -1; entry: number; lev: number; ret: number; locked: boolean }

export interface View {
  phase: Phase;
  i: number;
  layers: number;
  level: {
    tk: string; lore: string; rug: boolean;
    /** Fake headline share, only when the intro shows it as a chip (30% or more). */
    fakeChip: number | null;
    hunter: boolean;
    start: number; target: number; dur: number; drop: number; loan: number; drained: string | null;
  };
  left: number;
  p: number;
  /** True when candle f values carry the fair value line (Fair Value indicator in play). */
  fair: boolean;
  candles: Candle[];
  cur: Candle | null;
  ma20: number | null;
  feed: { text: string; flagged: boolean; mine: boolean }[];
  equity: number;
  pos: PosView | null;
  ready: boolean;
  streak: number;
  mult: number;
  canShort: boolean;
  inds: string[];
  nft: string | null;
  cons: (string | null)[];
  slots: number;
  credits: number;
  bagMult: number;
  whaleMult: number;
  offers: Offer[];
  clear: ClearInfo | null;
  end: { won: boolean; bank: number; layers: number; trades: number; best: number; seed: Seed; rng: string } | null;
}

export type Engine = ReturnType<typeof makeEngine>;
