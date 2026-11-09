import type { AuditReport, BossDirective, CeoPlan, IntelView } from "../../shared/types";
import type { Candidate, Proposal } from "../company/types";

// compact factor names keep prompts short without losing meaning
const SHORT: Record<string, string> = {
  htf_bias: "htf", ema_cross: "ema", trend_ema: "trend", rsi_momo: "rsi", volume: "vol", zscore_revert: "z",
  rsi_revert: "rsiR", vwap_revert: "vwap", book_imbalance: "book", funding: "fund",
};

// signed number with fixed decimals
const sg = (x: number, d = 2) => (Number.isFinite(x) ? `${x >= 0 ? "+" : ""}${x.toFixed(d)}` : "na");
// signed percent from a fraction
const pc = (x: number, d = 2) => (Number.isFinite(x) ? `${x >= 0 ? "+" : ""}${(x * 100).toFixed(d)}%` : "na");
// compact usd for volumes and open interest
const usd = (x: number) => (x >= 1e9 ? `$${(x / 1e9).toFixed(1)}B` : x >= 1e6 ? `$${(x / 1e6).toFixed(0)}M` : `$${Math.round(x)}`);
// price with sensible precision
const px = (x: number) => (x >= 1000 ? x.toFixed(1) : x >= 1 ? x.toFixed(3) : x.toPrecision(4));
// clamp to 0..1, accepting 0..100 percentages from sloppy models
const unit = (v: unknown) => {
  let n = Number(v);
  if (!Number.isFinite(n)) return 0;
  if (n > 1 && n <= 100) n /= 100;
  return Math.max(0, Math.min(1, n));
};
// bounded single-line string from model output
const text = (v: unknown, max: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

// role instructions; short on purpose because every token is paid for on each call
export const SYSTEM = {
  research:
    "You are the Research Manager of an autonomous crypto perpetual-futures desk on Hyperliquid. Quant workers send " +
    "candidates already filtered by a regime-aware factor model. For each, decide whether independent evidence (higher " +
    "timeframe trend, order book, funding and cross-venue funding, sentiment, news, CEO plan) supports the quant " +
    "direction. Fees and noise make marginal setups lose money, so skip anything unclear. You may only confirm the given " +
    "direction or skip. Output strict JSON only.",
  boss:
    "You are the Boss, the main AI with final authority over an autonomous crypto trading company on Hyperliquid perps. " +
    "Proposals reaching you already passed research and hard risk limits. Approve only trades with clear edge and sound " +
    "risk/reward; reject the rest. Capital preservation outranks activity. You may scale size from 0.25 to 1.0 of the " +
    "risk budget, never above. Stop-loss, leverage caps, daily loss limit and kill switch are enforced by code and cannot " +
    "be changed. Also set the company directive: normal, cautious (half risk) or halt (no new entries). Output strict JSON only.",
  ceo:
    "You are the CEO of an autonomous crypto trading company. From the market snapshot set the plan for the next period: " +
    "regime, a risk multiplier from 0.25 to 1, coins to focus on or avoid, and bias per coin. Use only the data given; " +
    "when evidence conflicts prefer neutral and lower risk. Output strict JSON only.",
  auditor:
    "You are the Chief Auditor of an autonomous trading company. Review recent trades, decisions and system health for " +
    "rule violations, overtrading, falling expectancy, losing streaks, execution problems and over-reliance on fallback " +
    "logic. Grade A (excellent) to F (failing) and recommend continue, reduce-risk or pause. Output strict JSON only.",
  intel:
    "You are the Deep Research Analyst of a crypto trading desk. Research news and scheduled events from the last 12 " +
    "hours and next 24 hours that could move the listed perpetual futures: macro releases, central bank decisions, ETF " +
    "flows, hacks, regulation, token unlocks, exchange incidents. Summarize; no citations. Output strict JSON only.",
};

// one-line market context shared by several prompts
export function marketLine(intel: IntelView): string {
  const parts: string[] = [];
  if (intel.fearGreed) parts.push(`F&G ${intel.fearGreed.value} ${intel.fearGreed.label}`);
  if (intel.macro) parts.push(`BTC.D ${intel.macro.btcDominance.toFixed(1)}%`, `mcap24h ${sg(intel.macro.mcapChange24h, 1)}%`);
  parts.push(`news ${sg(intel.newsScore)}`);
  return parts.join(" | ");
}

// ceo plan in one line for downstream prompts
export function planLine(plan: CeoPlan | null): string {
  if (!plan) return "Plan: none yet";
  const bias = Object.entries(plan.bias).filter(([, b]) => b !== "neutral").map(([c, b]) => `${c}:${b}`).join(" ");
  return `Plan: ${plan.regime} x${plan.riskMultiplier.toFixed(2)}${bias ? ` | bias ${bias}` : ""}${plan.avoid.length ? ` | avoid ${plan.avoid.join(",")}` : ""} | "${plan.summary.slice(0, 160)}"`;
}

// batched research request: all candidates of a cycle in a single call
export function researchPrompt(cands: Candidate[], plan: CeoPlan | null, intel: IntelView, headlines: string[]): string {
  const rows = cands.map((c, i) => {
    const s = c.signal;
    const x = c.intel;
    const f = s.factors.map((k) => `${SHORT[k.name] ?? k.name}${sg(k.value)}`).join(",");
    return `#${i + 1} ${c.coin} ${c.side.toUpperCase()} q=${sg(s.score)} ${s.regime} atr=${pc(s.atr / s.price)} f[${f}] ` +
      `24h=${sg(x.change24h, 1)}% vol=${usd(x.volumeUsd)} oi=${usd(x.oiUsd)} fund=${pc(x.funding, 4)}/h` +
      `${x.xFunding !== null ? ` xfund=${pc(x.xFunding, 4)}/h` : ""} prem=${pc(x.premium, 3)} book=${sg(x.imbalance)} ` +
      `spread=${x.spreadBps.toFixed(1)}bp news=${sg(x.news)}${x.flags.length ? ` flags=${x.flags.join("/")}` : ""}`;
  });
  return [
    planLine(plan),
    `Market: ${marketLine(intel)}`,
    headlines.length ? `Headlines:\n${headlines.map((h) => `- ${h.slice(0, 110)}`).join("\n")}` : "",
    `Candidates:\n${rows.join("\n")}`,
    'Reply JSON: {"items":[{"id":1,"decision":"long|short|skip","confidence":0.0-1.0,"thesis":"<=20 words","risk":"<=12 words"}]}',
    "decision must equal the candidate side or skip.",
  ].filter(Boolean).join("\n");
}

// validated research answer keyed by candidate number
export function validateResearch(n: number) {
  return (j: unknown) => {
    const items = (j as { items?: unknown })?.items;
    if (!Array.isArray(items)) return null;
    const out = new Map<number, { decision: "long" | "short" | "skip"; confidence: number; thesis: string; risk: string }>();
    for (const it of items as Record<string, unknown>[]) {
      const id = Number(it?.id);
      const d = String(it?.decision ?? "").toLowerCase();
      if (!Number.isInteger(id) || id < 1 || id > n || !["long", "short", "skip"].includes(d)) continue;
      out.set(id, { decision: d as "long" | "short" | "skip", confidence: unit(it.confidence), thesis: text(it.thesis, 200), risk: text(it.risk, 120) });
    }
    return out.size ? out : null;
  };
}

// account and governance context for the boss
export interface BossContext {
  equity: number;
  available: number;
  open: number;
  maxPositions: number;
  dayPnl: number;
  dayPnlPct: number;
  drawdownPct: number;
  killPct: number;
  streak: string;
  plan: CeoPlan | null;
  audit: AuditReport | null;
  directive: BossDirective | null;
}

// final approval request for the sized proposals of one cycle
export function bossPrompt(props: Proposal[], ctx: BossContext): string {
  const rows = props.map((p, i) => {
    const c = p.cand;
    const e = c.signal.price;
    const stopPct = Math.abs(p.sizing.stopPx - e) / e;
    const takePct = Math.abs(p.sizing.takePx - e) / e;
    return `#${i + 1} ${c.coin} ${c.side.toUpperCase()} conf=${p.opinion.confidence.toFixed(2)} "${p.opinion.thesis.slice(0, 120)}" | ` +
      `notional $${(p.size * e).toFixed(2)} lev ${p.sizing.leverage}x | entry ${px(e)} SL ${px(p.sizing.stopPx)} (-${(stopPct * 100).toFixed(2)}%) ` +
      `TP ${px(p.sizing.takePx)} (+${(takePct * 100).toFixed(2)}%) R:R ${p.rr.toFixed(2)} | risk $${p.sizing.riskUsd.toFixed(3)}` +
      `${c.intel.flags.length ? ` | flags ${c.intel.flags.join("/")}` : ""}`;
  });
  return [
    `Account: equity $${ctx.equity.toFixed(2)} | avail $${ctx.available.toFixed(2)} | open ${ctx.open}/${ctx.maxPositions} | ` +
      `today ${ctx.dayPnl >= 0 ? "+" : ""}$${ctx.dayPnl.toFixed(2)} (${sg(ctx.dayPnlPct, 1)}%) | DD ${ctx.drawdownPct.toFixed(1)}% (kill ${ctx.killPct}%) | streak ${ctx.streak}`,
    planLine(ctx.plan),
    ctx.audit ? `Audit: ${ctx.audit.grade} ${ctx.audit.recommendation} "${ctx.audit.summary.slice(0, 140)}"` : "Audit: none",
    `Directive now: ${ctx.directive?.mode ?? "normal"}`,
    `Proposals:\n${rows.join("\n")}`,
    'Reply JSON: {"decisions":[{"id":1,"approve":true,"size":0.25-1.0,"note":"<=15 words"}],"directive":"normal|cautious|halt","note":"<=20 words"}',
  ].join("\n");
}

// validated boss answer
export function validateBoss(n: number) {
  return (j: unknown) => {
    const o = j as { decisions?: unknown; directive?: unknown; note?: unknown };
    if (!Array.isArray(o?.decisions)) return null;
    const decisions = new Map<number, { approve: boolean; size: number; note: string }>();
    for (const d of o.decisions as Record<string, unknown>[]) {
      const id = Number(d?.id);
      if (!Number.isInteger(id) || id < 1 || id > n) continue;
      const approve = d.approve === true || d.approve === "true";
      decisions.set(id, { approve, size: Math.max(0.25, Math.min(1, Number(d.size) || 1)), note: text(d.note, 140) });
    }
    if (!decisions.size) return null;
    const dir = String(o.directive ?? "normal").toLowerCase();
    return { decisions, directive: (["normal", "cautious", "halt"].includes(dir) ? dir : "normal") as BossDirective["mode"], note: text(o.note, 200) };
  };
}

// raw numbers the ceo plans from
export interface CeoContext {
  minutes: number;
  majors: { coin: string; price: number; change24h: number; htf: number | null }[];
  breadthUp: number;
  breadthTotal: number;
  avgFunding: number;
  intel: IntelView;
  headlines: string[];
  desk: { trades: number; pnl: number; winRate: number };
  universe: string[];
  deep: string | null;
}

// periodic strategy request
export function ceoPrompt(c: CeoContext): string {
  return [
    `Period: next ${c.minutes} minutes`,
    `Majors: ${c.majors.map((m) => `${m.coin} ${px(m.price)} 24h ${sg(m.change24h, 1)}% trend1h ${m.htf === null ? "na" : sg(m.htf)}`).join(" | ")}`,
    `Breadth: ${c.breadthUp}/${c.breadthTotal} of top perps up 24h | avg funding ${pc(c.avgFunding, 4)}/h`,
    `Market: ${marketLine(c.intel)}`,
    c.headlines.length ? `Headlines:\n${c.headlines.map((h) => `- ${h.slice(0, 110)}`).join("\n")}` : "",
    c.deep ? `Deep research: ${c.deep.slice(0, 400)}` : "",
    `Desk 24h: ${c.desk.trades} trades, pnl ${c.desk.pnl >= 0 ? "+" : ""}$${c.desk.pnl.toFixed(2)}, win ${(c.desk.winRate * 100).toFixed(0)}%`,
    `Universe: ${c.universe.join(" ")}`,
    'Reply JSON: {"regime":"risk-on|neutral|risk-off","riskMultiplier":0.25-1,"focus":["COIN"],"avoid":["COIN"],"bias":{"COIN":"long|short|neutral"},"summary":"<=40 words"}',
  ].filter(Boolean).join("\n");
}

// validated ceo plan restricted to coins that actually exist in the universe
export function validateCeo(universe: string[]) {
  const canon = (c: unknown) => universe.find((u) => u.toLowerCase() === String(c ?? "").trim().toLowerCase());
  return (j: unknown): Omit<CeoPlan, "at" | "source"> | null => {
    const o = j as Record<string, unknown>;
    const regime = String(o?.regime ?? "").toLowerCase();
    if (!["risk-on", "neutral", "risk-off"].includes(regime)) return null;
    const list = (v: unknown) => (Array.isArray(v) ? [...new Set(v.map(canon).filter((x): x is string => !!x))].slice(0, 10) : []);
    const bias: CeoPlan["bias"] = {};
    if (o.bias && typeof o.bias === "object") {
      for (const [k, v] of Object.entries(o.bias as Record<string, unknown>)) {
        const c = canon(k);
        const b = String(v).toLowerCase();
        if (c && ["long", "short", "neutral"].includes(b)) bias[c] = b as "long" | "short" | "neutral";
      }
    }
    return {
      regime: regime as CeoPlan["regime"], riskMultiplier: Math.max(0.25, Math.min(1, Number(o.riskMultiplier) || 0.75)),
      focus: list(o.focus), avoid: list(o.avoid), bias, summary: text(o.summary, 300),
    };
  };
}

// numbers the auditor reviews
export interface AuditContext {
  trades: number;
  winRate: number;
  profitFactor: number;
  avgR: number;
  netPnl: number;
  maxLossStreak: number;
  currentStreak: string;
  recent: string[];
  outcomes: Record<string, number>;
  aiCalls: number;
  aiFailures: number;
  ruleDecisions: number;
  drawdownPct: number;
  killPct: number;
  dayLossPct: number;
  dayLimitPct: number;
  flags: string[];
}

// periodic performance review request
export function auditPrompt(a: AuditContext): string {
  return [
    `7d: ${a.trades} trades | win ${(a.winRate * 100).toFixed(0)}% | PF ${Number.isFinite(a.profitFactor) ? a.profitFactor.toFixed(2) : "inf"} | avgR ${sg(a.avgR)} | net ${a.netPnl >= 0 ? "+" : ""}$${a.netPnl.toFixed(2)} | max loss streak ${a.maxLossStreak} | now ${a.currentStreak}`,
    `Risk: DD ${a.drawdownPct.toFixed(1)}% of kill ${a.killPct}% | today ${a.dayLossPct.toFixed(1)}% of limit ${a.dayLimitPct}%`,
    `Decisions 24h: ${Object.entries(a.outcomes).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}`,
    `AI 24h: ${a.aiCalls} calls, ${a.aiFailures} failed, ${a.ruleDecisions} rule-engine fallbacks`,
    a.flags.length ? `Rule flags: ${a.flags.join("; ")}` : "Rule flags: none",
    a.recent.length ? `Recent trades:\n${a.recent.join("\n")}` : "Recent trades: none",
    'Reply JSON: {"grade":"A|B|C|D|F","issues":["<=12 words"],"recommendation":"continue|reduce-risk|pause","summary":"<=40 words"}',
  ].join("\n");
}

// validated audit report
export function validateAudit(j: unknown): Omit<AuditReport, "at" | "source"> | null {
  const o = j as Record<string, unknown>;
  const grade = String(o?.grade ?? "").toUpperCase();
  const rec = String(o?.recommendation ?? "").toLowerCase();
  if (!["A", "B", "C", "D", "F"].includes(grade) || !["continue", "reduce-risk", "pause"].includes(rec)) return null;
  return {
    grade: grade as AuditReport["grade"], recommendation: rec as AuditReport["recommendation"],
    issues: Array.isArray(o.issues) ? o.issues.map((x) => text(x, 120)).filter(Boolean).slice(0, 6) : [],
    summary: text(o.summary, 300),
  };
}

// slow web-research request for the antigravity agent
export function deepPrompt(coins: string[]): string {
  return [
    `Coins: ${coins.join(", ")}`,
    'Reply JSON: {"summary":"<=60 words","events":[{"title":"<=15 words","impact":"bullish|bearish|neutral","coins":["BTC"]}],"bias":{"BTC":"long|short|neutral"}}',
  ].join("\n");
}

// validated deep research briefing
export function validateDeep(j: unknown): { summary: string; events: { title: string; impact: string; coins: string[] }[] } | null {
  const o = j as Record<string, unknown>;
  const summary = text(o?.summary, 600);
  if (!summary) return null;
  const events = Array.isArray(o.events)
    ? (o.events as Record<string, unknown>[]).slice(0, 10).map((e) => ({
      title: text(e?.title, 140), impact: text(e?.impact, 12), coins: Array.isArray(e?.coins) ? e.coins.map((c) => text(c, 12)) : [],
    }))
    : [];
  return { summary, events };
}
