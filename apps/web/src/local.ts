import { TICK_MS, engine, nativeEngine, type Button, type Engine, type PublicEvent, type RunState, type View, toPublicEvents } from '@exit-liquidity/engine';
import type { Driver } from './driver.ts';

/** Practice mode and the title screen chart: the engine runs right here in the page. */
export class LocalDriver implements Driver {
  readonly kind: 'attract' | 'practice';
  view: View | null = null;
  onEvents: (ev: PublicEvent[]) => void = () => {};
  onChange: () => void = () => {};
  private S: RunState;
  private acc = 0;
  private eng: Engine;
  /** When true, frame() does not advance time. Tests step ticks by hand. */
  manual = false;

  constructor(opts: { seed: number; mint: string | null; attract?: boolean; native?: boolean }) {
    this.eng = opts.native ? nativeEngine : engine;
    this.kind = opts.attract ? 'attract' : 'practice';
    this.S = opts.attract ? this.eng.createAttract(opts.seed) : this.eng.createRun(opts.seed, opts.mint);
    this.view = this.eng.view(this.S);
  }

  frame(dtMs: number): void {
    if (!this.manual) {
      // Same as the prototype: time accrues in every mode, ticks only do work in play.
      this.acc += Math.min(400, dtMs);
      while (this.acc >= TICK_MS) { this.acc -= TICK_MS; this.step() }
    }
    this.view = this.eng.view(this.S);
  }

  /** One tick. Exposed for tests. */
  step(): void {
    const before = this.S.phase;
    const ev = this.eng.tick(this.S);
    if (ev.length) { this.view = this.eng.view(this.S); this.onEvents(toPublicEvents(ev)) }
    if (this.S.phase !== before) this.changed();
  }

  get phase() { return this.S.phase }
  get tickNow() { return this.S.m.t - this.S.lv.t0 }

  private apply(code: string | null): void {
    if (code == null) return;
    const before = this.S.phase;
    const r = this.eng.applyInput(this.S, code);
    this.view = this.eng.view(this.S);
    if (r.events.length) this.onEvents(toPublicEvents(r.events));
    if (this.S.phase !== before || before !== 'play') this.onChange();
  }

  private changed(): void { this.view = this.eng.view(this.S); this.onChange() }

  go(): void { this.apply('go') }
  next(): void { this.apply('next') }
  shop(code: string): void { this.apply(code) }
  press(b: Button): void { this.apply(this.eng.pressCode(this.S, b)) }
  async receipt(): Promise<string> { return JSON.stringify(this.eng.receipt(this.S)) }
  close(): void {}
}
