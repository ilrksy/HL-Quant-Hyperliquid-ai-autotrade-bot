import { useEffect, useState } from "react";
import { api } from "../api";
import { px, usd } from "../fmt";
import type { MarketRow } from "../hl";
import { refreshNow } from "../live";
import { Seg, toast } from "../ui";

// manual trade entry mirroring hyperliquid's ticket: market/limit, leverage, optional tp/sl
export function OrderTicket({ market, available, limitHint, live }: { market?: MarketRow; available: number; limitHint: number | null; live: boolean }) {
  const [side, setSide] = useState<"long" | "short">("long");
  const [type, setType] = useState<"market" | "limit">("market");
  const [sizeUsd, setSizeUsd] = useState("12");
  const [lev, setLev] = useState(3);
  const [limitPx, setLimitPx] = useState("");
  const [tp, setTp] = useState("");
  const [sl, setSl] = useState("");
  const [reduceOnly, setReduceOnly] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (limitHint) { setType("limit"); setLimitPx(String(limitHint)); } }, [limitHint]);
  useEffect(() => { setLimitPx(""); setTp(""); setSl(""); }, [market?.name]);
  useEffect(() => { if (market && lev > market.maxLeverage) setLev(market.maxLeverage); }, [market, lev]);

  if (!market) return <div className="empty">Select a market</div>;
  const price = type === "limit" && Number(limitPx) > 0 ? Number(limitPx) : market.mark;
  const notional = Number(sizeUsd) || 0;
  const margin = notional / lev;
  const fee = notional * (type === "market" ? 0.00045 : 0.00015);
  const dir = side === "long" ? 1 : -1;
  const liq = price * (1 - dir * (1 / lev - 1 / (2 * market.maxLeverage)));
  const slLoss = Number(sl) > 0 ? (Math.abs(price - Number(sl)) / price) * notional + fee * 2 : null;
  const tpGain = Number(tp) > 0 ? (Math.abs(Number(tp) - price) / price) * notional - fee * 2 : null;
  const badSl = Number(sl) > 0 && (Number(sl) - price) * dir >= 0;
  const badTp = Number(tp) > 0 && (Number(tp) - price) * dir <= 0;

  const submit = async () => {
    if (live && !confirm(`Send a REAL ${side} order for ${usd(notional)} of ${market.name}?`)) return;
    setBusy(true);
    try {
      const r = await api.order({
        coin: market.name, side, sizeUsd: notional, leverage: lev, reduceOnly,
        limitPx: type === "limit" ? Number(limitPx) : undefined, takePx: Number(tp) || undefined, stopPx: Number(sl) || undefined,
      });
      toast(`${market.name} ${side} ${r.status}${r.avgPx ? ` @ ${px(r.avgPx)}` : ""}`);
      refreshNow();
    } catch (e) {
      toast((e as Error).message, false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ticket">
      <Seg full value={side} onChange={setSide} options={[["long", <span key="l" className={side === "long" ? "up" : ""}>Buy / Long</span>], ["short", <span key="s" className={side === "short" ? "down" : ""}>Sell / Short</span>]]} />
      <div className="row">
        <Seg value={type} onChange={setType} options={[["market", "Market"], ["limit", "Limit"]]} />
        <span className="right small muted">Avail <span className="mono" style={{ color: "var(--text)" }}>{usd(available)}</span></span>
      </div>
      {type === "limit" && (
        <label className="field"><span>Limit price</span><input className="input" inputMode="decimal" value={limitPx} onChange={(e) => setLimitPx(e.target.value)} placeholder={px(market.mark)} /></label>
      )}
      <label className="field"><span>Size (USD notional · Hyperliquid minimum $10)</span><input className="input" inputMode="decimal" value={sizeUsd} onChange={(e) => setSizeUsd(e.target.value)} /></label>
      <label className="field">
        <span>Leverage <span className="mono" style={{ color: "var(--accent)" }}>{lev}x</span> <span className="dim">/ max {market.maxLeverage}x</span></span>
        <input type="range" min={1} max={market.maxLeverage} value={lev} onChange={(e) => setLev(Number(e.target.value))} style={{ accentColor: "var(--accent)" }} />
      </label>
      <div className="row">
        <label className="field grow"><span>Take profit</span><input className="input" inputMode="decimal" value={tp} onChange={(e) => setTp(e.target.value)} placeholder="price" style={badTp ? { borderColor: "var(--down)" } : undefined} /></label>
        <label className="field grow"><span>Stop loss</span><input className="input" inputMode="decimal" value={sl} onChange={(e) => setSl(e.target.value)} placeholder="price" style={badSl ? { borderColor: "var(--down)" } : undefined} /></label>
      </div>
      <label className="row small muted" style={{ cursor: "pointer" }}>
        <input type="checkbox" checked={reduceOnly} onChange={(e) => setReduceOnly(e.target.checked)} /> Reduce only
      </label>
      <div>
        <div className="kv"><span>Order size</span><span>{(notional / price).toPrecision(5)} {market.name}</span></div>
        <div className="kv"><span>Margin required</span><span>{usd(margin)}</span></div>
        <div className="kv"><span>Est. fee ({type === "market" ? "taker" : "maker"})</span><span>{usd(fee, 4)}</span></div>
        <div className="kv"><span>Est. liquidation</span><span>{px(liq)}</span></div>
        {slLoss !== null && <div className="kv"><span>Loss at stop</span><span className="down">{usd(-slLoss, 3)}</span></div>}
        {tpGain !== null && <div className="kv"><span>Gain at target</span><span className="up">{usd(tpGain, 3)}</span></div>}
      </div>
      <button className={`btn block ${side}`} style={{ height: 36 }} disabled={busy || notional < 10 || margin > available * 1.0001 || badSl || badTp || (type === "limit" && !(Number(limitPx) > 0))} onClick={submit}>
        {busy ? "Sending…" : `${side === "long" ? "Buy / Long" : "Sell / Short"} ${market.name}`}
      </button>
      {margin > available && <div className="msg err">Margin {usd(margin)} exceeds available {usd(available)}</div>}
      {(badSl || badTp) && <div className="msg err">{badSl ? "Stop loss is on the wrong side of the entry. " : ""}{badTp ? "Take profit is on the wrong side of the entry." : ""}</div>}
    </div>
  );
}
