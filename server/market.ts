import { HttpTransport, InfoClient } from "@nktkas/hyperliquid";
import type { Candle } from "../core/types";
import { config } from "./config";

// one http transport shared by reads and signed actions so network selection stays consistent
export const transport = new HttpTransport({ isTestnet: config.testnet });
// public read client for prices, candles, books and account state
export const info = new InfoClient({ transport });

// per-perp exchange metadata needed for order formatting and leverage caps
export interface AssetMeta {
  index: number;
  name: string;
  szDecimals: number;
  maxLeverage: number;
  funding: number;
  markPx: number;
}

// cached universe to stay well under hyperliquid's request-weight limits
let metaCache: { at: number; byName: Map<string, AssetMeta> } | null = null;

// listed perps keyed by name, with funding and mark from the same snapshot
export async function assets(maxAgeMs = 60_000): Promise<Map<string, AssetMeta>> {
  if (metaCache && Date.now() - metaCache.at < maxAgeMs) return metaCache.byName;
  const [meta, ctxs] = await info.metaAndAssetCtxs();
  const byName = new Map<string, AssetMeta>();
  meta.universe.forEach((u, i) => {
    if ((u as { isDelisted?: boolean }).isDelisted) return;
    byName.set(u.name, {
      index: i, name: u.name, szDecimals: u.szDecimals, maxLeverage: u.maxLeverage,
      funding: Number(ctxs[i]?.funding ?? 0), markPx: Number(ctxs[i]?.markPx ?? 0),
    });
  });
  metaCache = { at: Date.now(), byName };
  return byName;
}

// lookup that fails loudly on typos instead of trading the wrong asset index
export async function asset(coin: string): Promise<AssetMeta> {
  const a = (await assets()).get(coin);
  if (!a) throw new Error(`unknown perp ${coin}`);
  return a;
}

// all mid prices in one cheap call, drives paper fills and marketable limits
export async function mids(): Promise<Record<string, number>> {
  const m = await info.allMids();
  return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, Number(v)]));
}

// bar length per supported interval
export const INTERVAL_MS: Record<string, number> = { "1m": 60e3, "5m": 300e3, "15m": 900e3, "1h": 3600e3 };

// recent candles parsed to numbers for the indicator code
export async function candles(coin: string, interval: string, bars: number, endTime?: number) {
  const ms = INTERVAL_MS[interval];
  const end = endTime ?? Date.now();
  const raw = await info.candleSnapshot({
    coin, interval: interval as "1m", startTime: end - ms * (bars + 1), endTime: end,
  });
  return raw.map((k): Candle => ({ t: k.t, o: +k.o, h: +k.h, l: +k.l, c: +k.c, v: +k.v }));
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

// top-of-book pressure as a small live-only factor, -1 ask heavy to 1 bid heavy
export async function bookImbalance(coin: string): Promise<number> {
  const b = await info.l2Book({ coin });
  if (!b) return 0;
  const sum = (lv: { sz: string }[]) => lv.slice(0, 10).reduce((s, x) => s + Number(x.sz), 0);
  const bid = sum(b.levels[0]);
  const ask = sum(b.levels[1]);
  return bid + ask > 0 ? (bid - ask) / (bid + ask) : 0;
}
