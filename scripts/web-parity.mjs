// M0 exit test: the web app plays identically to the prototype.
//
// Builds apps/web, opens it in Chromium with native Math (?math=native) and a
// manual clock (?manual), then replays every native golden receipt (recorded
// from reference/prototype.html) by pressing the real UI: keyboard keys in
// play, shop buttons between layers. The web app's own receipt and end screen
// must match the prototype's exactly.

import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveStatic } from './static.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const golden = JSON.parse(readFileSync(resolve(root, 'packages/engine/test/golden/native.json'), 'utf8'));
const LIMIT = Number(process.argv[2] ?? golden.runs.length);

if (!process.argv.includes('--no-build')) execSync('pnpm --filter @exit-liquidity/web build', { cwd: root, stdio: 'inherit' });
const srv = await serveStatic(resolve(root, 'apps/web/dist'));
const base = `http://127.0.0.1:${srv.address().port}/`;

// prototype's money formatter, to check the end screen text
function fm(n) { const a = Math.abs(n); if (a >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B'; if (a >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M'; if (a >= 1e4) return '$' + (n / 1e3).toFixed(1) + 'K'; if (a >= 100) return '$' + Math.round(n).toLocaleString('en-US'); return '$' + n.toFixed(2); }

function drive(run) {
  const E = window.__el;
  const md = document.getElementById('modal');
  const key = (k) => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
  const click = (sel) => { const b = md.querySelector(sel); if (!b) throw new Error('missing ' + sel); b.click(); };
  const v = () => E.drv.view;
  const log = run.receipt.log;
  let p = 0, guard = 0;
  click('[data-act=start]');
  while (v().phase !== 'end') {
    if (++guard > 200000) throw new Error('guard');
    const ph = v().phase;
    if (ph === 'intro') { click('[data-act=trade]'); continue; }
    if (ph === 'shop') {
      while (p < log.length && log[p][0] === v().i && log[p][1] === -1) {
        const code = log[p][2];
        if (code === 'reroll') click('[data-act=reroll]');
        else if (code.startsWith('buy:')) click('[data-act=buy][data-id="' + code.slice(4) + '"]');
        else if (code.startsWith('sell:')) { click('.inds [data-act=pick][data-id="' + code.slice(5) + '"]'); click('[data-act=sellind]'); }
        p++;
      }
      click('[data-act=next]');
      continue;
    }
    const t = E.drv.tickNow;
    while (p < log.length && log[p][0] === v().i && log[p][1] === t && v().phase === 'play') {
      const code = log[p][2], x = v().pos;
      if (code === 'O+') key('b');
      else if (code === 'O-') key('s');
      else if (code === 'X') key(x && x.dir === 1 ? 's' : 'b');
      else if (code === 'L') key('l');
      else if (code.startsWith('C:')) key(String(v().cons.indexOf(code.slice(2)) + 1));
      p++;
    }
    if (v().phase === 'play') E.step(1);
  }
  return E.drv.receipt().then((rc) => ({
    receipt: rc, used: p, bankText: document.getElementById('endBank').textContent,
    layersText: document.getElementById('endLayers').textContent,
  }));
}

const browser = await chromium.launch();
const page = await browser.newPage();
await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
let bad = 0;
for (const [n, run] of golden.runs.slice(0, LIMIT).entries()) {
  await page.goto(`${base}?math=native&manual&seed=${run.receipt.seed}`);
  await page.evaluate((mint) => { localStorage.clear(); if (mint) localStorage.setItem('exitliq_mint', JSON.stringify({ id: mint, runs: 3 })); }, run.receipt.mint);
  const out = await page.evaluate(drive, run);
  const layers = run.final.won ? 8 : run.final.i;
  const same = out.receipt === JSON.stringify(run.receipt) && out.used === run.receipt.log.length &&
    out.bankText === fm(run.final.bank) && out.layersText === layers + ' of 8';
  if (!same) { bad++; console.log('MISMATCH run', n, out.receipt.slice(0, 200), 'want', JSON.stringify(run.receipt).slice(0, 200)); }
}
await browser.close();
srv.close();
if (errors.length) { console.log('page errors:', errors.slice(0, 5)); }
const total = Math.min(LIMIT, golden.runs.length);
console.log(`web parity: ${total - bad}/${total} prototype runs reproduced exactly through the web UI`);
process.exit(bad || errors.length ? 1 : 0);
