import { describe, expect, it } from 'vitest';
import { CONS, INDS, engine, mulberry32, type Button, type RunState } from '../src/index.ts';
const BUTTONS: Button[] = ['buy', 'sell', 'lock', 'item0', 'item1'];
const SHOP_CODES = [...INDS.map((x) => 'buy:' + x.id), ...CONS.map((x) => 'buy:' + x.id), ...INDS.map((x) => 'sell:' + x.id), 'reroll'];

function checkInvariants(S: RunState): void {
  const nums: [string, number][] = [
    ['bank', S.bank], ['credits', S.credits], ['best', S.best], ['streak', S.streak],
    ['cash', S.lv.cash], ['debt', S.lv.debt], ['p', S.m.p], ['lf', S.m.lf], ['dev', S.m.dev],
    ['target', S.lv.target], ['high', S.lv.high],
  ];
  for (const [k, v] of nums) if (!Number.isFinite(v)) throw new Error(k + ' is ' + v);
  if (S.lv.cash < 0) throw new Error('negative cash ' + S.lv.cash);
  if (S.bank < 0) throw new Error('negative bank');
  if (S.credits < 0) throw new Error('negative credits');
  if (S.m.p <= 0) throw new Error('non positive price');
  const x = S.lv.pos;
  if (x) {
    if (!(x.margin > 0) || !Number.isFinite(x.margin)) throw new Error('position without margin');
    if (!(x.entry > 0) || !Number.isFinite(x.entry)) throw new Error('bad entry');
    if (!(x.basis > 0)) throw new Error('bad basis');
  }
  if (S.cons.length !== 2) throw new Error('item slots changed');
}

/** Plays a random run. Random presses at random ticks, random shop actions, random mint. */
function fuzzRun(seed: number, opts: { pressRate: number; checkEveryTick: boolean }): RunState {
  const R = mulberry32(seed ^ 0xabcdef);
  const mint = R() < 0.5 ? (INDS[Math.floor(R() * INDS.length)]!.id) : null;
  const S = engine.createRun(seed, mint);
  let guard = 0;
  while (S.phase !== 'end') {
    if (++guard > 20000) throw new Error('run did not terminate');
    if (S.phase === 'intro') { engine.applyInput(S, 'go'); continue }
    if (S.phase === 'shop') {
      const n = Math.floor(R() * 8);
      for (let k = 0; k < n; k++) engine.applyInput(S, SHOP_CODES[Math.floor(R() * SHOP_CODES.length)]!);
      engine.applyInput(S, 'next');
      continue;
    }
    while (R() < opts.pressRate) {
      const code = engine.pressCode(S, BUTTONS[Math.floor(R() * BUTTONS.length)]!);
      if (code) engine.applyInput(S, code);
      // garbage input must be ignored, never crash
      if (R() < 0.05) engine.applyInput(S, ['C:nope', 'O?', '', 'buy:diamond', 'L'][Math.floor(R() * 5)]!);
      if (S.phase !== 'play') break;
    }
    if (S.phase === 'play') engine.tick(S);
    if (opts.checkEveryTick) checkInvariants(S);
  }
  checkInvariants(S);
  return S;
}

describe('property: random input logs', () => {
  it('never produce NaN, negative cash, or a position without margin, and always replay', () => {
    let deep = 0;
    for (let n = 0; n < 300; n++) {
      const seed = (Math.imul(n + 17, 0x9e3779b1) >>> 0);
      const S = fuzzRun(seed, { pressRate: 0.08 + (n % 5) * 0.05, checkEveryTick: true });
      if (S.i >= 1) deep++;
      const rc = engine.receipt(S);
      const out = engine.replay(rc);
      expect(out.error).toBeUndefined();
      expect(out.result).toEqual(rc.result);
      expect(out.state!.bank).toBe(S.bank);
    }
    expect(deep).toBeGreaterThan(0);
  });

  it('rejects tampered receipts', () => {
    let S: RunState;
    let seed = 1;
    do { S = fuzzRun(seed++, { pressRate: 0.2, checkEveryTick: false }) } while (S.log.length < 6);
    const rc = engine.receipt(S);
    const playIdx = rc.log.findIndex((e) => e[1] >= 0);
    // shift an input to a tick that is already past
    const t1 = structuredClone(rc);
    const later = t1.log.findIndex((e, k) => k > 0 && e[1] > 0 && t1.log[k - 1]![0] === e[0] && t1.log[k - 1]![1] >= 0);
    if (later > 0) { t1.log[later]![1] = 0; const o = engine.replay(t1); expect(o.ok && o.result!.bank === rc.result.bank).toBe(false) }
    // an input that cannot be applied
    const t2 = structuredClone(rc);
    t2.log.splice(playIdx, 0, [rc.log[playIdx]![0], rc.log[playIdx]![1], 'C:shill']);
    expect(engine.replay(t2).ok).toBe(false);
    // extra entry after the end
    const t3 = structuredClone(rc);
    t3.log.push([99, 0, 'O+']);
    expect(engine.replay(t3).ok).toBe(false);
    // bad seed and mint
    expect(engine.replay({ ...rc, seed: -1 }).ok).toBe(false);
    expect(engine.replay({ ...rc, mint: 'free-money' }).ok).toBe(false);
  });
});

describe('state is plain serializable data', () => {
  it('a JSON round trip mid run continues identically', () => {
    for (let n = 0; n < 20; n++) {
      const R = mulberry32(n + 500);
      const A = engine.createRun(1000 + n, n % 3 ? null : 'insider');
      let steps = 0;
      // play into the run, then clone through JSON
      while (A.phase !== 'end' && steps < 400 + n * 37) {
        steps++;
        if (A.phase === 'intro') engine.applyInput(A, 'go');
        else if (A.phase === 'shop') { engine.applyInput(A, 'buy:' + (A.offers[0]?.id ?? '')); engine.applyInput(A, 'next') }
        else { if (R() < 0.05) { const c = engine.pressCode(A, R() < 0.5 ? 'buy' : 'sell'); if (c) engine.applyInput(A, c) } engine.tick(A) }
      }
      const B = JSON.parse(JSON.stringify(A)) as RunState;
      expect(B).toEqual(A);
      for (let k = 0; k < 2000 && A.phase !== 'end'; k++) {
        const press = R() < 0.05 ? (R() < 0.5 ? 'buy' : 'sell') : null;
        for (const S of [A, B]) {
          if (S.phase === 'intro') engine.applyInput(S, 'go');
          else if (S.phase === 'shop') engine.applyInput(S, 'next');
          else { if (press) { const c = engine.pressCode(S, press as Button); if (c) engine.applyInput(S, c) } engine.tick(S) }
        }
      }
      expect(JSON.stringify(B)).toBe(JSON.stringify(A));
    }
  });
});

describe('math tagging', () => {
  it('fixed math receipts carry their math id and native ones are refused by the fixed engine', () => {
    const S = engine.createRun(42);
    engine.applyInput(S, 'go');
    while (S.phase === 'play') engine.tick(S);
    const rc = engine.receipt(S);
    expect(rc.math).toBe('fdlibm-js-1');
    expect(engine.replay(rc).ok).toBe(true);
    const { math: _m, ...nat } = rc;
    expect(engine.replay(nat).ok).toBe(false);
  });
});
