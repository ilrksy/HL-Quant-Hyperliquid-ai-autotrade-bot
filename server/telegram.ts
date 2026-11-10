import { randomInt } from "node:crypto";
import type { EventView, Settings } from "../shared/types";
import type { Broker } from "./broker";
import type { Bus } from "./bus";
import type { Company } from "./company/company";
import type { AiGateway } from "./ai/gateway";
import type { SettingsStore } from "./settings";
import type { Store } from "./store";

// everything the telegram worker needs; fetch is injectable for tests
export interface TelegramDeps {
  bus: Bus;
  settings: SettingsStore;
  store: Store;
  company: Company;
  broker: Broker;
  ai: AiGateway;
  apiBase: string;
  fetch?: typeof fetch;
}

// subset of a telegram update this bot reacts to
interface TgUpdate {
  update_id: number;
  message?: { chat: { id: number; type: string; title?: string; username?: string; first_name?: string }; text?: string };
}

// html escaping for telegram parse_mode=HTML
export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
// signed dollar amount
const usd = (x: number, d = 2) => `${x >= 0 ? "+" : "-"}$${Math.abs(x).toFixed(d)}`;
// resolves after ms
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// command list shown by /help
const HELP = [
  "<b>HL Quant bot</b>",
  "/status – account, bot and AI health",
  "/positions – open positions",
  "/pnl – profit and loss summary",
  "/pipeline – last pipeline cycle",
  "/ai – AI providers",
  "/logs – latest warnings and trades",
  "/arm – start autotrade (live needs <code>/arm confirm</code>)",
  "/disarm – stop new entries",
  "/kill confirm – close all bot positions and stop",
].join("\n");

// telegram long-polling worker: authorised remote control plus filtered notifications
export class Telegram {
  private running = false;
  private loopId = 0;
  private offset = 0;
  private queue: { chatId: string; text: string }[] = [];
  private sending = false;
  private pair: { code: string; until: number } | null = null;
  private recent = new Map<string, number>();
  private fetchImpl: typeof fetch;
  botName: string | null = null;
  lastError: string | null = null;
  private lastToken = "";

  // wires notifications and restarts polling when the token or enabled flag changes
  constructor(private d: TelegramDeps) {
    this.fetchImpl = d.fetch ?? fetch;
    d.bus.on("event", (e: EventView) => this.onEvent(e));
    d.settings.on("change", (next: Settings, prev: Settings) => {
      if (next.telegram.token !== prev.telegram.token || next.telegram.enabled !== prev.telegram.enabled) this.restart();
    });
  }

  // current telegram settings
  private cfg() {
    return this.d.settings.get().telegram;
  }

  // starts polling when enabled and a token is configured
  start() {
    this.restart();
  }

  // stops any running loop and starts a fresh one if configuration allows
  restart() {
    this.running = false;
    this.loopId++;
    this.botName = null;
    const c = this.cfg();
    if (!c.enabled || !c.token) {
      this.lastError = c.enabled ? "no bot token configured" : null;
      return;
    }
    if (c.token !== this.lastToken) this.offset = 0;
    this.lastToken = c.token;
    this.running = true;
    void this.loop(this.loopId);
  }

  // stops polling on shutdown
  stop() {
    this.running = false;
    this.loopId++;
  }

  // one bot api call; returns the parsed body and http status without throwing on api errors
  private async api(method: string, body: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<{ status: number; ok: boolean; result?: unknown; description?: string }> {
    const res = await this.fetchImpl(`${this.d.apiBase}/bot${this.cfg().token}/${method}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
    });
    const j = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: unknown; description?: string };
    return { status: res.status, ok: !!j.ok, result: j.result, description: j.description };
  }

  // long-poll loop with backoff; a token error parks the loop until settings change
  private async loop(id: number) {
    let backoff = 2000;
    try {
      const me = await this.api("getMe");
      if (!me.ok) {
        this.lastError = me.status === 401 ? "invalid bot token" : `getMe failed: ${me.description ?? me.status}`;
        this.d.bus.log("error", "telegram", "reporter", `Telegram: ${this.lastError}`);
        this.running = false;
        return;
      }
      this.botName = (me.result as { username?: string })?.username ?? null;
      this.lastError = null;
      this.d.bus.log("success", "telegram", "reporter", `Telegram connected as @${this.botName}`);
    } catch (e) {
      this.lastError = `cannot reach Telegram: ${(e as Error).message}`;
      this.d.bus.log("warn", "telegram", "reporter", `Telegram: ${this.lastError}; retrying`);
    }
    while (this.running && id === this.loopId) {
      const polledAt = Date.now();
      try {
        const r = await this.api("getUpdates", { offset: this.offset, timeout: 25, allowed_updates: ["message"] }, 35_000);
        if (id !== this.loopId) return;
        if (r.status === 401) {
          this.lastError = "invalid bot token";
          this.d.bus.log("error", "telegram", "reporter", "Telegram token rejected; polling stopped");
          this.running = false;
          return;
        }
        if (r.status === 409) {
          this.lastError = r.description ?? "conflict";
          if (/webhook/i.test(r.description ?? "")) await this.api("deleteWebhook", { drop_pending_updates: false });
          else this.d.bus.log("warn", "telegram", "reporter", `Telegram conflict: ${r.description}. Is another instance using this bot?`);
          await sleep(10_000);
          continue;
        }
        if (!r.ok) throw new Error(r.description ?? `HTTP ${r.status}`);
        this.lastError = null;
        backoff = 2000;
        const updates = (r.result as TgUpdate[]) ?? [];
        for (const u of updates) {
          this.offset = Math.max(this.offset, u.update_id + 1);
          if (u.message?.text) await this.handle(String(u.message.chat.id), u.message.text.trim(), u.message.chat).catch((e) =>
            this.d.bus.log("error", "telegram", "reporter", `command failed: ${(e as Error).message}`));
        }
        if (!updates.length && Date.now() - polledAt < 1000) await sleep(1000);
      } catch (e) {
        if (id !== this.loopId) return;
        this.lastError = (e as Error).message;
        await sleep(backoff);
        backoff = Math.min(60_000, backoff * 2);
      }
    }
  }

  // creates a short-lived pairing code shown in the dashboard
  createPairCode(): { code: string; until: number; bot: string | null } {
    this.pair = { code: String(randomInt(100000, 1000000)), until: Date.now() + 10 * 60_000 };
    return { ...this.pair, bot: this.botName };
  }

  // routes one incoming message; unknown chats may only pair
  async handle(chatId: string, text: string, chat?: TgUpdate["message"] extends infer M ? M extends { chat: infer C } ? C : never : never) {
    const [rawCmd, ...args] = text.split(/\s+/);
    const cmd = rawCmd.toLowerCase().replace(/@\w+$/, "");
    const authorised = this.cfg().chatIds.includes(chatId);
    if (cmd === "/pair") {
      const ok = this.pair && this.pair.until > Date.now() && args[0] === this.pair.code;
      if (!ok) return this.reply(chatId, "Pairing code invalid or expired. Create a new one in Settings → Telegram.");
      this.pair = null;
      const ids = [...new Set([...this.cfg().chatIds, chatId])];
      this.d.settings.update({ telegram: { chatIds: ids } });
      const who = chat ? chat.title ?? chat.username ?? chat.first_name ?? chatId : chatId;
      this.d.bus.log("success", "telegram", "reporter", `Telegram chat paired: ${who} (${chatId})`);
      return this.reply(chatId, `Paired. This chat now controls HL Quant.\n\n${HELP}`);
    }
    if (!authorised) {
      this.d.bus.log("warn", "telegram", "reporter", `Telegram message from unauthorised chat ${chatId} ignored`);
      return this.reply(chatId, `Not authorised. Your chat id is <code>${esc(chatId)}</code>.\nIn the dashboard open Settings → Telegram → Pair device, then send <code>/pair CODE</code>.`);
    }
    this.d.bus.log("info", "telegram", "reporter", `Telegram command ${cmd} from ${chatId}`);
    switch (cmd) {
      case "/start":
      case "/help":
        return this.reply(chatId, HELP);
      case "/status":
        return this.reply(chatId, await this.statusText());
      case "/positions":
        return this.reply(chatId, await this.positionsText());
      case "/pnl":
        return this.reply(chatId, this.pnlText());
      case "/pipeline":
        return this.reply(chatId, this.pipelineText());
      case "/ai":
        return this.reply(chatId, this.aiText());
      case "/logs":
        return this.reply(chatId, this.logsText(Math.min(20, Math.max(1, Number(args[0]) || 8))));
      case "/arm":
        if (this.d.broker.mode === "live" && args[0] !== "confirm") return this.reply(chatId, "LIVE mode uses real funds. Send <code>/arm confirm</code> to start.");
        this.d.company.arm();
        return this.reply(chatId, `Autotrade <b>ARMED</b> (${this.d.broker.mode}).`);
      case "/disarm":
        this.d.company.disarm("disarmed via Telegram");
        return this.reply(chatId, "Autotrade <b>OFF</b>. Exchange-side stops stay in place.");
      case "/kill":
        if (args[0] !== "confirm") return this.reply(chatId, "This closes every bot position at market. Send <code>/kill confirm</code>.");
        await this.d.company.kill("kill switch via Telegram");
        return this.reply(chatId, "Kill switch executed. Autotrade is off.");
      default:
        return this.reply(chatId, `Unknown command.\n\n${HELP}`);
    }
  }

  // /status text
  private async statusText(): Promise<string> {
    const snap = await this.d.broker.snapshot().catch(() => this.d.company.snapshot);
    const st = this.d.company.state();
    const eq = snap?.equity ?? 0;
    const day = st.bot.dayStartEquity ? eq - st.bot.dayStartEquity : 0;
    const dd = st.bot.peakEquity ? ((st.bot.peakEquity - eq) / st.bot.peakEquity) * 100 : 0;
    const ai = this.d.ai.view();
    return [
      `<b>HL Quant · ${this.d.broker.mode.toUpperCase()}</b>`,
      `Equity <b>$${eq.toFixed(2)}</b> · avail $${(snap?.available ?? 0).toFixed(2)}`,
      `Today ${usd(day, 3)} · drawdown ${dd.toFixed(2)}%`,
      `Autotrade ${st.bot.armed ? "🟢 ARMED" : st.bot.halted ? `🔴 HALTED (${esc(st.bot.halted)})` : "⚪ OFF"}`,
      `Directive ${st.directive ? `${st.directive.mode.toUpperCase()} (${esc(st.directive.note.slice(0, 80))})` : "normal"}`,
      `CEO ${st.ceo ? `${st.ceo.regime} x${st.ceo.riskMultiplier.toFixed(2)}` : "no plan yet"} · audit ${st.audit ? `${st.audit.grade} ${st.audit.recommendation}` : "none"}`,
      `Cycle #${st.pipeline.cycle} · ${st.pipeline.lastCycleMs} ms · open ${(snap?.positions.length ?? 0)}`,
      `AI ${ai.filter((p) => p.health === "healthy").length}/${ai.length} providers healthy`,
    ].join("\n");
  }

  // /positions text
  private async positionsText(): Promise<string> {
    const snap = await this.d.broker.snapshot().catch(() => this.d.company.snapshot);
    const pos = snap?.positions ?? [];
    if (!pos.length) return "No open positions.";
    return pos.map((p) => `<b>${esc(p.coin)}</b> ${p.side.toUpperCase()} ${p.leverage}x · ${p.size}\nentry ${p.entryPx} · mark ${p.markPx} · PnL ${usd(p.unrealizedPnl, 3)}\nSL ${p.stopPx ?? "—"} · TP ${p.takePx ?? "—"}`).join("\n\n");
  }

  // /pnl text from the trade journal
  private pnlText(): string {
    const mode = this.d.broker.mode;
    const now = Date.now();
    const sum = (since: number) => {
      const t = this.d.store.trades({ mode, since, limit: 5000 });
      const pnl = t.reduce((a, x) => a + x.pnl, 0);
      const w = t.filter((x) => x.pnl > 0).length;
      return `${usd(pnl, 3)} · ${t.length} trades · win ${t.length ? ((w / t.length) * 100).toFixed(0) : 0}%`;
    };
    return [`<b>PnL (${mode})</b>`, `24h: ${sum(now - 86_400_000)}`, `7d: ${sum(now - 7 * 86_400_000)}`, `All: ${sum(0)}`].join("\n");
  }

  // /pipeline text
  private pipelineText(): string {
    const p = this.d.company.state().pipeline;
    return [`<b>Pipeline cycle #${p.cycle}</b> (${p.lastCycleMs} ms)`, ...p.stages.map((s) => `${s.n}. ${esc(s.title)} – ${esc(s.metric)}${s.detail ? ` · ${esc(s.detail.slice(0, 70))}` : ""}`)].join("\n");
  }

  // /ai text
  private aiText(): string {
    const v = this.d.ai.view();
    if (!v.length) return "No AI providers configured; the rules engine is deciding.";
    return v.map((p) => `${p.health === "healthy" ? "🟢" : p.health === "degraded" ? "🟡" : p.health === "disabled" ? "⚪" : "🔴"} <b>${esc(p.name)}</b> · ${p.keys.filter((k) => k.state === "ready").length}/${p.keys.length} keys · ${p.ok24h}/${p.calls24h} ok 24h`).join("\n");
  }

  // /logs text
  private logsText(n: number): string {
    const ev = this.d.store.events({ level: "warn+", limit: n }).concat(this.d.store.events({ cat: "trade", limit: n }))
      .sort((a, b) => b.id - a.id).slice(0, n);
    if (!ev.length) return "No recent warnings or trades.";
    return ev.map((e) => `${new Date(e.ts).toISOString().slice(11, 19)} [${e.agent}] ${esc(e.msg.slice(0, 160))}`).join("\n");
  }

  // decides which history events become notifications, with de-duplication of repeats
  private onEvent(e: EventView) {
    const c = this.cfg();
    if (!c.enabled || !c.token || !c.chatIds.length || e.level === "debug") return;
    const kind = (e.data as { kind?: string } | undefined)?.kind;
    let text: string | null = null;
    if (c.notify.trades && e.cat === "trade" && (kind === "open" || kind === "close" || e.level === "error")) text = `${kind === "open" ? "🟦" : kind === "close" ? (e.level === "success" ? "🟩" : "🟥") : "⚠️"} ${esc(e.msg)}`;
    else if (c.notify.risk && (e.cat === "risk" || e.cat === "audit") && (e.level === "warn" || e.level === "error")) text = `🛡 ${esc(e.msg)}`;
    else if (c.notify.ai && e.cat === "ai" && e.level === "error") text = `🤖 ${esc(e.msg)}`;
    else if (c.notify.daily && kind === "daily") text = `📊 ${esc(e.msg)}`;
    else if (c.notify.decisions && (kind === "ceo" || kind === "audit")) text = `🧭 ${esc(e.msg)}`;
    else if (e.cat === "system" && e.level === "error") text = `❗ ${esc(e.msg)}`;
    if (!text) return;
    const key = text.slice(0, 120);
    if ((this.recent.get(key) ?? 0) > Date.now() - 10 * 60_000) return;
    this.recent.set(key, Date.now());
    if (this.recent.size > 500) this.recent.delete(this.recent.keys().next().value!);
    for (const id of c.chatIds) this.enqueue(id, text);
  }

  // queues a message to one chat
  private reply(chatId: string, text: string) {
    this.enqueue(chatId, text);
  }

  // rate-limited sender (about one message per second) that drops the backlog rather than lagging forever
  private enqueue(chatId: string, text: string) {
    if (this.queue.length >= 40) this.queue.shift();
    this.queue.push({ chatId, text: text.slice(0, 4000) });
    if (!this.sending) void this.drain();
  }

  // sends queued messages in order
  private async drain() {
    this.sending = true;
    try {
      while (this.queue.length) {
        const m = this.queue.shift()!;
        const r = await this.api("sendMessage", { chat_id: m.chatId, text: m.text, parse_mode: "HTML", disable_web_page_preview: true }).catch((e) => ({ ok: false, status: 0, description: (e as Error).message }));
        if (!r.ok) this.lastError = `send failed: ${r.description ?? r.status}`;
        await sleep(1100);
      }
    } finally {
      this.sending = false;
    }
  }

  // test message for the settings page, reporting per-chat results
  async test(): Promise<{ chatId: string; ok: boolean; error: string | null }[]> {
    const c = this.cfg();
    if (!c.token) throw new Error("no bot token configured");
    if (!c.chatIds.length) throw new Error("no paired chats");
    const out = [];
    for (const id of c.chatIds) {
      const r = await this.api("sendMessage", { chat_id: id, text: `✅ HL Quant test message (${this.d.broker.mode})`, parse_mode: "HTML" });
      out.push({ chatId: id, ok: r.ok, error: r.ok ? null : r.description ?? `HTTP ${r.status}` });
    }
    return out;
  }

  // status for the settings page
  status() {
    const c = this.cfg();
    return { enabled: c.enabled, configured: !!c.token, polling: this.running, bot: this.botName, chats: c.chatIds.length, lastError: this.lastError,
      pairing: this.pair && this.pair.until > Date.now() ? { until: this.pair.until } : null };
  }
}
