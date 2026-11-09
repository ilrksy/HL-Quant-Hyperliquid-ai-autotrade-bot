import type { Candle, Position, TradeRecord } from "./types";
import { evaluate, MIN_BARS, resample, type StrategyParams, defaultStrategyParams } from "./strategy";
import { defaultRiskParams, riskGate, sizePosition, trailStop, type RiskParams } from "./risk";

// summary statistics shown in the backtest tab and the cli
export interface BacktestResult {
  coin: string;
  startEquity: number;
  endEquity: number;
  returnPct: number;
  trades: TradeRecord[];
  winRate: number;
  profitFactor: number;
  maxDrawdownPct: number;
  avgR: number;
  sharpe: number;
  equityCurve: { t: number; equity: number }[];
  bars: number;
}

// pessimistic bar-by-bar replay of the live strategy so its edge, or lack of one, is measured before real money
export function backtest(
  coin: string,
  candles: Candle[],
  opts: { equity?: number; coinMaxLeverage?: number; slippage?: number; htfMs?: number;
    strategy?: StrategyParams; risk?: RiskParams; evaluator?: typeof evaluate } = {},
): BacktestResult {
  const r = opts.risk ?? defaultRiskParams;
  const sp = opts.strategy ?? defaultStrategyParams;
  const evalFn = opts.evaluator ?? evaluate;
  const slip = opts.slippage ?? 0.0003;
  const htfMs = opts.htfMs ?? 3_600_000;
  const start = opts.equity ?? 10;
  let equity = start;
  let peak = start;
  let dayStart = start;
  let day = -1;
  let pos: Position | null = null;
  let cooldownUntil = 0;
  const trades: TradeRecord[] = [];
  const curve: { t: number; equity: number }[] = [];
  const htfAll = resample(candles, htfMs);
  let htfIdx = 0;

  const close = (exitPx: number, t: number, why: string) => {
    if (!pos) return;
    const dir = pos.side === "long" ? 1 : -1;
    const fees = (pos.entryPx + exitPx) * pos.size * r.takerFee;
    const pnl = (exitPx - pos.entryPx) * dir * pos.size - fees;
    equity += pnl;
    const riskDist = Math.abs(pos.entryPx - pos.initialStopPx) * pos.size;
    trades.push({
      id: `${coin}-${trades.length}`, coin, side: pos.side, size: pos.size, entryPx: pos.entryPx, exitPx,
      pnl, fees, rMultiple: riskDist > 0 ? pnl / riskDist : 0, openedAt: pos.openedAt, closedAt: t,
      entryReason: pos.reason, exitReason: why,
    });
    if (pnl < 0) cooldownUntil = t + r.cooldownMin * 60_000;
    pos = null;
  };

  for (let i = MIN_BARS; i < candles.length - 1; i++) {
    const bar = candles[i];
    const d = Math.floor(bar.t / 86_400_000);
    if (d !== day) { day = d; dayStart = equity; }

    if (pos) {
      const isLong = pos.side === "long";
      const hitStop = isLong ? bar.l <= pos.stopPx : bar.h >= pos.stopPx;
      const hitTake = isLong ? bar.h >= pos.takePx : bar.l <= pos.takePx;
      if (hitStop) close(pos.stopPx * (isLong ? 1 - slip : 1 + slip), bar.t, "stop");
      else if (hitTake) close(pos.takePx, bar.t, "take-profit");
    }

    while (htfIdx < htfAll.length && htfAll[htfIdx].t + htfMs <= bar.t + 1) htfIdx++;
    const window = candles.slice(Math.max(0, i - 400), i + 1);
    const htf = htfAll.slice(Math.max(0, htfIdx - 200), htfIdx);
    const sig = evalFn(coin, window, htf, {}, sp);

    if (pos) {
      pos.stopPx = trailStop(pos.side, pos.entryPx, pos.initialStopPx, pos.stopPx, bar.c, sig.atr || 0, r);
      const opposite = (pos.side === "long" && sig.action === "short") || (pos.side === "short" && sig.action === "long");
      if (opposite) close(candles[i + 1].o, candles[i + 1].t, "signal reversal");
    } else if (sig.action !== "flat" && bar.t >= cooldownUntil) {
      const gate = riskGate({ equity, peakEquity: peak, dayStartEquity: dayStart, openPositions: 0 }, r);
      if (gate.ok) {
        const next = candles[i + 1];
        const px = next.o * (sig.action === "long" ? 1 + slip : 1 - slip);
        const s = sizePosition(equity, px, sig.atr, sig.action, opts.coinMaxLeverage ?? 20, r);
        if (s.ok) {
          pos = { coin, side: sig.action, size: s.size, entryPx: px, stopPx: s.stopPx, takePx: s.takePx,
            initialStopPx: s.stopPx, leverage: s.leverage, openedAt: next.t, reason: sig.reason };
        }
      }
    }
    peak = Math.max(peak, equity);
    curve.push({ t: bar.t, equity });
    if (equity <= 0) break;
  }
  const lastBar = candles[candles.length - 1];
  if (pos && lastBar) close(lastBar.c, lastBar.t, "end of data");

  const wins = trades.filter((t) => t.pnl > 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = -trades.filter((t) => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0);
  let pk = start;
  let mdd = 0;
  for (const p of curve) { pk = Math.max(pk, p.equity); mdd = Math.max(mdd, (pk - p.equity) / pk); }
  const rets = trades.map((t) => t.rMultiple);
  const mean = rets.reduce((s, x) => s + x, 0) / (rets.length || 1);
  const sd = Math.sqrt(rets.reduce((s, x) => s + (x - mean) ** 2, 0) / (rets.length || 1));
  return {
    coin, startEquity: start, endEquity: equity, returnPct: (equity / start - 1) * 100, trades,
    winRate: trades.length ? wins.length / trades.length : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
    maxDrawdownPct: mdd * 100, avgR: mean, sharpe: sd > 0 ? (mean / sd) * Math.sqrt(trades.length) : 0,
    equityCurve: curve.filter((_, i) => i % 6 === 0), bars: candles.length,
  };
}
