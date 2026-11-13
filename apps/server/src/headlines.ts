// Reads a headline's text back into its event type, for our scripted bots.
// The stream carries no type field, but the headline table ships with the
// client, so any bot can do this. Stripping the field is hygiene, not a
// defense against bots (see BUILD_SPEC section 8).

import { HEAD, type EventType } from '@exit-liquidity/engine';

const PATTERNS: [RegExp, EventType][] = [];
for (const [type, list] of Object.entries(HEAD) as [EventType, readonly string[]][]) {
  for (const t of list) {
    const [a, b] = t.split('{T}').map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    PATTERNS.push([new RegExp('^' + a + '\\$[A-Z]+' + b + '$'), type]);
  }
}

export function headlineType(text: string): EventType | null {
  for (const [re, type] of PATTERNS) if (re.test(text)) return type;
  return null;
}
