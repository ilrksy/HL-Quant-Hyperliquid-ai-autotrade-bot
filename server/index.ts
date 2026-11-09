import { timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";
import { extname, join, normalize, sep } from "node:path";
import { formatSize } from "@nktkas/hyperliquid/utils";
import { backtest } from "../core/backtest";
import type { Side } from "../core/types";
import type { AiRole, AppState, ChainLink, DeepPartial, EventView, Settings } from "../shared/types";
import { AiGateway } from "./ai/gateway";
import { PRESETS } from "./ai/presets";
import { AI_ROLES, type ProviderPatch } from "./ai/registry";
import type { Broker } from "./broker";
import { Bus } from "./bus";
import { Company } from "./company/company";
import { config } from "./config";
import { Intel } from "./intel";
import { LiveBroker } from "./live";
import { asset, candleHistory, INTERVAL_MS, liveMarket, mids } from "./market";
import { PaperBroker } from "./paper";
import { portfolioStats, toCsv } from "./portfolio";
import { SettingsStore } from "./settings";
import { Store } from "./store";
import { Telegram } from "./telegram";

// ---- composition root -------------------------------------------------------------------------------------------
const store = new Store(join(config.dataDir, "hlq.db"));
const bus = new Bus(store);
const settings = new SettingsStore(store);
const ai = new AiGateway(store, bus);
const intel = new Intel(bus);
const broker: Broker = config.mode === "live"
  ? new LiveBroker(config.privateKey!, config.accountAddress)
  : new PaperBroker(config.paperEquity, join(config.dataDir, "paper.json"));
const company = new Company({ broker, store, bus, settings, ai, intel, market: liveMarket });
const telegram = new Telegram({ bus, settings, store, company, broker, ai, apiBase: config.telegramApi });

// thrown by handlers to return a 4xx with a readable message
class HttpError extends Error {
  // status is sent as the http code
  constructor(public status: number, message: string) {
    super(message);
  }
}

// json body reader with a size cap
async function body<T = Record<string, unknown>>(req: IncomingMessage): Promise<T> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1_000_000) throw new HttpError(413, "body too large");
  }
  if (!raw) return {} as T;
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
}

// positive finite number or a 400, keeps bad input away from order code
function num(v: unknown, name: string): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new HttpError(400, `${name} must be a positive number`);
  return n;
}

// optional integer query parameter
const qint = (u: URL, k: string) => (u.searchParams.has(k) ? Number(u.searchParams.get(k)) || undefined : undefined);
// optional string query parameter
const qstr = (u: URL, k: string) => u.searchParams.get(k) || undefined;

// ai health summary for the top bar and telegram
function aiSummary(): AppState["ai"] {
  const t = store.aiTotals(Date.now() - 86_400_000);
  return {
    mode: settings.get().ai.mode,
    providers: ai.view().map((p) => ({ id: p.id, name: p.name, health: p.health, readyKeys: p.keys.filter((k) => k.state === "ready").length, keys: p.keys.length })),
    calls24h: t.calls, tokens24h: t.tokens, failures24h: t.failures,
  };
}

// full dashboard state; paper snapshots are in-memory so they are always fresh
async function appState(): Promise<AppState> {
  const account = broker.mode === "paper" ? await broker.snapshot() : company.snapshot;
  return { version: config.version, mode: broker.mode, testnet: config.testnet, serverTime: Date.now(), account, ...company.state(), intel: intel.view(), ai: aiSummary() };
}

// lan addresses so the connect panel can tell phones where to point
function lanUrls(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === "IPv4" && !a.internal) out.push(`http://${a.address}:${config.port}`);
  }
  return out;
}

// handler signature; params come from the route pattern
type Handler = (req: IncomingMessage, url: URL, params: string[], res: ServerResponse) => Promise<unknown>;

// route table: method, path pattern, handler
const routes: [string, RegExp, Handler][] = [];
// registers one route
const on = (method: string, pattern: string, h: Handler) => routes.push([method, new RegExp(`^${pattern.replace(/:\w+/g, "([^/]+)")}$`), h]);

// ---- system -------------------------------------------------------------------------------------------------------
on("GET", "/api/health", async () => ({ ok: true, name: "hl-quant", version: config.version, mode: broker.mode, testnet: config.testnet, time: Date.now() }));
on("GET", "/api/state", async () => appState());
on("GET", "/api/connection", async () => ({
  host: config.host, port: config.port, lan: config.host === "0.0.0.0" || config.host === "::" ? lanUrls() : [],
  localOnly: config.host === "127.0.0.1" || config.host === "localhost", tokenFromEnv: config.tokenFromEnv, dataDir: config.dataDir,
}));

// ---- company control ---------------------------------------------------------------------------------------------
on("POST", "/api/bot/arm", async (req) => {
  const b = await body<{ confirm?: boolean }>(req);
  if (broker.mode === "live" && b.confirm !== true) throw new HttpError(400, "live mode requires confirm: true");
  company.arm();
  return { ok: true };
});
on("POST", "/api/bot/disarm", async () => (company.disarm(), { ok: true }));
on("POST", "/api/bot/kill", async () => (await company.kill("manual kill switch"), { ok: true }));
on("POST", "/api/bot/cycle", async () => (company.runNow(), { ok: true }));
on("POST", "/api/ceo/run", async () => company.runCeo());
on("POST", "/api/audit/run", async () => company.runAudit());
on("POST", "/api/deep/run", async () => (void company.runDeepResearch(), { ok: true, started: true }));

// ---- settings ----------------------------------------------------------------------------------------------------
on("GET", "/api/settings", async () => settings.masked());
on("PATCH", "/api/settings", async (req) => {
  settings.update(await body<DeepPartial<Settings>>(req));
  bus.log("info", "system", "boss", "Settings updated");
  return settings.masked();
});

// ---- ai providers ------------------------------------------------------------------------------------------------
on("GET", "/api/ai/presets", async () => PRESETS);
on("GET", "/api/ai/providers", async () => ai.view());
on("POST", "/api/ai/providers", async (req) => {
  const b = await body<{ preset?: string; name?: string; keys?: string[]; models?: string[]; baseUrl?: string }>(req);
  if (!b.preset) throw new HttpError(400, "preset is required");
  const keys = Array.isArray(b.keys) ? b.keys.map(String) : [];
  const p = ai.registry.add(b.preset, { name: b.name, keys, models: Array.isArray(b.models) ? b.models.map(String) : undefined, baseUrl: b.baseUrl });
  bus.log("info", "ai", "boss", `AI provider added: ${p.name} with ${p.keys.length} key(s)`);
  return ai.view().find((x) => x.id === p.id);
});
on("PATCH", "/api/ai/providers/:id", async (req, _u, [id]) => {
  const patch = await body<ProviderPatch>(req);
  const p = ai.registry.update(decodeURIComponent(id), patch);
  if (patch.addKeys?.length || patch.removeKeys?.length) bus.log("info", "ai", "boss", `AI provider ${p.name}: key pool now ${p.keys.length}`);
  return ai.view().find((x) => x.id === p.id);
});
on("DELETE", "/api/ai/providers/:id", async (_r, _u, [id]) => {
  ai.registry.remove(decodeURIComponent(id));
  bus.log("info", "ai", "boss", `AI provider removed: ${decodeURIComponent(id)}`);
  return { ok: true };
});
on("POST", "/api/ai/providers/:id/test", async (_r, _u, [id]) => {
  const out = await ai.test(decodeURIComponent(id));
  bus.log(out.every((x) => x.ok) ? "success" : "warn", "ai", "gateway", `Test ${decodeURIComponent(id)}: ${out.map((x) => `${x.label} ${x.ok ? "ok" : x.status}`).join(", ")}`);
  return out;
});
on("GET", "/api/ai/providers/:id/models", async (_r, _u, [id]) => ai.listModels(decodeURIComponent(id)));
on("POST", "/api/ai/providers/:id/move", async (req, _u, [id]) => {
  const b = await body<{ dir?: number }>(req);
  ai.registry.move(decodeURIComponent(id), b.dir === -1 ? -1 : 1);
  return ai.view();
});
on("POST", "/api/ai/providers/:id/reset", async (_r, _u, [id]) => (ai.reset(decodeURIComponent(id)), { ok: true }));
on("GET", "/api/ai/routes", async () => ai.routes());
on("PUT", "/api/ai/routes/:role", async (req, _u, [role]) => {
  const b = await body<{ chain?: ChainLink[] }>(req);
  if (!AI_ROLES.includes(role as AiRole)) throw new HttpError(400, `unknown role ${role}`);
  ai.registry.setRoute(role as AiRole, Array.isArray(b.chain) ? b.chain : []);
  return ai.routes();
});
on("GET", "/api/ai/calls", async (_r, u) => store.aiCalls({ role: qstr(u, "role"), provider: qstr(u, "provider"), status: qstr(u, "status"), before: qint(u, "before"), limit: qint(u, "limit") }));

// ---- history -------------------------------------------------------------------------------------------------------
// shared parser for log filters
const logQuery = (u: URL) => ({
  cat: qstr(u, "cat"), level: qstr(u, "level"), agent: qstr(u, "agent"), coin: qstr(u, "coin"), q: qstr(u, "q"),
  before: qint(u, "before"), since: qint(u, "since"), until: qint(u, "until"), limit: qint(u, "limit"),
});
on("GET", "/api/logs", async (_r, u) => store.events(logQuery(u)));
on("GET", "/api/logs/export", async (_r, u, _p, res) => {
  const rows = store.events({ ...logQuery(u), limit: 1000 });
  return download(res, u, "hlq-logs", rows.map((e) => ({ id: e.id, time: new Date(e.ts).toISOString(), level: e.level, cat: e.cat, agent: e.agent, coin: e.coin, cycle: e.cycle, msg: e.msg, data: e.data })));
});
on("GET", "/api/decisions", async (_r, u) => store.decisions({ coin: qstr(u, "coin"), outcome: qstr(u, "outcome"), before: qint(u, "before"), limit: qint(u, "limit") }));
on("GET", "/api/cycles", async (_r, u) => store.cycles(qint(u, "limit") ?? 100));
on("GET", "/api/trades", async (_r, u) => store.trades({ mode: qstr(u, "mode") ?? broker.mode, coin: qstr(u, "coin"), source: qstr(u, "source"), since: qint(u, "since"), limit: qint(u, "limit") }));
on("GET", "/api/trades/export", async (_r, u, _p, res) => {
  const rows = store.trades({ mode: qstr(u, "mode") ?? broker.mode, limit: 5000 });
  return download(res, u, "hlq-trades", rows.map((t) => ({ ...t, opened: new Date(t.opened).toISOString(), closed: new Date(t.closed).toISOString() })));
});
on("GET", "/api/portfolio", async (_r, u) => {
  const range = qstr(u, "range") ?? "30d";
  const since = range === "all" ? 0 : Date.now() - (range === "7d" ? 7 : range === "24h" ? 1 : 30) * 86_400_000;
  const trades = store.trades({ mode: broker.mode, since, limit: 5000 });
  const equity = store.equity(broker.mode, since);
  const t = store.aiTotals(Date.now() - 86_400_000);
  const calls = store.aiCalls({ limit: 1000 }).filter((c) => c.ts >= Date.now() - 86_400_000);
  const decisions = store.decisions({ limit: 500 }).filter((d) => d.ts >= Date.now() - 86_400_000);
  return portfolioStats(trades, equity, equity[0]?.v ?? config.paperEquity, {
    calls24h: t.calls, tokens24h: t.tokens, fallbacks24h: calls.filter((c) => c.depth > 0 && c.status === "ok").length,
    ruleDecisions24h: decisions.filter((d) => d.research?.source?.startsWith("rules") || d.boss?.source === "rules").length,
  });
});

// sends rows as csv or json attachment
function download(res: ServerResponse, u: URL, name: string, rows: Record<string, unknown>[]) {
  const csv = u.searchParams.get("format") !== "json";
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  res.writeHead(200, {
    "content-type": csv ? "text/csv; charset=utf-8" : "application/json",
    "content-disposition": `attachment; filename="${name}-${stamp}.${csv ? "csv" : "json"}"`,
  });
  res.end(csv ? toCsv(rows) : JSON.stringify(rows, null, 2));
  return SENT;
}

// ---- manual trading --------------------------------------------------------------------------------------------
on("POST", "/api/order", async (req) => {
  const b = await body(req);
  const a = await asset(String(b.coin ?? ""));
  const side: Side = b.side === "short" ? "short" : "long";
  const px = b.limitPx ? num(b.limitPx, "limitPx") : (await mids())[a.name];
  const size = Number(formatSize(b.size ? num(b.size, "size") : num(b.sizeUsd, "sizeUsd") / px, a.szDecimals));
  if (!(size > 0)) throw new HttpError(400, `size rounds to zero (${a.szDecimals} decimals)`);
  const leverage = Math.min(a.maxLeverage, Math.max(1, Math.round(Number(b.leverage ?? 1))));
  if (size * px < 10 && !b.reduceOnly) throw new HttpError(400, "Hyperliquid minimum order value is $10");
  const res = await broker.open({
    coin: a.name, side, size, leverage, limitPx: b.limitPx ? px : undefined, reduceOnly: !!b.reduceOnly,
    stopPx: b.stopPx ? num(b.stopPx, "stopPx") : undefined, takePx: b.takePx ? num(b.takePx, "takePx") : undefined, reason: "manual",
  });
  bus.log("success", "trade", "manual", `Manual ${side} ${a.name} ${size} ${b.limitPx ? `limit ${px}` : "market"} → ${res.status}`, { coin: a.name });
  return res;
});
on("POST", "/api/close", async (req) => {
  const b = await body(req);
  await broker.close(String(b.coin), "manual close");
  bus.log("info", "trade", "manual", `Manual close ${b.coin}`, { coin: String(b.coin) });
  return { ok: true };
});
on("POST", "/api/cancel", async (req) => {
  const b = await body(req);
  await broker.cancel(String(b.coin), num(b.oid, "oid"));
  return { ok: true };
});
on("POST", "/api/paper/reset", async (req) => {
  if (!(broker instanceof PaperBroker)) throw new HttpError(400, "only in paper mode");
  const b = await body(req);
  const eq = b.equity ? num(b.equity, "equity") : config.paperEquity;
  broker.reset(eq);
  store.clearHistory("paper");
  company.resetRisk();
  bus.log("info", "system", "accountant", `Paper account reset to $${eq}`);
  return { ok: true };
});
on("GET", "/api/backtest", async (_r, u) => {
  const s = settings.get();
  const interval = u.searchParams.get("interval") ?? s.bot.interval;
  if (!["1m", "5m", "15m"].includes(interval)) throw new HttpError(400, "interval must be 1m, 5m or 15m");
  const days = Math.min(60, Math.max(1, Number(u.searchParams.get("days") ?? 14)));
  const equity = Number(u.searchParams.get("equity") ?? config.paperEquity);
  const a = await asset(u.searchParams.get("coin") ?? "BTC");
  const bars = Math.min(20_000, Math.ceil((days * 86_400_000) / INTERVAL_MS[interval]) + 250);
  const data = await candleHistory(a.name, interval, bars);
  const r = backtest(a.name, data, { equity, coinMaxLeverage: Math.min(a.maxLeverage, s.risk.maxLeverage), risk: s.risk, strategy: s.strategy });
  return { ...r, interval, days, from: data[0]?.t, to: data[data.length - 1]?.t };
});

// ---- telegram ----------------------------------------------------------------------------------------------------
on("GET", "/api/telegram/status", async () => telegram.status());
on("POST", "/api/telegram/pair", async () => {
  if (!settings.get().telegram.token) throw new HttpError(400, "save a bot token first");
  return telegram.createPairCode();
});
on("POST", "/api/telegram/test", async () => telegram.test());

// ---- live stream (server-sent events) --------------------------------------------------------------------------
const clients = new Set<ServerResponse>();
on("GET", "/api/stream", async (req, _u, _p, res) => {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
  res.write(`retry: 3000\nevent: state\ndata: ${JSON.stringify(await appState())}\n\n`);
  clients.add(res);
  req.on("close", () => clients.delete(res));
  return SENT;
});
// pushes every history entry to connected dashboards as it happens
bus.on("event", (e: EventView) => {
  if (!clients.size) return;
  const line = `event: log\ndata: ${JSON.stringify(e)}\n\n`;
  for (const c of clients) c.write(line);
});
// one state snapshot per tick shared by all clients, plus keep-alive comments for proxies
setInterval(async () => {
  if (!clients.size) return;
  try {
    const line = `event: state\ndata: ${JSON.stringify(await appState())}\n\n`;
    for (const c of clients) c.write(line);
  } catch (e) {
    console.error("state broadcast failed", e);
  }
}, 2000).unref();
setInterval(() => { for (const c of clients) c.write(": keep-alive\n\n"); }, 15_000).unref();

// ---- http plumbing ---------------------------------------------------------------------------------------------
// marker returned by handlers that already wrote the response
const SENT = Symbol("sent");

// content types for the built dashboard assets
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png",
  ".ico": "image/x-icon", ".json": "application/json", ".webmanifest": "application/manifest+json", ".woff2": "font/woff2", ".txt": "text/plain",
};

// serves the built dashboard with spa fallback, immutable caching for hashed assets
function serveStatic(url: URL, res: ServerResponse) {
  const root = config.webDist;
  let file = normalize(join(root, decodeURIComponent(url.pathname)));
  if (!(file === root || file.startsWith(root + sep)) || !existsSync(file) || statSync(file).isDirectory()) file = join(root, "index.html");
  if (!existsSync(file)) {
    res.writeHead(404, { "content-type": "text/plain" }).end("Dashboard not built. Run `npm run build`, or use `npm run dev` during development.");
    return;
  }
  const immutable = file.includes(`${sep}assets${sep}`);
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream", "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache" });
  createReadStream(file).pipe(res);
}

// constant-time token comparison
function tokenOk(given: string | undefined): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(config.apiToken);
  return a.length === b.length && timingSafeEqual(a, b);
}

// per-ip failed-auth counter to slow down token guessing on exposed servers
const authFails = new Map<string, { n: number; until: number }>();

// cors headers so browser, desktop (file://) and android webview clients can all call the api
const CORS = {
  "access-control-allow-origin": "*", "access-control-allow-headers": "content-type, x-api-token, authorization",
  "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS", "access-control-max-age": "600",
};

// api router: cors, auth, json errors; non-api GETs fall through to the dashboard
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://local");
  for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v);
  if (req.method === "OPTIONS") return void res.writeHead(204).end();
  if (!url.pathname.startsWith("/api/")) {
    if (req.method === "GET" || req.method === "HEAD") return serveStatic(url, res);
    return void res.writeHead(405).end();
  }
  const match = routes.map(([m, re, h]) => ({ m, h, p: url.pathname.match(re) })).filter((r) => r.p);
  const route = match.find((r) => r.m === req.method);
  try {
    if (!route) throw new HttpError(match.length ? 405 : 404, match.length ? "method not allowed" : "not found");
    if (url.pathname !== "/api/health") {
      const ip = req.socket.remoteAddress ?? "?";
      const f = authFails.get(ip);
      if (f && f.until > Date.now()) throw new HttpError(429, "too many failed attempts, try again later");
      const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, "");
      const given = (req.headers["x-api-token"] as string | undefined) ?? bearer ?? url.searchParams.get("token") ?? undefined;
      if (!tokenOk(given)) {
        const n = (f && f.until > Date.now() - 60_000 ? f.n : 0) + 1;
        authFails.set(ip, { n, until: n >= 10 ? Date.now() + 5 * 60_000 : Date.now() });
        if (n === 10) bus.log("warn", "system", "guard", `Blocked ${ip} for 5 minutes after repeated invalid API tokens`);
        throw new HttpError(401, "invalid or missing API token");
      }
      authFails.delete(ip);
    }
    const out = await route.h(req, url, route.p!.slice(1), res);
    if (out === SENT) return;
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(out ?? null));
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (!res.headersSent) res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: (e as Error).message }));
  }
});

// starts everything and prints how devices connect
server.listen(config.port, config.host, () => {
  const url = `http://${config.host === "0.0.0.0" ? "localhost" : config.host}:${config.port}`;
  console.log(`[hl-quant] v${config.version} ${config.mode.toUpperCase()}${config.testnet ? " (testnet)" : ""} listening on ${url}`);
  for (const u of config.host === "0.0.0.0" ? lanUrls() : []) console.log(`[hl-quant] LAN: ${u}`);
  console.log(config.tokenFromEnv ? "[hl-quant] API token: from API_TOKEN" : `[hl-quant] API token: ${config.apiToken}  (saved in ${join(config.dataDir, "server.json")})`);
  if (config.host !== "127.0.0.1" && config.host !== "localhost") console.log("[hl-quant] WARNING: reachable from other machines; use a private network or HTTPS tunnel, never a public port.");
  bus.log("info", "system", "boss", `Server v${config.version} started (${config.mode}${config.testnet ? ", testnet" : ""})`);
  company.start();
  telegram.start();
});

// daily retention so history cannot grow without bound
setInterval(() => store.prune(90), 86_400_000).unref();

// clean shutdown keeps sqlite consistent and stops polling loops
function shutdown(sig: string) {
  console.log(`[hl-quant] ${sig}, shutting down`);
  company.shutdown();
  telegram.stop();
  for (const c of clients) c.end();
  server.close(() => {
    store.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
