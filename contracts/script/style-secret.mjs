// Makes the founder style secret and its commitment. Keep the secret private
// until the sale has closed; commit only the hash (STYLE_SECRET_COMMIT).
//
//   node script/style-secret.mjs     writes secrets/style-secret.json (gitignored)

import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex } from '@noble/hashes/utils';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';

const dir = new URL('../secrets/', import.meta.url);
const file = new URL('style-secret.json', dir);
if (existsSync(file)) { console.error('secrets/style-secret.json already exists; refusing to overwrite it'); process.exit(1) }
const secret = randomBytes(32);
const commit = '0x' + bytesToHex(keccak_256(secret));
mkdirSync(dir, { recursive: true });
writeFileSync(file, JSON.stringify({ secret: '0x' + bytesToHex(secret), commit }, null, 2) + '\n', { mode: 0o600 });
console.log('STYLE_SECRET_COMMIT=' + commit);
console.log('secret written to secrets/style-secret.json: back it up privately, it is needed to reveal styles');
