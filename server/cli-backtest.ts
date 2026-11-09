import { backtest } from "../core/backtest";
import { asset, candleHistory, INTERVAL_MS } from "./market";

// command-line backtest so the strategy can be judged before any money is at risk
async function main() {
  const [coin = "BTC", interval = "5m", days = "14", equity = "10"] = process.argv.slice(2);
  const a = await asset(coin.toUpperCase());
  const bars = Math.ceil((Number(days) * 86_400_000) / INTERVAL_MS[interval]) + 250;
  const data = await candleHistory(a.name, interval, bars);
  const r = backtest(a.name, data, { equity: Number(equity), coinMaxLeverage: a.maxLeverage });
  console.log(`${a.name} ${interval} ${days}d  bars=${r.bars}  trades=${r.trades.length}`);
  console.log(`equity ${r.startEquity.toFixed(2)} -> ${r.endEquity.toFixed(2)}  (${r.returnPct.toFixed(2)}%)`);
  console.log(`win ${(r.winRate * 100).toFixed(1)}%  PF ${r.profitFactor.toFixed(2)}  avgR ${r.avgR.toFixed(2)}  maxDD ${r.maxDrawdownPct.toFixed(2)}%`);
}

main().catch((e) => { console.error(e); process.exit(1); });
