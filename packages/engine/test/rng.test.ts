import { describe, expect, it } from 'vitest';
import { engine, makeEngine, fixedMath, mulberry32, MULBERRY32, XOSHIRO256SS, xoshiroJump, xoshiroStep, type Button, type RunState } from '../src/index.ts';

const hex = (p: [number, number]) => p[0].toString(16).padStart(8, '0') + p[1].toString(16).padStart(8, '0');

// Vectors produced by the reference C code (prng.di.unimi.it/xoshiro256starstar.c,
// compiled with gcc), seeded with s = {1, 2, 3, 4}.
const SEED_1234 = '0x0000000000000001000000000000000200000000000000030000000000000004';

describe('xoshiro256**', () => {
  it('matches the reference implementation', () => {
    const { run } = XOSHIRO256SS.init(SEED_1234);
    const outs = Array.from({ length: 5 }, () => hex(xoshiroStep(run)));
    expect(outs).toEqual(['0000000000002d00', '0000000000000000', '000000005a007080', '10e0000000009d80', '10e0b61ce1009d80']);
  });
  it('jump matches the reference implementation', () => {
    const { run } = XOSHIRO256SS.init(SEED_1234);
    for (let k = 0; k < 100000; k++) xoshiroStep(run);
    xoshiroJump(run);
    expect([hex(xoshiroStep(run)), hex(xoshiroStep(run)), hex(xoshiroStep(run))]).toEqual(['bf883a98949197c8', 'ed3c29d5e7966bce', '36b02512ba4f9bb2']);
  });
  it('doubles are the top 53 bits, as (x >> 11) * 2^-53', () => {
    const s = XOSHIRO256SS.init('0xfc4f87cbabe59e614db95c95d9a48d9268773f4dde8cdce07721b87f0b4900c5').run;
    expect([XOSHIRO256SS.next(s), XOSHIRO256SS.next(s), XOSHIRO256SS.next(s)]).toEqual([0.79155228309395409, 0.91619459914245438, 0.11285859241792695]);
  });
  it('shop stream is the run stream jumped 2^128 ahead', () => {
    const { run, shop } = XOSHIRO256SS.init(SEED_1234);
    const j = run.slice(); xoshiroJump(j);
    expect(shop).toEqual(j);
  });
  it('rejects malformed seeds', () => {
    expect(() => XOSHIRO256SS.init(123)).toThrow();
    expect(() => XOSHIRO256SS.init('0x' + 'AB'.repeat(32))).toThrow(); // uppercase: one canonical form
    expect(() => XOSHIRO256SS.init('0x' + '00'.repeat(32))).toThrow();
    expect(() => XOSHIRO256SS.init('0x' + '11'.repeat(31))).toThrow();
    expect(() => MULBERRY32.init('0x' + '11'.repeat(32))).toThrow();
    expect(() => MULBERRY32.init(2 ** 32)).toThrow();
  });
  it('mulberry32 generator is the prototype sequence', () => {
    const a = mulberry32(77), s = MULBERRY32.init(77).run;
    for (let k = 0; k < 1000; k++) expect(MULBERRY32.next(s)).toBe(a());
  });
  it('values are uniform enough (mean and 10 bucket chi square)', () => {
    const s = XOSHIRO256SS.init(SEED_1234).run;
    const b = new Array(10).fill(0); let sum = 0; const n = 200000;
    for (let k = 0; k < n; k++) { const v = XOSHIRO256SS.next(s); sum += v; b[Math.floor(v * 10)]++ }
    expect(Math.abs(sum / n - 0.5)).toBeLessThan(0.005);
    const chi = b.reduce((a, x) => a + (x - n / 10) ** 2 / (n / 10), 0);
    expect(chi).toBeLessThan(27.9); // p = 0.001 at 9 degrees of freedom
  });
});

function play(S: RunState, seed: number): void {
  const R = mulberry32(seed);
  const B: Button[] = ['buy', 'sell', 'lock', 'item0', 'item1'];
  while (S.phase !== 'end') {
    if (S.phase === 'intro') engine.applyInput(S, 'go');
    else if (S.phase === 'shop') { if (S.offers[0]) engine.applyInput(S, 'buy:' + S.offers[0].id); engine.applyInput(S, 'next') }
    else { if (R() < 0.1) { const c = engine.pressCode(S, B[Math.floor(R() * 5)]!); if (c) engine.applyInput(S, c) } engine.tick(S) }
  }
}

describe('receipt v3 and generator selection', () => {
  const XS = '0x' + '5a'.repeat(32);
  it('ranked runs on xoshiro256** record the generator and replay', () => {
    const S = engine.createRun(XS, 'airdrop', 'xoshiro256ss');
    play(S, 3);
    const rc = engine.receipt(S);
    expect(rc).toMatchObject({ v: 3, rng: 'xoshiro256ss', seed: XS, math: 'fdlibm-js-1' });
    const out = engine.replay(rc);
    expect(out.error).toBeUndefined();
    expect(out.state!.bank).toBe(S.bank);
    expect(JSON.parse(JSON.stringify(S))).toEqual(S);
  });
  it('a receipt claiming the other generator does not replay to the same result', () => {
    const S = engine.createRun(12345, null, 'mulberry32');
    play(S, 4);
    const rc = engine.receipt(S);
    expect(engine.replay(rc).ok).toBe(true);
    expect(engine.replay({ ...rc, rng: 'xoshiro256ss' }).ok).toBe(false); // seed has the wrong form
    expect(engine.replay({ ...rc, rng: 'nope' }).error).toMatch(/unknown generator/);
    expect(engine.replay({ ...rc, v: 4 as never }).error).toMatch(/unsupported/);
    const { rng: _r, ...v2 } = rc;
    expect(engine.replay({ ...v2, v: 2 }).result).toEqual(rc.result); // v2 means mulberry32
    expect(engine.replay({ ...rc, v: 2 }).ok).toBe(false);
  });
  it('the same seed bytes give different charts on different generators', () => {
    const a = engine.createRun(0x5a5a5a5a, null, 'mulberry32'), b = engine.createRun(XS, null, 'xoshiro256ss');
    expect(a.m.p).not.toBe(b.m.p);
  });
  it('a generator can be injected', () => {
    let calls = 0;
    const counting = { ...MULBERRY32, id: 'counting', next: (s: number[]) => { calls++; return MULBERRY32.next(s) } };
    const e = makeEngine(fixedMath, 'fdlibm-js-1', { counting });
    const S = e.createRun(9, null, 'counting');
    expect(calls).toBeGreaterThan(400);
    expect(e.receipt(S).rng).toBe('counting');
    expect(() => e.createRun(9, null, 'mulberry32')).toThrow(/unknown generator/);
  });
});
