import type { Candle, MarketExtras, Regime, Signal, SignalFactor } from "./types";
import { adx, atr, clamp, ema, last, rsi, sma, stdev, vwap } from "./indicators";

// tunable model thresholds exposed in the dashboard
export interface StrategyParams {
  entryThreshold: number; // |score| needed to open
  adxTrend: number; // ADX above this = trending regime
  adxChop: number; // ADX below this with low vol = chop (no trades)
  minAtrPct: number; // skip dead markets (fees dominate)
}

// conservative defaults that favour standing aside over marginal setups
export const defaultStrategyParams: StrategyParams = {
  entryThreshold: 0.5,
  adxTrend: 22,
  adxChop: 14,
  minAtrPct: 0.0012,
};

// enough history for the slowest indicator to be warmed up
export const MIN_BARS = 220;

// builds higher-timeframe bars from lower ones so backtests can see the same htf bias as live
export function resample(candles: Candle[], bucketMs: number): Candle[] {
  const out: Candle[] = [];
  for (const k of candles) {
    const t = Math.floor(k.t / bucketMs) * bucketMs;
    const cur = out[out.length - 1];
    if (cur && cur.t === t) {
      cur.h = Math.max(cur.h, k.h);
      cur.l = Math.min(cur.l, k.l);
      cur.c = k.c;
      cur.v += k.v;
    } else out.push({ ...k, t });
  }
  return out;
}

// regime-aware multi-factor model: follow trends, fade ranges, stand aside in chop where noise and fees dominate
export function evaluate(
  coin: string,
  ltf: Candle[],
  htf: Candle[],
  extras: MarketExtras = {},
  p: StrategyParams = defaultStrategyParams,
): Signal {
  const c = ltf.map((k) => k.c);
  const h = ltf.map((k) => k.h);
  const l = ltf.map((k) => k.l);
  const v = ltf.map((k) => k.v);
  const price = last(c);
  const time = ltf[ltf.length - 1]?.t ?? 0;
  const flat = (reason: string, regime: Regime = "chop", a = 0): Signal => ({
    coin, time, price, score: 0, action: "flat", regime, atr: a, factors: [], reason,
  });
  if (ltf.length < MIN_BARS || htf.length < 60) return flat("insufficient history");

  const atrS = atr(h, l, c, 14);
  const a = last(atrS);
  const atrPct = a / price;
  const adxV = last(adx(h, l, c, 14));
  const fast = ema(c, 9);
  const slow = ema(c, 21);
  const trendE = ema(c, 100);
  const rsiV = last(rsi(c, 14));
  const mean = sma(c, 20);
  const sd = stdev(c, 20);
  const z = (price - last(mean)) / (last(sd) || 1);
  const vw = last(vwap(h, l, c, v, 48));
  const volMean = last(sma(v, 48));
  const volZ = volMean > 0 ? last(v) / volMean - 1 : 0;

  const hc = htf.map((k) => k.c);
  const hFast = ema(hc, 20);
  const hSlow = ema(hc, 50);
  const hSlope = (last(hFast) - hFast[hFast.length - 4]) / (last(hFast) || 1);
  const htfBias = clamp(((last(hFast) - last(hSlow)) / last(hSlow)) * 100 + hSlope * 200);

  let regime: Regime = "range";
  if (adxV >= p.adxTrend) regime = "trend";
  else if (adxV < p.adxChop || atrPct < p.minAtrPct) regime = "chop";
  if (atrPct < p.minAtrPct) return flat(`volatility too low (${(atrPct * 100).toFixed(2)}%)`, "chop", a);

  const factors: SignalFactor[] = [];
  const add = (name: string, value: number, weight: number) =>
    factors.push({ name, value: clamp(Number.isFinite(value) ? value : 0), weight });

  if (regime === "trend") {
    add("htf_bias", htfBias, 0.3);
    add("ema_cross", ((last(fast) - last(slow)) / a) * 0.8, 0.25);
    add("trend_ema", ((price - last(trendE)) / a) * 0.3, 0.15);
    // Momentum but avoid buying exhaustion: peaks around RSI 60/40, fades past 75/25.
    const r = (rsiV - 50) / 25;
    add("rsi_momo", Math.abs(rsiV - 50) > 25 ? r * 0.3 : r, 0.15);
    add("volume", Math.sign(price - c[c.length - 2]) * clamp(volZ, 0, 1), 0.05);
  } else {
    add("zscore_revert", -z / 2.2, 0.35);
    add("rsi_revert", -(rsiV - 50) / 20, 0.25);
    add("vwap_revert", -((price - vw) / a) * 0.5, 0.15);
    add("htf_bias", htfBias, 0.15);
  }
  if (extras.bookImbalance !== undefined) add("book_imbalance", extras.bookImbalance * 1.5, 0.05);
  // Crowded funding is a mild contrarian signal (longs paying = crowded long).
  if (extras.funding !== undefined) add("funding", -extras.funding / 0.0001, 0.05);

  const wsum = factors.reduce((s, f) => s + f.weight, 0);
  const score = clamp(factors.reduce((s, f) => s + f.value * f.weight, 0) / wsum);

  let action: Signal["action"] = "flat";
  let reason = `${regime}: score ${score.toFixed(2)} below ${p.entryThreshold}`;
  if (regime === "chop") {
    reason = `chop (ADX ${adxV.toFixed(1)}): standing aside`;
  } else if (Math.abs(score) >= p.entryThreshold) {
    const dir = score > 0 ? "long" : "short";
    // Never fight a strong higher-timeframe trend.
    if ((dir === "long" && htfBias < -0.4) || (dir === "short" && htfBias > 0.4)) {
      reason = `${dir} vetoed by HTF bias ${htfBias.toFixed(2)}`;
    } else {
      action = dir;
      const top = [...factors].sort((x, y) => Math.abs(y.value * y.weight) - Math.abs(x.value * x.weight))[0];
      reason = `${regime} ${dir} | score ${score.toFixed(2)} | ADX ${adxV.toFixed(1)} | lead: ${top.name}`;
    }
  }
  return { coin, time, price, score, action, regime, atr: a, factors, reason };
}
