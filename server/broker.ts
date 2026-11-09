import type { Side, TradeRecord } from "../core/types";

// normalised position row so paper and live render identically
export interface PositionView {
  coin: string;
  side: Side;
  size: number;
  entryPx: number;
  markPx: number;
  unrealizedPnl: number;
  leverage: number;
  liquidationPx: number | null;
  stopPx: number | null;
  takePx: number | null;
}

// normalised open order row, including trigger orders
export interface OrderView {
  oid: number;
  coin: string;
  side: Side; // long = buy
  type: string;
  px: number;
  size: number;
  reduceOnly: boolean;
  time: number;
}

// normalised execution row so fee drag is visible in both modes
export interface FillView {
  time: number;
  coin: string;
  side: Side;
  px: number;
  size: number;
  fee: number;
  closedPnl: number;
  dir: string;
}

// full account picture consumed by the bot and the dashboard
export interface AccountSnapshot {
  mode: "paper" | "live";
  address: string | null;
  equity: number;
  available: number;
  marginUsed: number;
  positions: PositionView[];
  orders: OrderView[];
  fills: FillView[];
}

// order intent shared by manual tickets and the bot
export interface OpenRequest {
  coin: string;
  side: Side;
  size: number;
  leverage: number;
  stopPx?: number;
  takePx?: number;
  limitPx?: number; // omit for market
  reduceOnly?: boolean;
  reason?: string;
}

// execution seam so the identical bot logic runs on paper and on real funds
export interface Broker {
  readonly mode: "paper" | "live";
  snapshot(): Promise<AccountSnapshot>;
  onPrices(prices: Record<string, number>): void;
  open(req: OpenRequest): Promise<{ filledSize: number; avgPx: number; status: string }>;
  close(coin: string, reason: string): Promise<void>;
  setStop(coin: string, stopPx: number): Promise<void>;
  cancel(coin: string, oid: number): Promise<void>;
  closedTrades(): TradeRecord[];
}
