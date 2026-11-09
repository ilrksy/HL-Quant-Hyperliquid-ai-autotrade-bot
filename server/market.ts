import { HttpTransport, InfoClient } from "@nktkas/hyperliquid";
import { INTERVAL_MS_PURE } from "../core/intervals";
import type { Candle } from "../core/types";
import { config } from "./config";

// one http transport shared by reads and signed actions so network selection stays consistent
export const transport = new HttpTransport({ isTestnet: config.testnet, timeout: 15_000 });
// public read client for prices, candles, books and account state
export const info = new InfoClient({ transport });

// per-perp exchange metadata plus the live context the workers score on
export interface MarketInfo {
  index: number;
  name: string;
  szDecimals: number;
  maxLeverage: number;
  funding: number;
  markPx: number;
  midPx: number;
  oraclePx: number;
  premium: number;
  oiUsd: number;
  volumeUsd: number;
  prevDayPx: number;
  change24h: number;
  spreadBps: number;
}

// kept for older imports
export type AssetMeta = MarketInfo;

// bar length per supported interval
export const INTERVAL_MS = INTERVAL_MS_PURE;

// the minimal market surface the company needs, so tests can swap in a fake exchange
export interface MarketData {
  snapshot(): Promise<Map<string, MarketInfo>>;
  mids(): Promise<Record<string, number>>;
  candles(coin: string, interval: string, bars: number): Promise<Candle[]>;
  book(coin: string): Promise<{ imbalance: number; spreadBps: number }>;
  crossFunding(): Promise<Map<string, number>>;
}

let snapCache: { at: number; map: Map<string, MarketInfo> } | null = null;
let snapInflight: Promise<Map<string, MarketInfo>> | null = null;

// whole universe with context in one weighted call, cached briefly and de-duplicated across callers
export async function marketSnapshot(maxAgeMs = 5_000): Promise<Map<string, MarketInfo>> {
  if (snapCache && Date.now() - snapCache.at < maxAgeMs) return snapCache.map;
  if (snapInflight) return snapInflight;
  snapInflight = (async () => {
    const [meta, ctxs] = await info.metaAndAssetCtxs();
    const map = new Map<string, MarketInfo>();
    meta.universe.forEach((u, i) => {
      const c = ctxs[i];
      if ((u as { isDelisted?: boolean }).isDelisted || !c) return;
      const mark = Number(c.markPx ?? 0);
      const mid = Number(c.midPx ?? mark);
      const prev = Number(c.prevDayPx ?? 0);
      const imp = (c.impactPxs ?? []).map(Number);
      map.set(u.name, {
        index: i, name: u.name, szDecimals: u.szDecimals, maxLeverage: u.maxLeverage, funding: Number(c.funding ?? 0),
        markPx: mark, midPx: mid, oraclePx: Number(c.oraclePx ?? 0), premium: Number(c.premium ?? 0),
        oiUsd: Number(c.openInterest ?? 0) * mark, volumeUsd: Number(c.dayNtlVlm ?? 0), prevDayPx: prev,
        change24h: prev ? (mark / prev - 1) * 100 : 0,
        spreadBps: imp.length === 2 && mid > 0 ? ((imp[1] - imp[0]) / mid) * 1e4 : 99,
      });
    });
    snapCache = { at: Date.now(), map };
    return map;
  })().finally(() => {
    snapInflight = null;
  });
  return snapInflight;
}

// compatibility wrapper for the brokers
export async function assets(maxAgeMs = 5_000): Promise<Map<string, MarketInfo>> {
  return marketSnapshot(maxAgeMs);
}

// canonical hyperliquid name for user input, tolerating case differences (kPEPE vs KPEPE)
export function resolveCoin(map: Map<string, MarketInfo>, name: string): string | null {
  if (map.has(name)) return name;
  const lower = name.toLowerCase();
  for (const k of map.keys()) if (k.toLowerCase() === lower) return k;
  return null;
}

// lookup that fails loudly on typos instead of trading the wrong asset index
export async function asset(coin: string): Promise<MarketInfo> {
  const map = await marketSnapshot();
  const name = resolveCoin(map, coin);
  if (!name) throw new Error(`unknown perp ${coin}`);
  return map.get(name)!;
}

// all mid prices in one cheap call, drives paper fills and marketable limits
export async function mids(): Promise<Record<string, number>> {
  const m = await info.allMids();
  return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, Number(v)]));
}

// raw candle request parsed to numbers
export async function candles(coin: string, interval: string, bars: number, endTime?: number): Promise<Candle[]> {
  const ms = INTERVAL_MS[interval];
  const end = endTime ?? Date.now();
  const raw = await info.candleSnapshot({ coin, interval: interval as "1m", startTime: end - ms * (bars + 1), endTime: end });
  return raw.map((k) => ({ t: k.t, o: +k.o, h: +k.h, l: +k.l, c: +k.c, v: +k.v }));
}

// pages backwards because one snapshot is capped, though hyperliquid only retains ~5000 bars per interval
export async function candleHistory(coin: string, interval: string, bars: number): Promise<Candle[]> {
  const out: Candle[] = [];
  let end = Date.now();
  while (out.length < bars) {
    const chunk = await candles(coin, interval, Math.min(5000, bars - out.length), end);
    const fresh = chunk.filter((k) => !out.length || k.t < out[0].t);
    if (!fresh.length) break;
    out.unshift(...fresh);
    end = fresh[0].t - 1;
  }
  return out;
}

// bars whose period has fully elapsed, so signals never repaint inside a bar
export function closedBars(bars: Candle[], interval: string, now = Date.now()): Candle[] {
  const ms = INTERVAL_MS[interval];
  return bars.filter((b) => b.t + ms <= now);
}

// incremental candle store: one full load, then only the newest bars once per bar period
export class CandleCache {
  private m = new Map<string, { bars: Candle[]; fetchedAt: number }>();

  // fetch function is injectable so tests can count requests
  constructor(private fetchBars: typeof candles = candles) {}

  // cached history, refreshed at most once per bar period which keeps us far below rate limits
  async get(coin: string, interval: string, need: number): Promise<Candle[]> {
    const key = `${coin}|${interval}`;
    const ms = INTERVAL_MS[interval];
    const now = Date.now();
    const e = this.m.get(key);
    if (e && Math.floor(e.fetchedAt / ms) === Math.floor(now / ms)) return e.bars;
    if (e && e.bars.length >= need) {
      const fresh = await this.fetchBars(coin, interval, 4);
      if (fresh.length) {
        const first = fresh[0].t;
        e.bars = [...e.bars.filter((b) => b.t < first), ...fresh].slice(-(need + 10));
      }
      e.fetchedAt = now;
      return e.bars;
    }
    const bars = await this.fetchBars(coin, interval, need);
    this.m.set(key, { bars, fetchedAt: now });
    return bars;
  }
}

// top-of-book pressure and spread for one candidate
export async function book(coin: string): Promise<{ imbalance: number; spreadBps: number }> {
  const b = await info.l2Book({ coin });
  if (!b) return { imbalance: 0, spreadBps: 99 };
  const sum = (lv: { sz: string }[]) => lv.slice(0, 10).reduce((s, x) => s + Number(x.sz), 0);
  const bid = sum(b.levels[0]);
  const ask = sum(b.levels[1]);
  const bb = Number(b.levels[0][0]?.px ?? 0);
  const ba = Number(b.levels[1][0]?.px ?? 0);
  return {
    imbalance: bid + ask > 0 ? (bid - ask) / (bid + ask) : 0,
    spreadBps: bb > 0 && ba > 0 ? ((ba - bb) / ((ba + bb) / 2)) * 1e4 : 99,
  };
}

let xfCache: { at: number; map: Map<string, number> } | null = null;

// average hourly funding on binance and bybit per coin, a crowding signal that hyperliquid alone cannot show
export async function crossFunding(maxAgeMs = 300_000): Promise<Map<string, number>> {
  if (xfCache && Date.now() - xfCache.at < maxAgeMs) return xfCache.map;
  const raw = await info.predictedFundings();
  const map = new Map<string, number>();
  for (const [coin, venues] of raw) {
    const rates = (venues ?? [])
      .filter(([v, d]) => v !== "HlPerp" && d && Number.isFinite(Number(d.fundingRate)))
      .map(([, d]) => Number(d!.fundingRate) / Math.max(1, Number(d!.fundingIntervalHours ?? 8)));
    if (rates.length) map.set(coin, rates.reduce((a, b) => a + b, 0) / rates.length);
  }
  xfCache = { at: Date.now(), map };
  return map;
}

// shared cache instance used by the live market adapter
const liveCandles = new CandleCache();

// production market adapter backed by the hyperliquid public api
export const liveMarket: MarketData = {
  snapshot: () => marketSnapshot(),
  mids,
  candles: (coin, interval, bars) => liveCandles.get(coin, interval, bars),
  book,
  crossFunding: () => crossFunding(),
};
