import { useEffect, useState } from "react";
import { api } from "../api";
import { px, usd } from "../fmt";
import type { MarketRow } from "../hl";

// manual trade entry mirroring hyperliquid's ticket: market/limit, leverage, optional tp/sl
export function OrderTicket({ market, available, limitHint, onDone }: {
  market?: MarketRow; available: number; limitHint: number | null; onDone: () => void;
}) {
  const [side, setSide] = useState<"long" | "short">("long");
  const [type, setType] = useState<"market" | "limit">("market");
  const [sizeUsd, setSizeUsd] = useState("12");
  const [lev, setLev] = useState(3);
  const [limitPx, setLimitPx] = useState("");
  const [tp, setTp] = useState("");
  const [sl, setSl] = useState("");
  const [reduceOnly, setReduceOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => { if (limitHint) { setType("limit"); setLimitPx(String(limitHint)); } }, [limitHint]);
  useEffect(() => { setLimitPx(""); setTp(""); setSl(""); setMsg(null); }, [market?.name]);

  if (!market) return null;
  const maxLev = market.maxLeverage;
  const price = type === "limit" && Number(limitPx) > 0 ? Number(limitPx) : market.mark;
  const notional = Number(sizeUsd) || 0;
  const margin = notional / lev;
  const fee = notional * (type === "market" ? 0.00045 : 0.00015);
  const dir = side === "long" ? 1 : -1;
  const liq = price * (1 - dir / (lev * 2));
  const slLoss = Number(sl) > 0 ? (Math.abs(price - Number(sl)) / price) * notional + fee * 2 : null;

  const submit = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.order({
        coin: market.name, side, sizeUsd: notional, leverage: lev, reduceOnly,
        limitPx: type === "limit" ? Number(limitPx) : undefined,
        takePx: Number(tp) || undefined, stopPx: Number(sl) || undefined,
      });
      setMsg({ ok: true, text: `Order ${r.status}` });
      onDone();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="form">
      <div className="seg" style={{ display: "grid", gridTemplateColumns: "1fr 1fr" }}>
        <button className={side === "long" ? "on" : ""} style={{ color: side === "long" ? "var(--up)" : undefined }} onClick={() => setSide("long")}>Long</button>
        <button className={side === "short" ? "on" : ""} style={{ color: side === "short" ? "var(--down)" : undefined }} onClick={() => setSide("short")}>Short</button>
      </div>
      <div className="row">
        <div className="seg">
          {(["market", "limit"] as const).map((t) => (
            <button key={t} className={type === t ? "on" : ""} onClick={() => setType(t)}>{t}</button>
          ))}
        </div>
        <span className="muted" style={{ textAlign: "right" }}>Avail <span className="mono">{usd(available)}</span></span>
      </div>
      {type === "limit" && (
        <label className="f">Limit price<input value={limitPx} onChange={(e) => setLimitPx(e.target.value)} placeholder={px(market.mark)} /></label>
      )}
      <label className="f">Size (USD notional, min $10)<input value={sizeUsd} onChange={(e) => setSizeUsd(e.target.value)} /></label>
      <label className="f">
        Leverage <span className="mono" style={{ color: "var(--text)" }}>{lev}x</span>
        <input type="range" min={1} max={maxLev} value={lev} onChange={(e) => setLev(Number(e.target.value))} />
      </label>
      <div className="row">
        <label className="f">Take profit<input value={tp} onChange={(e) => setTp(e.target.value)} placeholder="price" /></label>
        <label className="f">Stop loss<input value={sl} onChange={(e) => setSl(e.target.value)} placeholder="price" /></label>
      </div>
      <label className="row muted" style={{ flex: "none" }}>
        <input type="checkbox" checked={reduceOnly} onChange={(e) => setReduceOnly(e.target.checked)} style={{ flex: "none" }} /> Reduce only
      </label>
      <div className="kv"><span>Size</span><b>{(notional / price).toPrecision(5)} {market.name}</b></div>
      <div className="kv"><span>Margin req.</span><b>{usd(margin)}</b></div>
      <div className="kv"><span>Est. fee</span><b>{usd(fee, 4)}</b></div>
      <div className="kv"><span>Est. liq. (approx)</span><b>{px(liq)}</b></div>
      {slLoss !== null && <div className="kv"><span>Loss at SL</span><b className="down">{usd(-slLoss, 3)}</b></div>}
      <button className={`btn ${side}`} disabled={busy || notional < 10 || margin > available * 1.0001} onClick={submit}>
        {busy ? "Sending…" : `${side === "long" ? "Buy / Long" : "Sell / Short"} ${market.name}`}
      </button>
      {margin > available && <div className="msg err">Margin {usd(margin)} exceeds available {usd(available)}</div>}
      {msg && <div className={`msg ${msg.ok ? "ok" : "err"}`}>{msg.text}</div>}
    </div>
  );
}
