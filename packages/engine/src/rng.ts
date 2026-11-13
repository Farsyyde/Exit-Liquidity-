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
