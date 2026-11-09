import { useEffect, useState } from "react";
import { api, type AppState } from "../api";
import { px, time } from "../fmt";

// visual -1..1 score so the model's conviction is readable at a glance
function ScoreBar({ v }: { v: number }) {
  const w = Math.min(50, Math.abs(v) * 50);
  return (
    <span className="scorebar">
      <i style={{ left: v >= 0 ? "50%" : `${50 - w}%`, width: `${w}%`, background: v >= 0 ? "var(--up)" : "var(--down)" }} />
    </span>
  );
}

// fields exposed for tuning, as [group, key, label, multiplier shown to the user]
const FIELDS: [("risk" | "strategy"), string, string, number][] = [
  ["risk", "riskPerTradePct", "Risk / trade %", 100],
  ["risk", "maxLeverage", "Max leverage", 1],
  ["risk", "dailyLossLimitPct", "Daily loss limit %", 100],
  ["risk", "maxDrawdownPct", "Kill switch DD %", 100],
  ["risk", "stopAtr", "Stop (ATR)", 1],
  ["risk", "takeAtr", "Target (ATR)", 1],
  ["risk", "maxCostR", "Max cost (R)", 1],
  ["risk", "cooldownMin", "Cooldown (min)", 1],
  ["strategy", "entryThreshold", "Entry threshold", 1],
  ["strategy", "adxTrend", "ADX trend", 1],
];

// autotrade control surface: arm/disarm, live model output per coin, and risk configuration
export function BotPanel({ s, refresh }: { s: AppState; refresh: () => void }) {
  const [err, setErr] = useState<string | null>(null);
  const [edit, setEdit] = useState(false);
  const [form, setForm] = useState<Record<string, string>>({});

  useEffect(() => {
    if (edit) return;
    const f: Record<string, string> = { coins: s.config.coins.join(","), interval: s.config.interval };
    for (const [g, k, , m] of FIELDS) f[k] = String(+((s.config[g] as unknown as Record<string, number>)[k] * m).toFixed(4));
    setForm(f);
  }, [s.config, edit]);

  const act = async (fn: () => Promise<unknown>) => {
    setErr(null);
    try { await fn(); refresh(); } catch (e) { setErr((e as Error).message); }
  };

  const save = () => act(async () => {
    const risk: Record<string, number> = {};
    const strategy: Record<string, number> = {};
    for (const [g, k, , m] of FIELDS) (g === "risk" ? risk : strategy)[k] = Number(form[k]) / m;
    await api.config({ coins: form.coins.split(",").map((c) => c.trim()).filter(Boolean), interval: form.interval, risk, strategy });
    setEdit(false);
  });

  const b = s.bot;
  const live = s.mode === "live";
  const sigs = Object.values(s.signals).sort((a, z) => Math.abs(z.score) - Math.abs(a.score));

  return (
    <>
      <div className="form">
        <div className="row">
          <span><span className={`dot ${b.running ? "on" : b.halted ? "err" : ""}`} />{b.running ? "AUTOTRADE ON" : b.halted ? "HALTED" : "AUTOTRADE OFF"}</span>
          <span className="muted" style={{ textAlign: "right" }}>tick {b.lastTick ? time(b.lastTick) : "—"} · {s.config.interval}</span>
        </div>
        {b.halted && <div className="msg err">{b.halted}</div>}
        {b.lastError && <div className="msg err">{b.lastError}</div>}
        <div className="row">
          {b.running
            ? <button className="btn" onClick={() => act(api.stop)}>Stop</button>
            : <button className="btn amber" onClick={() => {
                if (live && !confirm("Start autotrading with REAL funds? Losses are possible.")) return;
                void act(api.start);
              }}>Start {live ? "LIVE" : "paper"}</button>}
          <button className="btn ghost-short" onClick={() => confirm("Close all bot positions and stop?") && act(api.kill)}>Kill switch</button>
        </div>
        {err && <div className="msg err">{err}</div>}
      </div>

      <div className="panel-h"><span className="title">Signals</span><span className="spacer" />score −1 … +1</div>
      <div style={{ maxHeight: 210, overflow: "auto" }}>
        <table>
          <thead><tr><th>Coin</th><th>Regime</th><th>Score</th><th>Act</th></tr></thead>
          <tbody>
            {sigs.length === 0 && <tr><td colSpan={4} className="empty">waiting for first tick…</td></tr>}
            {sigs.map((g) => (
              <tr key={g.coin} title={`${g.reason}\n${g.factors.map((f) => `${f.name}: ${f.value.toFixed(2)} × ${f.weight}`).join("\n")}`}>
                <td>{g.coin}<span className="muted"> {px(g.price)}</span></td>
                <td className="muted">{g.regime}</td>
                <td><ScoreBar v={g.score} /> <span className={g.score > 0 ? "up" : g.score < 0 ? "down" : ""}>{g.score.toFixed(2)}</span></td>
                <td className={g.action === "long" ? "up" : g.action === "short" ? "down" : "muted"}>{g.action}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="panel-h"><span className="title">Risk &amp; Strategy</span><span className="spacer" />
        {edit
          ? <><button className="btn sm" onClick={() => setEdit(false)}>cancel</button><button className="btn sm amber" onClick={save}>save</button></>
          : <button className="btn sm" onClick={() => setEdit(true)}>edit</button>}
      </div>
      <div className="form" style={{ gridTemplateColumns: "1fr 1fr" }}>
        <label className="f" style={{ gridColumn: "1 / -1" }}>Coins
          <input disabled={!edit} value={form.coins ?? ""} onChange={(e) => setForm({ ...form, coins: e.target.value })} />
        </label>
        <label className="f">Interval
          <select disabled={!edit} value={form.interval} onChange={(e) => setForm({ ...form, interval: e.target.value })}>
            {["1m", "5m", "15m"].map((i) => <option key={i}>{i}</option>)}
          </select>
        </label>
        {FIELDS.map(([, k, label]) => (
          <label key={k} className="f">{label}
            <input disabled={!edit} value={form[k] ?? ""} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
          </label>
        ))}
      </div>
      {s.mode === "paper" && (
        <div className="form">
          <button className="btn sm" onClick={() => {
            const v = prompt("Reset paper account to equity (USD):", "10");
            if (v) void act(() => api.resetPaper(Number(v)));
          }}>Reset paper account</button>
        </div>
      )}
    </>
  );
}
