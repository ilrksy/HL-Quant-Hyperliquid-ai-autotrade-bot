import { INTERVAL_MS_PURE } from "./intervals";

// leverage cap for one trade and the reasoning shown in the log
export interface LeverageDecision {
  cap: number;
  dailyVolPct: number;
  reason: string;
}

// inputs the leverage officer needs from settings
export interface LeveragePolicy {
  mode: "auto" | "fixed";
  fixed: number;
  volTargetPct: number;
  userCap: number;
  perCoinCap?: number;
}

// volatility-targeted leverage: a one-day 1-sigma move should cost at most volTargetPct of posted margin
export function leverageFor(atrPct: number, interval: string, coinMax: number, p: LeveragePolicy): LeverageDecision {
  const hardCap = Math.max(1, Math.floor(Math.min(p.userCap, p.perCoinCap ?? Infinity, coinMax)));
  const barsPerDay = 86_400_000 / (INTERVAL_MS_PURE[interval] ?? 900_000);
  const dailyVol = Math.max(1e-6, atrPct * Math.sqrt(barsPerDay));
  if (p.mode === "fixed") {
    const cap = Math.max(1, Math.min(Math.floor(p.fixed), hardCap));
    return { cap, dailyVolPct: dailyVol * 100, reason: `fixed ${cap}x (hard cap ${hardCap}x)` };
  }
  const volCap = Math.max(1, Math.floor(p.volTargetPct / 100 / dailyVol));
  const cap = Math.min(hardCap, volCap);
  return { cap, dailyVolPct: dailyVol * 100, reason: `auto ${cap}x: daily vol ${(dailyVol * 100).toFixed(1)}% → vol cap ${volCap}x, hard cap ${hardCap}x` };
}

// approximate isolated liquidation distance as a fraction of price, conservative for cross margin
export function liquidationDistance(leverage: number, coinMaxLeverage: number): number {
  return Math.max(0, 1 / leverage - 1 / (2 * coinMaxLeverage));
}
