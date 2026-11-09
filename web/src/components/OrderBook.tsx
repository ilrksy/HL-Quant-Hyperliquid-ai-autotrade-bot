import { useEffect, useState } from "react";
import { px, time } from "../fmt";
import { hl } from "../hl";

// one price level after parsing the websocket strings
interface Level { px: number; sz: number }
// one print on the trade tape
interface Print { px: number; sz: number; side: "B" | "A"; time: number; tid: number }

// levels shown per side, enough to read depth without scrolling
const DEPTH = 11;

// live l2 book with cumulative depth bars plus the public trade tape for the selected coin
export function OrderBook({ coin, testnet, onPrice }: { coin: string; testnet: boolean; onPrice: (p: number) => void }) {
  const [bids, setBids] = useState<Level[]>([]);
  const [asks, setAsks] = useState<Level[]>([]);
  const [tape, setTape] = useState<Print[]>([]);

  useEffect(() => {
    let cancelled = false;
    const subsList: { unsubscribe: () => Promise<void> }[] = [];
    const { subs } = hl(testnet);
    setBids([]);
    setAsks([]);
    setTape([]);
    (async () => {
      const book = await subs.l2Book({ coin }, (b) => {
        const parse = (l: { px: string; sz: string }[]) => l.slice(0, DEPTH).map((x) => ({ px: +x.px, sz: +x.sz }));
        setBids(parse(b.levels[0]));
        setAsks(parse(b.levels[1]));
      });
      const trades = await subs.trades({ coin }, (ts) => {
        setTape((prev) => [...ts.map((t) => ({ px: +t.px, sz: +t.sz, side: t.side, time: t.time, tid: t.tid })).reverse(), ...prev].slice(0, 60));
      });
      subsList.push(book, trades);
      if (cancelled) subsList.forEach((s) => void s.unsubscribe());
    })().catch((e) => console.error("book", e));
    return () => { cancelled = true; subsList.forEach((s) => void s.unsubscribe()); };
  }, [coin, testnet]);

  const cum = (lv: Level[]) => { let acc = 0; return lv.map((l) => (acc += l.sz)); };
  const bidCum = cum(bids);
  const askCum = cum(asks);
  const max = Math.max(bidCum[bidCum.length - 1] ?? 0, askCum[askCum.length - 1] ?? 0) || 1;
  const spread = asks[0] && bids[0] ? asks[0].px - bids[0].px : 0;
  const mid = asks[0] && bids[0] ? (asks[0].px + bids[0].px) / 2 : 0;

  return (
    <>
      <div className="col" style={{ gap: 0, minHeight: 0 }}>
        <div className="panel-h"><span className="t">Order book</span><span className="right dim tiny">click a price to set limit</span></div>
        <div className="lvl muted" style={{ fontSize: 10.5, cursor: "default" }}><span>Price</span><span>Size</span><span>Total</span></div>
        {asks.map((l, i) => ({ l, c: askCum[i] })).reverse().map(({ l, c }) => (
          <div key={`a${l.px}`} className="lvl ask" onClick={() => onPrice(l.px)}>
            <div className="depth" style={{ width: `${(c / max) * 100}%` }} />
            <span className="down">{px(l.px)}</span><span>{l.sz}</span><span className="muted">{c.toFixed(2)}</span>
          </div>
        ))}
        <div className="spread"><span className="accent">{px(mid)}</span><span>spread {px(spread)} · {mid ? ((spread / mid) * 1e4).toFixed(1) : "—"} bp</span></div>
        {bids.map((l, i) => (
          <div key={`b${l.px}`} className="lvl bid" onClick={() => onPrice(l.px)}>
            <div className="depth" style={{ width: `${(bidCum[i] / max) * 100}%` }} />
            <span className="up">{px(l.px)}</span><span>{l.sz}</span><span className="muted">{bidCum[i].toFixed(2)}</span>
          </div>
        ))}
      </div>
      <div className="col" style={{ gap: 0, minHeight: 0, borderLeft: "1px solid var(--line)" }}>
        <div className="panel-h"><span className="t">Trades</span></div>
        <div className="scroll tape" style={{ flex: 1 }}>
          {tape.map((t) => (
            <div key={t.tid}><span className={t.side === "B" ? "up" : "down"}>{px(t.px)}</span><span>{t.sz}</span><span className="muted">{time(t.time)}</span></div>
          ))}
          {!tape.length && <div className="empty" style={{ display: "block" }}>waiting for prints…</div>}
        </div>
      </div>
    </>
  );
}
