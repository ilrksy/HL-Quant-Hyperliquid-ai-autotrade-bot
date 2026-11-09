import { formatSize } from "@nktkas/hyperliquid/utils";
import { INTERVAL_MS_PURE } from "../../core/intervals";
import { leverageFor, liquidationDistance } from "../../core/leverage";
import { riskGate, sizePosition, trailStop } from "../../core/risk";
import { evaluate } from "../../core/strategy";
import type { Side, Signal } from "../../core/types";
import type {
  AgentStatus, AppState, AuditReport, BossDirective, CeoPlan, DecisionView, Funnel, StageId, StageView, TradeView,
} from "../../shared/types";
import type { AiGateway } from "../ai/gateway";
import {
  type AuditContext, auditPrompt, bossPrompt, type CeoContext, ceoPrompt, deepPrompt, researchPrompt, SYSTEM,
  validateAudit, validateBoss, validateCeo, validateDeep, validateResearch,
} from "../ai/prompts";
import { intelFlags, rulesAudit, rulesBoss, rulesCeo, rulesResearch } from "../ai/rules";
import type { AccountSnapshot, Broker } from "../broker";
import type { Bus } from "../bus";
import type { Intel } from "../intel";
import { closedBars, type MarketData, type MarketInfo, resolveCoin } from "../market";
import type { SettingsStore } from "../settings";
import type { Store } from "../store";
import { Agents } from "./agents";
import type { Candidate, CandidateIntel, Opinion, Proposal, Verdict } from "./types";

// pipeline cards in display order with the agent that owns each stage
export const STAGES: { id: StageId; title: string; agent: string }[] = [
  { id: "scout", title: "Perp Scout", agent: "scout" },
  { id: "quant", title: "Quant Engine", agent: "quant" },
  { id: "intel", title: "Market Intel", agent: "sentiment" },
  { id: "research", title: "AI Research", agent: "research" },
  { id: "risk", title: "Risk Guard", agent: "guard" },
  { id: "boss", title: "Boss Approval", agent: "boss" },
  { id: "audit", title: "Pre-trade Audit", agent: "auditor" },
  { id: "execute", title: "L1 Execution", agent: "trader" },
  { id: "monitor", title: "TP/SL Monitor", agent: "monitor" },
];

// everything the company needs from the outside world, injectable for tests
export interface CompanyDeps {
  broker: Broker;
  store: Store;
  bus: Bus;
  settings: SettingsStore;
  ai: AiGateway;
  intel: Intel;
  market: MarketData;
}

// a position the bot opened and is responsible for
interface Managed {
  side: Side;
  entryPx: number;
  initialStopPx: number;
  stopPx: number;
  takePx: number;
  openedAt: number;
  leverage: number;
  size: number;
  reason: string;
  exitReason?: string;
}

// company memory that must survive restarts, otherwise a restart could bypass risk limits
interface Persisted {
  managed: Record<string, Managed>;
  peakEquity: number;
  dayStartEquity: number;
  day: number;
  cooldown: Record<string, number>;
  ceo: CeoPlan | null;
  directive: BossDirective | null;
  audit: AuditReport | null;
  lastCeoAt: number;
  lastAuditAt: number;
  lastDeepAt: number;
  armed: boolean;
  halted: string | null;
  tradesSinceAudit: number;
  lastPaperSync: number;
}

// what a stage returns to the bookkeeping wrapper
interface StageOut<T> {
  value: T;
  metric: string;
  detail?: string;
  status?: AgentStatus;
  agent?: { provider?: string | null; model?: string | null; tokens?: number };
}

// running record of one candidate's path through the stages
interface Trail {
  cand: Candidate;
  stage: StageId;
  outcome: DecisionView["outcome"];
  reason: string;
  research?: DecisionView["research"];
  risk?: DecisionView["risk"];
  boss?: DecisionView["boss"];
  audit?: DecisionView["audit"];
}

// placeholder until the intel workers fill a candidate in
const EMPTY_INTEL: CandidateIntel = {
  imbalance: 0, spreadBps: 0, funding: 0, xFunding: null, premium: 0, change24h: 0, volumeUsd: 0, oiUsd: 0, news: 0, flags: [],
};

// all-zero funnel
const emptyFunnel = (): Funnel => ({ scanned: 0, candidates: 0, researched: 0, passedRisk: 0, approved: 0, passedAudit: 0, executed: 0 });

// bounded concurrency so a large universe cannot burst through exchange rate limits
async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const out: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try {
        out[i] = { status: "fulfilled", value: await fn(items[i]) };
      } catch (reason) {
        out[i] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// hh:mm in utc for log lines
const hhmm = (t: number) => new Date(t).toISOString().slice(11, 16);
// price formatting for log lines
const fp = (x: number) => (x >= 1000 ? x.toFixed(1) : x >= 1 ? x.toFixed(4) : x.toPrecision(5));

// the trading company: workers, managers, ceo, auditor and the boss running a filtered pipeline every cycle
export class Company {
  readonly agents = new Agents();
  signals: Record<string, Signal> = {};
  universe: string[] = [];
  snapshot: AccountSnapshot | null = null;
  stages: Record<StageId, StageView>;
  funnel: Funnel = emptyFunnel();
  recent: DecisionView[] = [];
  cycleNo: number;
  lastCycleAt = 0;
  lastCycleMs = 0;
  nextCycleAt = 0;
  lastError: string | null = null;
  private p: Persisted;
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private running = false;
  private memo = new Map<string, { key: string; at: number; op: Opinion }>();
  private decided = new Map<string, number>();
  private lastEquityAt = 0;
  private lastErrorLogAt = 0;
  private ceoBusy = false;
  private auditBusy = false;
  private deepBusy = false;

  // restores persisted state; autotrade only resumes after a restart when the user opted in
  constructor(private d: CompanyDeps) {
    const saved = d.store.kvGet<Partial<Persisted>>(`company.${d.broker.mode}`) ?? {};
    this.p = {
      managed: {}, peakEquity: 0, dayStartEquity: 0, day: -1, cooldown: {}, ceo: null, directive: null, audit: null,
      lastCeoAt: 0, lastAuditAt: 0, lastDeepAt: 0, armed: false, halted: null, tradesSinceAudit: 0, lastPaperSync: 0, ...saved,
    };
    if (!d.settings.get().bot.resumeOnRestart) this.p.armed = false;
    this.cycleNo = d.store.lastCycleId();
    this.stages = Object.fromEntries(STAGES.map((s, i) => [s.id, {
      id: s.id, n: i + 1, title: s.title, agent: s.agent, status: "idle", metric: "waiting", detail: "", ms: 0, at: 0,
    }])) as Record<StageId, StageView>;
    d.settings.on("change", (next: { bot: { cycleSec: number; interval: string } }, prev: { bot: { cycleSec: number; interval: string } }) => {
      if (next.bot.interval !== prev.bot.interval) {
        this.memo.clear();
        this.decided.clear();
      }
      if (next.bot.cycleSec !== prev.bot.cycleSec && this.running) this.schedule(Math.min(next.bot.cycleSec * 1000, Math.max(0, this.nextCycleAt - Date.now())));
    });
  }

  // persists company memory under the current trading mode
  private save() {
    this.d.store.kvSet(`company.${this.d.broker.mode}`, this.p);
  }

  // starts the 24/7 loop
  start() {
    this.running = true;
    this.d.bus.log("info", "system", "boss", `Company online · ${this.d.broker.mode.toUpperCase()} · autotrade ${this.p.armed ? "ARMED" : "standby"}`);
    this.schedule(0);
  }

  // stops the loop on shutdown
  shutdown() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
  }

  // timer management without overlapping cycles
  private schedule(ms: number) {
    if (this.timer) clearTimeout(this.timer);
    this.nextCycleAt = Date.now() + ms;
    this.timer = setTimeout(async () => {
      const t0 = Date.now();
      await this.cycle();
      if (this.running) this.schedule(Math.max(1000, this.d.settings.get().bot.cycleSec * 1000 - (Date.now() - t0)));
    }, ms);
  }

  // runs the next cycle immediately, e.g. after the user arms the bot
  runNow() {
    if (this.running && !this.busy) this.schedule(0);
  }

  // arms execution; analysis always runs, orders only flow while armed
  arm() {
    this.p.armed = true;
    this.p.halted = null;
    this.save();
    this.d.bus.log("success", "system", "boss", `Autotrade ARMED (${this.d.broker.mode})`);
    this.runNow();
  }

  // disarms new entries while exchange-side stops keep protecting open positions
  disarm(reason = "stopped by user") {
    this.p.armed = false;
    this.save();
    this.d.bus.log("warn", "system", "boss", `Autotrade OFF: ${reason}`);
  }

  // emergency flatten of every bot position plus disarm
  async kill(reason: string) {
    this.p.armed = false;
    this.p.halted = reason;
    for (const [coin, m] of Object.entries(this.p.managed)) {
      try {
        m.exitReason = "kill switch";
        await this.d.broker.close(coin, "kill switch");
        this.d.bus.log("warn", "trade", "trader", `${coin} closed by kill switch`, { coin });
      } catch (e) {
        this.d.bus.log("error", "trade", "trader", `${coin} close failed: ${(e as Error).message}`, { coin });
      }
    }
    this.save();
    this.d.bus.log("error", "risk", "guard", `KILL SWITCH: ${reason}`);
  }

  // clears risk references after a paper reset so an old peak cannot trip the kill switch
  resetRisk() {
    this.p = { ...this.p, managed: {}, peakEquity: 0, dayStartEquity: 0, day: -1, cooldown: {}, halted: null, lastPaperSync: 0, tradesSinceAudit: 0 };
    this.decided.clear();
    this.memo.clear();
    this.save();
  }

  // bookkeeping wrapper: timing, card status, agent status
  private async stage<T>(id: StageId, fn: () => Promise<StageOut<T>>): Promise<T> {
    const meta = STAGES.find((x) => x.id === id)!;
    const st = this.stages[id];
    st.status = "working";
    this.agents.start(meta.agent, meta.title);
    const t0 = Date.now();
    try {
      const out = await fn();
      const ms = Date.now() - t0;
      Object.assign(st, { status: out.status ?? "ok", metric: out.metric, detail: out.detail ?? "", ms, at: Date.now() });
      this.agents.done(meta.agent, out.status ?? "ok", out.metric, ms, out.agent ?? {});
      return out.value;
    } catch (e) {
      const msg = (e as Error).message;
      Object.assign(st, { status: "error", metric: "error", detail: msg.slice(0, 200), ms: Date.now() - t0, at: Date.now() });
      this.agents.done(meta.agent, "error", msg.slice(0, 120), Date.now() - t0);
      throw e;
    }
  }

  // marks downstream cards idle when an earlier filter removed everything
  private idle(ids: StageId[], metric: string, detail = "") {
    for (const id of ids) Object.assign(this.stages[id], { status: "idle", metric, detail, ms: 0, at: Date.now() });
  }

  // currently binding directive, if any
  activeDirective(): BossDirective | null {
    const d = this.p.directive;
    return d && d.mode !== "normal" && d.until > Date.now() ? d : null;
  }

  // changes the company directive; an auditor halt cannot be lifted early by the boss
  private setDirective(mode: BossDirective["mode"], minutes: number, note: string, source: string) {
    const cur = this.activeDirective();
    const now = Date.now();
    if (mode === "normal") {
      if (cur && !cur.source.startsWith("auditor")) {
        this.p.directive = null;
        this.d.bus.log("info", "risk", "boss", `Directive back to NORMAL (${source})`);
      }
      return;
    }
    if (cur && cur.mode === mode) {
      cur.until = Math.max(cur.until, now + minutes * 60_000);
      return;
    }
    if (cur?.mode === "halt" && mode === "cautious") return;
    this.p.directive = { at: now, mode, until: now + minutes * 60_000, note, source };
    this.d.bus.log("warn", "risk", source.startsWith("auditor") ? "auditor" : "boss",
      `Directive ${mode.toUpperCase()} until ${hhmm(now + minutes * 60_000)} UTC: ${note || "no note"} (${source})`);
  }

  // one full pass: account refresh, position care, then the entry pipeline
  async cycle(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    const s = this.d.settings.get();
    const c = ++this.cycleNo;
    const t0 = Date.now();
    const f = emptyFunnel();
    const trails = new Map<string, Trail>();
    const trail = (cn: Candidate, patch: Partial<Trail>) => {
      const t = trails.get(cn.coin) ?? { cand: cn, stage: "quant" as StageId, outcome: "skipped" as const, reason: "" };
      Object.assign(t, patch);
      trails.set(cn.coin, t);
    };
    const downstream: StageId[] = ["intel", "research", "risk", "boss", "audit", "execute"];
    try {
      const [mkt, mids] = await Promise.all([this.d.market.snapshot(), this.d.market.mids()]);
      this.d.broker.onPrices(mids);
      const snap = await this.d.broker.snapshot();
      this.snapshot = snap;
      this.accounting(snap, s);
      await this.monitor(snap, s, c);
      void this.d.intel.refresh(s);
      if (this.p.directive && this.p.directive.until <= Date.now()) {
        this.d.bus.log("info", "risk", "boss", `Directive ${this.p.directive.mode.toUpperCase()} expired`);
        this.p.directive = null;
      }

      const universe = await this.stage("scout", async () => {
        let list: string[];
        if (s.bot.universe === "auto") {
          list = [...mkt.values()]
            .filter((m) => m.volumeUsd >= s.bot.minVolumeUsd && m.spreadBps <= s.bot.maxSpreadBps && m.maxLeverage >= 3 && m.markPx > 0)
            .sort((a, b) => b.volumeUsd - a.volumeUsd).slice(0, s.bot.scoutTopN).map((m) => m.name);
        } else {
          list = s.bot.coins.map((x) => resolveCoin(mkt, x)).filter((x): x is string => !!x);
        }
        const held = [...snap.positions.map((p) => p.coin), ...Object.keys(this.p.managed)].filter((x) => mkt.has(x));
        const all = [...new Set([...list, ...held])];
        this.universe = all;
        return { value: all, metric: `${all.length} markets live`, detail: `${mkt.size} perps listed · ${s.bot.universe} universe` };
      });
      f.scanned = universe.length;

      const intervalMs = INTERVAL_MS_PURE[s.bot.interval];
      const cands = await this.stage("quant", async () => {
        const results = await mapLimit(universe, 6, async (coin) => {
          const [ltf, htf] = await Promise.all([this.d.market.candles(coin, s.bot.interval, 400), this.d.market.candles(coin, "1h", 250)]);
          return evaluate(coin, closedBars(ltf, s.bot.interval), closedBars(htf, "1h"), { funding: mkt.get(coin)?.funding }, s.strategy);
        });
        const sigs: Record<string, Signal> = {};
        let failed = 0;
        results.forEach((r, i) => (r.status === "fulfilled" ? (sigs[universe[i]] = r.value) : failed++));
        this.signals = sigs;
        const now = Date.now();
        const out: Candidate[] = [];
        let cooling = 0;
        for (const sig of Object.values(sigs)) {
          if (sig.action === "flat") continue;
          if (this.p.managed[sig.coin] || snap.positions.some((p) => p.coin === sig.coin)) continue;
          if ((this.p.cooldown[sig.coin] ?? 0) > now) { cooling++; continue; }
          if (now - (sig.time + intervalMs) > 2 * intervalMs) continue;
          if (this.decided.has(`${sig.coin}|${sig.action}|${sig.time}`)) continue;
          out.push({ coin: sig.coin, side: sig.action as Side, signal: sig, market: mkt.get(sig.coin)!, intel: { ...EMPTY_INTEL } });
        }
        out.sort((a, b) => Math.abs(b.signal.score) - Math.abs(a.signal.score));
        const top = out[0];
        return {
          value: out.slice(0, 6),
          metric: `${out.length} candidate${out.length === 1 ? "" : "s"}`,
          detail: top ? `${top.coin} ${top.side} score ${top.signal.score.toFixed(2)} (${top.signal.regime})`
            : `EMA 9/21 · RSI · ADX · VWAP z${cooling ? ` · ${cooling} cooling down` : ""}${failed ? ` · ${failed} data errors` : ""}`,
          status: failed ? "warn" : out.length ? "ok" : "idle",
        };
      });
      f.candidates = cands.length;

      if (!this.ceoBusy && (!this.p.ceo || (this.p.armed && Date.now() - this.p.lastCeoAt >= s.ai.ceoIntervalMin * 60_000))) await this.runCeo(mkt);
      if (!this.auditBusy && this.p.armed && (Date.now() - this.p.lastAuditAt >= s.ai.auditIntervalMin * 60_000 || this.p.tradesSinceAudit >= 5)) await this.runAudit();
      if (s.ai.deepResearch.enabled && this.p.armed && !this.deepBusy && Date.now() - this.p.lastDeepAt >= s.ai.deepResearch.intervalMin * 60_000) void this.runDeepResearch();

      if (!cands.length) {
        this.idle(downstream, "no candidates");
        return;
      }

      await this.stage("intel", async () => {
        this.agents.start("flow", "reading order books");
        this.agents.start("derivs", "funding and open interest");
        const t1 = Date.now();
        const xf = s.intel.crossFunding ? await this.d.market.crossFunding().catch(() => new Map<string, number>()) : new Map<string, number>();
        const books = await mapLimit(cands, 4, (cn) => this.d.market.book(cn.coin));
        cands.forEach((cn, i) => {
          const b = books[i].status === "fulfilled" ? books[i].value : { imbalance: 0, spreadBps: cn.market.spreadBps };
          const base = {
            imbalance: b.imbalance, spreadBps: b.spreadBps, funding: cn.market.funding, xFunding: xf.get(cn.coin) ?? null,
            premium: cn.market.premium, change24h: cn.market.change24h, volumeUsd: cn.market.volumeUsd, oiUsd: cn.market.oiUsd,
            news: s.intel.news ? this.d.intel.newsScore(cn.coin) : 0,
          };
          cn.intel = { ...base, flags: intelFlags({ ...cn, intel: base }, s.bot.maxSpreadBps) };
        });
        this.agents.done("flow", "ok", `${cands.length} books read`, Date.now() - t1);
        this.agents.done("derivs", "ok", `funding/OI for ${cands.length}`, Date.now() - t1);
        const fg = this.d.intel.fearGreed;
        const flags = cands.reduce((a, cn) => a + cn.intel.flags.length, 0);
        return { value: null, metric: `${cands.length} enriched`, detail: `${fg ? `F&G ${fg.value} · ` : ""}news ${this.d.intel.newsScore().toFixed(2)} · ${flags} red flag${flags === 1 ? "" : "s"}` };
      });

      const opinions = await this.stage("research", async () => {
        const result = new Map<string, Opinion>();
        if (!this.p.armed) return { value: result, metric: "standby", detail: "autotrade off: research paused to save tokens", status: "idle" as AgentStatus };
        const plan = this.p.ceo;
        const need: Candidate[] = [];
        for (const cn of cands) {
          const key = `${cn.side}|${cn.signal.time}`;
          const m = this.memo.get(cn.coin);
          if (m && m.key === key && Date.now() - m.at < s.ai.researchTtlMin * 60_000) result.set(cn.coin, { ...m.op, source: `${m.op.source} (memo)` });
          else need.push(cn);
        }
        let via = need.length ? "rules engine" : "memo";
        let agent: StageOut<unknown>["agent"] = { provider: "rules", model: null };
        if (need.length) {
          const rules = need.map((cn) => rulesResearch(cn, plan, s));
          if (s.ai.mode === "off") {
            need.forEach((cn, i) => result.set(cn.coin, rules[i]));
            via = "rules engine (AI off)";
          } else {
            const ask = need.filter((cn) => !plan?.avoid.includes(cn.coin));
            const res = ask.length
              ? await this.d.ai.complete({
                role: "research", system: SYSTEM.research, prompt: researchPrompt(ask, plan, this.d.intel.view(), this.d.intel.headlines(5).map((h) => h.title)),
                maxTokens: 300 + 160 * ask.length, deadlineMs: s.ai.maxCallSec * 1000, validate: validateResearch(ask.length),
              })
              : null;
            need.forEach((cn, i) => {
              const idx = ask.indexOf(cn);
              const ai = res?.ok && idx >= 0 ? res.value!.get(idx + 1) : undefined;
              let op: Opinion = rules[i];
              if (ai && res) {
                const src = `${res.providerName}/${res.model}`;
                const aiOp: Opinion = ai.decision !== "skip" && ai.decision !== cn.side
                  ? { ...ai, decision: "skip", thesis: `contradicts quant: ${ai.thesis}`, source: src }
                  : { ...ai, source: src };
                if (s.ai.mode === "control") op = aiOp;
                else this.d.bus.log("info", "ai", "research", `[advisory] ${cn.coin}: AI ${aiOp.decision} ${aiOp.confidence.toFixed(2)} vs rules ${op.decision} ${op.confidence.toFixed(2)}`, { coin: cn.coin, cycle: c });
              }
              result.set(cn.coin, op);
              this.memo.set(cn.coin, { key: `${cn.side}|${cn.signal.time}`, at: Date.now(), op });
            });
            if (res?.ok) {
              via = `${res.providerName} · ${res.model}${res.depth ? ` (fallback #${res.depth})` : ""}`;
              agent = { provider: res.providerName, model: res.model, tokens: res.tokensIn + res.tokensOut };
            } else if (res) {
              via = "rules engine (AI unavailable)";
              this.d.bus.log("warn", "ai", "research", `AI unavailable, rules engine decided. ${res.error}`, { cycle: c, data: { attempts: res.attempts } });
            }
          }
        }
        let confirmed = 0;
        for (const cn of cands) {
          const op = result.get(cn.coin)!;
          const ok = op.decision === cn.side && op.confidence >= s.ai.minConfidence;
          if (ok) confirmed++;
          trail(cn, {
            stage: "research", outcome: ok ? "skipped" : "rejected", reason: ok ? "" : `research: ${op.decision === "skip" ? "skip" : "low confidence"} (${op.confidence.toFixed(2)}) ${op.thesis}`,
            research: { decision: op.decision, confidence: op.confidence, thesis: op.thesis, source: op.source },
          });
        }
        return { value: result, metric: `${confirmed}/${cands.length} confirmed`, detail: via, agent };
      });
      if (!this.p.armed) {
        this.idle(["risk", "boss", "audit", "execute"], "standby", "arm autotrade to execute");
        return;
      }
      const confirmed = cands.filter((cn) => {
        const op = opinions.get(cn.coin);
        return op && op.decision === cn.side && op.confidence >= s.ai.minConfidence;
      });
      f.researched = confirmed.length;
      if (!confirmed.length) {
        this.idle(["risk", "boss", "audit", "execute"], "nothing confirmed");
        return;
      }

      const open = Math.max(snap.positions.length, Object.keys(this.p.managed).length);
      const slots = Math.max(0, s.risk.maxPositions - open);
      const props = await this.stage("risk", async () => {
        const gate = riskGate({ equity: snap.equity, peakEquity: this.p.peakEquity, dayStartEquity: this.p.dayStartEquity, openPositions: open }, s.risk);
        if (!gate.ok) {
          for (const cn of confirmed) trail(cn, { stage: "risk", outcome: "rejected", reason: gate.reason });
          if (gate.reason.startsWith("KILL")) await this.kill(gate.reason);
          return { value: [] as Proposal[], metric: "blocked", detail: gate.reason, status: (gate.reason.startsWith("KILL") ? "error" : "warn") as AgentStatus };
        }
        const dir = this.activeDirective();
        if (dir?.mode === "halt") {
          const why = `directive HALT until ${hhmm(dir.until)} UTC (${dir.source})`;
          for (const cn of confirmed) trail(cn, { stage: "risk", outcome: "rejected", reason: why });
          return { value: [] as Proposal[], metric: "halted", detail: why, status: "warn" as AgentStatus };
        }
        const riskMult = Math.min(1, (this.p.ceo?.riskMultiplier ?? 1) * (dir?.mode === "cautious" ? 0.5 : 1));
        const equity = snap.available > 0 ? Math.min(snap.equity, snap.available) : snap.equity;
        const out: Proposal[] = [];
        for (const cn of confirmed) {
          const op = opinions.get(cn.coin)!;
          const lev = leverageFor(cn.signal.atr / cn.signal.price, s.bot.interval, cn.market.maxLeverage, {
            mode: s.leverage.mode, fixed: s.leverage.fixed, volTargetPct: s.leverage.volTargetPct, userCap: s.risk.maxLeverage,
            perCoinCap: s.leverage.perCoin[cn.coin],
          });
          this.agents.done("leverage", "ok", `${cn.coin}: ${lev.reason}`, 0);
          const sizing = sizePosition(equity, cn.signal.price, cn.signal.atr, cn.side, lev.cap, { ...s.risk, riskPerTradePct: s.risk.riskPerTradePct * riskMult });
          const riskView = { ok: sizing.ok, reason: sizing.reason, notional: sizing.notional, leverage: sizing.leverage, stopPx: sizing.stopPx, takePx: sizing.takePx, riskUsd: sizing.riskUsd };
          if (!sizing.ok) {
            trail(cn, { stage: "risk", outcome: "rejected", reason: `risk: ${sizing.reason}`, risk: riskView });
            continue;
          }
          let size = Number(formatSize(sizing.size, cn.market.szDecimals));
          if (size * cn.signal.price < s.risk.minNotional) size = Number(formatSize(size + 10 ** -cn.market.szDecimals, cn.market.szDecimals));
          if (!(size > 0)) {
            trail(cn, { stage: "risk", outcome: "rejected", reason: "risk: size rounds to zero", risk: riskView });
            continue;
          }
          const rr = Math.abs(sizing.takePx - cn.signal.price) / Math.abs(cn.signal.price - sizing.stopPx);
          trail(cn, { stage: "risk", risk: { ...riskView, notional: size * cn.signal.price } });
          out.push({ id: out.length + 1, cand: cn, opinion: op, leverage: lev, sizing, size, riskMult, rr });
        }
        out.sort((a, b) => b.opinion.confidence - a.opinion.confidence);
        const kept = out.slice(0, slots);
        for (const p of out.slice(slots)) trail(p.cand, { stage: "risk", outcome: "rejected", reason: `no free position slot (${open}/${s.risk.maxPositions})` });
        kept.forEach((p, i) => (p.id = i + 1));
        return {
          value: kept, metric: `${kept.length} sized`,
          detail: `risk x${riskMult.toFixed(2)} · ${slots} slot${slots === 1 ? "" : "s"} · ${dir ? `directive ${dir.mode}` : "directive normal"}`,
          status: (kept.length ? "ok" : "warn") as AgentStatus,
        };
      });
      f.passedRisk = props.length;
      if (!props.length) {
        this.idle(["boss", "audit", "execute"], "nothing to approve");
        return;
      }

      const approved = await this.stage("boss", async () => {
        const rules = rulesBoss(props, slots, this.p.audit, s);
        let verdicts: Verdict[] = rules.verdicts;
        let directive = rules.directive;
        let note = rules.note;
        let via = "rules engine";
        let agent: StageOut<unknown>["agent"] = { provider: "rules", model: null };
        if (s.ai.mode !== "off") {
          const dayPnl = snap.equity - this.p.dayStartEquity;
          const res = await this.d.ai.complete({
            role: "boss", system: SYSTEM.boss, maxTokens: 260 + 110 * props.length, deadlineMs: s.ai.maxCallSec * 1000,
            prompt: bossPrompt(props, {
              equity: snap.equity, available: snap.available, open, maxPositions: s.risk.maxPositions, dayPnl,
              dayPnlPct: this.p.dayStartEquity ? (dayPnl / this.p.dayStartEquity) * 100 : 0,
              drawdownPct: this.p.peakEquity ? ((this.p.peakEquity - snap.equity) / this.p.peakEquity) * 100 : 0,
              killPct: Math.round(s.risk.maxDrawdownPct * 100), streak: this.streak(), plan: this.p.ceo, audit: this.p.audit,
              directive: this.activeDirective(),
            }),
            validate: validateBoss(props.length),
          });
          if (res.ok) {
            const src = `${res.providerName}/${res.model}`;
            const ai = props.map((_, i) => {
              const v = res.value!.decisions.get(i + 1);
              return v ? { ...v, source: src } : rules.verdicts[i];
            });
            agent = { provider: res.providerName, model: res.model, tokens: res.tokensIn + res.tokensOut };
            if (s.ai.mode === "control") {
              verdicts = ai;
              directive = res.value!.directive;
              note = res.value!.note;
              via = `${res.providerName} · ${res.model}${res.depth ? ` (fallback #${res.depth})` : ""}`;
            } else {
              this.d.bus.log("info", "ai", "boss", `[advisory] Boss AI: ${ai.map((v, i) => `${props[i].cand.coin} ${v.approve ? "approve" : "reject"}`).join(", ")}; directive ${res.value!.directive}`, { cycle: c });
            }
          } else {
            via = "rules engine (AI unavailable)";
            this.d.bus.log("warn", "ai", "boss", `Boss AI unavailable, rules engine decided. ${res.error}`, { cycle: c, data: { attempts: res.attempts } });
          }
        }
        if (directive === "halt") this.setDirective("halt", 60, note, via.startsWith("rules") ? "rules" : `boss ${via}`);
        else if (directive === "cautious") this.setDirective("cautious", 120, note, via.startsWith("rules") ? "rules" : `boss ${via}`);
        else this.setDirective("normal", 0, note, via);
        const out: Proposal[] = [];
        props.forEach((p, i) => {
          const v = verdicts[i];
          const halted = this.activeDirective()?.mode === "halt";
          const ok = v.approve && out.length < slots && !halted;
          trail(p.cand, {
            stage: "boss", outcome: ok ? "skipped" : "rejected",
            reason: ok ? "" : halted ? "boss set directive HALT" : v.approve ? "no free slot" : `boss: ${v.note || "rejected"}`,
            boss: { approve: ok, size: v.size, note: v.note, source: v.source },
          });
          if (!ok) return;
          if (v.size < 1) {
            const equity = snap.available > 0 ? Math.min(snap.equity, snap.available) : snap.equity;
            const scaled = sizePosition(equity, p.cand.signal.price, p.cand.signal.atr, p.cand.side, p.leverage.cap,
              { ...s.risk, riskPerTradePct: s.risk.riskPerTradePct * p.riskMult * v.size });
            if (!scaled.ok) {
              trail(p.cand, { outcome: "rejected", reason: `boss size x${v.size} not tradable: ${scaled.reason}` });
              return;
            }
            p.sizing = scaled;
            p.size = Number(formatSize(scaled.size, p.cand.market.szDecimals));
            if (p.size * p.cand.signal.price < s.risk.minNotional) p.size = Number(formatSize(p.size + 10 ** -p.cand.market.szDecimals, p.cand.market.szDecimals));
          }
          out.push(p);
        });
        return { value: out, metric: `${out.length}/${props.length} approved`, detail: via, agent, status: (out.length ? "ok" : "warn") as AgentStatus };
      });
      f.approved = approved.length;
      if (!approved.length) {
        this.idle(["audit", "execute"], "nothing approved");
        return;
      }

      const audited = await this.stage("audit", async () => {
        const live = await this.d.market.mids();
        const out: Proposal[] = [];
        for (const p of approved) {
          const issues = this.preTradeAudit(p, live[p.cand.coin], snap, s);
          trail(p.cand, { stage: "audit", audit: { ok: !issues.length, issues }, ...(issues.length ? { outcome: "rejected" as const, reason: `audit: ${issues.join("; ")}` } : {}) });
          if (issues.length) this.d.bus.log("warn", "audit", "auditor", `${p.cand.coin} blocked: ${issues.join("; ")}`, { coin: p.cand.coin, cycle: c });
          else out.push(p);
        }
        return { value: out, metric: `${out.length}/${approved.length} passed`, detail: "side, R:R, liquidation, caps, drift, freshness", status: (out.length ? "ok" : "warn") as AgentStatus };
      });
      f.passedAudit = audited.length;
      if (!audited.length) {
        this.idle(["execute"], "nothing passed audit");
        return;
      }

      f.executed = await this.stage("execute", async () => {
        let n = 0;
        for (const p of audited) {
          const cn = p.cand;
          try {
            const res = await this.d.broker.open({
              coin: cn.coin, side: cn.side, size: p.size, leverage: p.sizing.leverage, stopPx: p.sizing.stopPx, takePx: p.sizing.takePx,
              reason: `[bot] ${p.opinion.source}: ${p.opinion.thesis}`.slice(0, 220),
            });
            if (res.filledSize <= 0) {
              trail(cn, { stage: "execute", outcome: "error", reason: `entry not filled (${res.status})` });
              this.d.bus.log("warn", "trade", "trader", `${cn.coin} entry not filled (${res.status})`, { coin: cn.coin, cycle: c });
              continue;
            }
            n++;
            this.p.managed[cn.coin] = {
              side: cn.side, entryPx: res.avgPx, initialStopPx: p.sizing.stopPx, stopPx: p.sizing.stopPx, takePx: p.sizing.takePx,
              openedAt: Date.now(), leverage: p.sizing.leverage, size: res.filledSize, reason: `${p.opinion.source}: ${p.opinion.thesis}`,
            };
            trail(cn, { stage: "execute", outcome: "executed", reason: `filled ${res.filledSize} @ ${fp(res.avgPx)}` });
            this.d.bus.log("success", "trade", "trader",
              `OPEN ${cn.side.toUpperCase()} ${cn.coin} ${res.filledSize} @ ${fp(res.avgPx)} · ${p.sizing.leverage}x · SL ${fp(p.sizing.stopPx)} · TP ${fp(p.sizing.takePx)} · risk $${p.sizing.riskUsd.toFixed(3)}`,
              { coin: cn.coin, cycle: c, data: { kind: "open", side: cn.side, size: res.filledSize, price: res.avgPx, leverage: p.sizing.leverage, stopPx: p.sizing.stopPx, takePx: p.sizing.takePx, thesis: p.opinion.thesis, source: p.opinion.source } });
            const slip = Math.abs(res.avgPx - cn.signal.price) / cn.signal.price;
            if (slip > 0.003) this.d.bus.log("warn", "audit", "auditor", `post-trade: ${cn.coin} filled ${(slip * 100).toFixed(2)}% away from signal price`, { coin: cn.coin, cycle: c });
          } catch (e) {
            trail(cn, { stage: "execute", outcome: "error", reason: (e as Error).message });
            this.d.bus.log("error", "trade", "trader", `${cn.coin} order failed: ${(e as Error).message}`, { coin: cn.coin, cycle: c });
          }
        }
        this.save();
        return { value: n, metric: n ? `${n} filled` : "no fills", detail: this.d.broker.mode === "live" ? "Hyperliquid L1 · IOC + reduce-only TP/SL" : "paper fills · HL fees + slippage", status: (n ? "ok" : "warn") as AgentStatus };
      });
    } catch (e) {
      this.lastError = (e as Error).message;
      if (Date.now() - this.lastErrorLogAt > 60_000) {
        this.lastErrorLogAt = Date.now();
        this.d.bus.log("error", "pipeline", "ops", `cycle ${c} failed: ${this.lastError}`, { cycle: c });
      }
    } finally {
      const ms = Date.now() - t0;
      this.lastCycleAt = Date.now();
      this.lastCycleMs = ms;
      this.funnel = f;
      if (!this.lastError || ms > 0) this.lastError = this.stages.scout.status === "error" ? this.lastError : null;
      for (const t of trails.values()) {
        const dv = this.d.store.addDecision({
          ts: Date.now(), cycle: c, coin: t.cand.coin, side: t.cand.side, score: t.cand.signal.score, regime: t.cand.signal.regime,
          stage: t.stage, outcome: t.outcome, reason: t.reason, research: t.research, risk: t.risk, boss: t.boss, audit: t.audit,
        });
        this.recent.unshift(dv);
        this.decided.set(`${t.cand.coin}|${t.cand.side}|${t.cand.signal.time}`, Date.now());
        if (t.outcome !== "executed") this.d.bus.log("info", "pipeline", STAGES.find((x) => x.id === t.stage)?.agent ?? "ops",
          `${t.cand.coin} ${t.cand.side} ${t.outcome} at ${t.stage}: ${t.reason}`, { coin: t.cand.coin, cycle: c, data: { kind: "decision", id: dv.id } });
      }
      this.recent = this.recent.slice(0, 60);
      for (const [k, at] of this.decided) if (Date.now() - at > 6 * 3_600_000) this.decided.delete(k);
      this.d.store.addCycle({ id: c, ts: t0, ms, scanned: f.scanned, candidates: f.candidates, proposals: f.passedRisk, approved: f.approved, executed: f.executed });
      this.save();
      this.busy = false;
      this.d.bus.emit("cycle", c);
    }
  }

  // deterministic last line of defence before any order is sent
  private preTradeAudit(p: Proposal, mid: number | undefined, snap: AccountSnapshot, s: ReturnType<SettingsStore["get"]>): string[] {
    const sig = p.cand.signal;
    const price = sig.price;
    const dir = p.cand.side === "long" ? 1 : -1;
    const issues: string[] = [];
    if (!mid) issues.push("no live price");
    else if (Math.abs(mid - price) > 0.5 * sig.atr) issues.push(`price moved ${(Math.abs(mid - price) / sig.atr).toFixed(2)} ATR since signal`);
    if ((p.sizing.stopPx - price) * dir >= 0) issues.push("stop on wrong side");
    if ((p.sizing.takePx - price) * dir <= 0) issues.push("target on wrong side");
    if (p.rr < 1.2) issues.push(`R:R ${p.rr.toFixed(2)} below 1.2`);
    const stopDist = Math.abs(price - p.sizing.stopPx) / price;
    const liq = liquidationDistance(p.sizing.leverage, p.cand.market.maxLeverage);
    if (liq < stopDist * 2) issues.push(`liquidation ${(liq * 100).toFixed(2)}% too close to stop ${(stopDist * 100).toFixed(2)}%`);
    if (p.size * price < s.risk.minNotional * 0.999) issues.push("below exchange minimum notional");
    const cap = Math.min(s.risk.maxLeverage, p.cand.market.maxLeverage, s.leverage.perCoin[p.cand.coin] ?? Infinity);
    if (p.sizing.leverage > cap) issues.push(`leverage ${p.sizing.leverage}x above cap ${cap}x`);
    if (p.opinion.decision !== p.cand.side) issues.push("research and quant disagree on direction");
    const riskUsd = p.size * (Math.abs(price - p.sizing.stopPx) + price * s.risk.takerFee * 2);
    if (riskUsd > snap.equity * s.risk.riskPerTradePct * 1.5 + 1e-9) issues.push(`risk $${riskUsd.toFixed(3)} above 1.5x budget`);
    if (snap.positions.some((x) => x.coin === p.cand.coin) || this.p.managed[p.cand.coin]) issues.push("position already open");
    const iv = INTERVAL_MS_PURE[s.bot.interval];
    if (Date.now() - (sig.time + iv) > 2 * iv) issues.push("signal is stale");
    return issues;
  }

  // trailing stops, reversal and time exits, protection checks and close detection for bot positions
  private async monitor(snap: AccountSnapshot, s: ReturnType<SettingsStore["get"]>, c: number) {
    await this.stage("monitor", async () => {
      const lines: string[] = [];
      const iv = INTERVAL_MS_PURE[s.bot.interval];
      for (const [coin, m] of Object.entries(this.p.managed)) {
        const pos = snap.positions.find((x) => x.coin === coin);
        if (!pos) {
          this.onClosed(coin, m, snap, s, c);
          continue;
        }
        const sig = this.signals[coin];
        const atr = sig?.atr || Math.abs(m.entryPx - m.initialStopPx) / s.risk.stopAtr;
        const next = trailStop(m.side, m.entryPx, m.initialStopPx, m.stopPx, pos.markPx, atr, s.risk);
        if (Math.abs(next - m.stopPx) > atr * 0.1) {
          await this.d.broker.setStop(coin, next);
          this.d.bus.log("info", "trade", "monitor", `${coin} stop ${fp(m.stopPx)} → ${fp(next)}`, { coin, cycle: c });
          m.stopPx = next;
        }
        if (this.d.broker.mode === "live" && !snap.orders.some((o) => o.coin === coin && o.reduceOnly && /stop/i.test(o.type))) {
          this.d.bus.log("warn", "audit", "auditor", `${coin}: no exchange-side stop found, re-placing at ${fp(m.stopPx)}`, { coin, cycle: c });
          await this.d.broker.setStop(coin, m.stopPx);
        }
        const fresh = !!sig && Date.now() - (sig.time + iv) < 2 * iv;
        if (this.p.armed && fresh && sig.action !== "flat" && sig.action !== m.side) {
          m.exitReason = "signal reversal";
          await this.d.broker.close(coin, "signal reversal");
          this.d.bus.log("info", "trade", "monitor", `${coin} ${m.side} closing on reversal: ${sig.reason}`, { coin, cycle: c });
          continue;
        }
        if (s.bot.maxHoldHours > 0 && Date.now() - m.openedAt > s.bot.maxHoldHours * 3_600_000) {
          m.exitReason = "time stop";
          await this.d.broker.close(coin, "time stop");
          this.d.bus.log("info", "trade", "monitor", `${coin} closed by ${s.bot.maxHoldHours}h time stop`, { coin, cycle: c });
          continue;
        }
        lines.push(`${coin} ${m.side} ${pos.unrealizedPnl >= 0 ? "+" : ""}$${pos.unrealizedPnl.toFixed(3)} SL ${fp(m.stopPx)}`);
      }
      this.save();
      const n = Object.keys(this.p.managed).length;
      return {
        value: null, metric: n ? `${n} open` : "flat",
        detail: lines.join(" · ") || `TP +${s.risk.takeAtr} ATR / SL -${s.risk.stopAtr} ATR · trail ${s.risk.trailAtr} ATR`,
        status: (n ? "ok" : "idle") as AgentStatus,
      };
    });
  }

  // records a finished bot trade, applies the loss cooldown and notifies
  private onClosed(coin: string, m: Managed, snap: AccountSnapshot, s: ReturnType<SettingsStore["get"]>, c: number) {
    let t: TradeView | null = null;
    if (this.d.broker.mode === "paper") {
      const rec = this.d.broker.closedTrades().find((x) => x.coin === coin && x.closedAt >= m.openedAt - 1000);
      if (rec) t = {
        id: rec.id, mode: "paper", source: "bot", coin, side: rec.side, size: rec.size, entry: rec.entryPx, exit: rec.exitPx,
        pnl: rec.pnl, fees: rec.fees, r: rec.rMultiple, leverage: m.leverage, opened: rec.openedAt, closed: rec.closedAt,
        entryReason: m.reason, exitReason: m.exitReason ?? rec.exitReason,
      };
    } else {
      const fills = snap.fills.filter((x) => x.coin === coin && x.time >= m.openedAt - 5000);
      const exitFill = fills.find((x) => x.side !== m.side);
      const pnl = fills.reduce((a, x) => a + x.closedPnl - x.fee, 0);
      const riskDist = Math.abs(m.entryPx - m.initialStopPx) * m.size;
      t = {
        id: `live-${coin}-${m.openedAt}`, mode: "live", source: "bot", coin, side: m.side, size: m.size, entry: m.entryPx,
        exit: exitFill?.px ?? m.stopPx, pnl, fees: fills.reduce((a, x) => a + x.fee, 0), r: riskDist > 0 ? pnl / riskDist : 0,
        leverage: m.leverage, opened: m.openedAt, closed: exitFill?.time ?? Date.now(), entryReason: m.reason,
        exitReason: m.exitReason ?? "exchange TP/SL",
      };
    }
    if (t) {
      this.d.store.upsertTrade(t);
      if (t.pnl < 0) this.p.cooldown[coin] = Date.now() + s.risk.cooldownMin * 60_000;
      this.d.bus.log(t.pnl >= 0 ? "success" : "warn", "trade", "monitor",
        `CLOSE ${t.side.toUpperCase()} ${coin} @ ${fp(t.exit)} · PnL ${t.pnl >= 0 ? "+" : "-"}$${Math.abs(t.pnl).toFixed(4)} (${t.r >= 0 ? "+" : ""}${t.r.toFixed(2)}R) · ${t.exitReason}`,
        { coin, cycle: c, data: { kind: "close", ...t } });
    } else {
      this.d.bus.log("info", "trade", "monitor", `${coin} position closed (no fill record found)`, { coin, cycle: c });
    }
    delete this.p.managed[coin];
    this.p.tradesSinceAudit++;
  }

  // peak and day references for the circuit breakers, equity samples and paper journal sync
  private accounting(snap: AccountSnapshot, s: ReturnType<SettingsStore["get"]>) {
    const now = Date.now();
    const day = Math.floor(now / 86_400_000);
    if (day !== this.p.day) {
      if (this.p.day >= 0 && this.p.dayStartEquity > 0) {
        const pnl = snap.equity - this.p.dayStartEquity;
        const trades = this.d.store.trades({ mode: this.d.broker.mode, since: now - 86_400_000 }).length;
        this.d.bus.log("info", "system", "accountant",
          `Daily summary: equity $${snap.equity.toFixed(2)} · day PnL ${pnl >= 0 ? "+" : "-"}$${Math.abs(pnl).toFixed(3)} (${((pnl / this.p.dayStartEquity) * 100).toFixed(2)}%) · ${trades} trades`,
          { data: { kind: "daily", equity: snap.equity, pnl, trades } });
      }
      this.p.day = day;
      this.p.dayStartEquity = snap.equity;
    }
    if (this.p.dayStartEquity <= 0) this.p.dayStartEquity = snap.equity;
    this.p.peakEquity = Math.max(this.p.peakEquity, snap.equity);
    if (now - this.lastEquityAt >= 60_000) {
      const upnl = snap.positions.reduce((a, x) => a + x.unrealizedPnl, 0);
      this.d.store.addEquity(now, this.d.broker.mode, snap.equity, upnl, snap.marginUsed);
      this.lastEquityAt = now;
    }
    if (this.d.broker.mode === "paper") {
      let newest = this.p.lastPaperSync;
      for (const t of this.d.broker.closedTrades()) {
        if (t.closedAt <= this.p.lastPaperSync) break;
        newest = Math.max(newest, t.closedAt);
        const bot = t.entryReason.startsWith("[bot]");
        this.d.store.upsertTrade({
          id: t.id, mode: "paper", source: bot ? "bot" : "manual", coin: t.coin, side: t.side, size: t.size, entry: t.entryPx,
          exit: t.exitPx, pnl: t.pnl, fees: t.fees, r: t.rMultiple, leverage: this.p.managed[t.coin]?.leverage ?? 0, opened: t.openedAt,
          closed: t.closedAt, entryReason: bot ? t.entryReason.slice(6) : t.entryReason, exitReason: t.exitReason,
        });
      }
      this.p.lastPaperSync = newest;
    }
    this.agents.done("accountant", "ok", `equity $${snap.equity.toFixed(2)}`, 0);
    void s;
  }

  // current win or loss streak of bot trades, e.g. "W2" or "L3"
  private streak(): string {
    const t = this.d.store.trades({ mode: this.d.broker.mode, source: "bot", limit: 20 });
    if (!t.length) return "none";
    const win = t[0].pnl > 0;
    let n = 0;
    for (const x of t) if (x.pnl > 0 === win) n++; else break;
    return `${win ? "W" : "L"}${n}`;
  }

  // strategic plan from the ceo, falling back to the rules engine when no model answers
  async runCeo(mkt?: Map<string, MarketInfo>): Promise<CeoPlan | null> {
    if (this.ceoBusy) return this.p.ceo;
    this.ceoBusy = true;
    const s = this.d.settings.get();
    const t0 = Date.now();
    this.agents.start("ceo", "writing the strategic plan");
    try {
      const m = mkt ?? (await this.d.market.snapshot());
      const top = [...m.values()].sort((a, b) => b.volumeUsd - a.volumeUsd).slice(0, 20);
      const majors = [...new Set(["BTC", "ETH", "SOL", ...this.universe])].slice(0, 8)
        .map((coin) => {
          const mi = m.get(coin);
          const htf = this.signals[coin]?.factors.find((x) => x.name === "htf_bias")?.value ?? null;
          return mi ? { coin, price: mi.markPx, change24h: mi.change24h, htf } : null;
        })
        .filter((x): x is NonNullable<typeof x> => !!x);
      const day = this.d.store.trades({ mode: this.d.broker.mode, since: Date.now() - 86_400_000 });
      const ctx: CeoContext = {
        minutes: s.ai.ceoIntervalMin, majors, breadthUp: top.filter((x) => x.change24h > 0).length, breadthTotal: top.length,
        avgFunding: top.reduce((a, x) => a + x.funding, 0) / Math.max(1, top.length), intel: this.d.intel.view(),
        headlines: this.d.intel.headlines(6).map((h) => h.title),
        desk: { trades: day.length, pnl: day.reduce((a, x) => a + x.pnl, 0), winRate: day.length ? day.filter((x) => x.pnl > 0).length / day.length : 0 },
        universe: this.universe.length ? this.universe : majors.map((x) => x.coin), deep: this.d.intel.deep?.summary ?? null,
      };
      let plan: CeoPlan = { ...rulesCeo(ctx), at: Date.now(), source: "rules" };
      let extra: { provider?: string | null; model?: string | null; tokens?: number } = { provider: "rules", model: null };
      if (s.ai.mode !== "off") {
        const res = await this.d.ai.complete({
          role: "ceo", system: SYSTEM.ceo, prompt: ceoPrompt(ctx), maxTokens: 600, deadlineMs: s.ai.maxCallSec * 1000,
          validate: validateCeo([...new Set([...ctx.universe, ...majors.map((x) => x.coin)])]),
        });
        if (res.ok) {
          extra = { provider: res.providerName, model: res.model, tokens: res.tokensIn + res.tokensOut };
          if (s.ai.mode === "control") plan = { ...res.value!, at: Date.now(), source: `${res.providerName}/${res.model}` };
          else this.d.bus.log("info", "ai", "ceo", `[advisory] CEO AI: ${res.value!.regime} x${res.value!.riskMultiplier} — ${res.value!.summary}`);
        } else {
          this.d.bus.log("warn", "ai", "ceo", `CEO AI unavailable, rules engine planned. ${res.error}`, { data: { attempts: res.attempts } });
        }
      }
      this.p.ceo = plan;
      this.p.lastCeoAt = Date.now();
      this.save();
      this.d.bus.log("info", "pipeline", "ceo",
        `CEO plan: ${plan.regime.toUpperCase()} x${plan.riskMultiplier.toFixed(2)}${plan.focus.length ? ` · focus ${plan.focus.join(",")}` : ""}${plan.avoid.length ? ` · avoid ${plan.avoid.join(",")}` : ""} — ${plan.summary}`,
        { data: { kind: "ceo", ...plan } });
      this.agents.done("ceo", "ok", `${plan.regime} x${plan.riskMultiplier.toFixed(2)}`, Date.now() - t0, extra);
      return plan;
    } catch (e) {
      this.agents.done("ceo", "error", (e as Error).message, Date.now() - t0);
      this.d.bus.log("error", "pipeline", "ceo", `CEO failed: ${(e as Error).message}`);
      return this.p.ceo;
    } finally {
      this.ceoBusy = false;
    }
  }

  // periodic performance review; its recommendation becomes a binding directive
  async runAudit(): Promise<AuditReport | null> {
    if (this.auditBusy) return this.p.audit;
    this.auditBusy = true;
    const s = this.d.settings.get();
    const t0 = Date.now();
    this.agents.start("auditor", "reviewing performance");
    try {
      const now = Date.now();
      const trades = this.d.store.trades({ mode: this.d.broker.mode, source: "bot", since: now - 7 * 86_400_000, limit: 2000 });
      const chron = [...trades].reverse();
      let maxLoss = 0;
      let run = 0;
      for (const t of chron) {
        run = t.pnl < 0 ? run + 1 : 0;
        maxLoss = Math.max(maxLoss, run);
      }
      const gw = trades.filter((t) => t.pnl > 0).reduce((a, t) => a + t.pnl, 0);
      const gl = -trades.filter((t) => t.pnl <= 0).reduce((a, t) => a + t.pnl, 0);
      const decisions = this.d.store.decisions({ limit: 500 }).filter((x) => x.ts >= now - 86_400_000);
      const outcomes: Record<string, number> = {};
      for (const x of decisions) outcomes[x.outcome] = (outcomes[x.outcome] ?? 0) + 1;
      const ruleDecisions = decisions.filter((x) => x.research?.source === "rules" || x.boss?.source === "rules").length;
      const ai = this.d.store.aiTotals(now - 86_400_000);
      const equity = this.snapshot?.equity ?? 0;
      const dd = this.p.peakEquity ? ((this.p.peakEquity - equity) / this.p.peakEquity) * 100 : 0;
      const dayLoss = this.p.dayStartEquity ? Math.max(0, ((this.p.dayStartEquity - equity) / this.p.dayStartEquity) * 100) : 0;
      const streak = this.streak();
      const flags: string[] = [];
      if (streak.startsWith("L") && Number(streak.slice(1)) >= 3) flags.push(`losing streak ${streak.slice(1)}`);
      if (ai.calls >= 10 && ai.failures / ai.calls > 0.5) flags.push(`AI failure rate ${((ai.failures / ai.calls) * 100).toFixed(0)}%`);
      if (dd >= s.risk.maxDrawdownPct * 50) flags.push(`drawdown ${dd.toFixed(1)}% is over half the kill switch`);
      const ctx: AuditContext = {
        trades: trades.length, winRate: trades.length ? trades.filter((t) => t.pnl > 0).length / trades.length : 0,
        profitFactor: gl > 0 ? gw / gl : gw > 0 ? Infinity : 0, avgR: trades.length ? trades.reduce((a, t) => a + t.r, 0) / trades.length : 0,
        netPnl: trades.reduce((a, t) => a + t.pnl, 0), maxLossStreak: maxLoss, currentStreak: streak,
        recent: trades.slice(0, 8).map((t) => `${t.coin} ${t.side} ${t.r >= 0 ? "+" : ""}${t.r.toFixed(2)}R $${t.pnl.toFixed(3)} ${t.exitReason}`),
        outcomes, aiCalls: ai.calls, aiFailures: ai.failures, ruleDecisions, drawdownPct: dd, killPct: Math.round(s.risk.maxDrawdownPct * 100),
        dayLossPct: dayLoss, dayLimitPct: Math.round(s.risk.dailyLossLimitPct * 100), flags,
      };
      const rules = rulesAudit(ctx);
      let report: AuditReport = { ...rules, at: now, source: "rules" };
      let extra: { provider?: string | null; model?: string | null; tokens?: number } = { provider: "rules", model: null };
      if (s.ai.mode !== "off" && trades.length + decisions.length > 0) {
        const res = await this.d.ai.complete({ role: "auditor", system: SYSTEM.auditor, prompt: auditPrompt(ctx), maxTokens: 500, deadlineMs: s.ai.maxCallSec * 1000, validate: validateAudit });
        if (res.ok && s.ai.mode === "control") {
          const severity = { continue: 0, "reduce-risk": 1, pause: 2 } as const;
          const rec = severity[res.value!.recommendation] >= severity[rules.recommendation] ? res.value!.recommendation : rules.recommendation;
          report = { ...res.value!, recommendation: rec, issues: [...new Set([...rules.issues, ...res.value!.issues])].slice(0, 8), at: now, source: `${res.providerName}/${res.model}` };
          extra = { provider: res.providerName, model: res.model, tokens: res.tokensIn + res.tokensOut };
        } else if (!res.ok) {
          this.d.bus.log("warn", "ai", "auditor", `Auditor AI unavailable, rules engine reviewed. ${res.error}`);
        }
      }
      this.p.audit = report;
      this.p.lastAuditAt = now;
      this.p.tradesSinceAudit = 0;
      if (report.recommendation === "pause") this.setDirective("halt", 60, report.summary, `auditor ${report.source}`);
      else if (report.recommendation === "reduce-risk") this.setDirective("cautious", 120, report.summary, `auditor ${report.source}`);
      this.save();
      this.d.bus.log(report.recommendation === "continue" ? "info" : "warn", "audit", "auditor",
        `Audit grade ${report.grade} · ${report.recommendation} — ${report.summary}${report.issues.length ? ` Issues: ${report.issues.join("; ")}` : ""}`,
        { data: { kind: "audit", ...report } });
      this.agents.done("auditor", report.recommendation === "continue" ? "ok" : "warn", `grade ${report.grade} · ${report.recommendation}`, Date.now() - t0, extra);
      return report;
    } catch (e) {
      this.agents.done("auditor", "error", (e as Error).message, Date.now() - t0);
      this.d.bus.log("error", "audit", "auditor", `Audit failed: ${(e as Error).message}`);
      return this.p.audit;
    } finally {
      this.auditBusy = false;
    }
  }

  // slow web research through the antigravity agent (or any provider routed to the intel role)
  async runDeepResearch(): Promise<void> {
    if (this.deepBusy) return;
    const s = this.d.settings.get();
    if (!this.d.ai.registry.chainFor("intel").length) {
      this.agents.set("deep", "off", "no provider routed to deep research");
      this.p.lastDeepAt = Date.now();
      return;
    }
    this.deepBusy = true;
    const t0 = Date.now();
    this.agents.start("deep", "researching the web");
    try {
      const res = await this.d.ai.complete({
        role: "intel", system: SYSTEM.intel, prompt: deepPrompt(this.universe.length ? this.universe : s.bot.coins),
        maxTokens: s.ai.deepResearch.maxTokens, deadlineMs: 8 * 60_000, validate: validateDeep,
      });
      if (res.ok) {
        const v = res.value!;
        const events = v.events.map((e) => `${e.title} (${e.impact}${e.coins.length ? ` ${e.coins.join("/")}` : ""})`).join("; ");
        this.d.intel.deep = { at: Date.now(), summary: `${v.summary}${events ? ` Events: ${events}` : ""}`.slice(0, 900), source: `${res.providerName}/${res.model}` };
        this.d.bus.log("info", "intel", "deep", `Deep research: ${v.summary}`, { data: { kind: "deep", ...v } });
        this.agents.done("deep", "ok", "briefing ready", Date.now() - t0, { provider: res.providerName, model: res.model, tokens: res.tokensIn + res.tokensOut });
      } else {
        this.d.bus.log("warn", "intel", "deep", `Deep research failed: ${res.error}`);
        this.agents.done("deep", "warn", "no briefing", Date.now() - t0);
      }
    } finally {
      this.p.lastDeepAt = Date.now();
      this.deepBusy = false;
      this.save();
    }
  }

  // company slice of the dashboard state
  state(): Pick<AppState, "bot" | "pipeline" | "agents" | "ceo" | "directive" | "audit" | "signals" | "decisions" | "universe"> {
    const s = this.d.settings.get();
    if (!s.ai.deepResearch.enabled) this.agents.set("deep", "off", "disabled in settings");
    return {
      bot: { armed: this.p.armed, halted: this.p.halted, peakEquity: this.p.peakEquity, dayStartEquity: this.p.dayStartEquity, managed: this.p.managed },
      pipeline: {
        active: this.running, armed: this.p.armed, cycle: this.cycleNo, cycleSec: s.bot.cycleSec, lastCycleAt: this.lastCycleAt,
        lastCycleMs: this.lastCycleMs, nextCycleAt: this.nextCycleAt, stages: STAGES.map((x) => this.stages[x.id]), funnel: this.funnel,
        lastError: this.lastError,
      },
      agents: this.agents.list(), ceo: this.p.ceo, directive: this.activeDirective(), audit: this.p.audit, signals: this.signals,
      decisions: this.recent.slice(0, 40), universe: this.universe,
    };
  }
}
