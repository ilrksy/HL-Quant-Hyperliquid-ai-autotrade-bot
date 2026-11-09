import { useEffect, useState } from "react";
import { type Conn, initialConn, setConn } from "./api";
import { pct, susd, tone, usd } from "./fmt";
import { type LinkStatus, startLive, stopLive, useLive } from "./live";
import { Company } from "./pages/Company";
import { Connect } from "./pages/Connect";
import { History } from "./pages/History";
import { Portfolio } from "./pages/Portfolio";
import { Providers } from "./pages/Providers";
import { Settings } from "./pages/Settings";
import { Trade } from "./pages/Trade";
import { Icon, Logo, Toasts } from "./ui";

// navigation entries in display order
const NAV = [
  { id: "company", label: "Command", icon: "company" },
  { id: "trade", label: "Trade", icon: "trade" },
  { id: "ai", label: "AI", icon: "ai" },
  { id: "history", label: "History", icon: "history" },
  { id: "portfolio", label: "Portfolio", icon: "portfolio" },
  { id: "settings", label: "Settings", icon: "settings" },
] as const;
// one page id
type PageId = (typeof NAV)[number]["id"];

// current page from the location hash, defaulting to the command center
function readHash(): PageId {
  const id = location.hash.replace(/^#\/?/, "").split(/[?/]/)[0];
  return (NAV.find((n) => n.id === id)?.id ?? "company") as PageId;
}

// hash router so every page is linkable and works from file:// in the desktop app
function useRoute(): PageId {
  const [page, setPage] = useState<PageId>(readHash);
  useEffect(() => {
    const on = () => setPage(readHash());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return page;
}

// connection gate: shows the connect screen until a server and token are verified
export function App() {
  const [conn, setC] = useState<Conn | null>(() => {
    const c = initialConn();
    if (c) setConn(c);
    return c;
  });
  useEffect(() => {
    if (!conn) return;
    startLive();
    return () => stopLive();
  }, [conn]);
  const connect = (c: Conn) => { setConn(c); setC(c); };
  const disconnect = () => { setConn(null); setC(null); };
  return (
    <>
      {conn ? <Shell conn={conn} onDisconnect={disconnect} /> : <Connect onConnected={connect} />}
      <Toasts />
    </>
  );
}

// link status label and colour for the top bar
const LINK: Record<LinkStatus, [string, string]> = {
  connecting: ["connecting", "warn"], live: ["live", "ok"], polling: ["polling", "warn"], offline: ["offline", "error"], unauthorized: ["token rejected", "error"],
};

// app frame: top bar with account vitals, side or bottom navigation, and the active page
function Shell({ conn, onDisconnect }: { conn: Conn; onDisconnect: () => void }) {
  const page = useRoute();
  const { state: s, status } = useLive();
  const a = s?.account;
  const upnl = a?.positions.reduce((t, p) => t + p.unrealizedPnl, 0) ?? 0;
  const day = a && s?.bot.dayStartEquity ? a.equity - s.bot.dayStartEquity : 0;
  const dd = a && s?.bot.peakEquity ? ((s.bot.peakEquity - a.equity) / s.bot.peakEquity) * 100 : 0;
  const aiUp = s?.ai.providers.filter((p) => p.health === "healthy" || p.health === "degraded").length ?? 0;
  const [label, cls] = LINK[status];
  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand"><Logo /> HL&nbsp;QUANT</div>
        {s && <span className={`badge ${s.mode === "live" ? "bad" : "info"}`}>{s.mode}{s.testnet ? " · testnet" : ""}</span>}
        <div className="tstat"><span className="k">Equity</span><span className="v">{usd(a?.equity)}</span></div>
        <div className="tstat hide-m"><span className="k">Available</span><span className="v">{usd(a?.available)}</span></div>
        <div className="tstat"><span className="k">Unrealized</span><span className={`v ${tone(upnl)}`}>{susd(upnl, 3)}</span></div>
        <div className="tstat"><span className="k">Today</span><span className={`v ${tone(day)}`}>{susd(day, 3)}</span></div>
        <div className="tstat hide-m"><span className="k">Drawdown</span><span className={`v ${dd > 0.01 ? "down" : ""}`}>{pct(-dd)}</span></div>
        <div className="tstat"><span className="k">Autotrade</span>
          <span className="v">{s?.bot.armed ? <span className="up">ARMED</span> : s?.bot.halted ? <span className="down">HALTED</span> : <span className="muted">OFF</span>}</span>
        </div>
        <div className="tstat hide-m"><span className="k">AI</span><span className="v">{s ? (s.ai.mode === "off" ? <span className="muted">off</span> : `${aiUp}/${s.ai.providers.length} up`) : "—"}</span></div>
        <span className="grow" />
        <span className="row small nowrap hide-m" title={conn.url}><span className={`dot ${cls}`} />{label}</span>
        <button className="btn ghost icon-btn" title={`Disconnect from ${conn.url}`} onClick={() => confirm("Disconnect from this server?") && onDisconnect()}><Icon name="logout" /></button>
      </header>
      <nav className="nav" aria-label="Main">
        {NAV.map((n) => (
          <a key={n.id} href={`#/${n.id}`} className={page === n.id ? "on" : ""}><Icon name={n.icon} size={18} />{n.label}</a>
        ))}
      </nav>
      <main className="main">
        {status === "unauthorized" && (
          <div className="page" style={{ minHeight: 0, paddingBottom: 0 }}>
            <div className="msg err row">The server rejected the saved API token. <button className="btn sm right" onClick={onDisconnect}>Reconnect</button></div>
          </div>
        )}
        {!s ? <div className="empty" style={{ paddingTop: 80 }}>{status === "offline" ? `Cannot reach ${conn.url}. Retrying…` : "Loading…"}</div>
          : page === "trade" ? <Trade s={s} />
          : page === "ai" ? <Providers s={s} />
          : page === "history" ? <History />
          : page === "portfolio" ? <Portfolio s={s} />
          : page === "settings" ? <Settings s={s} conn={conn} onDisconnect={onDisconnect} />
          : <Company s={s} />}
      </main>
    </div>
  );
}
