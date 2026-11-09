import { createReadStream, existsSync, statSync } from "node:fs";
import { formatSize } from "@nktkas/hyperliquid/utils";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { backtest } from "../core/backtest";
import type { Side } from "../core/types";
import { Bot } from "./bot";
import type { Broker } from "./broker";
import { config } from "./config";
import { LiveBroker } from "./live";
import { asset, candleHistory, INTERVAL_MS, mids } from "./market";
import { PaperBroker } from "./paper";

// paper unless live was explicitly configured and acknowledged
const broker: Broker = config.mode === "live"
  ? new LiveBroker(config.privateKey!, config.accountAddress)
  : new PaperBroker(config.paperEquity);
// single bot instance shared by every dashboard client
const bot = new Bot(broker, config.bot);
bot.startLoop();

// thrown by handlers to return a 4xx with a readable message
class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

// small json body reader, capped to avoid memory abuse
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 100_000) throw new HttpError(413, "body too large");
  }
  return raw ? JSON.parse(raw) : {};
}

// positive finite number or a 400, keeps bad input away from order code
function num(v: unknown, name: string): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new HttpError(400, `${name} must be a positive number`);
  return n;
}

// shallow merge that only accepts known numeric keys from the dashboard
function mergeNumeric<T extends object>(target: T, patch: unknown) {
  if (!patch || typeof patch !== "object") return;
  for (const [k, v] of Object.entries(patch)) {
    if (k in target && typeof (target as Record<string, unknown>)[k] === "number" && Number.isFinite(Number(v)))
      (target as Record<string, number>)[k] = Number(v);
  }
}

// route handler signature
type Handler = (req: IncomingMessage, url: URL) => Promise<unknown>;

// every mutating route; reads are GET so they stay cache-safe and token-free
const routes: Record<string, Handler> = {
  "GET /api/state": async () => ({
    mode: broker.mode, testnet: config.testnet, bot: bot.status(), config: bot.cfg,
    account: broker.mode === "paper" ? await broker.snapshot() : bot.snapshot, signals: bot.signals, logs: bot.logs.slice(0, 200),
    trades: broker.closedTrades().slice(0, 200), equityCurve: bot.equityCurve.filter((_, i, a) => a.length < 600 || i % 5 === 0),
  }),
  "POST /api/bot/start": async () => { bot.start(); return { ok: true }; },
  "POST /api/bot/stop": async () => { bot.stop(); return { ok: true }; },
  "POST /api/bot/kill": async () => { await bot.killAll("manual kill switch"); return { ok: true }; },
  "POST /api/config": async (req) => {
    const b = await body(req);
    if (Array.isArray(b.coins)) {
      const known = await Promise.all(b.coins.map((c) => asset(String(c).toUpperCase()).then((a) => a.name).catch(() => null)));
      bot.cfg.coins = known.filter((c): c is string => !!c).slice(0, 12);
    }
    if (typeof b.interval === "string" && ["1m", "5m", "15m"].includes(b.interval)) bot.cfg.interval = b.interval as "5m";
    if (b.loopSec !== undefined) bot.cfg.loopSec = Math.max(5, Math.min(300, num(b.loopSec, "loopSec")));
    mergeNumeric(bot.cfg.risk, b.risk);
    mergeNumeric(bot.cfg.strategy, b.strategy);
    bot.cfg.risk.maxLeverage = Math.min(bot.cfg.risk.maxLeverage, 20);
    bot.cfg.risk.riskPerTradePct = Math.min(bot.cfg.risk.riskPerTradePct, 0.1);
    bot.startLoop();
    return bot.cfg;
  },
  "POST /api/order": async (req) => {
    const b = await body(req);
    const coin = String(b.coin ?? "").toUpperCase();
    const a = await asset(coin);
    const side = b.side === "short" ? "short" : ("long" as Side);
    const px = b.limitPx ? num(b.limitPx, "limitPx") : (await mids())[coin];
    const size = Number(formatSize(b.size ? num(b.size, "size") : num(b.sizeUsd, "sizeUsd") / px, a.szDecimals));
    if (!(size > 0)) throw new HttpError(400, `size rounds to zero (${a.szDecimals} decimals)`);
    const leverage = Math.min(a.maxLeverage, Math.round(num(b.leverage ?? 1, "leverage")));
    if (size * px < 10 && !b.reduceOnly) throw new HttpError(400, "Hyperliquid minimum order value is $10");
    const res = await broker.open({
      coin, side, size, leverage, limitPx: b.limitPx ? px : undefined, reduceOnly: !!b.reduceOnly,
      stopPx: b.stopPx ? num(b.stopPx, "stopPx") : undefined, takePx: b.takePx ? num(b.takePx, "takePx") : undefined,
    });
    bot.log("trade", `manual ${side} ${coin} ${size.toPrecision(4)} ${b.limitPx ? `limit ${px}` : "market"} -> ${res.status}`);
    await bot.refreshSnapshot();
    return res;
  },
  "POST /api/close": async (req) => {
    const b = await body(req);
    await broker.close(String(b.coin), "manual close");
    bot.log("trade", `manual close ${b.coin}`);
    await bot.refreshSnapshot();
    return { ok: true };
  },
  "POST /api/cancel": async (req) => {
    const b = await body(req);
    await broker.cancel(String(b.coin), num(b.oid, "oid"));
    await bot.refreshSnapshot();
    return { ok: true };
  },
  "POST /api/paper/reset": async (req) => {
    if (!(broker instanceof PaperBroker)) throw new HttpError(400, "only in paper mode");
    const b = await body(req);
    broker.reset(b.equity ? num(b.equity, "equity") : config.paperEquity);
    bot.resetRiskState();
    bot.log("info", "paper account reset");
    await bot.refreshSnapshot();
    return { ok: true };
  },
  "GET /api/backtest": async (_req, url) => {
    const coin = (url.searchParams.get("coin") ?? "BTC").toUpperCase();
    const interval = url.searchParams.get("interval") ?? bot.cfg.interval;
    if (!INTERVAL_MS[interval] || interval === "1h") throw new HttpError(400, "interval must be 1m, 5m or 15m");
    const days = Math.min(60, Math.max(1, Number(url.searchParams.get("days") ?? 14)));
    const equity = Number(url.searchParams.get("equity") ?? config.paperEquity);
    const a = await asset(coin);
    const bars = Math.min(20_000, Math.ceil((days * 86_400_000) / INTERVAL_MS[interval]) + 250);
    const data = await candleHistory(coin, interval, bars);
    const res = backtest(coin, data, { equity, coinMaxLeverage: a.maxLeverage, risk: bot.cfg.risk, strategy: bot.cfg.strategy });
    return { ...res, interval, days, from: data[0]?.t, to: data[data.length - 1]?.t };
  },
};

// content types for the built dashboard assets
const MIME: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };

// serves the built dashboard in production so one process is enough
function serveStatic(url: URL, res: ServerResponse) {
  const root = join(process.cwd(), "web", "dist");
  let file = normalize(join(root, url.pathname));
  if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) file = join(root, "index.html");
  if (!existsSync(file)) {
    res.writeHead(404).end("dashboard not built: run npm run build, or use npm run dev");
    return;
  }
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
  createReadStream(file).pipe(res);
}

// api router with optional token auth on mutating routes, falls through to the dashboard
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://local");
  const key = `${req.method} ${url.pathname}`;
  const handler = routes[key];
  if (!handler) {
    if (req.method === "GET" && !url.pathname.startsWith("/api")) return serveStatic(url, res);
    res.writeHead(404, { "content-type": "application/json" }).end('{"error":"not found"}');
    return;
  }
  try {
    if (req.method !== "GET" && config.apiToken && req.headers["x-api-token"] !== config.apiToken)
      throw new HttpError(401, "invalid API token");
    const out = await handler(req, url);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(out));
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ error: (e as Error).message }));
  }
});

server.listen(config.port, config.host, () => {
  console.log(`[server] ${config.mode.toUpperCase()}${config.testnet ? " (testnet)" : ""} on http://${config.host}:${config.port}`);
});
