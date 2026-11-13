// Balance sim: per layer pass rates under mulberry32 (practice, the prototype's
// generator) and xoshiro256** (ranked), with the same bot policies and the same
// bot randomness on both arms. Only the market generator differs.
//
//   pnpm --filter @exit-liquidity/server sim [runsPerArm]
//
// Pass rate for layer k = runs that cleared layer k / runs that reached it.

import { IND, INDS, engine, mulberry32, type EngineEvent, type RunState } from '@exit-liquidity/engine';
import { parseSeedHex, runSeedOf } from './seeds.ts';
import { writeFileSync } from 'node:fs';

type Policy = 'headline' | 'headline+shop';
const LATENCY = 2; // ticks between a headline and the bot's press (about 200 ms)
const PRIORITY = ['insider', 'mev', 'stop', 'compound', 'short', 'time', 'diamond', 'paper', 'copium', 'lev2', 'top', 'whale', 'bag', 'airdrop', 'tax', 'sniper', 'vwap', 'martin', 'funding'];

function playRun(S: RunState, policy: Policy, botSeed: number): number {
  const R = mulberry32(botSeed);
  const due: { at: number; code: 'buy' | 'sell' }[] = [];
  let held = 0;
  while (S.phase !== 'end') {
    if (S.phase === 'intro') { engine.applyInput(S, 'go'); continue }
    if (S.phase === 'shop') {
      if (policy === 'headline+shop') {
        for (const id of [...PRIORITY, ...INDS.map((x) => x.id)]) {
          const o = S.offers.find((x) => x.id === id && !x.con && !x.sold);
          if (o && !IND[o.id]!.c && S.credits >= IND[o.id]!.cost) engine.applyInput(S, 'buy:' + o.id);
        }
      }
      engine.applyInput(S, 'next');
      due.length = 0;
      continue;
    }
    const t = S.m.t - S.lv.t0;
    for (let k = due.length - 1; k >= 0; k--) {
      const d = due[k]!;
      if (d.at > t) continue;
      due.splice(k, 1);
      const code = engine.pressCode(S, d.code);
      if (code) engine.applyInput(S, code);
    }
    if (S.phase !== 'play') continue;
    const x = S.lv.pos;
    held = x ? held + 1 : 0;
    if (x) {
      const ret = Math.max(0, x.margin * (1 + x.lev * x.dir * (S.m.p / x.entry - 1))) / x.margin - 1;
      if (held > 45 + R() * 15 || ret > 0.3 || ret < -0.15) { const c = engine.pressCode(S, x.dir === 1 ? 'sell' : 'buy'); if (c) engine.applyInput(S, c) }
    } else if (S.lv.cash - S.lv.debt >= S.lv.target) { engine.applyInput(S, 'L'); continue }
    const ev: EngineEvent[] = engine.tick(S);
    for (const e of ev) {
      if (e.k !== 'headline' || e.mine) continue;
      if (e.type === 'pump') due.push({ at: t + 1 + LATENCY, code: 'buy' });
      else if (e.type === 'dump' || e.type === 'rug') due.push({ at: t + 1 + LATENCY, code: 'sell' });
    }
  }
  return S.won ? 8 : S.i;
}

interface Arm { reached: number[]; cleared: number[]; ends: number[] }

function runArm(gen: 'mulberry32' | 'xoshiro256ss', policy: Policy, n: number): Arm {
  const meta = mulberry32(0xba1a);
  const daily = parseSeedHex('0x' + 'ba'.repeat(32));
  const arm: Arm = { reached: Array(8).fill(0), cleared: Array(8).fill(0), ends: Array(9).fill(0) };
  for (let k = 0; k < n; k++) {
    const seed = gen === 'mulberry32' ? (meta() * 4294967296) >>> 0 : runSeedOf(daily, k + 1, 1);
    const S = engine.createRun(seed, null, gen);
    const layers = playRun(S, policy, k * 7919 + 13);
    arm.ends[layers]!++;
    for (let L = 0; L < 8; L++) { if (layers >= L) arm.reached[L]!++; if (layers > L) arm.cleared[L]!++ }
  }
  return arm;
}

function ci(p: number, n: number): number { return n ? 1.96 * Math.sqrt((p * (1 - p)) / n) : 0 }
function z(c1: number, n1: number, c2: number, n2: number): number {
  if (!n1 || !n2) return 0;
  const p = (c1 + c2) / (n1 + n2), se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  return se ? (c2 / n2 - c1 / n1) / se : 0;
}
const pct = (x: number) => (100 * x).toFixed(1) + '%';

const N = Number(process.argv[2] ?? 10000);
const t0 = Date.now();
const lines: string[] = [];
lines.push(`# Balance sim: mulberry32 vs xoshiro256**`, '', `${N} runs per arm. Same bots, same bot randomness; only the market generator differs.`,
  `Bots trade headlines with a ${LATENCY} tick reaction delay. "headline" never shops (the spec's no power ups bot); "headline+shop" buys indicators by a fixed priority list.`,
  `Pass rate = cleared / reached for that layer, with a 95% interval. z is the two proportion z score (new minus old); |z| > 3 would suggest a real difference.`, '');
for (const policy of ['headline', 'headline+shop'] as Policy[]) {
  const a = runArm('mulberry32', policy, N), b = runArm('xoshiro256ss', policy, N);
  lines.push(`## ${policy}`, '', '| Level (UI layer) | Coin | old reached | old pass | new reached | new pass | z |', '|---|---|---|---|---|---|---|');
  const coins = ['$WAGMI', '$COPE', '$RUGDAO', '$HOPIUM', '$GRANDMA', '$SOURCE', '$LASTONE', '$REAL'];
  for (let L = 0; L < 8; L++) {
    const pa = a.reached[L] ? a.cleared[L]! / a.reached[L]! : 0, pb = b.reached[L] ? b.cleared[L]! / b.reached[L]! : 0;
    lines.push(`| ${L + 1} (${8 - L}) | ${coins[L]} | ${a.reached[L]} | ${pct(pa)} ± ${pct(ci(pa, a.reached[L]!))} | ${b.reached[L]} | ${pct(pb)} ± ${pct(ci(pb, b.reached[L]!))} | ${z(a.cleared[L]!, a.reached[L]!, b.cleared[L]!, b.reached[L]!).toFixed(2)} |`);
  }
  lines.push('', `Full clears: old ${a.ends[8]}, new ${b.ends[8]}.`, '');
}
lines.push(`Took ${((Date.now() - t0) / 1000).toFixed(0)} s.`);
const md = lines.join('\n') + '\n';
console.log(md);
if (process.argv[3]) writeFileSync(process.argv[3], md);
