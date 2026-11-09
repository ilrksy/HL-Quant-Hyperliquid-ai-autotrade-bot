import type { RiskParams } from "../core/risk";
import type { StrategyParams } from "../core/strategy";
import type { Regime, Side, Signal } from "../core/types";
import type { AccountSnapshot } from "../server/broker";

// roles that may call a language model; every other agent is deterministic
export type AiRole = "boss" | "ceo" | "research" | "auditor" | "intel";

// how much authority the ai layer has over execution
export type AiMode = "off" | "advisory" | "control";

// every persisted, user-editable server setting
export interface Settings {
  bot: {
    cycleSec: number;
    interval: "1m" | "5m" | "15m";
    universe: "manual" | "auto";
    coins: string[];
    scoutTopN: number;
    minVolumeUsd: number;
    maxSpreadBps: number;
    maxHoldHours: number;
    resumeOnRestart: boolean;
  };
  risk: RiskParams;
  strategy: StrategyParams;
  leverage: { mode: "auto" | "fixed"; fixed: number; volTargetPct: number; perCoin: Record<string, number> };
  ai: {
    mode: AiMode;
    minConfidence: number;
    researchTtlMin: number;
    ceoIntervalMin: number;
    auditIntervalMin: number;
    maxCallSec: number;
    deepResearch: { enabled: boolean; intervalMin: number; maxTokens: number };
  };
  intel: { sentiment: boolean; news: boolean; macro: boolean; crossFunding: boolean };
  telegram: {
    enabled: boolean;
    token: string;
    chatIds: string[];
    notify: { trades: boolean; risk: boolean; ai: boolean; daily: boolean; decisions: boolean };
  };
}

// recursive partial used by the settings patch endpoint
export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? (T[K] extends unknown[] ? T[K] : DeepPartial<T[K]>) : T[K] };

// live status shared by agents and pipeline stages
export type AgentStatus = "idle" | "working" | "ok" | "warn" | "error" | "off";

// one member of the trading company org chart
export interface AgentView {
  id: string;
  name: string;
  title: string;
  dept: "executive" | "research" | "risk" | "operations" | "audit";
  reportsTo: string | null;
  kind: "ai" | "quant" | "ops";
  duty: string;
  status: AgentStatus;
  lastAction: string;
  lastAt: number;
  runs: number;
  errors: number;
  avgMs: number;
  provider: string | null;
  model: string | null;
  tokens: number;
}

// ordered pipeline stages, matching the dashboard cards
export type StageId = "scout" | "quant" | "intel" | "research" | "risk" | "boss" | "audit" | "execute" | "monitor";

// one pipeline card: what the stage did in the last cycle
export interface StageView {
  id: StageId;
  n: number;
  title: string;
  agent: string;
  status: AgentStatus;
  metric: string;
  detail: string;
  ms: number;
  at: number;
}

// candidate counts surviving each filter in the latest cycle
export interface Funnel {
  scanned: number;
  candidates: number;
  researched: number;
  passedRisk: number;
  approved: number;
  passedAudit: number;
  executed: number;
}

// whole pipeline status for the command center
export interface PipelineView {
  active: boolean;
  armed: boolean;
  cycle: number;
  cycleSec: number;
  lastCycleAt: number;
  lastCycleMs: number;
  nextCycleAt: number;
  stages: StageView[];
  funnel: Funnel;
  lastError: string | null;
}

// strategic plan produced by the ceo agent
export interface CeoPlan {
  at: number;
  regime: "risk-on" | "neutral" | "risk-off";
  riskMultiplier: number;
  focus: string[];
  avoid: string[];
  bias: Record<string, "long" | "short" | "neutral">;
  summary: string;
  source: string;
}

// standing order from the boss that gates new entries
export interface BossDirective {
  at: number;
  mode: "normal" | "cautious" | "halt";
  until: number;
  note: string;
  source: string;
}

// periodic review written by the auditor
export interface AuditReport {
  at: number;
  grade: "A" | "B" | "C" | "D" | "F";
  issues: string[];
  recommendation: "continue" | "reduce-risk" | "pause";
  summary: string;
  source: string;
}

// full trail of one candidate through the pipeline
export interface DecisionView {
  id: number;
  ts: number;
  cycle: number;
  coin: string;
  side: Side;
  score: number;
  regime: Regime;
  stage: StageId;
  outcome: "executed" | "rejected" | "skipped" | "advisory" | "error";
  reason: string;
  research?: { decision: string; confidence: number; thesis: string; source: string };
  risk?: { ok: boolean; reason: string; notional: number; leverage: number; stopPx: number; takePx: number; riskUsd: number };
  boss?: { approve: boolean; size: number; note: string; source: string };
  audit?: { ok: boolean; issues: string[] };
}

// category of a history log entry
export type EventCat = "pipeline" | "ai" | "trade" | "risk" | "audit" | "system" | "telegram" | "intel";
// severity of a history log entry
export type EventLevel = "debug" | "info" | "success" | "warn" | "error";

// one row of the unified history log
export interface EventView {
  id: number;
  ts: number;
  level: EventLevel;
  cat: EventCat;
  agent: string;
  coin: string | null;
  cycle: number | null;
  msg: string;
  data?: unknown;
}

// outcome class of a single model request
export type AiCallStatus =
  | "ok" | "cached" | "rate_limited" | "auth" | "bad_request" | "server" | "timeout" | "network" | "bad_output";

// one row of the ai call log
export interface AiCallView {
  id: number;
  ts: number;
  role: AiRole;
  provider: string;
  keyLabel: string;
  model: string;
  status: AiCallStatus;
  http: number | null;
  latency: number;
  tokIn: number;
  tokOut: number;
  depth: number;
  error: string | null;
}

// key as shown to clients, never containing the secret
export interface KeyView {
  id: string;
  label: string;
  masked: string;
  enabled: boolean;
  state: "ready" | "cooldown" | "invalid" | "disabled" | "throttled";
  cooldownUntil: number;
  lastError: string | null;
  calls24h: number;
  ok24h: number;
  rateLimited24h: number;
  avgMs: number;
  tokens24h: number;
}

// provider as shown to clients
export interface ProviderView {
  id: string;
  preset: string;
  name: string;
  kind: "openai" | "antigravity";
  baseUrl: string;
  enabled: boolean;
  keyRequired: boolean;
  models: string[];
  rpm: number;
  timeoutSec: number;
  jsonMode: boolean;
  keys: KeyView[];
  circuitOpenUntil: number;
  health: "healthy" | "degraded" | "down" | "disabled" | "unconfigured";
  calls24h: number;
  ok24h: number;
  tokens24h: number;
  avgMs: number;
}

// one link in a role's fallback chain
export interface ChainLink {
  providerId: string;
  model: string;
}

// fallback chain for a role; empty chain means automatic ordering
export interface RouteView {
  role: AiRole;
  chain: ChainLink[];
  effective: ChainLink[];
}

// catalogue entry used by the add-provider dialog
export interface PresetView {
  id: string;
  name: string;
  kind: "openai" | "antigravity";
  baseUrl: string;
  keyRequired: boolean;
  models: string[];
  rpm: number;
  pricing: string;
  signupUrl: string;
  notes: string;
}

// external market intelligence gathered by the sentiment and macro workers
export interface IntelView {
  fearGreed: { value: number; label: string; at: number } | null;
  macro: { btcDominance: number; mcapChange24h: number; at: number } | null;
  news: { title: string; source: string; at: number; score: number; coins: string[] }[];
  newsScore: number;
  deepResearch: { at: number; summary: string; source: string } | null;
}

// one closed round trip as stored in history
export interface TradeView {
  id: string;
  mode: "paper" | "live";
  source: "bot" | "manual";
  coin: string;
  side: Side;
  size: number;
  entry: number;
  exit: number;
  pnl: number;
  fees: number;
  r: number;
  leverage: number;
  opened: number;
  closed: number;
  entryReason: string;
  exitReason: string;
}

// derived performance metrics for the profile page
export interface PortfolioStats {
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  netPnl: number;
  grossWin: number;
  grossLoss: number;
  profitFactor: number;
  avgR: number;
  expectancy: number;
  fees: number;
  best: number;
  worst: number;
  maxDrawdownPct: number;
  longestWinStreak: number;
  longestLossStreak: number;
  avgHoldMin: number;
  byCoin: { coin: string; trades: number; pnl: number; winRate: number }[];
  byDay: { day: string; pnl: number; trades: number }[];
  equity: { t: number; v: number }[];
  startEquity: number;
  ai: { calls24h: number; tokens24h: number; fallbacks24h: number; ruleDecisions24h: number };
}

// ai health summary for the top bar
export interface AiSummary {
  mode: AiMode;
  providers: { id: string; name: string; health: ProviderView["health"]; readyKeys: number; keys: number }[];
  calls24h: number;
  tokens24h: number;
  failures24h: number;
}

// everything the dashboard needs on each refresh
export interface AppState {
  version: string;
  mode: "paper" | "live";
  testnet: boolean;
  serverTime: number;
  account: AccountSnapshot | null;
  bot: { armed: boolean; halted: string | null; peakEquity: number; dayStartEquity: number;
    managed: Record<string, { side: Side; entryPx: number; initialStopPx: number; stopPx: number; openedAt: number; leverage: number }> };
  pipeline: PipelineView;
  agents: AgentView[];
  ceo: CeoPlan | null;
  directive: BossDirective | null;
  audit: AuditReport | null;
  signals: Record<string, Signal>;
  intel: IntelView;
  ai: AiSummary;
  decisions: DecisionView[];
  universe: string[];
}
