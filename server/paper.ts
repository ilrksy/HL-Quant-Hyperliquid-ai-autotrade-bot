import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Side, TradeRecord } from "../core/types";
import type { AccountSnapshot, Broker, FillView, OpenRequest, OrderView } from "./broker";

// simulated position with the bot-managed stop and target attached
interface PaperPos {
  coin: string; side: Side; size: number; entryPx: number; leverage: number; stopPx: number | null;
  takePx: number | null; initialStopPx: number | null; openedAt: number; reason: string;
}
// whole simulated account, persisted so paper results survive restarts
interface PaperState {
  cash: number; positions: PaperPos[]; orders: (OrderView & { leverage: number })[];
  fills: FillView[]; trades: TradeRecord[]; nextOid: number;
}

// hyperliquid base-tier taker fee
const TAKER = 0.00045;
// hyperliquid base-tier maker fee
const MAKER = 0.00015;
// assumed adverse slippage per market fill so paper is not rosier than live
const SLIP = 0.0003;

// simulated exchange using hyperliquid base-tier fees and cross-margin accounting
export class PaperBroker implements Broker {
  readonly mode = "paper" as const;
  private s: PaperState;
  private px: Record<string, number> = {};

  // an empty file path disables persistence, used by tests
  constructor(startEquity: number, private file = "data/paper.json") {
    this.s = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : PaperBroker.fresh(startEquity);
  }

  // blank account with the given cash
  private static fresh(cash: number): PaperState {
    return { cash, positions: [], orders: [], fills: [], trades: [], nextOid: 1 };
  }

  // dashboard action to restart paper trading from a chosen balance
  reset(equity: number) {
    this.s = PaperBroker.fresh(equity);
    this.save();
  }

  // writes state after every mutation
  private save() {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.s));
  }

  // latest price, falling back to entry before the first tick arrives
  private mark(coin: string, fallback: number) {
    return this.px[coin] ?? fallback;
  }

  // open profit or loss of one position at the current mark
  private upnl(p: PaperPos) {
    return (this.mark(p.coin, p.entryPx) - p.entryPx) * p.size * (p.side === "long" ? 1 : -1);
  }

  // cash plus unrealised pnl, the figure all risk limits use
  private equity() {
    return this.s.cash + this.s.positions.reduce((a, p) => a + this.upnl(p), 0);
  }

  // initial margin locked by open positions
  private marginUsed() {
    return this.s.positions.reduce((a, p) => a + (this.mark(p.coin, p.entryPx) * p.size) / p.leverage, 0);
  }

  // one-way netting fill engine shared by market, limit, stop and liquidation paths
  private fill(coin: string, side: Side, size: number, px: number, feeRate: number, leverage: number,
    reduceOnly: boolean, why: string) {
    const fee = px * size * feeRate;
    const existing = this.s.positions.find((p) => p.coin === coin);
    let closedPnl = 0;
    let remaining = size;
    if (existing && existing.side !== side) {
      const qty = Math.min(existing.size, remaining);
      const dir = existing.side === "long" ? 1 : -1;
      closedPnl = (px - existing.entryPx) * qty * dir;
      existing.size -= qty;
      remaining -= qty;
      const riskDist = existing.initialStopPx ? Math.abs(existing.entryPx - existing.initialStopPx) * qty : 0;
      const fees = fee + existing.entryPx * qty * TAKER;
      const net = closedPnl - fees;
      this.s.trades.unshift({
        id: `p${Date.now()}${Math.random().toString(36).slice(2, 6)}`, coin, side: existing.side, size: qty,
        entryPx: existing.entryPx, exitPx: px, pnl: net, fees, rMultiple: riskDist > 0 ? net / riskDist : 0,
        openedAt: existing.openedAt, closedAt: Date.now(), entryReason: existing.reason, exitReason: why,
      });
      this.s.trades = this.s.trades.slice(0, 500);
      if (existing.size <= 1e-12) {
        this.s.positions = this.s.positions.filter((p) => p !== existing);
        this.s.orders = this.s.orders.filter((o) => o.coin !== coin || !o.reduceOnly);
      }
    }
    if (remaining > 1e-12 && !reduceOnly) {
      const same = this.s.positions.find((p) => p.coin === coin && p.side === side);
      if (same) {
        same.entryPx = (same.entryPx * same.size + px * remaining) / (same.size + remaining);
        same.size += remaining;
      } else {
        this.s.positions.push({ coin, side, size: remaining, entryPx: px, leverage, stopPx: null, takePx: null,
          initialStopPx: null, openedAt: Date.now(), reason: why });
      }
    }
    this.s.cash += closedPnl - fee;
    const dir = closedPnl !== 0 || (existing && existing.side !== side)
      ? side === "long" ? "Close Short" : "Close Long"
      : side === "long" ? "Open Long" : "Open Short";
    this.s.fills.unshift({ time: Date.now(), coin, side, px, size, fee, closedPnl, dir });
    this.s.fills = this.s.fills.slice(0, 300);
  }

  // matches stops, targets, resting limits and liquidations against fresh mids
  onPrices(prices: Record<string, number>) {
    this.px = { ...this.px, ...prices };
    let changed = false;
    for (const p of [...this.s.positions]) {
      const m = this.px[p.coin];
      if (!m) continue;
      const long = p.side === "long";
      const exit: Side = long ? "short" : "long";
      if (p.stopPx && (long ? m <= p.stopPx : m >= p.stopPx)) {
        this.fill(p.coin, exit, p.size, m * (long ? 1 - SLIP : 1 + SLIP), TAKER, p.leverage, true, "stop");
        changed = true;
      } else if (p.takePx && (long ? m >= p.takePx : m <= p.takePx)) {
        this.fill(p.coin, exit, p.size, p.takePx, TAKER, p.leverage, true, "take-profit");
        changed = true;
      }
    }
    for (const o of [...this.s.orders]) {
      const m = this.px[o.coin];
      if (!m || !(o.side === "long" ? m <= o.px : m >= o.px)) continue;
      this.s.orders = this.s.orders.filter((x) => x !== o);
      this.fill(o.coin, o.side, o.size, o.px, MAKER, o.leverage, o.reduceOnly, "limit");
      changed = true;
    }
    // Approximate maintenance margin as half of initial margin.
    if (this.s.positions.length && this.equity() <= this.marginUsed() * 0.5) {
      for (const p of [...this.s.positions]) {
        this.fill(p.coin, p.side === "long" ? "short" : "long", p.size, this.mark(p.coin, p.entryPx), TAKER,
          p.leverage, true, "liquidation");
      }
      changed = true;
    }
    if (changed) this.save();
  }

  // same shape as the live snapshot so the dashboard cannot tell them apart
  async snapshot(): Promise<AccountSnapshot> {
    const equity = this.equity();
    const used = this.marginUsed();
    return {
      mode: "paper", address: null, equity, available: Math.max(0, equity - used), marginUsed: used,
      positions: this.s.positions.map((p) => {
        const dir = p.side === "long" ? 1 : -1;
        return {
          coin: p.coin, side: p.side, size: p.size, entryPx: p.entryPx, markPx: this.mark(p.coin, p.entryPx),
          unrealizedPnl: this.upnl(p), leverage: p.leverage, liquidationPx: p.entryPx * (1 - dir / (p.leverage * 2)),
          stopPx: p.stopPx, takePx: p.takePx,
        };
      }),
      orders: this.s.orders.map(({ leverage: _l, ...o }) => o),
      fills: this.s.fills.slice(0, 100),
    };
  }

  // margin-checked entry that rests limits and fills market orders with slippage
  async open(req: OpenRequest) {
    const mark = this.px[req.coin];
    if (!mark) throw new Error(`no price for ${req.coin}`);
    if (!(req.size > 0)) throw new Error("size must be > 0");
    const notional = req.size * (req.limitPx ?? mark);
    if (!req.reduceOnly && notional / req.leverage > this.equity() - this.marginUsed())
      throw new Error(`insufficient margin: need $${(notional / req.leverage).toFixed(2)}`);
    if (req.limitPx) {
      this.s.orders.push({ oid: this.s.nextOid++, coin: req.coin, side: req.side, type: "Limit", px: req.limitPx,
        size: req.size, reduceOnly: !!req.reduceOnly, time: Date.now(), leverage: req.leverage });
      this.save();
      return { filledSize: 0, avgPx: 0, status: "resting" };
    }
    const px = mark * (req.side === "long" ? 1 + SLIP : 1 - SLIP);
    this.fill(req.coin, req.side, req.size, px, TAKER, req.leverage, !!req.reduceOnly, req.reason ?? "manual");
    const p = this.s.positions.find((x) => x.coin === req.coin && x.side === req.side);
    if (p && !req.reduceOnly) {
      if (req.stopPx) { p.stopPx = req.stopPx; p.initialStopPx = req.stopPx; }
      if (req.takePx) p.takePx = req.takePx;
    }
    this.save();
    return { filledSize: req.size, avgPx: px, status: "filled" };
  }

  // market flatten used by manual close, reversals and the kill switch
  async close(coin: string, reason: string) {
    const p = this.s.positions.find((x) => x.coin === coin);
    if (!p) return;
    const m = this.mark(coin, p.entryPx);
    this.fill(coin, p.side === "long" ? "short" : "long", p.size, m * (p.side === "long" ? 1 - SLIP : 1 + SLIP),
      TAKER, p.leverage, true, reason);
    this.save();
  }

  // trailing stop updates from the bot
  async setStop(coin: string, stopPx: number) {
    const p = this.s.positions.find((x) => x.coin === coin);
    if (p) { p.stopPx = stopPx; this.save(); }
  }

  // removes a resting limit order
  async cancel(_coin: string, oid: number) {
    this.s.orders = this.s.orders.filter((o) => o.oid !== oid);
    this.save();
  }

  // round-trip journal for the bot trades tab
  closedTrades() {
    return this.s.trades;
  }
}
