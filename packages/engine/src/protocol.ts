// Ranked WebSocket protocol (M1). Types only. The server is authoritative:
// the client never sees the seed before the run ends and never computes prices.

import type { Button, Candle, EngineEvent, Receipt, RunResult, View } from './engine.ts';

export const PROTOCOL_VERSION = 1;

/** View without chart history. Sent every tick. */
export type LightView = Omit<View, 'candles' | 'cur'>;

/** Minimal per tick state for scripted clients that do not render. */
export interface LiteState {
  phase: View['phase'];
  i: number;
  cash: number;
  debt: number;
  equity: number;
  target: number;
  pos: View['pos'];
  ready: boolean;
  left: number;
}

export type ClientMsg =
  | { t: 'hello'; v: number; name: string; token?: string; lite?: boolean }
  | { t: 'go' }
  | { t: 'next' }
  | { t: 'shop'; code: string }
  | { t: 'press'; b: Button }
  | { t: 'mint'; id: string };

export type ServerMsg =
  | { t: 'welcome'; name: string; player: number; token: string; day: string; attempt: number; attemptsLeft: number; commit: string; mint: string | null }
  /** Full view. Sent on phase changes and after every accepted input. */
  | { t: 'snap'; v: View; ev: EngineEvent[] }
  /** One tick. c is the candle that changed; closed means it just completed. */
  | { t: 'tick'; k: number; v: LightView; c: Candle; closed: boolean; ev: EngineEvent[] }
  | { t: 'tick'; k: number; p: number; s: LiteState; ev: EngineEvent[] }
  | { t: 'end'; run: number; receipt: RankedReceipt; attestation: Attestation }
  | { t: 'minted'; id: string; runs: number }
  | { t: 'error'; code: string; msg: string };

export interface RankedInfo { day: string; player: number; attempt: number }

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
    game: r.game, v: r.v, seed: r.seed, mint: r.mint, log: r.log, result: r.result, math: r.math,
    ranked: { day: r.ranked.day, player: r.ranked.player, attempt: r.ranked.attempt },
  });
}
