import { chmodSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { AiCallView, DecisionView, EventView, TradeView } from "../shared/types";

// schema for every history table; additive only so existing databases keep working
const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, level TEXT NOT NULL,
  cat TEXT NOT NULL, agent TEXT NOT NULL, coin TEXT, cycle INTEGER, msg TEXT NOT NULL, data TEXT);
CREATE INDEX IF NOT EXISTS events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS events_cat ON events(cat, id);
CREATE INDEX IF NOT EXISTS events_agent ON events(agent, id);
CREATE INDEX IF NOT EXISTS events_coin ON events(coin, id);
CREATE TABLE IF NOT EXISTS ai_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, role TEXT NOT NULL,
  provider TEXT NOT NULL, key_id TEXT, key_label TEXT, model TEXT, status TEXT NOT NULL, http INTEGER, latency INTEGER,
  tok_in INTEGER, tok_out INTEGER, depth INTEGER, error TEXT);
CREATE INDEX IF NOT EXISTS ai_ts ON ai_calls(ts);
CREATE TABLE IF NOT EXISTS decisions (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, cycle INTEGER,
  coin TEXT NOT NULL, side TEXT, score REAL, stage TEXT, outcome TEXT, reason TEXT, data TEXT);
CREATE INDEX IF NOT EXISTS decisions_ts ON decisions(ts);
CREATE TABLE IF NOT EXISTS trades (id TEXT PRIMARY KEY, mode TEXT NOT NULL, source TEXT, coin TEXT NOT NULL,
  side TEXT NOT NULL, size REAL, entry REAL, exit REAL, pnl REAL, fees REAL, r REAL, leverage REAL, opened INTEGER,
  closed INTEGER, entry_reason TEXT, exit_reason TEXT);
CREATE INDEX IF NOT EXISTS trades_closed ON trades(closed);
CREATE TABLE IF NOT EXISTS equity (ts INTEGER PRIMARY KEY, mode TEXT, equity REAL, upnl REAL, margin REAL);
CREATE TABLE IF NOT EXISTS cycles (id INTEGER PRIMARY KEY, ts INTEGER, ms INTEGER, scanned INTEGER, candidates INTEGER,
  proposals INTEGER, approved INTEGER, executed INTEGER, data TEXT);
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`;

// filters accepted by the history log endpoint
export interface EventQuery {
  cat?: string;
  level?: string;
  agent?: string;
  coin?: string;
  q?: string;
  before?: number;
  since?: number;
  until?: number;
  limit?: number;
}

// sqlite value types accepted by node:sqlite bindings
type Bind = string | number | null;

// caps stored json blobs so one noisy event cannot bloat the database
function packJson(v: unknown): string | null {
  if (v === undefined) return null;
  const s = JSON.stringify(v);
  return s.length > 8000 ? JSON.stringify({ truncated: true, preview: s.slice(0, 8000) }) : s;
}

// parse helper that tolerates legacy or truncated rows
function unpackJson(s: unknown): unknown {
  if (typeof s !== "string") return undefined;
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

// durable history for logs, ai calls, decisions, trades, equity and settings using built-in sqlite
export class Store {
  readonly db: DatabaseSync;
  private stmts = new Map<string, StatementSync>();

  // wal mode keeps writes cheap while the dashboard reads concurrently; owner-only because ai keys and bot tokens live here
  constructor(file: string) {
    this.db = new DatabaseSync(file);
    if (file !== ":memory:") {
      try {
        chmodSync(file, 0o600);
      } catch {
        // filesystems without unix permissions (e.g. some windows mounts) keep their defaults
      }
    }
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=3000;");
    this.db.exec(SCHEMA);
  }

  // statement cache so hot paths do not re-parse sql
  private st(sql: string): StatementSync {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  // appends one history entry and returns it with its id
  addEvent(e: Omit<EventView, "id">): EventView {
    const r = this.st("INSERT INTO events (ts, level, cat, agent, coin, cycle, msg, data) VALUES (?,?,?,?,?,?,?,?)")
      .run(e.ts, e.level, e.cat, e.agent, e.coin ?? null, e.cycle ?? null, e.msg, packJson(e.data));
    return { ...e, id: Number(r.lastInsertRowid) };
  }

  // filtered, newest-first page of history with id-based pagination
  events(q: EventQuery = {}): EventView[] {
    const where: string[] = [];
    const args: Bind[] = [];
    if (q.cat) { where.push("cat = ?"); args.push(q.cat); }
    if (q.level === "warn+") where.push("level IN ('warn','error')");
    else if (q.level) { where.push("level = ?"); args.push(q.level); }
    if (q.agent) { where.push("agent = ?"); args.push(q.agent); }
    if (q.coin) { where.push("coin = ?"); args.push(q.coin.toUpperCase()); }
    if (q.q) { where.push("msg LIKE ?"); args.push(`%${q.q}%`); }
    if (q.before) { where.push("id < ?"); args.push(q.before); }
    if (q.since) { where.push("ts >= ?"); args.push(q.since); }
    if (q.until) { where.push("ts <= ?"); args.push(q.until); }
    const limit = Math.max(1, Math.min(1000, q.limit ?? 200));
    const sql = `SELECT * FROM events ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ${limit}`;
    return (this.st(sql).all(...args) as Record<string, unknown>[]).map((r) => ({
      id: Number(r.id), ts: Number(r.ts), level: r.level as EventView["level"], cat: r.cat as EventView["cat"],
      agent: String(r.agent), coin: (r.coin as string) ?? null, cycle: r.cycle === null ? null : Number(r.cycle),
      msg: String(r.msg), data: unpackJson(r.data),
    }));
  }

  // one row per real model request, the raw material for provider health and cost tracking
  addAiCall(c: Omit<AiCallView, "id"> & { providerId: string; keyId: string }): number {
    const r = this.st(`INSERT INTO ai_calls (ts, role, provider, key_id, key_label, model, status, http, latency, tok_in,
      tok_out, depth, error) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(c.ts, c.role, c.providerId, c.keyId, c.keyLabel,
      c.model, c.status, c.http, c.latency, c.tokIn, c.tokOut, c.depth, c.error);
    return Number(r.lastInsertRowid);
  }

  // newest-first ai call log
  aiCalls(q: { role?: string; provider?: string; status?: string; before?: number; limit?: number } = {}): AiCallView[] {
    const where: string[] = [];
    const args: Bind[] = [];
    if (q.role) { where.push("role = ?"); args.push(q.role); }
    if (q.provider) { where.push("provider = ?"); args.push(q.provider); }
    if (q.status) { where.push("status = ?"); args.push(q.status); }
    if (q.before) { where.push("id < ?"); args.push(q.before); }
    const limit = Math.max(1, Math.min(1000, q.limit ?? 200));
    const sql = `SELECT * FROM ai_calls ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ${limit}`;
    return (this.st(sql).all(...args) as Record<string, unknown>[]).map((r) => ({
      id: Number(r.id), ts: Number(r.ts), role: r.role as AiCallView["role"], provider: String(r.provider),
      keyLabel: String(r.key_label ?? ""), model: String(r.model ?? ""), status: r.status as AiCallView["status"],
      http: r.http === null ? null : Number(r.http), latency: Number(r.latency ?? 0), tokIn: Number(r.tok_in ?? 0),
      tokOut: Number(r.tok_out ?? 0), depth: Number(r.depth ?? 0), error: (r.error as string) ?? null,
    }));
  }

  // per provider/key aggregates over a window, feeding the providers page
  aiStats(since: number): { provider: string; keyId: string; calls: number; ok: number; limited: number; avgMs: number; tokens: number }[] {
    return (this.st(`SELECT provider, key_id, COUNT(*) calls, SUM(status='ok') ok, SUM(status='rate_limited') limited,
      AVG(CASE WHEN status='ok' THEN latency END) avg_ms, SUM(COALESCE(tok_in,0)+COALESCE(tok_out,0)) tokens
      FROM ai_calls WHERE ts >= ? AND status != 'cached' GROUP BY provider, key_id`).all(since) as Record<string, unknown>[])
      .map((r) => ({
        provider: String(r.provider), keyId: String(r.key_id ?? ""), calls: Number(r.calls), ok: Number(r.ok ?? 0),
        limited: Number(r.limited ?? 0), avgMs: Math.round(Number(r.avg_ms ?? 0)), tokens: Number(r.tokens ?? 0),
      }));
  }

  // totals for the top bar and profile page
  aiTotals(since: number): { calls: number; tokens: number; failures: number } {
    const r = this.st(`SELECT COUNT(*) calls, SUM(COALESCE(tok_in,0)+COALESCE(tok_out,0)) tokens,
      SUM(status NOT IN ('ok','cached')) failures FROM ai_calls WHERE ts >= ?`).get(since) as Record<string, unknown>;
    return { calls: Number(r.calls ?? 0), tokens: Number(r.tokens ?? 0), failures: Number(r.failures ?? 0) };
  }

  // final verdict for one candidate, with the full stage trail in data
  addDecision(d: Omit<DecisionView, "id">): DecisionView {
    const { ts, cycle, coin, side, score, stage, outcome, reason, ...rest } = d;
    const r = this.st("INSERT INTO decisions (ts, cycle, coin, side, score, stage, outcome, reason, data) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(ts, cycle, coin, side, score, stage, outcome, reason, packJson(rest));
    return { ...d, id: Number(r.lastInsertRowid) };
  }

  // newest-first decisions, optionally filtered
  decisions(q: { coin?: string; outcome?: string; before?: number; limit?: number } = {}): DecisionView[] {
    const where: string[] = [];
    const args: Bind[] = [];
    if (q.coin) { where.push("coin = ?"); args.push(q.coin.toUpperCase()); }
    if (q.outcome) { where.push("outcome = ?"); args.push(q.outcome); }
    if (q.before) { where.push("id < ?"); args.push(q.before); }
    const limit = Math.max(1, Math.min(500, q.limit ?? 100));
    const sql = `SELECT * FROM decisions ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ${limit}`;
    return (this.st(sql).all(...args) as Record<string, unknown>[]).map((r) => ({
      ...((unpackJson(r.data) as object) ?? {}),
      id: Number(r.id), ts: Number(r.ts), cycle: Number(r.cycle ?? 0), coin: String(r.coin), side: r.side as DecisionView["side"],
      score: Number(r.score ?? 0), stage: r.stage as DecisionView["stage"], outcome: r.outcome as DecisionView["outcome"],
      reason: String(r.reason ?? ""),
    })) as DecisionView[];
  }

  // idempotent so paper history can be re-synced every cycle
  upsertTrade(t: TradeView) {
    this.st(`INSERT INTO trades (id, mode, source, coin, side, size, entry, exit, pnl, fees, r, leverage, opened, closed,
      entry_reason, exit_reason) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`)
      .run(t.id, t.mode, t.source, t.coin, t.side, t.size, t.entry, t.exit, t.pnl, t.fees, t.r, t.leverage, t.opened,
        t.closed, t.entryReason, t.exitReason);
  }

  // trade history for the profile page, newest first
  trades(q: { mode?: string; coin?: string; source?: string; since?: number; limit?: number } = {}): TradeView[] {
    const where: string[] = [];
    const args: Bind[] = [];
    if (q.mode) { where.push("mode = ?"); args.push(q.mode); }
    if (q.coin) { where.push("coin = ?"); args.push(q.coin.toUpperCase()); }
    if (q.source) { where.push("source = ?"); args.push(q.source); }
    if (q.since) { where.push("closed >= ?"); args.push(q.since); }
    const limit = Math.max(1, Math.min(5000, q.limit ?? 500));
    const sql = `SELECT * FROM trades ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY closed DESC LIMIT ${limit}`;
    return (this.st(sql).all(...args) as Record<string, unknown>[]).map((r) => ({
      id: String(r.id), mode: r.mode as TradeView["mode"], source: (r.source as TradeView["source"]) ?? "bot",
      coin: String(r.coin), side: r.side as TradeView["side"], size: Number(r.size), entry: Number(r.entry),
      exit: Number(r.exit), pnl: Number(r.pnl), fees: Number(r.fees), r: Number(r.r), leverage: Number(r.leverage ?? 0),
      opened: Number(r.opened), closed: Number(r.closed), entryReason: String(r.entry_reason ?? ""),
      exitReason: String(r.exit_reason ?? ""),
    }));
  }

  // wipes one mode's trade and equity history, used by paper reset
  clearHistory(mode: string) {
    this.st("DELETE FROM trades WHERE mode = ?").run(mode);
    this.st("DELETE FROM equity WHERE mode = ?").run(mode);
  }

  // minute-resolution equity samples for the portfolio curve
  addEquity(ts: number, mode: string, equity: number, upnl: number, margin: number) {
    this.st("INSERT OR REPLACE INTO equity (ts, mode, equity, upnl, margin) VALUES (?,?,?,?,?)").run(ts, mode, equity, upnl, margin);
  }

  // equity curve downsampled to at most maxPoints so charts stay light
  equity(mode: string, since = 0, maxPoints = 800): { t: number; v: number }[] {
    const rows = this.st("SELECT ts, equity FROM equity WHERE mode = ? AND ts >= ? ORDER BY ts").all(mode, since) as
      { ts: number; equity: number }[];
    const step = Math.max(1, Math.ceil(rows.length / maxPoints));
    return rows.filter((_, i) => i % step === 0 || i === rows.length - 1).map((r) => ({ t: Number(r.ts), v: Number(r.equity) }));
  }

  // one summary row per pipeline cycle
  addCycle(c: { id: number; ts: number; ms: number; scanned: number; candidates: number; proposals: number;
    approved: number; executed: number; data?: unknown }) {
    this.st(`INSERT OR REPLACE INTO cycles (id, ts, ms, scanned, candidates, proposals, approved, executed, data)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(c.id, c.ts, c.ms, c.scanned, c.candidates, c.proposals, c.approved, c.executed,
      packJson(c.data));
  }

  // highest cycle id so numbering continues across restarts
  lastCycleId(): number {
    const r = this.st("SELECT MAX(id) m FROM cycles").get() as { m: number | null };
    return Number(r.m ?? 0);
  }

  // recent cycles for the pipeline history table
  cycles(limit = 100) {
    return (this.st(`SELECT * FROM cycles ORDER BY id DESC LIMIT ${Math.max(1, Math.min(1000, limit))}`).all() as
      Record<string, unknown>[]).map((r) => ({
      id: Number(r.id), ts: Number(r.ts), ms: Number(r.ms), scanned: Number(r.scanned), candidates: Number(r.candidates),
      proposals: Number(r.proposals), approved: Number(r.approved), executed: Number(r.executed),
    }));
  }

  // small json documents: settings, ai providers, company state
  kvGet<T>(k: string): T | undefined {
    const r = this.st("SELECT v FROM kv WHERE k = ?").get(k) as { v: string } | undefined;
    return r ? (JSON.parse(r.v) as T) : undefined;
  }

  // upsert for kv documents
  kvSet(k: string, v: unknown) {
    this.st("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(k, JSON.stringify(v));
  }

  // retention so logs cannot grow without bound
  prune(days: number) {
    const cut = Date.now() - days * 86_400_000;
    this.st("DELETE FROM events WHERE ts < ?").run(cut);
    this.st("DELETE FROM ai_calls WHERE ts < ?").run(cut);
    this.st("DELETE FROM decisions WHERE ts < ?").run(cut);
    this.st("DELETE FROM cycles WHERE ts < ?").run(cut);
  }

  // releases the file handle on shutdown and in tests
  close() {
    this.db.close();
  }
}
