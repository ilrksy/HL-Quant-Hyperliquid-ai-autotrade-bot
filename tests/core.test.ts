import { describe, expect, it } from "vitest";
import { atr, ema, rsi, sma } from "../core/indicators";
import { defaultRiskParams, riskGate, sizePosition, trailStop } from "../core/risk";
import { evaluate, resample } from "../core/strategy";
import { backtest } from "../core/backtest";
import type { Candle } from "../core/types";

// deterministic synthetic market so tests never depend on the network
function series(n: number, drift: number, noise = 0.002, seed = 1): Candle[] {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647) - 0.5;
  let p = 100;
  return Array.from({ length: n }, (_, i) => {
    const o = p;
    p = p * (1 + drift + rnd() * noise);
    const c = p;
    return { t: i * 300_000, o, h: Math.max(o, c) * (1 + Math.abs(rnd()) * noise), l: Math.min(o, c) * (1 - Math.abs(rnd()) * noise), c, v: 100 + rnd() * 20 };
  });
}

describe("indicators", () => {
  it("sma and ema converge on a constant series", () => {
    const v = Array(50).fill(5);
    expect(sma(v, 10).at(-1)).toBeCloseTo(5);
    expect(ema(v, 10).at(-1)).toBeCloseTo(5);
    expect(Number.isNaN(ema(v, 10)[8])).toBe(true);
  });
  it("rsi is 100 for strictly rising prices and ~0 for falling", () => {
    const up = Array.from({ length: 40 }, (_, i) => i + 1);
    expect(rsi(up, 14).at(-1)).toBe(100);
    expect(rsi([...up].reverse(), 14).at(-1)).toBeLessThan(1);
  });
  it("atr equals the constant bar range", () => {
    const h = Array(30).fill(11);
    const l = Array(30).fill(9);
    const c = Array(30).fill(10);
    expect(atr(h, l, c, 14).at(-1)).toBeCloseTo(2);
  });
});

describe("risk sizing", () => {
  const r = { ...defaultRiskParams };
  it("caps loss at the stop to the risk budget plus fees", () => {
    const s = sizePosition(1000, 100, 1, "long", 20, r);
    expect(s.ok).toBe(true);
    expect(s.stopPx).toBeCloseTo(100 - r.stopAtr);
    expect(s.riskUsd).toBeLessThanOrEqual(1000 * r.riskPerTradePct + 1e-9);
  });
  it("never exceeds max leverage", () => {
    const s = sizePosition(10, 100, 0.5, "short", 50, { ...r, maxCostR: 1 });
    expect(s.notional).toBeLessThanOrEqual(10 * r.maxLeverage);
  });
  it("bumps a $10 account to the $10 exchange minimum only when risk stays acceptable", () => {
    const ok = sizePosition(10, 100, 1, "long", 20, { ...r, riskPerTradePct: 0.02 });
    expect(ok.ok).toBe(true);
    expect(ok.notional).toBeGreaterThanOrEqual(10);
    const tooWide = sizePosition(10, 100, 10, "long", 20, { ...r, riskPerTradePct: 0.02 });
    expect(tooWide.ok).toBe(false);
  });
  it("rejects trades whose fees eat too much of the stop", () => {
    const s = sizePosition(1000, 100, 0.05, "long", 20, r);
    expect(s.ok).toBe(false);
    expect(s.reason).toMatch(/fees/);
  });
  it("trailing stop only ever tightens", () => {
    const st = trailStop("long", 100, 98, 98, 99, 1, r);
    expect(st).toBe(98);
    const be = trailStop("long", 100, 98, 98, 102.1, 1, r);
    expect(be).toBeGreaterThanOrEqual(100);
    const back = trailStop("long", 100, 98, be, 101, 1, r);
    expect(back).toBe(be);
    const sh = trailStop("short", 100, 102, 102, 97, 1, r);
    expect(sh).toBeLessThanOrEqual(100);
  });
  it("kill switch and daily limit block new trades", () => {
    expect(riskGate({ equity: 7.9, peakEquity: 10, dayStartEquity: 7.9, openPositions: 0 }, r).reason).toMatch(/KILL/);
    expect(riskGate({ equity: 9.3, peakEquity: 9.4, dayStartEquity: 10, openPositions: 0 }, r).ok).toBe(false);
    expect(riskGate({ equity: 10, peakEquity: 10, dayStartEquity: 10, openPositions: 1 }, r).ok).toBe(false);
    expect(riskGate({ equity: 10, peakEquity: 10, dayStartEquity: 10, openPositions: 0 }, r).ok).toBe(true);
  });
});

describe("strategy", () => {
  it("stays flat without enough history", () => {
    const k = series(50, 0);
    expect(evaluate("X", k, resample(k, 3_600_000)).action).toBe("flat");
  });
  it("produces bounded scores and named factors", () => {
    const k = series(1000, 0.0008);
    const sig = evaluate("X", k, resample(k, 3_600_000));
    expect(Math.abs(sig.score)).toBeLessThanOrEqual(1);
    expect(sig.atr).toBeGreaterThan(0);
    if (sig.regime !== "chop") expect(sig.factors.length).toBeGreaterThan(0);
  });
  it("resample aggregates ohlcv correctly", () => {
    const k = series(24, 0.001);
    const h = resample(k, 3_600_000);
    expect(h).toHaveLength(2);
    expect(h[0].o).toBe(k[0].o);
    expect(h[0].c).toBe(k[11].c);
    expect(h[0].h).toBe(Math.max(...k.slice(0, 12).map((x) => x.h)));
  });
});

describe("backtest", () => {
  it("accounts every trade into final equity and never trades past the kill switch", () => {
    const k = series(3000, 0.0002, 0.006, 7);
    const r = backtest("X", k, { equity: 10 });
    const sum = r.trades.reduce((a, t) => a + t.pnl, 0);
    expect(r.endEquity).toBeCloseTo(10 + sum, 6);
    expect(r.maxDrawdownPct).toBeLessThanOrEqual(defaultRiskParams.maxDrawdownPct * 100 + 5);
  });
});
