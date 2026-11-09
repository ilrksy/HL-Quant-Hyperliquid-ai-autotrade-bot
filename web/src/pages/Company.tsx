import { useEffect, useMemo, useState } from "react";
import type { AgentView, DecisionView } from "../../../shared/types";
import { api, type AppState } from "../api";
import { ago, dateTime, px, time, tokens, until } from "../fmt";
import { refreshNow, useLive } from "../live";
import { Dot, Icon, Modal, Panel, ScoreBar, Stat, useAction } from "../ui";

// re-renders every second so countdowns stay accurate between pushes
function useTick(ms = 1000) {
  const [, set] = useState(0);
  useEffect(() => {
    const id = setInterval(() => set((n) => n + 1), ms);
    return () => clearInterval(id);
  }, [ms]);
}

// department order and labels for the org chart
const DEPTS: [AgentView["dept"], string][] = [["executive", "Executive"], ["audit", "Audit"], ["research", "Research"], ["risk", "Risk"], ["operations", "Operations"]];

// colour class per decision outcome
const OUTCOME: Record<DecisionView["outcome"], string> = { executed: "ok", rejected: "bad", skipped: "mut", advisory: "info", error: "warn" };

// command center for the ai trading company
export function Company({ s }: { s: AppState }) {
  useTick();
  const { busy, run } = useAction();
  const p = s.pipeline;
  const [detail, setDetail] = useState<DecisionView | null>(null);
  const live = s.mode === "live";

  const arm = () => {
    if (live && !confirm("Arm autotrade with REAL funds on Hyperliquid? Losses are possible and nothing guarantees profit.")) return;
    void run("arm", () => api.arm(live), "Autotrade armed").then(refreshNow);
  };
  const kill = () => confirm("Close every bot position at market and stop autotrade?") && run("kill", () => api.kill(), "Kill switch executed").then(refreshNow);

  return (
    <div className="page">
      <div className="page-h">
        <h1>AI Trading Company</h1>
        {p.active ? <span className="badge ok">active 24/7 daemon</span> : <span className="badge bad">stopped</span>}
        {s.bot.armed ? <span className="badge acc">autotrade armed</span> : s.bot.halted ? <span className="badge bad" title={s.bot.halted}>halted</span> : <span className="badge mut">analysis only</span>}
        <span className="badge mut">AI {s.ai.mode}</span>
        <div className="row right wrap">
          <button className="btn" disabled={!!busy} onClick={() => run("cycle", () => api.cycle()).then(refreshNow)}><Icon name="play" />Run cycle</button>
          {s.bot.armed
            ? <button className="btn" disabled={!!busy} onClick={() => run("disarm", () => api.disarm(), "Autotrade off").then(refreshNow)}><Icon name="stop" />Disarm</button>
            : <button className="btn primary" disabled={!!busy} onClick={arm}><Icon name="power" />Arm autotrade</button>}
          <button className="btn danger" disabled={!!busy} onClick={kill}><Icon name="shield" />Kill switch</button>
        </div>
      </div>

      {s.bot.halted && <div className="msg err">Halted: {s.bot.halted}. Review the audit and history, then arm again when ready.</div>}
      {s.directive && <div className={`msg ${s.directive.mode === "halt" ? "err" : "warn"}`}>Boss directive <b>{s.directive.mode.toUpperCase()}</b> until {time(s.directive.until)} — {s.directive.note || "no note"} <span className="dim">({s.directive.source})</span></div>}
      {p.lastError && <div className="msg err">Last cycle failed: {p.lastError}</div>}

      <Panel title={<><Icon name="bolt" size={13} /> Autonomous execution pipeline (Hyperliquid L1)</>} hl
        actions={<span className="small muted mono">cycle #{p.cycle} · every {p.cycleSec}s · last {p.lastCycleMs} ms {ago(p.lastCycleAt)} · next in {until(p.nextCycleAt)}</span>}>
        <div className="pipe">
          {p.stages.map((st) => (
            <div key={st.id} className={`stage ${st.status}`} title={st.detail}>
              <div className="h"><span>{st.n}. {st.title}</span><span className="right"><Dot s={st.status} /></span></div>
              <div className="m">{st.metric}</div>
              <div className="d">{st.detail || "—"}</div>
            </div>
          ))}
        </div>
        <div className="funnel" style={{ marginTop: 12 }}>
          {([["scanned", "Scanned"], ["candidates", "Candidates"], ["researched", "Confirmed"], ["passedRisk", "Sized"], ["approved", "Approved"], ["passedAudit", "Audited"], ["executed", "Executed"]] as const).map(([k, label], i) => {
            const v = p.funnel[k];
            const max = Math.max(1, p.funnel.scanned);
            return (
              <div key={k}>
                <span className="tiny muted upper">{i + 1}. {label}</span>
                <span className={`n ${k === "executed" && v ? "up" : ""}`}>{v}</span>
                <div className="bar"><i style={{ width: `${(v / max) * 100}%`, background: k === "executed" ? "var(--up)" : undefined }} /></div>
              </div>
            );
          })}
        </div>
      </Panel>

      <div className="grid g3">
        <Panel title="Boss · final authority" hl actions={<span className="badge mut">{s.ai.mode === "control" ? "AI in control" : s.ai.mode === "advisory" ? "AI advisory" : "rules only"}</span>}>
          <div className="col">
            <div className="kv"><span>Directive</span><span>{s.directive ? s.directive.mode.toUpperCase() : "NORMAL"}</span></div>
            <div className="kv"><span>Autotrade</span><span>{s.bot.armed ? "armed" : "off"}</span></div>
            <div className="kv"><span>Bot positions</span><span>{Object.keys(s.bot.managed).length}</span></div>
            <div className="kv"><span>Peak equity</span><span>${s.bot.peakEquity.toFixed(2)}</span></div>
            <div className="kv"><span>AI calls 24h</span><span>{s.ai.calls24h} · {tokens(s.ai.tokens24h)} tok · {s.ai.failures24h} failed</span></div>
            <div className="dim small">The Boss approves or rejects every sized trade and can halt the company. Hard limits (stop loss, leverage caps, daily loss limit, kill switch) are enforced in code and cannot be overridden by any model.</div>
          </div>
        </Panel>
        <Panel title="CEO · strategy" actions={<button className="btn sm" disabled={!!busy} onClick={() => run("ceo", () => api.runCeo(), "CEO plan updated").then(refreshNow)}><Icon name="refresh" size={12} />Re-plan</button>}>
          {!s.ceo ? <div className="empty">No plan yet</div> : (
            <div className="col">
              <div className="row wrap">
                <span className={`badge ${s.ceo.regime === "risk-on" ? "ok" : s.ceo.regime === "risk-off" ? "bad" : "mut"}`}>{s.ceo.regime}</span>
                <span className="badge mut">risk ×{s.ceo.riskMultiplier.toFixed(2)}</span>
                <span className="dim small right">{ago(s.ceo.at)} · {s.ceo.source}</span>
              </div>
              <div className="small">{s.ceo.summary}</div>
              {!!s.ceo.focus.length && <div className="kv"><span>Focus</span><span>{s.ceo.focus.join(", ")}</span></div>}
              {!!s.ceo.avoid.length && <div className="kv"><span>Avoid</span><span className="down">{s.ceo.avoid.join(", ")}</span></div>}
              <div className="row wrap gap-4">
                {Object.entries(s.ceo.bias).map(([c, b]) => <span key={c} className={`badge solid ${b === "long" ? "ok" : b === "short" ? "bad" : "mut"}`}>{c} {b}</span>)}
              </div>
            </div>
          )}
        </Panel>
        <Panel title="Auditor · compliance" actions={<button className="btn sm" disabled={!!busy} onClick={() => run("audit", () => api.runAudit(), "Audit complete").then(refreshNow)}><Icon name="check" size={12} />Audit now</button>}>
          {!s.audit ? <div className="empty">No audit yet</div> : (
            <div className="col">
              <div className="row wrap">
                <span className="mono" style={{ fontSize: 26, lineHeight: 1, color: ["A", "B"].includes(s.audit.grade) ? "var(--up)" : s.audit.grade === "C" ? "var(--warn)" : "var(--down)" }}>{s.audit.grade}</span>
                <span className={`badge ${s.audit.recommendation === "continue" ? "ok" : s.audit.recommendation === "pause" ? "bad" : "warn"}`}>{s.audit.recommendation}</span>
                <span className="dim small right">{ago(s.audit.at)} · {s.audit.source}</span>
              </div>
              <div className="small">{s.audit.summary}</div>
              {s.audit.issues.map((x, i) => <div key={i} className="small warn-t">• {x}</div>)}
              <div className="dim small">Every order also passes a deterministic pre-trade audit: side, R:R, liquidation distance, caps, price drift and signal freshness.</div>
            </div>
          )}
        </Panel>
      </div>

      <div className="grid g2">
        <Panel title="Signals" flush actions={<span className="dim small">quant score −1 … +1 on closed bars</span>}>
          <div className="scroll" style={{ maxHeight: 340 }}>
            <table>
              <thead><tr><th>Market</th><th className="l">Regime</th><th>Score</th><th>Action</th><th>Price</th><th className="l">Lead factor</th></tr></thead>
              <tbody>
                {Object.values(s.signals).sort((a, b) => Math.abs(b.score) - Math.abs(a.score)).map((g) => {
                  const lead = [...g.factors].sort((a, b) => Math.abs(b.value * b.weight) - Math.abs(a.value * a.weight))[0];
                  return (
                    <tr key={g.coin} title={g.reason}>
                      <td style={{ fontFamily: "var(--sans)", fontWeight: 600 }}>{g.coin}</td>
                      <td className="l muted">{g.regime}</td>
                      <td><ScoreBar v={g.score} /> <span className={g.score > 0 ? "up" : g.score < 0 ? "down" : ""}>{g.score.toFixed(2)}</span></td>
                      <td className={g.action === "long" ? "up" : g.action === "short" ? "down" : "muted"}>{g.action}</td>
                      <td>{px(g.price)}</td>
                      <td className="l muted">{lead ? `${lead.name} ${lead.value.toFixed(2)}` : g.reason.slice(0, 40)}</td>
                    </tr>
                  );
                })}
                {!Object.keys(s.signals).length && <tr><td colSpan={6} className="empty">Waiting for the first cycle…</td></tr>}
              </tbody>
            </table>
          </div>
        </Panel>
        <Panel title="Decisions" flush actions={<a className="small" href="#/history">full history</a>}>
          <div className="scroll" style={{ maxHeight: 340 }}>
            <table>
              <thead><tr><th>Time</th><th className="l">Market</th><th className="l">Outcome</th><th className="l">Reason</th></tr></thead>
              <tbody>
                {s.decisions.map((d) => (
                  <tr key={d.id} className="click" onClick={() => setDetail(d)}>
                    <td className="muted">{time(d.ts)}</td>
                    <td className="l"><span className={d.side === "long" ? "up" : "down"}>{d.coin} {d.side}</span></td>
                    <td className="l"><span className={`badge ${OUTCOME[d.outcome]}`}>{d.outcome}</span> <span className="dim tiny">@{d.stage}</span></td>
                    <td className="wrap small">{d.reason || d.research?.thesis}</td>
                  </tr>
                ))}
                {!s.decisions.length && <tr><td colSpan={4} className="empty">No candidates yet. The quant layer only forwards setups that clear the entry threshold.</td></tr>}
              </tbody>
            </table>
          </div>
        </Panel>
      </div>

      <OrgChart agents={s.agents} />

      <div className="grid g2">
        <IntelPanel s={s} busy={!!busy} onDeep={() => run("deep", () => api.runDeep(), "Deep research started")} />
        <ActivityPanel />
      </div>

      {detail && <DecisionModal d={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}

// agents grouped by department with live status, model and workload
function OrgChart({ agents }: { agents: AgentView[] }) {
  return (
    <Panel title="Organisation" actions={<span className="dim small">{agents.filter((a) => a.status === "working").length} working · {agents.length} agents</span>}>
      <div className="col gap-12">
        {DEPTS.map(([dept, label]) => {
          const list = agents.filter((a) => a.dept === dept);
          if (!list.length) return null;
          return (
            <div key={dept} className="dept">
              <span className="lbl">{label}</span>
              <div className="org">
                {list.map((a) => (
                  <div key={a.id} className={`agent ${a.dept === "executive" ? "exec" : ""}`} title={a.duty}>
                    <div className="nm"><Dot s={a.status} />{a.name}<span className={`badge right ${a.kind === "ai" ? "acc" : a.kind === "quant" ? "info" : "mut"}`}>{a.kind}</span></div>
                    <div className="ttl">{a.title}{a.reportsTo ? ` · reports to ${agents.find((x) => x.id === a.reportsTo)?.name ?? a.reportsTo}` : ""}</div>
                    <div className="act">{a.lastAction}</div>
                    <div className="meta">
                      <span>{a.runs} runs</span>{a.avgMs > 0 && <span>{a.avgMs} ms</span>}{a.errors > 0 && <span className="down">{a.errors} err</span>}
                      {a.provider && <span className="accent">{a.provider}{a.model ? ` · ${a.model}` : ""}</span>}{a.tokens > 0 && <span>{tokens(a.tokens)} tok</span>}
                      {a.lastAt > 0 && <span>{ago(a.lastAt)}</span>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

// sentiment, macro, headlines and the antigravity deep research briefing
function IntelPanel({ s, busy, onDeep }: { s: AppState; busy: boolean; onDeep: () => void }) {
  const i = s.intel;
  return (
    <Panel title="Market intelligence" actions={<button className="btn sm" disabled={busy} onClick={onDeep} title="Runs the deep research analyst now (Antigravity or the provider routed to Deep research)"><Icon name="search" size={12} />Deep research</button>}>
      <div className="col">
        <div className="stats">
          <Stat k="Fear & Greed" v={i.fearGreed ? i.fearGreed.value : "—"} s={i.fearGreed?.label} tone={i.fearGreed ? (i.fearGreed.value >= 55 ? "up" : i.fearGreed.value <= 45 ? "down" : "") : ""} />
          <Stat k="BTC dominance" v={i.macro ? `${i.macro.btcDominance.toFixed(1)}%` : "—"} />
          <Stat k="Market cap 24h" v={i.macro ? `${i.macro.mcapChange24h >= 0 ? "+" : ""}${i.macro.mcapChange24h.toFixed(2)}%` : "—"} tone={i.macro ? (i.macro.mcapChange24h >= 0 ? "up" : "down") : ""} />
          <Stat k="News sentiment" v={i.newsScore.toFixed(2)} tone={i.newsScore > 0.05 ? "up" : i.newsScore < -0.05 ? "down" : ""} s="keyword score, 24h" />
        </div>
        {i.deepResearch && <div className="msg"><b className="accent">Deep research</b> <span className="dim small">{ago(i.deepResearch.at)} · {i.deepResearch.source}</span><div className="small" style={{ marginTop: 4 }}>{i.deepResearch.summary}</div></div>}
        <div className="col gap-4">
          {i.news.slice(0, 8).map((n, k) => (
            <div key={k} className="row top small">
              <span className={`dot ${n.score > 0 ? "ok" : n.score < 0 ? "error" : "idle"}`} style={{ marginTop: 5 }} />
              <span className="grow">{n.title} <span className="dim">· {n.source} · {ago(n.at)}{n.coins.length ? ` · ${n.coins.join(",")}` : ""}</span></span>
            </div>
          ))}
          {!i.news.length && <div className="dim small">No headlines loaded (news worker disabled or feeds unreachable).</div>}
        </div>
      </div>
    </Panel>
  );
}

// live tail of the history log streamed from the server
function ActivityPanel() {
  const { logs } = useLive();
  const rows = useMemo(() => logs.filter((l) => l.level !== "debug").slice(0, 60), [logs]);
  return (
    <Panel title="Live activity" flush actions={<a className="small" href="#/history">open log</a>}>
      <div className="scroll feed" style={{ maxHeight: 420 }}>
        {rows.map((l) => (
          <div key={`${l.id}-${l.ts}`} className="line">
            <span className="dim">{time(l.ts)}</span>
            <span className="muted ag ellipsis">{l.agent}</span>
            <span className={`msgc lv-${l.level}`}>{l.msg}</span>
          </div>
        ))}
        {!rows.length && <div className="empty">No activity yet</div>}
      </div>
    </Panel>
  );
}

// full trail of one decision through every stage
function DecisionModal({ d, onClose }: { d: DecisionView; onClose: () => void }) {
  return (
    <Modal title={`${d.coin} ${d.side} · cycle #${d.cycle}`} onClose={onClose}>
      <div className="row wrap"><span className={`badge ${OUTCOME[d.outcome]}`}>{d.outcome}</span><span className="muted small">at {d.stage} · {dateTime(d.ts)} · quant {d.score.toFixed(2)} ({d.regime})</span></div>
      {d.reason && <div className="msg">{d.reason}</div>}
      {d.research && (
        <div><div className="tiny upper muted">Research · {d.research.source}</div>
          <div className="kv"><span>Decision</span><span>{d.research.decision} · confidence {d.research.confidence.toFixed(2)}</span></div>
          <div className="small">{d.research.thesis}</div></div>
      )}
      {d.risk && (
        <div><div className="tiny upper muted">Risk</div>
          <div className="kv"><span>Notional / leverage</span><span>${d.risk.notional.toFixed(2)} · {d.risk.leverage}x</span></div>
          <div className="kv"><span>Stop / target</span><span>{px(d.risk.stopPx)} / {px(d.risk.takePx)}</span></div>
          <div className="kv"><span>Risk at stop</span><span>${d.risk.riskUsd.toFixed(3)}</span></div>
          {!d.risk.ok && <div className="small down">{d.risk.reason}</div>}</div>
      )}
      {d.boss && (
        <div><div className="tiny upper muted">Boss · {d.boss.source}</div>
          <div className="kv"><span>Verdict</span><span>{d.boss.approve ? "approved" : "rejected"} · size ×{d.boss.size}</span></div>
          {d.boss.note && <div className="small">{d.boss.note}</div>}</div>
      )}
      {d.audit && (
        <div><div className="tiny upper muted">Pre-trade audit</div>
          <div className="small">{d.audit.ok ? <span className="up">passed all checks</span> : d.audit.issues.map((x, i) => <div key={i} className="down">• {x}</div>)}</div></div>
      )}
    </Modal>
  );
}
