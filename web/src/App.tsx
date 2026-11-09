import { useCallback, useEffect, useState } from "react";
import { api, type AppState } from "./api";
import { BotPanel } from "./components/BotPanel";
import { Bottom } from "./components/Bottom";
import { PriceChart, type TIMEFRAMES } from "./components/Chart";
import { MarketList } from "./components/MarketList";
import { OrderBook } from "./components/OrderBook";
import { OrderTicket } from "./components/OrderTicket";
import { compact, pct, px, tone, usd } from "./fmt";
import { loadMarkets, type MarketRow } from "./hl";

// root layout: polls the bot server for account state and hyperliquid for the market universe
export function App() {
  const [s, setS] = useState<AppState | null>(null);
  const [conn, setConn] = useState<"ok" | "err" | "init">("init");
  const [markets, setMarkets] = useState<MarketRow[]>([]);
  const [coin, setCoin] = useState(() => localStorage.getItem("coin") ?? "BTC");
  const [tf, setTf] = useState<(typeof TIMEFRAMES)[number]>("15m");
  const [sideTab, setSideTab] = useState<"trade" | "bot">("bot");
  const [limitHint, setLimitHint] = useState<number | null>(null);

  const refresh = useCallback(() => {
    api.state().then((x) => { setS(x); setConn("ok"); }).catch(() => setConn("err"));
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 2000);
    return () => clearInterval(id);
  }, [refresh]);

  const testnet = s?.testnet ?? false;
  useEffect(() => {
    const load = () => loadMarkets(testnet).then(setMarkets).catch(() => {});
    load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, [testnet]);

  useEffect(() => { localStorage.setItem("coin", coin); }, [coin]);

  const m = markets.find((x) => x.name === coin);
  const a = s?.account;
  const upnl = a?.positions.reduce((t, p) => t + p.unrealizedPnl, 0) ?? 0;
  const dayPnl = a && s?.bot.dayStartEquity ? a.equity - s.bot.dayStartEquity : 0;
  const dd = a && s?.bot.peakEquity ? ((s.bot.peakEquity - a.equity) / s.bot.peakEquity) * 100 : 0;

  return (
    <div className="app">
      <div className="panel topbar">
        <span className="brand">HL·QUANT</span>
        {s && <span className={`badge ${s.mode}`}>{s.mode.toUpperCase()}{s.testnet ? " · TESTNET" : ""}</span>}
        <div className="stat"><span className="k">Equity</span><span className="v">{usd(a?.equity)}</span></div>
        <div className="stat"><span className="k">Available</span><span className="v">{usd(a?.available)}</span></div>
        <div className="stat"><span className="k">Margin used</span><span className="v">{usd(a?.marginUsed)}</span></div>
        <div className="stat"><span className="k">Unrealised</span><span className={`v ${tone(upnl)}`}>{usd(upnl, 3)}</span></div>
        <div className="stat"><span className="k">Today</span><span className={`v ${tone(dayPnl)}`}>{usd(dayPnl, 3)}</span></div>
        <div className="stat"><span className="k">Drawdown</span><span className={`v ${dd > 0 ? "down" : ""}`}>{dd.toFixed(2)}%</span></div>
        <div className="stat"><span className="k">Bot</span>
          <span className="v">{s?.bot.running ? <span className="up">RUNNING</span> : s?.bot.halted ? <span className="down">HALTED</span> : <span className="muted">IDLE</span>}</span>
        </div>
        <span style={{ flex: 1 }} />
        {a?.address && <span className="muted mono">{a.address.slice(0, 6)}…{a.address.slice(-4)}</span>}
        <span className="muted"><span className={`dot ${conn === "ok" ? "on" : conn === "err" ? "err" : ""}`} />{conn === "err" ? "server offline" : "connected"}</span>
      </div>

      <MarketList markets={markets} selected={coin} onSelect={setCoin} botCoins={s?.config.coins ?? []} />

      <div className="panel chart">
        <div className="chart-head">
          <span className="sym">{coin}-PERP</span>
          <span className={`last ${tone(m?.change ?? 0)}`}>{px(m?.mark)}</span>
          <span className={tone(m?.change ?? 0)}>{pct(m?.change ?? 0)}</span>
          <span className="muted">Funding/h <span className={`mono ${tone(-(m?.funding ?? 0))}`}>{((m?.funding ?? 0) * 100).toFixed(4)}%</span></span>
          <span className="muted">OI <span className="mono">${compact(m?.openInterest ?? 0)}</span></span>
          <span className="muted">24h Vol <span className="mono">${compact(m?.volume ?? 0)}</span></span>
          <span className="muted">Max <span className="mono">{m?.maxLeverage ?? "—"}x</span></span>
        </div>
        <PriceChart coin={coin} testnet={testnet} tf={tf} onTf={setTf}
          position={a?.positions.find((p) => p.coin === coin)} fills={a?.fills ?? []} />
      </div>

      <OrderBook coin={coin} testnet={testnet} onPrice={(p) => { setLimitHint(p); setSideTab("trade"); }} />

      <div className="panel side">
        <div className="tabs">
          <button className={sideTab === "bot" ? "on" : ""} onClick={() => setSideTab("bot")}>AI Autotrade</button>
          <button className={sideTab === "trade" ? "on" : ""} onClick={() => setSideTab("trade")}>Manual trade</button>
        </div>
        <div className="scroll">
          {!s ? <div className="empty">connecting to bot server…</div>
            : sideTab === "bot" ? <BotPanel s={s} refresh={refresh} />
            : <OrderTicket market={m} available={a?.available ?? 0} limitHint={limitHint} onDone={refresh} />}
          <div className="form">
            <div className="warn-box">
              No trading system can guarantee profit. Perps with leverage can lose your entire deposit.
              Run paper mode and backtests first; only trade money you can afford to lose.
            </div>
          </div>
        </div>
      </div>

      {s ? <Bottom s={s} refresh={refresh} coin={coin} /> : <div className="panel bottom"><div className="empty">waiting for bot server on :8787 …</div></div>}
    </div>
  );
}
