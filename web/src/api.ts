import type { BacktestResult } from "../../core/backtest";
import type { AccountSnapshot } from "../../server/broker";
import type {
  AiCallView, AiRole, AppState, AuditReport, CeoPlan, ChainLink, DecisionView, DeepPartial, EventView, PortfolioStats, PresetView,
  ProviderView, RouteView, Settings, TradeView,
} from "../../shared/types";

// re-exported so pages import every server type from one module
export type { AccountSnapshot, AppState, EventView };

// one saved server connection
export interface Conn {
  url: string;
  token: string;
}

// values injected by the electron preload when the desktop app hosts or knows the server
interface DesktopBootstrap {
  platform: string;
  version: string;
  hostMode: boolean;
  serverUrl: string | null;
  token: string | null;
}

declare global {
  // desktop bridge exposed through contextBridge
  interface Window { hlqDesktop?: DesktopBootstrap }
}

// localStorage key for the saved connection
const KEY = "hlq.conn";

// backtest response shape returned by the server
export type BacktestResponse = BacktestResult & { interval: string; days: number; from: number; to: number };

// result of testing one key of a provider
export interface KeyTest { keyId: string; label: string; ok: boolean; status: string; http: number | null; ms: number; error: string | null }

// telegram worker status for the settings page
export interface TelegramStatus { enabled: boolean; configured: boolean; polling: boolean; bot: string | null; chats: number; lastError: string | null; pairing: { until: number } | null }

// server network details for the devices panel
export interface ConnectionInfo { host: string; port: number; lan: string[]; localOnly: boolean; tokenFromEnv: boolean; dataDir: string }

// strips trailing slashes and adds a scheme when the user typed only host:port
export function normalizeUrl(u: string): string {
  let s = u.trim().replace(/\/+$/, "");
  if (s && !/^https?:\/\//i.test(s)) s = `http://${s}`;
  return s;
}

// picks the connection in priority order: desktop host mode, link fragment, saved, same-origin server
export function initialConn(): Conn | null {
  const d = window.hlqDesktop;
  if (d?.serverUrl && d.token) return { url: normalizeUrl(d.serverUrl), token: d.token };
  const hash = new URLSearchParams(location.hash.replace(/^#\/?[^?]*\??/, ""));
  const linkToken = hash.get("token") ?? new URLSearchParams(location.hash.slice(1)).get("token");
  if (linkToken) {
    const c = { url: normalizeUrl(hash.get("server") ?? location.origin), token: linkToken };
    history.replaceState(null, "", location.pathname + location.search);
    localStorage.setItem(KEY, JSON.stringify(c));
    return c;
  }
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "null") as Conn | null;
    if (saved?.url && saved.token) return saved;
  } catch {
    // corrupted entry: ignore
  }
  return null;
}

// the url to suggest on the connect screen
export function suggestedUrl(): string {
  if (/^https?:$/.test(location.protocol) && !["localhost", "127.0.0.1"].includes(location.hostname) || location.port === "8787")
    return location.origin;
  return "http://127.0.0.1:8787";
}

// active connection used by every request
let conn: Conn | null = null;

// current connection
export const getConn = () => conn;

// stores the connection for this and future sessions
export function setConn(c: Conn | null) {
  conn = c;
  if (c) localStorage.setItem(KEY, JSON.stringify(c));
  else localStorage.removeItem(KEY);
}

// error with the http status so callers can detect a revoked token
export class ApiError extends Error {
  // status is the http code, 0 for network failures
  constructor(public status: number, message: string) {
    super(message);
  }
}

// single fetch wrapper: base url, token header, json errors, timeout
async function call<T>(method: string, path: string, body?: unknown, c: Conn | null = conn): Promise<T> {
  if (!c) throw new ApiError(0, "not connected");
  let res: Response;
  try {
    res = await fetch(`${c.url}${path}`, {
      method, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(path.startsWith("/api/backtest") ? 120_000 : 30_000),
      headers: { "content-type": "application/json", "x-api-token": c.token },
    });
  } catch (e) {
    throw new ApiError(0, (e as Error).name === "TimeoutError" ? "server did not respond in time" : `cannot reach server (${(e as Error).message})`);
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (json as { error?: string }).error ?? `HTTP ${res.status}`);
  return json as T;
}

// query string from defined values only
const qs = (o: Record<string, string | number | undefined>) => {
  const p = Object.entries(o).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`);
  return p.length ? `?${p.join("&")}` : "";
};

// verifies a server url and token before saving them
export async function probe(c: Conn): Promise<{ version: string; mode: string }> {
  const h = await fetch(`${c.url}/api/health`, { signal: AbortSignal.timeout(8000) }).then((r) => r.json()).catch(() => null);
  if (!h?.ok) throw new Error("No HL Quant server answered at this address");
  await call("GET", "/api/settings", undefined, c);
  return h;
}

// typed endpoint map
export const api = {
  state: () => call<AppState>("GET", "/api/state"),
  arm: (confirm = false) => call("POST", "/api/bot/arm", { confirm }),
  disarm: () => call("POST", "/api/bot/disarm", {}),
  kill: () => call("POST", "/api/bot/kill", {}),
  cycle: () => call("POST", "/api/bot/cycle", {}),
  runCeo: () => call<CeoPlan>("POST", "/api/ceo/run", {}),
  runAudit: () => call<AuditReport>("POST", "/api/audit/run", {}),
  runDeep: () => call("POST", "/api/deep/run", {}),
  settings: () => call<Settings>("GET", "/api/settings"),
  saveSettings: (patch: DeepPartial<Settings>) => call<Settings>("PATCH", "/api/settings", patch),
  presets: () => call<PresetView[]>("GET", "/api/ai/presets"),
  providers: () => call<ProviderView[]>("GET", "/api/ai/providers"),
  addProvider: (b: { preset: string; name?: string; keys?: string[]; models?: string[]; baseUrl?: string }) => call<ProviderView>("POST", "/api/ai/providers", b),
  updateProvider: (id: string, patch: Record<string, unknown>) => call<ProviderView>("PATCH", `/api/ai/providers/${encodeURIComponent(id)}`, patch),
  removeProvider: (id: string) => call("DELETE", `/api/ai/providers/${encodeURIComponent(id)}`),
  testProvider: (id: string) => call<KeyTest[]>("POST", `/api/ai/providers/${encodeURIComponent(id)}/test`, {}),
  models: (id: string) => call<string[]>("GET", `/api/ai/providers/${encodeURIComponent(id)}/models`),
  moveProvider: (id: string, dir: -1 | 1) => call<ProviderView[]>("POST", `/api/ai/providers/${encodeURIComponent(id)}/move`, { dir }),
  resetProvider: (id: string) => call("POST", `/api/ai/providers/${encodeURIComponent(id)}/reset`, {}),
  routes: () => call<RouteView[]>("GET", "/api/ai/routes"),
  setRoute: (role: AiRole, chain: ChainLink[]) => call<RouteView[]>("PUT", `/api/ai/routes/${role}`, { chain }),
  aiCalls: (q: { role?: string; provider?: string; status?: string; before?: number; limit?: number } = {}) => call<AiCallView[]>("GET", `/api/ai/calls${qs(q)}`),
  logs: (q: Record<string, string | number | undefined> = {}) => call<EventView[]>("GET", `/api/logs${qs(q)}`),
  decisions: (q: Record<string, string | number | undefined> = {}) => call<DecisionView[]>("GET", `/api/decisions${qs(q)}`),
  cycles: (limit = 100) => call<{ id: number; ts: number; ms: number; scanned: number; candidates: number; proposals: number; approved: number; executed: number }[]>("GET", `/api/cycles?limit=${limit}`),
  trades: (q: Record<string, string | number | undefined> = {}) => call<TradeView[]>("GET", `/api/trades${qs(q)}`),
  portfolio: (range: string) => call<PortfolioStats>("GET", `/api/portfolio?range=${range}`),
  order: (o: Record<string, unknown>) => call<{ status: string; filledSize: number; avgPx: number }>("POST", "/api/order", o),
  close: (coin: string) => call("POST", "/api/close", { coin }),
  cancel: (coin: string, oid: number) => call("POST", "/api/cancel", { coin, oid }),
  resetPaper: (equity: number) => call("POST", "/api/paper/reset", { equity }),
  backtest: (coin: string, interval: string, days: number, equity: number) => call<BacktestResponse>("GET", `/api/backtest${qs({ coin, interval, days, equity })}`),
  telegramStatus: () => call<TelegramStatus>("GET", "/api/telegram/status"),
  telegramPair: () => call<{ code: string; until: number; bot: string | null }>("POST", "/api/telegram/pair", {}),
  telegramTest: () => call<{ chatId: string; ok: boolean; error: string | null }[]>("POST", "/api/telegram/test", {}),
  connection: () => call<ConnectionInfo>("GET", "/api/connection"),
};

// authenticated download url for csv/json exports
export function exportUrl(path: string, q: Record<string, string | number | undefined> = {}): string {
  return conn ? `${conn.url}${path}${qs({ ...q, token: conn.token })}` : "#";
}

// event stream url; EventSource cannot send headers, so the token rides in the query string
export function streamUrl(): string | null {
  return conn ? `${conn.url}/api/stream?token=${encodeURIComponent(conn.token)}` : null;
}
