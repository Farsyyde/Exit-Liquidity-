// Entry point: pnpm server
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { startServer } from './server.ts';
import { createPassService, loadDeployment } from './pass.ts';
import { createPrivyAuth } from './privy.ts';
import { readFileSync } from 'node:fs';

const here = fileURLToPath(new URL('.', import.meta.url));
const env = process.env;
const webDist = resolve(here, '../../web/dist');

const srv = await startServer({
  port: Number(env.PORT ?? 8787),
  host: env.HOST ?? '127.0.0.1',
  dbPath: env.EXITLIQ_DB ?? resolve(here, '../data/exitliq.db'),
  signerKeyPath: env.EXITLIQ_SIGNER_KEY ?? resolve(here, '../data/signer.pem'),
  attemptsPerDay: Number(env.EXITLIQ_ATTEMPTS ?? 3),
  // For local testing only; real play is 100 ms per tick.
  ...(env.EXITLIQ_TICK_MS ? { tickMs: Number(env.EXITLIQ_TICK_MS) } : {}),
  staticDir: existsSync(webDist) ? webDist : null,
  // M2, testnet only. Set EXITLIQ_DEPLOYMENT to contracts/deployments/46630.json to turn the pass on.
  pass: env.EXITLIQ_DEPLOYMENT
    ? (db) => createPassService({
        db,
        deployment: loadDeployment(env.EXITLIQ_DEPLOYMENT!),
        rpcUrl: env.EXITLIQ_RPC_URL,
        baseUrl: env.EXITLIQ_BASE_URL ?? `http://127.0.0.1:${env.PORT ?? 8787}`,
        chainKey: env.EXITLIQ_CHAIN_KEY as `0x${string}` | undefined,
        keyPath: resolve(here, '../data/chain-signer.key'),
        linkSecret: env.EXITLIQ_LINK_SECRET,
        linkSecretPath: resolve(here, '../data/link-secret'),
        environment: env.EXITLIQ_ENV === 'production' ? 'production' : 'development',
        // Google Wallet: on when both are set. The service account JSON comes from a secret store, as a file or a value.
        google: env.GOOGLE_WALLET_ISSUER_ID && (env.GOOGLE_WALLET_SA_JSON || env.GOOGLE_WALLET_SA_FILE)
          ? { issuerId: env.GOOGLE_WALLET_ISSUER_ID, serviceAccount: JSON.parse(env.GOOGLE_WALLET_SA_JSON ?? readFileSync(env.GOOGLE_WALLET_SA_FILE!, 'utf8')) }
          : null,
        images: env.EXITLIQ_PASS_IMAGES ? JSON.parse(env.EXITLIQ_PASS_IMAGES) : null,
      })
    : null,
  // Privy login. Guests play without it. The app secret stays on the server.
  privy: env.PRIVY_APP_ID && env.PRIVY_VERIFICATION_KEY
    ? createPrivyAuth({
        appId: env.PRIVY_APP_ID,
        verificationKey: env.PRIVY_VERIFICATION_KEY.replace(/\\n/g, '\n'),
        appSecret: env.PRIVY_APP_SECRET ?? null,
        clientId: env.PRIVY_CLIENT_ID ?? null,
      })
    : null,
});
console.log(`run server on ${srv.url} (signer ${srv.signer})`);
if (srv.pass) console.log(`pass enabled on chain ${srv.pass.deployment.chainId}: PlayPass ${srv.pass.deployment.playPass}, result signer ${srv.pass.account.address}`);
const stop = () => { void srv.close().then(() => process.exit(0)) };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
