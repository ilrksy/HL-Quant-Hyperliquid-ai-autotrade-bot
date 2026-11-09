import { useMemo, useState } from "react";
import { compact, pct, px, tone } from "../fmt";
import type { MarketRow } from "../hl";

// searchable perp universe sorted by liquidity, with the bot's coins marked
export function MarketList({ markets, selected, onSelect, botCoins, autoFocus }: {
  markets: MarketRow[]; selected: string; onSelect: (c: string) => void; botCoins: string[]; autoFocus?: boolean;
}) {
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<"volume" | "change" | "name" | "funding">("volume");
  const rows = useMemo(() => {
    const f = markets.filter((m) => m.name.toLowerCase().includes(q.toLowerCase()));
    return f.sort((a, b) => (sort === "name" ? a.name.localeCompare(b.name) : sort === "change" ? b.change - a.change : sort === "funding" ? b.funding - a.funding : b.volume - a.volume));
  }, [markets, q, sort]);
  const th = (k: typeof sort, label: string, l = false) => (
    <th className={l ? "l" : ""} style={{ cursor: "pointer", color: sort === k ? "var(--accent)" : undefined }} onClick={() => setSort(k)}>{label}</th>
  );
  return (
    <>
      <div className="mkt-search"><input className="input" autoFocus={autoFocus} placeholder={`Search ${markets.length} perps`} value={q} onChange={(e) => setQ(e.target.value)} /></div>
      <div className="scroll" style={{ flex: 1 }}>
        <table>
          <thead><tr>{th("name", "Market", true)}{th("change", "24h")}{th("volume", "Volume")}</tr></thead>
          <tbody>
            {rows.map((m) => (
              <tr key={m.name} className={`click ${m.name === selected ? "sel" : ""}`} onClick={() => onSelect(m.name)}>
                <td>
                  <div className="row gap-4">
                    {botCoins.includes(m.name) && <span className="dot working" style={{ width: 6, height: 6, animation: "none" }} title="Watched by the bot" />}
                    <span style={{ fontFamily: "var(--sans)", fontWeight: 600 }}>{m.name}</span>
                    <span className="dim tiny">{m.maxLeverage}x</span>
                  </div>
                  <div className="dim tiny">{px(m.mark)}</div>
                </td>
                <td className={tone(m.change)}>{pct(m.change)}</td>
                <td className="muted">{compact(m.volume)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
