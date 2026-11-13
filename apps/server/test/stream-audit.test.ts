// Audit of everything the run server sends a player during a ranked run.
// Every key must be on an allowlist (a new engine field cannot leak by
// accident), and content may only be what that player's screen can show.

import { describe, expect, it } from 'vitest';
import { mulberry32, type ServerMsg, type Button } from '@exit-liquidity/engine';
import { RunSession } from '../src/session.ts';
import { parseSeedHex, runSeedOf } from '../src/seeds.ts';

const K = (s: string) => new Set(s.split(' '));
const VIEW = K('phase i layers level left p fair candles cur ma20 feed equity pos ready streak mult canShort inds nft cons slots credits bagMult whaleMult offers clear end');
const LIGHT = new Set([...VIEW].filter((k) => k !== 'candles' && k !== 'cur'));
const LEVEL = K('tk lore rug fakeChip hunter start target dur drop loan drained');
const CANDLE = K('o h l c f n');
const FEED = K('text flagged mine');
const POS = K('dir entry lev ret locked');
const OFFER = K('id sold con');
const CLEAR = K('bank target a b c');
const END = K('won bank layers trades best seed rng');
const LITE = K('phase i equity target pos ready left');
const EVENT: Record<string, Set<string>> = {
  headline: K('k text flagged mine'), open: K('k dir snipe'), win: K('k total mult tags streak big'), loss: K('k loss notes'),
  liquidated: K('k'), apeLocked: K('k'), item: K('k id amount into'), reorgEmpty: K('k'), countdown: K('k left'),
  cleared: K('k bank target a b c last'), failed: K('k bank target'),
};
const MSG: Record<string, Set<string>> = { snap: K('t v ev'), tick: K('t k v c closed ev'), ticklite: K('t k p s ev'), end: K('t run receipt attestation') };

function keys(o: object, allowed: Set<string>, where: string, bad: string[]): void {
  for (const k of Object.keys(o)) if (!allowed.has(k)) bad.push(`${where}.${k}`);
}

function auditView(v: Record<string, any>, allowed: Set<string>, where: string, bad: string[]): void {
  keys(v, allowed, where, bad);
  keys(v.level, LEVEL, where + '.level', bad);
  for (const c of v.candles ?? []) keys(c, CANDLE, where + '.candles[]', bad);
  if (v.cur) keys(v.cur, CANDLE, where + '.cur', bad);
  for (const f of v.feed) keys(f, FEED, where + '.feed[]', bad);
  if (v.pos) keys(v.pos, POS, where + '.pos', bad);
  for (const o of v.offers) keys(o, OFFER, where + '.offers[]', bad);
  if (v.clear) keys(v.clear, CLEAR, where + '.clear', bad);
  if (v.end) keys(v.end, END, where + '.end', bad);
}

interface Audit { msgs: ServerMsg[]; bad: string[] }

function audit(a: Audit): void {
  const { msgs, bad } = a;
  for (const [n, m] of msgs.entries()) {
    const w = `msg${n}(${m.t})`;
    if (m.t === 'end') { keys(m, MSG.end!, w, bad); continue }
    if (m.t !== 'snap' && m.t !== 'tick') { bad.push(w + ' unexpected type'); continue }
    const lite = m.t === 'tick' && 's' in m;
    keys(m, lite ? MSG.ticklite! : MSG[m.t]!, w, bad);
    for (const e of m.ev) {
      const allowed = EVENT[e.k];
      if (!allowed) { bad.push(w + ' unknown event ' + e.k); continue }
      keys(e, allowed, `${w}.ev(${e.k})`, bad);
    }
    if (lite) { keys((m as any).s, LITE, w + '.s', bad); if ((m as any).s.pos) keys((m as any).s.pos, POS, w + '.s.pos', bad); continue }
    const v = (m as any).v;
    auditView(v, m.t === 'snap' ? VIEW : LIGHT, w + '.v', bad);
    // what this screen holds right now
    const held = (id: string) => v.nft === id || v.inds.includes(id);
    const holdsInsider = held('insider'), holdsVwap = held('vwap'), holdsSniper = held('sniper');
    const play = v.phase === 'play';
    // fake flag only with Insider, in play
    for (const f of v.feed) if (f.flagged && !(holdsInsider && play)) bad.push(w + ' fake flag without Insider');
    for (const e of m.ev) if (e.k === 'headline' && e.flagged && !(holdsInsider && play)) bad.push(w + ' fake flag event without Insider');
    // fair value only with Fair Value, in play
    if (v.fair && !(holdsVwap && play)) bad.push(w + ' fair line without Fair Value');
    const candles = [...(v.candles ?? []), ...(v.cur ? [v.cur] : []), ...((m as any).c ? [(m as any).c] : [])];
    for (const c of candles) if (c.f !== 0 && !v.fair) bad.push(w + ' fair value in a candle');
    // sniper line only with Dip Sniper, in play
    if (v.ma20 != null && !(holdsSniper && play)) bad.push(w + ' ma20 without Dip Sniper');
    // shop data only in the shop, run summary only at the end
    if (v.offers.length && v.phase !== 'shop') bad.push(w + ' offers outside the shop');
    if (v.clear && v.phase !== 'shop') bad.push(w + ' clear info outside the shop');
    if (v.end && v.phase !== 'end') bad.push(w + ' end info before the end');
    if (v.level.fakeChip != null && v.level.fakeChip < 0.3) bad.push(w + ' fake rate below the chip threshold');
  }
  // raw strings that must never appear before the end message
  // (the run summary at the very end may show the seed: the run is over)
  const pre = JSON.stringify(msgs.filter((m) => m.t !== 'end' && !('v' in m && m.v.phase === 'end')));
  for (const s of ['"type"', '"q"', '"nextEv"', '"rng"', '"shopRng"', '"lf"', '"dev"', '"p0"', '"fake"', '"seed"', '"mag"', '"cash"', '"debt"']) {
    if (pre.includes(s)) bad.push('raw key ' + s + ' in stream');
  }
}

function runSession(seed: string, mint: string | null, lite: boolean, botSeed: number): Promise<ServerMsg[]> {
  const msgs: ServerMsg[] = [];
  const R = mulberry32(botSeed);
  const B: Button[] = ['buy', 'sell', 'lock', 'item0', 'item1'];
  return new Promise((resolve) => {
    let s: RunSession;
    const react = (m: ServerMsg) => setImmediate(() => {
      if (s.done) return;
      if (m.t === 'snap' && m.v.phase === 'intro') s.go();
      else if (m.t === 'snap' && m.v.phase === 'shop') {
        for (const o of m.v.offers) if (!o.sold) s.shop('buy:' + o.id);
        s.next();
      } else if (m.t === 'tick' && R() < 0.06) s.press(B[Math.floor(R() * B.length)]!);
    });
    s = new RunSession(
      { run: 1, player: 1, day: '2026-11-13', attempt: 1, seed, mint },
      { finish: () => setTimeout(() => resolve(msgs), 5), sign: () => '00', signer: '00' },
      { tickMs: 0, idleMs: 0 },
    );
    s.attach((m) => { msgs.push(JSON.parse(JSON.stringify(m))); react(m) }, lite);
  });
}

describe('stream audit', () => {
  const daily = parseSeedHex('0x' + '3c'.repeat(32));
  const cases: [string | null, boolean][] = [[null, false], ['insider', false], ['vwap', false], ['sniper', false], ['insider', true], [null, true], ['devwallet', false], ['short', false]];
  for (const [n, [mint, lite]] of cases.entries()) {
    it(`run with ${mint ?? 'no mint'} (${lite ? 'lite' : 'full'} stream) sends only what the screen shows`, async () => {
      let total = 0, headlines = 0, flagged = 0, fair = 0;
      for (let attempt = 1; attempt <= 4; attempt++) {
        const msgs = await runSession(runSeedOf(daily, n + 1, attempt), mint, lite, n * 31 + attempt);
        const bad: string[] = [];
        audit({ msgs, bad });
        expect(bad.slice(0, 10)).toEqual([]);
        total += msgs.length;
        for (const m of msgs) {
          if (m.t !== 'snap' && m.t !== 'tick') continue;
          for (const e of m.ev) if (e.k === 'headline' && !e.mine) { headlines++; if (e.flagged) flagged++ }
          if ('v' in m && m.v.fair) fair++;
        }
        expect(msgs.at(-1)!.t).toBe('end');
      }
      expect(total).toBeGreaterThan(400);
      expect(headlines).toBeGreaterThan(0);
      // the positive cases really exercise the flags
      if (mint === 'insider' && !lite) expect(flagged).toBeGreaterThan(0);
      if (mint === 'vwap') expect(fair).toBeGreaterThan(0);
      if (mint !== 'insider') expect(flagged).toBe(0);
    });
  }
});
