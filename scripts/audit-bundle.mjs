// Scans a built frontend for anything that should never ship to browsers:
// API keys, private keys, tokens, credentials, and lists every third-party
// host the bundle can talk to. Exits 1 on a finding.
//
//   node scripts/audit-bundle.mjs [distDir]

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const dist = resolve(process.argv[2] ?? 'apps/web/dist');

// High confidence credential shapes. Any match fails the audit.
const SECRETS = [
  ['PEM private key', /-{5}BEGIN [A-Z ]*PRIVATE KEY-{5}/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['Google service account', /"type"\s*:\s*"service_account"|client_email[^,]{0,80}gserviceaccount\.com/],
  ['Stripe secret key', /\b[rs]k_(live|test)_[0-9A-Za-z]{16,}\b/],
  ['Anthropic or OpenAI key', /\bsk-(ant-)?[A-Za-z0-9_-]{20,}\b/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  ['JSON web token', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ['Alchemy or Infura key in an RPC URL', /(alchemy\.com\/v2|infura\.io\/v3)\/[A-Za-z0-9_-]{16,}/],
  ['Named secret with a value', /(PRIVATE_KEY|SECRET|API_KEY|LINK_SECRET|SIGNER_KEY|PASSWORD)["']?\s*[:=]\s*["'][^"']{8,}["']/i],
];
// 32 byte hex values could be a private key. Public constants that ship in
// libraries (hash constants, the zero hash) are allowed by exact value.
const HEX32 = /0x[0-9a-fA-F]{64}(?![0-9a-fA-F])/g;
// Each was traced to its source (2026-11-13); add a value only after doing the same.
const PUBLIC_HEX32 = new Set([
  '0x0000000000000000000000000000000000000000000000000000000000000000', // zero hash
  '0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141', // secp256k1 group order n (@noble/curves)
  '0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2f', // secp256k1 field prime p (@noble/curves)
  '0x7ae96a2b657c07106e64479eac3434e99cf0497512f58995c1396c28719501ee', // secp256k1 endomorphism beta (@noble/curves)
  '0x6492649264926492649264926492649264926492649264926492649264926492', // ERC-6492 magic suffix (viem)
  '0x8010801080108010801080108010801080108010801080108010801080108010', // ERC-8010 magic suffix (viem)
  '0x5792579257925792579257925792579257925792579257925792579257925792', // EIP-5792 fallback call id (viem sendCalls)
]);

function files(dir) {
  return readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? files(p) : [p] });
}

let bad = 0;
const hosts = new Map();
const hex = new Map();
for (const f of files(dist)) {
  if (/\.(woff2?|png|jpe?g|gif|ico)$/.test(f)) continue;
  const text = readFileSync(f, 'utf8');
  const rel = relative(dist, f);
  for (const [name, re] of SECRETS) {
    const m = text.match(re);
    if (m) { bad++; console.log(`FINDING ${name} in ${rel}: ${m[0].slice(0, 24)}...`) }
  }
  for (const m of text.matchAll(HEX32)) if (!PUBLIC_HEX32.has(m[0].toLowerCase())) hex.set(m[0], rel);
  for (const m of text.matchAll(/https?:\/\/([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g)) {
    const h = m[1].toLowerCase();
    if (!hosts.has(h)) hosts.set(h, rel);
  }
}
for (const [v, rel] of hex) { bad++; console.log(`FINDING 32 byte hex value in ${rel}: ${v.slice(0, 10)}... (review: a private key would look like this)`) }
console.log(`hosts referenced by the bundle: ${hosts.size ? [...hosts.keys()].sort().join(', ') : 'none'}`);
console.log(bad ? `bundle audit: ${bad} finding(s)` : 'bundle audit: no credentials found');
process.exit(bad ? 1 : 0);
