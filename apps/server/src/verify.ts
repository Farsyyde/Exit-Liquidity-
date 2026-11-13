// Independent verification of ranked results. Needs nothing from the server
// except the published receipt, attestation and the revealed daily seed.

import {
  engine, FIXED_MATH_ID, attestationMessage, canonicalReceipt,
  type Attestation, type RankedReceipt, type RunResult,
} from '@exit-liquidity/engine';
import { commitOf, keccakHex, parseSeedHex, runSeedOf, RANKED_RNG } from './seeds.ts';
import { verifySig } from './sign.ts';

export interface VerifyInput {
  receipt: RankedReceipt;
  attestation?: Attestation | null;
  dailySeed: string;
  /** If given, keccak256(dailySeed) must equal it. */
  commit?: string | null;
  /** If given, the attestation must be signed by this key. */
  signer?: string | null;
}

export interface VerifyOutcome { ok: boolean; problems: string[]; replayed: RunResult | null }

const sameResult = (a: RunResult, b: RunResult) => a.layers === b.layers && a.bank === b.bank;

export function verifyRanked(x: VerifyInput): VerifyOutcome {
  const problems: string[] = [];
  const r = x.receipt;
  if (!r || r.game !== 'exit-liquidity' || r.v !== 3) return { ok: false, problems: ['not an exit-liquidity v3 receipt'], replayed: null };
  if (!r.ranked) return { ok: false, problems: ['not a ranked receipt'], replayed: null };
  if (r.rng !== RANKED_RNG) problems.push(`ranked receipts must use ${RANKED_RNG}, got ${String(r.rng)}`);
  if (r.math !== FIXED_MATH_ID) problems.push(`ranked receipts must use ${FIXED_MATH_ID} math, got ${r.math ?? 'native'}`);

  let seedBytes: Uint8Array | null = null;
  try { seedBytes = parseSeedHex(x.dailySeed) } catch (e) { problems.push(String((e as Error).message)) }
  if (seedBytes) {
    if (x.commit && commitOf(seedBytes).toLowerCase() !== x.commit.toLowerCase()) problems.push('daily seed does not match the commit');
    const want = runSeedOf(seedBytes, r.ranked.player, r.ranked.attempt);
    if (want !== r.seed) problems.push(`run seed ${String(r.seed)} is not derived from the daily seed (expected ${want})`);
  }

  const out = engine.replay(r);
  if (!out.ok) problems.push('replay failed: ' + out.error);
  else if (!sameResult(out.result!, r.result)) problems.push(`replay gives ${JSON.stringify(out.result)}, receipt claims ${JSON.stringify(r.result)}`);

  const a = x.attestation;
  if (a) {
    const hash = keccakHex(canonicalReceipt(r));
    if (a.receiptHash !== hash) problems.push('attestation receipt hash does not match the receipt');
    if (a.day !== r.ranked.day || a.player !== r.ranked.player || a.attempt !== r.ranked.attempt) problems.push('attestation identity does not match the receipt');
    if (!sameResult(a.result, r.result)) problems.push('attestation result does not match the receipt');
    if (out.ok && !sameResult(a.result, out.result!)) problems.push('attestation result does not match the replay');
    if (x.signer && a.signer.toLowerCase() !== x.signer.toLowerCase()) problems.push('attestation signed by an unexpected key');
    const { sig, signer, ...body } = a;
    if (!verifySig(signer, attestationMessage(body), sig)) problems.push('attestation signature is invalid');
  }
  return { ok: problems.length === 0, problems, replayed: out.ok ? out.result : null };
}
