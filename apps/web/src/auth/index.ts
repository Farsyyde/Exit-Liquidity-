// The game's side of login. Guests never load Privy: the island (React and
// the Privy SDK) is fetched only when someone presses LOG IN, or on page load
// when this browser has logged in before. Guest progress stays in
// localStorage and moves into the account on first login.

import type { AuthApi } from './types.ts';

export type { AuthApi, AuthState, AuthWallet } from './types.ts';

const SESSION_FLAG = 'exitliq_privy';
let api: Promise<AuthApi> | null = null;

export async function authConfig(): Promise<{ appId: string; clientId: string | null } | null> {
  try {
    const r = await fetch('/api/auth-config');
    if (!r.ok) return null;
    return ((await r.json()) as { privy: { appId: string; clientId: string | null } }).privy;
  } catch { return null }
}

/** Loads Privy (once). */
export function loadAuth(cfg: { appId: string; clientId: string | null }): Promise<AuthApi> {
  api ??= import('./island.tsx').then((m) => m.mountAuth(cfg));
  api.catch(() => { api = null }); // a failed start can be retried
  return api;
}

export function rememberSession(on: boolean): void {
  try { if (on) localStorage.setItem(SESSION_FLAG, '1'); else localStorage.removeItem(SESSION_FLAG) } catch { /* private mode */ }
}
export function hadSession(): boolean {
  try { return localStorage.getItem(SESSION_FLAG) === '1' } catch { return false }
}

/** Authenticated fetch to the run server's /api/me routes. */
export async function meFetch(a: AuthApi, path: string, body?: unknown): Promise<Response> {
  const tok = await a.accessToken();
  const id = await a.identityToken().catch(() => null);
  return fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: 'Bearer ' + (tok ?? ''), ...(id ? { 'privy-id-token': id } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
