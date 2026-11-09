import { EventEmitter } from "node:events";
import { defaultRiskParams } from "../core/risk";
import { defaultStrategyParams } from "../core/strategy";
import type { DeepPartial, Settings } from "../shared/types";
import { config } from "./config";
import type { Store } from "./store";

// placeholder sent to clients instead of secrets; sending it back means "unchanged"
export const MASK = "••••••••";

// first-run settings, tuned for a $10 account and free-tier ai quotas
export function defaultSettings(): Settings {
  return {
    bot: {
      cycleSec: Math.min(300, Math.max(5, config.seed.cycleSec)), interval: config.seed.interval, universe: "manual",
      coins: config.seed.coins, scoutTopN: 12, minVolumeUsd: 20_000_000, maxSpreadBps: 8, maxHoldHours: 0, resumeOnRestart: false,
    },
    risk: { ...defaultRiskParams },
    strategy: { ...defaultStrategyParams },
    leverage: { mode: "auto", fixed: 3, volTargetPct: 30, perCoin: {} },
    ai: {
      mode: "control", minConfidence: 0.6, researchTtlMin: 60, ceoIntervalMin: 30, auditIntervalMin: 120, maxCallSec: 25,
      deepResearch: { enabled: false, intervalMin: 240, maxTokens: 60_000 },
    },
    intel: { sentiment: true, news: true, macro: true, crossFunding: true },
    telegram: { enabled: false, token: "", chatIds: [], notify: { trades: true, risk: true, ai: true, daily: true, decisions: false } },
  };
}

// clamps a numeric field, falling back to the default for garbage input
const num = (v: unknown, min: number, max: number, def: number, int = false) => {
  const n = Number(v);
  if (v === null || v === undefined || v === "" || !Number.isFinite(n)) return def;
  const c = Math.min(max, Math.max(min, n));
  return int ? Math.round(c) : c;
};
// strict boolean with default
const bool = (v: unknown, def: boolean) => (typeof v === "boolean" ? v : def);
// enum guard with default
const pick = <T extends string>(v: unknown, list: readonly T[], def: T): T => (list.includes(v as T) ? (v as T) : def);
// hyperliquid names are case-sensitive (kPEPE), so only trim and validate characters
const coinName = (v: unknown) => String(v ?? "").trim();
// deduplicated, validated coin list
const coinList = (v: unknown, def: string[]) =>
  Array.isArray(v) ? [...new Set(v.map(coinName).filter((c) => /^[A-Za-z0-9]{1,20}$/.test(c)))].slice(0, 40) : def;

// turns any merged object into a complete, bounded settings document
export function sanitize(raw: unknown): Settings {
  const d = defaultSettings();
  const r = (raw ?? {}) as DeepPartial<Settings>;
  const perCoin: Record<string, number> = {};
  for (const [k, v] of Object.entries(r.leverage?.perCoin ?? {})) {
    const c = coinName(k);
    if (/^[A-Za-z0-9]{1,20}$/.test(c) && Number.isFinite(Number(v))) perCoin[c] = num(v, 1, 50, 1, true);
  }
  return {
    bot: {
      cycleSec: num(r.bot?.cycleSec, 5, 300, d.bot.cycleSec, true),
      interval: pick(r.bot?.interval, ["1m", "5m", "15m"] as const, d.bot.interval),
      universe: pick(r.bot?.universe, ["manual", "auto"] as const, d.bot.universe),
      coins: coinList(r.bot?.coins, d.bot.coins),
      scoutTopN: num(r.bot?.scoutTopN, 1, 40, d.bot.scoutTopN, true),
      minVolumeUsd: num(r.bot?.minVolumeUsd, 0, 1e12, d.bot.minVolumeUsd),
      maxSpreadBps: num(r.bot?.maxSpreadBps, 0.5, 200, d.bot.maxSpreadBps),
      maxHoldHours: num(r.bot?.maxHoldHours, 0, 720, d.bot.maxHoldHours),
      resumeOnRestart: bool(r.bot?.resumeOnRestart, d.bot.resumeOnRestart),
    },
    risk: {
      riskPerTradePct: num(r.risk?.riskPerTradePct, 0.001, 0.1, d.risk.riskPerTradePct),
      maxLeverage: num(r.risk?.maxLeverage, 1, 50, d.risk.maxLeverage, true),
      maxPositions: num(r.risk?.maxPositions, 1, 10, d.risk.maxPositions, true),
      dailyLossLimitPct: num(r.risk?.dailyLossLimitPct, 0.005, 0.5, d.risk.dailyLossLimitPct),
      maxDrawdownPct: num(r.risk?.maxDrawdownPct, 0.02, 0.9, d.risk.maxDrawdownPct),
      stopAtr: num(r.risk?.stopAtr, 0.3, 10, d.risk.stopAtr),
      takeAtr: num(r.risk?.takeAtr, 0.3, 30, d.risk.takeAtr),
      breakevenAtR: num(r.risk?.breakevenAtR, 0.2, 10, d.risk.breakevenAtR),
      trailAtr: num(r.risk?.trailAtr, 0.3, 20, d.risk.trailAtr),
      cooldownMin: num(r.risk?.cooldownMin, 0, 1440, d.risk.cooldownMin),
      minNotional: num(r.risk?.minNotional, 10, 1e7, d.risk.minNotional),
      takerFee: num(r.risk?.takerFee, 0, 0.01, d.risk.takerFee),
      slippage: num(r.risk?.slippage, 0, 0.05, d.risk.slippage),
      maxCostR: num(r.risk?.maxCostR, 0.01, 5, d.risk.maxCostR),
    },
    strategy: {
      entryThreshold: num(r.strategy?.entryThreshold, 0.05, 1, d.strategy.entryThreshold),
      adxTrend: num(r.strategy?.adxTrend, 5, 80, d.strategy.adxTrend),
      adxChop: num(r.strategy?.adxChop, 0, 60, d.strategy.adxChop),
      minAtrPct: num(r.strategy?.minAtrPct, 0, 0.05, d.strategy.minAtrPct),
    },
    leverage: {
      mode: pick(r.leverage?.mode, ["auto", "fixed"] as const, d.leverage.mode),
      fixed: num(r.leverage?.fixed, 1, 50, d.leverage.fixed, true),
      volTargetPct: num(r.leverage?.volTargetPct, 5, 100, d.leverage.volTargetPct),
      perCoin,
    },
    ai: {
      mode: pick(r.ai?.mode, ["off", "advisory", "control"] as const, d.ai.mode),
      minConfidence: num(r.ai?.minConfidence, 0, 1, d.ai.minConfidence),
      researchTtlMin: num(r.ai?.researchTtlMin, 0, 1440, d.ai.researchTtlMin),
      ceoIntervalMin: num(r.ai?.ceoIntervalMin, 5, 1440, d.ai.ceoIntervalMin),
      auditIntervalMin: num(r.ai?.auditIntervalMin, 10, 1440, d.ai.auditIntervalMin),
      maxCallSec: num(r.ai?.maxCallSec, 5, 120, d.ai.maxCallSec),
      deepResearch: {
        enabled: bool(r.ai?.deepResearch?.enabled, d.ai.deepResearch.enabled),
        intervalMin: num(r.ai?.deepResearch?.intervalMin, 30, 1440, d.ai.deepResearch.intervalMin),
        maxTokens: num(r.ai?.deepResearch?.maxTokens, 5_000, 500_000, d.ai.deepResearch.maxTokens, true),
      },
    },
    intel: {
      sentiment: bool(r.intel?.sentiment, d.intel.sentiment),
      news: bool(r.intel?.news, d.intel.news),
      macro: bool(r.intel?.macro, d.intel.macro),
      crossFunding: bool(r.intel?.crossFunding, d.intel.crossFunding),
    },
    telegram: {
      enabled: bool(r.telegram?.enabled, d.telegram.enabled),
      token: typeof r.telegram?.token === "string" ? r.telegram.token.trim().slice(0, 120) : d.telegram.token,
      chatIds: Array.isArray(r.telegram?.chatIds)
        ? [...new Set(r.telegram.chatIds.map((x) => String(x).trim()).filter((x) => /^-?\d{3,20}$/.test(x)))].slice(0, 10)
        : d.telegram.chatIds,
      notify: {
        trades: bool(r.telegram?.notify?.trades, d.telegram.notify.trades),
        risk: bool(r.telegram?.notify?.risk, d.telegram.notify.risk),
        ai: bool(r.telegram?.notify?.ai, d.telegram.notify.ai),
        daily: bool(r.telegram?.notify?.daily, d.telegram.notify.daily),
        decisions: bool(r.telegram?.notify?.decisions, d.telegram.notify.decisions),
      },
    },
  };
}

// recursive merge where arrays and scalars replace, used for partial updates
function merge(base: unknown, patch: unknown): unknown {
  if (patch === undefined) return base;
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) return patch;
  const out: Record<string, unknown> = { ...((base as Record<string, unknown>) ?? {}) };
  for (const [k, v] of Object.entries(patch)) out[k] = merge((base as Record<string, unknown>)?.[k], v);
  return out;
}

// persisted settings with change notifications so workers pick up edits without a restart
export class SettingsStore extends EventEmitter {
  private s: Settings;

  // loads saved settings over defaults, so new fields appear automatically after upgrades
  constructor(private store: Store) {
    super();
    this.s = sanitize(merge(defaultSettings(), store.kvGet("settings") ?? {}));
    store.kvSet("settings", this.s);
  }

  // current validated settings
  get(): Settings {
    return this.s;
  }

  // validates a partial patch, keeps masked secrets unchanged, persists and notifies
  update(patch: DeepPartial<Settings>): Settings {
    const p = structuredClone(patch ?? {}) as DeepPartial<Settings>;
    if (p.telegram?.token !== undefined && String(p.telegram.token).startsWith("••")) delete p.telegram.token;
    const next = merge(this.s, p) as Settings;
    if (p.leverage?.perCoin) next.leverage.perCoin = p.leverage.perCoin as Record<string, number>;
    const prev = this.s;
    this.s = sanitize(next);
    this.store.kvSet("settings", this.s);
    this.emit("change", this.s, prev);
    return this.s;
  }

  // copy safe to send to any connected device
  masked(): Settings {
    const c = structuredClone(this.s);
    if (c.telegram.token) c.telegram.token = MASK;
    return c;
  }
}
