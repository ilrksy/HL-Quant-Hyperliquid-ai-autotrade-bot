import { useEffect, useState } from "react";
import type { PortfolioStats, TradeView } from "../../../shared/types";
import { api, type AppState, exportUrl } from "../api";
import { BarChart, LineChart } from "../components/Chart";
import { dur, pct, px, susd, tokens, tone, usd } from "../fmt";
import { Icon, Panel, Seg, Stat, toast } from "../ui";
import { TradeTable } from "./History";

// profile page: account, equity curve, performance statistics, positions and trade history
export function Portfolio({ s }: { s: AppState }) {
  const [range, setRange] = useState<"24h" | "7d" | "30d" | "all">("30d");
  const [st, setSt] = useState<PortfolioStats | null>(null);
  const [trades, setTrades] = useState<TradeView[]>([]);
  useEffect(() => {
    const load = () => Promise.all([api.portfolio(range), api.trades({ limit: 300 })]).then(([p, t]) => { setSt(p); setTrades(t); }).catch((e) => toast((e as Error).message, false));
    void load();
    const id = setInterval(load, 15_000);
    return () => clearInterval(id);
  }, [range]);
  const a = s.account;
  const equity = a?.equity ?? 0;
  const ret = st && st.startEquity > 0 ? ((equity - st.startEquity) / st.startEquity) * 100 : 0;

  return (
    <div className="page">
      <div className="page-h">
        <h1>Portfolio</h1>
        <span className={`badge ${s.mode === "live" ? "bad" : "info"}`}>{s.mode}</span>
        {a?.address && <span className="mono small muted">{a.address}</span>}
        <div className="right"><Seg value={range} onChange={setRange} options={["24h", "7d", "30d", "all"]} /></div>
      </div>

      <div className="stats">
        <Stat k="Equity" v={usd(equity)} s={`available ${usd(a?.available)} · margin ${usd(a?.marginUsed)}`} />
        <Stat k={`Return (${range})`} v={pct(ret)} tone={tone(ret)} s={st ? `from ${usd(st.startEquity)}` : undefined} />
        <Stat k="Net PnL" v={st ? susd(st.netPnl, 3) : "—"} tone={tone(st?.netPnl ?? 0)} s={st ? `fees ${usd(st.fees, 3)}` : undefined} />
        <Stat k="Trades" v={st?.trades ?? "—"} s={st ? `${st.wins} W / ${st.losses} L` : undefined} />
        <Stat k="Win rate" v={st ? `${(st.winRate * 100).toFixed(1)}%` : "—"} />
        <Stat k="Profit factor" v={st ? (Number.isFinite(st.profitFactor) ? st.profitFactor.toFixed(2) : "∞") : "—"} tone={st && st.profitFactor >= 1 ? "up" : st && st.trades ? "down" : ""} />
        <Stat k="Avg R / expectancy" v={st ? st.avgR.toFixed(2) : "—"} s={st ? `${susd(st.expectancy, 4)} per trade` : undefined} tone={tone(st?.avgR ?? 0)} />
        <Stat k="Max drawdown" v={st ? `${st.maxDrawdownPct.toFixed(2)}%` : "—"} tone={st && st.maxDrawdownPct > 0 ? "down" : ""} />
        <Stat k="Best / worst" v={st && st.trades ? <><span className="up">{st.best > 0 ? susd(st.best, 3) : "—"}</span> <span className="down">{st.worst < 0 ? susd(st.worst, 3) : "—"}</span></> : "—"} />
        <Stat k="Streaks" v={st ? `${st.longestWinStreak}W / ${st.longestLossStreak}L` : "—"} s="longest" />
        <Stat k="Avg hold" v={st ? dur(st.avgHoldMin) : "—"} />
        <Stat k="AI usage 24h" v={st ? `${st.ai.calls24h} calls` : "—"} s={st ? `${tokens(st.ai.tokens24h)} tok · ${st.ai.fallbacks24h} fallbacks · ${st.ai.ruleDecisions24h} rule decisions` : undefined} />
      </div>

      <div className="grid g2">
        <Panel title="Equity curve" flush>{st && st.equity.length > 1 ? <LineChart data={st.equity} height={260} /> : <div className="empty">Equity is sampled every minute while the server runs</div>}</Panel>
        <Panel title="Daily PnL" flush>{st && st.byDay.length ? <BarChart data={st.byDay.map((d) => ({ day: d.day, v: d.pnl }))} height={260} /> : <div className="empty">No closed trades in this range</div>}</Panel>
      </div>

      <div className="grid g2">
        <Panel title="Open positions" flush>
          {!a?.positions.length ? <div className="empty">Flat</div> : (
            <table>
              <thead><tr><th className="l">Market</th><th>Size</th><th>Entry</th><th>Mark</th><th>PnL</th><th>TP / SL</th></tr></thead>
              <tbody>{a.positions.map((p) => (
                <tr key={p.coin}><td className="l"><span className={p.side === "long" ? "up" : "down"}>{p.coin} {p.side}</span> <span className="dim">{p.leverage}x</span></td>
                  <td>{p.size}</td><td>{px(p.entryPx)}</td><td>{px(p.markPx)}</td><td className={tone(p.unrealizedPnl)}>{susd(p.unrealizedPnl, 3)}</td>
                  <td><span className="up">{px(p.takePx)}</span> / <span className="down">{px(p.stopPx)}</span></td></tr>
              ))}</tbody>
            </table>
          )}
        </Panel>
        <Panel title="Performance by market" flush>
          {!st?.byCoin.length ? <div className="empty">No closed trades in this range</div> : (
            <table>
              <thead><tr><th className="l">Market</th><th>Trades</th><th>Win rate</th><th>PnL</th></tr></thead>
              <tbody>{st.byCoin.map((c) => <tr key={c.coin}><td className="l">{c.coin}</td><td>{c.trades}</td><td>{(c.winRate * 100).toFixed(0)}%</td><td className={tone(c.pnl)}>{susd(c.pnl, 4)}</td></tr>)}</tbody>
            </table>
          )}
        </Panel>
      </div>

      <Panel title="Trade history" flush actions={<a className="btn sm" href={exportUrl("/api/trades/export", { format: "csv" })} target="_blank" rel="noreferrer"><Icon name="download" size={12} />Export CSV</a>}>
        <TradeTable rows={trades} max="520px" />
      </Panel>
      <div className="dim small">Results shown are real paper or live fills including fees. No strategy or AI model can guarantee profit; leverage can lose the entire deposit.</div>
    </div>
  );
}
