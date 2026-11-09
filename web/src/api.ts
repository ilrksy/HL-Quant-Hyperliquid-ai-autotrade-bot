import type { BacktestResult } from "../../core/backtest";
import type { RiskParams } from "../../core/risk";
import type { StrategyParams } from "../../core/strategy";
import type { Side, Signal, TradeRecord } from "../../core/types";
import type { AccountSnapshot } from "../../server/broker";

// mirror of GET /api/state so components stay typed against the server contract
export interface AppState {
  mode: "paper" | "live";
  testnet: boolean;
  bot: {
    running: boolean;
    halted: string | null;
    lastTick: number;
    lastError: string | null;
    peakEquity: number;
    dayStartEquity: number;
    managed: Record<string, { side: Side; entryPx: number; initialStopPx: number; stopPx: number; openedAt: number }>;
    cooldown: Record<string, number>;
  };
  config: { coins: string[]; interval: string; loopSec: number; risk: RiskParams; strategy: StrategyParams };
  account: AccountSnapshot | null;
  signals: Record<string, Signal>;
  logs: { t: number; level: string; msg: string }[];
  trades: TradeRecord[];
  equityCurve: { t: number; equity: number }[];
}

export type BacktestResponse = BacktestResult & { interval: string; days: number; from: number; to: number };

// control endpoints may be token protected when the server is exposed beyond localhost
function headers(): HeadersInit {
  const token = localStorage.getItem("apiToken");
  return { "content-type": "application/json", ...(token ? { "x-api-token": token } : {}) };
}

// single fetch wrapper so every error surfaces with the server's message
async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, { method, headers: headers(), body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json as T;
}

// typed endpoints used by the dashboard
export const api = {
  state: () => call<AppState>("GET", "/api/state"),
  start: () => call("POST", "/api/bot/start"),
  stop: () => call("POST", "/api/bot/stop"),
  kill: () => call("POST", "/api/bot/kill"),
  config: (patch: Record<string, unknown>) => call("POST", "/api/config", patch),
  order: (o: Record<string, unknown>) => call<{ status: string }>("POST", "/api/order", o),
  close: (coin: string) => call("POST", "/api/close", { coin }),
  cancel: (coin: string, oid: number) => call("POST", "/api/cancel", { coin, oid }),
  resetPaper: (equity: number) => call("POST", "/api/paper/reset", { equity }),
  backtest: (coin: string, interval: string, days: number, equity: number) =>
    call<BacktestResponse>("GET", `/api/backtest?coin=${coin}&interval=${interval}&days=${days}&equity=${equity}`),
};
