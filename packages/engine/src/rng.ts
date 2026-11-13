// mulberry32, identical to the prototype, but with its state held as a plain
// number so the whole run state stays serializable.

/** Advances a mulberry32 state. Returns [nextState, value in [0, 1)]. */
export function mulberry32Step(a: number): [number, number] {
  a |= 0;
  a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return [a, ((t ^ (t >>> 14)) >>> 0) / 4294967296];
}

/** Closure form, same sequence as the prototype's mulberry32(seed). */
export function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    const [n, v] = mulberry32Step(a);
    a = n;
    return v;
  };
}

/** Seed of the shop generator, derived from the run seed as in the prototype. */
export function shopSeed(seed: number): number {
  return (seed ^ 0x9e3779b9) >>> 0;
}

// ---------- generator interface ----------

/** Generator state. Plain numbers so run state stays JSON. Mutated in place by next(). */
export type RngState = number[];

/** mulberry32 takes a uint32. xoshiro256** takes 32 bytes as 0x-prefixed lowercase hex. */
export type Seed = number | string;

export interface Generator {
  id: string;
  /** Run and shop streams for a seed. Throws if the seed has the wrong form. */
  init(seed: Seed): { run: RngState; shop: RngState };
  /** Next value in [0, 1). Mutates s. */
  next(s: RngState): number;
}

export const MULBERRY32: Generator = {
  id: 'mulberry32',
  init(seed) {
    if (typeof seed !== 'number' || !Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error('mulberry32 seed must be a uint32');
    return { run: [seed >>> 0], shop: [shopSeed(seed >>> 0)] };
  },
  next(s) {
    const [a, v] = mulberry32Step(s[0] as number);
    s[0] = a;
    return v;
  },
};

// ---------- xoshiro256** ----------
// Blackman and Vigna, https://prng.di.unimi.it/xoshiro256starstar.c
// 64 bit words held as [hi, lo] uint32 pairs; state is [s0h, s0l, s1h, s1l, s2h, s2l, s3h, s3l].

function rotlPair(h: number, l: number, k: number): [number, number] {
  if (k >= 32) { const t = h; h = l; l = t; k -= 32 }
  if (k === 0) return [h >>> 0, l >>> 0];
  return [((h << k) | (l >>> (32 - k))) >>> 0, ((l << k) | (h >>> (32 - k))) >>> 0];
}
function addPair(ah: number, al: number, bh: number, bl: number): [number, number] {
  const lo = al + bl; // exact, below 2^33
  return [(ah + bh + (lo > 0xffffffff ? 1 : 0)) >>> 0, lo >>> 0];
}
function shlPair(h: number, l: number, k: number): [number, number] {
  return [((h << k) | (l >>> (32 - k))) >>> 0, (l << k) >>> 0];
}

/** One xoshiro256** step. Returns the 64 bit output as [hi, lo]. */
export function xoshiroStep(s: RngState): [number, number] {
  const s0h = s[0]!, s0l = s[1]!, s1h = s[2]!, s1l = s[3]!, s2h = s[4]!, s2l = s[5]!, s3h = s[6]!, s3l = s[7]!;
  // result = rotl(s1 * 5, 7) * 9
  const [f4h, f4l] = shlPair(s1h, s1l, 2);
  const [m5h, m5l] = addPair(f4h, f4l, s1h, s1l);
  const [rh, rl] = rotlPair(m5h, m5l, 7);
  const [r8h, r8l] = shlPair(rh, rl, 3);
  const out = addPair(r8h, r8l, rh, rl);
  // t = s1 << 17
  const [th, tl] = shlPair(s1h, s1l, 17);
  const n2h = (s2h ^ s0h) >>> 0, n2l = (s2l ^ s0l) >>> 0;
  const n3h = (s3h ^ s1h) >>> 0, n3l = (s3l ^ s1l) >>> 0;
  const n1h = (s1h ^ n2h) >>> 0, n1l = (s1l ^ n2l) >>> 0;
  const n0h = (s0h ^ n3h) >>> 0, n0l = (s0l ^ n3l) >>> 0;
  const f2h = (n2h ^ th) >>> 0, f2l = (n2l ^ tl) >>> 0;
  const [f3h, f3l] = rotlPair(n3h, n3l, 45);
  s[0] = n0h; s[1] = n0l; s[2] = n1h; s[3] = n1l; s[4] = f2h; s[5] = f2l; s[6] = f3h; s[7] = f3l;
  return out;
}

const JUMP = [0x180ec6d33cfd0aban, 0xd5a61266f0c9392cn, 0xa9582618e03fc9aan, 0x39abdc4529b1661cn];

/** Advances s by 2^128 steps: a stream that never overlaps the original. */
export function xoshiroJump(s: RngState): void {
  const acc = [0, 0, 0, 0, 0, 0, 0, 0];
  for (const j of JUMP) {
    const jh = Number(j >> 32n), jl = Number(j & 0xffffffffn);
    for (let b = 0; b < 64; b++) {
      const bit = b < 32 ? (jl >>> b) & 1 : (jh >>> (b - 32)) & 1;
      if (bit) for (let k = 0; k < 8; k++) acc[k] = ((acc[k] as number) ^ (s[k] as number)) >>> 0;
      xoshiroStep(s);
    }
  }
  for (let k = 0; k < 8; k++) s[k] = acc[k] as number;
}

const SEED_HEX = /^0x[0-9a-f]{64}$/;

export const XOSHIRO256SS: Generator = {
  id: 'xoshiro256ss',
  init(seed) {
    if (typeof seed !== 'string' || !SEED_HEX.test(seed)) throw new Error('xoshiro256ss seed must be 32 bytes as 0x-prefixed lowercase hex');
    const run: RngState = [];
    for (let k = 0; k < 8; k++) run.push(parseInt(seed.slice(2 + k * 8, 10 + k * 8), 16) >>> 0);
    if (run.every((x) => x === 0)) throw new Error('xoshiro256ss seed must not be all zero');
    const shop = run.slice();
    xoshiroJump(shop);
    return { run, shop };
  },
  next(s) {
    const [h, l] = xoshiroStep(s);
    // top 53 bits as a double in [0, 1), exact
    return (h * 2097152 + (l >>> 11)) / 9007199254740992;
  },
};

export const GENERATORS: Readonly<Record<string, Generator>> = { mulberry32: MULBERRY32, xoshiro256ss: XOSHIRO256SS };
