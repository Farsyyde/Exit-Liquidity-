import { describe, expect, it } from 'vitest';
import { fcos, fexp, flog, mulberry32 } from '../src/index.ts';

// distance in units in the last place between two finite doubles
function ulps(a: number, b: number): number {
  if (a === b) return 0;
  const buf = new DataView(new ArrayBuffer(16));
  buf.setFloat64(0, a); buf.setFloat64(8, b);
  const ia = buf.getBigInt64(0), ib = buf.getBigInt64(8);
  const oa = ia < 0n ? -(ia & 0x7fffffffffffffffn) : ia;
  const ob = ib < 0n ? -(ib & 0x7fffffffffffffffn) : ib;
  const d = oa - ob;
  return Number(d < 0n ? -d : d);
}

describe('fixed math', () => {
  const r = mulberry32(99);
  it('exp stays within 1 ulp of the host over the market range', () => {
    let worst = 0;
    for (let k = 0; k < 200000; k++) { const x = (r() - 0.5) * 40; worst = Math.max(worst, ulps(fexp(x), Math.exp(x))) }
    expect(worst).toBeLessThanOrEqual(1);
  });
  it('log stays within 1 ulp of the host on (0, 1]', () => {
    let worst = 0;
    for (let k = 0; k < 200000; k++) { const x = r() || 1e-300; worst = Math.max(worst, ulps(flog(x), Math.log(x))) }
    expect(worst).toBeLessThanOrEqual(1);
  });
  it('cos stays within 1 ulp of the host on [0, 2pi) (absolute error near zeros)', () => {
    let worst = 0;
    for (let k = 0; k < 200000; k++) {
      const x = 6.283185307 * r();
      const a = fcos(x), b = Math.cos(x);
      if (Math.abs(b) > 1e-6) worst = Math.max(worst, ulps(a, b));
      else expect(Math.abs(a - b)).toBeLessThan(1e-17);
    }
    expect(worst).toBeLessThanOrEqual(1);
  });
  it('handles special values', () => {
    expect(fexp(0)).toBe(1);
    expect(fexp(-Infinity)).toBe(0);
    expect(fexp(Infinity)).toBe(Infinity);
    expect(fexp(1000)).toBe(Infinity);
    expect(fexp(-1000)).toBe(0);
    expect(Number.isNaN(fexp(NaN))).toBe(true);
    expect(flog(1)).toBe(0);
    expect(flog(0)).toBe(-Infinity);
    expect(Number.isNaN(flog(-1))).toBe(true);
    expect(flog(Math.E)).toBeCloseTo(1, 15);
    expect(flog(5e-324)).toBeCloseTo(-744.44007192138, 9);
    expect(fcos(0)).toBe(1);
    expect(fcos(Math.PI)).toBe(-1);
    expect(fcos(-1.2)).toBe(fcos(1.2));
    expect(() => fcos(1e9)).toThrow(RangeError);
  });
  it('known outputs are pinned (portable across runtimes)', () => {
    // If these change, every fixed math receipt is invalid.
    const xs = [0.1, 0.5, 1.7, 3.3, 5.9, -2.2, 12.5];
    const sig = xs.map((x) => [fexp(x), flog(Math.abs(x)), fcos(x)]).flat();
    expect(sig).toMatchSnapshot();
  });
});
