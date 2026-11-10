import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import type { AiCallView, DecisionView, EventView, TradeView } from "../../../shared/types";
import { api, exportUrl } from "../api";
import { dateTime, dur, px, susd, time, tone } from "../fmt";
import { useLive } from "../live";
import { Icon, Panel, Tabs, Toggle, toast } from "../ui";

// log categories for the filter
const CATS = ["", "pipeline", "trade", "ai", "risk", "audit", "intel", "telegram", "system"];
// agents that write history entries
const AGENTS = ["", "boss", "ceo", "auditor", "research", "risk", "ops", "scout", "quant", "flow", "derivs", "sentiment", "deep", "leverage", "guard", "trader", "monitor", "accountant", "reporter", "gateway", "manual"];

// one place for every kind of history: activity log, decisions, ai calls, cycles and trades
export function History() {
  const [tab, setTab] = useState<"log" | "dec" | "ai" | "cyc" | "trades">("log");
  return (
    <div className="page">
      <div className="page-h"><h1>History</h1><span className="muted small">Everything the company did, stored on the server (90-day retention).</span></div>
      <Panel flush>
        <Tabs value={tab} onChange={setTab} tabs={[["log", "Activity log"], ["dec", "Decisions"], ["ai", "AI calls"], ["cyc", "Cycles"], ["trades", "Trades"]]} />
        {tab === "log" && <LogTab />}
        {tab === "dec" && <DecisionsTab />}
        {tab === "ai" && <AiTab />}
        {tab === "cyc" && <CyclesTab />}
        {tab === "trades" && <TradesTab />}
      </Panel>
    </div>
  );
}

// filterable, paginated event log with live tail and export
function LogTab() {
  const [f, setF] = useState({ cat: "", level: "", agent: "", coin: "", q: "" });
  const [rows, setRows] = useState<EventView[]>([]);
  const [follow, setFollow] = useState(true);
  const [more, setMore] = useState(true);
  const { logs } = useLive();
  const query = useMemo(() => ({ cat: f.cat || undefined, level: f.level || undefined, agent: f.agent || undefined, coin: f.coin.trim() || undefined, q: f.q.trim() || undefined }), [f]);

  useEffect(() => {
    const t = setTimeout(() => {
      api.logs({ ...query, limit: 200 }).then((r) => { setRows(r); setMore(r.length === 200); }).catch((e) => toast((e as Error).message, false));
    }, 250);
    return () => clearTimeout(t);
  }, [query]);

  useEffect(() => {
    if (!follow || !logs.length) return;
    const match = (e: EventView) => e.id > 0 && (!query.cat || e.cat === query.cat) && (!query.agent || e.agent === query.agent)
      && (!query.coin || e.coin === query.coin.toUpperCase()) && (!query.q || e.msg.toLowerCase().includes(query.q.toLowerCase()))
      && (!query.level || (query.level === "warn+" ? e.level === "warn" || e.level === "error" : e.level === query.level));
    setRows((prev) => {
      const top = prev[0]?.id ?? 0;
      const fresh = logs.filter((e) => e.id > top && match(e));
      return fresh.length ? [...fresh, ...prev].slice(0, 2000) : prev;
    });
  }, [logs, follow, query]);

  const older = () => {
    const last = rows[rows.length - 1];
    if (!last) return;
    api.logs({ ...query, before: last.id, limit: 200 }).then((r) => { setRows((p) => [...p, ...r]); setMore(r.length === 200); }).catch((e) => toast((e as Error).message, false));
  };
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });

  return (
    <>
      <div className="row wrap pad-s" style={{ borderBottom: "1px solid var(--line)" }}>
        <select className="select" style={{ width: 130 }} value={f.cat} onChange={set("cat")}>{CATS.map((c) => <option key={c} value={c}>{c || "all categories"}</option>)}</select>
        <select className="select" style={{ width: 130 }} value={f.level} onChange={set("level")}>
          {[["", "all levels"], ["warn+", "warnings + errors"], ["error", "errors"], ["success", "success"], ["info", "info"]].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <select className="select" style={{ width: 130 }} value={f.agent} onChange={set("agent")}>{AGENTS.map((a) => <option key={a} value={a}>{a || "all agents"}</option>)}</select>
        <input className="input" style={{ width: 90 }} placeholder="coin" value={f.coin} onChange={set("coin")} />
        <input className="input" style={{ width: 200 }} placeholder="search text" value={f.q} onChange={set("q")} />
        <label className="row small muted"><Toggle on={follow} onChange={setFollow} /> live</label>
        <div className="row right">
          <a className="btn sm" href={exportUrl("/api/logs/export", { ...query, format: "csv" })} target="_blank" rel="noreferrer"><Icon name="download" size={12} />CSV</a>
          <a className="btn sm" href={exportUrl("/api/logs/export", { ...query, format: "json" })} target="_blank" rel="noreferrer"><Icon name="download" size={12} />JSON</a>
        </div>
      </div>
      <div className="feed scroll" style={{ maxHeight: "calc(100dvh - 230px)" }}>
        {rows.map((l) => (
          <div key={l.id} className="line" title={l.data ? JSON.stringify(l.data, null, 2) : undefined}>
            <span className="dim">{time(l.ts)}</span>
            <span className="muted ag ellipsis">{l.cat}·{l.agent}</span>
            <span className={`msgc lv-${l.level}`}>{l.coin && <span className="badge mut" style={{ marginRight: 6 }}>{l.coin}</span>}{l.msg}{l.cycle ? <span className="dim"> · #{l.cycle}</span> : null}<span className="dim"> · {dateTime(l.ts)}</span></span>
          </div>
        ))}
        {!rows.length && <div className="empty">No entries match these filters</div>}
        {more && rows.length > 0 && <div className="pad" style={{ textAlign: "center" }}><button className="btn sm" onClick={older}>Load older</button></div>}
      </div>
    </>
  );
}

// every candidate's verdict with its stage trail
function DecisionsTab() {
  const [rows, setRows] = useState<DecisionView[]>([]);
  const [outcome, setOutcome] = useState("");
  const [open, setOpen] = useState<number | null>(null);
  useEffect(() => { api.decisions({ outcome: outcome || undefined, limit: 300 }).then(setRows).catch((e) => toast((e as Error).message, false)); }, [outcome]);
  return (
    <>
      <div className="row pad-s" style={{ borderBottom: "1px solid var(--line)" }}>
        <select className="select" style={{ width: 160 }} value={outcome} onChange={(e) => setOutcome(e.target.value)}>{["", "executed", "rejected", "skipped", "error"].map((o) => <option key={o} value={o}>{o || "all outcomes"}</option>)}</select>
        <span className="dim small">Click a row for the full trail.</span>
      </div>
      <div className="scroll" style={{ maxHeight: "calc(100dvh - 230px)" }}>
        <table>
          <thead><tr><th>Time</th><th>Cycle</th><th className="l">Market</th><th>Quant</th><th className="l">Stage</th><th className="l">Outcome</th><th className="l">Research</th><th className="l">Boss</th><th className="l">Reason</th></tr></thead>
          <tbody>
            {rows.map((d) => (
              <Fragment key={d.id}>
                <tr className="click" onClick={() => setOpen(open === d.id ? null : d.id)}>
                  <td className="muted">{dateTime(d.ts)}</td><td className="muted">#{d.cycle}</td>
                  <td className="l"><span className={d.side === "long" ? "up" : "down"}>{d.coin} {d.side}</span></td><td>{d.score.toFixed(2)}</td>
                  <td className="l muted">{d.stage}</td>
                  <td className="l"><span className={`badge ${d.outcome === "executed" ? "ok" : d.outcome === "rejected" ? "bad" : d.outcome === "error" ? "warn" : "mut"}`}>{d.outcome}</span></td>
                  <td className="l small">{d.research ? `${d.research.decision} ${d.research.confidence.toFixed(2)}` : "—"} <span className="dim">{d.research?.source?.split("/")[0]}</span></td>
                  <td className="l small">{d.boss ? (d.boss.approve ? "approved" : "rejected") : "—"} <span className="dim">{d.boss?.source?.split("/")[0]}</span></td>
                  <td className="l wrap small">{d.reason}</td>
                </tr>
                {open === d.id && (
                  <tr><td colSpan={9} className="wrap small" style={{ background: "var(--bg)" }}>
                    {d.research && <div><b>Research</b> ({d.research.source}): {d.research.thesis}</div>}
                    {d.risk && <div><b>Risk</b>: ${d.risk.notional.toFixed(2)} at {d.risk.leverage}x, stop {px(d.risk.stopPx)}, target {px(d.risk.takePx)}, risk ${d.risk.riskUsd.toFixed(3)} {d.risk.ok ? "" : `— ${d.risk.reason}`}</div>}
                    {d.boss && <div><b>Boss</b> ({d.boss.source}): {d.boss.approve ? "approve" : "reject"} ×{d.boss.size} {d.boss.note}</div>}
                    {d.audit && <div><b>Audit</b>: {d.audit.ok ? "passed" : d.audit.issues.join("; ")}</div>}
                  </td></tr>
                )}
              </Fragment>
            ))}
            {!rows.length && <tr><td colSpan={9} className="empty">No decisions yet</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}

// raw model requests with fallback depth and errors
function AiTab() {
  const [rows, setRows] = useState<AiCallView[]>([]);
  const [status, setStatus] = useState("");
  const [role, setRole] = useState("");
  const load = useCallback((before?: number) => api.aiCalls({ status: status || undefined, role: role || undefined, before, limit: 200 }), [status, role]);
  useEffect(() => { load().then(setRows).catch((e) => toast((e as Error).message, false)); }, [load]);
  return (
    <>
      <div className="row wrap pad-s" style={{ borderBottom: "1px solid var(--line)" }}>
        <select className="select" style={{ width: 140 }} value={role} onChange={(e) => setRole(e.target.value)}>{["", "boss", "research", "ceo", "auditor", "intel"].map((o) => <option key={o} value={o}>{o || "all roles"}</option>)}</select>
        <select className="select" style={{ width: 160 }} value={status} onChange={(e) => setStatus(e.target.value)}>{["", "ok", "rate_limited", "auth", "server", "timeout", "network", "bad_output", "bad_request"].map((o) => <option key={o} value={o}>{o || "all statuses"}</option>)}</select>
      </div>
      <div className="scroll" style={{ maxHeight: "calc(100dvh - 230px)" }}>
        <table>
          <thead><tr><th>Time</th><th className="l">Role</th><th className="l">Provider · key</th><th className="l">Model</th><th className="l">Status</th><th>HTTP</th><th>Latency</th><th>Fallback</th><th>In / out</th><th className="l">Error</th></tr></thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id}>
                <td className="muted">{dateTime(c.ts)}</td><td className="l">{c.role}</td><td className="l">{c.provider} <span className="dim">· {c.keyLabel}</span></td><td className="l muted">{c.model}</td>
                <td className="l"><span className={`badge ${c.status === "ok" ? "ok" : c.status === "auth" || c.status === "bad_request" ? "bad" : "warn"}`}>{c.status}</span></td>
                <td className="muted">{c.http ?? "—"}</td><td>{c.latency} ms</td><td className={c.depth ? "warn-t" : "dim"}>{c.depth ? `#${c.depth}` : "primary"}</td>
                <td className="muted">{c.tokIn}/{c.tokOut}</td><td className="l wrap small down">{c.error}</td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={10} className="empty">No AI calls recorded</td></tr>}
          </tbody>
        </table>
        {rows.length >= 200 && <div className="pad" style={{ textAlign: "center" }}><button className="btn sm" onClick={() => load(rows[rows.length - 1].id).then((r) => setRows((p) => [...p, ...r]))}>Load older</button></div>}
      </div>
    </>
  );
}

// one row per pipeline pass with its funnel counts and timing
function CyclesTab() {
  const [rows, setRows] = useState<Awaited<ReturnType<typeof api.cycles>>>([]);
  useEffect(() => { api.cycles(300).then(setRows).catch((e) => toast((e as Error).message, false)); }, []);
  return (
    <div className="scroll" style={{ maxHeight: "calc(100dvh - 200px)" }}>
      <table>
        <thead><tr><th>Cycle</th><th>Time</th><th>Duration</th><th>Scanned</th><th>Candidates</th><th>Sized</th><th>Approved</th><th>Executed</th></tr></thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.id}><td>#{c.id}</td><td className="muted">{dateTime(c.ts)}</td><td>{c.ms} ms</td><td>{c.scanned}</td><td>{c.candidates}</td><td>{c.proposals}</td><td>{c.approved}</td><td className={c.executed ? "up" : "dim"}>{c.executed}</td></tr>
          ))}
          {!rows.length && <tr><td colSpan={8} className="empty">No cycles yet</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

// closed trades journal for the current mode
function TradesTab() {
  const [rows, setRows] = useState<TradeView[]>([]);
  const [source, setSource] = useState("");
  useEffect(() => { api.trades({ source: source || undefined, limit: 1000 }).then(setRows).catch((e) => toast((e as Error).message, false)); }, [source]);
  return (
    <>
      <div className="row pad-s" style={{ borderBottom: "1px solid var(--line)" }}>
        <select className="select" style={{ width: 140 }} value={source} onChange={(e) => setSource(e.target.value)}>{["", "bot", "manual"].map((o) => <option key={o} value={o}>{o || "bot + manual"}</option>)}</select>
        <a className="btn sm right" href={exportUrl("/api/trades/export", { format: "csv" })} target="_blank" rel="noreferrer"><Icon name="download" size={12} />Export CSV</a>
      </div>
      <TradeTable rows={rows} />
    </>
  );
}

// shared trade table used by history and portfolio
export function TradeTable({ rows, max = "calc(100dvh - 230px)" }: { rows: TradeView[]; max?: string }) {
  return (
    <div className="scroll" style={{ maxHeight: max }}>
      <table>
        <thead><tr><th>Closed</th><th className="l">Market</th><th className="l">Source</th><th>Size</th><th>Entry</th><th>Exit</th><th>PnL</th><th>R</th><th>Fees</th><th>Held</th><th className="l">Exit</th><th className="l">Thesis</th></tr></thead>
        <tbody>
          {rows.map((t) => (
            <tr key={t.id}>
              <td className="muted">{dateTime(t.closed)}</td>
              <td className="l"><span className={t.side === "long" ? "up" : "down"}>{t.coin} {t.side}</span>{t.leverage ? <span className="dim"> {t.leverage}x</span> : null}</td>
              <td className="l"><span className={`badge ${t.source === "bot" ? "acc" : "mut"}`}>{t.source}</span></td>
              <td>{t.size}</td><td>{px(t.entry)}</td><td>{px(t.exit)}</td>
              <td className={tone(t.pnl)}>{susd(t.pnl, 4)}</td><td className={tone(t.r)}>{t.r.toFixed(2)}</td><td className="muted">${t.fees.toFixed(4)}</td>
              <td className="muted">{dur((t.closed - t.opened) / 60000)}</td><td className="l muted">{t.exitReason}</td><td className="l wrap small dim">{t.entryReason}</td>
            </tr>
          ))}
          {!rows.length && <tr><td colSpan={12} className="empty">No closed trades yet</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
