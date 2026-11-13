// Game data ported verbatim from reference/prototype.html.
// Changing any number here changes game rules and breaks every recorded receipt.

export interface LevelDef {
  tk: string;
  gain: number;
  vol: number;
  fake: number;
  gapMin: number;
  gapVar: number;
  rug?: 1;
  hunter?: 1;
  lore: string;
}

export const LEVELS: readonly LevelDef[] = [
  { tk: '$WAGMI', gain: 0.25, vol: 1.0, fake: 0.12, gapMin: 30, gapVar: 35,
    lore: 'Launched four minutes ago by a dev whose profile picture is a stock photo of a handshake. The roadmap is one PNG of a rocket. Liquidity is thin. Vibes are immaculate.' },
  { tk: '$COPE', gain: 0.40, vol: 1.1, fake: 0.15, gapMin: 30, gapVar: 35,
    lore: 'A token for people who bought the last token. The whitepaper is one sentence: "It is coming back." The Telegram has 9,000 members. 8,994 are bots saying gm.' },
  { tk: '$RUGDAO', gain: 0.55, vol: 1.2, fake: 0.15, rug: 1, gapMin: 30, gapVar: 32,
    lore: 'A decentralized community of carpet enthusiasts. The dev promises the liquidity is locked. He will not say where. He will not say with what.' },
  { tk: '$HOPIUM', gain: 0.75, vol: 1.3, fake: 0.33, gapMin: 28, gapVar: 30,
    lore: 'Endorsed by an influencer who was paid in $HOPIUM to say he was not paid. Every headline is "huge if true." About two in three are true.' },
  { tk: '$GRANDMA', gain: 1.0, vol: 1.4, fake: 0.15, rug: 1, gapMin: 28, gapVar: 30,
    lore: 'Somebody\'s grandmother tweeted the ticker by accident while searching for a casserole recipe. It now has a $40M market cap. She has not been told.' },
  { tk: '$SOURCE', gain: 1.25, vol: 1.5, fake: 0.45, gapMin: 26, gapVar: 28,
    lore: '"Trust me bro" as a financial instrument. Half the news is invented by a guy named Kyle. Kyle is also the top holder.' },
  { tk: '$LASTONE', gain: 1.5, vol: 1.6, fake: 0.2, rug: 1, gapMin: 22, gapVar: 24,
    lore: 'The dev swears this is his last coin. It is his fourth last coin this week. His bags are packed. So is his actual bag.' },
  { tk: '$REAL', gain: 2.0, vol: 1.7, fake: 0.2, hunter: 1, gapMin: 24, gapVar: 26,
    lore: 'The final coin. No dev, no history, and exactly one other trader: the Market Maker. He can see your position. He does not like your position.' },
];

export type EventType = 'pump' | 'dump' | 'dip' | 'spike' | 'rug';

export const HEAD: Readonly<Record<EventType, readonly string[]>> = {
  pump: ['Whale wallet is loading up on {T}', 'Big streamer just said {T} on air', '{T} trending #1, buyers piling in', 'Exchange listing rumor for {T}'],
  dump: ['Dev wallet is moving {T} to an exchange', 'Top holder is unloading {T}', 'Influencer deleted every {T} post', 'Team tokens for {T} just unlocked'],
  dip: ['Fat finger sell on {T}, bids stacked below', 'Leverage flush on {T}, nothing changed', 'Panic seller dumping {T} into thick bids'],
  spike: ['Short squeeze on {T}, no real buyers', 'Bot glitch is spiking {T}, it will fade', 'One guy market bought {T} by mistake'],
  rug: ['WARNING: {T} liquidity lock just expired', 'WARNING: dev is pulling {T} liquidity'],
};

export interface IndicatorDef { id: string; g: string; name: string; cost: number; c?: 1; d: string }
export interface ItemDef { id: string; g: string; name: string; cost: number; d: string }

export const INDS: readonly IndicatorDef[] = [
  { id: 'diamond', g: '◆', name: 'Diamond Hands', cost: 4, d: '+0.05 mult per second you hold a winning trade (max +1.0).' },
  { id: 'paper', g: '≈', name: 'Paper Hands', cost: 3, d: 'Winning trades closed within 3 seconds get +0.5 mult.' },
  { id: 'vwap', g: '~', name: 'Fair Value', cost: 3, d: 'Draws the true value line. Moves away from it snap back.' },
  { id: 'insider', g: '◉', name: 'Insider', cost: 5, d: 'Headlines land twice as early and fake ones get flagged.' },
  { id: 'stop', g: '✖', name: 'Stop Loss', cost: 3, d: 'Auto-closes any trade that drops 12% against you.' },
  { id: 'lev2', g: '×2', name: '2x Lever', cost: 4, d: 'Every trade wins or loses double.' },
  { id: 'lev5', g: '×5', name: '5x Degen', cost: 7, d: 'Every trade wins or loses 5x. A 20% move against you wipes it.' },
  { id: 'short', g: '▼', name: 'Short Seller', cost: 5, d: 'Unlocks SHORT so you profit when the chart falls.' },
  { id: 'mev', g: '☂', name: 'MEV Shield', cost: 3, d: 'Trading fees drop from 0.5% to zero.' },
  { id: 'copium', g: '☁', name: 'Copium Tank', cost: 3, d: 'Your first losing trade each level keeps your streak.' },
  { id: 'sniper', g: '✚', name: 'Dip Sniper', cost: 4, d: 'Buys made 6% under the average price get +0.75 mult.' },
  { id: 'top', g: '▲', name: 'Top Ticker', cost: 4, d: 'Selling within 3% of the level high gives +1.0 mult.' },
  { id: 'time', g: '∞', name: 'Time Dilation', cost: 4, d: '+12 seconds on every level.' },
  { id: 'airdrop', g: '✦', name: 'Airdrop Farmer', cost: 4, d: 'Start every level with a free 8% on your bankroll.' },
  { id: 'compound', g: '★', name: 'Compounder', cost: 5, d: 'Each streak win adds +0.2 mult, up from +0.1.' },
  { id: 'bag', g: '$', name: 'Bag Holder', cost: 5, d: 'Grows +0.1 mult forever each time a trade goes 15% red and still closes green.' },
  { id: 'whale', g: '◎', name: 'Whale Watcher', cost: 5, d: 'Grows +0.15 mult forever each time you buy within 2s of a pump headline and close green.' },
  { id: 'tax', g: '%', name: 'Tax Harvest', cost: 3, d: 'Losing trades pay 1 alpha each, up to 2 per level.' },
  { id: 'martin', g: '±', name: 'Martingale', cost: 4, d: 'After a losing trade, your next win gets double mult.' },
  { id: 'funding', g: '÷', name: 'Funding Rate', cost: 4, d: 'Shorts earn 0.4% per second held. Longs pay 0.2%.' },
  { id: 'devwallet', g: '♛', name: 'Dev Wallet', cost: 6, c: 1, d: 'Trade double your bankroll on loan every level. Targets are 50% harder.' },
  { id: 'sticky', g: '#', name: 'Sticky Note Seed', cost: 5, c: 1, d: '+2 indicator slots. Each level, 10% chance one indicator gets drained.' },
  { id: 'ape', g: '!!', name: 'Ape Mode', cost: 6, c: 1, d: '+2.0 mult on every win. You cannot close a trade for 2 seconds after opening it.' },
];

export const CONS: readonly ItemDef[] = [
  { id: 'inject', g: '+$', name: 'Liquidity Injection', cost: 2, d: 'Borrow 50% of your starting bankroll. It adds to your open trade at the current price, or to cash if flat. Repaid at level end.' },
  { id: 'shill', g: '♪', name: 'Paid Shill', cost: 2, d: 'Trigger a pump on demand, half a second after you tap.' },
  { id: 'fud', g: '!?', name: 'FUD Post', cost: 2, d: 'Trigger a sharp dip that bounces back. Buy your own dip.' },
  { id: 'breaker', g: '■', name: 'Circuit Breaker', cost: 2, d: 'Cancel every move that is pending or in progress, rugs included.' },
  { id: 'reorg', g: '↺', name: 'Reorg', cost: 2, d: 'Undo your last closed trade as if it never happened.' },
];

export const IND: Readonly<Record<string, IndicatorDef>> = Object.fromEntries(INDS.map((x) => [x.id, x]));
export const CON: Readonly<Record<string, ItemDef>> = Object.fromEntries(CONS.map((x) => [x.id, x]));

/** Milliseconds per tick in real time play. */
export const TICK_MS = 100;
/** Ticks per candle. */
export const CANDLE = 4;
/** Base indicator slots. */
export const SLOTS = 5;
/** Item slots. */
export const CSLOTS = 2;
/** Mean reversion strength of the deviation term. */
export const K = 0.03;
/** Warm up ticks run before a level opens, so the chart has history. */
export const WARMUP = 52 * CANDLE;
/** Candles kept in level history. */
export const MAX_CANDLES = 90;
