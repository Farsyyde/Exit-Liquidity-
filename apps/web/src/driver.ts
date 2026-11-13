import type { Button, PublicEvent, View } from '@exit-liquidity/engine';

/**
 * What the UI talks to. Practice runs the engine in the page (LocalDriver).
 * Ranked streams state from the run server (RemoteDriver). The UI never
 * touches engine state directly, only the public View.
 */
export interface Driver {
  readonly kind: 'attract' | 'practice' | 'ranked';
  /** Latest public view, null until the first state arrives. */
  view: View | null;
  /** Called by the UI every animation frame with elapsed ms. */
  frame(dtMs: number): void;
  go(): void;
  next(): void;
  shop(code: string): void;
  press(b: Button): void;
  /** Receipt JSON text for the finished run. */
  receipt(): Promise<string>;
  close(): void;
  /** Juice: sounds, pops and shakes. */
  onEvents: (ev: PublicEvent[]) => void;
  /** Phase changed or a modal needs to re-render. */
  onChange: () => void;
}
