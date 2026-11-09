import { useEffect, useMemo, useState } from "react";
import { compact, pct, px, tone } from "../fmt";
import type { MarketRow } from "../hl";

// searchable perp universe, sorted by liquidity so the useful markets surface first
export function MarketList({ markets, selected, onSelect, botCoins }: {
  markets: MarketRow[]; selected: string; onSelect: (c: string) => void; botCoins: string[];
}) {
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<"volume" | "change" | "name">("volume");
  const rows = useMemo(() => {
    const f = markets.filter((m) => m.name.toLowerCase().includes(q.toLowerCase()));
    return f.sort((a, b) => (sort === "name" ? a.name.localeCompare(b.name) : sort === "change" ? b.change - a.change : b.volume - a.volume));
  }, [markets, q, sort]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "/" && document.activeElement?.tagName !== "INPUT") {
        e.preventDefault();
        document.getElementById("mkt-search")?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="panel mkt">
      <div className="panel-h"><span className="title">Markets</span><span className="spacer" />{markets.length} perps</div>
      <input id="mkt-search" placeholder="Search  ( / )" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th onClick={() => setSort("name")} style={{ cursor: "pointer" }}>Coin</th>
              <th>Price</th>
              <th onClick={() => setSort("change")} style={{ cursor: "pointer" }}>24h</th>
              <th onClick={() => setSort("volume")} style={{ cursor: "pointer" }}>Vol</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => (
              <tr key={m.name} className={`clickable ${m.name === selected ? "sel" : ""}`} onClick={() => onSelect(m.name)}>
                <td>
                  {botCoins.includes(m.name) && <span className="amber">● </span>}
                  {m.name}<span className="muted"> {m.maxLeverage}x</span>
                </td>
                <td>{px(m.mark)}</td>
                <td className={tone(m.change)}>{pct(m.change)}</td>
                <td className="muted">{compact(m.volume)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
