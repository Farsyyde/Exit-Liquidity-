// Portable exp, log and cos (spec section 4, option 2).
//
// JS engines are free to implement Math.exp, Math.log and Math.cos however
// they like, and they do differ: Chromium 153 and Node 22 disagree in the last
// bit on roughly 10% of inputs. The market compounds those bits, so a receipt
// recorded in one runtime does not replay bit for bit in another.
//
// These are straight ports of the fdlibm 5.3 algorithms (e_exp.c, e_log.c,
// s_cos.c, k_cos.c, k_sin.c, e_rem_pio2.c). They use only IEEE 754 basic
// operations (+ - * /), which JS specifies exactly, plus bit access through a
// DataView. The result is the same on every conforming JS engine.
//
// Do not change a constant or reorder an operation: that changes results and
// invalidates every receipt recorded with FIXED_MATH_ID.

import type { MathImpl } from './engine.ts';

/** Recorded in receipts so a verifier knows which math produced them. */
export const FIXED_MATH_ID = 'fdlibm-js-1';

const dv = new DataView(new ArrayBuffer(8));
function hiWord(x: number): number { dv.setFloat64(0, x); return dv.getInt32(0) }
function loWord(x: number): number { dv.setFloat64(0, x); return dv.getUint32(4) }
function withHi(x: number, h: number): number { dv.setFloat64(0, x); dv.setInt32(0, h | 0); return dv.getFloat64(0) }
function fromWords(h: number, l: number): number { dv.setInt32(0, h | 0); dv.setUint32(4, l >>> 0); return dv.getFloat64(0) }

// ---------- exp ----------

const halF = [0.5, -0.5];
const huge = 1.0e+300;
const twom1000 = 9.33263618503218878990e-302;
const o_threshold = 7.09782712893383973096e+02;
const u_threshold = -7.45133219101941108420e+02;
const ln2HI = [6.93147180369123816490e-01, -6.93147180369123816490e-01];
const ln2LO = [1.90821492927058770002e-10, -1.90821492927058770002e-10];
const invln2 = 1.44269504088896338700e+00;
const P1 = 1.66666666666666019037e-01;
const P2 = -2.77777777770155933842e-03;
const P3 = 6.61375632143793436117e-05;
const P4 = -1.65339022054652515390e-06;
const P5 = 4.13813679705723846039e-08;

export function fexp(x: number): number {
  let hi = 0, lo = 0, k = 0;
  let hx = hiWord(x);
  const xsb = (hx >>> 31) & 1;
  hx &= 0x7fffffff;
  if (hx >= 0x40862e42) {
    if (hx >= 0x7ff00000) {
      if (((hx & 0xfffff) | loWord(x)) !== 0) return x + x;
      return xsb === 0 ? x : 0.0;
    }
    if (x > o_threshold) return huge * huge;
    if (x < u_threshold) return twom1000 * twom1000;
  }
  if (hx > 0x3fd62e42) {
    if (hx < 0x3ff0a2b2) {
      hi = x - (ln2HI[xsb] as number); lo = ln2LO[xsb] as number; k = 1 - xsb - xsb;
    } else {
      k = (invln2 * x + (halF[xsb] as number)) | 0;
      const t = k;
      hi = x - t * (ln2HI[0] as number);
      lo = t * (ln2LO[0] as number);
    }
    x = hi - lo;
  } else if (hx < 0x3e300000) {
    if (huge + x > 1.0) return 1.0 + x;
  } else k = 0;
  const t = x * x;
  const c = x - t * (P1 + t * (P2 + t * (P3 + t * (P4 + t * P5))));
  if (k === 0) return 1.0 - ((x * c) / (c - 2.0) - x);
  const y = 1.0 - ((lo - (x * c) / (2.0 - c)) - hi);
  if (k >= -1021) return withHi(y, hiWord(y) + (k << 20));
  return withHi(y, hiWord(y) + ((k + 1000) << 20)) * twom1000;
}

// ---------- log ----------

const ln2_hi = 6.93147180369123816490e-01;
const ln2_lo = 1.90821492927058770002e-10;
const two54 = 1.80143985094819840000e+16;
const Lg1 = 6.666666666666735130e-01;
const Lg2 = 3.999999999940941908e-01;
const Lg3 = 2.857142874366239149e-01;
const Lg4 = 2.222219843214978396e-01;
const Lg5 = 1.818357216161805012e-01;
const Lg6 = 1.531383769920937332e-01;
const Lg7 = 1.479819860511658591e-01;

export function flog(x: number): number {
  let hx = hiWord(x);
  const lx = loWord(x);
  let k = 0;
  if (hx < 0x00100000) {
    if (((hx & 0x7fffffff) | lx) === 0) return -Infinity;
    if (hx < 0) return NaN;
    k -= 54; x *= two54;
    hx = hiWord(x);
  }
  if (hx >= 0x7ff00000) return x + x;
  k += (hx >> 20) - 1023;
  hx &= 0x000fffff;
  let i = (hx + 0x95f64) & 0x100000;
  x = fromWords(hx | (i ^ 0x3ff00000), loWord(x));
  k += i >> 20;
  const f = x - 1.0;
  if ((0x000fffff & (2 + hx)) < 3) {
    if (f === 0) { if (k === 0) return 0; const dk = k; return dk * ln2_hi + dk * ln2_lo }
    const R = f * f * (0.5 - 0.33333333333333333 * f);
    if (k === 0) return f - R;
    const dk = k;
    return dk * ln2_hi - ((R - dk * ln2_lo) - f);
  }
  const s = f / (2.0 + f);
  const dk = k;
  const z = s * s;
  i = hx - 0x6147a;
  const w = z * z;
  const j = 0x6b851 - hx;
  const t1 = w * (Lg2 + w * (Lg4 + w * Lg6));
  const t2 = z * (Lg1 + w * (Lg3 + w * (Lg5 + w * Lg7)));
  i |= j;
  const R = t2 + t1;
  if (i > 0) {
    const hfsq = 0.5 * f * f;
    if (k === 0) return f - (hfsq - s * (hfsq + R));
    return dk * ln2_hi - ((hfsq - (s * (hfsq + R) + dk * ln2_lo)) - f);
  }
  if (k === 0) return f - s * (f - R);
  return dk * ln2_hi - ((s * (f - R) - dk * ln2_lo) - f);
}

// ---------- cos ----------

const C1 = 4.16666666666666019037e-02;
const C2 = -1.38888888888741095749e-03;
const C3 = 2.48015872894767294178e-05;
const C4 = -2.75573143513906633035e-07;
const C5 = 2.08757232129817482790e-09;
const C6 = -1.13596475577881948265e-11;

function kcos(x: number, y: number): number {
  const ix = hiWord(x) & 0x7fffffff;
  if (ix < 0x3e400000) { if ((x | 0) === 0) return 1.0 }
  const z = x * x;
  const r = z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6)))));
  if (ix < 0x3fd33333) return 1.0 - (0.5 * z - (z * r - x * y));
  const qx = ix > 0x3fe90000 ? 0.28125 : fromWords(ix - 0x00200000, 0);
  const hz = 0.5 * z - qx;
  const a = 1.0 - qx;
  return a - (hz - (z * r - x * y));
}

const S1 = -1.66666666666666324348e-01;
const S2 = 8.33333333332248946124e-03;
const S3 = -1.98412698298579493134e-04;
const S4 = 2.75573137070700676789e-06;
const S5 = -2.50507602534068634195e-08;
const S6 = 1.58969099521155010221e-10;

function ksin(x: number, y: number, iy: number): number {
  const ix = hiWord(x) & 0x7fffffff;
  if (ix < 0x3e400000) { if ((x | 0) === 0) return x }
  const z = x * x;
  const v = z * x;
  const r = S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)));
  if (iy === 0) return x + v * (S1 + z * r);
  return x - ((z * (0.5 * y - v * r) - y) - v * S1);
}

const invpio2 = 6.36619772367581382433e-01;
const pio2_1 = 1.57079632673412561417e+00;
const pio2_1t = 6.07710050650619224932e-11;
const pio2_2 = 6.07710050630396597660e-11;
const pio2_2t = 2.02226624879595063154e-21;
const pio2_3 = 2.02226624871116645580e-21;
const pio2_3t = 8.47842766036889956997e-32;

/** Reduces x modulo pi/2 into y0 + y1. Supports |x| up to about 2^19 * pi/2. */
function remPio2(x: number, y: [number, number]): number {
  const hx = hiWord(x);
  const ix = hx & 0x7fffffff;
  if (ix <= 0x3fe921fb) { y[0] = x; y[1] = 0; return 0 }
  if (ix < 0x4002d97c) {
    if (hx > 0) {
      let z = x - pio2_1;
      if (ix !== 0x3ff921fb) { y[0] = z - pio2_1t; y[1] = (z - y[0]) - pio2_1t }
      else { z -= pio2_2; y[0] = z - pio2_2t; y[1] = (z - y[0]) - pio2_2t }
      return 1;
    }
    let z = x + pio2_1;
    if (ix !== 0x3ff921fb) { y[0] = z + pio2_1t; y[1] = (z - y[0]) + pio2_1t }
    else { z += pio2_2; y[0] = z + pio2_2t; y[1] = (z - y[0]) + pio2_2t }
    return -1;
  }
  if (ix <= 0x413921fb) {
    let t = Math.abs(x);
    const n = (t * invpio2 + 0.5) | 0;
    const fn = n;
    let r = t - fn * pio2_1;
    let w = fn * pio2_1t;
    // fdlibm skips the cancellation check for some n via a table. Always
    // checking is at least as accurate and keeps this port table free.
    const j = ix >> 20;
    y[0] = r - w;
    let i = j - ((hiWord(y[0]) >> 20) & 0x7ff);
    if (i > 16) {
      t = r;
      w = fn * pio2_2;
      r = t - w;
      w = fn * pio2_2t - ((t - r) - w);
      y[0] = r - w;
      i = j - ((hiWord(y[0]) >> 20) & 0x7ff);
      if (i > 49) {
        t = r;
        w = fn * pio2_3;
        r = t - w;
        w = fn * pio2_3t - ((t - r) - w);
        y[0] = r - w;
      }
    }
    y[1] = (r - y[0]) - w;
    if (hx < 0) { y[0] = -y[0]; y[1] = -y[1]; return -n }
    return n;
  }
  throw new RangeError('fcos argument out of supported range');
}

export function fcos(x: number): number {
  const ix = hiWord(x) & 0x7fffffff;
  if (ix <= 0x3fe921fb) return kcos(x, 0.0);
  if (ix >= 0x7ff00000) return x - x;
  const y: [number, number] = [0, 0];
  const n = remPio2(x, y);
  switch (n & 3) {
    case 0: return kcos(y[0], y[1]);
    case 1: return -ksin(y[0], y[1], 1);
    case 2: return -kcos(y[0], y[1]);
    default: return ksin(y[0], y[1], 1);
  }
}

export const fixedMath: MathImpl = { exp: fexp, log: flog, cos: fcos };
