// Ranked WebSocket protocol (M1). Types only. The server is authoritative:
// the client never sees the seed before the run ends and never computes prices.

import type { Button, Candle, PublicEvent, Receipt, RunResult, View } from './engine.ts';

export const PROTOCOL_VERSION = 1;

/** View without chart history. Sent every tick. */
export type LightView = Omit<View, 'candles' | 'cur'>;

/** Minimal per tick state for scripted clients that do not render. */
export interface LiteState {
  phase: View['phase'];
  i: number;
  equity: number;
  target: number;
  pos: View['pos'];
  ready: boolean;
  left: number;
}

export type ClientMsg =
  /** resume: only reattach to a run in progress (or just finished); never start a new attempt. */
  | { t: 'hello'; v: number; name: string; token?: string; lite?: boolean; resume?: boolean;
      /** Bind this run to a pass: a signed /api/pass-challenge message. Optional; ranked is free without one. */
      pass?: { id: string; message: string; signature: string } }
  | { t: 'go' }
  | { t: 'next' }
  | { t: 'shop'; code: string }
  | { t: 'press'; b: Button }
  | { t: 'mint'; id: string };

export type ServerMsg =
  | { t: 'welcome'; name: string; player: number; token: string; day: string; attempt: number; attemptsLeft: number; commit: string; mint: string | null; resumed: boolean; pass?: { id: string; attempt: number } | null }
  /** For a run bound to a pass, after `end`: what the pass owner submits to RunRegistry.settle. */
  | ({ t: 'settlement'; run: number } & Settlement)
  /** Full view. Sent on phase changes and after every accepted input. */
  | { t: 'snap'; v: View; ev: PublicEvent[] }
  /** One tick. c is the candle that changed; closed means it just completed. */
  | { t: 'tick'; k: number; v: LightView; c: Candle; closed: boolean; ev: PublicEvent[] }
  | { t: 'tick'; k: number; p: number; s: LiteState; ev: PublicEvent[] }
  | { t: 'end'; run: number; receipt: RankedReceipt; attestation: Attestation }
  | { t: 'minted'; id: string; runs: number }
  | { t: 'error'; code: string; msg: string };

export interface RankedInfo { day: string; player: number; attempt: number }

/** An EIP-712 RunResult signed by the run server. Integers that can pass 2^53 travel as strings. */
export interface Settlement {
  chainId: number;
  registry: `0x${string}`;
  result: { passId: string; day: number; attempt: number; receiptHash: `0x${string}`; layers: number; bankCents: string };
  signature: `0x${string}`;
}

/** A ranked receipt is a plain receipt plus who, when and which attempt. */
export interface RankedReceipt extends Receipt { ranked: RankedInfo }

/** What the server signs at the end of a ranked run. */
export interface Attestation {
  run: number;
  day: string;
  player: number;
  attempt: number;
  receiptHash: string;
  result: RunResult;
  /** ed25519 public key (hex) of the signer, and signature (hex) over attestationMessage(). */
  signer: string;
  sig: string;
}

/** Canonical bytes signed by the server. Field order is fixed. */
export function attestationMessage(a: Omit<Attestation, 'sig' | 'signer'>): string {
  return JSON.stringify(['exit-liquidity/run/1', a.run, a.day, a.player, a.attempt, a.receiptHash, a.result.layers, a.result.bank]);
}

/** Canonical JSON for hashing a receipt. Field order is fixed. */
export function canonicalReceipt(r: RankedReceipt): string {
  return JSON.stringify({
    game: r.game, v: r.v, rng: r.rng, seed: r.seed, mint: r.mint, log: r.log, result: r.result, math: r.math,
    ranked: { day: r.ranked.day, player: r.ranked.player, attempt: r.ranked.attempt },
  });
}
