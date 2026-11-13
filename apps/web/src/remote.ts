import {
  MAX_CANDLES, PROTOCOL_VERSION,
  type Button, type ClientMsg, type EngineEvent, type ServerMsg, type View, type RankedReceipt, type Attestation,
} from '@exit-liquidity/engine';
import type { Driver } from './driver.ts';

const ID_KEY = 'exitliq_ranked_id';

export interface Identity { name: string; token: string }

export function loadIdentity(): Identity | null {
  try { const v = JSON.parse(localStorage.getItem(ID_KEY) || 'null'); return v && typeof v.name === 'string' && typeof v.token === 'string' ? v : null } catch { return null }
}
export function saveIdentity(id: Identity): void { try { localStorage.setItem(ID_KEY, JSON.stringify(id)) } catch { /* private mode */ } }

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

/**
 * Ranked mode. The server owns the seed and the clock. This driver only
 * renders what arrives and forwards button presses.
 */
export class RemoteDriver implements Driver {
  readonly kind = 'ranked' as const;
  view: View | null = null;
  onEvents: (ev: EngineEvent[]) => void = () => {};
  onChange: () => void = () => {};
  identity: Identity = { name: '', token: '' };
  private final: { receipt: RankedReceipt; attestation: Attestation } | null = null;

  private constructor(private ws: WebSocket) {}

  static connect(name: string): Promise<RemoteDriver> {
    return new Promise((resolve, reject) => {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(proto + '//' + location.host + '/ws');
      const d = new RemoteDriver(ws);
      const prev = loadIdentity();
      let settled = false;
      ws.onopen = () => d.send({ t: 'hello', v: PROTOCOL_VERSION, name, token: prev && prev.name === name ? prev.token : undefined });
      ws.onerror = () => { if (!settled) { settled = true; reject(new Error('Could not reach the run server.')) } };
      ws.onclose = () => { if (!settled) { settled = true; reject(new Error('The run server closed the connection.')) } };
      ws.onmessage = (e) => {
        const m = JSON.parse(String(e.data)) as ServerMsg;
        if (!settled) {
          if (m.t === 'error') { settled = true; reject(new Error(m.msg)); ws.close(); return }
          if (m.t === 'welcome') d.identity = { name: m.name, token: m.token };
          if (m.t === 'snap') { settled = true; d.handle(m); resolve(d); return }
        }
        d.handle(m);
      };
    });
  }

  private send(m: ClientMsg): void { if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m)) }

  private handle(m: ServerMsg): void {
    if (m.t === 'snap') {
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
  close(): void { try { this.ws.close() } catch { /* already closed */ } }
}
