import { HttpTransport, InfoClient, SubscriptionClient, WebSocketTransport } from "@nktkas/hyperliquid";

// public market data goes browser -> hyperliquid directly, keeping the bot server free for trading
let clients: { info: InfoClient; subs: SubscriptionClient; testnet: boolean } | null = null;

// lazily built once the server tells us which network it trades on
export function hl(testnet = false) {
  if (!clients || clients.testnet !== testnet) {
    clients = {
      info: new InfoClient({ transport: new HttpTransport({ isTestnet: testnet }) }),
      subs: new SubscriptionClient({ transport: new WebSocketTransport({ isTestnet: testnet }) }),
      testnet,
    };
  }
  return clients;
}

// one row of the markets table built from metaAndAssetCtxs
export interface MarketRow {
  name: string;
  szDecimals: number;
  maxLeverage: number;
  mark: number;
  prevDay: number;
  change: number;
  funding: number;
  openInterest: number;
  volume: number;
}

// snapshot of every listed perp, refreshed on an interval by the market list
export async function loadMarkets(testnet: boolean): Promise<MarketRow[]> {
  const [meta, ctxs] = await hl(testnet).info.metaAndAssetCtxs();
  return meta.universe
    .map((u, i) => {
      const c = ctxs[i];
      const mark = Number(c?.markPx ?? 0);
      const prev = Number(c?.prevDayPx ?? 0);
      return {
        name: u.name, szDecimals: u.szDecimals, maxLeverage: u.maxLeverage, mark, prevDay: prev,
        change: prev ? (mark / prev - 1) * 100 : 0, funding: Number(c?.funding ?? 0),
        openInterest: Number(c?.openInterest ?? 0) * mark, volume: Number(c?.dayNtlVlm ?? 0),
        delisted: (u as { isDelisted?: boolean }).isDelisted,
      };
    })
    .filter((m) => !m.delisted && m.mark > 0);
}
