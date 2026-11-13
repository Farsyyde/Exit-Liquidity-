// ed25519 signing of run attestations. M2 replaces this with an EIP-712
// signature that RunRegistry can check on chain.

import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface Signer { publicHex: string; sign(msg: string): string }

export function loadOrCreateSigner(path: string | null): Signer {
  let key: KeyObject;
  if (path && existsSync(path)) key = createPrivateKey(readFileSync(path));
  else {
    key = generateKeyPairSync('ed25519').privateKey;
    if (path) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, key.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
    }
  }
  const pub = createPublicKey(key).export({ format: 'jwk' }).x as string;
  const publicHex = Buffer.from(pub, 'base64url').toString('hex');
  return { publicHex, sign: (msg) => sign(null, Buffer.from(msg, 'utf8'), key).toString('hex') };
}

export function verifySig(publicHex: string, msg: string, sigHex: string): boolean {
  try {
    const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(publicHex, 'hex').toString('base64url') }, format: 'jwk' });
    return verify(null, Buffer.from(msg, 'utf8'), key, Buffer.from(sigHex, 'hex'));
  } catch {
    return false;
  }
}
