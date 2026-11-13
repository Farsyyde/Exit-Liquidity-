// Entry point: pnpm server
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { startServer } from './server.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const env = process.env;
const webDist = resolve(here, '../../web/dist');

const srv = await startServer({
  port: Number(env.PORT ?? 8787),
  host: env.HOST ?? '127.0.0.1',
  dbPath: env.EXITLIQ_DB ?? resolve(here, '../data/exitliq.db'),
  signerKeyPath: env.EXITLIQ_SIGNER_KEY ?? resolve(here, '../data/signer.pem'),
  attemptsPerDay: Number(env.EXITLIQ_ATTEMPTS ?? 3),
  staticDir: existsSync(webDist) ? webDist : null,
});
console.log(`run server on ${srv.url} (signer ${srv.signer})`);
const stop = () => { void srv.close().then(() => process.exit(0)) };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
