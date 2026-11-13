// Scripted ranked client. Plays over a real WebSocket like a browser would,
// so the server's stamping is exercised with real network timing.

import WebSocket from 'ws';
import {
  CON, IND, PROTOCOL_VERSION, mulberry32,
  type Attestation, type Button, type ClientMsg, type RankedReceipt, type ServerMsg, type View, type EngineEvent,
} from '@exit-liquidity/engine';

export interface BotOptions {
  url: string;          // ws://host:port/ws
  name: string;
  token?: string;
  seed: number;         // bot's own randomness, not the game seed
  /** Probability of walking away mid run (the server must finish the run unattended). */
  quitChance?: number;
  /** Client side message budget per second, under the server's limit. */
  maxPerSec?: number;
  timeoutMs?: number;
}

export interface BotResult {
  token: string | null;
  run: number | null;
  receipt: RankedReceipt | null;
  attestation: Attestation | null;
  quit: boolean;
  error: string | null;
  sent: number;
}

const BUTTONS: Button[] = ['buy', 'sell', 'lock', 'item0', 'item1'];

export function playBot(o: BotOptions): Promise<BotResult> {
  const R = mulberry32(o.seed);
  const res: BotResult = { token: null, run: null, receipt: null, attestation: null, quit: false, error: null, sent: 0 };
  const budget = o.maxPerSec ?? 30;
  const quitAt = R() < (o.quitChance ?? 0) ? 20 + Math.floor(R() * 600) : -1;
  return new Promise((resolve) => {
    const ws = new WebSocket(o.url);
    let view: View | null = null;
    let shopDoneFor = -1, ticks = 0, sentWindow = 0, windowStart = Date.now();
    let pos: { dir: 1 | -1; ret: number } | null = null, ready = false;
    const done = () => { clearTimeout(timer); try { ws.close() } catch { /* closed */ } resolve(res) };
    const timer = setTimeout(() => { res.error = 'timeout'; done() }, o.timeoutMs ?? 120_000);
    const send = (m: ClientMsg, force = false): void => {
      const t = Date.now();
      if (t - windowStart >= 1000) { windowStart = t; sentWindow = 0 }
      if (!force && sentWindow >= budget) return;
      if (ws.readyState !== ws.OPEN) return;
      sentWindow++; res.sent++;
      ws.send(JSON.stringify(m));
    };

    // Headline trader: buy pump headlines, get out on dump headlines or after the move.
    let heldFor = 0;
    function onHeadlines(ev: EngineEvent[]): void {
      for (const e of ev) {
        if (e.k !== 'headline' || e.mine) continue;
        if (e.type === 'pump' && !pos && R() < 0.9) send({ t: 'press', b: 'buy' });
        else if ((e.type === 'dump' || e.type === 'rug') && pos) send({ t: 'press', b: pos.dir === 1 ? 'sell' : 'buy' });
        else if ((e.type === 'dump' || e.type === 'rug') && !pos && R() < 0.7) send({ t: 'press', b: 'sell' });
      }
    }

    function onTick(): void {
      ticks++;
      if (quitAt >= 0 && ticks >= quitAt) { res.quit = true; done(); return }
      heldFor = pos ? heldFor + 1 : 0;
      if (pos) {
        if (heldFor > 50 + R() * 20 || pos.ret > 0.3 || pos.ret < -0.15) send({ t: 'press', b: pos.dir === 1 ? 'sell' : 'buy' });
      } else if (ready && R() < 0.5) send({ t: 'press', b: 'lock' });
      // occasional noise: items, stray presses, inputs that are invalid right now
      if (R() < 0.004) send({ t: 'press', b: BUTTONS[Math.floor(R() * BUTTONS.length)]! });
    }

    function onShop(v: View): void {
      if (shopDoneFor === v.i) return;
      shopDoneFor = v.i;
      let credits = v.credits;
      const inds = v.inds.slice();
      const n = Math.floor(R() * 5);
      for (let k = 0; k < n; k++) {
        const r = R();
        if (r < 0.7) {
          const o2 = v.offers[Math.floor(R() * v.offers.length)];
          if (!o2) continue;
          const cost = (o2.con ? CON[o2.id] : IND[o2.id])?.cost ?? 99;
          if (cost <= credits) { credits -= cost; send({ t: 'shop', code: 'buy:' + o2.id }, true) }
        } else if (r < 0.85 && inds.length) {
          const id = inds.splice(Math.floor(R() * inds.length), 1)[0]!;
          send({ t: 'shop', code: 'sell:' + id }, true);
        } else send({ t: 'shop', code: 'reroll' }, true);
      }
      send({ t: 'next' }, true);
    }

    ws.on('open', () => send({ t: 'hello', v: PROTOCOL_VERSION, name: o.name, token: o.token, lite: true }, true));
    ws.on('message', (data) => {
      const m = JSON.parse(String(data)) as ServerMsg;
      if (m.t === 'welcome') { res.token = m.token; res.run = null }
      else if (m.t === 'error') { if (!res.receipt) res.error = m.code + ': ' + m.msg; if (m.code !== 'mint') done() }
      else if (m.t === 'snap') {
        view = m.v;
        pos = view.pos ? { dir: view.pos.dir, ret: view.pos.ret } : null;
        ready = view.ready;
        if (view.phase === 'intro') send({ t: 'go' }, true);
        else if (view.phase === 'shop') onShop(view);
        onHeadlines(m.ev);
      } else if (m.t === 'tick') {
        if ('s' in m) { pos = m.s.pos ? { dir: m.s.pos.dir, ret: m.s.pos.ret } : null; ready = m.s.ready }
        onHeadlines(m.ev);
        onTick();
      } else if (m.t === 'end') {
        res.run = m.run; res.receipt = m.receipt; res.attestation = m.attestation;
        const inds = view ? view.inds : [];
        if (inds.length && R() < 0.5) send({ t: 'mint', id: inds[Math.floor(R() * inds.length)]! }, true);
        setTimeout(done, 20);
      } else if (m.t === 'minted') { /* fine */ }
    });
    ws.on('error', (e) => { res.error = String(e); done() });
    ws.on('close', () => done());
  });
}
