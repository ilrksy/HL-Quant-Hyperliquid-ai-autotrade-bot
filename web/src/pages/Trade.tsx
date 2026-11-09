import { useEffect, useState } from "react";
import { api, type AppState, type BacktestResponse } from "../api";
import { LineChart, PriceChart, type Tf } from "../components/Chart";
import { MarketList } from "../components/MarketList";
import { OrderBook } from "../components/OrderBook";
import { OrderTicket } from "../components/OrderTicket";
import { compact, dateTime, pct, px, susd, tone, usd } from "../fmt";
import { loadMarkets, type MarketRow } from "../hl";
import { refreshNow } from "../live";
import { Field, Icon, Modal, Seg, Stat, Tabs, toast, useAction } from "../ui";

// market universe refreshed every few seconds straight from hyperliquid
function useMarkets(testnet: boolean): MarketRow[] {
  const [m, setM] = useState<MarketRow[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () => loadMarkets(testnet).then((x) => alive && setM(x)).catch(() => undefined);
    load();
    const id = setInterval(load, 5000);
    return () => { alive = false; clearInterval(id); };
  }, [testnet]);
  return m;
}

// exchange-style terminal: markets, chart, book, ticket and account drawer
export function Trade({ s }: { s: AppState }) {
  const markets = useMarkets(s.testnet);
  const [coin, setCoin] = useState(() => localStorage.getItem("hlq.coin") ?? "BTC");
  const [tf, setTf] = useState<Tf>(() => (localStorage.getItem("hlq.tf") as Tf) ?? "15m");
  const [limitHint, setLimitHint] = useState<number | null>(null);
  const [picker, setPicker] = useState(false);
  useEffect(() => { localStorage.setItem("hlq.coin", coin); }, [coin]);
  useEffect(() => { localStorage.setItem("hlq.tf", tf); }, [tf]);
  const m = markets.find((x) => x.name === coin);
  const a = s.account;
  const pos = a?.positions.find((p) => p.coin === coin);

  return (
    <div className="trade">
      <div className="t-mkt"><MarketList markets={markets} selected={coin} onSelect={setCoin} botCoins={s.universe} /></div>
      <div className="t-chart">
        <div className="chart-head">
          <button className="coin-btn sym" onClick={() => setPicker(true)} title="Change market">{coin}-USD <Icon name="down" size={12} /></button>
          <span className={`last ${tone(m?.change ?? 0)}`}>{px(m?.mark)}</span>
          <div className="hstat"><span className="k">24h change</span><span className={`v ${tone(m?.change ?? 0)}`}>{pct(m?.change ?? 0)}</span></div>
          <div className="hstat"><span className="k">Funding / 1h</span><span className={`v ${tone(-(m?.funding ?? 0))}`}>{((m?.funding ?? 0) * 100).toFixed(4)}%</span></div>
          <div className="hstat"><span className="k">Open interest</span><span className="v">${compact(m?.openInterest ?? 0)}</span></div>
          <div className="hstat"><span className="k">24h volume</span><span className="v">${compact(m?.volume ?? 0)}</span></div>
          <div className="hstat"><span className="k">Max leverage</span><span className="v">{m?.maxLeverage ?? "—"}x</span></div>
          {s.signals[coin] && (
            <div className="hstat"><span className="k">Bot signal</span>
              <span className={`v ${s.signals[coin].action === "long" ? "up" : s.signals[coin].action === "short" ? "down" : "muted"}`}>{s.signals[coin].action} {s.signals[coin].score.toFixed(2)}</span>
            </div>
          )}
        </div>
        <PriceChart coin={coin} testnet={s.testnet} tf={tf} onTf={setTf} position={pos} fills={a?.fills ?? []} />
      </div>
      <div className="t-book"><OrderBook coin={coin} testnet={s.testnet} onPrice={setLimitHint} /></div>
      <div className="t-ticket">
        <div className="panel-h"><span className="t hl">Manual order</span>{s.mode === "live" && <span className="badge bad right">real funds</span>}</div>
        <OrderTicket market={m} available={a?.available ?? 0} limitHint={limitHint} live={s.mode === "live"} />
      </div>
      <div className="t-bottom"><Drawer s={s} coin={coin} /></div>
      {picker && (
        <Modal title="Select market" onClose={() => setPicker(false)}>
          <div style={{ height: "60dvh", display: "flex", flexDirection: "column", margin: "-12px" }}>
            <MarketList autoFocus markets={markets} selected={coin} onSelect={(c) => { setCoin(c); setPicker(false); }} botCoins={s.universe} />
          </div>
        </Modal>
      )}
    </div>
  );
}

// positions, orders, fills and backtest tabs under the chart
function Drawer({ s, coin }: { s: AppState; coin: string }) {
  const [tab, setTab] = useState<"pos" | "ord" | "fill" | "bt">("pos");
  const a = s.account;
  const { busy, run } = useAction();
  return (
    <>
      <Tabs value={tab} onChange={setTab} tabs={[["pos", "Positions", a?.positions.length], ["ord", "Open orders", a?.orders.length], ["fill", "Fills"], ["bt", "Backtest"]]} />
      <div className="scroll" style={{ flex: 1 }}>
        {tab === "pos" && (!a?.positions.length ? <div className="empty">No open positions</div> : (
          <table>
            <thead><tr><th>Market</th><th>Size</th><th>Value</th><th>Entry</th><th>Mark</th><th>PnL (ROE)</th><th>Liq.</th><th>TP / SL</th><th>Owner</th><th /></tr></thead>
            <tbody>
              {a.positions.map((p) => {
                const margin = (p.entryPx * p.size) / p.leverage;
                return (
                  <tr key={p.coin}>
                    <td><span className={p.side === "long" ? "up" : "down"} style={{ fontFamily: "var(--sans)", fontWeight: 600 }}>{p.coin}</span> <span className="dim">{p.leverage}x {p.side}</span></td>
                    <td>{p.size}</td><td>{usd(p.markPx * p.size)}</td><td>{px(p.entryPx)}</td><td>{px(p.markPx)}</td>
                    <td className={tone(p.unrealizedPnl)}>{susd(p.unrealizedPnl, 3)} ({pct((p.unrealizedPnl / margin) * 100, 1)})</td>
                    <td className="muted">{px(p.liquidationPx)}</td>
                    <td><span className="up">{px(p.takePx)}</span> / <span className="down">{px(p.stopPx)}</span></td>
                    <td>{s.bot.managed[p.coin] ? <span className="badge acc">bot</span> : <span className="badge mut">manual</span>}</td>
                    <td><button className="btn sm" disabled={busy === p.coin} onClick={() => (s.mode !== "live" || confirm(`Close ${p.coin} at market?`)) && run(p.coin, () => api.close(p.coin), `${p.coin} closed`).then(refreshNow)}>Market close</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ))}
        {tab === "ord" && (!a?.orders.length ? <div className="empty">No open orders</div> : (
          <table>
            <thead><tr><th>Time</th><th>Market</th><th>Type</th><th>Side</th><th>Price</th><th>Size</th><th>Reduce only</th><th /></tr></thead>
            <tbody>
              {a.orders.map((o) => (
                <tr key={o.oid}>
                  <td className="muted">{dateTime(o.time)}</td><td>{o.coin}</td><td>{o.type}</td>
                  <td className={o.side === "long" ? "up" : "down"}>{o.side === "long" ? "buy" : "sell"}</td><td>{px(o.px)}</td><td>{o.size}</td>
                  <td className="muted">{o.reduceOnly ? "yes" : ""}</td>
                  <td><button className="btn sm" onClick={() => run(String(o.oid), () => api.cancel(o.coin, o.oid), "Order cancelled").then(refreshNow)}>Cancel</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}
        {tab === "fill" && (!a?.fills.length ? <div className="empty">No fills yet</div> : (
          <table>
            <thead><tr><th>Time</th><th>Market</th><th>Direction</th><th>Price</th><th>Size</th><th>Fee</th><th>Closed PnL</th></tr></thead>
            <tbody>
              {a.fills.map((f, i) => (
                <tr key={`${f.time}-${i}`}>
                  <td className="muted">{dateTime(f.time)}</td><td>{f.coin}</td><td className={f.side === "long" ? "up" : "down"}>{f.dir}</td>
                  <td>{px(f.px)}</td><td>{f.size}</td><td className="muted">{usd(f.fee, 4)}</td><td className={tone(f.closedPnl)}>{f.closedPnl ? susd(f.closedPnl, 4) : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}
        {tab === "bt" && <Backtest coin={coin} interval={s.mode ? "15m" : "15m"} />}
      </div>
    </>
  );
}

// runs the live strategy and risk settings over recent exchange history with fees and slippage
function Backtest({ coin: initial, interval: iv }: { coin: string; interval: string }) {
  const [coin, setCoin] = useState(initial);
  const [interval, setIntervalV] = useState(iv);
  const [days, setDays] = useState(14);
  const [equity, setEquity] = useState(10);
  const [res, setRes] = useState<BacktestResponse | null>(null);
  const { busy, run } = useAction();
  useEffect(() => setCoin(initial), [initial]);
  return (
    <div className="pad col gap-12">
      <div className="row wrap" style={{ alignItems: "flex-end" }}>
        <Field label="Market"><input className="input" style={{ width: 110 }} value={coin} onChange={(e) => setCoin(e.target.value)} /></Field>
        <Field label="Interval"><Seg value={interval} onChange={setIntervalV} options={["1m", "5m", "15m"]} /></Field>
        <Field label="Days"><input className="input" style={{ width: 80 }} type="number" value={days} onChange={(e) => setDays(Number(e.target.value))} /></Field>
        <Field label="Start equity"><input className="input" style={{ width: 90 }} type="number" value={equity} onChange={(e) => setEquity(Number(e.target.value))} /></Field>
        <button className="btn primary" disabled={!!busy} onClick={() => run("bt", () => api.backtest(coin, interval, days, equity)).then((r) => r && setRes(r))}>{busy ? "Running…" : "Run backtest"}</button>
        <span className="dim tiny grow" style={{ minWidth: 220 }}>Quant layer only (AI is not replayed). Uses your risk settings, taker fees and slippage; Hyperliquid keeps ~5000 bars per interval. Past results do not predict future returns.</span>
      </div>
      {res && (
        <>
          <div className="stats">
            <Stat k="Return" v={pct(res.returnPct)} tone={tone(res.returnPct)} s={`${usd(res.startEquity)} → ${usd(res.endEquity)}`} />
            <Stat k="Trades" v={res.trades.length} s={`${res.bars} bars`} />
            <Stat k="Win rate" v={`${(res.winRate * 100).toFixed(1)}%`} />
            <Stat k="Profit factor" v={Number.isFinite(res.profitFactor) ? res.profitFactor.toFixed(2) : "∞"} />
            <Stat k="Avg R" v={res.avgR.toFixed(2)} tone={tone(res.avgR)} />
            <Stat k="Max drawdown" v={`${res.maxDrawdownPct.toFixed(2)}%`} tone="down" />
          </div>
          <LineChart data={res.equityCurve.map((p) => ({ t: p.t, v: p.equity }))} color="#6aa6f8" height={220} />
          {res.trades.length === 0 && (() => { toast("No trades: filters rejected every setup in this window"); return null; })()}
        </>
      )}
    </div>
  );
}
