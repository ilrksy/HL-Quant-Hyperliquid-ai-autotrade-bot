import { useEffect, useState } from "react";
import type { Settings as SettingsT } from "../../../shared/types";
import { api, type AppState, type Conn, type ConnectionInfo, type TelegramStatus } from "../api";
import { until } from "../fmt";
import { refreshNow } from "../live";
import { copy, Field, Icon, Panel, Seg, Toggle, toast, useAction } from "../ui";

// numeric input that shows a scaled value (e.g. percent) without fighting partial typing
function Num({ value, onChange, scale = 1, step, disabled }: { value: number; onChange: (v: number) => void; scale?: number; step?: number; disabled?: boolean }) {
  const show = (v: number) => String(+(v * scale).toFixed(6));
  const [txt, setTxt] = useState(show(value));
  useEffect(() => { if (Number(txt) / scale !== value) setTxt(show(value)); }, [value, scale]);
  return <input className="input" inputMode="decimal" type="number" step={step} disabled={disabled} value={txt} onChange={(e) => { setTxt(e.target.value); const n = Number(e.target.value); if (e.target.value !== "" && Number.isFinite(n)) onChange(n / scale); }} />;
}

// sections that can be saved independently
type Section = keyof SettingsT;

// every server setting, editable from any connected device
export function Settings({ s, conn, onDisconnect }: { s: AppState; conn: Conn; onDisconnect: () => void }) {
  const [saved, setSaved] = useState<SettingsT | null>(null);
  const [d, setD] = useState<SettingsT | null>(null);
  const { busy, run } = useAction();
  useEffect(() => { api.settings().then((x) => { setSaved(x); setD(structuredClone(x)); }).catch((e) => toast((e as Error).message, false)); }, []);
  if (!d || !saved) return <div className="empty">Loading settings…</div>;

  const set = <K extends Section>(sec: K, patch: Partial<SettingsT[K]>) => setD((p) => (p ? { ...p, [sec]: { ...p[sec], ...patch } } : p));
  const dirty = (sec: Section) => JSON.stringify(d[sec]) !== JSON.stringify(saved[sec]);
  const save = (sec: Section) => run(sec, () => api.saveSettings({ [sec]: d[sec] } as never), "Saved").then((x) => {
    if (!x) return;
    setSaved(x);
    setD((p) => (p ? { ...p, [sec]: structuredClone(x[sec]) } : p));
    refreshNow();
  });
  const actions = (sec: Section) => (
    <>
      {dirty(sec) && <button className="btn sm ghost" onClick={() => setD((p) => (p ? { ...p, [sec]: structuredClone(saved[sec]) } : p))}>Discard</button>}
      <button className="btn sm primary" disabled={!dirty(sec) || busy === sec} onClick={() => save(sec)}>{busy === sec ? "Saving…" : "Save"}</button>
    </>
  );

  return (
    <div className="page">
      <div className="page-h"><h1>Settings</h1><span className="muted small">Stored on the server and applied on the next cycle; every device sees the same values.</span></div>

      <Panel title="Autotrade" actions={actions("bot")}>
        <div className="fields">
          <Field label="Cycle frequency (s)" hint="5–300"><Num value={d.bot.cycleSec} onChange={(v) => set("bot", { cycleSec: v })} /></Field>
          <Field label="Signal interval"><Seg value={d.bot.interval} onChange={(v) => set("bot", { interval: v })} options={["1m", "5m", "15m"]} /></Field>
          <Field label="Universe"><Seg value={d.bot.universe} onChange={(v) => set("bot", { universe: v })} options={[["manual", "Manual list"], ["auto", "Auto scout"]]} /></Field>
          {d.bot.universe === "manual"
            ? <Field label="Coins" className="span2" hint="Comma separated Hyperliquid names"><input className="input" value={d.bot.coins.join(", ")} onChange={(e) => set("bot", { coins: e.target.value.split(/[,\s]+/).filter(Boolean) })} /></Field>
            : <>
              <Field label="Scout: top N by volume"><Num value={d.bot.scoutTopN} onChange={(v) => set("bot", { scoutTopN: v })} /></Field>
              <Field label="Scout: min 24h volume ($M)"><Num value={d.bot.minVolumeUsd} scale={1e-6} onChange={(v) => set("bot", { minVolumeUsd: v })} /></Field>
            </>}
          <Field label="Max spread (bp)"><Num value={d.bot.maxSpreadBps} onChange={(v) => set("bot", { maxSpreadBps: v })} /></Field>
          <Field label="Time stop (hours)" hint="0 = off"><Num value={d.bot.maxHoldHours} onChange={(v) => set("bot", { maxHoldHours: v })} /></Field>
          <Field label="Resume armed after restart"><div className="row" style={{ height: 30 }}><Toggle on={d.bot.resumeOnRestart} onChange={(v) => set("bot", { resumeOnRestart: v })} /></div></Field>
        </div>
      </Panel>

      <Panel title="Risk limits" actions={actions("risk")}>
        <div className="fields">
          <Field label="Risk per trade (%)" hint="loss if the stop is hit, incl. fees"><Num value={d.risk.riskPerTradePct} scale={100} step={0.1} onChange={(v) => set("risk", { riskPerTradePct: v })} /></Field>
          <Field label="Max leverage (x)"><Num value={d.risk.maxLeverage} onChange={(v) => set("risk", { maxLeverage: v })} /></Field>
          <Field label="Max positions"><Num value={d.risk.maxPositions} onChange={(v) => set("risk", { maxPositions: v })} /></Field>
          <Field label="Daily loss limit (%)"><Num value={d.risk.dailyLossLimitPct} scale={100} onChange={(v) => set("risk", { dailyLossLimitPct: v })} /></Field>
          <Field label="Kill switch drawdown (%)" hint="from equity peak"><Num value={d.risk.maxDrawdownPct} scale={100} onChange={(v) => set("risk", { maxDrawdownPct: v })} /></Field>
          <Field label="Stop distance (ATR)"><Num value={d.risk.stopAtr} step={0.1} onChange={(v) => set("risk", { stopAtr: v })} /></Field>
          <Field label="Take profit (ATR)"><Num value={d.risk.takeAtr} step={0.1} onChange={(v) => set("risk", { takeAtr: v })} /></Field>
          <Field label="Breakeven after (R)"><Num value={d.risk.breakevenAtR} step={0.1} onChange={(v) => set("risk", { breakevenAtR: v })} /></Field>
          <Field label="Trailing distance (ATR)"><Num value={d.risk.trailAtr} step={0.1} onChange={(v) => set("risk", { trailAtr: v })} /></Field>
          <Field label="Loss cooldown (min)"><Num value={d.risk.cooldownMin} onChange={(v) => set("risk", { cooldownMin: v })} /></Field>
          <Field label="Max cost (R)" hint="skip trades where fees+slippage exceed this share of the stop"><Num value={d.risk.maxCostR} step={0.05} onChange={(v) => set("risk", { maxCostR: v })} /></Field>
        </div>
      </Panel>

      <Panel title="Leverage officer" actions={actions("leverage")}>
        <div className="fields">
          <Field label="Mode"><Seg value={d.leverage.mode} onChange={(v) => set("leverage", { mode: v })} options={[["auto", "Auto"], ["fixed", "Fixed"]]} /></Field>
          {d.leverage.mode === "fixed"
            ? <Field label="Fixed leverage (x)"><Num value={d.leverage.fixed} onChange={(v) => set("leverage", { fixed: v })} /></Field>
            : <Field label="Daily volatility budget (% of margin)" hint="lower = less leverage on volatile coins"><Num value={d.leverage.volTargetPct} onChange={(v) => set("leverage", { volTargetPct: v })} /></Field>}
          <Field label="Per-coin caps" className="span2" hint="e.g. BTC=10, DOGE=3 (always below the coin and global max)">
            <input className="input" value={Object.entries(d.leverage.perCoin).map(([k, v]) => `${k}=${v}`).join(", ")}
              onChange={(e) => set("leverage", { perCoin: Object.fromEntries(e.target.value.split(/[,\s]+/).map((x) => x.split("=")).filter(([k, v]) => k && Number(v) > 0).map(([k, v]) => [k, Number(v)])) })} />
          </Field>
        </div>
        <div className="dim small" style={{ marginTop: 8 }}>Leverage only changes margin usage; the dollar risk is fixed by the stop distance and the risk-per-trade limit.</div>
      </Panel>

      <Panel title="AI company" actions={actions("ai")}>
        <div className="fields">
          <Field label="AI authority"><Seg value={d.ai.mode} onChange={(v) => set("ai", { mode: v })} options={[["off", "Off"], ["advisory", "Advisory"], ["control", "Control"]]} /></Field>
          <Field label="Min research confidence"><Num value={d.ai.minConfidence} step={0.05} onChange={(v) => set("ai", { minConfidence: v })} /></Field>
          <Field label="Research memo (min)" hint="reuse an opinion for the same signal bar"><Num value={d.ai.researchTtlMin} onChange={(v) => set("ai", { researchTtlMin: v })} /></Field>
          <Field label="CEO plan every (min)"><Num value={d.ai.ceoIntervalMin} onChange={(v) => set("ai", { ceoIntervalMin: v })} /></Field>
          <Field label="Audit every (min)"><Num value={d.ai.auditIntervalMin} onChange={(v) => set("ai", { auditIntervalMin: v })} /></Field>
          <Field label="Max wait per decision (s)" hint="then the rules engine decides"><Num value={d.ai.maxCallSec} onChange={(v) => set("ai", { maxCallSec: v })} /></Field>
          <Field label="Deep research (Antigravity)"><div className="row" style={{ height: 30 }}><Toggle on={d.ai.deepResearch.enabled} onChange={(v) => set("ai", { deepResearch: { ...d.ai.deepResearch, enabled: v } })} /></div></Field>
          <Field label="Deep research every (min)"><Num value={d.ai.deepResearch.intervalMin} onChange={(v) => set("ai", { deepResearch: { ...d.ai.deepResearch, intervalMin: v } })} /></Field>
          <Field label="Deep research token cap"><Num value={d.ai.deepResearch.maxTokens} onChange={(v) => set("ai", { deepResearch: { ...d.ai.deepResearch, maxTokens: v } })} /></Field>
        </div>
      </Panel>

      <Panel title="Market intelligence workers" actions={actions("intel")}>
        <div className="fields">
          {([["sentiment", "Fear & Greed index"], ["news", "News headlines (RSS)"], ["macro", "BTC dominance & market cap"], ["crossFunding", "Binance/Bybit funding"]] as const).map(([k, label]) => (
            <Field key={k} label={label}><div className="row" style={{ height: 30 }}><Toggle on={d.intel[k]} onChange={(v) => set("intel", { [k]: v })} /></div></Field>
          ))}
        </div>
      </Panel>

      <TelegramPanel d={d} set={set} actions={actions("telegram")} dirty={dirty("telegram")} />
      <DevicesPanel conn={conn} onDisconnect={onDisconnect} />

      {s.mode === "paper" && <PaperPanel />}
    </div>
  );
}

// telegram bot configuration, pairing and notification filters
function TelegramPanel({ d, set, actions, dirty }: { d: SettingsT; set: <K extends Section>(sec: K, patch: Partial<SettingsT[K]>) => void; actions: React.ReactNode; dirty: boolean }) {
  const [st, setSt] = useState<TelegramStatus | null>(null);
  const [pair, setPair] = useState<{ code: string; until: number; bot: string | null } | null>(null);
  const { busy, run } = useAction();
  useEffect(() => {
    const load = () => api.telegramStatus().then(setSt).catch(() => undefined);
    void load();
    const id = setInterval(load, 4000);
    return () => clearInterval(id);
  }, []);
  const t = d.telegram;
  return (
    <Panel title="Telegram" actions={<>{st && <span className={`badge ${st.polling && !st.lastError ? "ok" : st.enabled ? "warn" : "mut"}`}>{st.polling && st.bot ? `@${st.bot}` : st.enabled ? st.lastError ?? "starting" : "off"}</span>}{actions}</>}>
      <div className="col gap-12">
        <div className="fields">
          <Field label="Enabled"><div className="row" style={{ height: 30 }}><Toggle on={t.enabled} onChange={(v) => set("telegram", { enabled: v })} /></div></Field>
          <Field label="Bot token" className="span2" hint="Create a bot with @BotFather and paste its token. Stored on your server only.">
            <input className="input" type="password" autoComplete="off" value={t.token} onChange={(e) => set("telegram", { token: e.target.value })} placeholder="123456:ABC…" />
          </Field>
        </div>
        <div className="row wrap">
          {([["trades", "Trades"], ["risk", "Risk & audit alerts"], ["ai", "AI failures"], ["daily", "Daily summary"], ["decisions", "CEO plans & audits"]] as const).map(([k, label]) => (
            <label key={k} className="row small" style={{ marginRight: 12 }}><Toggle on={t.notify[k]} onChange={(v) => set("telegram", { notify: { ...t.notify, [k]: v } })} />{label}</label>
          ))}
        </div>
        <div className="row wrap">
          <button className="btn" disabled={dirty || !t.token || !!busy} title={dirty ? "Save first" : undefined} onClick={() => run("pair", () => api.telegramPair()).then((p) => p && setPair(p))}><Icon name="link" />Pair a chat</button>
          <button className="btn" disabled={dirty || !t.chatIds.length || !!busy} onClick={() => run("test", () => api.telegramTest()).then((r) => r && toast(r.map((x) => `${x.chatId}: ${x.ok ? "sent" : x.error}`).join(" · "), r.every((x) => x.ok)))}><Icon name="send" />Send test</button>
          {st?.lastError && <span className="small down">{st.lastError}</span>}
        </div>
        {pair && pair.until > Date.now() && (
          <div className="msg ok">Open Telegram, message {pair.bot ? <b>@{pair.bot}</b> : "your bot"} and send <code>/pair {pair.code}</code> within {until(pair.until)}. Commands: /status /positions /pnl /pipeline /ai /logs /arm /disarm /kill</div>
        )}
        <div className="col gap-4">
          <span className="small muted">Paired chats</span>
          {t.chatIds.map((id) => (
            <div key={id} className="row"><code>{id}</code><button className="btn sm ghost" onClick={() => set("telegram", { chatIds: t.chatIds.filter((x) => x !== id) })}><Icon name="x" size={12} />Remove</button></div>
          ))}
          {!t.chatIds.length && <span className="dim small">None yet. Unknown chats are rejected and logged.</span>}
        </div>
      </div>
    </Panel>
  );
}

// how other devices reach this server with the single api
function DevicesPanel({ conn, onDisconnect }: { conn: Conn; onDisconnect: () => void }) {
  const [info, setInfo] = useState<ConnectionInfo | null>(null);
  const [reveal, setReveal] = useState(false);
  useEffect(() => { api.connection().then(setInfo).catch(() => undefined); }, []);
  const link = `${conn.url}/#token=${encodeURIComponent(conn.token)}`;
  return (
    <Panel title="Devices & connection" actions={<button className="btn sm danger" onClick={() => confirm("Disconnect this device?") && onDisconnect()}><Icon name="logout" size={12} />Disconnect</button>}>
      <div className="col gap-12">
        <div className="kv"><span>Server</span><span>{conn.url}</span></div>
        <div className="row wrap"><span className="small muted">API token</span><code>{reveal ? conn.token : "•".repeat(Math.min(24, conn.token.length))}</code>
          <button className="btn sm ghost" onClick={() => setReveal(!reveal)}>{reveal ? "Hide" : "Show"}</button>
          <button className="btn sm" onClick={() => copy(conn.token, "Token copied")}><Icon name="copy" size={12} />Copy token</button>
          <button className="btn sm" onClick={() => copy(link, "Browser link copied")}><Icon name="link" size={12} />Copy browser link</button>
        </div>
        {info && (info.localOnly
          ? <div className="msg warn">The server only listens on {info.host}. To connect phones or other PCs on your network, restart it with <code>HOST=0.0.0.0</code> (desktop: tray → Allow LAN devices). For access outside your home use Tailscale or a Cloudflare Tunnel — never open the port to the internet.</div>
          : <div className="col gap-4"><span className="small muted">Reachable on your network at:</span>{info.lan.map((u) => <code key={u}>{u}</code>)}</div>)}
        <div className="dim small" style={{ lineHeight: 1.6 }}>
          Windows / Linux / macOS app, Android app and any browser connect with the same URL and token.
          The browser link signs a browser in automatically; treat it like a password.
        </div>
      </div>
    </Panel>
  );
}

// resets the simulated account
function PaperPanel() {
  const [eq, setEq] = useState(10);
  const { busy, run } = useAction();
  return (
    <Panel title="Paper account">
      <div className="row wrap" style={{ alignItems: "flex-end" }}>
        <Field label="Starting equity (USD)"><input className="input" style={{ width: 140 }} type="number" value={eq} onChange={(e) => setEq(Number(e.target.value))} /></Field>
        <button className="btn danger" disabled={!!busy || !(eq > 0)} onClick={() => confirm(`Reset the paper account to $${eq}? Paper trade history is cleared.`) && run("reset", () => api.resetPaper(eq), "Paper account reset").then(refreshNow)}>Reset paper account</button>
        <span className="dim small">Live trading is enabled on the server with TRADING_MODE=live and an API wallet key (see README).</span>
      </div>
    </Panel>
  );
}
