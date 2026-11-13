// Records golden receipts by playing the untouched prototype (reference/prototype.html)
// in headless Chromium with scripted bots. The engine's replay() must reproduce
// every one of them exactly. Run: pnpm golden:record
//
// The page's own animation loop is disabled and the bot calls the prototype's
// tick() and press handlers directly, so a run takes milliseconds and the
// recorded log is exactly what the prototype would have logged.

import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fixedMathPatch } from './bundle.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// usage: node scripts/record-golden.mjs <native|fixed> [count]
// native: the prototype exactly as shipped, using Chromium's Math.
// fixed:  the prototype with Math.exp/log/cos replaced by the engine's portable fixed math.
const MATH = process.argv[2] ?? 'native';
if (MATH !== 'native' && MATH !== 'fixed') throw new Error('math must be native or fixed');
const COUNT = Number(process.argv[3] ?? 66);
const out = resolve(root, `packages/engine/test/golden/${MATH}.json`);
const INDS = ['diamond', 'paper', 'vwap', 'insider', 'stop', 'lev2', 'lev5', 'short', 'mev', 'copium', 'sniper', 'top',
  'time', 'airdrop', 'compound', 'bag', 'whale', 'tax', 'martin', 'funding', 'devwallet', 'sticky', 'ape'];
const STYLES = ['oracle', 'headline', 'random'];

const init = () => {
  window.requestAnimationFrame = () => 0;
  window.AudioContext = undefined;
  window.webkitAudioContext = undefined;
  const orig = Math.random;
  window.__seedQ = [];
  Math.random = () => (window.__seedQ.length ? window.__seedQ.shift() : orig());
};

// Runs inside the page. Uses the prototype's globals (S, M, Lv, mode, tick, press*, useCons, md, HEAD).
function botRun(args) {
  const { seed, botSeed, mint, style } = args;
  const R = mulberry32(botSeed);
  const click = (sel) => { const b = md.querySelector(sel); if (!b) throw new Error('missing ' + sel); b.click(); };
  try { localStorage.clear(); } catch (e) {}
  if (mint) localStorage.setItem('exitliq_mint', JSON.stringify({ id: mint, runs: 3 }));
  window.__seedQ.push(seed / 4294967296);
  click('[data-act=start]');
  if (S.seed !== seed) throw new Error('seed injection failed');
  let lastTop = null, guard = 0;
  const pumpTexts = HEAD.pump.map((t) => t.replace('{T}', ''));
  const isType = (text, type) => HEAD[type].some((t) => text === t.replace('{T}', Lv.L.tk));

  function playOracle() {
    const pend = M.q;
    const soon = (types, w) => pend.some((e) => types.includes(e.type) && e.start - M.t <= w && M.t < e.end);
    const x = Lv.pos;
    if (!x) {
      if (Lv.cash - Lv.debt >= Lv.target && R() < 0.5) { pressLock(); return; }
      if (soon(['pump', 'spike'], 3)) { pressBuy(); return; }
      if (soon(['dump', 'rug', 'dip'], 3) && has('short')) { pressSell(); return; }
      if (R() < 0.01 && S.cons.some(Boolean)) { useCons(S.cons[0] ? 0 : 1); return; }
      if (R() < 0.004) pressBuy();
    } else {
      const ret = posValue() / x.margin - 1;
      const good = x.dir === 1 ? soon(['pump', 'spike'], 0) : soon(['dump', 'rug', 'dip'], 0);
      if (!good && (ret > 0.01 || R() < 0.05)) { x.dir === 1 ? pressSell() : pressBuy(); return; }
      if (R() < 0.01 && S.cons.some(Boolean)) useCons(S.cons[0] ? 0 : 1);
    }
  }
  function playHeadline() {
    const top = Lv.feed[0] || null;
    const x = Lv.pos;
    if (top && top !== lastTop) {
      lastTop = top;
      if (!top.mine) {
        if ((isType(top.text, 'pump') || isType(top.text, 'dip')) && !x && R() < 0.85) { pressBuy(); return; }
        if ((isType(top.text, 'dump') || isType(top.text, 'rug')) && x && x.dir === 1) { pressSell(); return; }
        if ((isType(top.text, 'dump') || isType(top.text, 'rug')) && !x && has('short')) { pressSell(); return; }
      }
    }
    if (x) {
      const ret = posValue() / x.margin - 1;
      if ((ret > 0.06 && R() < 0.15) || (ret < -0.08 && R() < 0.1) || R() < 0.004) { x.dir === 1 ? pressSell() : pressBuy(); return; }
    } else if (Lv.cash - Lv.debt >= Lv.target && R() < 0.2) { pressLock(); return; }
    if (R() < 0.005 && S.cons.some(Boolean)) useCons(R() < 0.5 ? 0 : 1);
  }
  function playRandom() {
    const r = R();
    if (r < 0.015) pressBuy();
    else if (r < 0.03) pressSell();
    else if (r < 0.035) pressLock();
    else if (r < 0.038) useCons(0);
    else if (r < 0.041) useCons(1);
  }
  function shopBot() {
    const n = 1 + Math.floor(R() * 6);
    for (let k = 0; k < n; k++) {
      const r = R();
      if (r < 0.7) {
        const btns = [...md.querySelectorAll('[data-act=buy]')].filter((b) => !b.disabled);
        if (btns.length) btns[Math.floor(R() * btns.length)].click();
      } else if (r < 0.85) {
        const mine = [...md.querySelectorAll('.inds [data-act=pick]')].filter((b) => !b.classList.contains('nft'));
        if (mine.length) {
          mine[Math.floor(R() * mine.length)].click();
          const s = md.querySelector('[data-act=sellind]');
          if (s) s.click();
        }
      } else {
        const b = md.querySelector('[data-act=reroll]');
        if (b && !b.disabled) b.click();
      }
    }
  }

  while (true) {
    if (guard++ > 400000) throw new Error('guard');
    if (mode === 'pause') {
      if (md.querySelector('[data-act=trade]')) { click('[data-act=trade]'); continue; }
      if (md.querySelector('[data-act=next]')) { shopBot(); click('[data-act=next]'); continue; }
      if (md.querySelector('[data-act=copy]')) break;
      throw new Error('unknown screen');
    }
    if (mode === 'play') {
      if (style === 'oracle') playOracle(); else if (style === 'headline') playHeadline(); else playRandom();
      if (mode === 'play') tick();
    }
  }
  const won = md.querySelector('[data-act=copy]').dataset.won === '1';
  return {
    receipt: JSON.parse(receipt(won)),
    final: {
      bank: S.bank, credits: S.credits, trades: S.trades, best: S.best, streak: S.streak, i: S.i,
      inds: S.inds.slice(), cons: S.cons.slice(), bagMult: S.bagMult, whaleMult: S.whaleMult, won,
    },
  };
}

const browser = await chromium.launch();
const page = await browser.newPage();
await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
await page.addInitScript(init);
if (MATH === 'fixed') await page.addInitScript({ content: fixedMathPatch() });
await page.goto(pathToFileURL(resolve(root, 'reference/prototype.html')).href);
await page.evaluate(`window.__botRun = ${botRun.toString()}`);

const runs = [];
for (let n = 0; n < COUNT; n++) {
  const seed = (Math.imul(n + 1, 2654435761) ^ 0x5bd1e995) >>> 0;
  const style = STYLES[n % STYLES.length];
  const mint = n % 2 === 0 ? INDS[(n / 2) % INDS.length] : null;
  const r = await page.evaluate((a) => window.__botRun(a), { seed, botSeed: n * 7919 + 1, mint, style });
  runs.push({ style, ...r });
  console.log(n, style, mint ?? '-', 'layers', r.receipt.result.layers, 'bank', r.receipt.result.bank, 'inputs', r.receipt.log.length);
}
const version = browser.version();
await browser.close();
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ source: 'reference/prototype.html', recorded: 'scripts/record-golden.mjs', math: MATH, browser: version, runs }, null, 0) + '\n');
console.log('wrote', out);
