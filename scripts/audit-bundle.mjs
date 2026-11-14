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
  // The Privy island (traced 2026-11-14):
  '0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798', // secp256k1 generator x
  '0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8', // secp256k1 generator y
  '0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffed', // ed25519 field prime p
  '0x1000000000000000000000000000000014def9dea2f79cd65812631a5cf5d3ed', // ed25519 group order n
  '0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffec', // ed25519 curve a
  '0x52036cee2b6ffe738cc740797779e89800700a4d4141d8ab75eb4dca135978a3', // ed25519 curve d
  '0x216936d3cd6e53fec0a4e231fdd6dc5c692cc7609525a7b2c9562d608f25d51a', // ed25519 generator x
  '0x6666666666666666666666666666666666666666666666666666666666666658', // ed25519 generator y
  '0xffffffff00000001000000000000000000000000ffffffffffffffffffffffff', // P-256 field prime p
  '0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551', // P-256 group order n
  '0xffffffff00000001000000000000000000000000fffffffffffffffffffffffc', // P-256 curve a
  '0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604b', // P-256 curve b
  '0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296', // P-256 generator x
  '0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5', // P-256 generator y
  '0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff', // int256 max (abi codec range)
  '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff', // uint256 max (abi codec range)
  '0xfffffffffffffffffffffffffffffff000000000000000000000000000000000', // dummy signature r for EIP-7702 gas estimation (viem)
  '0x7aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', // dummy signature s for EIP-7702 gas estimation (viem)
  '0x583cc63a2e37f645b43eac911b1a6d6de08b83abdc308c61364edda8cfc3bd37', // ox tempo recoveryWalletInitCodeHash
  '0x7777777777777777777777777777777777777777777777777777777777777777', // ox tempo signature envelope magicBytes
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
    for (const m of text.matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'))) {
      // A value made only of letters and underscores is a code identifier (CANNOT_SET_PASSWORD = "cannot_set_password",
      // x ? "setWalletPassword" : "setWalletRecovery"), not a secret. Real keys and secrets carry digits.
      const kv = /([A-Za-z_]+)["']?\s*[:=]\s*["']([^"']+)["']/.exec(m[0]);
      if (name === 'Named secret with a value' && kv && /^[A-Za-z_]+$/.test(kv[2])) continue;
      bad++; console.log(`FINDING ${name} in ${rel}: ${m[0].slice(0, 24)}...`);
      break;
    }
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
