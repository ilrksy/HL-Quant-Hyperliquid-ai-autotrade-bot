import { createHash } from "node:crypto";
import type { AiCallStatus, AiRole, KeyView, ProviderView, RouteView } from "../../shared/types";
import type { Bus } from "../bus";
import type { Store } from "../store";
import { extractJson, retryAfterMs, shortError } from "./json";
import type { KeyConfig, ProviderConfig } from "./registry";
import { AiRegistry } from "./registry";

// one model request as issued by an agent
export interface AiRequest<T> {
  role: AiRole;
  system: string;
  prompt: string;
  maxTokens?: number;
  temperature?: number;
  cacheTtlMs?: number;
  deadlineMs?: number;
  // returns the normalised value, or null when the output is unusable so the next provider is tried
  validate: (json: unknown) => T | null;
}

// trace of one try inside the fallback chain
export interface AiAttempt {
  provider: string;
  model: string;
  key: string;
  status: AiCallStatus | "skipped";
  http: number | null;
  ms: number;
  error?: string;
}

// final answer plus everything needed to explain how it was obtained
export interface AiResult<T> {
  ok: boolean;
  value: T | null;
  text: string;
  provider: string;
  providerName: string;
  model: string;
  keyLabel: string;
  latencyMs: number;
  depth: number;
  cached: boolean;
  attempts: AiAttempt[];
  tokensIn: number;
  tokensOut: number;
  error: string | null;
}

// raw outcome of one http exchange before policy is applied
interface CallOutcome {
  status: AiCallStatus;
  http: number | null;
  text: string;
  tokIn: number;
  tokOut: number;
  error?: string;
  retryAfter?: number;
  daily?: boolean;
}

// volatile health of one key
interface KeyRt {
  cooldownUntil: number;
  strikes: number;
  invalid: string | null;
  window: number[];
  lastUsed: number;
  lastError: string | null;
}

// volatile health of one provider
interface ProvRt {
  failures: number;
  openUntil: number;
  opens: number;
  lastError: string | null;
}

// pseudo key used for providers that work without credentials
const ANON: KeyConfig = { id: "anon", label: "no key", key: "", enabled: true };

// masked form of a secret for display
export const maskKey = (k: string) => (!k ? "" : k.length <= 10 ? "••••" : `${k.slice(0, 4)}…${k.slice(-4)}`);

// resolves after ms, used by the antigravity poller
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// maps a failed http status to a policy class
function classify(http: number, body: string, retryHeader: string | null): CallOutcome {
  const error = shortError(body);
  const base = { http, text: "", tokIn: 0, tokOut: 0, error };
  if (http === 429) return { ...base, status: "rate_limited", retryAfter: retryAfterMs(retryHeader, body), daily: /per ?day|daily|RPD/i.test(body) };
  if (http === 402) {
    const retryAfter = retryAfterMs(retryHeader, body);
    return { ...base, status: "rate_limited", retryAfter: retryAfter ?? 3_600_000, daily: !retryAfter };
  }
  if (http === 401 || http === 403) return { ...base, status: "auth" };
  if (http === 400 && /api[_ ]?key|API_KEY_INVALID|unauthori[sz]ed|invalid.{0,20}key|permission/i.test(body)) return { ...base, status: "auth" };
  if (http >= 500 || http === 408 || http === 409) return { ...base, status: "server" };
  return { ...base, status: "bad_request" };
}

// text content from an openai-style chat completion, including array content parts
function contentOf(j: unknown): string {
  const c = (j as { choices?: { message?: { content?: unknown } }[] })?.choices?.[0]?.message?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((p) => (typeof p === "string" ? p : (p as { text?: string })?.text ?? "")).join("");
  return "";
}

// multi-provider, multi-key llm router: rotates keys, cools down rate-limited keys, trips circuit breakers on
// failing providers and walks each role's fallback chain until a valid answer arrives
export class AiGateway {
  readonly registry: AiRegistry;
  private keyRt = new Map<string, KeyRt>();
  private provRt = new Map<string, ProvRt>();
  private cache = new Map<string, { exp: number; res: AiResult<unknown> }>();
  private fetchImpl: typeof fetch;

  // the registry owns configuration; this class owns runtime health
  constructor(private store: Store, private bus: Bus, opts: { fetch?: typeof fetch } = {}) {
    this.registry = new AiRegistry(store);
    this.fetchImpl = opts.fetch ?? fetch;
    this.registry.onChange(() => this.forgetStaleKeys());
  }

  // drops runtime state of keys that no longer exist so re-added keys start clean
  private forgetStaleKeys() {
    const live = new Set(this.registry.list().flatMap((p) => [...p.keys, ANON].map((k) => `${p.id}:${k.id}`)));
    for (const k of this.keyRt.keys()) if (!live.has(k)) this.keyRt.delete(k);
  }

  // lazily created key runtime
  private krt(pid: string, kid: string): KeyRt {
    const id = `${pid}:${kid}`;
    let rt = this.keyRt.get(id);
    if (!rt) {
      rt = { cooldownUntil: 0, strikes: 0, invalid: null, window: [], lastUsed: 0, lastError: null };
      this.keyRt.set(id, rt);
    }
    return rt;
  }

  // lazily created provider runtime
  private prt(pid: string): ProvRt {
    let rt = this.provRt.get(pid);
    if (!rt) {
      rt = { failures: 0, openUntil: 0, opens: 0, lastError: null };
      this.provRt.set(pid, rt);
    }
    return rt;
  }

  // configured keys, or the anonymous pseudo key for keyless providers
  private poolOf(p: ProviderConfig): KeyConfig[] {
    if (p.keys.length) return p.keys;
    return p.keyRequired ? [] : [ANON];
  }

  // keys that may be used right now, least recently used first for even spreading across the pool
  private usableKeys(p: ProviderConfig, now: number): KeyConfig[] {
    return this.poolOf(p)
      .filter((k) => k.enabled)
      .map((k) => [k, this.krt(p.id, k.id)] as const)
      .filter(([k, rt]) => {
        rt.window = rt.window.filter((t) => now - t < 60_000);
        return !rt.invalid && !k.invalid && rt.cooldownUntil <= now && rt.window.length < p.rpm;
      })
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed)
      .map(([k]) => k);
  }

  // walks the role chain; returns ok=false only when every provider and key failed
  async complete<T>(req: AiRequest<T>): Promise<AiResult<T>> {
    const started = Date.now();
    const deadline = started + (req.deadlineMs ?? 25_000);
    const cacheKey = req.cacheTtlMs
      ? createHash("sha256").update(`${req.role}\n${req.system}\n${req.prompt}`).digest("hex")
      : null;
    if (cacheKey) {
      const hit = this.cache.get(cacheKey);
      if (hit && hit.exp > started) return { ...(hit.res as AiResult<T>), cached: true, latencyMs: 0, attempts: [] };
    }
    const attempts: AiAttempt[] = [];
    const chain = this.registry.chainFor(req.role);
    for (let depth = 0; depth < chain.length; depth++) {
      const link = chain[depth];
      const p = this.registry.get(link.providerId);
      if (!p) continue;
      const pr = this.prt(p.id);
      const now = Date.now();
      if (pr.openUntil > now) {
        attempts.push({ provider: p.id, model: link.model, key: "", status: "skipped", http: null, ms: 0, error: "circuit open" });
        continue;
      }
      const keys = this.usableKeys(p, now);
      if (!keys.length) {
        attempts.push({ provider: p.id, model: link.model, key: "", status: "skipped", http: null, ms: 0, error: "no key available (cooldown, invalid or rpm)" });
        continue;
      }
      let nextProvider = false;
      for (const k of keys) {
        const remaining = deadline - Date.now();
        if (remaining < 1500) break;
        const rt = this.krt(p.id, k.id);
        rt.window.push(Date.now());
        rt.lastUsed = Date.now();
        const t0 = Date.now();
        const moreAfter = depth < chain.length - 1;
        const timeout = Math.min(p.timeoutSec * 1000, moreAfter ? Math.max(5000, remaining * 0.6) : remaining);
        let out = p.kind === "antigravity"
          ? await this.callAntigravity(p, k, link.model, req, timeout)
          : await this.callOpenAi(p, k, link.model, req, timeout);
        const ms = Date.now() - t0;
        let value: T | null = null;
        if (out.status === "ok") {
          value = req.validate(extractJson(out.text));
          if (value === null) out = { ...out, status: "bad_output", error: `unusable output: ${out.text.slice(0, 160) || "(empty)"}` };
        }
        this.store.addAiCall({
          ts: t0, role: req.role, provider: p.id, providerId: p.id, keyId: k.id, keyLabel: k.label, model: link.model,
          status: out.status, http: out.http, latency: ms, tokIn: out.tokIn, tokOut: out.tokOut, depth, error: out.error ?? null,
        });
        attempts.push({ provider: p.id, model: link.model, key: k.label, status: out.status, http: out.http, ms, error: out.error });
        if (out.status === "ok" && value !== null) {
          rt.strikes = 0;
          rt.lastError = null;
          pr.failures = 0;
          pr.opens = 0;
          const res: AiResult<T> = {
            ok: true, value, text: out.text, provider: p.id, providerName: p.name, model: link.model, keyLabel: k.label,
            latencyMs: Date.now() - started, depth, cached: false, attempts, tokensIn: out.tokIn, tokensOut: out.tokOut, error: null,
          };
          if (cacheKey) this.cache.set(cacheKey, { exp: Date.now() + req.cacheTtlMs!, res });
          if (this.cache.size > 300) this.cache.delete(this.cache.keys().next().value!);
          return res;
        }
        rt.lastError = out.error ?? out.status;
        pr.lastError = out.error ?? out.status;
        if (out.status === "rate_limited") {
          rt.strikes++;
          const backoff = out.daily ? 3_600_000 : Math.min(15 * 60_000, 15_000 * 2 ** (rt.strikes - 1));
          const cool = out.retryAfter && !out.daily ? Math.max(out.retryAfter, 5_000) : Math.max(out.retryAfter ?? 0, backoff);
          rt.cooldownUntil = Date.now() + cool;
          this.bus.log("warn", "ai", "gateway", `${p.name} ${k.label} rate-limited, cooling down ${Math.round(cool / 1000)}s`,
            { data: { provider: p.id, model: link.model, http: out.http, error: out.error } });
          continue;
        }
        if (out.status === "auth") {
          rt.invalid = out.error ?? "rejected";
          this.registry.markInvalid(p.id, k.id, rt.invalid);
          this.bus.log("error", "ai", "gateway", `${p.name} ${k.label} rejected (${out.http}): ${out.error}`, { data: { provider: p.id } });
          continue;
        }
        if (out.status === "server" || out.status === "timeout" || out.status === "network") {
          pr.failures++;
          if (pr.failures >= 3) {
            const open = Math.min(10 * 60_000, 30_000 * 2 ** pr.opens);
            pr.opens++;
            pr.failures = 0;
            pr.openUntil = Date.now() + open;
            this.bus.log("warn", "ai", "gateway", `${p.name} circuit open for ${Math.round(open / 1000)}s after repeated ${out.status} errors`,
              { data: { provider: p.id, error: out.error } });
          }
        }
        nextProvider = true;
        break;
      }
      if (!nextProvider && Date.now() >= deadline - 1500) break;
    }
    const error = attempts.length
      ? attempts.map((a) => `${a.provider}${a.key ? `/${a.key}` : ""}: ${a.status}${a.error ? ` (${a.error.slice(0, 80)})` : ""}`).join("; ")
      : "no ai provider configured for this role";
    return {
      ok: false, value: null, text: "", provider: "none", providerName: "none", model: "", keyLabel: "", depth: chain.length,
      latencyMs: Date.now() - started, cached: false, attempts, tokensIn: 0, tokensOut: 0, error,
    };
  }

  // openai-compatible /chat/completions call, used by almost every provider
  private async callOpenAi(p: ProviderConfig, k: KeyConfig, model: string, req: AiRequest<unknown>, timeoutMs: number): Promise<CallOutcome> {
    const out = await this.postChat(p, k, model, req, timeoutMs, p.jsonMode);
    if (out.status === "bad_request" && p.jsonMode && /response_format|json_object|json mode|json_mode/i.test(out.error ?? "")) {
      const retry = await this.postChat(p, k, model, req, timeoutMs, false);
      if (retry.status === "ok") {
        this.registry.update(p.id, { jsonMode: false });
        this.bus.log("info", "ai", "gateway", `${p.name} rejects response_format; JSON mode switched off for this provider`);
      }
      return retry;
    }
    return out;
  }

  // one chat completion request with optional json mode
  private async postChat(p: ProviderConfig, k: KeyConfig, model: string, req: AiRequest<unknown>, timeoutMs: number, jsonMode: boolean): Promise<CallOutcome> {
    const body: Record<string, unknown> = {
      model,
      messages: [{ role: "system", content: req.system }, { role: "user", content: req.prompt }],
      temperature: req.temperature ?? 0.2,
      max_tokens: req.maxTokens ?? 800,
    };
    if (jsonMode) body.response_format = { type: "json_object" };
    const headers: Record<string, string> = { "content-type": "application/json", ...p.headers };
    if (k.key) headers.authorization = `Bearer ${k.key}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await this.fetchImpl(`${p.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST", headers, body: JSON.stringify(body), signal: ctrl.signal,
      });
      const raw = await res.text();
      if (!res.ok) return classify(res.status, raw, res.headers.get("retry-after"));
      let j: { usage?: { prompt_tokens?: number; completion_tokens?: number } };
      try {
        j = JSON.parse(raw);
      } catch {
        return { status: "bad_output", http: res.status, text: "", tokIn: 0, tokOut: 0, error: `non-json body: ${raw.slice(0, 120)}` };
      }
      return { status: "ok", http: res.status, text: contentOf(j), tokIn: j.usage?.prompt_tokens ?? 0, tokOut: j.usage?.completion_tokens ?? 0 };
    } catch (e) {
      const aborted = ctrl.signal.aborted;
      return { status: aborted ? "timeout" : "network", http: null, text: "", tokIn: 0, tokOut: 0,
        error: aborted ? `no response within ${Math.round(timeoutMs / 1000)}s` : (e as Error).message };
    } finally {
      clearTimeout(timer);
    }
  }

  // google antigravity managed agent through the gemini interactions api: start in background, then poll
  private async callAntigravity(p: ProviderConfig, k: KeyConfig, agent: string, req: AiRequest<unknown>, timeoutMs: number): Promise<CallOutcome> {
    const base = p.baseUrl.replace(/\/+$/, "");
    const headers = { "content-type": "application/json", "x-goog-api-key": k.key, "Api-Revision": "2026-05-20" };
    const until = Date.now() + timeoutMs;
    const read = (j: Record<string, unknown>) => {
      const outputs = (j.outputs as { text?: string }[] | undefined)?.map((o) => o?.text ?? "").join("") ?? "";
      const usage = (j.usage ?? {}) as Record<string, number>;
      return {
        text: String(j.output_text ?? outputs ?? ""),
        tokIn: Number(usage.total_input_tokens ?? usage.input_tokens ?? 0),
        tokOut: Number(usage.total_output_tokens ?? usage.output_tokens ?? 0),
      };
    };
    try {
      const res = await this.fetchImpl(`${base}/interactions`, {
        method: "POST", headers,
        body: JSON.stringify({
          agent, input: `${req.system}\n\n${req.prompt}`, environment: "remote", background: true,
          agent_config: { type: "antigravity", max_total_tokens: req.maxTokens ?? 60_000 },
        }),
        signal: AbortSignal.timeout(Math.min(30_000, timeoutMs)),
      });
      const raw = await res.text();
      if (!res.ok) return classify(res.status, raw, res.headers.get("retry-after"));
      let j = JSON.parse(raw) as Record<string, unknown>;
      while (!["completed", "failed", "cancelled", "incomplete"].includes(String(j.status))) {
        if (Date.now() > until) return { status: "timeout", http: null, text: "", tokIn: 0, tokOut: 0, error: "agent still running at deadline" };
        await sleep(4000);
        const poll = await this.fetchImpl(`${base}/interactions/${encodeURIComponent(String(j.id))}`, {
          headers, signal: AbortSignal.timeout(20_000),
        });
        const praw = await poll.text();
        if (!poll.ok) return classify(poll.status, praw, poll.headers.get("retry-after"));
        j = JSON.parse(praw);
      }
      const out = read(j);
      if (j.status === "completed" || (j.status === "incomplete" && out.text)) return { status: "ok", http: 200, ...out };
      return { status: "server", http: 200, text: "", tokIn: out.tokIn, tokOut: out.tokOut, error: `agent ${j.status}` };
    } catch (e) {
      const timedOut = (e as Error).name === "TimeoutError";
      return { status: timedOut ? "timeout" : "network", http: null, text: "", tokIn: 0, tokOut: 0, error: (e as Error).message };
    }
  }

  // sends a tiny prompt through every key of one provider and clears penalties for keys that work
  async test(providerId: string): Promise<{ keyId: string; label: string; ok: boolean; status: string; http: number | null; ms: number; error: string | null }[]> {
    const p = this.registry.get(providerId);
    if (!p) throw new Error(`unknown provider ${providerId}`);
    const out = [];
    for (const k of this.poolOf(p)) {
      const t0 = Date.now();
      let res: CallOutcome;
      if (p.kind === "antigravity") {
        res = await this.fetchImpl(`${p.baseUrl.replace(/\/+$/, "")}/models?pageSize=1`, { headers: { "x-goog-api-key": k.key }, signal: AbortSignal.timeout(15_000) })
          .then(async (r) => (r.ok ? { status: "ok" as const, http: r.status, text: '{"ok":true}', tokIn: 0, tokOut: 0 } : classify(r.status, await r.text(), null)))
          .catch((e) => ({ status: "network" as const, http: null, text: "", tokIn: 0, tokOut: 0, error: (e as Error).message }));
      } else {
        res = await this.callOpenAi(p, k, p.models[0] ?? "", {
          role: "auditor", system: "You are a health check. Reply with JSON only.", prompt: 'Return exactly {"ok":true}',
          maxTokens: 400, validate: () => true,
        }, Math.min(p.timeoutSec * 1000, 30_000));
      }
      const ok = res.status === "ok" && (extractJson(res.text) as { ok?: boolean } | null)?.ok === true;
      const rt = this.krt(p.id, k.id);
      if (ok) {
        rt.invalid = null;
        rt.cooldownUntil = 0;
        rt.strikes = 0;
        rt.lastError = null;
        this.prt(p.id).openUntil = 0;
        this.registry.markInvalid(p.id, k.id, null);
      } else if (res.status === "auth") {
        rt.invalid = res.error ?? "rejected";
        this.registry.markInvalid(p.id, k.id, rt.invalid);
      }
      out.push({ keyId: k.id, label: k.label, ok, status: ok ? "ok" : res.status === "ok" ? "bad_output" : res.status,
        http: res.http, ms: Date.now() - t0, error: ok ? null : res.error ?? `unexpected reply: ${res.text.slice(0, 120)}` });
    }
    return out;
  }

  // live model list from the provider so stale preset ids can be replaced
  async listModels(providerId: string): Promise<string[]> {
    const p = this.registry.get(providerId);
    if (!p) throw new Error(`unknown provider ${providerId}`);
    if (p.kind === "antigravity") return p.models;
    const k = this.poolOf(p).find((x) => x.enabled);
    const headers: Record<string, string> = { ...p.headers };
    if (k?.key) headers.authorization = `Bearer ${k.key}`;
    const res = await this.fetchImpl(`${p.baseUrl.replace(/\/+$/, "")}/models`, { headers, signal: AbortSignal.timeout(20_000) });
    const raw = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${shortError(raw)}`);
    const j = JSON.parse(raw) as { data?: { id: string }[]; models?: { id?: string; name?: string }[] } | { id: string }[];
    const list = Array.isArray(j) ? j : j.data ?? j.models ?? [];
    return [...new Set(list.map((m) => String((m as { id?: string; name?: string }).id ?? (m as { name?: string }).name ?? "").replace(/^models\//, "")).filter(Boolean))].sort();
  }

  // provider list for clients with masked keys, runtime health and 24h usage
  view(): ProviderView[] {
    const now = Date.now();
    const stats = this.store.aiStats(now - 86_400_000);
    return this.registry.list().map((p) => {
      const pr = this.prt(p.id);
      const keys: KeyView[] = this.poolOf(p).map((k) => {
        const rt = this.krt(p.id, k.id);
        const s = stats.find((x) => x.provider === p.id && x.keyId === k.id);
        const recent = rt.window.filter((t) => now - t < 60_000).length;
        const invalid = rt.invalid ?? k.invalid ?? null;
        const state: KeyView["state"] = !k.enabled ? "disabled" : invalid ? "invalid" : rt.cooldownUntil > now ? "cooldown"
          : recent >= p.rpm ? "throttled" : "ready";
        return {
          id: k.id, label: k.label, masked: k.id === "anon" ? "no key needed" : maskKey(k.key), enabled: k.enabled, state,
          cooldownUntil: rt.cooldownUntil, lastError: invalid ?? rt.lastError, calls24h: s?.calls ?? 0, ok24h: s?.ok ?? 0,
          rateLimited24h: s?.limited ?? 0, avgMs: s?.avgMs ?? 0, tokens24h: s?.tokens ?? 0,
        };
      });
      const sum = stats.filter((x) => x.provider === p.id);
      const calls = sum.reduce((a, x) => a + x.calls, 0);
      const ok = sum.reduce((a, x) => a + x.ok, 0);
      const ready = keys.filter((k) => k.state === "ready" || k.state === "throttled").length;
      const health: ProviderView["health"] = !p.enabled ? "disabled" : p.keyRequired && !p.keys.length ? "unconfigured"
        : pr.openUntil > now || ready === 0 || (calls >= 3 && ok === 0) ? "down"
        : ready < keys.length || (calls >= 5 && ok / calls < 0.7) ? "degraded" : "healthy";
      return {
        id: p.id, preset: p.preset, name: p.name, kind: p.kind, baseUrl: p.baseUrl, enabled: p.enabled, keyRequired: p.keyRequired,
        models: p.models, rpm: p.rpm, timeoutSec: p.timeoutSec, jsonMode: p.jsonMode, keys, circuitOpenUntil: pr.openUntil, health,
        calls24h: calls, ok24h: ok, tokens24h: sum.reduce((a, x) => a + x.tokens, 0),
        avgMs: ok ? Math.round(sum.reduce((a, x) => a + x.avgMs * x.ok, 0) / ok) : 0,
      };
    });
  }

  // explicit and effective chains for every role
  routes(): RouteView[] {
    return this.registry.routeList().map((r) => ({ ...r, effective: this.registry.chainFor(r.role) }));
  }

  // clears a tripped breaker or cooldowns by hand from the dashboard
  reset(providerId: string) {
    const pr = this.prt(providerId);
    pr.openUntil = 0;
    pr.failures = 0;
    for (const [id, rt] of this.keyRt) if (id.startsWith(`${providerId}:`)) {
      rt.cooldownUntil = 0;
      rt.strikes = 0;
      rt.invalid = null;
    }
    for (const k of this.registry.get(providerId)?.keys ?? []) this.registry.markInvalid(providerId, k.id, null);
  }
}
