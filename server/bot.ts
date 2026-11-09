import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { formatSize } from "@nktkas/hyperliquid/utils";
import { riskGate, sizePosition, trailStop } from "../core/risk";
import { evaluate } from "../core/strategy";
import type { Side, Signal } from "../core/types";
import type { AccountSnapshot, Broker } from "./broker";
import type { BotConfig } from "./config";
import { assets, bookImbalance, candles, mids } from "./market";

// one line in the bot journal shown on the dashboard
export interface LogLine {
  t: number;
  level: "info" | "trade" | "warn" | "error";
  msg: string;
}

// what the bot remembers about positions it opened, survives restarts via data/bot.json
interface Managed {
  side: Side;
  entryPx: number;
  initialStopPx: number;
  stopPx: number;
  openedAt: number;
}

// persisted subset so a restart neither forgets open trades nor resets drawdown tracking
interface Persisted {
  managed: Record<string, Managed>;
  peakEquity: number;
  dayStartEquity: number;
  day: number;
  cooldown: Record<string, number>;
}

// state file location
const FILE = "data/bot.json";

// autonomous loop: score markets, gate by risk, execute, then babysit open positions
export class Bot {
  running = false;
  halted: string | null = null;
  lastTick = 0;
  lastError: string | null = null;
  signals: Record<string, Signal> = {};
  logs: LogLine[] = [];
  equityCurve: { t: number; equity: number }[] = [];
  snapshot: AccountSnapshot | null = null;
  private p: Persisted;
  private timer: NodeJS.Timeout | null = null;
  private busy = false;

  // restores persisted risk state so a restart cannot bypass the kill switch
  constructor(public broker: Broker, public cfg: BotConfig) {
    this.p = existsSync(FILE)
      ? JSON.parse(readFileSync(FILE, "utf8"))
      : { managed: {}, peakEquity: 0, dayStartEquity: 0, day: -1, cooldown: {} };
  }

  // keeps state on disk after every change that matters for risk
  private save() {
    mkdirSync("data", { recursive: true });
    writeFileSync(FILE, JSON.stringify(this.p));
  }

  // bounded in-memory journal, newest first
  log(level: LogLine["level"], msg: string) {
    this.logs.unshift({ t: Date.now(), level, msg });
    if (this.logs.length > 400) this.logs.length = 400;
    if (level !== "info") console.log(`[${level}] ${msg}`);
  }

  // analysis runs continuously so the dashboard always has fresh signals even when trading is off
  startLoop() {
    if (this.timer) clearInterval(this.timer);
    const run = () => void this.tick();
    run();
    this.timer = setInterval(run, this.cfg.loopSec * 1000);
  }

  // arms order execution, clearing a previous halt only on explicit user action
  start() {
    this.running = true;
    this.halted = null;
    this.log("info", `autotrade ON (${this.broker.mode}) coins=${this.cfg.coins.join(",")}`);
  }

  // disarms new entries while leaving exchange-side stops in place
  stop(reason = "stopped by user") {
    this.running = false;
    this.log("warn", `autotrade OFF: ${reason}`);
  }

  // emergency flatten of every bot-managed position
  async killAll(reason: string) {
    this.stop(reason);
    for (const coin of Object.keys(this.p.managed)) {
      try {
        await this.broker.close(coin, reason);
        this.log("trade", `${coin} closed: ${reason}`);
      } catch (e) {
        this.log("error", `${coin} close failed: ${(e as Error).message}`);
      }
      delete this.p.managed[coin];
    }
    this.save();
  }

  // drawdown references reset with the paper account so old peaks do not trip the kill switch
  resetRiskState() {
    this.p = { managed: {}, peakEquity: 0, dayStartEquity: 0, day: -1, cooldown: {} };
    this.equityCurve = [];
    this.save();
  }

  // one pass: refresh account, manage open trades, then look for new entries
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      this.broker.onPrices(await mids());
      const snap = await this.broker.snapshot();
      this.snapshot = snap;
      this.trackEquity(snap.equity);
      const meta = await assets();
      const coins = [...new Set([...this.cfg.coins, ...Object.keys(this.p.managed)])];

      for (const coin of coins) {
        const a = meta.get(coin);
        if (!a) continue;
        const [ltf, htf, imb] = await Promise.all([
          candles(coin, this.cfg.interval, 400),
          candles(coin, "1h", 250),
          bookImbalance(coin).catch(() => 0),
        ]);
        // closed bars only so the signal cannot repaint within a bar
        const sig = evaluate(coin, ltf.slice(0, -1), htf.slice(0, -1), { bookImbalance: imb, funding: a.funding }, this.cfg.strategy);
        this.signals[coin] = sig;
        await this.manage(coin, sig, snap, a.maxLeverage, a.szDecimals);
      }
      this.lastTick = Date.now();
      this.lastError = null;
    } catch (e) {
      this.lastError = (e as Error).message;
      this.log("error", `tick failed: ${this.lastError}`);
    } finally {
      this.busy = false;
    }
  }

  // peak and day-start references drive the drawdown kill switch and daily loss limit
  private trackEquity(equity: number) {
    const day = Math.floor(Date.now() / 86_400_000);
    if (day !== this.p.day) { this.p.day = day; this.p.dayStartEquity = equity; }
    this.p.peakEquity = Math.max(this.p.peakEquity, equity);
    this.equityCurve.push({ t: Date.now(), equity });
    if (this.equityCurve.length > 3000) this.equityCurve.splice(0, this.equityCurve.length - 3000);
    this.save();
  }

  // per-coin state machine: trail or exit if positioned, otherwise consider an entry
  private async manage(coin: string, sig: Signal, snap: AccountSnapshot, coinMaxLev: number, szDecimals: number) {
    const r = this.cfg.risk;
    const pos = snap.positions.find((x) => x.coin === coin);
    const m = this.p.managed[coin];

    if (m && !pos) {
      const fill = snap.fills.find((f) => f.coin === coin && f.closedPnl !== 0);
      const pnl = fill ? fill.closedPnl - fill.fee : 0;
      this.log("trade", `${coin} ${m.side} closed by exchange (stop/target) pnl≈${pnl.toFixed(4)}`);
      if (pnl < 0) this.p.cooldown[coin] = Date.now() + r.cooldownMin * 60_000;
      delete this.p.managed[coin];
      this.save();
      return;
    }

    if (m && pos) {
      const next = trailStop(m.side, m.entryPx, m.initialStopPx, m.stopPx, pos.markPx, sig.atr, r);
      if (Math.abs(next - m.stopPx) > sig.atr * 0.1) {
        await this.broker.setStop(coin, next);
        this.log("trade", `${coin} stop ${m.stopPx.toPrecision(6)} -> ${next.toPrecision(6)}`);
        m.stopPx = next;
        this.save();
      }
      const reversal = (m.side === "long" && sig.action === "short") || (m.side === "short" && sig.action === "long");
      if (reversal && this.running) {
        await this.broker.close(coin, "signal reversal");
        this.log("trade", `${coin} ${m.side} closed on reversal: ${sig.reason}`);
        delete this.p.managed[coin];
        this.save();
      }
      return;
    }

    if (!this.running || pos || sig.action === "flat") return;
    if ((this.p.cooldown[coin] ?? 0) > Date.now()) return;

    const gate = riskGate({
      equity: snap.equity, peakEquity: this.p.peakEquity, dayStartEquity: this.p.dayStartEquity,
      openPositions: Math.max(snap.positions.length, Object.keys(this.p.managed).length),
    }, r);
    if (!gate.ok) {
      if (gate.reason.startsWith("KILL")) {
        this.halted = gate.reason;
        await this.killAll(gate.reason);
      }
      return;
    }

    const price = sig.price;
    const s = sizePosition(snap.available > 0 ? Math.min(snap.equity, snap.available) : snap.equity, price, sig.atr,
      sig.action, coinMaxLev, r);
    if (!s.ok) {
      this.log("warn", `${coin} ${sig.action} skipped: ${s.reason}`);
      return;
    }
    try {
      let size = Number(formatSize(s.size, szDecimals));
      if (size * price < r.minNotional) size = Number(formatSize(size + 10 ** -szDecimals, szDecimals));
      const res = await this.broker.open({
        coin, side: sig.action, size, leverage: s.leverage, stopPx: s.stopPx, takePx: s.takePx, reason: sig.reason,
      });
      if (res.filledSize <= 0) {
        this.log("warn", `${coin} entry not filled (${res.status})`);
        return;
      }
      this.p.managed[coin] = { side: sig.action, entryPx: res.avgPx, initialStopPx: s.stopPx, stopPx: s.stopPx, openedAt: Date.now() };
      this.save();
      this.log("trade",
        `${coin} OPEN ${sig.action.toUpperCase()} ${res.filledSize} @ ${res.avgPx.toPrecision(6)} ` +
        `$${s.notional.toFixed(2)} ${s.leverage}x SL ${s.stopPx.toPrecision(6)} TP ${s.takePx.toPrecision(6)} ` +
        `risk $${s.riskUsd.toFixed(3)} | ${sig.reason}`);
    } catch (e) {
      this.log("error", `${coin} open failed: ${(e as Error).message}`);
    }
  }

  // cheap account refresh after manual actions, without re-running the whole analysis pass
  async refreshSnapshot() {
    try {
      this.snapshot = await this.broker.snapshot();
    } catch (e) {
      this.log("error", `snapshot failed: ${(e as Error).message}`);
    }
    return this.snapshot;
  }

  // read model for the dashboard
  status() {
    return {
      running: this.running, halted: this.halted, lastTick: this.lastTick, lastError: this.lastError,
      peakEquity: this.p.peakEquity, dayStartEquity: this.p.dayStartEquity, managed: this.p.managed,
      cooldown: this.p.cooldown,
    };
  }
}
