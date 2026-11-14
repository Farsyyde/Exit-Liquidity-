// Privy login on the run server, with tokens signed by a local ES256 key in
// the format Privy issues (typ JWT, iss privy.io, aud = app id, sid, sub) and
// a stand-in for Privy's user API. The chain parts are in pass.test.ts.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { SignJWT, exportSPKI, generateKeyPair, type KeyLike } from 'jose';
import { PROTOCOL_VERSION, type ServerMsg } from '@exit-liquidity/engine';
import { startServer, type RunServer } from '../src/server.ts';
import { createPrivyAuth, type PrivyUserLike } from '../src/privy.ts';

const APP = 'cm-test-app-id';
let priv: KeyLike, pubPem: string, otherPriv: KeyLike;
let srv: RunServer, dir: string;
const users = new Map<string, PrivyUserLike>();
const deleted: string[] = [];

async function token(sub: string, o: { key?: KeyLike; aud?: string; iss?: string; expIn?: number; typ?: string } = {}) {
  return new SignJWT({ sid: 'session-' + sub })
    .setProtectedHeader({ alg: 'ES256', typ: o.typ ?? 'JWT' })
    .setSubject(sub).setIssuer(o.iss ?? 'privy.io').setAudience(o.aud ?? APP)
    .setIssuedAt().setExpirationTime(Math.floor(Date.now() / 1000) + (o.expIn ?? 3600))
    .sign(o.key ?? priv);
}

beforeEach(async () => {
  const kp = await generateKeyPair('ES256');
  priv = kp.privateKey; pubPem = await exportSPKI(kp.publicKey);
  otherPriv = (await generateKeyPair('ES256')).privateKey;
  users.clear(); deleted.length = 0;
  dir = mkdtempSync(join(tmpdir(), 'exitliq-privy-'));
  srv = await startServer({
    dbPath: join(dir, 'db'), signerKeyPath: join(dir, 'k.pem'), tickMs: 0, idleMs: 0, maxMsgsPerSec: 1000, log: () => {},
    privy: createPrivyAuth({
      appId: APP, verificationKey: pubPem,
      api: {
        async getUser(id) { const u = users.get(id); if (!u) throw new Error('no user'); return u },
        async deleteUser(id) { deleted.push(id); users.delete(id) },
      },
    }),
  });
});
afterEach(async () => { await srv.close(); rmSync(dir, { recursive: true, force: true }) });

const post = (path: string, body: unknown, tok?: string) => fetch(srv.url + path, {
  method: 'POST', headers: { 'content-type': 'application/json', ...(tok ? { authorization: 'Bearer ' + tok } : {}) }, body: JSON.stringify(body),
});

/** Plays a whole run (quick: ticks are back to back) and returns every message. */
function play(hello: Record<string, unknown>): Promise<ServerMsg[]> {
  return new Promise((done) => {
    const ws = new WebSocket(srv.url.replace('http', 'ws') + '/ws');
    const msgs: ServerMsg[] = [];
    ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, lite: true, ...hello })));
    ws.on('message', (d) => {
      const m = JSON.parse(String(d)) as ServerMsg;
      msgs.push(m);
      if (m.t === 'error' || m.t === 'end') { ws.close(); done(msgs) }
      if (m.t === 'snap' && m.v.phase === 'intro') ws.send('{"t":"go"}');
      if (m.t === 'snap' && m.v.phase === 'shop') ws.send('{"t":"next"}');
    });
  });
}

describe('Privy login', () => {
  it('verifies the access token: wrong key, app, issuer, type or an expired token are refused', async () => {
    const good = await token('did:privy:alice');
    expect((await post('/api/me', {}, good)).status).toBe(200);
    for (const bad of [
      await token('did:privy:alice', { key: otherPriv }),
      await token('did:privy:alice', { aud: 'another-app' }),
      await token('did:privy:alice', { iss: 'evil.io' }),
      await token('did:privy:alice', { expIn: -10 }),
      await token('did:privy:alice', { typ: 'at+jwt' }),
      'not-a-jwt', '',
    ]) {
      expect((await post('/api/me', {}, bad)).status).toBe(401);
      const r = await play({ privy: bad });
      expect(r.at(-1)).toMatchObject({ t: 'error', code: 'auth' });
    }
    expect((await post('/api/me', {})).status).toBe(401);
  });

  it('first login adopts the guest ranked identity and practice keepsake; ranked then runs on the Privy token', async () => {
    // play as a guest first
    const guestRun = await play({ name: 'Guesty' });
    const welcome = guestRun.find((m) => m.t === 'welcome') as Extract<ServerMsg, { t: 'welcome' }>;
    const guest = { name: 'Guesty', token: welcome.token };
    const tok = await token('did:privy:g1');
    const me = await (await post('/api/me', { guest, practiceMint: { id: 'insider', runs: 2 } }, tok)).json();
    expect(me).toMatchObject({ created: true, adoptedGuest: true, player: { name: 'Guesty' }, practiceMint: { id: 'insider', runs: 2 } });
    // ranked by token: same player, attempt 2
    const r = await play({ privy: tok });
    const w = r.find((m) => m.t === 'welcome') as Extract<ServerMsg, { t: 'welcome' }>;
    expect(w).toMatchObject({ name: 'Guesty', player: welcome.player, attempt: 2, token: '' });
    expect(r.at(-1)!.t).toBe('end');
    // the guest name and token no longer play it
    const again = await play({ name: 'Guesty', token: guest.token });
    expect(again.at(-1)).toMatchObject({ t: 'error', code: 'name' });
    // a second login is idempotent and does not re-adopt
    const me2 = await (await post('/api/me', { guest }, tok)).json();
    expect(me2).toMatchObject({ created: false, adoptedGuest: false, player: { name: 'Guesty' } });
  });

  it('an account that already has a ranked name keeps it; another guest name stays separate', async () => {
    const tok = await token('did:privy:h1');
    await post('/api/me', {}, tok);
    expect((await play({ privy: tok })).at(-1)).toMatchObject({ t: 'error', code: 'account' });
    expect((await (await post('/api/me/name', { name: 'Holder' }, tok)).json()).player.name).toBe('Holder');
    expect((await post('/api/me/name', { name: 'Second' }, tok)).status).toBe(409);
    const g = await play({ name: 'Visitor' });
    const gt = (g.find((m) => m.t === 'welcome') as Extract<ServerMsg, { t: 'welcome' }>).token;
    const me = await (await post('/api/me', { guest: { name: 'Visitor', token: gt } }, tok)).json();
    expect(me).toMatchObject({ adoptedGuest: false, guestKeptSeparate: true, player: { name: 'Holder' } });
    // a name already used by someone else cannot be taken
    const tok2 = await token('did:privy:h2');
    await post('/api/me', {}, tok2);
    expect((await post('/api/me/name', { name: 'holder' }, tok2)).status).toBe(409);
  });

  it('export lists the linked wallets; delete removes the account, its runs and, when confirmed, the Privy user', async () => {
    users.set('did:privy:d1', { id: 'did:privy:d1', linked_accounts: [
      { type: 'email', address: 'x@example.com' },
      { type: 'wallet', chain_type: 'ethereum', address: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8', connector_type: 'embedded', wallet_client_type: 'privy' },
      { type: 'wallet', chain_type: 'ethereum', address: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC', connector_type: 'injected', wallet_client_type: 'metamask' },
      { type: 'wallet', chain_type: 'solana', address: 'So1ana111111111111111111111111111111111111' },
    ] });
    const tok = await token('did:privy:d1');
    await post('/api/me', {}, tok);
    await post('/api/me/name', { name: 'Leaver' }, tok);
    await play({ privy: tok });
    const exp = await (await post('/api/account/export', {}, tok)).json();
    expect(exp.linkedWallets).toEqual([
      { address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', embedded: true, client: 'privy' },
      { address: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC', embedded: false, client: 'metamask' },
    ]);
    expect(exp.ranked.runs).toHaveLength(1);

    const del = await (await post('/api/account/delete', { deletePrivyUser: true }, tok)).json();
    expect(del).toEqual({ deleted: true, runs: 1, privyUserDeleted: true });
    expect(deleted).toEqual(['did:privy:d1']);
    const left = srv.db.raw.prepare("SELECT (SELECT COUNT(*) FROM accounts) a, (SELECT COUNT(*) FROM players WHERE name = 'Leaver') p, (SELECT COUNT(*) FROM runs) r").get();
    expect(left).toEqual({ a: 0, p: 0, r: 0 });

    // without the confirmation the Privy user is kept
    const tok2 = await token('did:privy:d2');
    await post('/api/me', {}, tok2);
    expect(await (await post('/api/account/delete', {}, tok2)).json()).toMatchObject({ deleted: true, privyUserDeleted: false });
    expect(deleted).toEqual(['did:privy:d1']);
  });

  it('guests are untouched: no login needed, guest delete still works', async () => {
    const g = await play({ name: 'Free Player' });
    const w = g.find((m) => m.t === 'welcome') as Extract<ServerMsg, { t: 'welcome' }>;
    expect(g.at(-1)!.t).toBe('end');
    expect(await (await post('/api/account/delete', { name: 'Free Player', token: w.token })).json()).toMatchObject({ deleted: true });
    expect(await (await fetch(srv.url + '/api/auth-config')).json()).toEqual({ privy: { appId: APP, clientId: null } });
  });
});
