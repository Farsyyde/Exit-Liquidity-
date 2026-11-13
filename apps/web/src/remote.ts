import {
  MAX_CANDLES, PROTOCOL_VERSION,
  type Button, type ClientMsg, type Settlement, type PublicEvent, type ServerMsg, type View, type RankedReceipt, type Attestation,
} from '@exit-liquidity/engine';
import type { Driver } from './driver.ts';

const ID_KEY = 'exitliq_ranked_id';

export interface Identity { name: string; token: string }

export function loadIdentity(): Identity | null {
  try { const v = JSON.parse(localStorage.getItem(ID_KEY) || 'null'); return v && typeof v.name === 'string' && typeof v.token === 'string' ? v : null } catch { return null }
}
export function saveIdentity(id: Identity): void { try { localStorage.setItem(ID_KEY, JSON.stringify(id)) } catch { /* private mode */ } }
export function clearIdentity(): void { try { localStorage.removeItem(ID_KEY) } catch { /* private mode */ } }

/** Data export or account deletion, authenticated by the name and token this browser holds. */
export async function accountRequest(action: 'export' | 'delete', id: Identity): Promise<unknown> {
  const r = await fetch('/api/account/' + action, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: id.name, token: id.token }) });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((body as { error?: string }).error ?? 'The run server refused (' + r.status + ').');
  return body;
}

export async function rankedAvailable(): Promise<boolean> {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 1500);
    const r = await fetch('/api/health', { signal: ctl.signal });
    clearTimeout(t);
    return r.ok;
  } catch { return false }
}

export async function fetchLeaderboard(): Promise<{ day: string; rows: { name: string; layers: number; bank: number }[] }> {
  const r = await fetch('/api/leaderboard');
  if (!r.ok) throw new Error('leaderboard ' + r.status);
  return r.json();
}

export type LinkStatus = 'ok' | 'reconnecting' | 'lost' | 'replaced';

const RETRY_MS = [250, 500, 1000, 2000, 3000, 5000];
const GIVE_UP_MS = 3 * 60_000;

function wsUrl(): string {
  return (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/ws';
}

/**
 * Ranked mode. The server owns the seed and the clock. This driver only
 * renders what arrives and forwards button presses. If the connection drops,
 * the run carries on at the server; this driver reconnects with resume and
 * picks up from the server's full snapshot.
 */
export class RemoteDriver implements Driver {
  readonly kind = 'ranked' as const;
  view: View | null = null;
  onEvents: (ev: PublicEvent[]) => void = () => {};
  onChange: () => void = () => {};
  onStatus: (s: LinkStatus) => void = () => {};
  identity: Identity = { name: '', token: '' };
  private final: { receipt: RankedReceipt; attestation: Attestation } | null = null;
  /** The pass this run is bound to, and once the run ends, the signed result to settle on chain. */
  boundPass: string | null = null;
  settlement: Settlement | null = null;
  onSettlement: () => void = () => {};
  private closedByUs = false;
  private retry = 0;
  private lostAt = 0;

  private constructor(private ws: WebSocket) {}

  static connect(name: string, pass?: { id: string; message: string; signature: string }): Promise<RemoteDriver> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl());
      const d = new RemoteDriver(ws);
      const prev = loadIdentity();
      let settled = false;
      ws.onopen = () => d.send({ t: 'hello', v: PROTOCOL_VERSION, name, token: prev && prev.name === name ? prev.token : undefined, ...(pass ? { pass } : {}) });
      ws.onerror = () => { if (!settled) { settled = true; reject(new Error('Could not reach the run server.')) } };
      ws.onclose = () => { if (!settled) { settled = true; reject(new Error('The run server closed the connection.')) } else d.dropped() };
      ws.onmessage = (e) => {
        const m = JSON.parse(String(e.data)) as ServerMsg;
        if (!settled) {
          if (m.t === 'error') { settled = true; reject(new Error(m.msg)); ws.close(); return }
          if (m.t === 'welcome') { d.identity = { name: m.name, token: m.token }; d.boundPass = m.pass?.id ?? null }
          if (m.t === 'snap') { settled = true; d.handle(m); resolve(d); return }
        }
        d.handle(m);
      };
    });
  }

  /** The socket closed without us asking. The run is still going at the server, so go back to it. */
  private dropped(): void {
    if (this.closedByUs || this.final) return;
    if (!this.lostAt) this.lostAt = Date.now();
    if (Date.now() - this.lostAt > GIVE_UP_MS) { this.onStatus('lost'); return }
    this.onStatus('reconnecting');
    const wait = RETRY_MS[Math.min(this.retry++, RETRY_MS.length - 1)]!;
    setTimeout(() => this.reopen(), wait);
  }

  private reopen(): void {
    if (this.closedByUs) return;
    const ws = new WebSocket(wsUrl());
    this.ws = ws;
    ws.onopen = () => this.send({ t: 'hello', v: PROTOCOL_VERSION, name: this.identity.name, token: this.identity.token, resume: true });
    ws.onclose = () => { if (this.ws === ws) this.dropped() };
    ws.onerror = () => { /* close follows */ };
    ws.onmessage = (e) => this.handle(JSON.parse(String(e.data)) as ServerMsg);
  }

  private send(m: ClientMsg): void { if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m)) }

  private handle(m: ServerMsg): void {
    if (m.t === 'welcome') {
      if (m.resumed) { this.retry = 0; this.lostAt = 0; this.onStatus('ok') }
    } else if (m.t === 'error') {
      if (m.code === 'replaced') { this.closedByUs = true; this.onStatus('replaced') }
      else if (m.code === 'resume') { this.closedByUs = true; this.onStatus('lost') }
    } else if (m.t === 'snap') {
      // a snapshot is the whole truth, chart history included: after a resume it replaces everything
      this.view = m.v;
      if (m.ev.length) this.onEvents(m.ev);
      this.onChange();
    } else if (m.t === 'tick' && 'v' in m && this.view) {
      const candles = this.view.candles;
      let cur = this.view.cur;
      if (m.closed) { candles.push(m.c); if (candles.length > MAX_CANDLES) candles.shift(); cur = null } else cur = m.c;
      this.view = { ...m.v, candles, cur };
      if (m.ev.length) this.onEvents(m.ev);
    } else if (m.t === 'end') {
      this.final = { receipt: m.receipt, attestation: m.attestation };
    } else if (m.t === 'settlement') {
      const { t: _t, run: _r, ...s } = m;
      this.settlement = s;
      this.onSettlement();
    }
  }

  frame(): void { /* the server owns time */ }
  go(): void { this.send({ t: 'go' }) }
  next(): void { this.send({ t: 'next' }) }
  shop(code: string): void { this.send({ t: 'shop', code }) }
  press(b: Button): void { this.send({ t: 'press', b }) }
  mint(id: string): void { this.send({ t: 'mint', id }) }
  async receipt(): Promise<string> {
    for (let k = 0; k < 50 && !this.final; k++) await new Promise((r) => setTimeout(r, 100));
    return JSON.stringify(this.final ?? { error: 'receipt not received' });
  }
  close(): void { this.closedByUs = true; try { this.ws.close() } catch { /* already closed */ } }
}
