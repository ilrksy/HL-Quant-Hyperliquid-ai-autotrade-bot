import {
  CandlestickSeries, ColorType, CrosshairMode, HistogramSeries, LineSeries, createChart, createSeriesMarkers,
  type IChartApi, type IPriceLine, type ISeriesApi, type ISeriesMarkersPluginApi, type SeriesMarker, type Time, type UTCTimestamp,
} from "lightweight-charts";
import { useEffect, useRef, useState } from "react";
import { ema } from "../../../core/indicators";
import type { FillView, PositionView } from "../../../server/broker";
import { px } from "../fmt";
import { hl } from "../hl";

// timeframes offered on the chart, wider than the bot's so context is visible
export const TIMEFRAMES = ["1m", "5m", "15m", "1h", "4h", "1d"] as const;
// one of the chart timeframes
type Tf = (typeof TIMEFRAMES)[number];
// bar length per timeframe, used to snap fill markers onto bars
const TF_MS: Record<Tf, number> = { "1m": 60e3, "5m": 300e3, "15m": 900e3, "1h": 3600e3, "4h": 14400e3, "1d": 86400e3 };

// minimal bar shape kept in a ref so websocket updates avoid react re-renders
interface Bar { time: UTCTimestamp; open: number; high: number; low: number; close: number; volume: number }

// shared visual theme so both price and equity charts look like one product
export const chartTheme = {
  layout: { background: { type: ColorType.Solid, color: "#0f1215" }, textColor: "#69737d", fontSize: 11,
    fontFamily: "JetBrains Mono, Menlo, monospace", attributionLogo: false },
  grid: { vertLines: { color: "#161a1f" }, horzLines: { color: "#161a1f" } },
  rightPriceScale: { borderColor: "#1f252b" },
  timeScale: { borderColor: "#1f252b", timeVisible: true, secondsVisible: false },
};

// candlestick chart with emas, volume, live updates, fill markers and position levels
export function PriceChart({ coin, testnet, position, fills, tf, onTf }: {
  coin: string; testnet: boolean; position?: PositionView; fills: FillView[]; tf: Tf; onTf: (t: Tf) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<{
    candles: ISeriesApi<"Candlestick">; vol: ISeriesApi<"Histogram">; e9: ISeriesApi<"Line">; e21: ISeriesApi<"Line">;
    e100: ISeriesApi<"Line">; markers: ISeriesMarkersPluginApi<Time>;
  } | null>(null);
  const bars = useRef<Bar[]>([]);
  const lines = useRef<IPriceLine[]>([]);
  const [legend, setLegend] = useState<Bar | null>(null);

  useEffect(() => {
    if (!box.current) return;
    const c = createChart(box.current, { ...chartTheme, autoSize: true, crosshair: { mode: CrosshairMode.Normal } });
    const candles = c.addSeries(CandlestickSeries, {
      upColor: "#26b07a", downColor: "#e5484d", borderVisible: false, wickUpColor: "#26b07a", wickDownColor: "#e5484d",
    });
    const vol = c.addSeries(HistogramSeries, { priceScaleId: "vol", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
    c.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    const line = (color: string) => c.addSeries(LineSeries, { color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
    series.current = { candles, vol, e9: line("#ff9f1a"), e21: line("#4c8dff"), e100: line("#8b5cf6"), markers: createSeriesMarkers(candles, []) };
    c.subscribeCrosshairMove((p) => {
      const d = p.time ? bars.current.find((b) => b.time === p.time) : null;
      setLegend(d ?? null);
    });
    chart.current = c;
    return () => { c.remove(); chart.current = null; series.current = null; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let unsub: (() => Promise<void>) | null = null;
    const ms = TF_MS[tf];
    const { info, subs } = hl(testnet);

    const paint = () => {
      const s = series.current;
      if (!s) return;
      const b = bars.current;
      s.candles.setData(b);
      s.vol.setData(b.map((k) => ({ time: k.time, value: k.volume, color: k.close >= k.open ? "#26b07a40" : "#e5484d40" })));
      const closes = b.map((k) => k.close);
      const toLine = (vals: number[]) => vals.flatMap((v, i) => (Number.isFinite(v) ? [{ time: b[i].time, value: v }] : []));
      s.e9.setData(toLine(ema(closes, 9)));
      s.e21.setData(toLine(ema(closes, 21)));
      s.e100.setData(toLine(ema(closes, 100)));
    };

    (async () => {
      const raw = await info.candleSnapshot({ coin, interval: tf, startTime: Date.now() - ms * 600 });
      if (cancelled) return;
      bars.current = raw.map((k) => ({ time: (k.t / 1000) as UTCTimestamp, open: +k.o, high: +k.h, low: +k.l, close: +k.c, volume: +k.v }));
      paint();
      chart.current?.timeScale().scrollToRealTime();
      const sub = await subs.candle({ coin, interval: tf }, (k) => {
        const bar: Bar = { time: (k.t / 1000) as UTCTimestamp, open: +k.o, high: +k.h, low: +k.l, close: +k.c, volume: +k.v };
        const arr = bars.current;
        const lastBar = arr[arr.length - 1];
        if (lastBar && lastBar.time === bar.time) arr[arr.length - 1] = bar;
        else if (!lastBar || bar.time > lastBar.time) arr.push(bar);
        else return;
        const s = series.current;
        if (!s) return;
        s.candles.update(bar);
        s.vol.update({ time: bar.time, value: bar.volume, color: bar.close >= bar.open ? "#26b07a40" : "#e5484d40" });
      });
      if (cancelled) await sub.unsubscribe();
      else unsub = () => sub.unsubscribe();
    })().catch((e) => console.error("chart", e));
    return () => { cancelled = true; void unsub?.(); };
  }, [coin, tf, testnet]);

  useEffect(() => {
    const s = series.current;
    if (!s) return;
    const ms = TF_MS[tf];
    const markers: SeriesMarker<Time>[] = fills
      .filter((f) => f.coin === coin)
      .map((f): SeriesMarker<Time> => ({
        time: (Math.floor(f.time / ms) * ms / 1000) as UTCTimestamp,
        position: f.side === "long" ? "belowBar" : "aboveBar",
        color: f.side === "long" ? "#26b07a" : "#e5484d",
        shape: f.side === "long" ? "arrowUp" : "arrowDown",
        text: f.dir.startsWith("Close") ? "x" : f.side === "long" ? "B" : "S",
      }))
      .sort((a, b) => (a.time as number) - (b.time as number));
    s.markers.setMarkers(markers);

    for (const l of lines.current) s.candles.removePriceLine(l);
    lines.current = [];
    if (position) {
      const add = (price: number | null, color: string, title: string) => {
        if (price) lines.current.push(s.candles.createPriceLine({ price, color, lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title }));
      };
      add(position.entryPx, "#c8cfd6", `${position.side.toUpperCase()} ${position.size}`);
      add(position.stopPx, "#e5484d", "SL");
      add(position.takePx, "#26b07a", "TP");
      add(position.liquidationPx, "#8b5cf6", "LIQ");
    }
  }, [fills, position, coin, tf]);

  const shown = legend ?? bars.current[bars.current.length - 1];
  return (
    <div className="chart-box">
      <div className="legend">
        {shown && (
          <>
            <span className="muted">O</span>{px(shown.open)}<span className="muted">H</span>{px(shown.high)}
            <span className="muted">L</span>{px(shown.low)}<span className="muted">C</span>
            <span className={shown.close >= shown.open ? "up" : "down"}>{px(shown.close)}</span>
            <span className="amber">EMA9</span><span style={{ color: "#4c8dff" }}>EMA21</span><span style={{ color: "#8b5cf6" }}>EMA100</span>
          </>
        )}
      </div>
      <div className="tf" style={{ position: "absolute", right: 70, top: 4, zIndex: 3 }}>
        {TIMEFRAMES.map((t) => (
          <button key={t} className={t === tf ? "on" : ""} onClick={() => onTf(t)}>{t}</button>
        ))}
      </div>
      <div ref={box} style={{ position: "absolute", inset: 0 }} />
    </div>
  );
}

// reusable line chart for account equity and backtest curves
export function LineChart({ data, color = "#ff9f1a" }: { data: { t: number; v: number }[]; color?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const s = useRef<ISeriesApi<"Line"> | null>(null);
  useEffect(() => {
    if (!box.current) return;
    const c = createChart(box.current, { ...chartTheme, autoSize: true });
    s.current = c.addSeries(LineSeries, { color, lineWidth: 2, priceLineVisible: false });
    return () => { c.remove(); s.current = null; };
  }, [color]);
  useEffect(() => {
    const seen = new Set<number>();
    const pts = data
      .map((d) => ({ time: Math.floor(d.t / 1000) as UTCTimestamp, value: d.v }))
      .filter((p) => (seen.has(p.time) ? false : (seen.add(p.time), true)))
      .sort((a, b) => a.time - b.time);
    s.current?.setData(pts);
  }, [data]);
  return <div ref={box} className="mini-chart" />;
}
