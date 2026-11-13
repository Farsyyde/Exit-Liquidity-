import { describe, expect, it } from 'vitest';
import { engine, type RankedReceipt, attestationMessage, canonicalReceipt, nativeEngine } from '@exit-liquidity/engine';
import { commitOf, keccakHex, parseSeedHex, runSeedOf, utcDay } from '../src/seeds.ts';
import { loadOrCreateSigner } from '../src/sign.ts';
import { verifyRanked } from '../src/verify.ts';

const SEED = '0x' + '11'.repeat(32);
const seedBytes = parseSeedHex(SEED);

function makeRun(player = 7, attempt = 1, native = false) {
  const eng = native ? nativeEngine : engine;
  const seed = runSeedOf(seedBytes, player, attempt);
  const S = eng.createRun(seed, 'insider', 'xoshiro256ss');
  eng.applyInput(S, 'go');
  let k = 0;
  while (S.phase !== 'end') {
    if (S.phase === 'shop') { eng.applyInput(S, 'next'); continue }
    if (S.phase === 'intro') { eng.applyInput(S, 'go'); continue }
    if (k++ % 37 === 5) { const c = eng.pressCode(S, S.lv.pos ? 'sell' : 'buy'); if (c) eng.applyInput(S, c) }
    eng.tick(S);
  }
  const receipt: RankedReceipt = { ...eng.receipt(S), ranked: { day: '2026-11-12', player, attempt } };
  const signer = loadOrCreateSigner(null);
  const body = { run: 1, day: '2026-11-12', player, attempt, receiptHash: keccakHex(canonicalReceipt(receipt)), result: receipt.result };
  const attestation = { ...body, signer: signer.publicHex, sig: signer.sign(attestationMessage(body)) };
  return { receipt, attestation, signer };
}

describe('seeds', () => {
  it('derives run seeds deterministically and differently per player and attempt', () => {
    const a = runSeedOf(seedBytes, 1, 1);
    expect(runSeedOf(seedBytes, 1, 1)).toBe(a);
    expect(runSeedOf(seedBytes, 2, 1)).not.toBe(a);
    expect(runSeedOf(seedBytes, 1, 2)).not.toBe(a);
    expect(a).toMatch(/^0x[0-9a-f]{64}$/); // the full hash, nothing truncated
    expect(a).toBe(keccakHex(new Uint8Array([...seedBytes, ...new Uint8Array(31), 1, ...new Uint8Array(31), 1])));
  });
  it('commit is keccak256 of the seed bytes', () => {
    // keccak256 of 32 bytes of 0x11, independently known value
    expect(commitOf(seedBytes)).toBe(keccakHex(seedBytes));
    expect(keccakHex('')).toBe('0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
  });
  it('utcDay', () => { expect(utcDay(Date.UTC(2026, 0, 2, 23, 59))).toBe('2026-01-02') });
});

describe('verifier', () => {
  const good = makeRun();
  const base = { receipt: good.receipt, attestation: good.attestation, dailySeed: SEED, commit: commitOf(seedBytes), signer: good.signer.publicHex };

  it('accepts an honest run', () => {
    const out = verifyRanked(base);
    expect(out.problems).toEqual([]);
    expect(out.ok).toBe(true);
  });
  it('rejects a claimed result the log does not produce', () => {
    const r = structuredClone(good.receipt); r.result.bank += 1;
    expect(verifyRanked({ ...base, receipt: r }).ok).toBe(false);
  });
  it('rejects an edited input log even with the original attestation', () => {
    const r = structuredClone(good.receipt); r.log = r.log.slice(1);
    expect(verifyRanked({ ...base, receipt: r }).ok).toBe(false);
  });
  it('rejects a seed not derived from the daily seed', () => {
    expect(verifyRanked({ ...base, dailySeed: '0x' + '22'.repeat(32) }).ok).toBe(false);
    const r = structuredClone(good.receipt); r.ranked.attempt = 2;
    expect(verifyRanked({ ...base, receipt: r, attestation: null }).problems.join()).toMatch(/not derived/);
  });
  it('rejects a reveal that does not match the commit', () => {
    expect(verifyRanked({ ...base, commit: '0x' + '00'.repeat(32) }).ok).toBe(false);
  });
  it('rejects forged or foreign signatures', () => {
    expect(verifyRanked({ ...base, attestation: { ...good.attestation, sig: '00'.repeat(64) } }).ok).toBe(false);
    const other = loadOrCreateSigner(null);
    expect(verifyRanked({ ...base, signer: other.publicHex }).ok).toBe(false);
    const att = { ...good.attestation, result: { ...good.attestation.result, layers: 8 } };
    expect(verifyRanked({ ...base, attestation: att }).ok).toBe(false);
  });
  it('rejects ranked receipts on the practice generator', () => {
    const r = structuredClone(good.receipt); r.rng = 'mulberry32';
    expect(verifyRanked({ ...base, receipt: r, attestation: null }).problems.join()).toMatch(/xoshiro256ss/);
    const v2 = structuredClone(good.receipt) as any; v2.v = 2; delete v2.rng;
    expect(verifyRanked({ ...base, receipt: v2, attestation: null }).ok).toBe(false);
  });
  it('rejects ranked receipts made with host math', () => {
    const nat = makeRun(7, 1, true);
    expect(verifyRanked({ ...base, receipt: nat.receipt, attestation: null }).problems.join()).toMatch(/math/);
  });
});
