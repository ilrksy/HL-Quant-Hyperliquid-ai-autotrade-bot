import type { PortfolioStats, TradeView } from "../shared/types";

// performance metrics for the profile page, computed from the trade journal and equity samples
export function portfolioStats(trades: TradeView[], equity: { t: number; v: number }[], startEquity: number,
  ai: PortfolioStats["ai"]): PortfolioStats {
  const chron = [...trades].sort((a, b) => a.closed - b.closed);
  const wins = chron.filter((t) => t.pnl > 0);
  const losses = chron.filter((t) => t.pnl <= 0);
  const grossWin = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = -losses.reduce((a, t) => a + t.pnl, 0);
  let ws = 0;
  let ls = 0;
  let maxW = 0;
  let maxL = 0;
  for (const t of chron) {
    if (t.pnl > 0) { ws++; ls = 0; } else { ls++; ws = 0; }
    maxW = Math.max(maxW, ws);
    maxL = Math.max(maxL, ls);
  }
  let peak = equity[0]?.v ?? startEquity;
  let mdd = 0;
  for (const p of equity) {
    peak = Math.max(peak, p.v);
    if (peak > 0) mdd = Math.max(mdd, (peak - p.v) / peak);
  }
  const byCoinMap = new Map<string, { trades: number; pnl: number; wins: number }>();
  for (const t of chron) {
    const e = byCoinMap.get(t.coin) ?? { trades: 0, pnl: 0, wins: 0 };
    e.trades++;
    e.pnl += t.pnl;
    if (t.pnl > 0) e.wins++;
    byCoinMap.set(t.coin, e);
  }
  const byDayMap = new Map<string, { pnl: number; trades: number }>();
  for (const t of chron) {
    const day = new Date(t.closed).toISOString().slice(0, 10);
    const e = byDayMap.get(day) ?? { pnl: 0, trades: 0 };
    e.pnl += t.pnl;
    e.trades++;
    byDayMap.set(day, e);
  }
  const n = chron.length;
  return {
    trades: n, wins: wins.length, losses: losses.length, winRate: n ? wins.length / n : 0,
    netPnl: grossWin - grossLoss, grossWin, grossLoss,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
    avgR: n ? chron.reduce((a, t) => a + t.r, 0) / n : 0,
    expectancy: n ? (grossWin - grossLoss) / n : 0,
    fees: chron.reduce((a, t) => a + t.fees, 0),
    best: n ? Math.max(...chron.map((t) => t.pnl)) : 0,
    worst: n ? Math.min(...chron.map((t) => t.pnl)) : 0,
    maxDrawdownPct: mdd * 100, longestWinStreak: maxW, longestLossStreak: maxL,
    avgHoldMin: n ? chron.reduce((a, t) => a + (t.closed - t.opened), 0) / n / 60_000 : 0,
    byCoin: [...byCoinMap.entries()].map(([coin, e]) => ({ coin, trades: e.trades, pnl: e.pnl, winRate: e.wins / e.trades }))
      .sort((a, b) => b.pnl - a.pnl),
    byDay: [...byDayMap.entries()].map(([day, e]) => ({ day, ...e })).sort((a, b) => a.day.localeCompare(b.day)).slice(-60),
    equity, startEquity, ai,
  };
}

// csv export with quoting so trade reasons containing commas stay intact
export function toCsv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return "";
  const cols = Object.keys(rows[0]);
  const cell = (v: unknown) => {
    const s = v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => cell(r[c])).join(","))].join("\n");
}
