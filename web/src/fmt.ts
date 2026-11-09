// price precision that adapts from btc-sized numbers down to sub-cent memecoins
export function px(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  const d = a >= 1000 ? 1 : a >= 100 ? 2 : a >= 1 ? 4 : a >= 0.01 ? 5 : 7;
  return v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}

// dollar amounts, with cents always visible because the account starts at $10
export function usd(v: number | null | undefined, d = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return (v < 0 ? "-$" : "$") + Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}

// compact notation for volume and open interest columns
export function compact(v: number): string {
  return Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(v);
}

// signed percent used for pnl and 24h change
export function pct(v: number, d = 2): string {
  if (!Number.isFinite(v)) return "—";
  return `${v > 0 ? "+" : ""}${v.toFixed(d)}%`;
}

// css class for green/red colouring
export const tone = (v: number) => (v > 0 ? "up" : v < 0 ? "down" : "");

// hh:mm:ss in local time for tapes and logs
export const time = (t: number) => new Date(t).toLocaleTimeString("en-GB", { hour12: false });

// date + time for trade history
export const dateTime = (t: number) =>
  new Date(t).toLocaleString("en-GB", { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
