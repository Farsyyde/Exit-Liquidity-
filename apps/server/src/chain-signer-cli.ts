// Prints the address of the run server's chain key (EIP-712 result signer
// and seed operator), creating the key if it does not exist yet. Pass this
// address to the deploy script as SERVER_SIGNER and SEED_OPERATOR, and fund
// it with testnet ETH so it can commit and reveal daily seeds.
//
//   pnpm --filter @exit-liquidity/server chain-signer
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const path = resolve(fileURLToPath(new URL('.', import.meta.url)), '../data/chain-signer.key');
if (!existsSync(path)) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, generatePrivateKey() + '\n', { mode: 0o600 }) }
const key = (process.env.EXITLIQ_CHAIN_KEY ?? readFileSync(path, 'utf8').trim()) as `0x${string}`;
console.log(privateKeyToAccount(key).address);
