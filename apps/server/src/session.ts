// One ranked run held by the server. The engine state never leaves this object
// except as the public View. Inputs are applied the moment they arrive, so the
// tick the engine logs them at is the tick the server stamped them with.
//
// A run is not tied to a connection. A client attaches, may drop, and may
// attach again: the run keeps going on the server the whole time and the
// clock never pauses for anyone. Reattaching sends a full snapshot.

import {
  engine, attestationMessage, toPublicEvents, canonicalReceipt, IND,
  type Attestation, type Button, type EngineEvent, type RankedReceipt, type RunState, type ServerMsg, type LiteState,
} from '@exit-liquidity/engine';
import { performance } from 'node:perf_hooks';
import { keccakHex, RANKED_RNG } from './seeds.ts';


export interface SessionInfo { run: number; player: number; day: string; attempt: number; seed: string; mint: string | null }

export type Sender = (m: ServerMsg) => void;

export interface SessionHooks {
  finish(s: RunSession, receipt: RankedReceipt, attestation: Attestation): void;
  sign(msg: string): string;
  signer: string;
}

const BUTTONS: readonly Button[] = ['buy', 'sell', 'lock', 'item0', 'item1'];
const SHOP_CODE = /^(buy|sell):[a-z0-9]{1,16}$|^reroll$/;

export class RunSession {
  readonly S: RunState;
  done = false;
  ended: { receipt: RankedReceipt; attestation: Attestation } | null = null;
  private timer: NodeJS.Timeout | null = null;
  private immediate: NodeJS.Immediate | null = null;
  private nextAt = 0;
  private sender: Sender | null = null;
  private lite = false;
  private idleTimer: NodeJS.Timeout | null = null;

  constructor(
    readonly info: SessionInfo,
    private hooks: SessionHooks,
    private opts: { tickMs: number; idleMs: number },
  ) {
    this.S = engine.createRun(info.seed, info.mint, RANKED_RNG);
    this.armIdle();
  }

  get attached(): boolean { return this.sender !== null }

  /** Connects a client. It gets a full snapshot now (and the result, if the run already ended), then live updates. */
  attach(send: Sender, lite: boolean): void {
    this.sender = send;
    this.lite = lite;
    this.snap([]);
    if (this.ended) send({ t: 'end', run: this.info.run, receipt: this.ended.receipt, attestation: this.ended.attestation });
  }

  /** The client went away. Nothing else changes: the clock keeps running and the run plays on. */
  detach(): void { this.sender = null }

  private send(m: ServerMsg): void { if (this.sender) this.sender(m) }

  // ---------- client messages ----------

  go(): void { this.input('go') }
  next(): void { this.input('next') }
  shop(code: unknown): void { if (typeof code === 'string' && SHOP_CODE.test(code) && this.S.phase === 'shop') this.input(code) }
  press(b: unknown): void {
    if (!BUTTONS.includes(b as Button) || this.S.phase !== 'play') return;
    const code = engine.pressCode(this.S, b as Button);
    if (code) this.input(code);
  }

  private input(code: string): void {
    if (this.done) return;
    const before = this.S.phase;
    const r = engine.applyInput(this.S, code);
    if (!r.ok && !r.events.length) return;
    this.afterChange(before, r.events, true);
  }

  // ---------- time ----------

  private afterChange(before: RunState['phase'], ev: EngineEvent[], forceSnap: boolean): void {
    if (this.S.phase === 'end') { this.snap(ev); this.end(); return }
    if (forceSnap || this.S.phase !== before) this.snap(ev);
    if (this.S.phase === 'play' && before !== 'play') this.startClock();
    if (this.S.phase !== 'play') { this.stopClock(); this.armIdle() } else this.disarmIdle();
  }

  private startClock(): void {
    this.stopClock();
    if (this.opts.tickMs <= 0) { this.immediate = setImmediate(() => this.fastLoop()); return }
    this.nextAt = performance.now() + this.opts.tickMs;
    this.timer = setTimeout(() => this.clockLoop(), this.opts.tickMs);
  }
  private stopClock(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    if (this.immediate) { clearImmediate(this.immediate); this.immediate = null }
  }
  private clockLoop(): void {
    this.timer = null;
    const now = performance.now();
    // Same catch up limit as the prototype's frame loop: at most 4 ticks per wake.
    let n = 0;
    while (now >= this.nextAt && n < 4 && this.S.phase === 'play' && !this.done) { this.step(); this.nextAt += this.opts.tickMs; n++ }
    if (now >= this.nextAt) this.nextAt = now + this.opts.tickMs;
    if (this.S.phase === 'play' && !this.done) this.timer = setTimeout(() => this.clockLoop(), Math.max(0, this.nextAt - performance.now()));
  }
  private fastLoop(): void {
    this.immediate = null;
    if (this.S.phase !== 'play' || this.done) return;
    this.step();
    if (this.S.phase === 'play' && !this.done) this.immediate = setImmediate(() => this.fastLoop());
  }

  /** One tick. Public for tests and for finishing abandoned runs. */
  step(): void {
    const before = this.S.phase;
    const ev = engine.tick(this.S);
    if (this.sender) this.sendTick(ev);
    if (this.S.phase !== before) this.afterChange(before, ev, false);
  }

  private sendTick(ev: EngineEvent[]): void {
    const S = this.S, k = S.m.t - S.lv.t0;
    if (this.lite) {
      const L = S.lv;
      const s: LiteState = {
        phase: S.phase, i: S.i, equity: engine.equity(S), target: L.target,
        pos: L.pos ? { dir: L.pos.dir, entry: L.pos.entry, lev: L.pos.lev, ret: Math.max(0, L.pos.margin * (1 + L.pos.lev * L.pos.dir * (S.m.p / L.pos.entry - 1))) / L.pos.margin - 1, locked: false } : null,
        ready: S.phase === 'play' && !L.pos && L.cash - L.debt >= L.target, left: Math.max(0, L.dur - (S.m.t - L.t0)),
      };
      this.send({ t: 'tick', k, p: S.m.p, s, ev: toPublicEvents(ev) });
      return;
    }
    const { candles, cur, ...v } = engine.view(S);
    const closed = !cur;
    const c = closed ? candles[candles.length - 1]! : cur;
    this.send({ t: 'tick', k, v, c, closed, ev: toPublicEvents(ev) });
  }

  private snap(ev: EngineEvent[]): void { if (this.sender) this.send({ t: 'snap', v: engine.view(this.S), ev: toPublicEvents(ev) }) }

  // ---------- idle and disconnects ----------

  private armIdle(): void {
    this.disarmIdle();
    if (this.done || this.opts.idleMs <= 0) return;
    this.idleTimer = setTimeout(() => this.finishUnattended(), this.opts.idleMs);
  }
  private disarmIdle(): void { if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null } }

  /**
   * Nobody pressed anything on an intro or shop screen for idleMs (connected
   * or not), or the server is shutting down. The run is not thrown away (that
   * would let players peek at a chart and retry): it plays out with no further
   * input, leaving the shop untouched, and the result counts.
   */
  finishUnattended(): void {
    this.stopClock();
    this.disarmIdle();
    let guard = 0;
    while (!this.done && this.S.phase !== 'end' && guard++ < 100000) {
      if (this.S.phase === 'intro') engine.applyInput(this.S, 'go');
      else if (this.S.phase === 'shop') engine.applyInput(this.S, 'next');
      else engine.tick(this.S);
    }
    this.end();
  }


  // ---------- end ----------

  private end(): void {
    if (this.done) return;
    this.done = true;
    this.stopClock();
    this.disarmIdle();
    const base = engine.receipt(this.S);
    const receipt: RankedReceipt = { ...base, ranked: { day: this.info.day, player: this.info.player, attempt: this.info.attempt } };
    const receiptHash = keccakHex(canonicalReceipt(receipt));
    const body = { run: this.info.run, day: this.info.day, player: this.info.player, attempt: this.info.attempt, receiptHash, result: receipt.result };
    const attestation: Attestation = { ...body, signer: this.hooks.signer, sig: this.hooks.sign(attestationMessage(body)) };
    this.ended = { receipt, attestation };
    this.hooks.finish(this, receipt, attestation);
    this.send({ t: 'end', run: this.info.run, receipt, attestation });
  }

  /** Indicators the player held when the run ended; only these can be minted (spec section 6). */
  mintable(): string[] { return this.done ? this.S.inds.filter((id) => !!IND[id]) : [] }
}
