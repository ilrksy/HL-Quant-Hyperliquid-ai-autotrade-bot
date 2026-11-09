import type { AuditReport, BossDirective, CeoPlan, Settings } from "../../shared/types";
import type { Candidate, Opinion, Proposal, Verdict } from "../company/types";
import type { AuditContext, CeoContext } from "./prompts";

// evidence flags the workers raise against a candidate's direction
export function intelFlags(c: Omit<Candidate, "intel"> & { intel: Omit<Candidate["intel"], "flags"> }, maxSpreadBps: number): string[] {
  const dir = c.side === "long" ? 1 : -1;
  const x = c.intel;
  const flags: string[] = [];
  if (x.funding * dir > 0.00004) flags.push("crowded-funding");
  if (x.xFunding !== null && x.xFunding * dir > 0.00006) flags.push("crowded-xvenue");
  if (x.imbalance * dir < -0.35) flags.push("book-against");
  if (x.news * dir < -0.3) flags.push("news-against");
  if (x.spreadBps > maxSpreadBps) flags.push("wide-spread");
  return flags;
}

// deterministic research fallback: quant conviction minus penalties for contrary evidence
export function rulesResearch(c: Candidate, plan: CeoPlan | null, s: Settings): Opinion {
  if (plan?.avoid.includes(c.coin)) return { decision: "skip", confidence: 0, thesis: "CEO avoid list", risk: "", source: "rules" };
  const thr = s.strategy.entryThreshold;
  let conf = 0.6 + 0.4 * Math.max(0, (Math.abs(c.signal.score) - thr) / Math.max(0.01, 1 - thr));
  const notes: string[] = [];
  const penalty: Record<string, number> = {
    "crowded-funding": 0.12, "crowded-xvenue": 0.08, "book-against": 0.1, "news-against": 0.1, "wide-spread": 0.2,
  };
  for (const f of c.intel.flags) {
    conf -= penalty[f] ?? 0.05;
    notes.push(f);
  }
  const bias = plan?.bias[c.coin];
  if (bias && bias !== "neutral" && bias !== c.side) {
    conf -= 0.15;
    notes.push("CEO bias against");
  }
  if (plan?.regime === "risk-off") conf -= 0.05;
  conf = Math.max(0, Math.min(1, conf));
  const ok = conf >= s.ai.minConfidence;
  return {
    decision: ok ? c.side : "skip", confidence: conf,
    thesis: `${c.signal.regime} ${c.side}, quant ${c.signal.score.toFixed(2)}${notes.length ? `, against: ${notes.join(", ")}` : ", no contrary evidence"}`,
    risk: notes.join(", "), source: "rules",
  };
}

// deterministic boss fallback: confidence ranking inside free position slots, directive from the audit
export function rulesBoss(props: Proposal[], slots: number, audit: AuditReport | null, s: Settings):
  { verdicts: Verdict[]; directive: BossDirective["mode"]; note: string } {
  const ranked = props.map((p, i) => ({ p, i })).sort((a, b) => b.p.opinion.confidence - a.p.opinion.confidence);
  const approved = new Set(ranked.filter(({ p }) => p.opinion.confidence >= s.ai.minConfidence).slice(0, Math.max(0, slots)).map(({ i }) => i));
  const directive: BossDirective["mode"] = audit?.recommendation === "pause" ? "halt" : audit?.recommendation === "reduce-risk" ? "cautious" : "normal";
  return {
    verdicts: props.map((p, i) => ({
      approve: approved.has(i), size: 1, source: "rules",
      note: approved.has(i) ? `confidence ${p.opinion.confidence.toFixed(2)} within limits` : p.opinion.confidence < s.ai.minConfidence ? "confidence below minimum" : "no free slot",
    })),
    directive, note: "rules engine",
  };
}

// deterministic ceo fallback: trend of majors, breadth, macro and sentiment blended into a regime
export function rulesCeo(c: CeoContext): Omit<CeoPlan, "at" | "source"> {
  const btc = c.majors.find((m) => m.coin === "BTC");
  const trend = btc?.htf ?? 0;
  const breadth = c.breadthTotal ? c.breadthUp / c.breadthTotal : 0.5;
  const mcap = c.intel.macro?.mcapChange24h ?? 0;
  const fng = c.intel.fearGreed?.value ?? 50;
  const score = 0.4 * trend + 0.3 * (breadth - 0.5) * 2 + 0.2 * Math.max(-1, Math.min(1, mcap / 5)) + 0.1 * ((fng - 50) / 50);
  const regime: CeoPlan["regime"] = score > 0.25 ? "risk-on" : score < -0.25 ? "risk-off" : "neutral";
  const bias: CeoPlan["bias"] = {};
  for (const m of c.majors) if (m.htf !== null) bias[m.coin] = m.htf > 0.3 ? "long" : m.htf < -0.3 ? "short" : "neutral";
  const focus = c.majors.filter((m) => m.htf !== null && Math.abs(m.htf) > 0.3).sort((a, b) => Math.abs(b.htf!) - Math.abs(a.htf!)).slice(0, 3).map((m) => m.coin);
  return {
    regime, riskMultiplier: regime === "risk-on" ? 1 : regime === "neutral" ? 0.75 : 0.5, focus, avoid: [], bias,
    summary: `Composite ${score.toFixed(2)}: BTC trend ${trend.toFixed(2)}, breadth ${(breadth * 100).toFixed(0)}% up, mcap ${mcap.toFixed(1)}%, F&G ${fng}.`,
  };
}

// deterministic audit: hard numbers that do not need a model to interpret
export function rulesAudit(a: AuditContext): Omit<AuditReport, "at" | "source"> {
  const issues = [...a.flags];
  let rec: AuditReport["recommendation"] = "continue";
  if (a.drawdownPct >= a.killPct * 0.75 || a.dayLossPct >= a.dayLimitPct * 0.9) rec = "pause";
  else if (a.maxLossStreak >= 4 || a.drawdownPct >= a.killPct * 0.5 || (a.trades >= 10 && a.avgR < -0.2)) rec = "reduce-risk";
  const grade: AuditReport["grade"] = a.trades < 5 ? "C" : a.avgR > 0.3 && a.profitFactor > 1.5 ? "A" : a.avgR > 0.1 ? "B"
    : a.avgR > -0.1 ? "C" : a.avgR > -0.3 ? "D" : "F";
  return {
    grade, issues, recommendation: rec,
    summary: `${a.trades} trades in 7d, win ${(a.winRate * 100).toFixed(0)}%, avg R ${a.avgR.toFixed(2)}, DD ${a.drawdownPct.toFixed(1)}%.`,
  };
}
