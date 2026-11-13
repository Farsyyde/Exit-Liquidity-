// The prototype exactly as shipped, using Chromium's own Math, against the
// engine running inside the same Chromium with the same native Math. This is
// the "plays identically to index.html" check at the rules level.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
// @ts-expect-error plain JS helper
import { engineBundle } from '../../../scripts/bundle.mjs';

const require = createRequire(import.meta.url);
let chromium: { launch(): Promise<any> } | null = null;
try { chromium = require('playwright').chromium } catch { chromium = null }

const golden = JSON.parse(readFileSync(new URL('./golden/native.json', import.meta.url), 'utf8'));

describe.skipIf(!chromium)('engine in Chromium vs prototype in Chromium (native Math)', () => {
  it('replays every native golden receipt bit for bit', async () => {
    const browser = await chromium!.launch();
    try {
      const page = await browser.newPage();
      await page.setContent('<!doctype html><title>parity</title>');
      await page.addScriptTag({ content: engineBundle() });
      const results = await page.evaluate((runs: any[]) => {
        const E = (window as any).ELE;
        const eng = E.nativeEngine;
        return runs.map((run) => {
          const out = eng.replay(run.receipt);
          if (!out.ok) return { ok: false, error: out.error };
          const S = out.state;
          return {
            ok: true,
            same: S.bank === run.final.bank && S.best === run.final.best && S.credits === run.final.credits &&
              S.trades === run.final.trades && S.i === run.final.i &&
              (() => { const rc = eng.receipt(S), p = run.receipt; return rc.v === 3 && rc.rng === 'mulberry32' && rc.math === undefined &&
                JSON.stringify([rc.seed, rc.mint, rc.log, rc.result]) === JSON.stringify([p.seed, p.mint, p.log, p.result]) })(),
            bank: S.bank, want: run.final.bank,
          };
        });
      }, golden.runs);
      expect(results.length).toBe(golden.runs.length);
      for (const [n, r] of results.entries()) expect({ n, ...r }).toMatchObject({ n, ok: true, same: true });
    } finally {
      await browser.close();
    }
  });
});
