import { makeEngine } from './engine.ts';
import { FIXED_MATH_ID, fixedMath } from './fixedmath.ts';

export * from './tables.ts';
export * from './rng.ts';
export * from './engine.ts';
export * from './format.ts';

/** Engine on the portable fixed math. Its receipts replay bit for bit in any JS runtime. Use this by default. */
export const engine = makeEngine(fixedMath, FIXED_MATH_ID);

/** Engine on the host's Math, identical to the prototype in the same runtime. Receipts only replay in that runtime. */
export const nativeEngine = makeEngine(Math, 'native');
export * from './fixedmath.ts';
