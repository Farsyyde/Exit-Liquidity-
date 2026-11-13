// Daily seed commit and reveal, and per run seed derivation (spec section 5).
// Off chain in M1: the commit is published by the server's API, not posted on chain.

import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';

export function keccakHex(data: Uint8Array | string): string {
  return '0x' + bytesToHex(keccak_256(typeof data === 'string' ? new TextEncoder().encode(data) : data));
}

export function parseSeedHex(hex: string): Uint8Array {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (!/^[0-9a-fA-F]{64}$/.test(h)) throw new Error('daily seed must be 32 bytes of hex');
  return hexToBytes(h.toLowerCase());
}

/** keccak256(dailySeed), the value committed before the day starts. */
export function commitOf(dailySeed: Uint8Array): string {
  return keccakHex(dailySeed);
}

function uint256(n: number): Uint8Array {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('bad uint');
  const b = new Uint8Array(32);
  let v = BigInt(n);
  for (let k = 31; k >= 0 && v > 0n; k--) { b[k] = Number(v & 0xffn); v >>= 8n }
  return b;
}

/**
 * runSeed = uint32(keccak256(dailySeed ++ uint256(player) ++ uint256(attempt))),
 * that is the low 32 bits of the hash, as Solidity's uint32(uint256(h)) would give.
 * The player id stands in for the pass id until passes exist (M2).
 */
export function runSeedOf(dailySeed: Uint8Array, player: number, attempt: number): number {
  const buf = new Uint8Array(96);
  buf.set(dailySeed, 0);
  buf.set(uint256(player), 32);
  buf.set(uint256(attempt), 64);
  const h = keccak_256(buf);
  return ((h[28]! << 24) | (h[29]! << 16) | (h[30]! << 8) | h[31]!) >>> 0;
}

/** UTC calendar day, YYYY-MM-DD. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
