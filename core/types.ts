// one ohlcv bar in numeric form, the common currency of every indicator
export interface Candle {
  t: number; // open time ms
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

// direction of a perp position
export type Side = "long" | "short";

// simulated open position used by the backtester
export interface Position {
  coin: string;
  side: Side;
  size: number; // base units, always positive
  entryPx: number;
  stopPx: number;
  takePx: number;
  initialStopPx: number;
  leverage: number;
  openedAt: number;
  reason: string;
}

// closed round trip with r-multiple so results are comparable across account sizes
export interface TradeRecord {
  id: string;
  coin: string;
  side: Side;
  size: number;
  entryPx: number;
  exitPx: number;
  pnl: number; // net of fees
  fees: number;
  rMultiple: number;
  openedAt: number;
  closedAt: number;
  entryReason: string;
  exitReason: string;
}

// market state classification that decides which sub-model is allowed to trade
export type Regime = "trend" | "range" | "chop";

// one explainable input to the score, surfaced in the dashboard tooltip
export interface SignalFactor {
  name: string;
  value: number; // normalised -1..1 (positive = bullish)
  weight: number;
}

// model output for one coin at one bar
export interface Signal {
  coin: string;
  time: number;
  price: number;
  score: number; // -1..1
  action: "long" | "short" | "flat";
  regime: Regime;
  atr: number;
  factors: SignalFactor[];
  reason: string;
}

// live-only inputs that historical candles cannot provide
export interface MarketExtras {
  bookImbalance?: number; // -1..1, (bid-ask)/(bid+ask) depth
  funding?: number; // hourly funding rate
}
