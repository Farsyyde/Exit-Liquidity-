import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { engine, FIXED_MATH_ID, type Receipt } from '../src/index.ts';

interface GoldenRun {
  style: string;
  receipt: Receipt;
  final: {
    bank: number; credits: number; trades: number; best: number; streak: number; i: number;
    inds: string[]; cons: (string | null)[]; bagMult: number; whaleMult: number; won: boolean;
  };
}

const golden = JSON.parse(readFileSync(new URL('./golden/fixed.json', import.meta.url), 'utf8')) as { runs: GoldenRun[] };

// Recorded from reference/prototype.html with Math.exp/log/cos swapped for the
// engine's fixed math (scripts/record-golden.mjs fixed). Replaying in Node must
// reproduce every run bit for bit. The native Math recording is checked inside
// Chromium by browser-parity.test.ts.
describe('golden receipts recorded from the prototype (fixed math)', () => {
  it('has a meaningful sample', () => {
    expect(golden.runs.length).toBeGreaterThanOrEqual(20);
    expect(golden.runs.some((r) => r.final.won)).toBe(true);
  });

  for (const [n, run] of golden.runs.entries()) {
    it(`run ${n} (${run.style}, mint ${run.receipt.mint ?? 'none'}) replays exactly`, () => {
      const out = engine.replay(run.receipt, { anyMath: true });
      expect(out.error).toBeUndefined();
      expect(out.ok).toBe(true);
      expect(out.result).toEqual(run.receipt.result);
      const S = out.state!;
      // exact float equality, not rounding
      expect(S.bank).toBe(run.final.bank);
      expect(S.best).toBe(run.final.best);
      expect(S.credits).toBe(run.final.credits);
      expect(S.trades).toBe(run.final.trades);
      expect(S.streak).toBe(run.final.streak);
      expect(S.i).toBe(run.final.i);
      expect(S.inds).toEqual(run.final.inds);
      expect(S.bagMult).toBe(run.final.bagMult);
      expect(S.whaleMult).toBe(run.final.whaleMult);
      expect(!!S.won).toBe(run.final.won);
      expect(S.cons.filter(Boolean).sort()).toEqual(run.final.cons.filter(Boolean).sort());
      // the engine's own receipt is identical to the prototype's
      expect(engine.receipt(S)).toEqual({ ...run.receipt, math: FIXED_MATH_ID });
    });
  }
});
