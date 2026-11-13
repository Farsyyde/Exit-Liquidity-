// Builds the fixed, shuffled founder style list and its hash.
//
// The list is public and reproducible by anyone: a Fisher-Yates shuffle of
// the exact caps, driven by keccak256 in counter mode from a published label.
// It is committed in PlayPass's constructor (the contract checks the caps and
// stores the hash), so it is fixed before the sale. At reveal a random offset
// rotates it; token id n gets style list[(n - 1 + offset) % 2222].
//
//   node script/style-list.mjs          writes config/founder-styles.json

import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import { writeFileSync } from 'node:fs';

export const LABEL = 'exit-liquidity/founder-styles/v1';
// id: [name, cap]. Ids are what PlayPass.styleOf returns.
export const STYLES = [['Classic', 800], ['Neon', 500], ['Founders Gold', 72], ['Blood Moon', 400], ['Ghost', 300], ['Glitch', 150]];
export const SUPPLY = STYLES.reduce((a, [, n]) => a + n, 0);

function stream(label) {
  const seed = keccak_256(utf8ToBytes(label));
  let counter = 0, buf = new Uint8Array(0), pos = 0;
  return () => {
    // 32 bit unsigned values from keccak256(seed ++ uint32 counter)
    if (pos + 4 > buf.length) {
      const c = new Uint8Array(36); c.set(seed); new DataView(c.buffer).setUint32(32, counter++);
      buf = keccak_256(c); pos = 0;
    }
    const v = new DataView(buf.buffer, buf.byteOffset + pos, 4).getUint32(0); pos += 4;
    return v;
  };
}

// Uniform integer in [0, n) by rejection, so the shuffle has no modulo bias.
function below(next, n) {
  const limit = Math.floor(0x100000000 / n) * n;
  for (;;) { const v = next(); if (v < limit) return v % n }
}

export function buildList(label = LABEL) {
  const list = [];
  STYLES.forEach(([, n], id) => { for (let k = 0; k < n; k++) list.push(id) });
  const next = stream(label);
  for (let i = list.length - 1; i > 0; i--) { const j = below(next, i + 1); [list[i], list[j]] = [list[j], list[i]] }
  const bytes = Uint8Array.from(list);
  return { list, hex: '0x' + bytesToHex(bytes), hash: '0x' + bytesToHex(keccak_256(bytes)) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { list, hex, hash } = buildList();
  const counts = Object.fromEntries(STYLES.map(([name], id) => [name, list.filter((x) => x === id).length]));
  writeFileSync(new URL('../config/founder-styles.json', import.meta.url), JSON.stringify({
    label: LABEL, supply: SUPPLY,
    styles: STYLES.map(([name, cap], id) => ({ id, name, cap })),
    counts, hash, list: hex,
  }, null, 2) + '\n');
  console.log('founder style list', hash, counts);
}
