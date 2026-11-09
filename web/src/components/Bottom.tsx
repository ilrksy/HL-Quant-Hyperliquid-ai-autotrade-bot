import { useState } from "react";
import { api, type AppState, type BacktestResponse } from "../api";
import { dateTime, pct, px, time, tone, usd } from "../fmt";
import { LineChart } from "./Chart";

// drawer tabs in display order
const TABS = ["Positions", "Orders", "Fills", "Bot trades", "Log", "Equity", "Backtest"] as const;

// account tables and research tools under the chart, like an exchange's bottom drawer
export function Bottom({ s, refresh, coin }: { s: AppState; refresh: () => void; coin: string }) {
  const [tab, setTab] = useState<(typeof TABS)[number]>("Positions");
  const a = s.account;
  const counts: Partial<Record<(typeof TABS)[number], number>> = {
    Positions: a?.positions.length, Orders: a?.orders.length,
  };
  return (
    <div className="panel bottom">
      <div className="tabs">
        {TABS.map((t) => (
          <button key={t} className={t === tab ? "on" : ""} onClick={() => setTab(t)}>
            {t}{counts[t] ? ` (${counts[t]})` : ""}
          </button>
        ))}
      </div>
      {tab === "Positions" && <Positions s={s} refresh={refresh} />}
      {tab === "Orders" && <Orders s={s} refresh={refresh} />}
      {tab === "Fills" && <Fills s={s} />}
      {tab === "Bot trades" && <Trades s={s} />}
      {tab === "Log" && <Log s={s} />}
      {tab === "Equity" && (
        <div className="scroll">
          {s.equityCurve.length < 2
            ? <div className="empty">collecting equity samples…</div>
            : <LineChart data={s.equityCurve.map((p) => ({ t: p.t, v: p.equity }))} />}
        </div>
      )}
      {tab === "Backtest" && <Backtest defaultCoin={coin} s={s} />}
    </div>
  );
}

// open positions with one-click market close
function Positions({ s, refresh }: { s: AppState; refresh: () => void }) {
  const rows = s.account?.positions ?? [];
  if (!rows.length) return <div className="empty">No open positions</div>;
  return (
    <div className="scroll">
      <table>
        <thead><tr><th>Coin</th><th>Size</th><th>Value</th><th>Entry</th><th>Mark</th><th>PnL (ROE)</th><th>Liq.</th><th>SL / TP</th><th>Bot</th><th /></tr></thead>
        <tbody>
          {rows.map((p) => {
            const margin = (p.entryPx * p.size) / p.leverage;
            return (
              <tr key={p.coin}>
                <td className={p.side === "long" ? "up" : "down"}>{p.coin} {p.leverage}x {p.side}</td>
                <td>{p.size}</td>
                <td>{usd(p.markPx * p.size)}</td>
                <td>{px(p.entryPx)}</td>
                <td>{px(p.markPx)}</td>
                <td className={tone(p.unrealizedPnl)}>{usd(p.unrealizedPnl, 3)} ({pct((p.unrealizedPnl / margin) * 100, 1)})</td>
                <td className="muted">{px(p.liquidationPx)}</td>
                <td><span className="down">{px(p.stopPx)}</span> / <span className="up">{px(p.takePx)}</span></td>
                <td>{s.bot.managed[p.coin] ? <span className="amber">auto</span> : <span className="muted">manual</span>}</td>
                <td><button className="btn sm" onClick={() => api.close(p.coin).then(refresh)}>Market close</button></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// resting and trigger orders with cancel
function Orders({ s, refresh }: { s: AppState; refresh: () => void }) {
  const rows = s.account?.orders ?? [];
  if (!rows.length) return <div className="empty">No open orders</div>;
  return (
    <div className="scroll">
      <table>
        <thead><tr><th>Time</th><th>Coin</th><th>Type</th><th>Side</th><th>Price</th><th>Size</th><th>Reduce</th><th /></tr></thead>
        <tbody>
          {rows.map((o) => (
            <tr key={o.oid}>
              <td className="muted">{dateTime(o.time)}</td><td>{o.coin}</td><td>{o.type}</td>
              <td className={o.side === "long" ? "up" : "down"}>{o.side === "long" ? "buy" : "sell"}</td>
              <td>{px(o.px)}</td><td>{o.size}</td><td className="muted">{o.reduceOnly ? "yes" : ""}</td>
              <td><button className="btn sm" onClick={() => api.cancel(o.coin, o.oid).then(refresh)}>Cancel</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// execution history including fees, so cost drag is visible
function Fills({ s }: { s: AppState }) {
  const rows = s.account?.fills ?? [];
  if (!rows.length) return <div className="empty">No fills yet</div>;
  return (
    <div className="scroll">
      <table>
        <thead><tr><th>Time</th><th>Coin</th><th>Dir</th><th>Price</th><th>Size</th><th>Fee</th><th>Closed PnL</th></tr></thead>
        <tbody>
          {rows.map((f, i) => (
            <tr key={`${f.time}-${i}`}>
              <td className="muted">{dateTime(f.time)}</td><td>{f.coin}</td>
              <td className={f.side === "long" ? "up" : "down"}>{f.dir}</td>
              <td>{px(f.px)}</td><td>{f.size}</td><td className="muted">{usd(f.fee, 4)}</td>
              <td className={tone(f.closedPnl)}>{f.closedPnl ? usd(f.closedPnl, 4) : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// round-trip journal with r-multiples, the honest scorecard for the bot
function Trades({ s }: { s: AppState }) {
  const t = s.trades;
  if (!t.length) return <div className="empty">{s.mode === "live" ? "Live realised PnL is in Fills" : "No closed trades yet"}</div>;
  const wins = t.filter((x) => x.pnl > 0).length;
  const net = t.reduce((a, x) => a + x.pnl, 0);
  const fees = t.reduce((a, x) => a + x.fees, 0);
  return (
    <div className="scroll">
      <div className="metrics">
        <div><div className="muted">Trades</div><div className="num">{t.length}</div></div>
        <div><div className="muted">Win rate</div><div className="num">{((wins / t.length) * 100).toFixed(1)}%</div></div>
        <div><div className="muted">Net PnL</div><div className={`num ${tone(net)}`}>{usd(net, 3)}</div></div>
        <div><div className="muted">Fees paid</div><div className="num">{usd(fees, 3)}</div></div>
      </div>
      <table>
        <thead><tr><th>Closed</th><th>Coin</th><th>Side</th><th>Entry</th><th>Exit</th><th>PnL</th><th>R</th><th>Exit reason</th></tr></thead>
        <tbody>
          {t.map((x) => (
            <tr key={x.id} title={x.entryReason}>
              <td className="muted">{dateTime(x.closedAt)}</td><td>{x.coin}</td>
              <td className={x.side === "long" ? "up" : "down"}>{x.side}</td>
              <td>{px(x.entryPx)}</td><td>{px(x.exitPx)}</td>
              <td className={tone(x.pnl)}>{usd(x.pnl, 4)}</td>
              <td className={tone(x.rMultiple)}>{x.rMultiple.toFixed(2)}</td>
              <td className="muted">{x.exitReason}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// bot decision journal
function Log({ s }: { s: AppState }) {
  return (
    <div className="scroll log">
      {s.logs.map((l, i) => (
        <div key={i} className={l.level}><span className="muted">{time(l.t)}</span> {l.msg}</div>
      ))}
    </div>
  );
}

// runs the exact live strategy over recent exchange history with fees and slippage
function Backtest({ defaultCoin, s }: { defaultCoin: string; s: AppState }) {
  const [coin, setCoin] = useState(defaultCoin);
  const [interval, setIntervalV] = useState(s.config.interval);
  const [days, setDays] = useState(14);
  const [equity, setEquity] = useState(10);
  const [res, setRes] = useState<BacktestResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const run = async () => {
    setBusy(true); setErr(null);
    try { setRes(await api.backtest(coin.toUpperCase(), interval, days, equity)); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <div className="split">
      <div>
        <div className="form" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <label className="f">Coin<input value={coin} onChange={(e) => setCoin(e.target.value)} /></label>
          <label className="f">Interval
            <select value={interval} onChange={(e) => setIntervalV(e.target.value)}>
              {["1m", "5m", "15m"].map((i) => <option key={i}>{i}</option>)}
            </select>
          </label>
          <label className="f">Days<input type="number" value={days} onChange={(e) => setDays(Number(e.target.value))} /></label>
          <label className="f">Start equity<input type="number" value={equity} onChange={(e) => setEquity(Number(e.target.value))} /></label>
          <button className="btn amber" style={{ gridColumn: "1 / -1" }} disabled={busy} onClick={run}>{busy ? "Running…" : "Run backtest"}</button>
          {err && <div className="msg err" style={{ gridColumn: "1 / -1" }}>{err}</div>}
          <div className="muted" style={{ gridColumn: "1 / -1", fontSize: 10.5 }}>
            Uses current risk/strategy settings, taker fees and slippage. Hyperliquid serves at most ~5000 bars per interval,
            so 5m covers ~17 days. Past results do not predict future returns.
          </div>
        </div>
        {res && (
          <div className="metrics" style={{ gridTemplateColumns: "1fr 1fr" }}>
            <div><div className="muted">Return</div><div className={`num ${tone(res.returnPct)}`}>{pct(res.returnPct)} ({usd(res.endEquity)})</div></div>
            <div><div className="muted">Trades</div><div className="num">{res.trades.length}</div></div>
            <div><div className="muted">Win rate</div><div className="num">{(res.winRate * 100).toFixed(1)}%</div></div>
            <div><div className="muted">Profit factor</div><div className="num">{Number.isFinite(res.profitFactor) ? res.profitFactor.toFixed(2) : "∞"}</div></div>
            <div><div className="muted">Max drawdown</div><div className="num down">{res.maxDrawdownPct.toFixed(2)}%</div></div>
            <div><div className="muted">Avg R</div><div className={`num ${tone(res.avgR)}`}>{res.avgR.toFixed(2)}</div></div>
          </div>
        )}
      </div>
      <div>
        {res ? <LineChart data={res.equityCurve.map((p) => ({ t: p.t, v: p.equity }))} color="#4c8dff" />
          : <div className="empty">Run a backtest to see the equity curve</div>}
      </div>
    </div>
  );
}
