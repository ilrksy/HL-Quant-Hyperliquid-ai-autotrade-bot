import { ExchangeClient } from "@nktkas/hyperliquid";
import { formatPrice, formatSize } from "@nktkas/hyperliquid/utils";
import { privateKeyToAccount } from "viem/accounts";
import type { Side, TradeRecord } from "../core/types";
import type { AccountSnapshot, Broker, OpenRequest } from "./broker";
import { asset, info, mids, transport } from "./market";

// marketable IOC limit offset, hyperliquid has no true market orders
const MARKET_SLIPPAGE = 0.01;
// trigger orders execute as market with this protective limit band
const TRIGGER_SLIPPAGE = 0.1;

// real-money execution against hyperliquid perps through a signing wallet or agent key
export class LiveBroker implements Broker {
  readonly mode = "live" as const;
  private exchange: ExchangeClient;
  readonly user: `0x${string}`;

  // agent wallets sign for a main account, so reads must target that account's address
  constructor(privateKey: `0x${string}`, accountAddress?: `0x${string}`) {
    const wallet = privateKeyToAccount(privateKey);
    this.exchange = new ExchangeClient({ transport, wallet });
    this.user = accountAddress ?? wallet.address;
  }

  // paper-only hook, the exchange matches its own orders in live mode
  onPrices() {}

  // single round of account reads so the dashboard reflects exchange truth
  async snapshot(): Promise<AccountSnapshot> {
    const [ch, orders, fills] = await Promise.all([
      info.clearinghouseState({ user: this.user }),
      info.frontendOpenOrders({ user: this.user }),
      info.userFills({ user: this.user }),
    ]);
    const m = await mids();
    const triggers = orders.filter((o) => o.isTrigger && o.reduceOnly);
    return {
      mode: "live",
      address: this.user,
      equity: Number(ch.marginSummary.accountValue),
      available: Number(ch.withdrawable),
      marginUsed: Number(ch.marginSummary.totalMarginUsed),
      positions: ch.assetPositions.map(({ position: p }) => {
        const szi = Number(p.szi);
        const side: Side = szi > 0 ? "long" : "short";
        const stop = triggers.find((o) => o.coin === p.coin && o.orderType.startsWith("Stop"));
        const take = triggers.find((o) => o.coin === p.coin && o.orderType.startsWith("Take"));
        return {
          coin: p.coin, side, size: Math.abs(szi), entryPx: Number(p.entryPx), markPx: m[p.coin] ?? Number(p.entryPx),
          unrealizedPnl: Number(p.unrealizedPnl), leverage: p.leverage.value,
          liquidationPx: p.liquidationPx ? Number(p.liquidationPx) : null,
          stopPx: stop ? Number(stop.triggerPx) : null, takePx: take ? Number(take.triggerPx) : null,
        };
      }),
      orders: orders.map((o) => ({
        oid: o.oid, coin: o.coin, side: o.side === "B" ? "long" : "short", type: o.orderType,
        px: Number(o.isTrigger ? o.triggerPx : o.limitPx), size: Number(o.sz), reduceOnly: o.reduceOnly, time: o.timestamp,
      })),
      fills: fills.slice(0, 100).map((f) => ({
        time: f.time, coin: f.coin, side: f.side === "B" ? "long" : "short", px: Number(f.px), size: Number(f.sz),
        fee: Number(f.fee), closedPnl: Number(f.closedPnl), dir: f.dir,
      })),
    };
  }

  // builds a reduce-only market trigger used for both stop-loss and take-profit legs
  private trigger(a: { index: number; szDecimals: number }, side: Side, size: number, triggerPx: number, kind: "sl" | "tp") {
    const isBuy = side === "short";
    const limit = triggerPx * (isBuy ? 1 + TRIGGER_SLIPPAGE : 1 - TRIGGER_SLIPPAGE);
    return {
      a: a.index, b: isBuy, p: formatPrice(limit, a.szDecimals), s: formatSize(size, a.szDecimals), r: true,
      t: { trigger: { isMarket: true, triggerPx: formatPrice(triggerPx, a.szDecimals), tpsl: kind } },
    };
  }

  // entry first, then protective orders sized to the actual fill so partial fills stay covered
  async open(req: OpenRequest) {
    const a = await asset(req.coin);
    const size = formatSize(req.size, a.szDecimals);
    if (Number(size) <= 0) throw new Error(`size rounds to zero at ${a.szDecimals} decimals`);
    if (!req.reduceOnly) {
      await this.exchange.updateLeverage({ asset: a.index, isCross: true, leverage: Math.min(req.leverage, a.maxLeverage) });
    }
    const isBuy = req.side === "long";
    const mid = (await mids())[req.coin];
    const px = req.limitPx ?? mid * (isBuy ? 1 + MARKET_SLIPPAGE : 1 - MARKET_SLIPPAGE);
    const res = await this.exchange.order({
      orders: [{ a: a.index, b: isBuy, p: formatPrice(px, a.szDecimals), s: size, r: !!req.reduceOnly,
        t: { limit: { tif: req.limitPx ? "Gtc" : "Ioc" } } }],
      grouping: "na",
    });
    const st = res.response.data.statuses[0];
    let filledSize = 0;
    let avgPx = 0;
    let status = "unknown";
    if (typeof st === "object" && "filled" in st) {
      filledSize = Number(st.filled.totalSz);
      avgPx = Number(st.filled.avgPx);
      status = "filled";
    } else if (typeof st === "object" && "resting" in st) status = "resting";
    else status = String(st);

    if (filledSize > 0 && !req.reduceOnly && (req.stopPx || req.takePx)) {
      const legs = [];
      if (req.stopPx) legs.push(this.trigger(a, req.side, filledSize, req.stopPx, "sl"));
      if (req.takePx) legs.push(this.trigger(a, req.side, filledSize, req.takePx, "tp"));
      await this.exchange.order({ orders: legs, grouping: "na" });
    }
    return { filledSize, avgPx, status };
  }

  // flattens with a marketable reduce-only order and clears leftover triggers for that coin
  async close(coin: string, _reason: string) {
    const a = await asset(coin);
    const ch = await info.clearinghouseState({ user: this.user });
    const p = ch.assetPositions.find((x) => x.position.coin === coin)?.position;
    if (p && Number(p.szi) !== 0) {
      const szi = Number(p.szi);
      const mid = (await mids())[coin];
      const isBuy = szi < 0;
      await this.exchange.order({
        orders: [{ a: a.index, b: isBuy, p: formatPrice(mid * (isBuy ? 1 + MARKET_SLIPPAGE : 1 - MARKET_SLIPPAGE), a.szDecimals),
          s: formatSize(Math.abs(szi), a.szDecimals), r: true, t: { limit: { tif: "Ioc" } } }],
        grouping: "na",
      });
    }
    await this.cancelWhere(coin, (o) => o.reduceOnly);
  }

  // replaces the exchange-side stop so a crash of this process still leaves protection in place
  async setStop(coin: string, stopPx: number) {
    const a = await asset(coin);
    const ch = await info.clearinghouseState({ user: this.user });
    const p = ch.assetPositions.find((x) => x.position.coin === coin)?.position;
    if (!p || Number(p.szi) === 0) return;
    const szi = Number(p.szi);
    const side: Side = szi > 0 ? "long" : "short";
    await this.exchange.order({ orders: [this.trigger(a, side, Math.abs(szi), stopPx, "sl")], grouping: "na" });
    const fresh = Number(formatPrice(stopPx, a.szDecimals));
    await this.cancelWhere(coin, (o) => o.isTrigger && o.orderType.startsWith("Stop") && Number(o.triggerPx) !== fresh);
  }

  // shared cancel path filtered by an order predicate
  private async cancelWhere(coin: string, pred: (o: Awaited<ReturnType<typeof info.frontendOpenOrders>>[number]) => boolean) {
    const a = await asset(coin);
    const orders = (await info.frontendOpenOrders({ user: this.user })).filter((o) => o.coin === coin && pred(o));
    if (orders.length) await this.exchange.cancel({ cancels: orders.map((o) => ({ a: a.index, o: o.oid })) });
  }

  // manual cancel from the dashboard order table
  async cancel(coin: string, oid: number) {
    const a = await asset(coin);
    await this.exchange.cancel({ cancels: [{ a: a.index, o: oid }] });
  }

  // live realised pnl lives in exchange fills, shown via snapshot().fills instead
  closedTrades(): TradeRecord[] {
    return [];
  }
}
