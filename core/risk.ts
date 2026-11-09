import type { Side } from "./types";

// every limit that bounds how much a single trade, day or drawdown can cost
export interface RiskParams {
  riskPerTradePct: number; // equity fraction lost if stop is hit
  maxLeverage: number;
  maxPositions: number;
  dailyLossLimitPct: number; // halt trading for the UTC day
  maxDrawdownPct: number; // hard kill switch from equity peak
  stopAtr: number;
  takeAtr: number;
  breakevenAtR: number; // move stop to entry after this many R
  trailAtr: number; // trailing distance once in profit
  cooldownMin: number; // pause per coin after a losing trade
  minNotional: number; // exchange minimum order value (USD)
  takerFee: number;
  slippage: number; // expected per-side slippage fraction
  maxCostR: number; // reject trades whose round-trip costs exceed this fraction of the stop distance
}

// defaults sized for a $10 account against hyperliquid's $10 minimum order and base-tier fees
export const defaultRiskParams: RiskParams = {
  riskPerTradePct: 0.02,
  maxLeverage: 5,
  maxPositions: 1,
  dailyLossLimitPct: 0.06,
  maxDrawdownPct: 0.2,
  stopAtr: 1.6,
  takeAtr: 3.2,
  breakevenAtR: 1,
  trailAtr: 2,
  cooldownMin: 30,
  minNotional: 10,
  takerFee: 0.00045,
  slippage: 0.0003,
  maxCostR: 0.2,
};

// sizing decision with the reason a trade was refused, so skips are explainable in the log
export interface SizingResult {
  ok: boolean;
  reason: string;
  size: number;
  notional: number;
  leverage: number;
  stopPx: number;
  takePx: number;
  riskUsd: number;
}

// fixed-fractional sizing so a stop-out costs a known slice of equity, never the account
export function sizePosition(
  equity: number,
  price: number,
  atr: number,
  side: Side,
  coinMaxLeverage: number,
  r: RiskParams,
): SizingResult {
  const dir = side === "long" ? 1 : -1;
  const stopDist = atr * r.stopAtr;
  const stopPx = price - dir * stopDist;
  const takePx = price + dir * atr * r.takeAtr;
  const fail = (reason: string): SizingResult => ({
    ok: false, reason, size: 0, notional: 0, leverage: 0, stopPx, takePx, riskUsd: 0,
  });
  if (!(equity > 0) || !(price > 0) || !(stopDist > 0)) return fail("invalid inputs");
  const costR = (price * 2 * (r.takerFee + r.slippage)) / stopDist;
  if (costR > r.maxCostR) return fail(`fees+slippage ${costR.toFixed(2)}R > ${r.maxCostR}R: stop too tight for costs`);

  const lev = Math.max(1, Math.min(r.maxLeverage, coinMaxLeverage));
  const maxNotional = equity * lev * 0.95; // margin buffer for fees/price drift
  const riskBudget = equity * r.riskPerTradePct;
  // Loss at stop includes round-trip taker fees.
  const lossPerUnit = stopDist + price * r.takerFee * 2;
  let size = riskBudget / lossPerUnit;
  let notional = size * price;

  if (notional > maxNotional) {
    notional = maxNotional;
    size = notional / price;
  }
  if (notional < r.minNotional) {
    // Small accounts: bump to exchange minimum only if the resulting risk stays within 1.5x budget.
    const minSize = (r.minNotional * 1.01) / price;
    const minRisk = minSize * lossPerUnit;
    if (minSize * price > maxNotional) return fail(`min notional $${r.minNotional} exceeds ${lev}x margin`);
    if (minRisk > riskBudget * 1.5)
      return fail(`stop too wide for account: risk $${minRisk.toFixed(2)} > budget $${riskBudget.toFixed(2)}`);
    size = minSize;
    notional = size * price;
  }
  return {
    ok: true,
    reason: "ok",
    size,
    notional,
    leverage: Math.min(lev, Math.max(1, Math.ceil(notional / equity))),
    stopPx,
    takePx,
    riskUsd: size * lossPerUnit,
  };
}

// locks in breakeven then trails, so winners are protected without ever loosening the stop
export function trailStop(
  side: Side,
  entry: number,
  initialStop: number,
  currentStop: number,
  price: number,
  atr: number,
  r: RiskParams,
): number {
  const dir = side === "long" ? 1 : -1;
  const riskDist = Math.abs(entry - initialStop);
  const gainR = ((price - entry) * dir) / riskDist;
  let next = currentStop;
  if (gainR >= r.breakevenAtR) {
    const be = entry + dir * entry * r.takerFee * 2;
    next = dir > 0 ? Math.max(next, be) : Math.min(next, be);
  }
  if (gainR >= r.breakevenAtR * 1.5) {
    const trail = price - dir * atr * r.trailAtr;
    next = dir > 0 ? Math.max(next, trail) : Math.min(next, trail);
  }
  return next;
}

// account figures the circuit breakers need
export interface GuardState {
  equity: number;
  peakEquity: number;
  dayStartEquity: number;
  openPositions: number;
}

// circuit breakers that stop new risk after a bad day or a deep drawdown
export function riskGate(s: GuardState, r: RiskParams): { ok: boolean; reason: string } {
  if (s.peakEquity > 0 && (s.peakEquity - s.equity) / s.peakEquity >= r.maxDrawdownPct)
    return { ok: false, reason: `KILL SWITCH: drawdown >= ${(r.maxDrawdownPct * 100).toFixed(0)}% from peak` };
  if (s.dayStartEquity > 0 && (s.dayStartEquity - s.equity) / s.dayStartEquity >= r.dailyLossLimitPct)
    return { ok: false, reason: `daily loss limit ${(r.dailyLossLimitPct * 100).toFixed(0)}% reached` };
  if (s.openPositions >= r.maxPositions) return { ok: false, reason: "max positions open" };
  return { ok: true, reason: "ok" };
}
