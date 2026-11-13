#!/usr/bin/env -S npx tsx
// Verifier CLI (spec section 7). Exits nonzero on any mismatch.
//
//   verify <run.json> <dailySeed> [--commit 0x..] [--signer hex]
//       run.json is a receipt, or {receipt, attestation} as the server sends it.
//   verify --batch <runs.jsonl> [--signer hex]
//       one {receipt, attestation, dailySeed, commit?} per line.
//   verify --server <url> --day YYYY-MM-DD [--signer hex]
//       fetches the revealed seed and every published run for that day.

import { readFileSync } from 'node:fs';
import { verifyRanked, type VerifyInput } from './verify.ts';

function arg(name: string): string | null {
  const k = process.argv.indexOf(name);
  return k >= 0 ? (process.argv[k + 1] ?? null) : null;
}

function report(items: VerifyInput[], label: (k: number) => string): number {
  let bad = 0;
  items.forEach((it, k) => {
    const out = verifyRanked(it);
    if (!out.ok) { bad++; console.log(`FAIL ${label(k)}: ${out.problems.join('; ')}`) }
    else if (items.length === 1) console.log(`OK ${label(k)}: layers ${out.replayed!.layers}, bank ${out.replayed!.bank}`);
  });
  console.log(`${items.length - bad}/${items.length} runs verified`);
  return bad ? 1 : 0;
}

async function main(): Promise<number> {
  const signer = arg('--signer');
  const batch = arg('--batch');
  const server = arg('--server');
  if (batch) {
    const lines = readFileSync(batch, 'utf8').split('\n').filter((l) => l.trim());
    const items = lines.map((l) => { const j = JSON.parse(l); return { ...j, signer: signer ?? j.signer ?? null } as VerifyInput });
    return report(items, (k) => `line ${k + 1} (run ${items[k]!.attestation?.run ?? '?'})`);
  }
  if (server) {
    const day = arg('--day');
    if (!day) { console.error('--server needs --day'); return 2 }
    const seed = await (await fetch(new URL(`/api/seed/${day}`, server))).json() as { seed?: string; commit?: string; error?: string };
    if (!seed.seed) { console.error('seed not available: ' + (seed.error ?? 'unknown')); return 2 }
    const pub = await (await fetch(new URL(`/api/runs/${day}`, server))).json() as { runs: { run: number; receipt: never; attestation: never }[] };
    // A commit you recorded before the day started is the one that matters; the server's copy is a fallback.
    const commit = arg('--commit') ?? seed.commit ?? null;
    const items = pub.runs.map((r) => ({ receipt: r.receipt, attestation: r.attestation, dailySeed: seed.seed!, commit, signer }));
    return report(items, (k) => `run ${pub.runs[k]!.run}`);
  }
  const [file, dailySeed] = process.argv.slice(2).filter((a, k, all) => !a.startsWith('--') && !(all[k - 1] ?? '').startsWith('--'));
  if (!file || !dailySeed) {
    console.error('usage: verify <run.json> <dailySeed> [--commit 0x..] [--signer hex]\n       verify --batch <runs.jsonl>\n       verify --server <url> --day YYYY-MM-DD');
    return 2;
  }
  const j = JSON.parse(readFileSync(file, 'utf8'));
  const item: VerifyInput = j.receipt ? { receipt: j.receipt, attestation: j.attestation ?? null, dailySeed } : { receipt: j, dailySeed };
  item.commit = arg('--commit');
  item.signer = signer;
  return report([item], () => file);
}

main().then((code) => process.exit(code), (e) => { console.error(e); process.exit(2) });
