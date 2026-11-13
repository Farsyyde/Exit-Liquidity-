// Exit Liquidity client. Rendering, sound and screens are ported from
// reference/prototype.html. Game rules live in @exit-liquidity/engine; this
// file only reads the public View and dispatches inputs through a Driver.

import { CON, CSLOTS, IND, LEVELS, fm, fp, type EngineEvent, type View } from '@exit-liquidity/engine';
import type { Driver } from './driver.ts';
import { LocalDriver } from './local.ts';
import { RemoteDriver, rankedAvailable, loadIdentity, saveIdentity, fetchLeaderboard } from './remote.ts';

const MINT_KEY = 'exitliq_mint';
const $ = (id: string) => document.getElementById(id) as HTMLElement;
const params = new URLSearchParams(location.search);
const NATIVE = params.get('math') === 'native';
const MANUAL = params.has('manual');

let drv: Driver | null = null;      // the run being played, if any
let attract: LocalDriver = new LocalDriver({ seed: rndSeed(), mint: null, attract: true, native: NATIVE });
let screen: 'title' | 'intro' | 'play' | 'shop' | 'end' | 'other' = 'title';
let dispEq = 100, sel: string | null = null, lastPhase = '';
let vlo: number | null = null, vhi: number | null = null;
let ranked = false;

function rndSeed(): number { return (Math.random() * 4294967296) >>> 0 }
function V(): View { return ((drv && drv.view) || attract.view) as View }
function playing(): boolean { return screen === 'play' && !!drv && V().phase === 'play' }
function has(v: View, id: string): boolean { return v.inds.indexOf(id) >= 0 || v.nft === id }
function esc(s: string): string { return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string) }
function descOf(v: View, id: string): string {
  const x = IND[id]!;
  let d = x.d;
  if (id === 'bag') d += ' Now +' + v.bagMult.toFixed(1) + '.';
  if (id === 'whale') d += ' Now +' + v.whaleMult.toFixed(2) + '.';
  return d;
}

/* ---------- sound ---------- */
let AC: AudioContext | null = null, muted = false;
function initAudio(): void {
  if (AC) return;
  try { AC = new (window.AudioContext || (window as any).webkitAudioContext)() } catch { AC = null }
}
function beep(f: number, d: number, type?: OscillatorType, v?: number, when?: number): void {
  if (muted || !AC) return;
  try {
    const t = AC.currentTime + (when || 0), o = AC.createOscillator(), g = AC.createGain();
    o.type = type || 'square'; o.frequency.value = f; g.gain.setValueAtTime(v || 0.05, t); g.gain.exponentialRampToValueAtTime(0.0001, t + d);
    o.connect(g); g.connect(AC.destination); o.start(t); o.stop(t + d + 0.02);
  } catch { /* sound is optional */ }
}
function winSound(streak: number): void {
  const base = 440 * Math.pow(1.06, Math.min(streak, 14));
  beep(base, .09, 'square', .05, 0); beep(base * 1.26, .09, 'square', .05, .07); beep(base * 1.5, .14, 'square', .05, .14);
}

/* ---------- storage (one viewer's keepsake, may be missing) ---------- */
interface Mint { id: string; runs: number }
function readMint(): Mint | null {
  try { const v = JSON.parse(localStorage.getItem(MINT_KEY) || 'null'); return v && IND[v.id] && v.runs > 0 ? v : null } catch { return null }
}
function writeMint(v: Mint): void { try { localStorage.setItem(MINT_KEY, JSON.stringify(v)) } catch { /* private mode */ } }

/* ---------- events to juice ---------- */
function onEvents(evs: EngineEvent[]): void {
  for (const e of evs) {
    switch (e.k) {
      case 'headline':
        if (!e.mine && playing()) beep(e.type === 'rug' ? 180 : 880, .05, 'triangle', .04);
        renderNews();
        break;
      case 'open':
        beep(e.dir === 1 ? 520 : 300, .07, 'square', .05);
        if (e.snipe) pop('SNIPED', 'dip entry, +0.75 mult', 'var(--blue)');
        break;
      case 'win':
        pop('+' + fm(e.total).slice(1), (e.mult > 1.001 ? 'x' + e.mult.toFixed(2) + ' ' : '') + e.tags.join(' + '), 'var(--up)');
        winSound(e.streak);
        if (e.big) shake();
        break;
      case 'loss':
        pop('-' + fm(e.loss).slice(1), e.notes.join(', '), 'var(--down)');
        beep(150, .18, 'sawtooth', .05);
        break;
      case 'liquidated':
        pop('LIQUIDATED', 'position wiped', 'var(--down)'); beep(90, .4, 'sawtooth', .07); shake();
        break;
      case 'apeLocked': beep(110, .08, 'square', .04); break;
      case 'item':
        if (e.id === 'inject') pop('+' + fm(e.amount!).slice(1) + ' INJECTED', e.into === 'trade' ? 'added to your trade' : 'added to cash', 'var(--blue)');
        if (e.id === 'reorg') pop('REORG', 'last trade erased', 'var(--blue)');
        beep(990, .06, 'triangle', .05); beep(1320, .1, 'triangle', .05, .06);
        renderCons();
        break;
      case 'reorgEmpty': pop('NOTHING TO UNDO', 'close a trade first', 'var(--dim)'); break;
      case 'countdown': beep(660, .04, 'square', .03); break;
      case 'cleared': beep(523, .1, 'square', .05, 0); beep(659, .1, 'square', .05, .1); beep(784, .2, 'square', .05, .2); break;
      case 'failed': beep(196, .25, 'sawtooth', .06, 0); beep(130, .5, 'sawtooth', .06, .2); break;
    }
  }
}

/** Phase changes from the driver decide which screen shows. */
function onChange(): void {
  if (!drv || !drv.view) return;
  const v = drv.view;
  const key = v.phase + ':' + v.i;
  if (key === lastPhase) {
    if (screen === 'shop' && v.phase === 'shop') showShop();
    return;
  }
  lastPhase = key;
  if (v.phase === 'intro') showIntro();
  else if (v.phase === 'play') { hide(); screen = 'play'; hudKey = ''; renderNews(); renderInds(); renderCons() }
  else if (v.phase === 'shop') { sel = null; showShop() }
  else if (v.phase === 'end') showEnd();
}

function startRun(d: Driver): void {
  if (drv) drv.close();
  drv = d;
  ranked = d.kind === 'ranked';
  d.onEvents = onEvents;
  d.onChange = onChange;
  lastPhase = '';
  vlo = vhi = null;
  $('info').textContent = 'Tap an indicator to read what it does.';
  onChange();
}

/* ---------- main loop ---------- */
let last = performance.now();
function frame(now: number): void {
  const dt = now - last; last = now;
  if (drv) drv.frame(dt); else attract.frame(dt);
  draw();
  requestAnimationFrame(frame);
}

/* ---------- drawing ---------- */
const cv = $('chart') as HTMLCanvasElement, ctx = cv.getContext('2d') as CanvasRenderingContext2D;
function css(n: string): string { return getComputedStyle(document.documentElement).getPropertyValue(n).trim() }
let COL: Record<string, string> | null = null;
function draw(): void {
  const v = V();
  if (!v) return;
  if (!COL) COL = { up: css('--up'), down: css('--down'), gold: css('--gold'), blue: css('--blue'), dim: css('--dim'), edge: css('--panel-edge'), cream: css('--cream') };
  const dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr) }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
  const N = 46, cs = v.candles.slice(-(N - 1));
  if (v.cur) cs.push(v.cur);
  if (!cs.length) return;
  const showFair = playing() && v.fair;
  let lo = Infinity, hi = -Infinity;
  for (const c of cs) { if (c.l < lo) lo = c.l; if (c.h > hi) hi = c.h; if (showFair) { if (c.f < lo) lo = c.f; if (c.f > hi) hi = c.f } }
  if (v.pos) { lo = Math.min(lo, v.pos.entry); hi = Math.max(hi, v.pos.entry) }
  const padv = (hi - lo) * 0.1 || hi * 0.02; lo -= padv; hi += padv;
  if (vlo == null || vhi == null) { vlo = lo; vhi = hi } else { vlo += (lo - vlo) * 0.18; vhi += (hi - vhi) * 0.18 }
  lo = Math.min(vlo, lo + padv * 0.5); hi = Math.max(vhi, hi - padv * 0.5);
  const gut = 58, top = 8, bot = 8, pw = w - gut, cw = pw / N;
  const y = (val: number) => top + (hi - val) / (hi - lo) * (h - top - bot);
  ctx.font = '14px VT323, monospace'; ctx.textBaseline = 'middle';
  ctx.strokeStyle = 'rgba(138,148,173,.14)'; ctx.lineWidth = 1; ctx.fillStyle = COL.dim!;
  for (let g = 1; g <= 3; g++) {
    const val = lo + (hi - lo) * g / 4, yy = Math.round(y(val)) + .5;
    ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(pw, yy); ctx.stroke();
    ctx.fillText(fp(val), pw + 5, yy);
  }
  const x0 = pw - cs.length * cw;
  for (let k = 0; k < cs.length; k++) {
    const c = cs[k]!, x = x0 + k * cw, up = c.c >= c.o;
    ctx.fillStyle = up ? COL.up! : COL.down!;
    const mid = Math.round(x + cw / 2);
    ctx.fillRect(mid, y(c.h), 1, Math.max(1, y(c.l) - y(c.h)));
    const yt = y(Math.max(c.o, c.c)), yb = y(Math.min(c.o, c.c));
    ctx.fillRect(Math.round(x + 1), yt, Math.max(2, Math.round(cw - 2)), Math.max(1.5, yb - yt));
  }
  if (showFair) {
    ctx.strokeStyle = COL.blue!; ctx.lineWidth = 2; ctx.beginPath();
    for (let k = 0; k < cs.length; k++) { const xx = x0 + k * cw + cw / 2, yy = y(cs[k]!.f); if (k) ctx.lineTo(xx, yy); else ctx.moveTo(xx, yy) }
    ctx.stroke();
  }
  if (playing() && v.ma20 != null && !v.pos) {
    const val = v.ma20 * 0.94;
    if (val > lo && val < hi) { hline(y(val), COL.blue!, [2, 4], pw); ctx.fillStyle = COL.blue!; ctx.fillText('SNIPE', 4, y(val) - 8) }
  }
  if (v.pos) {
    const ye = y(v.pos.entry); hline(ye, COL.gold!, [5, 4], pw);
    ctx.fillStyle = COL.gold!; ctx.fillText('ENTRY', 4, ye - 8);
  }
  const p = v.p, yp = Math.max(top + 8, Math.min(h - bot - 8, y(p))), lastC = cs[cs.length - 1]!, upNow = lastC.c >= lastC.o;
  hline(yp, upNow ? COL.up! : COL.down!, [1, 3], pw);
  ctx.fillStyle = upNow ? COL.up! : COL.down!; ctx.fillRect(pw + 1, yp - 9, gut - 3, 18);
  ctx.fillStyle = '#0c1018'; ctx.fillText(fp(p), pw + 5, yp + 1);
  drawHud(v);
}
function hline(yy: number, col: string, dash: number[], pw: number): void {
  ctx.save(); ctx.strokeStyle = col; ctx.lineWidth = 1.5; ctx.setLineDash(dash); ctx.beginPath();
  ctx.moveTo(0, Math.round(yy) + .5); ctx.lineTo(pw, Math.round(yy) + .5); ctx.stroke(); ctx.restore();
}

const el = {
  eq: $('eq'), tg: $('tg'), mult: $('mult'), px: $('px'), tk: $('tk'), layer: $('layer'), tf: $('timerFill'), tt: $('timerTxt'), timer: $('timer'),
  buy: $('buyBtn') as HTMLButtonElement, sell: $('sellBtn') as HTMLButtonElement, lock: $('lockBtn') as HTMLButtonElement, pos: $('posTag'),
};
let hudKey = '';
function drawHud(v: View): void {
  const lv = v.level;
  const eqv = !drv ? lv.start : Math.max(0, v.equity);
  dispEq += (eqv - dispEq) * 0.3; if (Math.abs(eqv - dispEq) < 0.005) dispEq = eqv;
  el.eq.textContent = fm(dispEq);
  el.eq.className = eqv >= lv.target ? 'win' : (eqv < lv.start * 0.999 ? 'lose' : '');
  el.tg.textContent = fm(lv.target);
  el.mult.textContent = 'x' + v.mult.toFixed(1); el.mult.className = v.streak >= 5 ? 'hot' : '';
  el.px.textContent = fp(v.p); el.tk.textContent = lv.tk;
  el.layer.textContent = 'LAYER ' + (LEVELS.length - v.i);
  const left = !drv ? lv.dur : v.left;
  el.tf.style.transform = 'scaleX(' + (left / lv.dur) + ')';
  el.tt.textContent = Math.ceil(left / 10) + 's';
  el.timer.className = 'timer' + (left <= 80 ? ' low' : '');
  const x = v.pos, canShort = v.canShort, play = playing(), ape = play && !!x && x.locked;
  const pct = Math.max(0, Math.min(1, (eqv - lv.start) / (lv.target - lv.start)));
  const ready = play && v.ready;
  const key = [play, x ? x.dir : 0, canShort, ready, Math.floor(pct * 100), eqv >= lv.target, ape].join('|');
  if (key !== hudKey) {
    hudKey = key;
    const lockTxt = 'LOCKED<small>APE MODE</small>';
    el.buy.innerHTML = x && x.dir === -1 ? (ape ? lockTxt : 'COVER<small>CLOSE SHORT</small>') : 'BUY<small>ALL IN</small>';
    el.sell.innerHTML = x ? (x.dir === 1 && ape ? lockTxt : 'SELL<small>ALL OUT</small>') : (canShort ? 'SHORT<small>ALL IN</small>' : 'SELL<small>ALL OUT</small>');
    el.buy.disabled = !play || (!!x && (x.dir === 1 || ape));
    el.sell.disabled = !play || (x ? (x.dir === -1 || ape) : !canShort);
    el.lock.disabled = !ready;
    el.lock.className = 'btn lock' + (ready ? ' ready' : '');
    el.lock.innerHTML = ready ? 'LOCK IN<small>END LEVEL</small>' : (eqv >= lv.target ? 'CLOSE<small>TO LOCK IN</small>' : Math.floor(pct * 100) + '%<small>OF TARGET</small>');
  }
  if (x) {
    const r = x.ret * 100;
    el.pos.style.display = 'block';
    el.pos.style.color = r >= 0 ? COL!.up! : COL!.down!;
    el.pos.textContent = (x.dir === 1 ? 'LONG' : 'SHORT') + (x.lev > 1 ? ' ' + x.lev + 'x' : '') + ' ' + (r >= 0 ? '+' : '') + r.toFixed(1) + '%';
  } else el.pos.style.display = 'none';
}
function pop(big: string, small: string, col: string): void {
  const d = document.createElement('div'); d.className = 'pop'; d.style.color = col;
  d.textContent = big; if (small) { const s = document.createElement('small'); s.textContent = small; d.appendChild(s) }
  $('pops').appendChild(d); setTimeout(() => d.remove(), 1300);
}
function shake(): void { const a = $('app'); a.classList.remove('shake'); void a.offsetWidth; a.classList.add('shake') }
function renderNews(): void {
  const v = V();
  const n = $('news'); n.textContent = '';
  if (!v.feed.length) { const d = document.createElement('div'); d.className = 'h old'; d.textContent = 'The wire is quiet. Headlines land here before the chart moves.'; n.appendChild(d); return }
  v.feed.forEach((f, k) => {
    const fk = f.flagged;
    const d = document.createElement('div'); d.className = 'h ' + (k === 0 ? 'new' : 'old') + (fk ? ' fake' : '');
    const t = document.createElement('span'); t.className = 'tag' + (fk ? ' fk' : (f.mine ? ' me' : '')); t.textContent = fk ? 'FAKE' : (f.mine ? 'YOU' : 'WIRE');
    d.appendChild(t); d.appendChild(document.createTextNode(f.text)); n.appendChild(d);
  });
}
function cardHTML(id: string, extra?: string, act?: string): string {
  const x = IND[id]!;
  return '<button type="button" class="card' + (x.c ? ' cursed' : '') + (extra ? ' ' + extra : '') + '" data-id="' + id + '"' + (act ? ' data-act="' + act + '"' : '') + ' aria-label="' + x.name + '"><span class="g">' + x.g + '</span><span class="n">' + x.name + '</span></button>';
}
function renderInds(): void {
  const v = V();
  let h = '';
  if (v.nft) h += cardHTML(v.nft, 'nft');
  const n = Math.max(v.slots, v.inds.length);
  for (let k = 0; k < n; k++) h += v.inds[k] ? cardHTML(v.inds[k]!) : '<span class="card empty"></span>';
  $('inds').innerHTML = h;
}
function renderCons(): void {
  const v = V();
  const box = $('cons'); box.textContent = '';
  for (let k = 0; k < CSLOTS; k++) {
    const id = v.cons[k], b = document.createElement('button'); b.type = 'button';
    if (id) { b.className = 'citem'; b.dataset.k = String(k); b.textContent = CON[id]!.g + ' ' + CON[id]!.name }
    else { b.className = 'citem empty'; b.disabled = true; b.textContent = 'ITEM SLOT' }
    box.appendChild(b);
  }
}
function useItem(k: number): void {
  const v = V(), id = v.cons[k];
  if (!id) return;
  if (!playing()) { $('info').textContent = CON[id]!.name + ': ' + CON[id]!.d; return }
  drv!.press(k === 0 ? 'item0' : 'item1');
}
$('inds').addEventListener('click', (e) => {
  const c = (e.target as HTMLElement).closest('.card') as HTMLElement | null;
  if (!c || !c.dataset.id) return;
  $('info').textContent = IND[c.dataset.id]!.name + ': ' + descOf(V(), c.dataset.id);
});
$('cons').addEventListener('pointerdown', (e) => {
  const b = (e.target as HTMLElement).closest('.citem') as HTMLElement | null;
  if (!b || b.dataset.k == null) return;
  e.preventDefault(); initAudio(); useItem(+b.dataset.k);
});

/* ---------- screens ---------- */
const ov = $('overlay'), md = $('modal');
function show(html: string): void { md.innerHTML = html; ov.classList.remove('hide'); md.scrollTop = 0 }
function hide(): void { ov.classList.add('hide') }
let rankedUp = false;
function showTitle(): void {
  screen = 'title';
  const mint = readMint();
  show('<span class="eyebrow">WORKING TITLE, PLAYABLE MVP</span><h1>EXIT LIQUIDITY</h1>' +
    '<p>You fell asleep at the terminal and woke up inside it. Eight layers of memecoins sit between you and reality. Trade your way out.</p>' +
    '<ul><li>Buy the dips, sell the highs, hit the target before the clock runs out.</li>' +
    '<li>Read the wire. Headlines land about a second before the chart moves, and some are lies.</li>' +
    '<li>Winning trades in a row build your streak multiplier. One loss resets it.</li>' +
    '<li>Between layers, spend alpha on indicators that bend the rules and one-shot items you fire mid-trade.</li></ul>' +
    (mint ? '<p><span class="chip y">MINTED</span>' + IND[mint.id]!.name + ' joins this run (' + mint.runs + ' left).</p>' : '') +
    '<div class="row"><button class="btn go" data-act="start" type="button">START RUN</button></div>' +
    (rankedUp ? '<div class="row"><button class="btn alt" data-act="ranked" type="button">RANKED RUN</button><button class="btn alt" data-act="board" type="button">LEADERBOARD</button></div>' : '') +
    '<p class="eyebrow">KEYS: B BUY, S SELL, L LOCK IN, 1 AND 2 ITEMS</p>');
}
function showRankedEntry(msg?: string): void {
  screen = 'other';
  const id = loadIdentity();
  show('<span class="eyebrow">RANKED, SERVER PICKS THE CHART</span><h1>RANKED RUN</h1>' +
    '<p>The server holds today\'s seed and streams the chart. Your inputs are stamped with the tick they arrive on. Anyone can replay the receipt once the day\'s seed is revealed.</p>' +
    '<p><label for="rname">Name</label></p><input id="rname" maxlength="24" autocomplete="off" value="' + esc(id ? id.name : '') + '" style="font-family:var(--body);font-size:21px;padding:6px;border-radius:6px;border:2px solid var(--panel-edge);background:#0c1018;color:var(--cream);-webkit-user-select:text;user-select:text">' +
    (msg ? '<p style="color:var(--down)">' + esc(msg) + '</p>' : '') +
    '<div class="row"><button class="btn alt" data-act="title" type="button">BACK</button><button class="btn go" data-act="enter" type="button">ENTER</button></div>');
}
async function showBoard(): Promise<void> {
  screen = 'other';
  show('<span class="eyebrow">TODAY, UTC</span><h1>LEADERBOARD</h1><p>Loading.</p>');
  try {
    const b = await fetchLeaderboard();
    let h = '<span class="eyebrow">' + esc(b.day) + ', UTC</span><h1>LEADERBOARD</h1>';
    if (!b.rows.length) h += '<p>No ranked runs today yet.</p>';
    else {
      h += '<div class="stat">';
      b.rows.forEach((r, k) => { h += '<span>' + (k + 1) + '. ' + esc(r.name) + '</span><span>' + r.layers + ' / ' + LEVELS.length + ', ' + fm(r.bank) + '</span>' });
      h += '</div>';
    }
    h += '<div class="row"><button class="btn alt" data-act="title" type="button">BACK</button></div>';
    show(h);
  } catch {
    show('<h1>LEADERBOARD</h1><p>The server is not answering.</p><div class="row"><button class="btn alt" data-act="title" type="button">BACK</button></div>');
  }
}
function showIntro(): void {
  screen = 'intro';
  const v = V(), L = v.level;
  let chips = '';
  if (L.rug) chips += '<span class="chip">RUGS ENABLED</span>';
  if (L.fake >= .3) chips += '<span class="chip y">FAKE NEWS ' + Math.round(L.fake * 100) + '%</span>';
  if (L.hunter) chips += '<span class="chip b">BOSS: THE MARKET MAKER</span>';
  dispEq = L.start;
  renderNews(); renderInds(); renderCons();
  show('<span class="eyebrow">LAYER ' + (LEVELS.length - v.i) + ' OF ' + LEVELS.length + (ranked ? ', RANKED' : '') + '</span><h1>' + L.tk + '</h1>' +
    '<p class="lore">' + L.lore + '</p>' + (chips ? '<p>' + chips + '</p>' : '') +
    (L.hunter ? '<p>While you hold a position, the price leans against it. Get in, get paid, get out.</p>' : '') +
    (L.drained ? '<p><span class="chip c">DRAINED</span>Someone read your sticky note. ' + IND[L.drained]!.name + ' is gone.</p>' : '') +
    (L.drop ? '<p><span class="chip g">AIRDROP</span>+' + fm(L.drop) + ' landed in your wallet.</p>' : '') +
    (L.loan ? '<p><span class="chip c">DEV WALLET</span>' + fm(L.loan) + ' on loan to trade with. Repaid at the bell.</p>' : '') +
    '<p>Turn <b>' + fm(L.start) + '</b> into <b style="color:var(--gold)">' + fm(L.target) + '</b> in ' + (L.dur / 10) + ' seconds.</p>' +
    '<div class="row"><button class="btn go" data-act="trade" type="button">OPEN THE CHART</button></div>');
}
function shopNote(v: View): string {
  const c = v.clear;
  if (!c) return '';
  return 'Cleared with ' + fm(c.bank) + ' against a ' + fm(c.target) + ' target. Alpha earned: ' + c.a + ' base' + (c.b ? ', +' + c.b + ' surplus' : '') + (c.c ? ', +' + c.c + ' speed' : '') + '.';
}
function showShop(): void {
  screen = 'shop';
  const v = V();
  const consCount = v.cons.filter(Boolean).length;
  let h = '<span class="eyebrow">BETWEEN LAYERS</span><h1>THE DESK</h1><p>' + shopNote(v) + '</p>' +
    '<p class="alpha">ALPHA TO SPEND: ' + v.credits + '</p>';
  v.offers.forEach((o, k) => {
    const x = o.con ? CON[o.id]! : IND[o.id]!;
    const full = o.con ? consCount >= CSLOTS : v.inds.length >= v.slots;
    const no = o.sold || v.credits < x.cost || full;
    if (k === 3) h += '<h2>ITEMS, ONE USE EACH (' + consCount + '/' + CSLOTS + ')</h2>';
    h += '<div class="offer' + (o.sold ? ' sold' : '') + '"><div class="card' + (o.con ? ' con' : '') + ((x as { c?: 1 }).c ? ' cursed' : '') + '"><span class="g">' + x.g + '</span></div>' +
      '<div><div class="t">' + x.name + ((x as { c?: 1 }).c ? ' <span class="chip c">CURSED</span>' : '') + '</div><div class="d">' + x.d + '</div></div>' +
      '<button class="btn" data-act="buy" data-k="' + k + '" data-id="' + o.id + '" type="button"' + (no ? ' disabled' : '') + '>' + (o.sold ? 'SOLD' : x.cost) + '</button></div>';
  });
  h += '<h2>YOUR INDICATORS (' + v.inds.length + '/' + v.slots + ')</h2><div class="inds">';
  if (v.nft) h += cardHTML(v.nft, 'nft', 'pick');
  const n = Math.max(v.slots, v.inds.length);
  for (let k = 0; k < n; k++) { const id = v.inds[k]; h += id ? cardHTML(id, sel === id ? 'sel' : '', 'pick') : '<span class="card empty"></span>' }
  h += '</div>';
  if (sel && IND[sel]) {
    const mine = v.inds.indexOf(sel) >= 0;
    h += '<p>' + IND[sel]!.name + ': ' + descOf(v, sel) + (mine ? '' : ' Minted, cannot be sold.') + '</p>';
    if (mine) h += '<div class="row"><button class="btn alt" data-act="sellind" type="button">SELL FOR 1 ALPHA</button></div>';
  } else h += '<p style="color:var(--dim)">Tap one of yours to read it or sell it.</p>';
  h += '<div class="row"><button class="btn alt" data-act="reroll" type="button"' + (v.credits < 1 ? ' disabled' : '') + '>REROLL (1)</button>' +
    '<button class="btn go" data-act="next" type="button">NEXT LAYER</button></div>';
  show(h); renderInds(); renderCons();
}
function showEnd(): void {
  screen = 'end';
  const v = V(), e = v.end!, L = v.level;
  const won = e.won;
  const seed = e.seed.toString(16).toUpperCase().padStart(8, '0');
  let h = won ? '<span class="eyebrow">LAYER 0</span><h1>REALITY</h1><p>The terminal goes dark. You are at your desk. It is 4:12 AM. Your real portfolio is down 3%. It is, somehow, a relief.</p>'
    : '<span class="eyebrow">LAYER ' + (LEVELS.length - v.i) + ', ' + L.tk + '</span><h1>MARGIN CALLED</h1><p>You needed ' + fm(L.target) + ' and closed with ' + fm(e.bank) + '. The terminal resets. So do you.</p>';
  h += '<div class="stat"><span>Layers cleared</span><span id="endLayers">' + e.layers + ' of ' + LEVELS.length + '</span>' +
    '<span>Final bankroll</span><span id="endBank">' + fm(e.bank) + '</span><span>Trades closed</span><span>' + e.trades + '</span>' +
    '<span>Best single trade</span><span>' + fm(e.best) + '</span><span>Run seed</span><span>' + seed + '</span></div>';
  if (v.inds.length) {
    h += '<h2>MINT ONE TO KEEP</h2><p>Pick one indicator. It joins your next 3 runs in a bonus slot. ' + (ranked ? 'Kept on the run server for ranked runs.' : 'Simulated here, an NFT mint in the real game.') + '</p><div class="inds" id="mintRow">';
    v.inds.forEach((id) => { h += cardHTML(id, '', 'mint') });
    h += '</div><p id="mintMsg" style="color:var(--dim)">Minting replaces any indicator you minted before.</p>';
  }
  h += '<div class="row"><button class="btn alt" data-act="copy" type="button">COPY RUN RECEIPT</button>' +
    '<button class="btn go" data-act="' + (ranked ? 'title' : 'start') + '" type="button">' + (ranked ? 'DONE' : 'NEW RUN') + '</button></div>' +
    '<p id="rcptMsg" class="eyebrow">THE RECEIPT IS THE SEED PLUS EVERY INPUT. IT IS WHAT A VERIFIER WOULD REPLAY.</p>' +
    '<textarea id="rcpt" readonly aria-label="Run receipt"></textarea>';
  show(h);
}

function newPractice(): void {
  const m = readMint();
  let mint: string | null = null;
  if (m) { mint = m.id; m.runs--; writeMint(m) }
  const seedParam = params.get('seed');
  const d = new LocalDriver({ seed: seedParam != null ? Number(seedParam) >>> 0 : rndSeed(), mint, native: NATIVE });
  d.manual = MANUAL;
  startRun(d);
}

md.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest('[data-act]') as HTMLButtonElement | null;
  if (!b || b.disabled) return;
  const act = b.dataset.act;
  initAudio(); beep(700, .04, 'square', .03);
  if (act === 'start') newPractice();
  else if (act === 'title') { if (drv) { drv.close(); drv = null } ranked = false; attract = new LocalDriver({ seed: rndSeed(), mint: null, attract: true, native: NATIVE }); vlo = vhi = null; renderNews(); renderInds(); renderCons(); showTitle() }
  else if (act === 'ranked') showRankedEntry();
  else if (act === 'board') void showBoard();
  else if (act === 'enter') {
    const name = (($('rname') as HTMLInputElement).value || '').trim();
    if (!/^[A-Za-z0-9 _.-]{2,24}$/.test(name)) { showRankedEntry('Use 2 to 24 letters, numbers, spaces, dots, dashes or underscores.'); return }
    show('<h1>CONNECTING</h1><p>Asking the run server for a chart.</p>');
    RemoteDriver.connect(name).then((d) => { saveIdentity(d.identity); startRun(d) }).catch((err: Error) => showRankedEntry(err.message));
  } else if (act === 'trade') drv?.go();
  else if (act === 'buy') drv?.shop('buy:' + b.dataset.id);
  else if (act === 'pick') { sel = sel === b.dataset.id ? null : (b.dataset.id ?? null); showShop() }
  else if (act === 'sellind') { if (sel) { const s = sel; sel = null; drv?.shop('sell:' + s) } }
  else if (act === 'reroll') drv?.shop('reroll');
  else if (act === 'next') drv?.next();
  else if (act === 'mint') {
    const id = b.dataset.id!;
    if (drv && drv.kind === 'ranked') (drv as RemoteDriver).mint(id);
    else writeMint({ id, runs: 3 });
    md.querySelectorAll('#mintRow .card').forEach((c) => c.classList.toggle('nft', c === b));
    $('mintMsg').textContent = IND[id]!.name + ' minted. It will be waiting in your next 3 ' + (ranked ? 'ranked ' : '') + 'runs.';
  } else if (act === 'copy') {
    const msg = $('rcptMsg'), box = $('rcpt') as HTMLTextAreaElement;
    void drv?.receipt().then((txt) => {
      box.value = txt;
      const fail = () => { box.style.display = 'block'; box.focus(); box.select(); msg.textContent = 'COPY IS BLOCKED HERE. SELECT THE TEXT BELOW.' };
      try { navigator.clipboard.writeText(txt).then(() => { msg.textContent = 'RECEIPT COPIED.' }, fail) } catch { fail() }
    });
  }
});

/* ---------- input ---------- */
function pressBuy(): void { if (playing()) drv!.press('buy') }
function pressSell(): void { if (playing()) drv!.press('sell') }
function pressLock(): void { if (playing()) drv!.press('lock') }
function bind(btn: HTMLElement, fn: () => void): void {
  btn.addEventListener('pointerdown', (e) => { e.preventDefault(); initAudio(); fn() });
  btn.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn() } });
}
bind(el.buy, pressBuy); bind(el.sell, pressSell); bind(el.lock, pressLock);
document.addEventListener('keydown', (e) => {
  if (!playing() || e.repeat) return;
  const k = e.key.toLowerCase();
  if (k === 'b' || k === 'arrowup') pressBuy(); else if (k === 's' || k === 'arrowdown') pressSell(); else if (k === 'l') pressLock();
  else if (k === '1') useItem(0); else if (k === '2') useItem(1);
});
$('muteBtn').addEventListener('click', function (this: HTMLElement) { muted = !muted; this.textContent = muted ? 'SOUND OFF' : 'SOUND ON' });

/* ---------- boot ---------- */
renderNews(); renderInds(); renderCons();
showTitle();
requestAnimationFrame(frame);
void rankedAvailable().then((up) => { rankedUp = up; if (screen === 'title') showTitle() });

// Test hook: lets a scripted browser step ticks deterministically (?manual).
if (MANUAL) (window as any).__el = { get drv() { return drv }, step(n = 1) { for (let k = 0; k < n; k++) (drv as LocalDriver | null)?.step(); drv?.frame(0) } };
